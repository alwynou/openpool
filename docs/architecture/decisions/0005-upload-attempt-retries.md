# ADR 0005：显式上传尝试重试

- 状态：Accepted（本地实现；staging 尚未升级）
- 日期：2026-09-02

## 决策

不改变 ADR 0001 的直传数据面，也不引入对象版本或覆盖 READY 对象。一个 logical bucket/key
仍只有一个 object；重试保留 object ID、路径和 createdAt，更新本次预留的 size/contentType。

`POST /uploads` 只有携带 `retryUploadSessionId` 才能替换已有 `PENDING` object 的当前尝试。
该 ID 必须等于当前 session，状态可为 `PENDING`、`EXPIRED` 或 `ABORTED`；普通创建仍冲突，
`READY`/`DELETING`/`DELETED` 不可重试。`GET /uploads/:objectId` 返回当前 session 摘要，使用
同一 `objects:upload` Bucket/path 授权。客户端不自动替换并发产生的新 session。

每次重试生成全新 session、location 和 physical key。`upload_sessions.is_current` 的部分唯一索引
保证每个 object 只有一个当前 session；`location_id` 绑定该尝试原始的物理位置。历史 session 和
location 保留，不将旧 session 改回 PENDING，也不复用旧签名 URL。

## 事务与清理

单个 D1 batch 条件检查 expected session/object 后，按顺序执行：

1. 若旧 session 仍 PENDING，先转 EXPIRED，使用**旧 size 和旧 primary**释放一次预留；
2. 旧 session/location 不再是 current/primary；
3. 更新 object 的本次 size/contentType，创建新 primary location 并由现有触发器预留新容量；
4. 创建新 current session，append `OBJECT_UPLOAD_RETRIED` outbox 事件（包含前后 session ID）。

所有条件写入均有事务断言；容量、账号状态、并发或 outbox 失败使整个 batch 回滚，旧尝试保持原状，
新签名 URL 不返回。跨 shard 重试只选择 Bucket 当前的 ACTIVE shard；不能凭旧会话写入 draining
账号。旧预留释放和新预留创建必须保持上述顺序，不可基于已经更新的 object size 释放旧容量。

旧 PUT URL 不能撤销，因此清理必须等该 session 原签名到期再加 5 分钟 grace；早于到期的显式重试
也不例外。Cron 按 session 的 `location_id` 删除旧位置，而非查询 object 当前 primary。新对象即使
已经 READY 或 DELETED，旧 EXPIRED session 的清理仍继续，失败保持 EXPIRED，成功转 ABORTED，
不再释放容量。历史清理尚未完成会阻止对应账号移除和 shard migration 退役；ABORTED 历史不阻塞。

## 后果与边界

- 同一 expected session 的并发重试只有一个成功；请求响应丢失时先查询当前 session/对象，不能盲目
  重放创建。PUT 已成功但 complete 响应丢失时，先幂等重试 complete，避免无谓重传。
- `0006_upload_retries.sql` 保留历史数据、回填 location 绑定，仅改变当前 session 唯一约束；不修改
  已发布的 0001–0005。应用 0006 后再部署新 Worker/Web，再启用重试。产生多会话后不能直接回滚到
  假定每对象只有一个 session 的旧 Worker，应前滚修复。
- 不实现删除后同名重新创建、版本浏览、multipart 断点续传或无人值守自动重传。
- 预留容量是控制面的逻辑计数；旧 signed PUT 在有效期内仍可能产生物理字节，5 分钟 grace 也不是
  Provider 对超长在途请求的取消保证。B2 等版本化 Bucket 的历史版本仍需其生命周期策略管理。
