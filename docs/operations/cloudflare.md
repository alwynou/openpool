# Cloudflare 部署

OpenPool 由一个 Worker 同时提供 API 和构建后的 SPA，D1 保存 metadata，Secret 保存 master key。
正式部署前需要把 `apps/worker/wrangler.jsonc` 中的占位数据库 ID 换成真实值。

## 首次配置

```bash
npx wrangler login
npx wrangler d1 create openpool
```

复制命令返回的 `database_id` 到 `apps/worker/wrangler.jsonc`，然后配置加密主密钥：

```bash
openssl rand -base64 32
npx wrangler secret put CREDENTIAL_MASTER_KEY --config apps/worker/wrangler.jsonc
```

不要把生成值放进 shell history 以外的仓库文件；更严格环境应由 secret manager 注入命令 stdin。

## 迁移与部署

```bash
npm install
npm run verify
npm run db:migrate:remote
npm run deploy --workspace=@openpool/worker
```

远端迁移和部署是独立的破坏面：先确认目标 Cloudflare 账号和 D1 数据库，再执行。生产 `APP_ENV`
应使用 Wrangler environment 或 CI 配置覆盖，不能保留 `development`。

## 自定义域名

首个部署成功后，在 Cloudflare Dashboard 的 Worker Routes/Custom Domains 为 Worker 绑定例如
`oss.example.com`。API 与后台共用该域名，`/api/*` 先进入 Worker，其余路径优先由 Static Assets
处理并支持 SPA fallback。

## 回滚

- Worker 代码使用 Cloudflare deployment versions 回滚；
- D1 migration 默认只前进，必须通过新的补偿迁移恢复 schema；
- Provider credential rotation 与代码回滚分开操作；
- 任何回滚都不得让已签发上传写入一个 D1 不再认识的位置。

参考 Cloudflare 官方文档：[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、
[D1 本地开发](https://developers.cloudflare.com/d1/best-practices/local-development/)、
[Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)。
