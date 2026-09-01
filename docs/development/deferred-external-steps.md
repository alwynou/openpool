# Deferred 外部步骤

本文记录本地开发无法独立完成、必须由项目所有者提供账号权限、真实凭证或远端操作授权的步骤。
这些步骤不阻塞对应功能的本地实现、Fake 测试和离线集成测试。

## Cloudflare 平台

- [x] 使用 `wrangler login` 完成交互式 Cloudflare 登录，并通过 `wrangler whoami --json` 确认唯一
  可见的 Cloudflare account（2026-09-01；账号 ID 与登录邮箱不写入仓库）。
- [ ] 决定 test/production 是否使用独立 Cloudflare account 或至少独立资源与环境。
- [ ] 确认 D1 location 或 jurisdiction，再创建远端 D1 并替换 `wrangler.jsonc` 中的占位 ID。
- [ ] 安全生成并配置独立的 `CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER` 和管理员 bootstrap secret；
  记录/保管 `CREDENTIAL_MASTER_KEY_ID`（默认 `primary-v1`），不要在 V1 期间更换已有 vault key。
- [ ] 明确授权后执行远端 D1 migration。
- [ ] 明确授权后部署 Worker（根目录 `npm run deploy` 只构建 Web 并发布，不隐式迁移 D1），并决定
  使用 `workers.dev` 还是自定义域名。只有同时授权远端迁移和部署时才使用
  `npm run deploy:with-migrations`。
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
