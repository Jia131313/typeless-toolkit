# Typeless Account Bundle v1

工具集的「导出账号备份」下载此格式的 JSON 文件。「导入账号文件」接受同一格式，供换机和兼容工具交换长期账号凭证。独立 Registrar 若要生成可导入文件，也应使用这个协议；当前 Registrar 原型尚未实现正式导出。

```json
{
  "format": "typeless-account-bundle",
  "version": 1,
  "exported_at": "2026-09-29T00:00:00.000Z",
  "source": "typeless-toolkit",
  "accounts": [
    {
      "user_id": "usr_example",
      "nickname": "示例账号",
      "email": "example@example.com",
      "refresh_token": "<该账号未过期的 Typeless refresh JWT>",
      "client_user_id": "cli_example",
      "role": "free",
      "updated_at": "2026-09-29T00:00:00.000Z"
    }
  ]
}
```

`format`、整数 `version`、ISO 8601 `exported_at` 和 `accounts` 数组必需。每条账号必须包含 `user_id` 与未过期、类型为 `refresh`、JWT 中 `subject.user_id` 一致的 `refresh_token`。`nickname`、`email`、`client_user_id`、`role` 和 `updated_at` 是可选显示/来源字段；额外字段会忽略。

导出可选择一个或多个账号，只包含所选账号的有效长期凭证，不含短期 access token、登录快照、主词库、设备标识或 WebDAV 密码。导入按 `user_id` 合并：保留本机账号与登录状态，新增账号标记为待在本机启用；凭证按 JWT 的 `iat`、`exp` 选择较新者，时间相同则保留本机凭证。导入不会自动删除账号或切换 Typeless。

文件是明文，含可用于登录的长期凭证。不要公开分享，导入后妥善保管。离线 JWT 检查无法证明凭证未被服务端撤销；在目标电脑点击「在此设备启用」后才能确认账号可用。

旧版「本机内部备份」中的 `accounts.json` 是原始账号数组，使用设置页专门的「导入旧备份」入口；它不是本协议。主词库单独使用设置页的「导出主词库」和「导入主词库」迁移。
