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
- [x] 已获授权并执行 `npm run db:migrate:staging`；0001→0003 均已应用，migration history 无待办
  （2026-09-01）。仓库目前没有 production migration 命令。
- [x] 已获授权并运行 `npm run deploy:staging`，独立 Worker 已发布到 staging `workers.dev`，健康
  接口、静态控制台、`admin` 初始化、登录/session/audit/logout 及 bootstrap 删除后的再次登录均
  验证通过（2026-09-01）。管理员密码只保存在 macOS 登录钥匙串。只有同时授权 staging migration
  和部署时才使用 `npm run deploy:staging:with-migrations`。
- [ ] `*/5 * * * *` Cron Trigger 已随 staging Worker 创建；仍需在 Cloudflare 日志/metrics 看到
  至少一次 scheduled maintenance 运行记录。
- [ ] 如启用 CI/CD，创建最小权限 Cloudflare API token 并通过 CI secret 注入。

## Provider 真实联调

- [x] 已在当前 staging Cloudflare account 创建 APAC 的独立空 bucket `openpool-staging-smoke`，并配置
  只允许 staging `workers.dev` origin 的 `PUT`/`GET`/`HEAD`/`DELETE`、`Content-Type` 和 `ETag`
  CORS policy（2026-09-01）。
- [x] 已为 `openpool-staging-smoke` 创建只授权该 bucket 的 Object Read & Write S3 API credentials，
  并通过 OpenPool 完成账号验证、逻辑 Bucket/ACTIVE shard、签名 PUT、complete/HEAD、签名 GET 字节
  比对及 DELETE smoke；删除后账号与 shard 用量均回到 0，R2 bucket 为空，审计事件完整
  （2026-09-01）。credential 未经过仓库或聊天。
- [ ] 为 Backblaze B2 创建独立测试 bucket 和受限 application key，执行 S3-compatible smoke test。
- [ ] 为 Generic S3 提供测试 endpoint、region、bucket、访问凭证和 path-style/TLS 等兼容性要求。
- [x] 已从 staging 控制台浏览器实际完成 R2 文件上传、下载和删除，确认 signed PUT/GET 与最小化
  CORS policy 生效（2026-09-01）。
- [ ] 后续 B2/Generic S3 bucket 也必须配置并实测最小化 CORS：仅允许管理后台实际 origin 和直传/
  直取所需 method/header，不开放不必要权限。否则 signed URL 会被浏览器拦截。

所有 secret 都只能通过本地忽略文件、交互式命令、Cloudflare Secret 或外部 secret manager 注入，不能写入
仓库、测试快照、日志或聊天记录。
