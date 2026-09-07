# 对象与签名传输 API

OpenPool 只处理认证、放置和元数据；对象字节始终由客户端直接传给 `v0.1.0` 正式支持的 R2 或 B2
Provider。实验性的 Generic S3 adapter 不属于当前支持范围。对象 API 接受管理员 session 或具备对应
scope、Bucket/path 限制的 API Key；所有响应使用
`Cache-Control: no-store`。公开对象元数据不会暴露 Storage Account、shard、物理 Bucket、物理 key、
credential 或 credential envelope。API Key 的创建和权限规则见 [API Key API](api-keys.md)。

## 上传

`POST /api/v1/uploads`：

```json
{
  "bucketId": "logical-bucket-id",
  "logicalKey": "reports/2026.pdf",
  "sizeBytes": 123456,
  "contentType": "application/pdf"
}
```

用例只通过该 Logical Bucket 的唯一 `ACTIVE` shard 解析物理位置，检查账号健康、capability 和 90%
soft limit，然后生成 15 分钟的签名 `PUT`。D1 随后以单个原子操作创建 object、primary location、
upload session，并同时预留 Storage Account 与 shard 容量。若预留发生 namespace、状态或容量冲突，
签名 URL 不会返回给调用方。

成功返回 `201`，其中 `uploadUrl` 只在这次响应出现：

```json
{
  "data": {
    "objectId": "object-id",
    "uploadSessionId": "upload-session-id",
    "uploadUrl": "https://provider.example/...signed...",
    "expiresAt": "2026-09-01T00:15:00.000Z"
  },
  "requestId": "request-id"
}
```

客户端必须向 `uploadUrl` 直接执行 `PUT`，并发送与 reservation 一致的精确字节长度和
`Content-Type`；两者都包含在签名约束中。浏览器应直接用对应 `File`/`Blob` 作为 body，让 Fetch
自动设置受限的 `Content-Length`，不要尝试手工设置该 header。不得把对象正文发给 Worker。

上传结束后调用 `POST /api/v1/uploads/:objectId/complete`，请求体为
`{ "uploadSessionId": "..." }`。OpenPool 使用 Provider `HEAD` 验证实际大小并保存 ETag/checksum，
再原子地把 object 与 session 标为 `READY`/`COMPLETED`。重复 complete 返回同一完成状态；大小不符
返回 `422 OBJECT_SIZE_MISMATCH`。Worker 每 5 分钟运行一次 scheduled maintenance；超过签名有效期
再经过 5 分钟 grace 的 `PENDING` session 会原子标为 `EXPIRED` 并只释放一次预留容量，随后尝试删除
Provider 残留，成功后标为 `ABORTED`。Provider 删除失败时保留 `EXPIRED`，由下次 cron 重试。

### 失败／过期后重试（需要 0006 migration 与新 Worker）

`GET /api/v1/uploads/:objectId` 返回当前尝试摘要：

```json
{
  "data": {
    "objectId": "object-id",
    "uploadSessionId": "previous-session-id",
    "status": "ABORTED",
    "expiresAt": "2026-09-01T00:15:00.000Z"
  },
  "requestId": "request-id"
}
```

该查询也要求 `objects:upload` scope 和相应 Bucket/path 授权，不返回签名 URL 或物理位置。
若 PUT 成功但 complete 响应丢失，先重试原 complete；若需要重新发送文件，显式创建新尝试：

```json
{
  "bucketId": "logical-bucket-id",
  "logicalKey": "reports/2026.pdf",
  "sizeBytes": 123456,
  "contentType": "application/pdf",
  "retryUploadSessionId": "previous-session-id"
}
```

仍发送到 `POST /api/v1/uploads`，成功仍为 `201 CreateUploadResponse`。只允许 object 为 PENDING，
当前 session 为 PENDING/EXPIRED/ABORTED；新文件可有不同大小或 contentType，但 object ID、Bucket、
logical key 保持不变。新 session ID 和 physical key 独立；旧 session 不能完成新上传，旧清理不会
删除新位置。旧 signed PUT 原有效期加 grace 结束后才清理旧文件，即使新对象已经 READY/DELETED。

