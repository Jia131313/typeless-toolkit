# macOS Tauri 轻量化迁移计划

**状态：** 进行中（仅功能分支，不合并、不发布）  
**分支：** `codex/tauri-macos-migration`  
**基线：** `origin/main` @ `4b4c104`  
**目标：** 用 Tauri 2 + macOS 系统 WKWebView 完整替换 Electron macOS 宿主，同时保留现有业务能力、用户数据路径和 Windows 实现，并按 CPU 架构与 Node 携带方式提供四个更小的 macOS 安装包。

## 1. 原始需求与已确认决策

1. macOS 不再携带 Electron/Chromium，改用 Tauri 2 和系统 WKWebView。
2. Apple Silicon 与 Intel 分开构建，不再发布 Universal 包。
3. 每种架构提供两个版本：
   - `mac-arm64-portable`：内置 arm64 Node，可直接运行；
   - `mac-arm64-lite`：使用本机 Node；
   - `mac-x64-portable`：内置 x64 Node，可直接运行；
   - `mac-x64-lite`：使用本机 Node。
4. Lite 必须适配 Finder 启动时没有交互式 shell、NVM 或 Homebrew PATH 的现实，能发现、校验并记住 Node 22.12+ 的绝对路径。
5. Toolkit 自更新按当前 `arch + edition` 选择附件，更新后保持原 edition；用户数据原地保留。
6. Bundle ID 保持 `com.typeless-toolkit.manager`，数据目录保持 `~/Library/Application Support/Typeless 工具集/data`。
7. 账号、快照、词库、WebDAV 配置等现有数据不迁移、不复制，继续读取原目录。
8. Tauri 主程序负责需要 macOS App 管理权限的最终系统写入，避免 Lite 外部 Node 成为权限主体。
9. 移植现有单实例、窗口、主题、外链、隐私设置、权限身份变化处理、Toolkit 更新等宿主能力。
10. 完成替代并确认无引用后，删除 Electron 入口、preload、依赖、构建脚本和失效测试路径。
11. Windows 保持 C# WinForms + WebView2 + Node，不迁移 Tauri，也不改变现有 Lite/Portable 发布物。
12. 整条能力闭环并经本机验收前，不合并 `main`，不创建 GitHub Release。

## 2. 非目标与边界

- 不重写 `manager.html`，继续复用现有成熟管理界面。
- 不把账号、词库、WebDAV、CDP 等 Node 业务重写为 Rust。
- 不改变 Windows 宿主、Windows 更新 helper 或 Windows 数据布局。
- 不在迁移中新增与轻量化无关的产品功能。
- 不执行真实账号切换、设备重置或修改 Typeless.app；真实补丁/官方更新写入留给用户验收阶段明确操作。
- 不提交、覆盖或打包真实 `accounts.json`、`profiles/`、词库、备份、WebDAV 密码和 `config.local.json`。

## 3. 目标架构

```text
Typeless 工具集.app（Tauri / Rust，稳定权限主体）
  ├─ WKWebView：显示现有 manager.html
  ├─ 宿主命令：主题、外链、系统设置、权限清理、打开/安装更新
  ├─ Node 生命周期：发现或启动当前 edition 对应的 Node
  └─ 特权文件操作：对 /Applications/Typeless.app 的最终写入与签名
       ↕ loopback HTTP（验证 service=typeless-toolkit）
manager.js（Node，共享业务后端）
  ├─ 账号 / 快照 / CDP / 词库 / WebDAV
  ├─ 补丁分析与待执行操作描述
  └─ Toolkit/Typeless 更新状态与下载
```

### 3.1 宿主与 Node 的职责边界

- Node 继续承担跨平台业务逻辑和本地 HTTP API，尽量避免扩大迁移范围。
- Rust/Tauri 承担桌面生命周期和 macOS 原生操作。
- 涉及 `/Applications/Typeless.app` 的替换、恢复、重签名等最终写入，Node 只准备参数/结果，Rust 执行；这样 Portable 与 Lite 的 TCC/App 管理主体一致。
- 两侧通信使用最小、显式的 Tauri command/本地 API 契约，不复制第二套业务实现。

### 3.2 数据与版本身份

- 所有 edition 和架构共享原有数据目录，不在 `.app` 内保存用户数据。
- edition 和 arch 由构建元数据确定并由宿主注入后端，用于环境展示与更新附件选择，不依赖用户手填。
- Lite 选择的 Node 绝对路径存入现有外置数据目录的 Toolkit 配置，不写死个人工作站路径。

