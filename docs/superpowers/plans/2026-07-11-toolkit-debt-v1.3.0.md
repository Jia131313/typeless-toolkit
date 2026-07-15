# Typeless Toolkit v1.3.0 修债实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公开版剩余债修完并与 Release 对齐；发 `v1.3.0` 单 Latest；Typeless 2.0 可打补丁、CDP 不假就绪、spawn 失败不崩主进程。

**Architecture:** 公开版为唯一源码真相；`lib/platform.js` 负责 spawn 错误传播；`lib/common.js` 已含 2.0/CDP 修复仅需进包；打包版 robocopy 后 build；删旧 Release 只留 v1.3.0。

**Tech Stack:** Node.js、Electron 31 portable、gh CLI、Windows（本机验证）。

**Spec:** `docs/superpowers/specs/2026-07-11-toolkit-debt-v1.3.0-design.md`

---

## Task 1: spawn 错误可捕获并传到 API

**Files:**
- Modify: `lib/platform.js`（`win.launchApp` / `mac.launchApp`）
- Modify: `lib/common.js`（`launchTypeless`、`ensureApp`）
- Verify: `manager.js` `/api/launch` 是否已把 throw 变成 `FAIL` msg（现有 try/catch 应已覆盖）

- [ ] **Step 1: 改 `platform.js` 的 `launchApp`**

使 spawn 失败同步可感知。推荐写法（Win/Mac 同结构）：

```js
launchApp(exe, cdpPort) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [`--remote-debugging-port=${cdpPort}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', (err) => {
      const code = err && err.code;
      let hint = err.message || String(err);
      if (code === 'EACCES') hint = '启动被拒绝(EACCES)，可能被占用、无执行权限或杀软拦截: ' + exe;
      else if (code === 'ENOENT') hint = '找不到可执行文件: ' + exe;
      reject(new Error(hint));
    });
    // spawn 成功排队后即 resolve；真正 CDP 就绪由 ensureApp 轮询
    child.unref();
    // 短延迟：若立刻 error 会先 reject
    setTimeout(() => resolve(), 50);
  });
},
```

注意：`killApp` 等其它函数保持同步即可。

- [ ] **Step 2: 改 `common.js` 的 `launchTypeless` / `ensureApp`**

```js
async function launchTypeless() {
  if (!TYPELESS_EXE) throw new Error('Typeless 可执行文件路径未配置,无法启动');
  await PLAT.launchApp(TYPELESS_EXE, CDP_PORT);
}

