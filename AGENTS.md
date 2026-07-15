# Typeless Toolkit 项目协作记忆

本文件是仓库级开发约定。开始修改前先阅读本文与 `README.md`；若本机存在未跟踪的
`LOCAL_DEVELOPMENT.md`，再读取其中的工作站路径和本地发布注意事项。

## 仓库与协作流程

- 正式仓库：`Jia131313/typeless-toolkit`，本地远端名为 `origin`。
- `ygttygtt/typeless-toolkit` 仅作为历史 fork，本地远端名为 `fork`。
- `main` 是受保护的集成基线。即使拥有写权限，也默认从最新 `origin/main` 创建功能分支，
  推送后通过 PR 合并；不要直接推送 `main`。
- 开发前执行 `git switch main`、`git pull --ff-only origin main`，再创建 `codex/<topic>` 或清晰命名的功能分支。
- 2026-07-15：PR #5 已将 Windows 桌面壳、多账号体验与双发布包完整并入；PR #6 又加入
  macOS Electron 客户端和官方升级功能。后续开发必须以当前上游代码为准，不从旧 fork 重放整套实现。

## 项目结构

- `manager.js`：本地 HTTP API；既可直接运行，也向 Electron 客户端导出 `startServer()`、`server` 和 `PORT`。
- `manager.html`：成熟的单页管理界面。不要另建简陋前端或把页面重写进 C#/Electron。
- `lib/common.js`：账号、快照、CDP、词库、补丁与通用环境探测。
- `lib/platform.js`：Windows/macOS 的进程、路径、凭据、启动和签名差异。
- `lib/official-update.js`：macOS 官方更新包的发现、校验、安装与回滚。
- `main.cs`：Windows WebView2 独立窗口、单实例和托盘宿主；不承载业务 UI。
- `electron-main.js`：macOS Electron 宿主，复用同一个 `manager.js` 服务和 `manager.html`。
- `gen-icon.cs`、`icon/`、`assets/`：Windows ICO/圆角 PNG 与 macOS SVG/ICNS 资源。
- `test/`：Node 内置测试，当前覆盖付费墙目标检测和官方升级逻辑。
- `build-tray.bat`：编译 Windows C# 宿主。
- `build-release.bat`：更新本机自用 Windows 包，必须保留已有 `data/`。
- `build-public-release.bat/.ps1`：生成脱敏的 Windows Lite/Portable ZIP 和 SHA256。

## 不可破坏的产品约束

1. 日常操作尽量不影响正在使用的 Typeless。
   - 当前账号优先读取 `app-storage.json`。
   - 跳过教程读取/写入 `app-onboarding.json`。
   - CDP 主要用于新增或更新账号凭证；临时调试启动必须有超时，并在 `finally` 中恢复普通模式。
2. Windows 只有一个用户入口 `TypelessToolkit.exe`：独立 WebView2 窗口、托盘、单实例和后端生命周期由它统一管理。
3. 关闭 Windows 窗口只收纳到托盘；托盘“退出”才结束宿主及其启动的后端。
4. 任务栏、标题栏、托盘、Web logo/favicon 必须从同一图标源派生，并保留透明圆角。
5. `manager_port` 来自配置。复用已监听端口前必须请求 `/api/env` 并验证 `service=typeless-toolkit`，不能只检查 TCP 监听。
6. 用户数据与代码分离。不得提交或覆盖真实 `accounts.json`、`profiles/`、词库 CSV、备份和 `config.local.json`。
7. 公开包只能由公开构建脚本生成，必须使用示例账号、空 `profiles/`，并输出校验值；禁止直接压缩自用目录。
8. 付费墙补丁必须语义定位真实 handler，不能退回“第一个含 paywall 的脚本”。失败时必须事务回滚并尽量恢复 Typeless。
9. macOS 官方升级必须保留 SHA-512、版本、Bundle ID、Developer ID、Gatekeeper 校验和失败回滚。

## 开发与验证命令

需要 Node.js 22.12+。新环境先运行：

```powershell
npm ci
npm run check
```

`npm run check` 包含所有关键 JS 的语法检查和 `node --test`。改动相应平台后再运行：

```powershell
cmd.exe /c build-tray.bat
cmd.exe /c build-public-release.bat
```

macOS 构建在 Mac 上运行：

```bash
npm run build:mac
# 或
npm run build:mac:universal
```

验证范围应与改动风险匹配：

- API/账号改动：检查 `/api/env`、`/api/current`，并覆盖成功、失败、超时和恢复路径。
- UI 改动：至少检查约 1200px 默认宽度与约 880px 窄窗口，无横向溢出或孤立按钮。
- Windows 宿主：检查双击启动、单实例恢复、托盘、暗色标题栏、任务栏/窗口图标和配置端口。
- 发布改动：从最终 ZIP 重新解压启动；确认 Portable 使用包内 Node、Lite 不含 Node、公开数据已脱敏。
- 补丁/升级改动：优先使用只读状态探测和测试夹具；涉及真实程序文件前必须有本次操作的回滚快照。

## 版本与发布注意事项

- `package.json` 当前版本为 1.4.0。
- Windows 发布脚本和 `main.cs` 中仍可能保留 1.3.1 常量。创建下一次 Release 前必须统一
  package、程序集、脚本文件名、README 和标签版本；不要上传版本号不一致的附件。
- GitHub Release 是独立发布动作。代码合并不会自动替换旧 Release 附件。

## 实现偏好

- 优先扩展已有模块，避免平行实现相同功能。
- C# 由 .NET Framework 4.x `csc.exe` 编译，按现有兼容语法书写；不要引入需要新 SDK 的语言特性。
- 不恢复手工拆 asar、打开 DevTools、填写混淆变量的旧指南。无法自动适配时返回明确错误并要求提供版本/错误信息。
- 不把个人工作站路径、账号或令牌写入跟踪文件；本机差异只放 `LOCAL_DEVELOPMENT.md`。

