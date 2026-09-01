# 对象与签名传输 API

OpenPool 只处理认证、放置和元数据；对象字节始终由客户端直接传给 R2、B2 或 S3-compatible
Provider。对象 API 接受管理员 session 或具备对应 scope、Bucket/path 限制的 API Key；所有响应使用
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
