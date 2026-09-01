# 审计日志 API

`GET /api/v1/audit-logs` 是管理员 session-only 的只读查询接口。响应包含 `requestId` 并设置
`Cache-Control: no-store`；日志 metadata 只允许 string 值，不包含 credential、authorization
header 或完整 signed URL。

## 查询

```http
GET /api/v1/audit-logs?limit=50&actorType=API_KEY&resourceType=OBJECT
Cookie: openpool_session=...
```

支持的 query 参数：

- `limit`：1–200，默认 50；
- `actorType`：`ADMIN`、`API_KEY` 或 `SYSTEM`；
- `action`、`resourceType`、`resourceId`：精确匹配，非空、最多 256 个字符，不得包含控制字符，
  也不得带首尾空白；
- `afterCreatedAt` 与 `afterId`：必须成对出现。它们来自上一页 `nextCursor`，时间必须是
  canonical ISO-8601 UTC 字符串。

结果按 `createdAt DESC, id DESC` 排序，响应 envelope 的 `data` 为：

```json
{
  "items": [
    {
      "id": "audit-id",
      "actorType": "API_KEY",
      "actorId": "api-key-id",
      "action": "OBJECT_UPLOAD_COMPLETED",
      "resourceType": "OBJECT",
      "resourceId": "object-id",
      "requestId": "request-id",
      "metadata": {"sizeBytes": "1234"},
      "createdAt": "2026-09-01T00:00:00.000Z"
    }
  ],
  "nextCursor": {
    "afterCreatedAt": "2026-09-01T00:00:00.000Z",
    "afterId": "audit-id"
  }
}
```

没有下一页时 `nextCursor` 为 `null`。下一页应 URL-encode cursor 值并原样传回；不要自行按时间
推算游标。

## 当前记录的事件

事件的 `actorType` 为 `ADMIN`、`API_KEY` 或 `SYSTEM`。当前用例会记录：

- 认证：`ADMINISTRATOR_INITIALIZED`、`LOGIN`、`LOGOUT`；
- API Key：`API_KEY_CREATED`、`API_KEY_REVOKED`、`API_KEY_AUTHORIZED`；
- Storage Account：`STORAGE_ACCOUNT_CREATED`、`STORAGE_ACCOUNT_CONFIGURATION_UPDATED`、
  `STORAGE_ACCOUNT_VERIFIED`、`STORAGE_ACCOUNT_HEALTH_REFRESHED`、
  `STORAGE_ACCOUNT_STATUS_CHANGED`；配置更新 metadata 只记录配置/credential 是否发生替换，不记录值；
- Logical Bucket/Shard：`LOGICAL_BUCKET_CREATED`、`STORAGE_SHARD_CREATED`、
  `STORAGE_SHARD_STATUS_CHANGED`；
- Object：`OBJECT_UPLOAD_RESERVED`、`OBJECT_UPLOAD_COMPLETED`、`OBJECT_UPLOAD_EXPIRED`、
  `OBJECT_UPLOAD_ABORTED`、`OBJECT_DOWNLOAD_SIGNED`、`OBJECT_DELETE_STARTED`、`OBJECT_DELETED`。

事件集合会随用例扩展；消费者应把未知 action 当作可显示的字符串，而不要硬编码为封闭枚举。
容量预留、过期释放和删除释放只在其对应的状态转换成功时写入事件，重复请求不会重复扣减容量。
V1 的业务写入与 audit insert 不是同一个 D1 事务；如果后者失败，请求会返回 500，但前者可能已经
成功。该接口因此用于运维追踪而不是防篡改合规账本，调用方重试前应先读取资源当前状态。

## 错误与边界

没有或无效的管理员 session 返回 `401 UNAUTHORIZED`。非法参数（包括未知 query key、重复参数、
不成对 cursor、非法 limit 或过滤字符）返回 `400 AUDIT_QUERY_INVALID`。审计查询不会对 API Key
开放；API Key 的授权动作本身会作为 `API_KEY_AUTHORIZED` 记录。
