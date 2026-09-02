# Shard Migration API 与流式搬运器

Shard migration 用于完成 Storage Account drain。所有控制 API 只接受管理员 session，并返回
`Cache-Control: no-store`。对象内容不经过 Worker；架构边界见
[ADR 0003](../architecture/decisions/0003-client-mediated-shard-migration.md)。

## 启动与查询

源 shard 必须为 `ACTIVE`，其账号必须为 `DRAINING`；目标必须是同一 logical bucket 的 `STANDBY`
shard，账号仍为健康、可写、容量已知且具备完整对象能力。目标 shard/account 都必须在 10% soft
headroom 后容纳源 shard 当前用量。

`POST /api/v1/shard-migrations`：

```json
{
  "sourceShardId": "source-shard-id",
  "targetShardId": "target-shard-id",
  "expectedSourceUpdatedAt": "2026-09-01T10:00:00.000Z",
  "expectedTargetUpdatedAt": "2026-09-01T10:00:00.000Z"
}
```

成功返回 `202`。D1 在条件事务中把源设为 `MIGRATING`、目标设为 `ACTIVE` 并创建 `RUNNING`
migration；CAS timestamp 过期时返回 `409 SHARD_MIGRATION_CONFLICT`，不会留下半切换状态。

- `GET /api/v1/shard-migrations/:id`：读取单个 migration 与进度；
- `GET /api/v1/buckets/:bucketId/shard-migrations`：按新到旧列出该 bucket 最近 100 个 migration，供
  管理界面在刷新后恢复进度。

进度包含 `remainingReady`、`reserved`、`switched`、`completed`、`failed` 和 `blocking`。`blocking`
表示源仍有 `PENDING`、`DELETING` 等不能安全切换的对象；必须先让其完成或由既有维护流程收敛。

## 搬运 claim 与 complete

`POST /api/v1/shard-migrations/:id/transfers` 不接受请求体内容。无 body 和零字节 body stream 均有效，
但非空 body（即使声明 `Content-Length: 0`）或读取失败均拒绝。成功时返回一个短期任务：

```json
{
  "taskId": "task-id",
  "objectId": "object-id",
  "sizeBytes": 524288,
  "contentType": "application/octet-stream",
  "downloadUrl": "short-lived-signed-get",
  "uploadUrl": "short-lived-signed-put",
  "expiresAt": "2026-09-01T10:15:00.000Z",
  "leaseToken": "short-lived-task-secret"
}
```

搬运器完成直传后调用 `POST /api/v1/shard-migration-transfers/:taskId/complete`，请求体只包含
`{ "leaseToken": "..." }`。Worker 自行对目标 `HEAD` 并校验大小及可用 checksum；验证通过后才原子
切换 primary，再删除源对象并释放源 shard/account 计数。客户端不能提交 size、checksum 或 ETag。

租约过期可重新 claim。目标签名或传输失败会保留源 primary；primary 已切换但源删除失败时，原
complete 可重试，5 分钟 scheduled maintenance 也会扫描 `SWITCHED` 任务恢复源清理。Provider 删除
返回 not found 按幂等成功处理。

## 运行 Node 搬运器

Node 22+ CLI 只把下载流直接 pipe 到目标 `PUT`，设置契约中的精确 `Content-Length` 和
`Content-Type`，不会把整个对象读入内存。先从可信管理员会话取得完整 Cookie pair，并在当前 shell
隐藏输入；不要把 Cookie 放进命令参数、shell history、日志、聊天或仓库：

```bash
read -s OPENPOOL_SESSION_COOKIE
export OPENPOOL_SESSION_COOKIE
npm run migrate:shard -- \
  --base-url https://openpool.example.com \
  --migration-id migration-id
unset OPENPOOL_SESSION_COOKIE
```

输入格式必须仅为 `openpool_session=<token>`。远端 base URL 必须使用 HTTPS；HTTP 只允许
`localhost`/loopback 本地开发。CLI 只输出最终结果或不含敏感信息的错误状态，不输出 Cookie、
lease token 或签名 URL。CLI 退出不破坏源 primary；可在租约到期后重新运行同一 migration。

## 稳定错误

非法请求返回 `400 SHARD_MIGRATION_INVALID`；资源不存在返回对应 `*_NOT_FOUND`；状态/CAS/容量/
阻塞冲突返回 `409`；lease 过期返回 `410`；目标校验不匹配返回 `422`。Provider 和 vault 错误使用
稳定 `PROVIDER_*` / `CREDENTIAL_VAULT_UNAVAILABLE` code，响应不会包含 endpoint、Provider 正文、
credential、signed URL 或 lease token。
