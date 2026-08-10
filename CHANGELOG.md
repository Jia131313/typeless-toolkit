# 更新日志

## 1.5.0 - 2026-08-10

### macOS

- 完成账号管理、账号切换、词库同步、设备重置、注册流程、跳过教程和去弹窗功能对齐。
- 去弹窗前创建完整 App 回滚快照，定向重签 Electron Framework 与根 Bundle，并保留运行权限和 Hardened Runtime。
- 增加补丁后签名、启动存活检查、失败诊断日志及事务回滚。
- 修复辅助功能身份变化提示、Spotlight 重复应用、应用内图标、单实例与端口冲突问题。
- 深色模式同步 macOS 原生标题栏；重写“注册并添加新账号”流程说明。
- 增加 `npm run deploy:mac`，自动构建、替换、验证并复用现有用户数据。

### 通用

- 当前账号日常检测改为只读本地存储，不再隐式重启 Typeless 或开启 CDP。
- 新手引导状态覆盖 live 文件与账号快照，切号后可自动补齐缺失标记。
- 本地 HTTP 服务验证 Host/Origin，账号列表不再向前端返回 bearer token。
- 增加桌面宿主、管理器安全、新手引导、macOS 签名及官方升级测试。
- 新增标签触发的 GitHub Actions，统一构建 Windows Lite/Portable 与 macOS Universal DMG，并发布 SHA-256 校验文件。
