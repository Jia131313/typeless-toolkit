# Typeless 工具集

Typeless 桌面端的多账号管理 + 个人词库跨账号同步 + 去升级弹窗补丁工具集。
核心是 Node.js 本地服务 + 单页前端；Windows 打包版使用 WebView2 提供独立桌面窗口和托盘。
源码同时支持 Windows 与 macOS。

## 这是什么

[Typeless](https://typeless.com/) 是一款语音听写桌面应用(Electron)。本工具集围绕它的几个
实际使用痛点提供本地辅助:

- **多账号管理**:一台机器上切换多个 Typeless 账号,各自保留登录态快照,一键切换。
- **词库跨账号同步**:把多个账号的个人词库(含系统自动学习的 auto 词)合并成一份主清单,
  再回灌到每个账号,换号不丢词。
- **解除设备限制**:重置设备 ID,准备注册新账号。
- **去升级/会员弹窗**:自动定位 Electron 渲染层的付费墙调用并打等长补丁,关掉相关弹窗。

## 原理简述

- **个性化 = 词库可同步 + 风格不可导出**:Typeless 的「个性化」主要来自个人词库(手动加的词 +
  系统自动学习的词),这些都能通过官方 API 导出/导入;而说话风格模型不可导出,跨账号无法迁移。
- **多账号切换 = 登录态快照**:Typeless 把登录凭证存在 `%APPDATA%\Typeless.exe\` 下的几个
  JSON 文件里。把这些文件按账号 snapshot 存好,切换账号时还原对应快照并重启即可。
- **设备限制 = Credential Manager 设备 ID**:Typeless 用 Windows Credential Manager 的
  `Typeless.deviceIdentifier` 凭据 + `%APPDATA%\Typeless\Cache\device.cache` 绑定设备。
  删掉这两处(外加清登录态)即可重置成「新设备」。
- **去弹窗 = 自动定位 + 完整性同步**:工具会自动扫描 asar 中包含 `paywall` 的渲染文件，识别
  混淆后的函数调用并做等长替换，同时更新 per-file SHA256。程序会优先关闭 Electron 的内嵌
  asar 完整性校验，无法关闭时再同步可执行文件中的整头 SHA256；失败会从备份自动还原。

## 下载选择与运行要求

Windows Release 同时提供两个 ZIP，功能完全相同：

- **Portable（推荐）**：内置 Node.js，解压后直接双击 `TypelessToolkit.exe`。
- **Lite**：体积更小，适合电脑上已经安装 Node.js 22.12+ 的用户。

两个版本都只有一个需要操作的入口，并会把账号、配置和快照保存在解压目录的 `data/` 中。
升级时请保留该目录。除此之外还需要：

- **Microsoft Edge WebView2 Runtime**（多数 Windows 10/11 电脑已安装；缺失时程序会提示）
- **curl**（Windows 10 1803+ / macOS 自带，用于调用 Typeless API）
- **已安装 Typeless 桌面端**
- **无需管理员权限**：Typeless 位于用户目录，普通权限即可运行；macOS 修改应用后需 ad-hoc 重签名

源码运行仍需要 Node.js 22.12+。Windows 发布包适用于 x64；源码同时保留 macOS 支持，Linux 未适配。

## 快速开始

1. **配置**(可选):打开 `data/config.json`,若 Typeless 不在默认安装路径,填 `typeless_exe`。
2. **启动管理器**:Windows release 版直接双击 `TypelessToolkit.exe`；源码开发时运行
   `node manager.js` 后访问 `http://127.0.0.1:7788`。
3. **添加账号**:在 Typeless 里登录第一个账号 → 管理器点「添加当前账号」(会自动抓 token)。
4. **同步词库**:点「全部同步」,各账号词库自动对齐到主 CSV。
5. **切换账号**:账号卡片点「切换到此号」(从快照还原 + 重启 Typeless)。
6. **解除弹窗**:点「解除弹窗提示」(首次自动备份 `.bak`,失败自动还原)。

源码模式也可以直接运行 `同步词库.bat` 或 `node typeless-dict-sync.js`。

## Windows 桌面窗口与托盘

release 版只有一个入口：`TypelessToolkit.exe`。

- 双击 EXE 会启动本地服务，并在程序自己的 WebView2 独立窗口中打开管理器。
- 窗口标题栏、Windows 任务栏、系统托盘和 Web 页面使用同一套应用图标。
- WebView2 使用 Per-Monitor V2 高 DPI 渲染，标题栏颜色会跟随页面深浅主题。
- 默认窗口最多为 1440×880，并自动适应屏幕工作区；工具栏按常用操作和系统操作分组，在窄窗口中整组换行。
- 点击窗口关闭按钮会收纳到托盘；双击托盘图标或再次双击 EXE 可恢复窗口。
- 托盘右键→「退出」才会关闭窗口及由它启动的后端进程。
- 修改源码后运行 `build-release.bat`，会重新生成单入口 release 包。

`build-release.bat` 用于更新本机自用包，会保留已有账号和快照。准备公开附件时必须运行
`build-public-release.bat`，它会生成：

- `TypelessToolkit-v1.3.1-win-x64-portable.zip`：内置经过 SHA256 校验的 Node.js 24.15.0
- `TypelessToolkit-v1.3.1-win-x64-lite.zip`：使用系统 Node.js 22.12+

两个公开包都会强制使用示例账号和空 `profiles/`，并分别输出 SHA256 文件。绝不能直接上传
本机自用 release 目录。

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
| 去升级弹窗 | 管理器 | 自动定位付费墙调用、处理完整性校验并显示实时状态 |
| 跳过新手引导 | 管理器 | 写入本地 onboarding 状态并自动重启 Typeless |

## 配置说明

Release 用户修改 `data/config.json`，源码模式修改根目录 `config.json`（默认值均不含隐私）：

```json
{
  "typeless_exe": "",            // 留空=自动探测 %LOCALAPPDATA%\Programs\Typeless\Typeless.exe
  "cdp_port": 9222,              // CDP 调试端口
  "manager_port": 7788,          // 管理器 HTTP 端口
  "api_base": "https://api.typeless.com",
  "master_csv": "Typeless词库主清单.csv"
}
```

- `typeless_exe` 留空时按优先级探测:config → 环境变量 `TYPELESS_EXE` → 默认安装路径 → 报错。
- `paywall` 内部默认值无需用户维护。Typeless 更新后，管理器会自动扫描 asar、定位目标文件，
  并识别需要替换的调用，无需手动拆包或打开 DevTools。
- 自动检测会验证 `onImportantNotification` / `onSessionInterrupt` 语义，不会把 onboarding
  的 `paywall` 埋点误判为弹窗处理文件；已适配 Typeless 2.0.1。
- 本地私有覆盖可写在 `config.local.json`(已 `.gitignore`,不会进 git)。

## 常见问题

**Q: 抓 token 失败 / 「CDP 无响应」?**
A: 点击「添加当前账号」时，管理器会临时用调试端口重启 Typeless，抓取完成后自动恢复普通启动。
这是唯一使用 CDP 的功能；当前账号检测、账号切换和跳过教程等日常操作不依赖调试模式。
抓取有明确超时，无论成功或失败都会尝试恢复 Typeless。请先确认 Typeless 已安装、已登录且可以正常使用。

**Q: 如何手动刷新当前登录账号?**
A: 点击右上角的账号状态条（或聚焦后按 Enter/空格）。该操作只读取本地 `app-storage.json`，不会开启调试模式，也不会重启 Typeless。

**Q: 打补丁后 Typeless 闪退?**
A: 日志若出现 `FATAL:asar_util.cc ... Integrity check failed`，说明完整性处理没有适配当前版本。
管理器会自动从 `.bak` 还原。若自动检测提示当前 Typeless 版本暂不支持，请更新工具或提交 issue
并附上 Typeless 版本和完整错误文本，不需要自行修改 asar。

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
Windows 与 macOS 各一套实现。macOS 路径按平台固定(不混用 Windows 的 `.exe` 命名)。

- **启动**:用 `启动管理器.command` / `同步词库.command`
  (首次需在终端执行 `chmod +x *.command` 赋可执行权限;或右键→打开)。
- **连接**:从 Dock / Finder 启动的 Typeless 不会带调试端口。管理器在 macOS 上会 soft 重连
  (检测到进程在跑但 CDP 不通时,自动以 `--remote-debugging-port` 重启再抓 token)。
- **进程 / 路径 / 凭据**(Typeless 2.0 实测默认,可在 `config.json` 覆盖):

  | 项 | macOS 默认 | config 覆盖字段 |
  | --- | --- | --- |
  | 可执行文件 | `/Applications/Typeless.app/Contents/MacOS/Typeless` | `typeless_exe` |
  | 登录态目录 | `~/Library/Application Support/Typeless` | `userdata_dir` |
  | 设备缓存 | `~/Library/Application Support/now.typeless.desktop` | `device_cache_dir` |
  | 设备 ID 凭据 | Keychain 通用密码 `now.typeless.desktop.deviceIdentifier` | `credential_target` |

- **去弹窗补丁(实验性)**:改 Mach-O 可执行文件后会破坏代码签名,补丁流程会自动执行
  `codesign --force --deep --sign -` 做 ad-hoc 重签名并移除隔离属性;若自动重签名失败,
  需手动执行 `codesign --force --deep --sign - /Applications/Typeless.app`。首次使用请先手动备份 `.app`。

- **排错**:管理器顶栏会显示当前平台徽章;若显示「⚠ 未找到 Typeless」,访问
  `http://127.0.0.1:7788/api/env` 查看探测到的各路径,按上表在 `config.json` 里改正。

> 以上路径基于 Typeless 2.0.0(Bundle ID `now.typeless.desktop`)在真实 Mac 上实测。
> 若你的版本目录名或 Keychain 条目不同，请对照 `/api/env` 修改对应的路径配置；
> 补丁目标和混淆标记由程序自动检测。

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
