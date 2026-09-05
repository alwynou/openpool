# OpenPool

> A self-hosted, Cloudflare-native object storage control plane.

OpenPool 把用户合法拥有的多个 Cloudflare R2、Backblaze B2 和 S3-compatible
存储账号组织成一个逻辑存储池，并通过统一命名空间、管理后台和 API 提供访问。

当前仓库是持续实现中的 V1 控制面：Worker 健康接口、单管理员初始化与 session、AES-GCM
credential vault、Storage Account 生命周期、R2/B2/Generic S3 验证与签名、D1 模型、Placement
Engine、logical bucket、对象 reserve/complete/download/delete、API Key 管理与 audit-log 查询 API
以及覆盖这些管理面的 Web 控制台已经实现。Phase 2 的 account drain/shard migration 控制面、流式
搬运 CLI 与恢复清理已实现。独立 Cloudflare staging、D1、Secret、部署、真实 R2/B2 直传、双向小文件
迁移和事务审计 outbox 已验收；Generic S3、production、自动部署与更广的故障/压力验收仍需项目所有者
参与或授权。升级证据见[迁移与审计验收](docs/development/staging-upgrade-acceptance.md)和
[上传重试验收](docs/development/staging-upload-retry-acceptance.md)。
管理控制台支持英文和简体中文，可自动识别浏览器语言并记住用户选择；本地测试和 staging
真实浏览器切换/刷新持久化均已验收。
管理员初始化/登录已接入 Cloudflare 原生双层限流；健康接口会预检 D1、关键 Secret、认证 bindings
与 bootstrap 生命周期，并在部署配置不安全时 fail closed。该安全升级已通过 staging readiness、
真实 429/恢复窗口和管理员 session 验收。

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

GitHub Actions 会在 pull request 以及 `main`/`dev` push 上运行同一条验证命令。
验证工作流只有仓库只读权限，不接收 Cloudflare Secret，也不会部署 Worker 或执行 migration。受保护的
`main` 只接受 pull request，并要求分支跟上最新 `main` 且 `CI / Verify` 成功后才能合并。

本地开发会使用被忽略的 Wrangler D1 状态和 `.dev.vars`；首次启动前请先阅读
[本地开发](docs/development/getting-started.md)。远端配置、迁移和发布必须按
[V1 本地验收与发布清单](docs/development/v1-acceptance.md)执行，并由项目所有者明确授权。

## 仓库导航

```text
apps/worker/          Cloudflare Worker、HTTP 适配器、组合根
apps/web/             React 管理控制台
apps/migrator/        Shard migration 流式数据搬运 CLI
apps/cli/             API Key 鉴权的通用对象 CLI
packages/domain/      纯领域模型与 Placement 规则
packages/application/ 用例与端口（接口）
packages/contracts/   Worker 与 Web 共用的 API 契约
packages/sdk/         私有预览 TypeScript 对象 API 客户端
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

上传失败／过期后的显式重试已实现并随 `0006` 和配套 Worker/Web 部署到 staging：保留同一
object ID/logical key，生成新 session/物理位置，旧尝试独立清理。真实 R2/B2 验收见
[上传重试验收记录](docs/development/staging-upload-retry-acceptance.md)；不支持覆盖 READY 或复用
DELETED 路径。Shard migration 需要在线 CLI 搬运器，scheduled maintenance
只恢复 primary 已切换后的源清理；仍没有通用的无人值守跨 Provider replication、自动修复或 gateway。
对象字节始终不会经过 Worker。

现有对象控制 API 的 Fetch 客户端见 [TypeScript SDK](docs/sdk/typescript.md)，命令行使用见
[对象 CLI](docs/cli/objects.md)。CLI 支持列表、详情、上传、下载、删除、上传状态、幂等完成和显式重试，
只使用受限 API Key，不登录管理员或保存凭据。SDK/CLI 保持 reserve/complete 控制流与 Provider
signed transfer 分离，目前均为 workspace 内私有预览，不代表公开 npm 发布承诺。
构建后的 CLI 已完成 [staging R2/B2 小文件验收](docs/development/staging-cli-acceptance.md)，
覆盖哈希比对、权限、分页、防覆盖、显式恢复和删除；另已通过
[50 MB 文件与中途取消验收](docs/development/staging-cli-50mb-acceptance.md)，提供显式 opt-in 的
[可重复 smoke 脚本](docs/development/cli-smoke.md)。更大文件、并发/压力和长期测试仍未验收。

## License

[MIT](LICENSE)
