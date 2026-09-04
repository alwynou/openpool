# ADR 0004：事务审计 Outbox

- 状态：Accepted（Phase 2，本地实现完成）
- 日期：2026-09-01

## 决策

业务 D1 写入与对应 `audit_outbox` append 必须在同一 D1 batch/事务中提交。事件使用稳定唯一
event id（存储为 outbox `id`）；Cron 以短 lease claim pending/processing 事件，按 event id 幂等写入 `audit_logs`，成功
标记 delivered，失败按指数退避重试。审计查询统一合并未 delivered 的 pending/processing outbox 与
delivered logs，按统一游标排序；投递前后沿用同一公开 `id`，避免可见性回归或重复。

当前实现原子覆盖认证 session、API Key create/revoke、Storage Account、Logical Bucket、Storage Shard、
Object 与 Shard Migration 的全部现有 business mutation。没有对应业务写入的审计事件（例如签名下载
和 API Key 授权）直接 append 到 outbox，不伪造事务边界。
`0005` migration 与 Worker 已于 2026-09-02 经项目所有者授权应用和部署到 staging；本地持久化 D1
未在此次操作中迁移。未来 migration 与部署仍需分别取得授权。

## 后果

读模型暂时是两个表的 union，需处理 lease 过期、重试退避和幂等冲突；outbox 是运维追踪机制，不是
防篡改合规账本。
