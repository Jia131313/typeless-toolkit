# 平台实现与配置

本文供需要了解实现或排查平台行为的用户参考。日常安装见 [安装指南](installation.md)。

## 原理简述

- **个性化 = 词库可同步 + 风格不可导出**:Typeless 的「个性化」主要来自个人词库(手动加的词 +
  系统自动学习的词),这些都能通过官方 API 导出/导入;而说话风格模型不可导出,跨账号无法迁移。
- **多账号切换 = 登录态快照**:Typeless 把登录凭证存在 `%APPDATA%\Typeless.exe\` 下的几个
  JSON 文件里。把这些文件按账号 snapshot 存好,切换账号时还原对应快照并重启即可。
- **设备限制 = Credential Manager 设备 ID**:Typeless 用 Windows Credential Manager 的
  `Typeless.deviceIdentifier` 凭据 + `%APPDATA%\Typeless\Cache\device.cache` 绑定设备。
  删掉这两处(外加清登录态)即可重置成「新设备」。
- **去弹窗 = 自动定位 + 完整性同步**:工具会自动扫描 asar 中包含 `paywall` 的渲染文件，识别
  混淆后的函数调用并做等长替换，同时更新 per-file SHA256。macOS 会优先保留并同步
  `Info.plist/ElectronAsarIntegrity`；旧格式再按实际能力处理 fuse 或可执行文件内嵌 hash。
  未知结构会明确提示不兼容，失败会从备份自动还原。

## 配置说明

### 后台额度提醒

在「设置 → 通用 → 额度提醒」开启，默认关闭，默认剩余 200 字时提醒（上限为 2000 时对应已用 1800）。自动切号需另外显式开启，可选择剩余额度、个性化程度或自定义顺序；静默模式只在已开启自动切号后可用。
工具集后端通常每 2 分钟查询当前账号，剩余额度不高于阈值两倍时每 30 秒查询；达到阈值后才扫描有有效本机快照的备用账号，按所选策略推荐目标，备用账号查询结果缓存 5 分钟。

首页显示提醒和切换按钮，Windows 桌面宿主同时提供托盘通知；点击通知只打开管理器。
macOS 和源码浏览器模式本阶段只有页面提示，后台监测仍正常运行。
默认只提醒，由用户确认后切换。显式开启自动切号后，普通模式先显示倒计时，静默模式则在检测到未听写时直接切换；切换前仍会检查当前身份、目标快照及听写状态。自动切换会重启 Typeless，请自行确认其行为符合使用场景。
本地设置保存在数据目录的 `quota-monitor.json`，不参与账号同步；关闭窗口到托盘后监测继续，退出工具集后停止。

额度以上游返回的本周用量和上限为准，不假定每天重置，也不再以 8000 作为缺失上限的默认值。
查询失败或上限未知时停止推荐并退避重试；Typeless 未运行时暂停查询。统计延迟和一次长听写可能跨过提醒阈值。
若官方返回 `20006`（客户端不受支持），工具集会明确提示并暂停自动重试，保留“立即检查”入口；此时无法提供额度监控，请在官方应用中查看额度。2026-09-18 的本机真实接口验证遇到了此限制。

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
  的 `paywall` 埋点误判为弹窗处理文件；当前已实测适配 Typeless 2.8.0。
- 本地私有覆盖可写在 `config.local.json`(已 `.gitignore`,不会进 git)。

## macOS 适配

平台相关差异(进程、路径、凭据、原始文件复制、重签名)全部封装在 `lib/platform.js`,
Windows 与 macOS 各一套实现。macOS 路径按平台固定(不混用 Windows 的 `.exe` 命名)。
账号管理、账号切换、快照、词库增删/导出/同步、主词库、备份、设备重置、注册向导、
弹窗补丁和跳过新手引导均复用同一套 API 与管理页面；只有桌面宿主和系统调用按平台实现。

- **启动**:可用 `启动管理器.command` / `同步词库.command` 运行源码
  (首次需在终端执行 `chmod +x *.command` 赋可执行权限;或右键→打开)，也可运行
  `npm run build:mac` 构建当前架构 Portable DMG，或运行 `npm run build:mac:all` 构建 arm64/x64 的 Portable/Lite 四个 DMG。开发机可运行 `npm run deploy:mac` 一次完成构建、签名校验、
  替换 `/Applications` 中的旧 App 和启动验证；成功后旧 App 会被删除，外置用户数据不会改动。
  工具集使用个人 ad-hoc 签名而非 Developer ID/公证签名，
  首次打开若被 macOS 拦截，请在 Finder 中右键应用选择“打开”。Mac 的 ICNS、Web logo/favicon
  与 Windows 桌面壳均从 `icon/icon.png` 生成，避免不同平台出现两套图标；Mac ICNS 按 1024 画布中的
  824 像素标准视觉框生成，Web 和 Windows 保持各自现有显示比例。macOS Tauri 宿主
  支持单实例恢复；当前实例必须持有自己的 Node/Rust 宿主协议，配置端口被占用时会选择回退端口，
  不复用缺少该协议的外部后端。macOS 使用 Dock 的原生窗口生命周期，不机械复制 Windows 系统托盘。
- **连接**:日常账号检测只读取 `app-storage.json`,不会启动调试端口或重启 Typeless。
  仅在「添加当前账号」或注册新号收尾需要更新凭证时，管理器才会临时以
  `--remote-debugging-port` 重启抓取 token，并在 `finally` 中恢复普通模式。所有 macOS 启动
  （普通启动、切号、注册、调试抓取与恢复）都通过 LaunchServices 打开 App Bundle，不直接
  spawn `Contents/MacOS/Typeless`；否则 macOS TCC 会把 Typeless 的辅助功能/麦克风请求错误
  归因到 Typeless 工具集，出现两个 App 都要授权或开关已开启却无法继续的假死状态。
- **跳过教程**:同时写入 `app-onboarding.json`、`app-storage.json` 当前平台标记和当前账号快照。
  完成后按钮仍可点击“重新修复”，用于 Typeless 升级或切号后状态回潮；切换账号恢复快照时也会
  自动检查并补齐全部完成标记。
- **进程 / 路径 / 凭据**(Typeless 2.0 实测默认,可在 `config.json` 覆盖):

  | 项 | macOS 默认 | config 覆盖字段 |
  | --- | --- | --- |
  | 可执行文件 | `/Applications/Typeless.app/Contents/MacOS/Typeless` | `typeless_exe` |
  | 登录态目录 | `~/Library/Application Support/Typeless` | `userdata_dir` |
  | 设备缓存 | `~/Library/Application Support/now.typeless.desktop` | `device_cache_dir` |
  | 设备 ID 凭据 | Keychain 通用密码 `now.typeless.desktop.deviceIdentifier` | `credential_target` |

- **去弹窗补丁(实验性)**:修改前会把完整 `Typeless.app` 临时备份到工具集数据目录下的
  `backups/typeless-app/paywall-patch-时间戳/`，备份位于 `.app` 外，不会污染代码签名。
  备份 Bundle 使用 `.app.backup` 后缀并放在 `.noindex` 目录，且备份根目录带 Spotlight 排除标记，避免系统快速搜索
  把备份误显示成第二个可启动的 Typeless。补丁通过严格签名校验并确认 Typeless 正常启动后，
  本次事务备份会立即删除；只有恢复失败时才保留可用于人工恢复的副本，不会随每次更新长期堆积。
  Typeless 提供 `Info.plist/ElectronAsarIntegrity` 时，工具集会保留该校验并同步更新 ASAR header hash；
  只有实际检测到旧格式时才尝试 `@electron/fuses` 或主程序内嵌 hash。若 fuse 路径改动了
  `Electron Framework.framework`，只对该 Framework 与 App 根 Bundle 做定向 ad-hoc 重签名；
  根程序保留原 Bundle ID、JIT、麦克风、网络与 Hardened Runtime，
  并增加加载定向改签 Framework 所需的 Library Validation 例外。Renderer/GPU/Plugin 等其他 Helper
  继续保留官方签名。随后仅清除该 App 的下载隔离标记，并立即执行严格验证及启动检查。不要手工使用
  `codesign --deep --sign -`，它会递归改签内部组件并可能丢失 JIT、麦克风等权限。任一步失败都会
  自动恢复完整备份；失败版本会留在同一备份目录，错误阶段和完整原因写入数据目录的 `logs/`。
  ad-hoc 签名的默认指定要求会随内容变化。工具集会比较修改前后的 macOS designated requirement；
  只有代码身份确实变化时，才自动通过 `tccutil` 清除 Typeless 旧的辅助功能和麦克风记录，使系统
  下次展示的是可重新授权的新身份，而不是“开关仍开启但新进程无法识别”的失效条目。恢复官方
  更新时也执行同一判断；官方签名身份未变化则不会打扰现有权限。工具集内的“macOS 权限说明”仍
  提供一次性手动清理入口，用于迁移旧版本遗留状态。清理只影响授权记录，不删除账号或应用数据。
  工具集自身也是 ad-hoc 签名；安装新的工具集构建后，它会记录并比较自身代码身份，自动删除旧的
  App 管理条目及历史版本误加的工具集辅助功能条目。下次真正需要修改 Typeless.app 时，只需对
  当前工具集身份重新允许一次，不会继续对着旧的“已开启”开关循环。
  Tauri 版先由 Node 在工具集外置 `data/staging/` 中准备并校验候选 App，再由 Tauri 主程序完成 `/Applications/Typeless.app` 的最终替换和失败恢复；因此 Portable 内置 Node 与 Lite 外部 Node 不会成为两套 App 管理权限主体。工具集只在确实需要写入 `Typeless.app`（自动解除弹窗或安装官方更新）时展示明确说明并直接打开
  App 管理设置；开启后回到工具集，原操作自动继续。普通 App 无法替用户自动打开该隐私开关；
  长期免重复授权仍需要稳定的 Developer ID 签名，而不是 ad-hoc 签名。
  补丁会使 Typeless 原生自动安装升级
  失效，后续版本使用管理器的「安装 Typeless 官方更新」入口安装。

- **安装 Typeless 官方更新**:Typeless 即使因补丁无法自行完成安装,仍会把官方更新包下载到 updater 缓存。
  管理器会先校验更新包 SHA-512、Bundle ID、Developer ID、官方 Team ID、代码签名和 Gatekeeper,
  再把当前应用完整移动到工具集数据目录备份并安装新版本。升级会清除弹窗补丁并恢复官方签名。
  该入口只消费本机已有的 Typeless 更新缓存，不会检查或更新 Typeless Toolkit 自身。

- **排错**:管理器顶栏会显示当前平台徽章;若显示「⚠ 未找到 Typeless」,访问
  `http://127.0.0.1:7788/api/env` 查看探测到的各路径,按上表在 `config.json` 里改正。

> 以上路径基于 Typeless 2.0.0(Bundle ID `now.typeless.desktop`)在真实 Mac 上实测。
> 若你的版本目录名或 Keychain 条目不同，请对照 `/api/env` 修改对应的路径配置；
> 补丁目标和混淆标记由程序自动检测。
