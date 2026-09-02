# TypeScript SDK（私有预览）

`@openpool/sdk` 是现有对象控制 API 的轻量 Fetch 客户端，目前只在 workspace 内使用，不发布到
npm，也不承诺独立的公共版本兼容周期。它依赖 `@openpool/contracts`，不依赖 Worker、D1、Hono、
Provider SDK 或 domain/application 包。

## 创建客户端

Node.js 22+ 或浏览器可以直接提供原生 Fetch。远端 control-plane URL 必须使用 HTTPS；只有
`localhost`、`127.0.0.1` 和 `::1` 允许 HTTP。

```ts
import { OpenPoolClient } from '@openpool/sdk';

const apiKey = process.env.OPENPOOL_API_KEY;
if (!apiKey) throw new Error('OPENPOOL_API_KEY is required');

const client = new OpenPoolClient({
  baseUrl: 'https://openpool.example.com',
  apiKey,
});
```

机器客户端推荐使用带最小 scope 的 API Key。浏览器若已经通过同源管理员 session 登录，可省略
`apiKey` 并显式设置 `credentials: 'include'`（同源控制台也可使用 `same-origin`）。SDK 不读取 HttpOnly
Cookie，不实现 Node Cookie jar，也不负责登录或保存管理员密码。

## 管理面

SDK 已覆盖现有 Storage Account、Logical Bucket、Storage Shard、API Key 和审计查询接口。它们是
管理员 session-only API；调用方必须提供已经登录的浏览器 session，API Key 不能借此提升为管理员。

```ts
const admin = new OpenPoolClient({
  baseUrl: window.location.origin,
  credentials: 'same-origin',
});

const accounts = await admin.listAccounts();
const bucket = await admin.createBucket({ name: 'documents' });
const auditPage = await admin.listAuditLogs({ limit: 50, actorType: 'ADMIN' });
```

Storage Account credential 只作为 `createAccount` 或 `updateAccountConfiguration` 的请求参数发送；响应
类型不包含 credential 或加密信封。`createApiKey` 返回的一次性 token 由调用方立即安全保存，SDK 不会
持久化、记录或自动采用它。Shard Migration 仍由管理后台和专用 migrator 使用现有接口，不属于这批
通用 SDK 方法。

## 对象查询与直接传输

```ts
const objects = await client.listObjects('bucket-id', {
  status: 'READY',
  prefix: 'reports/',
  limit: 100,
});

const completed = await client.uploadObject(
  {
    bucketId: 'bucket-id',
    logicalKey: 'reports/2026.pdf',
    sizeBytes: file.size,
    contentType: file.type || 'application/octet-stream',
  },
  file,
);

const response = await client.downloadObject(completed.object.id);
```

`uploadObject` 严格按 reserve → signed `PUT` → complete 执行；`downloadObject` 先取得 signed URL，
再直接 `GET` Provider。SDK 的 control-plane Authorization 和 Cookie 永远不会复制到 signed URL
请求，对象正文也不会发送给 Worker。浏览器直传仍要求 Provider 为实际应用 origin 配置最小 CORS。

需要自行保存 reservation 或精确控制重试时，分别调用 `createUpload`、`uploadDirect` 和
`completeUpload`。传给 `uploadDirect` 的 body、`sizeBytes` 与 `contentType` 必须一致；不要手工设置
浏览器受限的 `Content-Length`。

## 错误与重试

- `OpenPoolApiError`：保留 HTTP `status`、稳定 `code` 和 `requestId`；
- `OpenPoolProtocolError`：control plane 返回不可读或非法 envelope/签名 URL；
- `OpenPoolTransferError`：Provider 拒绝 signed upload/download，只暴露操作类型和状态码，不读取或
  拼接 Provider 响应正文。

SDK 不自动重试请求。调用方可以按服务端既有幂等语义重试 `completeUpload` 和 `deleteObject`；不要
默认重试 reserve 等非幂等控制请求。

当前方法覆盖 health/setup 状态、Storage Account、Logical Bucket、Storage Shard、API Key、审计查询，
以及对象列表/元数据、reserve/complete、签名下载和删除。Web 管理控制台复用同一客户端，登录/初始化
和 Shard Migration 暂时保留专用请求路径。公开发布、Node 管理员认证、自动重试与通用 CLI 仍需单独
确定兼容和安全策略。
