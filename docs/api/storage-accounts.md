# Storage Account API

Storage Account API 只接受管理员 session Cookie。所有响应包含 `requestId` 并设置
`Cache-Control: no-store`；credential 明文和加密信封都不会出现在响应中。

## 生命周期

```text
VERIFYING → ACTIVE → DRAINING → READ_ONLY → REMOVED
```

创建账号只保存加密 credential，并保持 `VERIFYING`。只有显式验证成功后才能进入 `ACTIVE`；后续
状态只能沿上图前进，不能恢复或跳级。并发修改使用条件更新，冲突返回
`409 STORAGE_ACCOUNT_CONFLICT`。进入 `REMOVED` 前必须没有非 `RETIRED` shard、未删除 object
location 或非零已用容量；仍有引用时返回 `409 STORAGE_ACCOUNT_HAS_REFERENCES`，避免对象或后台
清理任务失去 Provider 访问路径。

## 创建与查询

`POST /api/v1/storage-accounts` 创建账号并返回 `201`：

```json
{
  "name": "Primary R2",
  "provider": "r2",
  "providerConfig": {
    "accountId": "your-cloudflare-account-id",
    "validationBucket": "openpool-test",
    "jurisdiction": "eu",
    "addressingStyle": "path"
  },
  "credentials": {
    "accessKeyId": "write-only",
    "secretAccessKey": "write-only"
  },
  "priority": 100,
  "capacityBytes": 107374182400
}
```

R2 的 `jurisdiction` 可省略，或为 `eu`、`fedramp`；`region` 如显式提供只能是 `auto`。
`addressingStyle` 默认为 `path`。`validationBucket` 必须是该 credential 可执行 `HEAD Bucket` 的
既有物理 Bucket。

R2 的 S3 API 不提供账号容量用量查询，因此当前必须提供可信的 `capacityBytes`，验证时会把它标为
`CONFIGURED`。若既没有可观测容量也没有配置容量，账号不会激活。

Backblaze B2 使用 `provider: "b2"`，`providerConfig` 包含 `region`、`validationBucket` 和可选
`addressingStyle`。Generic S3 使用 `provider: "s3"`，配置包含 HTTPS `endpoint`、`region`、
`validationBucket` 和可选 `addressingStyle`。三者的 credential 请求均使用 `accessKeyId`、
`secretAccessKey` 和可选 `sessionToken`，并且只写不读。

`GET /api/v1/storage-accounts` 返回安全的账号列表，其中包含状态、健康、容量准确性和验证得到的
capabilities，但不包含 `credentials` 或 `credentialEnvelope`。

## 验证、健康与状态

- `POST /api/v1/storage-accounts/:id/verify`：解密一次 credential，签名并执行 `HEAD Bucket`，验证
  capability、健康和容量后激活账号。
- `POST /api/v1/storage-accounts/:id/health`：重新探测健康与容量，不改变生命周期。
- `PATCH /api/v1/storage-accounts/:id/status`：请求体为
  `{ "status": "DRAINING" | "READ_ONLY" | "REMOVED" }`。

Provider 错误会映射为稳定的 `PROVIDER_*` 错误码。错误消息不包含 endpoint、Bucket、响应正文、
credential 或签名 URL。真实 R2 验证需要项目所有者提供受限 credential；本地测试使用注入的 fake
transport，不会访问远端。
