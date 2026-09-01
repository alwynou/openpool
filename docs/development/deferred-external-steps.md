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
- [ ] 安全生成并配置独立的 `CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER` 和管理员 bootstrap secret；
  记录/保管 `CREDENTIAL_MASTER_KEY_ID`（默认 `primary-v1`），不要在 V1 期间更换已有 vault key。
- [ ] 明确授权后执行 `npm run db:migrate:staging`；仓库目前没有 production migration 命令。
- [ ] 明确授权后运行 `npm run deploy:staging`，将独立 Worker 发布到 staging `workers.dev`。只有
  同时授权 staging migration 和部署时才使用 `npm run deploy:staging:with-migrations`。
- [ ] 部署后确认 `*/5 * * * *` Cron Trigger 已创建，并在 Cloudflare 日志/metrics 看到 scheduled
  maintenance 运行记录。
- [ ] 如启用 CI/CD，创建最小权限 Cloudflare API token 并通过 CI secret 注入。

## Provider 真实联调

- [ ] 为 R2 创建独立测试 bucket 和 bucket-scoped S3 API credentials，执行 PUT/HEAD/GET/DELETE smoke test。
- [ ] 为 Backblaze B2 创建独立测试 bucket 和受限 application key，执行 S3-compatible smoke test。
- [ ] 为 Generic S3 提供测试 endpoint、region、bucket、访问凭证和 path-style/TLS 等兼容性要求。
- [ ] 为真实 Provider bucket 配置最小化 CORS：仅允许管理后台实际 origin，允许浏览器直传/直取所需
  的 `PUT`、`GET`、`HEAD` 和 `Content-Type`（以及 Provider 要求的必要响应头）；不要开放不必要的
  origin、method 或 header。否则 signed URL 在浏览器中会被 CORS 拦截。

所有 secret 都只能通过本地忽略文件、交互式命令、Cloudflare Secret 或外部 secret manager 注入，不能写入
仓库、测试快照、日志或聊天记录。
