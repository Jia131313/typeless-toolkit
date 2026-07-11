# Typeless 工具集(公开版)

Typeless 桌面端的多账号管理 + 个人词库跨账号同步 + 去升级弹窗补丁工具集。
提供原生窗口形态的 macOS 客户端,同时保留 Node.js + 单页前端的脚本运行方式,支持 Windows 与 macOS。

## 这是什么

[Typeless](https://typeless.com/) 是一款语音听写桌面应用(Electron)。本工具集围绕它的几个
实际使用痛点提供本地辅助:

- **多账号管理**:一台机器上切换多个 Typeless 账号,各自保留登录态快照,一键切换。
- **词库跨账号同步**:把多个账号的个人词库(含系统自动学习的 auto 词)合并成一份主清单,
  再回灌到每个账号,换号不丢词。
- **解除设备限制**:重置设备 ID,准备注册新账号。
- **去升级/会员弹窗**:对 Electron 的 asar 两层完整性校验打等长字节补丁,关掉付费墙弹窗。

## 原理简述

- **个性化 = 词库可同步 + 风格不可导出**:Typeless 的「个性化」主要来自个人词库(手动加的词 +
  系统自动学习的词),这些都能通过官方 API 导出/导入;而说话风格模型不可导出,跨账号无法迁移。
- **多账号切换 = 登录态快照**:Typeless 把登录凭证存在 `%APPDATA%\Typeless.exe\` 下的几个
  JSON 文件里。把这些文件按账号 snapshot 存好,切换账号时还原对应快照并重启即可。
- **设备限制 = Credential Manager 设备 ID**:Typeless 用 Windows Credential Manager 的
  `Typeless.deviceIdentifier` 凭据 + `%APPDATA%\Typeless\Cache\device.cache` 绑定设备。
  删掉这两处(外加清登录态)即可重置成「新设备」。
- **去弹窗 = 两层 asar 完整性补丁**:Electron 有两道 asar 完整性校验——asar 头里每个文件的
  per-file SHA256,以及平台完整性文件内嵌的整头 SHA256(Windows 在 exe,macOS 在 Info.plist)。
  改 asar 内容必须同时更新这两层,否则启动闪退。
  本工具用等长字节替换(`gn(x)` → `(0,x)`)把付费墙渲染函数调用变成无操作表达式。

## 安装要求

- **Node.js 18+**(用了原生 `WebSocket`、`fetch`)
- **Windows 或 macOS**(平台差异集中在 `lib/platform.js`;Linux 未适配)
- **curl**(Windows 10 1803+ / macOS 自带;用于调 Typeless API,自动走系统代理)
- **已安装 Typeless 桌面端**
- **无需管理员权限**:Typeless 装在用户目录,app.asar/可执行文件/设备凭据都在当前用户权限内,普通权限即可运行(改可执行文件会让签名失效,Windows 本机仍可运行,macOS 需 ad-hoc 重签名,见下)

## 快速开始

### macOS 客户端

1. 打开发布的 `Typeless-Toolkit-*.dmg`。
2. 将「Typeless 工具集」拖入 Applications。
3. 从「应用程序」运行客户端。首次打开若 macOS 提示来源未验证,请在 Finder 中右键应用并选择「打开」。

客户端把账号、词库、备份和本地配置保存在
`~/Library/Application Support/Typeless 工具集/data/`,升级或替换应用不会覆盖这些数据。

开发者可执行 `npm install && npm run start` 启动客户端,执行 `npm run build:mac` 生成 Apple Silicon `.dmg`。

### 脚本方式

1. **配置**(可选):打开 `config.json`,若 Typeless 不在默认安装路径,填 `typeless_exe`。
2. **启动管理器**:双击 `启动管理器.bat`(或 `node manager.js`),浏览器自动打开
   `http://127.0.0.1:7788`。
3. **添加账号**:在 Typeless 里登录第一个账号 → 管理器点「添加当前账号」(会自动抓 token)。
4. **同步词库**:点「全部同步」,各账号词库自动对齐到主 CSV。
5. **切换账号**:账号卡片点「切换到此号」(从快照还原 + 重启 Typeless)。
6. **解除弹窗**:点「解除弹窗提示」(首次自动备份 `.bak`,失败自动还原)。

也可以不用管理器,直接命令行跑词库同步:`同步词库.bat`(或 `node typeless-dict-sync.js`)。

## 功能列表

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 账号管理 | 管理器 | 添加/移除/切换账号,实时显示额度、词库数、个性化进度、凭证有效期 |
| 概览总览 | 管理器 | 顶部汇总所有账号:账号数、本周额度合计、词库合计、累计节省时长 |
| 词库同步 | 管理器 / CLI | 导出各账号词库到主 CSV,再把缺失词回灌(只增不删,自动翻页拉全量) |
| 主词库编辑 | 管理器 | 一行一个词,作为所有账号同步的基准,可一键导出 txt |
| 词库导出 | 管理器 | 单账号词库、主词库均可导出为 txt 文件 |
| 跨账号复制词库 | 管理器 | 把某账号词库整份导入另一账号 |
| 数据备份 | 管理器 | 一键把 accounts.json + 主词库备份到 `backups/时间戳/` |
| 搜索 / 排序 | 管理器 | 账号超过 3 个时,按昵称/额度/剩余/词库数排序,支持搜索 |
| 深色模式 | 管理器 | 跟随系统或手动切换,偏好本地记忆 |
| 解除设备限制 | 管理器 | 重置设备 ID,准备注册新账号 |
| 去升级弹窗 | 管理器 | asar + exe 两层等长补丁,关掉付费墙,按钮实时显示补丁状态 |
| 带调试端口启动 | bat | `--remote-debugging-port=9222` 启动 Typeless,供 CDP 抓 token |

## 配置说明

`config.json`(用户可改,默认值无隐私):

```json
{
  "typeless_exe": "",            // 留空=自动探测 %LOCALAPPDATA%\Programs\Typeless\Typeless.exe
  "cdp_port": 9222,              // CDP 调试端口
  "manager_port": 7788,          // 管理器 HTTP 端口
  "api_base": "https://api.typeless.com",
  "master_csv": "Typeless词库主清单.csv",
  "paywall": {
    "file_path": ["dist", "renderer", "static", "js", "BYriTiPi.mjs"],
    "replacements": [
      ["_n(_0x4a75c6)", "(0,_0x4a75c6)"],
      ["_n(_0x55e021)", "(0,_0x55e021)"]
    ],
    "auto_detect_file": true
  }
}
```

- `typeless_exe` 留空时按优先级探测:config → 环境变量 `TYPELESS_EXE` → 默认安装路径 → 报错。
- `paywall.file_path` 是 v2.0 的值(示例);`auto_detect_file=true` 时若找不到会自动遍历
  asar 内 `.mjs` 文件找含 `paywall` 的那个。
- `paywall.replacements` 是 minified 变量名,**无法自动推测**,版本变了需手动定位(见下)。
- 本地私有覆盖可写在 `config.local.json`(已 `.gitignore`,不会进 git)。

## 各版本弹窗补丁适配

Typeless 更新后,`.mjs` 文件名和 minified 变量名(`gn`、`_0x1c3e62` 等)可能改变。
若管理器报「未找到标记 X」,说明你的版本与 config 默认值不同,需要:

1. 用 `npx asar extract` 或 7-Zip 解开 `app.asar`。
2. 在 `dist/renderer` 下 grep `paywall`,定位渲染层 `.mjs` 文件。
3. 用 DevTools(浏览器开 `http://127.0.0.1:9222`)在 `onImportantNotification` /
   `onSessionInterrupt` 的 `type==='paywall'` 分支找到弹窗显示函数名。
4. 把调用改成 `(0,原参数)`(等长 3 字符替换:`gn(` → `(0,`),填入 `config.json`。

详细步骤见 [Typeless去升级弹窗补丁指南.md](Typeless去升级弹窗补丁指南.md)。

## 常见问题

**Q: 抓 token 失败 / 「CDP 无响应」?**
A: Typeless 必须带 `--remote-debugging-port=9222` 启动。用本目录的
`启动Typeless(带调试端口).bat`,或管理器的「启动 Typeless」按钮(会自动带调试端口)。

**Q: 打补丁后 Typeless 闪退?**
A: 日志若出现 `FATAL:asar_util.cc ... Integrity check failed`,说明两层完整性校验没同步好。
  管理器会自动从 `.bak` 还原;手动补丁则 `copy /Y *.bak *` 还原后重试。

**Q: Typeless 自动更新后弹窗又回来了?**
A: 自动更新会重写 `app.asar` 和 `Typeless.exe`,补丁被还原,需重打。要根治可关 Typeless 自动更新。

**Q: token 会过期吗?**
A: Typeless 的 JWT 约 1 年有效。token 失效后管理器会显示「token失效」,重新点「添加当前账号」
  抓一次新 token 即可。

**Q: 支持 Mac/Linux 吗?**
A: **Windows 与 macOS 都支持**(平台差异集中在 `lib/platform.js`)。Linux 暂未适配。
  macOS 启动用本目录的 `.command` 脚本(首次需 `chmod +x *.command`)。详见下方「macOS 适配」。

## macOS 适配

平台相关差异(进程、路径、凭据、原始文件复制、重签名)全部封装在 `lib/platform.js`,
Windows 与 macOS 各一套实现。macOS 上:

- **启动**:用 `启动管理器.command` / `启动Typeless(带调试端口).command` / `同步词库.command`
  (首次需在终端执行 `chmod +x *.command` 赋可执行权限;或右键→打开)。
- **进程 / 路径 / 凭据**(合理默认,可在 `config.json` 覆盖):

  | 项 | macOS 默认 | config 覆盖字段 |
  | --- | --- | --- |
  | 可执行文件 | `/Applications/Typeless.app/Contents/MacOS/Typeless` | `typeless_exe` |
  | 登录态目录 | `~/Library/Application Support/Typeless.exe`(不存在则 `.../Typeless`) | `userdata_dir` |
  | 设备缓存 | `~/Library/Application Support/Typeless/Cache` | `device_cache_dir` |
  | 设备 ID 凭据 | Keychain 通用密码 `Typeless.deviceIdentifier` | `credential_target` |

- **去弹窗补丁(实验性)**:改 Mach-O 可执行文件后会破坏代码签名,补丁流程会自动执行
  `codesign --force --deep --sign -` 做 ad-hoc 重签名并移除隔离属性;若自动重签名失败,
  需手动执行 `codesign --force --deep --sign - /Applications/Typeless.app`。**此功能未在真实
  Mac 上验证**,首次使用请先手动备份 `.app`。

- **排错**:管理器顶栏会显示当前平台徽章;若显示「⚠ 未找到 Typeless」,访问
  `http://127.0.0.1:7788/api/env` 查看探测到的各路径,按上表在 `config.json` 里改正。

> ⚠️ **给 macOS 用户的说明**:本工具的 macOS 分支基于 Electron/macOS 惯例编写,作者在
> Windows 环境开发、**未在真实 Mac 上实测**。上表的数据目录名、Keychain 条目名、asar 内混淆
> 变量若与你的版本不符,请对照 `/api/env` 输出与「各版本弹窗补丁适配」章节自行校正 `config.json`。

## 免责声明

**本工具集内容仅供 24 小时内的学习与技术交流,请于下载/使用后 24 小时内自行删除。**

- 本项目旨在帮助理解 Electron 应用的 asar 完整性机制、CDP 远程调试、多账号登录态管理等技术原理,仅供个人学习与研究。
- **不得用于规避 Typeless 的付费机制、违反其服务条款,或任何商业用途。** 不得将本项目用于盈利、贩卖、分发或任何形式的商业传播。
- Typeless 软件及相关商标、著作权的全部权利归其原始权利人所有,本项目与 Typeless 官方无任何关联、赞助或认可关系。
- 使用本工具集产生的一切后果(包括但不限于账号封禁、数据丢失、应用损坏、法律责任)由使用者自行承担,作者不承担任何责任。
- 使用前请先阅读 Typeless 的服务条款;若你的所在地法律或 Typeless 条款禁止此类操作,请勿使用。
- 继续使用即视为你已阅读并同意上述声明。

## 许可证

MIT,见 [LICENSE](LICENSE)。

## 参考项目

- [estarpro1022/typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device) —— 本项目的「解除设备登录限制」功能参考了该项目重置 Typeless 设备 ID 的思路(清理设备标识凭据以重新注册新账号)。

## 致谢 / Thanks

感谢 [LINUX DO 论坛社区](https://linux.do/) 的关注、反馈与支持。
