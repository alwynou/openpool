# OpenPool

> A self-hosted, Cloudflare-native object storage control plane.

OpenPool 把用户合法拥有的多个 Cloudflare R2、Backblaze B2 和 S3-compatible
存储账号组织成一个逻辑存储池，并通过统一命名空间、管理后台和 API 提供访问。

当前仓库是可运行的 V1 基础骨架：Worker 健康接口、React 控制台、D1 初始模型、
Placement Engine 和 Workers 运行时测试已经就位；登录、Provider 凭证接入和完整上传流程
仍在后续路线中。

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
npm run db:migrate:local
npm run dev
```

打开 `http://localhost:5173`。Worker API 运行在 `http://localhost:8787`，Vite 会把
`/api` 请求代理过去。

提交前运行：

```bash
npm run verify
```

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

V1 计划支持单管理员、R2/B2/Generic S3、逻辑 Bucket、文件管理、容量与健康检查、
简单 Placement、API Key、签名上传/下载、删除、审计日志和凭证加密。

完整 S3 Gateway、GitHub Provider、自动迁移、多副本、多用户、计费与复杂 RBAC 不属于
V1。

## License

[MIT](LICENSE)
