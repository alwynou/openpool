# OpenPool

> A self-hosted, Cloudflare-native object storage control plane.

OpenPool 把用户合法拥有的多个 Cloudflare R2、Backblaze B2 和 S3-compatible
存储账号组织成一个逻辑存储池，并通过统一命名空间、管理后台和 API 提供访问。

当前仓库是持续实现中的 V1 控制面：Worker 健康接口、单管理员初始化与 session、AES-GCM
credential vault、Storage Account 生命周期、R2/B2/Generic S3 验证与签名、D1 模型、Placement
Engine、logical bucket、对象 reserve/complete/download/delete、API Key 管理与 audit-log 查询 API
以及覆盖这些管理面的 Web 控制台已经实现。独立 Cloudflare staging、D1、Secret、部署及真实 R2
直传 smoke 已验收；B2、Generic S3、production 和 CI/CD 仍需要项目所有者提供外部资源或授权。

## 架构原则

- Cloudflare Worker 只承载认证、元数据、放置决策和签名 URL 等控制面流量。
- 对象内容不经过 Worker；客户端使用签名 URL 与 R2/B2/S3 直接传输。
- D1 维护逻辑对象到物理位置的映射，用户路径不依赖底层 Provider。
- 核心领域与 Cloudflare、D1、HTTP、具体 Provider 解耦。

```text
Browser / SDK ── control API ──> Worker ──> D1
      │                            │
      └──── object bytes ──────────┴────> R2 / B2 / S3
```

## 快速开始

要求 Node.js 22+。

```bash
npm install
npm run dev:secrets
npm run db:migrate:local
npm run dev
```

打开 `http://localhost:5173`。Worker API 运行在 `http://localhost:8787`，Vite 会把
`/api` 请求代理过去。

提交前运行：

```bash
npm run verify
```

本地开发会使用被忽略的 Wrangler D1 状态和 `.dev.vars`；首次启动前请先阅读
[本地开发](docs/development/getting-started.md)。远端配置、迁移和发布必须按
[V1 本地验收与发布清单](docs/development/v1-acceptance.md)执行，并由项目所有者明确授权。

## 仓库导航

```text
apps/worker/          Cloudflare Worker、HTTP 适配器、组合根
apps/web/             React 管理控制台
packages/domain/      纯领域模型与 Placement 规则
packages/application/ 用例与端口（接口）
packages/contracts/   Worker 与 Web 共用的 API 契约
database/migrations/  D1 迁移；只追加，不回写已发布迁移
docs/                 架构、开发、Provider 与运维文档
```

从 [docs/README.md](docs/README.md) 开始阅读。Cloudflare 部署步骤见
[docs/operations/cloudflare.md](docs/operations/cloudflare.md)，开发约定见
[docs/development/workflow.md](docs/development/workflow.md)。

## V1 范围

V1 控制面支持单管理员、R2/B2/Generic S3、逻辑 Bucket、文件元数据管理、容量与健康检查、
简单 Placement、API Key、签名上传/下载、删除、审计日志和凭证加密。当前完成状态与未完成的
真实环境验收见[路线图](docs/roadmap.md)和[V1 验收清单](docs/development/v1-acceptance.md)。

完整 S3 Gateway、GitHub Provider、自动迁移、多副本、多用户、计费与复杂 RBAC 不属于
V1。

V1 的已知限制：过期 `PENDING` tombstone 会保留以供审计，因此同一 logical key 不能立即复用；
后续需要 retry/version namespace design。V1 没有无人值守的自动 migration、自动 replication 或
gateway（发布命令虽可串联迁移，但必须由用户明确授权），对象字节也不会经 Worker 代理。

## License

[MIT](LICENSE)