## 4. 发行物与命名

计划采用以下稳定命名（实现时与 CI、更新器、README、Release 模板统一）：

| 架构 | Edition | 附件 |
| --- | --- | --- |
| Apple Silicon | Portable | `Typeless-Toolkit-<version>-mac-arm64-portable.dmg` |
| Apple Silicon | Lite | `Typeless-Toolkit-<version>-mac-arm64-lite.dmg` |
| Intel | Portable | `Typeless-Toolkit-<version>-mac-x64-portable.dmg` |
| Intel | Lite | `Typeless-Toolkit-<version>-mac-x64-lite.dmg` |

每个公开附件继续生成项目既有要求的 SHA-256 文件；这不是新增重复校验机制，而是维持当前 Release 契约。

## 5. 分阶段实施

### 阶段 A：现状审计与权威计划

- [x] 确认 `main` 与 `origin/main` 同步，基线为 `4b4c104`。
- [x] 确认工作区只有既有未跟踪 `output/`，明确保留。
- [x] 创建 `codex/tauri-macos-migration`。
- [x] 盘点 Electron 宿主、前端桥、构建、更新、CI、文档和测试耦合。
- [ ] 完成 Tauri 2 官方机制与最小依赖核对。
- [ ] 完成宿主/Node/App 管理权限的详细接口设计。

### 阶段 B：Tauri 宿主最小闭环

- [ ] 安装并验证 Rust/Tauri 2 构建工具链。
- [ ] 建立 `src-tauri/`，保持产品名、Bundle ID、图标和数据目录。
- [ ] 创建 WKWebView 窗口并加载已启动的本地管理服务。
- [ ] 实现单实例、窗口恢复、主题同步、外链限制和正常退出。
- [ ] 实现 Portable bundled Node 启动。
- [ ] 实现 Lite Node 发现、版本校验、选择和持久化。
- [ ] 验证 `/api/env`、`/api/current` 和已有端口服务身份校验。

### 阶段 C：macOS 原生桥与权限闭环

- [ ] 将 Electron preload 的四个桌面操作迁移为 Tauri command。
- [ ] 移植 Toolkit 自身代码身份比较和旧 TCC 记录清理。
- [ ] 将 App 管理权限所需的 Typeless.app 最终写入归到 Rust 宿主。
- [ ] 保持 Typeless 辅助功能/麦克风与 Toolkit App 管理权限的概念和提示分离。
- [ ] 验证权限设置跳转、返回后的继续操作和身份变化路径。

### 阶段 D：四包构建与自更新

- [ ] 建立 arm64/x64 × Portable/Lite 构建入口。
- [ ] 为 Portable 获取并打包对应架构 Node；Lite 不携带 Node。
- [ ] 统一 App、DMG、checksum 的架构/edition 命名。
- [ ] 修改 Toolkit 更新发现、摘要、下载和打开/安装路径，严格保持当前 edition。
- [ ] 修改 CI 为四包矩阵，Windows job 保持原样。
- [ ] 修改公开包 smoke 验证以识别 Tauri bundle、edition 和 Node 运行方式。

### 阶段 E：删除 Electron 与统一文档

- [ ] 删除 `electron-main.js`、`electron-preload.js` 和 Electron 专属脚本。
- [ ] 删除 `electron`、`electron-builder`、`@electron/fuses` 依赖与失效配置。
- [ ] 调整 Electron 专属测试/断言为 Tauri 边界，保留共享业务验证。
- [ ] 更新 README、CHANGELOG、Release 指南和发布说明生成器。
- [ ] 全仓搜索并清除失效的 Universal/Electron/macOS 旧入口引用。

### 阶段 F：验证、体积报告与用户验收

- [ ] 运行 `npm ci` / `npm run check`。
- [ ] 本机实际构建 arm64 Portable 与 Lite，并从最终产物启动验证。
- [ ] 对 x64 产物完成可在 Apple Silicon 主机上执行的静态/架构/smoke 验证；如运行验证受宿主架构限制，明确记录。
- [ ] 验证两个 edition 都复用原 Application Support 数据目录，且构建/安装未改动真实用户数据。
- [ ] 对比四个附件与安装后 App 体积，确认不再含 Electron Framework/Chromium。
- [ ] 验证旧 Electron 文件和依赖已清理，Windows 构建路径未受影响。
- [ ] 将候选版安装到本机供用户人工验收。
- [ ] 用户验收后再决定提交、PR、合并和 Release；未授权前不做后三项。

