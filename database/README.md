# D1 migrations

迁移按四位递增编号保存，例如 `0002_add_provider_capabilities.sql`。

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

只追加新迁移，不修改已在共享或远端环境执行过的 SQL。远端迁移必须由用户明确授权；执行前确认
`apps/worker/wrangler.jsonc` 的数据库 ID 和当前 Cloudflare 账号。
