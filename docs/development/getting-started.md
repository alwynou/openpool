# 本地开发

## 环境

- Node.js 22+
- npm 10+
- 首次远端部署需要 Cloudflare 账号和 Wrangler 登录

## 启动

```bash
npm install
npm run dev:secrets
npm run db:migrate:local
npm run dev
```

- Web：`http://localhost:5173`
- Worker：`http://localhost:8787`
- 健康检查：`http://localhost:8787/api/v1/health`

健康接口同时是部署就绪检查。D1 尚未迁移、关键 Secret 缺失/格式错误或认证限流 binding 缺失时返回
`503 DEPLOYMENT_NOT_READY`；响应只列安全 issue code，不包含 Secret 值。

`npm run dev` 同时启动 Vite 与 Wrangler；Web 的 `/api` 会代理到本地 Worker。Wrangler 的本地 D1
状态位于被忽略的 `.wrangler` 目录。

## 常用命令

```bash
npm run test
npm run test:watch
npm run typecheck
npm run lint
npm run build
npm run verify
npm run dev:worker:scheduled
```

代码检查由 Oxlint 执行；仓库不依赖 ESLint 或 Prettier。

`npm run dev:worker:scheduled` 会显式启用 Wrangler 的 `--test-scheduled`，可通过
`http://localhost:8787/cdn-cgi/handler/scheduled?format=json` 手工触发一次本地 Cron，并检查结构化
outcome。该 Wrangler 保留路径不会被 Static Assets 的 SPA fallback 截获，也不是业务 API。

新增或修改 `wrangler.jsonc` binding 后运行 `npm run cf:typegen`。生成文件不手工编辑。

本地和 staging 都声明了两组 Cloudflare 原生认证限流 binding：每个认证入口 30 次/分钟的 location
总量上限，以及每个用户名指纹 5 次/分钟的身份上限。它们只覆盖初始化与管理员登录；本地开发由
Wrangler 模拟，真实计数语义以 Cloudflare 网络为准。

首次本地启动使用 `npm run dev:secrets` 创建权限为 `0600` 的 `apps/worker/.dev.vars`。该命令生成三组
独立的 32-byte 随机值，不打印 secret，并在文件已存在时拒绝覆盖。本地 Secret 不要提交：

```dotenv
ADMIN_BOOTSTRAP_TOKEN=generate-a-long-random-value
CREDENTIAL_MASTER_KEY=base64-encoded-32-byte-key
CREDENTIAL_MASTER_KEY_ID=primary-v1
API_KEY_PEPPER=another-base64-encoded-32-byte-key
```

`CREDENTIAL_MASTER_KEY_ID` 可省略，默认是 `primary-v1`。在实现 credential rotation 前，不要在已有
加密数据上更改该 ID 或 master key；不匹配会按安全策略 fail closed。

`CREDENTIAL_MASTER_KEY` 与 `API_KEY_PEPPER` 必须是独立生成、恰好 32 字节并使用 canonical base64
编码的值；不要复用。三个 Secret 都不能提交。生产环境使用 Wrangler Secret，不要把值写入
`wrangler.jsonc`。

首次打开控制台时，用 `ADMIN_BOOTSTRAP_TOKEN` 创建唯一的管理员。bootstrap token 仅从请求头读取，
不会写入 D1 或浏览器存储；管理员密码需为 12–256 个字符。初始化成功后可删除
`ADMIN_BOOTSTRAP_TOKEN` 以缩小暴露面；后续初始化请求会因已经初始化而拒绝，不需要该 Secret。
只有重建全新的 D1/实例时，才为新实例生成新的 bootstrap token。

本地开发与 Workers Vitest 不需要 `wrangler login`。登录只在创建或操作远端 Cloudflare 资源时需要，
这些步骤记录在 [Deferred 外部步骤](deferred-external-steps.md)。
