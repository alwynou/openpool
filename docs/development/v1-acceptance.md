# V1 本地验收与发布清单

这是一份可执行的 runbook，但本文更新期间没有执行其中的远端命令、迁移、部署或真实 Provider
smoke。勾选项代表项目所有者或验收者实际取得证据后才可勾选；文档本身不构成远端验证声明。

## 1. 本地前置条件

- [ ] Node.js 22+、npm 10+，且 `npm install` 成功。
- [ ] `apps/worker/.dev.vars` 由本地安全值填充，至少包含：
  `ADMIN_BOOTSTRAP_TOKEN`、独立的 32 字节 canonical-base64 `CREDENTIAL_MASTER_KEY`、
  `CREDENTIAL_MASTER_KEY_ID=primary-v1`（或已审计的稳定 ID）、独立的 32 字节 canonical-base64
  `API_KEY_PEPPER`。
- [ ] `.dev.vars`、`.wrangler`、D1 导出和 Provider 凭证不在 git 状态中。
- [ ] 本地 migration 只通过 `npm run db:migrate:local` 应用；`npm run dev` 后确认
  `http://localhost:8787/api/v1/health` 返回 `status: ok`，Web 为 `http://localhost:5173`。
- [ ] `npm run verify` 通过，并保存 CI/本地输出作为本地证据。

## 2. 本地认证与安全边界

- [ ] `GET /api/v1/setup/status` 初始返回 `initialized: false`。
- [ ] 用 `x-openpool-bootstrap-token` 调用 `POST /api/v1/setup`，验证只成功一次；错误 token 为
  `403 INVALID_BOOTSTRAP_TOKEN`，重复初始化为 `409 ALREADY_INITIALIZED`，密码长度限制为 12–256。
- [ ] `POST /api/v1/auth/login` 设置 `openpool_session` HttpOnly、SameSite=Strict Cookie；错误
  用户名与错误密码都返回 `401 INVALID_CREDENTIALS`，不泄漏用户存在性。
- [ ] `GET /api/v1/auth/session` 可读取当前 session；`DELETE /api/v1/auth/session` 撤销并清除
  Cookie，重复登出仍为 `204`。
- [ ] 认证响应、管理响应和错误响应都包含 `requestId`；敏感响应为 `Cache-Control: no-store`。
- [ ] 初始化成功后删除 bootstrap Secret；后续初始化不需要它。重建全新实例时才生成新的 token。

## 3. 本地迁移顺序、备份与恢复演练

V1 schema 必须按以下顺序前滚，不能跳过或重排：

1. `database/migrations/0001_initial.sql`：核心实体，以及 API key/audit log 表；
2. `database/migrations/0002_storage_account_metadata.sql`：Provider capabilities 与容量准确性；
3. `database/migrations/0003_object_capacity_reservations.sql`：上传 session 唯一约束、断言
   guard 和容量预留/释放 triggers。

- [ ] `npx wrangler d1 migrations list openpool --local --config apps/worker/wrangler.jsonc` 显示
  0001、0002、0003 均按顺序应用。
- [ ] 用本地 D1 数据验证关键约束：同一 Bucket/key 唯一、每对象最多一个上传 session、每 Bucket
  最多一个 ACTIVE shard；容量预留、过期释放和删除释放各只发生一次。
- [ ] 迁移文件一旦在共享/远端环境执行，不再修改；schema 修复只新增编号更高的补偿 migration。
- [ ] 迁移前导出受保护备份，导出路径在仓库外且不提交：

  ```bash
  npx wrangler d1 export openpool --local --output <secure-path>/openpool-local-before.sql --config apps/worker/wrangler.jsonc
  ```

- [ ] 按[Cloudflare 运维 runbook](../operations/cloudflare.md)记录 D1 export、Time Travel/bookmark
  和恢复负责人；恢复是可能丢数据的破坏性操作，未经批准不得执行。

## 4. 本地控制面流程

- [ ] 用 fake transport 创建并验证 R2、B2、Generic S3 Storage Account；验证成功才进入 `ACTIVE`，
  列表不返回 credential 或 envelope。
