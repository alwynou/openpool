# 路线图

## Phase 0：Foundation（完成）

- workspace、严格 TypeScript、Oxlint、test/build；
- Worker + Static Assets + D1；
- domain/application/adapters 分层；
- 初始 schema、Placement 规则与文档。

## Phase 1：V1（本地代码与契约已覆盖；远端验收待项目所有者执行）

1. 单管理员初始化、登录与 session（本地完成）；
2. AES-GCM credential vault（本地完成）；
3. R2 Provider 验证与签名上传/下载（本地完成，真实 R2 smoke 待执行）；
4. logical bucket、对象 reserve/complete/delete（本地完成；对象字节直传 Provider）；
5. Storage Account、容量、健康检查和简单 Placement（本地完成）；
6. Generic S3 与 B2（本地完成，真实 Provider smoke 待执行）；
7. API Key、文件管理 API、审计日志查询 API与管理界面（本地完成；真实环境验收待执行）；
8. Cloudflare 部署和升级说明（文档完成；远端账号、D1、Secret、迁移和 deploy 未执行）。

这里的“完成”只表示仓库中的 domain/application/adapter/contract、测试路径或操作文档已具备，
不表示已登录 Cloudflare、已执行远端 D1 migration/deploy，或已用真实 R2/B2/Generic S3 凭证验证。

V1 退出条件：本地 `npm run verify` 通过；按[验收清单](development/v1-acceptance.md)完成本地流程；
项目所有者提供真实 Provider 资源并完成 opt-in smoke；确认目标 Cloudflare account、D1 ID、Secrets
和备份后，才可由所有者授权远端迁移与部署。

## Phase 2

- account drain 与 shard migration；
- 业务写入与审计事件的事务 outbox/强一致 append；
- GitHub/static tier；
- replication 与校验修复；
- SDK、CLI 与有限 S3 compatibility gateway；
- multi-user、quota 和细粒度 RBAC。

在 V1 真实使用证明需要之前，不引入复杂一致性哈希、自动分层、完整 S3 API 或计费系统。

## V1 明确限制

- Worker 每 5 分钟扫描超过签名 expiry 5 分钟 grace 的 direct-upload session：保留 `PENDING` object
  tombstone 和审计记录，释放一次预留容量，并重试 Provider 残留清理；成功后 session 为 `ABORTED`，
  Provider 失败时保留 `EXPIRED` 等下一轮。因此同一 `(logical bucket, logical key)` 不能靠重试立即
  复用，未来需要 retry/version namespace design。
- 没有无人值守的自动 migration、自动 replication、自动修复或完整 S3 gateway；发布命令可串联
  迁移但仍需用户明确授权。对象内容始终由客户端通过短期签名 URL 直传/直取 Provider。
- V1 audit log 用于运维追踪；业务变更与 audit insert 是连续但非事务性的 D1 操作。audit 写入失败
  会返回 500，已成功的业务变更不会自动回滚；需要强审计完整性时使用 Phase 2 的事务 outbox。
