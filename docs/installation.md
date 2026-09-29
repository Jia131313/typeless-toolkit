# 下载、安装与升级

安装包的实际功能以对应 [Release](https://github.com/Jia131313/typeless-toolkit/releases/latest) 说明为准。首次使用也可先看 [README](../README.md)。

## 下载选择与运行要求

Windows Release 同时提供两个 ZIP，功能完全相同：

- **Portable（推荐）**：内置 Node.js，解压后直接双击 `TypelessToolkit.exe`。
- **Lite**：体积更小，适合电脑上已经安装 Node.js 22.12+ 的用户。

macOS Release 将 Apple Silicon（arm64）与 Intel（x64）分开，每种架构均提供 Portable 和 Lite：

- **Portable（推荐）**：内置对应架构的 Node.js，打开 DMG 后拖入“应用程序”即可；
- **Lite**：不重复携带 Node.js，适合本机已有同架构 Node.js 22.12+ 的用户。Finder 启动不读取终端配置，工具集会发现、校验并记住所选 Node 路径。

升级只替换 App 本体，账号、快照、词库和配置继续保存在
`~/Library/Application Support/Typeless 工具集/data/`。每个附件均提供独立 SHA-256 校验文件。

工具集会在启动后检查 GitHub Release，并展示版本说明。Windows 的 Portable/Lite 包可由工具集下载、
校验 SHA-256 后在退出时自动替换程序文件，保留 `data/` 中的账号、快照、词库和配置；macOS 当前
使用 ad-hoc 签名，工具集会按当前 CPU 架构和 Portable/Lite 类型下载并打开已校验的 DMG，仍需手动拖入“应用程序”完成替换。这里的
“工具集更新”与“安装 Typeless 官方更新”位于「设置 → 关于与更新」，是两个独立入口，后者只处理 Typeless 本体。
发现可用更新时，首页和设置会显示升级提示，点击对应入口即可打开更新窗口；macOS 本体更新提示仅代表已发现本地缓存包。

两个版本都只有一个需要操作的入口，并会把账号、配置和快照保存在解压目录的 `data/` 中。
升级时请保留该目录。除此之外还需要：

- **Microsoft Edge WebView2 Runtime**（多数 Windows 10/11 电脑已安装；缺失时程序会提示）
- **curl**（Windows 10 1803+ / macOS 自带，用于调用 Typeless API）
- **已安装 Typeless 桌面端**
- **无需管理员权限**：Typeless 位于用户目录，普通权限即可运行；macOS 修改应用后需 ad-hoc 重签名

源码运行仍需要 Node.js 22.12+。Windows 发布包适用于 x64；源码同时保留 macOS 支持，Linux 未适配。

## 快速开始

1. **配置**(可选):打开 `data/config.json`(release) 或根目录 `config.json`(源码),若 Typeless 不在默认安装路径,填 `typeless_exe`。
2. **启动管理器**:
   - Windows release：双击 `TypelessToolkit.exe`
   - 源码：`node manager.js` 后访问 `http://127.0.0.1:7788`
   - macOS 客户端：`npm run build:mac` 生成当前架构的 Portable DMG；用 `npm run build:mac:all` 生成四种公开包
3. **添加账号**:在 Typeless 里登录第一个账号 → 管理器点「添加当前账号」(会自动抓 token)。
4. **词库自动对齐**:添加账号、编辑词库或启动工具集后会自动检查，各账号词库无需手动导入；顶部状态入口可查看结果或立即重试。
5. **切换账号**:账号卡片点「切换到此号」(从快照还原 + 重启 Typeless)。
6. **跨设备同步**(可选):打开「设置 → 同步与数据」，选择坚果云或其他 WebDAV，填写应用密码和一条各设备相同的同步密码；账号和主词库可分别选择或同时同步，保存后会记住配置。
7. **自动解除弹窗**:工具集启动、账号变更或安装官方更新后会检查并自动修复；顶部状态按钮保留为立即检查/失败重试入口。Windows 保留文件级 `.bak`，macOS 会在事务期间临时备份完整 `Typeless.app`，失败自动还原，成功验证并启动后立即清理临时副本。

首页保留启动 Typeless、刷新、主词库、注册账号和添加当前账号五个常用操作。主题和快捷键位于
「设置 → 通用」；WebDAV 与本地备份位于「同步与数据」；弹窗维护和 macOS 权限说明位于
「权限与维护」，这里也提供独立的「重置设备」入口。账号卡片中的详情、快照状态和切换入口保持可见。

源码模式也可以直接运行 `同步词库.bat` 或 `node typeless-dict-sync.js`。

## Windows 桌面窗口与托盘

release 版只有一个入口：`TypelessToolkit.exe`。

- 双击 EXE 会启动本地服务，并在程序自己的 WebView2 独立窗口中打开管理器。
- 窗口标题栏、Windows 任务栏、系统托盘和 Web 页面使用同一套应用图标。
- WebView2 使用 Per-Monitor V2 高 DPI 渲染，标题栏颜色会跟随页面深浅主题。
- 默认窗口最多为 1440×880，并自动适应屏幕工作区；首页保留高频操作，配置类入口集中在设置，工具栏和账号卡片随窄窗口自适应排列。
- 点击窗口关闭按钮会收纳到托盘；双击托盘图标或再次双击 EXE 可恢复窗口。
- 托盘右键→「退出」才会关闭窗口及由它启动的后端进程。
- 修改源码后运行 `build-release.bat`，会重新生成单入口 release 包；Windows 编译中间产物统一放在 `.build/windows/`，不会散落到源码根目录。

`build-release.bat` 用于更新本机自用包，会保留已有账号和快照。准备公开附件时必须运行
`build-public-release.bat`，它会生成：

- 文件名以 `win-x64-portable.zip` 结尾的 ZIP：内置经过 SHA-256 校验的 Node.js
- 文件名以 `win-x64-lite.zip` 结尾的 ZIP：使用系统 Node.js 22.12+

两个公开包都会强制使用空账号列表和空 `profiles/`，并分别输出 SHA256 文件。绝不能直接上传
本机自用 release 目录。
