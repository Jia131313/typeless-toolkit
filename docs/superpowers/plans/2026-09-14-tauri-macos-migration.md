# macOS Tauri 轻量化迁移计划

**状态：** 已完成（PR #25、v1.8.0 Release 与本机 arm64 Lite 安装均已验收）

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
12. 整条能力闭环并经本机验收前，不合并 `main`，不创建 GitHub Release；2026-09-14 用户已验收当前候选并授权通过最终验证后提交 PR、合并和发布。
13. 正式发布后，本机只安装 Apple Silicon Lite，复用已有 Node 环境；其他架构和 Portable 仅作为 Release 产物，不保留测试安装。

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
- [x] 完成 Tauri 2 官方机制与最小依赖核对。
- [x] 完成宿主/Node/App 管理权限的详细接口设计。

### 阶段 B：Tauri 宿主最小闭环

- [x] 安装并验证 Rust/Tauri 2 构建工具链。
- [x] 建立 `src-tauri/`，保持产品名、Bundle ID、图标和数据目录。
- [x] 创建 WKWebView 窗口并加载已启动的本地管理服务。
- [x] 实现单实例、窗口恢复、主题同步、外链限制和正常退出。
- [x] 实现 Portable bundled Node 启动。
- [x] 实现 Lite Node 发现、版本校验、选择和持久化。
- [x] 验证 `/api/env`、`/api/current` 和已有端口服务身份校验。

### 阶段 C：macOS 原生桥与权限闭环

- [x] 将 Electron preload 的四个桌面操作迁移为 Tauri command。
- [x] 移植 Toolkit 自身代码身份比较和旧 TCC 记录清理。
- [x] 将 App 管理权限所需的 Typeless.app 最终写入归到 Rust 宿主。
- [x] 保持 Typeless 辅助功能/麦克风与 Toolkit App 管理权限的概念和提示分离。
- [x] 验证权限设置跳转、返回后的继续操作和身份变化路径。

### 阶段 D：四包构建与自更新

- [x] 建立 arm64/x64 × Portable/Lite 构建入口。
- [x] 为 Portable 获取并打包对应架构 Node；Lite 不携带 Node。
- [x] 统一 App、DMG、checksum 的架构/edition 命名。
- [x] 修改 Toolkit 更新发现、摘要、下载和打开/安装路径，严格保持当前 edition。
- [x] 修改 CI 为四包矩阵，Windows job 保持原样。
- [x] 修改公开包 smoke 验证以识别 Tauri bundle、edition 和 Node 运行方式。

### 阶段 E：删除 Electron 与统一文档

- [x] 删除 `electron-main.js`、`electron-preload.js` 和 Electron 专属脚本。
- [x] 删除工具集宿主的 `electron`、`electron-builder` 依赖与失效配置；保留修改 Typeless 本体所需的 `@electron/fuses`。
- [x] 调整 Electron 专属测试/断言为 Tauri 边界，保留共享业务验证。
- [x] 更新 README、CHANGELOG、Release 指南和发布说明生成器。
- [x] 全仓搜索并清除失效的 Universal/Electron/macOS 旧入口引用；历史版本记录与 Typeless 本体 Electron 说明保留。

### 阶段 F：验证、体积报告与用户验收

- [x] 运行 `npm ci` / `npm run check`。
- [x] 本机实际构建 arm64 Portable 与 Lite，并从最终产物启动验证。
- [x] 对 x64 产物完成可在 Apple Silicon 主机上执行的静态/架构/smoke 验证；当前机器没有 Rosetta，真实 x64 GUI 留给 Intel/CI。
- [x] 验证两个 edition 都复用原 Application Support 数据目录，且构建/安装未改动真实账号、词库或 profiles；Lite 仅按设计记忆 `node_path`。
- [x] 对比四个附件与安装后 App 体积，确认不再含 Electron Framework/Chromium。
- [x] 验证旧 Electron 文件和依赖已清理；Windows 源码路径未改，实际 Windows 构建由 CI 验证。
- [x] 将最终 arm64 Portable 候选安装到本机供用户人工验收。
- [x] 用户已完成候选验收并授权提交 PR、合并和 Release。
- [x] 统一 v1.8.0 版本、完成最终检查，通过 PR 合并后由 GitHub Actions 构建并发布。
- [x] 安装正式 arm64 Lite，验证自动发现/记忆本机 Node，并清理其他测试安装与临时资源。

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
- **外部页面权限面：** WKWebView 继续打开本地 HTTP 页面，但不给该 remote origin 开放宽泛 Tauri API；页面桌面操作先走 Node API，再经专用宿主协议到 Rust。
- **Tauri 原生 updater：** 官方 updater 强制 `.app.tar.gz` 签名密钥，与本项目当前只有 SHA-256 的 ad-hoc DMG 发布契约不兼容。本轮继续使用现有 GitHub Release 下载 + DMG 安装动线，只把附件匹配扩展为 `arch + edition`；不为换壳额外引入发布私钥体系。
- **替代清理：** 仅在 Tauri 路径实际通过验证后删除 Electron 路径，删除后用全仓引用检查证明没有旧入口残留。