- [ ] 创建 logical Bucket；为其创建 `STANDBY` shard 并激活；确认账号状态、健康、能力和容量门槛
  约束写入。
- [ ] Storage Account 仍有非 `RETIRED` shard、未删除 object location 或非零容量时，转为
  `REMOVED` 返回 `409 STORAGE_ACCOUNT_HAS_REFERENCES`；清理引用后才允许最终移除。
- [ ] 创建上传 reservation，确认 Worker 只返回短期签名 URL，不接收对象正文。
- [ ] 客户端直接 `PUT` 到 Provider，随后调用 complete；`HEAD` 大小不匹配返回
  `422 OBJECT_SIZE_MISMATCH`，匹配时 object/session 进入 `READY`/`COMPLETED`。签名必须包含预留的
  精确 `Content-Length` 和请求的 `Content-Type`；浏览器用同一个 `File`/`Blob` 作为 body，让运行时
  设置长度，不手工设置受限的 `Content-Length` header。
- [ ] `READY` 对象可生成短期 signed `GET` URL；删除经历 `DELETING → DELETED` 并只释放一次容量；
  Provider 404 删除可安全重试。
- [ ] 列表支持 `status`、`prefix`、`afterKey`、`limit`（1–1000）并按 logical key 稳定排序；
  公开响应不包含 account、shard、physical bucket/key、credential 或签名 URL。
- [ ] 过期 upload session 释放一次容量但保留 `PENDING` tombstone；同一 logical key 的后续
  reservation 按 V1 约束冲突。该限制待 future retry/version namespace design。
- [ ] 用 `npm run dev:worker -- --test-scheduled` 启动本地 Worker，并访问
  `http://localhost:8787/__scheduled` 触发一次 scheduled maintenance：验证签名 expiry 后 5 分钟
  grace 才将 session 原子标为 `EXPIRED`、释放一次容量并尝试清理 Provider；清理成功标为 `ABORTED`，
  Provider 失败时保留 `EXPIRED` 供下一次 cron 重试。确认 object tombstone 仍保留。

## 5. API Key 与审计

- [ ] 管理员创建 key 时只授予必要 scope、Bucket 和 path prefix，并设置合理过期时间；创建响应中的
  raw `opk_...` token 只保存一次。
- [ ] `GET /api/v1/api-keys` 只返回安全 metadata；`DELETE /api/v1/api-keys/:id` 可幂等撤销。
- [ ] 使用 `Authorization: Bearer <token>` 验证四个 object scope：`objects:list`、`objects:read`、
  `objects:upload`、`objects:delete`；验证 revoked/expired、错误 Bucket、越界 path 和缺失 scope
  均被拒绝。
- [ ] 确认 API Key 不能访问管理员初始化/login、Storage Account、Bucket/Shard 管理、API Key 管理
  或 audit-log 查询。
- [ ] `GET /api/v1/audit-logs` 仅管理员可访问；验证默认 limit 50、最大 200、actor/action/resource
  filters、成对 cursor，以及 `createdAt DESC, id DESC` 分页。
- [ ] 检查 audit metadata 只有安全字符串，不含 raw token、credential、authorization header 或
  signed URL；确认认证、账号、shard、object、API key 的状态变更都有预期事件。
- [ ] 接受 V1 audit 的明确边界：业务写入与 audit insert 非同一事务；监控 5xx，遇到 audit 写失败
  时先查询资源当前状态再决定是否重试。需要合规级完整性时不得把 V1 日志当作唯一账本。

## 6. 真实 Provider smoke（必须 opt-in）

以下步骤必须由项目所有者提供隔离资源和凭证，执行后才可声称真实联调通过：

- [ ] R2：隔离测试 bucket、bucket-scoped S3 credentials；执行 `HEAD Bucket` 验证以及 PUT/HEAD/
  GET/DELETE object smoke。
- [ ] Backblaze B2：隔离测试 bucket、受限 application key；用正确 region 执行同一组 S3-compatible
  smoke。
