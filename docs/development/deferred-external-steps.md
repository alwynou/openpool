# Deferred 外部步骤

本文记录本地开发无法独立完成、必须由项目所有者提供账号权限、真实凭证或远端操作授权的步骤。
这些步骤不阻塞对应功能的本地实现、Fake 测试和离线集成测试。

## Cloudflare 平台

- [ ] 使用 `wrangler login` 完成交互式 Cloudflare 登录；当前本机 Wrangler 未认证。
- [ ] 确认目标 Cloudflare account，以及 test/production 是否隔离。
- [ ] 确认 D1 location 或 jurisdiction，再创建远端 D1 并替换 `wrangler.jsonc` 中的占位 ID。
- [ ] 安全生成并配置 `CREDENTIAL_MASTER_KEY` 和管理员 bootstrap secret。
- [ ] 明确授权后执行远端 D1 migration。
- [ ] 明确授权后部署 Worker，并决定使用 `workers.dev` 还是自定义域名。
- [ ] 如启用 CI/CD，创建最小权限 Cloudflare API token 并通过 CI secret 注入。

## Provider 真实联调

- [ ] 为 R2 创建独立测试 bucket 和 bucket-scoped S3 API credentials，执行 PUT/HEAD/GET/DELETE smoke test。
- [ ] 为 Backblaze B2 创建独立测试 bucket 和受限 application key，执行 S3-compatible smoke test。
- [ ] 为 Generic S3 提供测试 endpoint、region、bucket、访问凭证和 path-style/TLS 等兼容性要求。

所有 secret 都只能通过本地忽略文件、交互式命令、Cloudflare Secret 或外部 secret manager 注入，不能写入
仓库、测试快照、日志或聊天记录。