## 8. 进度记录

### 2026-09-14

- 已读取最新 `AGENTS.md` 与 `README.md`，确认仓库约束和现有产品边界。
- 已确认 `main` 和 `origin/main` 无差异，创建功能分支 `codex/tauri-macos-migration`。
- 已保护既有未跟踪 `output/`，本任务不删除、不提交。
- 已完成第一轮仓库映射：Tauri 可直接复用 `manager.html`、`manager.js`、`lib/desktop-host.js` 和大部分 `lib/platform.js`；替换范围集中于 Electron host/preload、macOS 构建发布、自更新选包和 Electron 专属 smoke/test。
- 已完成 Tauri 2 官方调研：锁定稳定 2.x；Portable 使用官方 Node 原始 runtime 作为 external binary，Lite 不依赖尚未正式发布的 `fix-path-env-rs`。
- 已确定页面不直接获得通用 Tauri 能力：新增 Node ↔ Rust 的逐行 JSON 宿主协议，页面的桌面操作改走受限本地 API。
- 已确定去弹窗与官方更新采用“Node 在 Application Support staging 中准备和校验，Rust 对 `/Applications/Typeless.app` 做最终 swap/回滚”的权限边界。
- 已确认 `@electron/fuses` 仍是 Typeless 本体补丁依赖，不能随工具集 Electron 宿主一起删除。
- 已用 rustup 官方安装器安装最小稳定工具链：`rustc 1.98.1`、`cargo 1.98.1`，当前已安装目标为 `aarch64-apple-darwin`。
- 已实现 Toolkit 更新资产的四维精确命名和选择：macOS 同时校验 `arch + edition`，不再接受 Universal 默认包；focused 测试 14/14 通过。
- 已建立 Node 侧 `lib/tauri-host.js` JSONL client 和显式桌面启动参数，Tauri 模式 stdout 专用于协议、普通日志转 stderr。
- 已将前端主题、隐私设置、TCC 清理和打开 Toolkit DMG 改为受限 `/api/desktop-host` → Rust 领域命令；原 Electron bridge 在迁移未清理前仅作为旧版兼容路径。
- 已将 macOS 去弹窗流程改为在 `data/staging` 的 Typeless.app 副本上补丁/重签，然后调用 Rust `swap_typeless_app`；原地写入仅保留给非 Tauri 源码/旧宿主路径。
- 已为官方更新加入同一 Rust swap 回调边界，原有 SHA-512、版本、Bundle ID、Developer ID、Team ID 和 Gatekeeper 预验证保持不变。
- 已运行 Node 语法检查、macOS 签名/官方更新/Toolkit 更新 focused 测试 22/22，以及管理器 UI/设置/更新/本地 API 测试 42/42，均通过；未对真实 Typeless.app 执行写入。
- 已移除 npm 中工具集宿主的 `electron` / `electron-builder`，接入 `@tauri-apps/cli 2.11.4`；`npm run check` 全量 152 项通过。
- arm64 Lite 首次实际 DMG 构建约 6.4 MiB，挂载后的 Bundle ID、签名、资源、无 Electron Framework 和隔离 API smoke 均通过。
- arm64 Portable 首次 DMG 约 41 MiB；发现 sidecar 经 Hardened Runtime 签名后 `node --version` 可用但执行 JavaScript 会 `SIGTRAP 133`。已定位为 V8 JIT entitlement 缺失，当前正在修正嵌套 Node 签名配置后重打；该产物暂不计为通过。
- 已为内置 Node 补齐 V8 JIT 所需的 `allow-jit` 与 `allow-unsigned-executable-memory` entitlement；最新 arm64 Portable DMG 内的 Node 已能执行 JavaScript、启动包内 `manager.js` 并通过隔离 API smoke。
- 已完成四种发行物的构建与静态/资源验证：arm64 Lite 约 6.4 MiB、arm64 Portable 约 41.0 MiB、x64 Lite 约 6.6 MiB、x64 Portable 约 43.0 MiB；当前机器没有 Rosetta，x64 Portable 的真实运行仍需 Intel/CI 环境证明。
- 已完成 `npm run check`（152/152）、macOS 签名/官方更新/Toolkit 更新 focused 测试（22/22）、管理器 UI/安全 focused 测试（42/42）、`cargo fmt --check`、`cargo clippy -D warnings`、`cargo check`、Entitlements plist 校验和 `git diff --check`。
- 已确认上轮误启动的递归 `shasum` 进程已经结束；后续安装前后数据一致性只核对账号、主词库、同步元数据、配置与 `profiles/` 聚合，不扫描 `backups/`、`logs/` 或 `staging/`。
- 当前准备安装最新 `mac-arm64-portable` 候选，验证真实 Rust → Node → JSONL broker → WKWebView 链路、单实例、窗口生命周期和退出回收；本阶段不执行真实补丁、官方更新、切号或设备重置。
- 已完成首轮 arm64 Portable 真机安装：Rust 主程序成功启动内置 Node，`/api/env`、`/api/current`、首页、JSONL 宿主命令和主题切换均正常；二次打开保持同一主进程和同一 Node，用户数据摘要与 Typeless 本体进程均未变化。
- 首轮真机窗口生命周期发现缺陷：点击窗口关闭按钮会结束 Tauri 与 Node，而目标是隐藏窗口并保持后台。已在 Tauri 全局窗口事件中拦截 `CloseRequested` 并隐藏窗口，待重打后同时复测关闭/恢复与 `Cmd-Q` 真正退出。
- 已重打并安装修正版 arm64 Portable：关闭窗口后 Rust、Node 和 API 均保持；再次打开恢复同一组 PID；`Cmd-Q` 后 Rust、Node 和监听端口全部退出，Typeless 本体原 PID 保持；再次启动恢复正常。阶段 B 的真实 GUI、单实例、主题和生命周期闭环通过。
- 下一步安装 arm64 Lite 真机验证。本次允许的预期数据变化仅为 Lite 将合格 Node 的绝对路径写入 `data/config.json.node_path`；验证完成后恢复安装 Portable 候选供用户验收。
- arm64 Lite 真机验证通过：App 内不含 Node，首次从 NVM 发现 arm64 Node 22.23.2 并记忆 `node_path`；完全退出后重启改为 `node_source=configured`。随后已恢复安装 arm64 Portable 供用户继续使用。
- 已开始阶段 E 清理：删除工具集旧 Electron host/preload 与旧 macOS 构建脚本，并移除前端 Electron bridge fallback；历史设计文档和面向 Typeless 本体的 Electron/fuse/签名说明不属于失效入口，继续保留。
- 最终安装核对发现 Tauri 身份迁移解析缺陷：macOS `codesign -d -r-` 输出以 `# designated =>` 开头，Rust 只接受无 `#` 形式，导致 reconcile 记录未更新。已改为从输出行中的 `designated =>` 片段解析；待重打安装后验证新身份写入、`regrant_required=true`，以及第二次启动不重复清理。
- Lite → Portable 替换核对发现旧 Lite Node 在 Rust 宿主被终止后成为孤立进程，占用原 7788 端口，新 Portable 因而启动到 7789。已将 JSONL stdin 关闭定义为 Node 退出信号，并让本地安装器同时停止目标 App `Resources/server/manager.js`；待重打后验证原端口复用且无孤立后端。
- 终端直启捕获到身份解析仍失败的准确原因：`codesign` 将 designated requirement 写到 stdout，而 Rust 只读取 stderr（stderr 只有 Executable 行）。已改为合并 stdout/stderr 后解析；不再猜测系统权限行为。
- 身份迁移修复已通过真机：状态文件写入当前 Tauri CDHash，`regrant_required=true`、旧授权时间清空；同一构建完全退出再启动时文件摘要和 mtime 均不变，证明不会重复清理 TCC。
- 宿主异常终止验证通过：向 Rust 主进程发送终止信号后，Node 因 JSONL stdin 关闭自动退出，7788 立即释放；再次启动恢复单一 Portable 主进程和单一内置 Node，无孤立后端。
- 已从包含全部修复和 Electron 清理的最终代码重建四包并逐包通过 headless manager/API smoke；最终 DMG 为 arm64 Lite 6.4 MiB、arm64 Portable 41 MiB、x64 Lite 6.6 MiB、x64 Portable 43 MiB。
- 已将最终 arm64 Portable 安装到 `/Applications/Typeless 工具集.app`：严格签名验证通过，App 内无 Electron Framework/app.asar；只运行一个 Rust 主程序和一个 arm64 bundled Node，监听 7788。Typeless 本体仍为原 PID 28127。
- 安装前后账号、主词库、`config.local.json` 与 6 个 profiles 摘要一致；`config.json` 的唯一预期变化是 Lite 验证写入 `node_path`。本轮未产生新的 Typeless App 备份或 staging 残留，也没有遗留临时安装 App。
- 用户反馈连续四包重建时 Tauri 的 DMG 布局步骤反复弹出 Finder 窗口并打断输入。已确认不是安装四份软件：本机只使用 arm64 Portable，其余三包仅为发布产物；所有挂载与构建进程已结束。最后一次逐包验证改用无界面挂载，后续不再重复构建或安装。最后一次重建相对已安装候选只更新包内 README 文案，不为此再次重启用户 App。
- 用户已验收当前候选并授权：最终验证通过后提交 PR、合并并发布 Release；正式发布采用 v1.8.0。本机最终改装 arm64 Lite，复用并记忆现有 NVM Node，不保留其他测试安装。
- 发布前复核已完成第一轮：`npm run check` 152/152，通过 Rust fmt、clippy、check、Entitlements 与 diff 检查；四个 v1.7.1 最终候选均通过无界面挂载的包结构和隔离 manager/API smoke。正式四包由 GitHub Actions 在 v1.8.0 标签上重建，避免本机 DMG 布局反复唤起 Finder。
- 已创建中文标题 PR #25 并在提交 `82eafb9` 上触发分支预构建。发布阻断审查发现 Tauri swap/restore 仍固定写入 `/Applications/Typeless.app`，会破坏既有的 `~/Applications` 与自定义 `typeless_exe` 支持；已取消该次预构建，改为由 Node 把实际探测到的目标 App 明确传给 Rust，swap 和 restore 必须使用同一目标。
- 该次远端 macOS 构建还暴露了干净 checkout 缺少生成态 `assets/icon-rounded.png`：构建脚本错误地在图标生成前准备 bundle。本地之所以未暴露，是旧生成文件仍在工作区。已调整为先从跟踪的 `icon/icon.png` 生成图标，再准备公开 bundle；修复后重新运行完整预构建。
- 同轮审查发现 Tauri 完成官方更新 swap 后，Node 的官方签名/版本二次校验若失败，原 catch 只处理旧 Node 安装路径，未调用 Rust 恢复已创建的备份。已给官方更新接入配对的宿主恢复回调，失败时复用同一备份恢复同一 `target_app`，不增加第二份备份。
- PR #25 最终 head `2a2bc6f` 的远端预构建 [Actions #34805913904](https://github.com/Jia131313/typeless-toolkit/actions/runs/34805913904) 已完成：Windows、macOS job 均成功，分支构建的 Release job 按设计跳过；macOS job 完成四包编译以及版本、架构、edition、资源和后端 smoke，Windows job 完成全量检查、更新替换/恢复 smoke、双包构建及解压 smoke。
- 已下载预构建 artifacts 到临时目录复核：Windows Lite/Portable 与 macOS arm64/x64 × Lite/Portable 共 6 个安装包及各自 SHA-256 文件，总计 12 个文件，命名和 v1.8.0 版本一致，无 Universal、旧版本或额外附件；6 个安装包的实际 SHA-256 均与随附记录一致。PR 当前为 `MERGEABLE / CLEAN`。
- PR #25 已于 2026-09-14 合并到 `main`，merge commit 为 `d361227`；最终功能代码与通过预构建的 `2a2bc6f` 一致，后续提交仅补充发布验证记录。
- 已创建并推送 `v1.8.0` 标签。正式 [Actions #34806654235](https://github.com/Jia131313/typeless-toolkit/actions/runs/34806654235) 全部成功：Windows 3m10s、macOS 8m16s、Release 15s；Windows 双包和 macOS 四包均完成各自 smoke 后上传。
- [v1.8.0 - macOS Tauri 轻量客户端](https://github.com/Jia131313/typeless-toolkit/releases/tag/v1.8.0) 已发布，状态为非草稿、非预发布；6 个安装包和 6 个配套 SHA-256 文件全部存在，无 Universal、旧版本或额外附件。
- 已从正式 Release 下载并校验 `Typeless-Toolkit-1.8.0-mac-arm64-lite.dmg`，无界面替换 `/Applications/Typeless 工具集.app`。安装后版本 1.8.0、Bundle ID `com.typeless-toolkit.manager`、arm64/Lite 元数据和签名结构正确，App 内不含 bundled Node 或 Electron Framework。
- 正式 Lite 真机启动验证通过：`/api/env` 返回 `service=typeless-toolkit`、`desktop_host=tauri`、`toolkit_edition=lite`、`toolkit_arch=arm64`；唯一 Node 子进程来自已记忆的 `/Users/ygtt/.nvm/versions/node/v22.23.2/bin/node`，`node_source=configured`。重复打开保持同一 Rust/Node PID，7788 正常监听，`/api/current` 返回 OK。
- 安装前后账号、主词库、`config.local.json`、`config.json` 的 SHA-256 及 profiles 统计完全一致；Typeless 本体保持原 PID 28127。`/Applications` 只保留正式 Typeless 工具集与 Typeless 本体，没有临时 App 或 DMG 挂载。
- 已清理约 4.6 GiB 可重建测试资产：旧 `dist/` 四包、`.build/macos/`、`src-tauri/target/`、预构建 artifacts 和正式 Lite 下载临时目录；保留既有未跟踪 `output/`、Application Support 用户数据与正式安装 App。

## 9. 决策日志

| 日期 | 决策 | 原因与影响 |
| --- | --- | --- |
| 2026-09-14 | 使用单一完整功能分支，不拆成可发布的半成品 | 用户要求一次性改完整；阶段只用于内部执行和验证 |
| 2026-09-14 | Node 业务后端保留，桌面壳迁到 Tauri | 直接消除 Electron 主要体积，同时避免无收益重写成熟业务 |
| 2026-09-14 | 四包而非 Universal | 避免每个用户承担另一架构和不需要的 Node 体积 |
| 2026-09-14 | 保持 Bundle ID 和 Application Support 数据目录 | 原地继承现有用户数据并减少升级迁移成本 |
| 2026-09-14 | 特权最终写入归 Tauri 主程序 | 保持 Portable/Lite 的 App 管理权限主体一致 |
| 2026-09-14 | 保留当前 Release SHA-256 契约 | 项目明确要求公开发布物带校验值，本任务不另造重复机制 |
| 2026-09-14 | 不采用 Tauri updater 插件 | 它强制引入 updater 私钥和 `.app.tar.gz/.sig` 发布链；本轮保持现有 DMG 更新产品动线即可满足目标 |
| 2026-09-14 | 页面桌面操作经 Node 宿主协议转发 | 同时服务前台按钮和后台自动维护，不向 localhost 页面开放通用 Tauri IPC |
| 2026-09-14 | 保留 `@electron/fuses` | 它用于修改目标 Typeless 的 Electron fuse，不是工具集 Electron 壳依赖 |

## 10. 当前阻塞与下一步

- 当前无用户侧阻塞。
- macOS Tauri 迁移、四包拆分、Lite Node 自动发现、PR 合并、v1.8.0 Release、本机正式 arm64 Lite 安装、数据保留核对和测试资产清理均已完成。当前仅保留已知验证边界：x64 通过 CI 构建、签名、Mach-O 架构、资源和后端 smoke，没有 Intel 真机 GUI 证据。
