## 下载与安装

请在本页面底部的 **Assets** 中选择与你的平台对应的安装包：

| 平台 | 推荐文件 | 适用情况 |
| --- | --- | --- |
| Windows | `TypelessToolkit-v{{VERSION}}-win-x64-portable-setup.exe` | **推荐日常使用**，内置 Node.js，运行环境随工具集更新 |
| Windows | `TypelessToolkit-v{{VERSION}}-win-x64-lite-setup.exe` | 较小，使用本机 Node.js 22.12+，推荐 Node 24 LTS |
| Windows | `TypelessToolkit-v{{VERSION}}-win-x64-portable.zip` | 免安装，内置 Node.js，解压后运行 `TypelessToolkit.exe` |
| Windows | `TypelessToolkit-v{{VERSION}}-win-x64-lite.zip` | 免安装，使用本机 Node.js 22.12+，推荐 Node 24 LTS |
| Apple Silicon Mac | `Typeless-Toolkit-{{VERSION}}-mac-arm64-portable.dmg` | **推荐大多数 Mac 用户使用**，已内置 Node.js |
| Apple Silicon Mac | `Typeless-Toolkit-{{VERSION}}-mac-arm64-lite.dmg` | 更小，电脑需要已安装同架构 Node.js 22.12+ |
| Intel Mac | `Typeless-Toolkit-{{VERSION}}-mac-x64-portable.dmg` | **推荐 Intel Mac 用户使用**，已内置 Node.js |
| Intel Mac | `Typeless-Toolkit-{{VERSION}}-mac-x64-lite.dmg` | 更小，电脑需要已安装同架构 Node.js 22.12+ |

Windows 版本需要 Microsoft Edge WebView2 Runtime；多数 Windows 10/11 电脑已自带。Setup 支持简体中文与英文，目前未签名，可能显示未知发布者。Lite 不会安装或升级系统 Node；官网安装的 Node 需自行更新。

## 已安装用户如何升级

如果当前版本已有「工具集更新」，可在工具集内检查并下载新版：Windows 安装版点击“退出并安装”后打开同类型 Setup，ZIP 使用原有程序替换流程；macOS 点击“打开 DMG 并退出工具集”后仍需拖入「应用程序」。更新不自动转换安装形式或 Portable/Lite 类型。

### Windows

**安装版：** 从托盘退出工具集后运行同类型 Setup。数据保存在 `%LOCALAPPDATA%\TypelessToolkit\data`，不在安装目录中，升级和卸载保留数据。从旧 ZIP 改用安装版时，数据不会因选择相同安装目录而自动迁入；首次空数据安装可在设置中选择旧 ZIP 目录迁移，也可使用“备份与迁移”手动导入。确认账号和词库正常后再删除旧 ZIP 数据。

**ZIP：**

1. 从托盘菜单退出 Typeless 工具集。
2. 将新版 ZIP 解压到一个新目录。
3. 把旧目录中的整个 `data/` 文件夹移动到新目录，替换新版包内的空 `data/`。
4. 启动新目录中的 `TypelessToolkit.exe`，确认账号与词库正常后即可删除旧程序目录。

不要用公开包内的空 `data/` 覆盖自己的旧数据；其中保存了账号、登录快照、词库和配置。

### macOS

先在「关于本机」确认芯片类型，再打开对应架构与当前 Portable/Lite 类型的新版 DMG，将“Typeless 工具集”拖入“应用程序”并选择替换。工具集内检查更新时也只会下载当前架构和类型；下载完成点击“打开 DMG 并退出工具集”，确认后成功打开 DMG 即完整退出工具集及其后端。手动从 Finder 打开 DMG 时，请先自行退出工具集。用户数据保存在 `~/Library/Application Support/Typeless 工具集/data/`，替换 App 本体不会删除账号、快照、词库或配置。

当前 macOS 版本使用 ad-hoc 签名；首次打开若被系统拦截，请在 Finder 中右键应用并选择“打开”。版本升级后若出现权限提示，请按工具集内的 macOS 权限说明重新允许当前版本。

## 校验与反馈

每个安装包旁边都提供同名的 `.sha256.txt` 校验文件。遇到问题时，请在 [Issues](https://github.com/Jia131313/typeless-toolkit/issues) 中附上操作系统版本、Toolkit 版本、Typeless 版本以及错误截图或日志。
