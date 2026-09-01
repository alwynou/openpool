# Logical Bucket 与 Storage Shard API

Logical Bucket 是稳定的用户命名空间，不等同于任何 Provider 的物理 Bucket。Storage Shard 把一个
Logical Bucket 映射到已验证 Storage Account 上的物理 Bucket。管理 API 只接受管理员 session，
响应包含 `requestId` 并设置 `Cache-Control: no-store`。

## Logical Bucket

- `POST /api/v1/buckets`：创建逻辑 Bucket，请求体为
  `{ "name": "documents", "description": "optional" }`。
- `GET /api/v1/buckets`：按创建时间和 ID 稳定排序返回列表。
- `GET /api/v1/buckets/:id`：读取单个逻辑 Bucket。

同名 Bucket 的并发创建只允许一个成功；重复返回 `409 LOGICAL_BUCKET_ALREADY_EXISTS`。

## Storage Shard

新 shard 只能以 `STANDBY` 或 `ACTIVE` 创建：

```json
{
  "storageAccountId": "storage-account-id",
  "physicalBucket": "provider-bucket-name",
  "status": "ACTIVE",
  "capacityBytes": 107374182400,
  "usedBytes": 0
}
```

- `POST /api/v1/buckets/:id/shards`：创建物理映射。
- `GET /api/v1/buckets/:id/shards`：列出该 Bucket 的 shard。
- `PATCH /api/v1/shards/:id/status`：显式推进 shard 状态。

```text
STANDBY → ACTIVE → READ_ONLY → RETIRED
    │         └→ MIGRATING → ACTIVE | READ_ONLY | RETIRED
    └──────────────────────────────────────────→ RETIRED
```

一个 Logical Bucket 同时最多一个 `ACTIVE` shard；应用层先检查，D1 partial unique index 负责并发
最终约束。激活 shard 时 Storage Account 必须仍为 `ACTIVE`、允许写入、健康、容量已知，并具备 V1
所需对象能力。冲突或并发条件写失败返回稳定的 `STORAGE_SHARD_*` 错误。

`physicalBucket` 必须已存在，并由该 Storage Account 的受限 credential 授权。真实 Bucket 可访问性
验收需要项目所有者提供 Provider 测试资源，记录在
[Deferred 外部步骤](../development/deferred-external-steps.md)；本地测试不会访问远端。
