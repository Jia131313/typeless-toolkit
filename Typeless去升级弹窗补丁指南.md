# Typeless 去升级弹窗补丁指南

> 适用:Typeless 桌面端(Electron 应用,Windows)
> 默认安装路径:`%LOCALAPPDATA%\Programs\Typeless`(展开后形如 `...\AppData\Local\Programs\Typeless`)

## 一、目标

去掉 Typeless 正常使用时弹出的「升级 Pro / 升级会员」付费墙弹窗,且不破坏应用启动。

> 本工具集已把补丁逻辑集成进管理器(`manager.js` 的 `patchPaywall`),多数用户点管理器页面的「解除弹窗提示」按钮即可,无需手动操作。下文原理与手动脚本作为进阶/兜底方案保留。

## 二、原理

付费墙由后端下发的 `paywall` 通知触发,渲染层在 handler 里调用局部函数显示弹窗。
目标文件与函数名随版本混淆变化,例如:

| 版本 | 文件 | 函数调用示例 |
| --- | --- | --- |
| v1.8.x | `dist/renderer/static/js/2J71HyJ6.mjs` | `gn(_0x…)` |
| v2.0.0 | `…/BYriTiPi.mjs` | `_n(_0x…)` |
| **v2.0.1** | `…/DnfpkdWz.mjs` | `mn(_0x3b8fd1)` / `mn(_0x478298)` |

两处调用:

- `onImportantNotification`:`if(x['type']==='paywall')mn(x)`
- `onSessionInterrupt`:`if(x['type']==='paywall')mn(x)`

把这两处 `mn(...)` / `gn(...)` / `_n(...)` 改成无副作用的等长表达式
(`mn(_0x3b8fd1)` → `(0,_0x3b8fd1)`),弹窗就不再弹出,其余功能不受影响。

> 管理器从 适配 2.0.1 起支持**动态探测**:config 标记对不上时,会自动从
> `if(x['type']==='paywall')fn(x)` 结构推导两个等长替换,无需每次手填。

## 三、两道完整性校验(关键坑)

Typeless 有 **两层** asar 完整性校验,任意一层不过都会启动即闪退:

| 层级 | 存储位置 | 校验内容 | 改动后必须同步 |
| --- | --- | --- | --- |
| 第一层:逐文件 SHA256 | `app.asar` 头 JSON 里每个文件的 `integrity.hash` / `integrity.blocks[0]` | 文件内容 SHA256 | 改了文件内容就要更新该文件哈希 |
| 第二层:整头 SHA256 | `Typeless.exe` 的 PE 资源 `INTEGRITY/ELECTRONASAR` | 整个 asar 头 JSON 的 SHA256 | 改了头(即改了 per-file 哈希)就要更新 exe 内嵌值 |

> 闪退特征:日志 `FATAL:asar_util.cc(144)] Integrity check failed for asar archive (expected vs actual)`。

## 四、用管理器打补丁(推荐)

1. 退出 Typeless(任务管理器结束所有 `Typeless.exe`)。
2. 启动 `启动管理器.bat`,点「解除弹窗提示」按钮。
3. 管理器自动完成:备份 `app.asar.bak` / `Typeless.exe.bak` → 内容替换 → 同步逐文件 SHA256 →
   同步 exe 内嵌整头 SHA256 → 重启 Typeless。
4. 失败会自动从 `.bak` 还原,不会留下半改状态。

补丁标记(`gn(_0x1c3e62)` 等)和目标文件路径都写在 `config.json` 的 `paywall` 段,
版本变了改 config 即可,不用动代码。

## 五、不同版本适配

Typeless 更新后,`2J71HyJ6.mjs` 的文件名、minified 变量名 `_0x1c3e62` / `_0x2d6844` / 函数名 `gn`
都可能改变。若管理器报「未找到标记 X」,按下面步骤定位你版本的值,填入 `config.json`。

### 1. 解开 app.asar

任选其一:

```bash
# 方式 A:npx asar(需 Node.js)
npx asar extract "%LOCALAPPDATA%\Programs\Typeless\resources\app.asar" app-unpacked

# 方式 B:7-Zip(把 app.asar 当压缩包右键解压)
```

### 2. 定位含 paywall 的 .mjs 文件

```bash
# 在解压目录里搜 'paywall',锁定渲染层文件
grep -rl "paywall" app-unpacked/dist/renderer --include="*.mjs"
```

`config.paywall.auto_detect_file = true` 时管理器会自动遍历 asar 内所有 `.mjs` 找含 `paywall`
的文件,通常无需手动填 `file_path`;但若自动探测找到多个或路径异常,可手动指定。

### 3. 用 DevTools 找弹窗显示函数名

1. 用 `--remote-debugging-port=9222` 启动 Typeless(用本目录的 `启动Typeless(带调试端口).bat`)。
2. 浏览器打开 `http://127.0.0.1:9222`,进入 Typeless 渲染窗口的 DevTools。
3. 在 Sources 里打开上一步定位到的 `.mjs`,搜 `onImportantNotification` 和 `onSessionInterrupt`。
4. 找到 `type==='paywall'`(或 `\"paywall\"===type`)分支里调用的那个函数名(假设叫 `gn`)。
5. 记下该函数被调用时传入的参数变量名(假设是 `_0x1c3e62`、`_0x2d6844`)。

### 4. 填入 config.json

把 `config.json` 的 `paywall` 段改成你版本的值:

```json
"paywall": {
  "file_path": ["dist", "renderer", "static", "js", "你版本的文件名.mjs"],
  "replacements": [
    ["gn(_0x1c3e62)", "(0,_0x1c3e62)"],
    ["gn(_0x2d6844)", "(0,_0x2d6844)"]
  ],
  "auto_detect_file": true
}
```

