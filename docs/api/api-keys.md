# API Key API

API Key 是给对象 API 使用的 Bearer 凭证。管理 API 只接受管理员的
`openpool_session` HttpOnly Cookie；原始 token 只在创建成功的响应中出现一次。D1 只保存
`key_prefix` 和带 `API_KEY_PEPPER` 的 HMAC-SHA256 hash，不能从列表或日志恢复 token。
所有响应包含 `requestId` 并设置 `Cache-Control: no-store`。

## 创建、列出与撤销

`POST /api/v1/api-keys` 请求体：

```json
{
  "name": "backup client",
  "scopes": ["objects:list", "objects:read"],
  "logicalBucketId": "bucket-id",
  "pathPrefix": "reports/",
  "expiresAt": "2026-12-31T00:00:00.000Z"
}
```

- `name` 会去除首尾空白，不能为空且最多 128 个字符；
- `scopes` 至少一个，且只能来自 `objects:list`、`objects:read`、`objects:upload`、
  `objects:delete`，不能重复；
- `logicalBucketId` 可省略或为 `null`（不限定 Bucket）；填写时必须是已存在的逻辑 Bucket；
- `pathPrefix` 可省略或为 `null`，是对 logical key 的字面 `startsWith` 限制，最多 1,024 个字符；
  需要目录语义时建议包含结尾 `/`；
- `expiresAt` 可省略或为 `null`（不过期），否则必须是未来的 canonical ISO-8601 UTC 时间。

成功返回 `201`，响应的 `data.token` 形如 `opk_...`，是 32 字节随机值；请立即安全保存，之后
无法再次查看：

```json
{
  "data": {
    "apiKey": {
      "id": "api-key-id",
      "name": "backup client",
      "keyPrefix": "opk_A1b2C3d4",
      "scopes": ["objects:list", "objects:read"],
      "logicalBucketId": "bucket-id",
      "pathPrefix": "reports/",
      "expiresAt": "2026-12-31T00:00:00.000Z",
      "revokedAt": null,
      "createdAt": "2026-09-01T00:00:00.000Z"
    },
    "token": "opk_<shown-once>"
  },
  "requestId": "request-id"
}
```

`GET /api/v1/api-keys` 返回按 `createdAt, id` 稳定排序的安全 metadata 数组，不返回 token 或
hash。`DELETE /api/v1/api-keys/:id` 撤销 key 并返回 metadata；重复撤销是幂等的，返回同一已撤销
状态。无效输入返回 `400 API_KEY_INVALID`，不存在的 Bucket/key 分别返回
`404 API_KEY_BUCKET_NOT_FOUND`/`API_KEY_NOT_FOUND`，并发冲突返回 `409 API_KEY_CONFLICT`。

## 使用对象 API

在对象 API 请求上发送：

```http
Authorization: Bearer opk_<token>
```

API Key 可调用的路径和 scope 如下：

| Scope | 路径 |
| --- | --- |
| `objects:list` | `GET /api/v1/buckets/:bucketId/objects` |
| `objects:read` | `GET /api/v1/objects/:id`、`POST /api/v1/objects/:id/download` |
| `objects:upload` | `POST /api/v1/uploads`、`GET /api/v1/uploads/:objectId`、`POST /api/v1/uploads/:objectId/complete` |
| `objects:delete` | `DELETE /api/v1/objects/:id` |

Key 必须未撤销且未过期，同时满足 Bucket 限制和 path prefix 限制。管理员 session 仍可访问这些
对象路径；API Key 不能用于管理员初始化、登录、Storage Account、Bucket/Shard 管理、API Key
管理或 audit-log 查询。对象 API 依然只返回逻辑 metadata 和短期 signed URL；对象正文必须由
客户端直传/直取 Provider。

带 `pathPrefix` 的 key 列表请求若未提供 `prefix`，服务会自动使用该限制；若显式提供 `prefix`，
它也必须落在限制内。`GET` 列表默认按 logical key 稳定排序，其他对象请求的完整参数和状态见
[对象 API](objects.md)。未认证返回 `401 UNAUTHORIZED`，认证成功但 scope、Bucket 或 key 不符
返回 `403 FORBIDDEN`。
管理员专用接口不接受 Bearer Key 作为 session，因此只提供 API Key 时返回 `401 UNAUTHORIZED`。

## 安全操作

token 是不可恢复的 bearer secret：不要写入 git、浏览器 local storage、日志、audit metadata 或
聊天记录。泄露时立即调用撤销接口并重新创建最小 scope、最小 Bucket/path 范围和有限期限的 key。
V1 没有 key rotation endpoint；轮换应采用“创建新 key → 更新客户端 → 撤销旧 key”。

Web 创建表单不自动重试或缓存 raw token；列表刷新失败不丢弃已经返回的 token，关闭展示弹窗
或离开页面后不能再次查看。复制失败时可在弹窗中手动复制。如果创建请求结果不确定，先刷新列表，
撤销拿不到 token 的多余 Key，再决定是否重新创建。交互回归见[Web API Key 创建](../development/web-api-key-creation.md)。
