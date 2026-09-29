# 常见问题与排错

反馈问题时请提供系统、Typeless 与工具集版本，以及错误文本；不要公开账号凭证、词库或 WebDAV 密码。

**Q: 抓 token 失败 / 「CDP 无响应」?**
A: 点击「添加当前账号」时，管理器会临时用调试端口重启 Typeless，抓取完成后自动恢复普通启动。
这是唯一使用 CDP 的功能；当前账号检测、账号切换和跳过教程等日常操作不依赖调试模式。
抓取有明确超时，无论成功或失败都会尝试恢复 Typeless。请先确认 Typeless 已安装、已登录且可以正常使用。

**Q: 提示「The number of users logged into this device has exceeded the limit」怎么办？**
A: 可在「设置 → 权限与维护」手动尝试「重置设备」，不必先进入注册向导。确认后会尝试保存当前账号快照，清理设备标识、缓存及当前登录状态，并重启 Typeless 到登录页；工具集已保存的账号、快照和主词库不会删除。可以登录已有账号，不要求注册新账号，但已有快照能否直接恢复使用仍需实际验证，必要时需要重新登录。普通切号不会自动执行重置。此入口不保证解除官方服务端限制；若问题仍在，请在 Issue 中反馈系统、Typeless 版本和操作结果，不要附带登录凭证。

**Q: 打补丁后 Typeless 闪退?**
A: 日志若出现 `FATAL:asar_util.cc ... Integrity check failed`，说明完整性处理没有适配当前版本。
管理器会自动回滚：Windows 从本次文件快照还原，macOS 从补丁前的完整 `Typeless.app` 还原。若自动检测提示当前 Typeless 版本暂不支持，请更新工具或提交 issue
并附上 Typeless 版本和完整错误文本，不需要自行修改 asar。

**Q: Typeless 自动更新后弹窗又回来了?**
A: 自动更新会重写 `app.asar` 和主程序。工具集会在启动、账号变更或官方更新流程后自动检测并重新应用补丁；若 macOS 要求当前工具集身份重新获得 App 管理权限，会直接打开对应设置，允许后自动继续。

**Q: 支持 Mac/Linux 吗?**
A: **Windows 与 macOS 都支持**(平台差异集中在 `lib/platform.js`)。Linux 暂未适配。
  macOS 启动可用 Tauri 客户端或仓库根目录的 `.command` 源码脚本(首次需 `chmod +x *.command`)。详见[平台实现与配置](platform.md#macos-适配)。
