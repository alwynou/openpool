# 路线图

## Phase 0：Foundation（完成）

- workspace、严格 TypeScript、Oxlint、test/build；
- Worker + Static Assets + D1；
- domain/application/adapters 分层；
- 初始 schema、Placement 规则与文档。

## Phase 1：V1（核心控制面与 staging R2/B2 验收完成）

1. 单管理员初始化、登录与 session（本地完成）；
2. AES-GCM credential vault（本地完成）；
3. R2 Provider 验证与签名上传/下载（本地及真实 staging R2 smoke 完成）；
4. logical bucket、对象 reserve/complete/delete（本地完成；对象字节直传 Provider）；
5. Storage Account、验证失败配置/credential 纠错、容量、健康检查和简单 Placement（本地完成）；
6. Generic S3 与 B2（本地完成；真实 B2 smoke 已完成，Generic S3 仍待项目所有者提供隔离资源和凭证）；
7. API Key、文件管理 API、审计日志查询 API 与管理界面（本地及 staging 验收完成）；
8. Cloudflare 部署和升级说明（文档完成；独立 staging 账号目标、D1、Secret、迁移、deploy、Cron
   和浏览器 R2/B2 直传均已验收，production 尚未创建）。

这里的“本地完成”表示仓库中的 domain/application/adapter/contract、测试路径和操作文档已具备；
“staging 验收完成”覆盖当前隔离 Cloudflare staging、R2 与 B2，不代表 Generic S3 或 production。

核心 V1 控制面退出条件已经达到：本地 `npm run verify` 通过；本地流程、独立 staging 部署、R2
R2/B2 Provider、浏览器直传、API Key、审计和 Cron 均按[验收清单](development/v1-acceptance.md)取得证据。
完整的 V1 Provider 兼容性声明仍需 Generic S3 的 opt-in smoke。production、CI/CD token、受保护
备份位置和恢复演练也继续由项目所有者决定，不复用 staging 资源。

## Phase 2

- account drain 与 shard migration（按
  [ADR 0003](architecture/decisions/0003-client-mediated-shard-migration.md)使用持久化任务和客户端直传）；
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