> 关键约束:替换必须**等长**(`gn(` 是 3 字符,`(0,` 也是 3 字符,总长不变),否则 asar 偏移错乱
> 会导致闪退。`gn(x)` → `(0,x)` 是让函数调用变成逗号表达式,直接返回入参、跳过显示。

## 六、手动补丁(兜底)

若管理器按钮不可用,可手动跑下面两段脚本(原理同管理器内置逻辑)。

### 1. 改 app.asar 内容 + 同步逐文件 SHA256

保存为 `patch-asar.js`,`node patch-asar.js`:

```javascript
const fs=require('fs'),crypto=require('crypto');
const asar=process.argv[2] || process.env.LOCALAPPDATA+'\\Programs\\Typeless\\resources\\app.asar';
const fd=fs.openSync(asar,'r+');
const fsize=fs.statSync(asar).size;
const buf=Buffer.alloc(fsize); fs.readSync(fd,buf,0,fsize,0);
const jl=buf.readUInt32LE(12);
const dataStart=16+jl+((16+jl)%4?(4-((16+jl)%4)):0);
const header=JSON.parse(buf.subarray(16,16+jl).toString('utf8'));
let node=header; for(const k of ['dist','renderer','static','js','2J71HyJ6.mjs']) node=node.files[k];
const foff=dataStart+ +node.offset, size=node.size;
const oldHash=node.integrity.hash;
const content=Buffer.from(buf.subarray(foff,foff+size));
const repl=[
  [Buffer.from("gn(_0x1c3e62)",'utf8'), Buffer.from("(0,_0x1c3e62)",'utf8')],
  [Buffer.from("gn(_0x2d6844)",'utf8'), Buffer.from("(0,_0x2d6844)",'utf8')],
];
for(const [from,to] of repl){
  const i=content.indexOf(from);
  if(i<0||i!==content.lastIndexOf(from)) throw new Error('未找到或不唯一: '+from);
  to.copy(content,i);
}
const newHash=crypto.createHash('sha256').update(content).digest('hex');
const headerBuf=buf.subarray(16,16+jl);
const oldHB=Buffer.from(oldHash), newHB=Buffer.from(newHash);
let p=headerBuf.indexOf(oldHB),cnt=0;
while(p>=0){newHB.copy(headerBuf,p);cnt++;p=headerBuf.indexOf(oldHB,p+1);}
if(cnt!==2) throw new Error('expected 2 hash occurrences, got '+cnt);
fs.writeSync(fd,content,0,size,foff);
fs.writeSync(fd,headerBuf,0,headerBuf.length,16);
fs.closeSync(fd);
console.log('new content hash',newHash);
```

### 2. 同步 Typeless.exe 内嵌整头 SHA256

先算新头 SHA256:

```javascript
const fs=require('fs'),crypto=require('crypto');
const asar=process.argv[2] || process.env.LOCALAPPDATA+'\\Programs\\Typeless\\resources\\app.asar';
const buf=fs.readFileSync(asar);
const jl=buf.readUInt32LE(12);
console.log(crypto.createHash('sha256').update(buf.subarray(16,16+jl)).digest('hex'));
```

再等长替换 exe 里嵌入的旧 hex(ASCII 64 hex):

```javascript
const fs=require('fs');
const exe=process.env.LOCALAPPDATA+'\\Programs\\Typeless\\Typeless.exe';
const oldH='<旧头SHA256>';   // 替换前 exe 里嵌入的值
const newH='<新头SHA256>';   // 上一步算出的新值
const fd=fs.openSync(exe,'r+');
const stat=fs.statSync(exe); const buf=Buffer.alloc(stat.size); fs.readSync(fd,buf,0,stat.size,0);
const oldB=Buffer.from(oldH), newB=Buffer.from(newH);
let i=buf.indexOf(oldB),cnt=0,idxs=[];
while(i>=0){idxs.push(i);cnt++;i=buf.indexOf(oldB,i+1);}
if(cnt<1) throw new Error('exe 里找不到旧整头 hash,可能已被改过');
for(const p of idxs) newB.copy(buf,p);
fs.writeSync(fd,buf,0,stat.size,0); fs.closeSync(fd);
```

### 3. 验证

```bash
cd "%LOCALAPPDATA%\Programs\Typeless"
Typeless.exe --enable-logging=stderr 2>typeless.log
REM 9 个进程正常拉起、日志无 "FATAL:asar_util.cc" 即通过
taskkill /F /IM Typeless.exe
findstr /i "fatal integrity" typeless.log   REM 应为空
```

## 七、还原

```bash
cd "%LOCALAPPDATA%\Programs\Typeless"
copy /Y resources\app.asar.bak resources\app.asar
copy /Y Typeless.exe.bak Typeless.exe
```

或用管理器:把 `app.asar.bak` / `Typeless.exe.bak` 覆盖回去后重启 Typeless。

## 八、注意事项

1. **改 exe 会让 Authenticode 代码签名失效**:本机已安装的本地 exe 仍可正常运行,
   仅 UAC 弹窗可能显示「未验证发布者」,属正常现象。
2. **自动更新会还原补丁**:`typeless-updater` 更新会重写 `app.asar` 和 `Typeless.exe`,
   弹窗会回来,需按本文重打两层补丁。要根治可关闭 Typeless 自动更新。
3. **更新后变量名可能变**:minified 变量 `_0x1c3e62` / `_0x2d6844` / 函数名 `gn`
   在新版本里可能改名,届时按「五、不同版本适配」重新定位。
4. **定位思路**:在 `app.asar` 里搜 `paywall`,找渲染层 `'onImportantNotification'`
   和 `'onSessionInterrupt'` 中 `type==='paywall'` 分支调用的那个函数,将其调用改无操作即可。
