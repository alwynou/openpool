# 本地开发

## 环境

- Node.js 22+
- npm 10+
- 首次远端部署需要 Cloudflare 账号和 Wrangler 登录

## 启动

```bash
npm install
npm run db:migrate:local
npm run dev
```

- Web：`http://localhost:5173`
- Worker：`http://localhost:8787`
- 健康检查：`http://localhost:8787/api/v1/health`

`npm run dev` 同时启动 Vite 与 Wrangler；Web 的 `/api` 会代理到本地 Worker。Wrangler 的本地 D1
状态位于被忽略的 `.wrangler` 目录。

## 常用命令

```bash
npm run test
npm run test:watch
npm run typecheck
npm run lint
npm run format
npm run build
npm run verify
```

新增或修改 `wrangler.jsonc` binding 后运行 `npm run cf:typegen`。生成文件不手工编辑。

本地 Secret 放在 `apps/worker/.dev.vars`，不要提交：

```dotenv
CREDENTIAL_MASTER_KEY=base64-encoded-32-byte-key
```