async function ensureApp() {
  if (await portUp()) return;
  log('Typeless 未带调试端口,正在以调试端口重启…');
  killTypeless();
  for (let i = 0; i < 10; i++) { if (!(await portUp())) break; await sleep(500); }
  await sleep(500);
  await launchTypeless();
  for (let i = 0; i < 40; i++) { if (await portUp()) return; await sleep(500); }
  throw new Error('Typeless 已启动但调试端口 ' + CDP_PORT + ' 未就绪,请稍后重试或检查是否被拦截');
}
```

（原先 ensureApp 超时静默 return 的，改为明确 throw，避免「假就绪」。）

- [ ] **Step 3: 确认 `manager.js` 路由**

`/api/launch` 已是：

```js
await ensureApp();
return send(res, 200, { status: 'OK', msg: '...' });
// outer catch → send 500 FAIL msg
```

若 outer `catch` 已有，无需改。快速读一遍确认无吞错。

- [ ] **Step 4: 本地冒烟**

```bash
cd "D:/AI/Claude/Typeless工具集/公开版"
# 可选：临时把 config typeless_exe 指到不存在路径，POST /api/launch，应 FAIL 可读文案
node -e "const C=require('./lib/common'); C.launchTypeless().then(()=>console.log('ok')).catch(e=>console.log('fail',e.message))"
```

Expected: 路径错误时打印 fail 文案，进程不崩溃。

- [ ] **Step 5: Commit**

```bash
git add lib/platform.js lib/common.js
git commit -m "修复: spawn失败可捕获并向上抛错"
```

---

## Task 2: README 文案对齐

**Files:**
- Modify: `README.md`
- Optionally skim: `Typeless去升级弹窗补丁指南.md`（若仍写死 1.8.0/`gn` 为主示例，补一句 2.0 或改示例）

- [ ] **Step 1: 改开篇「仅 Windows」**

将类似「纯 Node.js + 单页前端,Windows 平台」改为明确 **Windows 或 macOS**（与安装要求一致）。

- [ ] **Step 2: 原理里的 `gn(x)`**

改为通用描述，例如：等长替换把付费墙渲染调用变成 `(0,x)` 无操作；**v2.0 示例为 `_n(x)`**，旧版曾为 `gn(x)`；版本变更需按「弹窗补丁适配」重定位。

- [ ] **Step 3: 配置示例**

确认示例已是 `BYriTiPi.mjs` + `_n(_0x4a75c6)` / `_n(_0x55e021)`（此前已改则跳过）。

- [ ] **Step 4: Commit**

```bash
git add README.md
# 若改了指南: git add Typeless去升级弹窗补丁指南.md
git commit -m "优化: README平台与2.0补丁文案"
```

---

## Task 3: 同步打包版并升版本

**Files:**
- Modify: `打包版/package.json` → `"version": "1.3.0"`
- Sync into `打包版/`: `manager.js`, `manager.html`, `config.json`, `lib/**`
- Build: `打包版/dist/TypelessToolkit.exe`

- [ ] **Step 1: 同步源文件**

在 bash 中（注意 robocopy 退出码 0/1 皆成功，用 `;`）：

```bash
cd "D:/AI/Claude/Typeless工具集/打包版"
robocopy "../公开版" "." manager.js manager.html config.json /njh /njs /ndl /np
robocopy "../公开版/lib" "lib" /E /njh /njs /ndl /np
```

- [ ] **Step 2: package.json version = 1.3.0**

- [ ] **Step 3: 一致性检查（验收清单）**

```bash
# paywall 段应含 BYriTiPi 与 _n(
grep -E "BYriTiPi|_n\(|ensureApp|/json/list" lib/common.js config.json | head -20
```

Expected: 有 2.0 标记；common 含 `/json/list` 与端口关闭逻辑。

- [ ] **Step 4: 打包**

```bash
cd "D:/AI/Claude/Typeless工具集/打包版"
npx electron-builder --win portable
ls -la dist/TypelessToolkit.exe
```

Expected: 新 mtime 的 exe，体积约 68MB。

- [ ] **Step 5: （可选）本机补丁/启动冒烟**

关闭 Typeless 后用公开版或打包逻辑跑 `paywallStatus`/`patchPaywall`；或双击 exe 点启动/添加账号。

---

## Task 4: GitHub Release 治理

**Requires:** 代理 `HTTPS_PROXY=http://127.0.0.1:7897`（本机 Clash）

- [ ] **Step 1: 公开版 push**

```bash
cd "D:/AI/Claude/Typeless工具集/公开版"
git push origin main
```

确保 Task 1–2 commit 已在远端。

- [ ] **Step 2: 删除旧 Release**

```bash
HTTPS_PROXY=http://127.0.0.1:7897 gh release delete v1.2.0 --repo Jia131313/typeless-toolkit --yes --cleanup-tag
HTTPS_PROXY=http://127.0.0.1:7897 gh release delete v1.10.0 --repo Jia131313/typeless-toolkit --yes --cleanup-tag
```

- [ ] **Step 3: 创建 v1.3.0 并上传**

```bash
cd "D:/AI/Claude/Typeless工具集/打包版/dist"
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
gh release create v1.3.0 "TypelessToolkit.exe" \
  --repo Jia131313/typeless-toolkit \
  --title "v1.3.0 - 修债对齐 Typeless 2.0" \
  --notes "## 本版要点
- 弹窗补丁适配 Typeless 2.0（BYriTiPi.mjs / _n 标记）
- 修复 CDP 启动竞态与 targets 端点兼容（减少「已就绪但 CDP 无响应」）
- spawn 失败可捕获，避免主进程 Uncaught Exception
- README 平台与补丁文案对齐
- 删除旧 tag v1.2.0 / v1.10.0，仅保留本版 Latest

绿色单文件，无需管理员权限。"
```

- [ ] **Step 4: 验证**

```bash
HTTPS_PROXY=http://127.0.0.1:7897 gh release list --repo Jia131313/typeless-toolkit
HTTPS_PROXY=http://127.0.0.1:7897 gh release view v1.3.0 --repo Jia131313/typeless-toolkit
```

Expected: 仅 `v1.3.0`；资产 `TypelessToolkit.exe`。

---

## Task 5: 收尾核对

- [ ] **Step 1: 对照 spec §5 验收表勾选**

| 项 | 通过? |
| --- | --- |
| config/common paywall 与 main 一致 | |
| ensureApp/withCDP 在包内 | |
| Release 仅 v1.3.0 | |
| README 无「仅 Windows」矛盾、示例 2.0 | |
| spawn 失败可读（至少代码路径） | |

- [ ] **Step 2: 若有未提交文档**

实现计划已在 docs 则 commit：

```bash
git add docs/superpowers/plans/2026-07-11-toolkit-debt-v1.3.0.md
git commit -m "新增: v1.3.0修债实现计划"
git push origin main
```

---

## 执行注意

1. **Git Bash + taskkill：** 强杀用 `MSYS_NO_PATHCONV=1 taskkill /F /IM Typeless.exe`。  
2. **打补丁前** 必须无 Typeless 进程，否则 EBUSY。  
3. **不要** 再 `--clobber` 覆盖旧 tag；本轮只建 `v1.3.0`。  
4. 打包版 **不进 git**；只推公开版源码 + Release 资产。
