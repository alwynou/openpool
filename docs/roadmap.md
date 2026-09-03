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
   上传失败／过期后的显式 retry、历史尝试清理与 Web 重试入口已实现，`0006` 和新版本已部署到
   staging，R2/B2 立即、过期和清理后重试均已通过 API/Provider 验收；证据见
   [上传重试验收](development/staging-upload-retry-acceptance.md)，设计见
   [ADR 0005](architecture/decisions/0005-upload-attempt-retries.md)；
5. Storage Account、验证失败配置/credential 纠错、容量、健康检查和简单 Placement（本地完成）；
6. Generic S3 与 B2（本地完成；真实 B2 smoke 已完成，Generic S3 仍待项目所有者提供隔离资源和凭证）；
7. API Key、文件管理 API、审计日志查询 API 与管理界面（本地及 staging 验收完成）；
8. Cloudflare 部署和升级说明（文档完成；独立 staging 账号目标、D1、Secret、迁移、deploy、Cron
   和浏览器 R2/B2 直传均已验收，production 尚未创建）。

这里的“本地完成”表示仓库中的 domain/application/adapter/contract、测试路径和操作文档已具备；
“staging 验收完成”覆盖当前隔离 Cloudflare staging、R2 与 B2，不代表 Generic S3 或 production。

核心 V1 控制面退出条件已经达到：本地 `npm run verify` 通过；本地流程、独立 staging 部署、
R2/B2 Provider、浏览器直传、API Key、审计和 Cron 均按[验收清单](development/v1-acceptance.md)取得证据。
完整的 V1 Provider 兼容性声明仍需 Generic S3 的 opt-in smoke。production、CI/CD token、受保护
备份位置和恢复演练也继续由项目所有者决定，不复用 staging 资源。

## Phase 2

- account drain 与 shard migration（本地实现完成：持久化任务、原子 cutover、双重容量预留、管理
  界面、流式 CLI 和 scheduled source cleanup；staging 0004 migration/deploy、R2 ↔ B2 小文件真实
  搬运及租约到期重试已验收，详见[升级验收记录](development/staging-upgrade-acceptance.md)，设计见
  [ADR 0003](architecture/decisions/0003-client-mediated-shard-migration.md)）；
- 业务写入与审计事件的事务 outbox/强一致 append（本地实现及 staging 升级验收完成）；
  已原子覆盖认证 session、API Key create/revoke、Storage Account、Logical Bucket、Storage Shard、
  Object 与 Shard Migration 的全部现有 mutation；staging `0005` migration/deploy、投递前后可见性、
  稳定 event id 与去重已验证。
- GitHub/static tier；
- replication 与校验修复；
- SDK、CLI 与有限 S3 compatibility gateway（对象及现有管理 API 的 TypeScript SDK 私有预览已本地
  实现，Web 控制台已复用；[通用对象 CLI](cli/objects.md) 已本地实现上传/下载/列表/详情/删除、上传
  状态、幂等完成与显式重试，API Key-only、不自动重试或覆盖；真实 R2/B2 小文件 CLI 流程已
  [验收](development/staging-cli-acceptance.md)，该轮旧 session/Cron/B2 收尾已闭环；后续
  [50 MB 文件验收](development/staging-cli-50mb-acceptance.md) 已覆盖实际传输中途取消、显式恢复及
  内存观察，并提供[可重复 smoke](development/cli-smoke.md)。更大文件、并发/压力、公开发布策略和
  gateway 仍待后续授权/决策/实现）；
- multi-user、quota 和细粒度 RBAC。

在 V1 真实使用证明需要之前，不引入复杂一致性哈希、自动分层、完整 S3 API 或计费系统。

## V1 明确限制

- Worker 每 5 分钟扫描超过签名 expiry 5 分钟 grace 的 direct-upload session。`0006` 支持显式替换
  PENDING object 的当前尝试，新 session/物理位置与旧尝试隔离，旧预留只释放一次；旧残留清理失败
  保持 EXPIRED、成功变 ABORTED。staging 已升级至 0006，支持显式重试。
  不支持覆盖 READY、删除后复用路径、版本历史浏览或 multipart 断点续传。
- 没有无人值守的自动 migration、自动 replication、自动修复或完整 S3 gateway；发布命令可串联
  迁移但仍需用户明确授权。对象内容始终由客户端通过短期签名 URL 直传/直取 Provider。
- V1 audit log 用于运维追踪。全部现有 business mutation 已使用同事务 outbox；没有对应业务写入的
  签名下载和 API Key 授权事件直接 append 到 outbox。outbox Cron 使用 lease、event id 幂等和退避。
