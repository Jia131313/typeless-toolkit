# Typeless Toolkit 修债对齐设计（v1.3.0）

**日期**: 2026-07-11  
**状态**: 已定稿（brainstorming 用户确认）  
**范围**: 纯修债 + 源码与 Release 对齐，不加新功能  

## 1. 背景与目标

Typeless Toolkit 已开源（`Jia131313/typeless-toolkit`），公开版 `main` 上已有：

- Typeless **2.0** 弹窗补丁标记（`BYriTiPi.mjs` + `_n(...)`）
- CDP **race / targets 端点** 修复（`ensureApp` 等端口关闭 + `/json` 与 `/json/list`）

但**打包版与 GitHub Release 落后**，且存在 **v1.10.0 / v1.2.0 版本倒挂**。用户下载 Latest 或数字更大的 tag 时，会拿到不含上述修复的 exe，表现为：打补丁失败、CDP 无响应、点启动后页面无变化等。

### 成功标准（验收）

1. **源码 = Release**：`main` 与 `v1.3.0` 打包产物中 paywall 默认与 CDP 路径一致。  
2. **Typeless 2.0 可打补丁**：本机对 2.0 执行解除弹窗，可成功或 already，不因旧 `gn(...)` 标记失败。  
3. **CDP 不再假就绪**：`ensureApp` 后立刻 capture 不再系统性出现「已就绪 → CDP 无响应」竞态路径。  
4. **版本号单调清晰**：仅保留 Latest `v1.3.0`；删除 `v1.2.0` 与 `v1.10.0`（含 tag）。

### 明确不做（本轮）

- 新功能（自动同步、额度预警、批量操作等）
- config 运行时热加载
- 根目录历史残留清理
- UI 大改、macOS 实机验证补强

## 2. 落地路线

**路线 A：源码债 → 打包同步 → 单一发版**

1. 在公开版修完剩余源码债并 push `main`  
2. robocopy 同步到打包版，`package.json` version = `1.3.0`  
3. electron-builder 出 portable exe  
4. 删除旧 Release/tag，创建 `v1.3.0` 并上传 exe  

## 3. 修债清单

| # | 项 | 落点 | 目标行为 |
| --- | --- | --- | --- |
| 1 | 2.0 弹窗标记进包 | 打包同步 `config.json` + `lib/common.js` 默认 | 与 main 一致 |
| 2 | CDP race/端点进包 | 打包同步 `lib/common.js` | 与 main 一致 |
| 3 | spawn 无 error 监听 | `lib/platform.js` `launchApp`；`launchTypeless`/`ensureApp` 可感知失败 | 失败可读，主进程不 Uncaught Exception |
| 4 | README 文案 | `README.md`（必要时补丁指南） | 平台 Win/Mac；原理/示例与 2.0 标记一致 |
| 5 | 构建/同步可靠 | `打包版/构建.bat` 或等价命令 | 同步+build 可在本环境稳定跑通 |
| 6 | Release 治理 | GitHub Releases + tags | 仅 `v1.3.0` Latest |

已在 main、只需同步的项：**不重写** 2.0 标记与 CDP 逻辑，只保证进包。

## 4. 架构与改动边界

整体架构不变：

```
公开版 (git main, 唯一真相)
  manager.js / manager.html
  lib/common.js / lib/platform.js
  config.json

打包版 (不进 git)
  electron-main.js
  package.json (version + electron-builder)
  构建同步 + dist/TypelessToolkit.exe
```

### 组件职责

| 组件 | 职责 | 本轮是否改 |
| --- | --- | --- |
| `platform.launchApp` | spawn Typeless + CDP 端口参数 | 是：error 监听/失败传播 |
| `common.ensureApp` / `launchTypeless` | 确保调试端口就绪 | 是：若 launch 失败则抛错；已有 race 修复保持 |
| `common.withCDP` / `captureTokenCDP` | CDP 抓 token | 否（逻辑已在 main） |
| `common.paywallStatus` / `patchPaywall` | 等长补丁 + 两层 hash | 否（2.0 默认已在 main） |
| `electron-main.js` | DATA_DIR、启服务、开窗 | 否 |
| 发版脚本/流程 | 同步、build、gh release | 是：跑通并固化步骤 |

### 错误处理原则

- 启动失败：`launchApp`/`launchTypeless`/`ensureApp` 失败必须传播到 HTTP 路由层；`/api/launch` 等返回 `status:FAIL` + 中文 `msg`，前端已有 toast 即够；**禁止** 主进程未捕获异常弹窗。若现有路由吞掉 error，则一并改 `manager.js` 对应路由。  
- 补丁失败：保持「未找到标记 + 从 .bak 还原」。  
- CDP 超时：保持现有文案；竞态由已合并的 ensureApp/withCDP 修复覆盖。

### 发版数据流

```
修源码债 → commit/push main
  → robocopy 公开版 → 打包版
  → version 1.3.0 → electron-builder portable
  → gh release delete v1.2.0 & v1.10.0
  → gh release create v1.3.0 + TypelessToolkit.exe
```

## 5. 验证计划

| 检查 | 方法 |
| --- | --- |
| 源码与打包一致 | 固定对比：`config.json` 的 `paywall` 段；`lib/common.js` 默认 paywall、`ensureApp`、`withCDP`（含 `/json/list`） |
| 2.0 补丁 | 本机关闭 Typeless 后 `patchPaywall` 或管理器「解除弹窗」；`paywallStatus.patched === true` 或 already |
| CDP | 启动（ensureApp）后立即添加当前账号；不应再稳定复现「已就绪 + CDP 无响应」假就绪 |
| Release | `gh release list` 仅 `v1.3.0`；资产含 `TypelessToolkit.exe` |
| spawn 错误（可选） | 临时错误 `typeless_exe` 路径，确认 API 返回可读 FAIL 文案而非主进程崩溃 |
| README | 安装要求含 Win/Mac；配置示例标记与 main 一致（`BYriTiPi` / `_n(...)`）；原理不再只写过时的 `gn(x)` 且无「仅 Windows」矛盾 |

## 6. 风险与备注

| 风险 | 缓解 |
| --- | --- |
| 上传大文件慢/卡 | 使用 `HTTPS_PROXY`（本机 Clash 7897） |
| robocopy 退出码 1 被 shell 当失败 | 用 `;` 而非 `&&`，或显式接受 0/1 |
| Typeless 进程锁 exe | 打补丁/改 exe 前强杀并等待；注意 Git Bash 下 `taskkill /F` 需 `MSYS_NO_PATHCONV=1` |
| 用户本机仍用旧 exe | Release notes 写明请下 v1.3.0；旧 tag 删除后链接失效 |

**不在本轮但已记录**：config 仅启动加载、根目录残留、spawn EACCES 在部分环境仍可能由杀软引起（有监听后至少不崩）。

## 7. 决策记录

- 升级重心：**先稳再强（修债）**  
- 边界：**纯修债**  
- 成功标准：**源码=Release + 2.0/CDP 可用**  
- 路线：**A 源码债→打包→发版**  
- 旧 Release：**删除 v1.2.0 与 v1.10.0，只留 v1.3.0**  