## 6. 验收标准

1. macOS App 中不存在 Electron Framework，窗口由 WKWebView 渲染，UI 与现有版本一致。
2. arm64/x64、Portable/Lite 四个 DMG 名称正确；Portable 可在无系统 Node 情况下启动，Lite 可可靠发现或引导选择 Node 22.12+。
3. App Bundle ID、用户数据路径与现有版本一致，原账号、快照、词库和 WebDAV 设置可直接读取。
4. macOS 的账号、词库、WebDAV、切号、注册、跳过引导、补丁状态、设备重置和更新入口未因换壳丢失。
5. 需要 App 管理权限的最终写入由 Tauri 主程序执行，Portable/Lite 不因 Node 路径不同产生不同权限主体。
6. Toolkit 更新只下载当前架构和 edition 的包；Windows 更新逻辑行为不变。
7. 单实例、主题、外链、系统设置跳转和退出行为达到现有 Electron 版本能力。
8. `npm run check` 通过；最终 macOS 包 smoke 通过；关键 API 在隔离数据目录下可实际访问。
9. 无真实用户数据进入构建产物或 Git；`output/` 和用户现有 Application Support 数据不被清理。
10. 迁移后的实际包体显著小于 Electron arm64 DMG（当前约 116.6 MiB），并报告真实测量值。

## 7. 风险与处理原则

- **ad-hoc 签名身份变化：** Tauri 不能消除无 Developer ID 导致的重构建身份变化。继续使用现有身份比较/旧权限记录清理机制，并把第一次 Electron → Tauri 的重新授权作为明确迁移提示。
- **Lite Node 路径：** Finder 不读取 `.zshrc`。由宿主检查已保存路径和 macOS 常见绝对路径；若没有合格 Node，提供选择本机可执行文件的明确流程，不通过隐式 shell fallback 启动。
- **跨架构 Node：** Portable 必须携带与目标 Rust 二进制同架构的 Node；构建脚本在打包时校验二进制架构。
- **x64 本机运行验证：** Apple Silicon 可构建/静态检查 x64，但 Rosetta 状态可能影响真实启动；无法在当前机器完整证明时单独列出，不用 arm64 成功代替 x64 验收。
- **权限归属改造范围：** 只迁移现有需要 App 管理权限的最终写入，不把全部 `lib/platform.js` 重写成 Rust。
- **替代清理：** 仅在 Tauri 路径实际通过验证后删除 Electron 路径，删除后用全仓引用检查证明没有旧入口残留。

## 8. 进度记录

### 2026-09-14

- 已读取最新 `AGENTS.md` 与 `README.md`，确认仓库约束和现有产品边界。
- 已确认 `main` 和 `origin/main` 无差异，创建功能分支 `codex/tauri-macos-migration`。
- 已保护既有未跟踪 `output/`，本任务不删除、不提交。
- 已完成第一轮仓库映射：Tauri 可直接复用 `manager.html`、`manager.js`、`lib/desktop-host.js` 和大部分 `lib/platform.js`；替换范围集中于 Electron host/preload、macOS 构建发布、自更新选包和 Electron 专属 smoke/test。
- 等待中的只读调研：Tauri 2 官方依赖/构建机制、宿主权限边界详细设计。

## 9. 决策日志

| 日期 | 决策 | 原因与影响 |
| --- | --- | --- |
| 2026-09-14 | 使用单一完整功能分支，不拆成可发布的半成品 | 用户要求一次性改完整；阶段只用于内部执行和验证 |
| 2026-09-14 | Node 业务后端保留，桌面壳迁到 Tauri | 直接消除 Electron 主要体积，同时避免无收益重写成熟业务 |
| 2026-09-14 | 四包而非 Universal | 避免每个用户承担另一架构和不需要的 Node 体积 |
| 2026-09-14 | 保持 Bundle ID 和 Application Support 数据目录 | 原地继承现有用户数据并减少升级迁移成本 |
| 2026-09-14 | 特权最终写入归 Tauri 主程序 | 保持 Portable/Lite 的 App 管理权限主体一致 |
| 2026-09-14 | 保留当前 Release SHA-256 契约 | 项目明确要求公开发布物带校验值，本任务不另造重复机制 |

## 10. 当前阻塞与下一步

- 当前无用户侧阻塞。
- 下一步：合并剩余调研结论，确定 Tauri 依赖和 command 契约；安装 Rust 工具链并建立可启动的最小 Tauri 宿主。
