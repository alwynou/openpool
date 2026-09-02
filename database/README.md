# D1 migrations

迁移按四位递增编号保存。当前 V1 的升级顺序不可跳过：

1. `0001_initial.sql`：基础表，以及 API key/audit log 表；
2. `0002_storage_account_metadata.sql`：Storage Account capabilities、容量准确性；
3. `0003_object_capacity_reservations.sql`：upload session 唯一约束、D1 断言和容量预留/释放触发器；
4. `0004_shard_migrations.sql`：durable shard migration、对象任务、租约、目标双重容量预留与条件断言。
5. `0005_transactional_audit_outbox.sql`：事务审计 outbox、lease/退避与 event-id 幂等投递。

2026-09-02 已经项目所有者授权，将 staging 从 0003 升至 0005；本地持久化 D1 未在本次操作中迁移。
`0004`、`0005` 现已发布，后续修复必须新增迁移，不得再编辑原文件。

```bash
npm run db:migrate:local
npm run db:migrate:staging
```

`db:migrate:local` 只操作 Wrangler 本地持久化 D1；`db:migrate:staging` 显式改变 staging D1，必须
由用户明确授权。仓库目前不提供 production migration 命令。执行前确认
`apps/worker/wrangler.jsonc` 的 database ID、当前 Cloudflare account、目标环境，并在仓库外安全
位置导出备份：

```bash
npx wrangler d1 migrations list DB --remote --env staging --config apps/worker/wrangler.jsonc
npx wrangler d1 export DB --remote --env staging --output <secure-path>/openpool-staging-before-migration.sql --config apps/worker/wrangler.jsonc
```

Wrangler 按 migration history 依次应用尚未执行的文件；单个 migration 失败时该次迁移保持回滚，
之前成功的 migration 不变。只追加新迁移，不修改已在共享或远端环境执行过的 SQL；schema 修复必须
通过新的补偿迁移前滚。不要用回滚 SQL 或手工删除 migration history 降级。数据恢复需所有者批准，
并使用受保护的 export 或 D1 Time Travel；这可能丢失恢复点之后的数据，完整 runbook 见
[Cloudflare 部署](../docs/operations/cloudflare.md)和[V1 验收清单](../docs/development/v1-acceptance.md)。

Migration SQL 由 `.gitattributes` 强制为 LF。包含 trigger 的 migration 不要在 trigger body 内使用
以 `END;` 结尾的 `CASE` 表达式；当前 D1 remote migration splitter 可能把它误判为 trigger 结束。
优先使用等价的 `SELECT RAISE(...) WHERE ...` 形式，并同时通过本地 runtime 测试和 staging remote
migration 验证。