携带过时 session ID 返回 `409 OBJECT_CONFLICT`；READY/DELETING/DELETED 返回
`409 OBJECT_INVALID_STATE`。不带 retry ID 的同路径创建仍返回 `409 OBJECT_ALREADY_EXISTS`。
重试事务失败不释放旧预留、不改变旧会话、不追加成功审计；成功时旧预留只释放一次，新预留和
`OBJECT_UPLOAD_RETRIED` 审计同事务提交。并发相同 retry 请求仅一个成功，不能将其当作幂等创建；
若响应丢失，先查询当前状态再决定是否创建下一次尝试。此功能不允许覆盖已完成文件或复用 DELETED 路径。

## 查询、下载与删除

- `GET /api/v1/buckets/:bucketId/objects`：按 logical key 稳定排序；支持 `status`、`prefix`、
  `afterKey` 和 `limit`（1–1000）。
- `GET /api/v1/objects/:id`：读取逻辑对象元数据。
- `POST /api/v1/objects/:id/download`：仅为 `READY` 对象返回 15 分钟签名 `GET` URL。
- `DELETE /api/v1/objects/:id`：先持久化 `READY → DELETING`，再删除 Provider 对象，最后原子进入
  `DELETED` 并释放容量。

对象已有 `RESERVED` 或 `SWITCHED` shard migration task 时，删除返回 `409 OBJECT_CONFLICT`，避免
普通删除与 primary 切换/双重容量预留并发；migration 完成后可重试。先进入 `DELETING` 的对象不会
被 migration claim，而会显示在 migration 的 `blocking` 进度中直到删除收敛。

删除可安全重试：Provider 返回 404 表示目标状态已经达到；D1 只在第一次
`DELETING → DELETED` 时释放容量。签名 URL 不写入 D1、audit metadata 或日志。

## 稳定公开链接（需要 `0007` migration 与配套 Worker）

每个对象元数据响应额外返回以下字段：

```json
{
  "publicAccessMode": "INHERIT",
  "publicAccessExpiresAt": null,
  "publicUrl": "https://openpool.example/public/objects/object-id"
}
```

`publicUrl` 是当前 OpenPool origin 下的稳定地址，不包含 logical key、Provider、物理 Bucket 或签名。
它即使在对象当前私有时也会返回，便于管理员预先复制；是否允许访问在每次请求时重新判断。

管理员通过 `PATCH /api/v1/objects/:id/public-access` 设置单文件策略：

```json
{
  "mode": "PUBLIC",
  "expiresAt": "2026-09-08T00:00:00.000Z",
  "expectedUpdatedAt": "2026-09-07T12:00:00.000Z"
}
```

- `INHERIT` 跟随 Logical Bucket 的默认设置；
- `PUBLIC` 显式公开，可把 `expiresAt` 设为未来的 canonical UTC 时间，或用 `null` 表示不过期；
- `PRIVATE` 显式私有，即使 Bucket 已公开也不允许匿名读取。

只有 `READY` 对象可更新，`expiresAt` 仅能与 `PUBLIC` 同时使用。`expectedUpdatedAt` 执行乐观并发
控制，过时值返回 `409 OBJECT_CONFLICT`。该接口只接受管理员 session；API Key 即使拥有对象读写
scope 也返回 `403 FORBIDDEN`。

匿名客户端请求 `GET /public/objects/:id`。若策略允许，Worker 根据当前 primary location 生成最长
60 秒的 Provider signed GET，并返回空 body 的 `302`；浏览器随后直接从 R2/B2 读取字节。响应包含
`Cache-Control: no-store`、`Referrer-Policy: no-referrer` 与 `X-Content-Type-Options: nosniff`。
不存在、非 READY、私有或已过期对象统一返回空 body `404`，避免泄漏对象是否存在；query string
同样被拒绝。Provider 限流可返回 `429`，临时 Provider/vault 故障返回 `503`。

关闭公开访问会立即阻止新的重定向，但已经签发的 Provider URL 最多在其剩余 60 秒内继续有效。
公开读取不写 audit outbox，避免匿名流量造成 D1 写放大；策略变更仍与对应审计事件同事务提交。
Bucket 公开不提供匿名列表。设计依据见
[ADR 0006](../architecture/decisions/0006-stable-public-object-links.md)。