- [ ] Generic S3：提供 HTTPS endpoint、region、validation bucket、addressing style 和受限凭证；
  记录兼容性差异及错误分类。
- [ ] 在每个真实 bucket 配置最小化 CORS，只允许管理后台实际 origin，允许浏览器 signed URL 所需
  的 `PUT`、`GET`、`HEAD` 和 `Content-Type`（以及必要响应头）；不开放不必要 origin/method/header。
- [ ] 通过浏览器实际执行 signed PUT/GET，确认 CORS preflight 和 response headers 正常；curl 成功
  不能替代浏览器 CORS 验收。

## 7. 远端升级与部署（必须由所有者明确授权）

### 升级前

- [x] `npx wrangler login` 成功并确认唯一可见 account；staging 使用 APAC 的独立 D1 与
  `env.staging`（2026-09-01）。production 尚未创建，不能复用 staging database ID。
- [ ] 配置独立的 `CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER`、`ADMIN_BOOTSTRAP_TOKEN`；保管
  `CREDENTIAL_MASTER_KEY_ID`，V1 期间不更换已有 key/ID。
- [ ] 运行 `npx wrangler whoami --json`、`npx wrangler d1 info openpool --config apps/worker/wrangler.jsonc`
  和 migrations list，确认目标无误。
- [ ] 用仓库外受限路径保存迁移前 D1 export（包含 metadata、audit 和加密 credential envelope）：

  ```bash
  npx wrangler d1 export DB --remote --env staging --output <secure-path>/openpool-staging-before-v1.sql --config apps/worker/wrangler.jsonc
  ```

### 前滚与发布

- [x] 已执行 `npm run verify` 并获准运行 `npm run db:migrate:staging`；目标为独立 staging D1，
  且只前滚
  0001→0002→0003，随后 migrations list 显示无待办（2026-09-01）。新库迁移前为空，无用户数据
  可备份。
- [ ] 迁移成功后检查 migration history、健康接口、D1 关键约束和已有 credential 解密，再部署
  Worker；生产覆盖 `APP_ENV`，不使用 `development`。
- [ ] 迁移确认完成后，运行根目录 `npm run deploy:staging` 构建 Web 并部署
  `openpool-staging`；该命令不会隐式迁移 D1，但不是 dry-run，必须视为有远端发布副作用的命令。
- [ ] 仅在明确需要把两个远端步骤合并且已再次确认账号、D1、备份和授权时，才使用
  `npm run deploy:staging:with-migrations`；该命令会先迁移 staging D1 再部署 staging Worker。
- [ ] 部署后执行健康、认证、控制面流程，并重复真实 Provider signed PUT/GET/CORS smoke；确认
  observability 日志无敏感值。
- [ ] 确认 Wrangler `*/5 * * * *` Cron Trigger 已随 Worker 创建，并在 Cloudflare 日志/metrics 中
  看到至少一次 scheduled maintenance 运行记录；确认失败清理会留待下次重试。

### 失败、回滚与后续

- [ ] 单个 migration 失败时保留 Wrangler 的失败输出；该迁移应保持回滚，之前成功的 migration 不变。
- [ ] Worker 版本异常时使用 deployment version 回滚，但先确认旧代码兼容当前 schema/envelope；不要
  通过改 key 或 ID 规避问题。
- [ ] 已应用 migration 不能回滚 SQL；schema 修复新增补偿 migration。数据恢复只能在停止写入、
  评估数据丢失风险并获批准后，使用 export 或 D1 Time Travel bookmark/timestamp。
- [ ] 恢复/回滚后重新检查 migration history、账号健康/状态、容量计数和已签发 URL 的物理位置，
  确认不会把上传写入 D1 不再认识的位置。

## 8. 外部步骤记录

尚未完成或需要项目所有者参与的事项集中记录在[Deferred 外部步骤](deferred-external-steps.md)。
在 owner 提供证据前，以下事项必须保持未勾选：Cloudflare login/account/D1 ID、三类 Secrets、
远端 migration/deploy、真实 R2/B2/Generic S3 smoke、bucket CORS 和自定义域名。
