## 下载与安装

请在本页面底部的 **Assets** 中选择与你的平台对应的安装包：

| 平台 | 推荐文件 | 适用情况 |
| --- | --- | --- |
| Windows | `TypelessToolkit-v{{VERSION}}-win-x64-portable.zip` | **推荐大多数用户使用**，已内置 Node.js，解压后运行 `TypelessToolkit.exe` |
| Windows | `TypelessToolkit-v{{VERSION}}-win-x64-lite.zip` | 体积较小，电脑需要已安装 Node.js 22.12+ |
| macOS | `Typeless-Toolkit-{{VERSION}}-universal.dmg` | 同时支持 Apple Silicon 与 Intel Mac，拖入“应用程序”即可 |

Windows 版本需要 Microsoft Edge WebView2 Runtime；多数 Windows 10/11 电脑已自带。

## 已安装用户如何升级

如果当前版本已有「工具集更新」，可在工具集内检查并下载新版：Windows 确认后自动替换程序，macOS 下载后仍需拖入「应用程序」。尚无此入口的旧版用户请按下方步骤手动升级。

### Windows

1. 从托盘菜单退出 Typeless 工具集。
2. 将新版 ZIP 解压到一个新目录。
3. 把旧目录中的整个 `data/` 文件夹移动到新目录，替换新版包内的空 `data/`。
4. 启动新目录中的 `TypelessToolkit.exe`，确认账号与词库正常后即可删除旧程序目录。

不要用公开包内的空 `data/` 覆盖自己的旧数据；其中保存了账号、登录快照、词库和配置。

### macOS

打开新版 DMG，将“Typeless 工具集”拖入“应用程序”并选择替换。用户数据保存在 `~/Library/Application Support/Typeless 工具集/data/`，替换 App 本体不会删除账号、快照、词库或配置。

当前 macOS 版本使用 ad-hoc 签名；首次打开若被系统拦截，请在 Finder 中右键应用并选择“打开”。版本升级后若出现权限提示，请按工具集内的 macOS 权限说明重新允许当前版本。

## 校验与反馈

每个安装包旁边都提供同名的 `.sha256.txt` 校验文件。遇到问题时，请在 [Issues](https://github.com/Jia131313/typeless-toolkit/issues) 中附上操作系统版本、Toolkit 版本、Typeless 版本以及错误截图或日志。
