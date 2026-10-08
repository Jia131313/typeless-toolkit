# 账号与备份

账号文件用于迁移长期登录凭证，不是整机镜像；本机快照和主词库需按页面说明分别处理。导出的 JSON 包含敏感凭证，务必妥善保管。格式规范见 [Typeless Account Bundle v1](account-bundle-format.md)。

**Q: 如何手动刷新当前登录账号?**
A: 点击右上角的账号状态条（或聚焦后按 Enter/空格）。已收录账号只会刷新显示；如果当前账号尚未收录，会直接打开“添加当前账号”窗口。日常检测只读取本地 `app-storage.json`，不会开启调试模式，也不会重启 Typeless。

**Q: token 会过期吗?**
A: Typeless 2.3.1 之后的 access token 约 24 小时有效，refresh token 约 1 年有效。工具集会在需要调用 API 时自动用 refresh token 换取新的 access token，不需要每天打开工具集续签；只有长期 refresh token 也过期或被撤销时，才需要重新登录并点「添加当前账号」。

**Q: 本地备份怎样在另一台电脑恢复？**
A: 在旧电脑打开「设置 → 同步与数据 → 数据导入与导出」，点击「导出账号备份」并选择要迁移的账号（默认选中所有可导出账号），下载 JSON；在新电脑点击「导入账号文件」，选择该 JSON，确认预览后按账号 ID 增量合并。新导入的账号需要逐个点击「在此设备启用」，由 Typeless 在新电脑建立登录态与快照。主词库使用相邻的「导出主词库」和「导入主词库」单独迁移，导入时与本机词条合并。已有的本机备份目录中，可在新电脑点击「导入旧备份」，同时选择 `accounts.json` 与主词库 CSV。旧备份缺少的快照和设备配置无法跨机直接恢复。账号文件和旧备份中的 `accounts.json` 都含长期登录凭证，应妥善保管，不要上传到公开 Issue。

Windows 发布版的本机备份目录位于工具集解压目录下的 `data/backups/`；macOS Tauri 版位于 `~/Library/Application Support/Typeless 工具集/data/backups/`。设置页的「打开备份目录」会直接打开实际目录。新建的内部副本还包含 `dictionary-sync-meta.json` 和 `account-sync-tombstones.json`，供本机数据排查；跨机导入不会原样搬运删除记录、机器路径或 WebDAV 密码。需要持续同步账号与主词库时可使用 WebDAV。

兼容工具需要生成账号文件时，参见 [Typeless Account Bundle v1 格式](account-bundle-format.md)。
