# Deferred 外部步骤

本文记录本地开发无法独立完成、必须由项目所有者提供账号权限、真实凭证或远端操作授权的步骤。
这些步骤不阻塞对应功能的本地实现、Fake 测试和离线集成测试。

## Cloudflare 平台

- [x] 使用 `wrangler login` 完成交互式 Cloudflare 登录，并通过 `wrangler whoami --json` 确认唯一
  可见的 Cloudflare account（2026-09-01；账号 ID 与登录邮箱不写入仓库）。
- [x] staging 使用当前 Cloudflare account 的独立 Worker、D1、Secrets 和 Provider 资源；production
  暂不创建，正式上线前再决定是否使用独立 account（2026-09-01）。
- [x] 在 APAC 创建独立的 `openpool-staging` D1，并绑定到 `env.staging`（2026-09-01；database ID
  只保存在 Wrangler 配置所需位置）。
- [x] 已为 staging 安全生成并配置独立的 `CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER` 和管理员
  bootstrap secret，并备份到 macOS 登录钥匙串；`CREDENTIAL_MASTER_KEY_ID` 固定为 `primary-v1`
  （2026-09-01）。`admin` 初始化后已从 Worker 删除一次性 bootstrap secret，远端只保留 master
  key 和 pepper；不要在 V1 期间更换已有 vault key。
- [x] 已获授权并执行 V1 `npm run db:migrate:staging`；0001→0003 均已应用（2026-09-01）。仓库目前
  没有 production migration 命令。
- [ ] Phase 2 的 `0004_shard_migrations.sql` 尚未应用到 staging，相关 Worker/Web 也尚未部署。执行前
  需项目所有者指定受限 D1 export 保存位置，并分别明确授权 remote migration 与 staging deploy；
  不得用当前对话中的开发授权推定远端变更授权。
- [x] 已获授权并运行 `npm run deploy:staging`，独立 Worker 已发布到 staging `workers.dev`，健康
  接口、静态控制台、`admin` 初始化、登录/session/audit/logout 及 bootstrap 删除后的再次登录均
  验证通过（2026-09-01）。管理员密码只保存在 macOS 登录钥匙串。只有同时授权 staging migration
  和部署时才使用 `npm run deploy:staging:with-migrations`。
- [x] `*/5 * * * *` Cron Trigger 已随 staging Worker 创建，并通过 Wrangler live tail 捕获到至少
  一次 outcome `ok` 的 scheduled maintenance；该次无 exception、无应用日志，CPU 1 ms
  （2026-09-01）。
- [x] staging live tail 抽样中的 session Cookie 和路径标识被 Cloudflare 标为 `REDACTED`，Worker
  没有输出 credential、token、signed URL、异常或响应正文；tail 仍包含标准客户端网络/地理 metadata，
  其访问权限和保留策略必须继续受限（2026-09-01）。
- [ ] 在下一次包含已有数据的远端 schema 升级前，项目所有者指定仓库外、受限且持久的 D1 export
  保存位置，并确认 Time Travel/恢复负责人；恢复演练会改写数据，必须另行授权。
- [ ] 正式上线前决定 production 使用当前还是独立 Cloudflare account，创建独立 D1、Secrets 和
  Provider 资源，并决定是否绑定自定义域名；不得复用 staging database、credential 或 bucket。
- [ ] 如启用 CI/CD，创建最小权限 Cloudflare API token 并通过 CI secret 注入。

## Provider 真实联调

- [x] 已在当前 staging Cloudflare account 创建 APAC 的独立空 bucket `openpool-staging-smoke`，并配置
  只允许 staging `workers.dev` origin 的 `PUT`/`GET`/`HEAD`/`DELETE`、`Content-Type` 和 `ETag`
  CORS policy（2026-09-01）。
- [x] 已为 `openpool-staging-smoke` 创建只授权该 bucket 的 Object Read & Write S3 API credentials，
  并通过 OpenPool 完成账号验证、逻辑 Bucket/ACTIVE shard、签名 PUT、complete/HEAD、签名 GET 字节
  比对及 DELETE smoke；删除后账号与 shard 用量均回到 0，R2 bucket 为空，审计事件完整
  （2026-09-01）。credential 未经过仓库或聊天。
- [x] 已创建私有 B2 隔离 bucket `openpool-b2-staging-5dfebd7d02` 和 bucket-scoped Read & Write
  application key；使用 `us-east-005` 完成账号验证、逻辑 Bucket/ACTIVE shard、浏览器签名 PUT、
  complete、签名 GET 字节比对和 DELETE smoke，OpenPool 容量回到 0（2026-09-01）。B2 的
  `Keep all versions` 会在 S3 DELETE 后保留历史版本，后续是否永久清除由 bucket lifecycle 决定。
- [ ] 为 Generic S3 提供测试 endpoint、region、bucket、访问凭证和 path-style/TLS 等兼容性要求。
- [x] 已从 staging 控制台浏览器实际完成 R2 文件上传、下载和删除，确认 signed PUT/GET 与最小化
  CORS policy 生效（2026-09-01）。
- [x] B2 已写入只允许 staging `workers.dev` origin 的自定义 S3 CORS，覆盖 `PUT`/`GET`/`HEAD` 和
  `Content-Type`/`Authorization`/`Range`；真实 `OPTIONS` 预检、浏览器上传和下载通过。用于写 CORS
  的临时全账户 application key 已立即撤销（2026-09-01）。
- [ ] Generic S3 bucket 仍需配置并实测最小化 CORS：仅允许管理后台实际 origin 和直传/直取所需
  method/header，不开放不必要权限。否则 signed URL 会被浏览器拦截。
- [ ] 在 staging 0004/deploy 完成后，用独立 R2/B2 测试 shard 执行一次真实 drain → migration：确认
  CLI 流式传输、目标 HEAD、primary 切换、源删除、容量计数、scheduled cleanup 和源 shard retirement。
  该验收会改变远端 D1 与 Provider 对象，必须单独授权。
- [ ] B2 smoke 的 S3 DELETE 已留下一个 52 B 对象的历史 upload version 与 hide marker；用户已确认
  永久删除，但 Backblaze 浏览器会话在操作前过期。需重新登录 Backblaze 后删除全部两个版本，或为
  测试 bucket 配置合适的 lifecycle；这不影响 OpenPool 中已完成的逻辑删除。

所有 secret 都只能通过本地忽略文件、交互式命令、Cloudflare Secret 或外部 secret manager 注入，不能写入
仓库、测试快照、日志或聊天记录。
