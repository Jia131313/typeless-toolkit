# 备份与账号文件格式

## Typeless Toolkit Backup v1

工具集「导出备份」使用以下统一 JSON，将账号和主词库放在同一个文件中：

```json
{
  "format": "typeless-toolkit-backup",
  "version": 1,
  "exported_at": "2026-10-09T00:00:00.000Z",
  "account_bundle": {
    "format": "typeless-account-bundle",
    "version": 1,
    "exported_at": "2026-10-09T00:00:00.000Z",
    "source": "typeless-toolkit",
    "accounts": []
  },
  "dictionary": ["示例词条"]
}
```

`account_bundle` 使用下述 Account Bundle v1，`dictionary` 是主词库字符串数组。只导出词库时 `accounts` 为空，只导出账号时 `dictionary` 为空。导出部分账号仍携带整份所选主词库，不按账号筛选词条。文件不包含登录快照、设备配置、账号或词库的删除记录。

导入入口自动识别统一备份、Account Bundle v1 和旧 `accounts.json` 数组；统一备份中的账号与词库一起预览并增量合并，词条不区分大小写去重。旧账号文件不含词库，不会被当成完整备份。单独 CSV/TXT 词库沿用词库导入流程。

API：`GET /api/account-bundle/export?backup=1&include_accounts=1&include_dictionary=1`，重复的 `user_id` 参数选择账号；`include_accounts=0` 或 `include_dictionary=0` 排除对应内容。不设置 `backup=1` 时仍导出原 Account Bundle。`POST /api/account-bundle/preview` 和 `/import` 接受 `{ "content": "<JSON文本>" }`，结果同时包含 `dictionary_total`、`dictionary_added`。

## Typeless Account Bundle v1

这是现有账号交换协议，新的统一备份将它嵌入 `account_bundle`。工具集继续接受独立的 Account Bundle 文件，供兼容工具交换长期账号凭证；独立 Registrar 可沿用这个协议，不必携带主词库。

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

旧版「本机内部备份」中的 `accounts.json` 是原始账号数组，不是本协议；统一导入入口会自动识别它。独立词库仍可通过更多操作导入／导出。
