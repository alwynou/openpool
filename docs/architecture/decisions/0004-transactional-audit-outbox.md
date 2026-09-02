# ADR 0004：事务审计 Outbox

- 状态：Accepted（Phase 2，聚合迁移进行中）
- 日期：2026-09-01

## 决策

业务 D1 写入与对应 `audit_outbox` append 必须在同一 D1 batch/事务中提交。事件使用稳定唯一
event id（存储为 outbox `id`）；Cron 以短 lease claim pending/processing 事件，按 event id 幂等写入 `audit_logs`，成功
标记 delivered，失败按指数退避重试。审计查询统一合并未 delivered 的 pending/processing outbox 与
delivered logs，按统一游标排序；投递前后沿用同一公开 `id`，避免可见性回归或重复。

当前实现原子覆盖认证 session、API Key create/revoke、Storage Account、Logical Bucket 与 Storage Shard
mutation；Object 和 Shard Migration mutation 仍待迁移，不能声称全站已完成。
`0005` migration 不在本地或远端执行；staging 迁移与部署必须分别取得授权。

## 后果

读模型暂时是两个表的 union，需处理 lease 过期、重试退避和幂等冲突；outbox 是运维追踪机制，不是
防篡改合规账本。
