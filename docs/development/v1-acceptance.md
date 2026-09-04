# V1 本地验收与发布清单

这是一份可执行的 runbook。勾选项代表项目所有者或验收者已经取得证据；2026-09-01 已完成的
staging 远端操作记录在第 7 节。真实 R2/B2 smoke 已完成，Generic S3 仍需项目所有者提供资源。
2026-09-02 的 0004/0005 前滚、迁移 CLI 和事务审计 outbox 证据另见[升级验收记录](staging-upgrade-acceptance.md)。
同日 `0006` 和配套 Worker/Web 已发布到 staging，真实 R2/B2 测试见[上传重试验收](staging-upload-retry-acceptance.md)。

## 1. 本地前置条件

- [x] Node.js 22.23.2、npm 10.9.8，且依赖安装与 workspace 命令成功（2026-09-01）。
- [x] `npm run dev:secrets` 创建权限为 `0600` 的 `apps/worker/.dev.vars`，至少包含：
  `ADMIN_BOOTSTRAP_TOKEN`、独立的 32 字节 canonical-base64 `CREDENTIAL_MASTER_KEY`、
  `CREDENTIAL_MASTER_KEY_ID=primary-v1`（或已审计的稳定 ID）、独立的 32 字节 canonical-base64
  `API_KEY_PEPPER`。
- [x] `.dev.vars` 与 `.wrangler` 均由 `.gitignore` 排除，git 状态中没有 D1 导出或 Provider 凭证
  （2026-09-01）。
- [x] 本地 migration 只通过 `npm run db:migrate:local` 应用；`npm run dev` 后
  `http://localhost:8787/api/v1/health` 返回 `status: ok`，Web 由 Vite 在
  `http://localhost:5173` 提供（2026-09-01）。
- [x] `npm run verify` 通过：Oxlint、全部 workspace typecheck、314 个测试和 Web/Worker build
  （2026-09-01）。

## 2. 本地认证与安全边界

- [x] `GET /api/v1/setup/status` 初始返回 `initialized: false`（2026-09-01）。
- [x] 用 `x-openpool-bootstrap-token` 调用 `POST /api/v1/setup`，验证只成功一次；错误 token 为
  `403 INVALID_BOOTSTRAP_TOKEN`，重复初始化为 `409 ALREADY_INITIALIZED`，密码长度限制为 12–256。
  真实环境使用密码管理器生成的高熵随机密码，以配合 Workers 允许的 100,000 次 PBKDF2 上限。
- [x] `POST /api/v1/auth/login` 设置 `openpool_session` HttpOnly、SameSite=Strict Cookie；错误
  用户名与错误密码都返回 `401 INVALID_CREDENTIALS`，不泄漏用户存在性。
- [x] setup/login 在凭证校验前经过 Cloudflare 原生双层限流；入口超过 30 次/分钟或用户名指纹超过
  5 次/分钟时返回 `429 RATE_LIMITED` 与 `Retry-After: 60`，binding 异常时 fail closed 为 503。
- [x] `/api/v1/health` 对 D1、32 字节 canonical-base64 master key/pepper、Secret 复用、key ID、
  认证限流 binding 和 bootstrap 生命周期执行 readiness preflight；失败只返回安全 issue code，
  静态关键配置错误同时阻断其他 API 与 scheduled maintenance。
- [x] `GET /api/v1/auth/session` 可读取当前 session；`DELETE /api/v1/auth/session` 撤销并清除
  Cookie，重复登出仍为 `204`。
- [x] 认证响应、管理响应和错误响应都包含 `requestId`；敏感响应为 `Cache-Control: no-store`
  （2026-09-01）。
- [x] staging 初始化成功后已删除 bootstrap Secret；后续初始化不需要它。忽略的本地 `.dev.vars`
  保留 token 仅用于重建本地 D1，重建实例时由生成器创建新值（2026-09-01）。

## 3. 本地迁移顺序、备份与恢复演练

V1 schema 必须按以下顺序前滚，不能跳过或重排：

1. `database/migrations/0001_initial.sql`：核心实体，以及 API key/audit log 表；
2. `database/migrations/0002_storage_account_metadata.sql`：Provider capabilities 与容量准确性；
3. `database/migrations/0003_object_capacity_reservations.sql`：上传 session 唯一约束、断言
   guard 和容量预留/释放 triggers。

- [x] `npx wrangler d1 migrations list openpool --local --config apps/worker/wrangler.jsonc` 显示
  0001、0002、0003 均按顺序应用。
- [x] Workers Vitest 的本地 D1 验证关键约束：同一 Bucket/key 唯一、每对象最多一个上传 session、
  每 Bucket 最多一个 ACTIVE shard；容量预留、过期释放和删除释放各只发生一次（2026-09-01）。
- [x] 已远端应用的 0001–0003 保持未修改；schema 修复只新增编号更高的补偿 migration。
- [ ] 迁移前导出受保护备份，导出路径在仓库外且不提交：

  ```bash
  npx wrangler d1 export openpool --local --output <secure-path>/openpool-local-before.sql --config apps/worker/wrangler.jsonc
  ```

- [ ] 按[Cloudflare 运维 runbook](../operations/cloudflare.md)记录 D1 export、Time Travel/bookmark
  和恢复负责人；恢复是可能丢数据的破坏性操作，未经批准不得执行。

## 4. 本地控制面流程

- [x] 用 fake transport 创建并验证 R2、B2、Generic S3 Storage Account；验证成功才进入 `ACTIVE`，
  列表不返回 credential 或 envelope。
- [x] `VERIFYING` Storage Account 可纠正 Provider 配置、按需替换加密 credential，并以
  `updatedAt` 条件写入后重新验证；已激活账号不可使用该纠错路径，响应与 audit 不泄露敏感值。
- [x] 创建 logical Bucket；为其创建 `STANDBY` shard 并激活；确认账号状态、健康、能力和容量门槛
  约束写入。
- [x] Storage Account 仍有非 `RETIRED` shard、未删除 object location 或非零容量时，转为
  `REMOVED` 返回 `409 STORAGE_ACCOUNT_HAS_REFERENCES`；清理引用后才允许最终移除。
- [x] 创建上传 reservation，确认 Worker 只返回短期签名 URL，不接收对象正文。
- [x] 客户端直接 `PUT` 到 Provider，随后调用 complete；`HEAD` 大小不匹配返回
  `422 OBJECT_SIZE_MISMATCH`，匹配时 object/session 进入 `READY`/`COMPLETED`。签名必须包含预留的
  精确 `Content-Length` 和请求的 `Content-Type`；浏览器用同一个 `File`/`Blob` 作为 body，让运行时
  设置长度，不手工设置受限的 `Content-Length` header。
- [x] `READY` 对象可生成短期 signed `GET` URL；删除经历 `DELETING → DELETED` 并只释放一次容量；
  Provider 404 删除可安全重试。
- [x] 列表支持 `status`、`prefix`、`afterKey`、`limit`（1–1000）并按 logical key 稳定排序；
  公开响应不包含 account、shard、physical bucket/key、credential 或签名 URL。
- [x] 过期 upload session 释放一次容量但保留 `PENDING` tombstone；普通同路径 reservation 仍冲突。
  `0006` 新增显式 retry：同一 object/key、全新 session/物理位置、旧会话隔离、容量/审计原子
  交换，支持 PENDING/EXPIRED/ABORTED 当前尝试。已用用例、D1、HTTP、SDK/Web 工作流测试验证；
  staging 已应用 0006 并部署配套 Worker/Web，实际远端证据见[上传重试验收](staging-upload-retry-acceptance.md)。
- [x] 用 `npm run dev:worker:scheduled` 启动本地 Worker，并访问
  `http://localhost:8787/cdn-cgi/handler/scheduled?format=json` 触发一次 scheduled maintenance：验证
  outcome 为 `ok`，并通过 scheduled/repository tests 验证签名 expiry 后 5 分钟
  grace 才将 session 原子标为 `EXPIRED`、释放一次容量并尝试清理 Provider；清理成功标为 `ABORTED`，
  Provider 失败时保留 `EXPIRED` 供下一次 cron 重试。确认 object tombstone 仍保留。

## 5. API Key 与审计

- [x] staging 管理员创建了限制到 `smoke-test` Bucket、`api-smoke/` path、所需 scope 和一小时过期
  时间的 key；raw `opk_...` token 仅在进程内使用一次，未保存到仓库、日志或聊天（2026-09-01）。
- [x] `GET /api/v1/api-keys` 只返回安全 metadata，不含 raw token；
  `DELETE /api/v1/api-keys/:id` 重复撤销返回相同时间，验证幂等（2026-09-01）。
- [x] 使用 `Authorization: Bearer <token>` 完成四个 object scope 的真实 R2 生命周期；revoked、expired、
  错误 Bucket、越界 path 和缺失 scope 均按预期返回 `401`/`403`（2026-09-01）。
- [x] staging API Key 访问 Storage Account、Bucket/Shard、API Key 管理和 audit-log 查询均被拒绝；
  初始化/login 仍只接受各自的 bootstrap/password 认证，不接受 Bearer key（2026-09-01）。
- [x] `GET /api/v1/audit-logs` 仅管理员可访问；已验证默认 limit 50、最大 200、actor/action/resource
  filters、成对 cursor、分页不重叠和非法 limit 拒绝（2026-09-01）。
- [x] 抽查 53 条远端 audit：metadata 只有字符串，不含完整 raw token、credential、authorization
  header、signed URL 或 credential envelope；API_KEY actor 的授权与对象生命周期事件完整
  （2026-09-01）。
- [x] 2026-09-01 的原始 V1 audit 使用独立 append；2026-09-02 staging 升级为业务写入与 outbox
  同事务提交，已验证投递前后可见性、稳定 event id 与去重。审计仍不是防篡改合规账本；遇到不确定
  响应时仍应先查询业务资源状态，再按幂等语义决定是否重试。

## 6. 真实 Provider smoke（必须 opt-in）

以下步骤必须由项目所有者提供隔离资源和凭证，执行后才可声称真实联调通过：

- [x] R2：APAC 隔离测试 bucket `openpool-staging-smoke` 使用 bucket-scoped Object Read & Write
  credentials，通过 `HEAD Bucket` 验证、逻辑 Bucket/ACTIVE shard、签名 PUT、complete/HEAD、签名
  GET 字节比对及 DELETE smoke；删除后容量归零且 R2 bucket 为空（2026-09-01）。
- [x] Backblaze B2：私有隔离 bucket `openpool-b2-staging-5dfebd7d02`、bucket-scoped Read & Write
  application key 和 `us-east-005` region，通过账号验证、逻辑 Bucket/ACTIVE shard、浏览器签名 PUT、
  complete、签名 GET 字节比对及 DELETE smoke；删除后 OpenPool 账号容量归零（2026-09-01）。B2 bucket
  使用 `Keep all versions`，因此 S3 DELETE 隐藏当前对象但保留历史版本；这是 Provider 生命周期策略，
  不能把控制台仍显示历史字节误判为 OpenPool 删除失败。
- [ ] Generic S3：提供 HTTPS endpoint、region、validation bucket、addressing style 和受限凭证；
  记录兼容性差异及错误分类。
- [x] R2 bucket 使用最小化 CORS，只允许 staging 控制台 origin，以及 signed URL 所需的
  `PUT`、`GET`、`HEAD`、`DELETE`、`Content-Type` 和 `ETag`；已通过浏览器实际上传、下载和删除
  验收（2026-09-01）。
- [x] B2 bucket 使用自定义 CORS，只允许 staging `workers.dev` origin，以及 S3 `PUT`/`GET`/`HEAD`
  所需的 `Content-Type`、`Authorization` 和 `Range`；真实浏览器预检、上传和下载均通过
  （2026-09-01）。Backblaze Web Console 的标准“共享所有内容”预设只包含 S3 `GET`/`HEAD`，不能
  用于 OpenPool 浏览器直传。
- [ ] Generic S3 bucket 仍需配置并实测最小化 CORS，不得开放不必要 origin/method/header。

## 7. 远端升级与部署（必须由所有者明确授权）

### 升级前

- [x] `npx wrangler login` 成功并确认唯一可见 account；staging 使用 APAC 的独立 D1 与
  `env.staging`（2026-09-01）。production 尚未创建，不能复用 staging database ID。
- [x] staging 首次部署已配置独立的 `CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER`、
  `ADMIN_BOOTSTRAP_TOKEN`，并在 macOS 登录钥匙串备份；`CREDENTIAL_MASTER_KEY_ID=primary-v1`
  （2026-09-01）。管理员初始化后已从 Worker 删除一次性 bootstrap secret，当前远端 secret list
  只保留 master key 和 pepper。V1 期间不更换已有 key/ID。
- [x] 运行 `npx wrangler whoami --json`、`npx wrangler d1 info openpool-staging --json` 和
  `npx wrangler d1 migrations list DB --remote --env staging --config apps/worker/wrangler.jsonc`，确认
  唯一可见 account、APAC staging D1 和 migration history 无误（2026-09-01）。
- [ ] 下一次对已有数据的远端 schema 升级前，用仓库外受限路径保存 D1 export（包含 metadata、audit
  和加密 credential envelope）：

  ```bash
  npx wrangler d1 export DB --remote --env staging --output <secure-path>/openpool-staging-before-v1.sql --config apps/worker/wrangler.jsonc
  ```

### 前滚与发布

- [x] 已执行 `npm run verify` 并获准运行 `npm run db:migrate:staging`；目标为独立 staging D1，
  且只前滚
  0001→0002→0003，随后 migrations list 显示无待办（2026-09-01）。新库迁移前为空，无用户数据
  可备份。
- [x] 迁移成功后已检查 migration history、健康接口、D1 容量约束，并通过真实 R2 生命周期验证已有
  credential 可解密，再部署 Worker；staging 使用 `APP_ENV=staging`（2026-09-01）。production 创建时
  也必须显式覆盖 `APP_ENV`，不能使用 `development`。
- [x] 迁移确认完成后，运行根目录 `npm run deploy:staging` 构建 Web 并部署
  `openpool-staging`；该命令不会隐式迁移 D1，但不是 dry-run，必须视为有远端发布副作用的命令。
- [ ] 仅在明确需要把两个远端步骤合并且已再次确认账号、D1、备份和授权时，才使用
  `npm run deploy:staging:with-migrations`；该命令会先迁移 staging D1 再部署 staging Worker。
- [x] 部署后健康接口、静态控制台和初始 `initialized: false` 已验证；使用钥匙串中的高熵随机密码
  初始化 `admin` 后，登录、session、管理员 audit 查询、登出和撤销后 session 均通过远端检查。
  删除 bootstrap secret 后再次验证健康、`initialized: true`、登录和登出（2026-09-01）。
- [x] staging 的 R2 账号、逻辑 Bucket/ACTIVE shard、signed PUT/GET/DELETE 及浏览器 CORS smoke 已
  完成；live tail 抽样中的 Cookie/路径标识被标为 `REDACTED`，没有应用日志、异常、credential、token、
  signed URL 或响应正文。标准客户端网络/地理 metadata 仍要求受限访问和保留策略（2026-09-01）。
- [x] B2 真实联调完成：验证、ACTIVE shard、浏览器直传/直取、删除、Cron 过期清理和精确 CORS
  均取得 staging 证据；临时 CORS 管理 key 用后立即撤销（2026-09-01）。
- [ ] Generic S3 真实联调仍待完成。
- [x] 2026-09-04 发布认证限流/readiness preflight 与 Web i18n bundle 到 staging；health 为 200，
  错误登录在 Cloudflare 最终一致计数收敛后返回 429，完整窗口后恢复，已初始化实例没有
  `ADMIN_BOOTSTRAP_TOKEN_UNEXPECTED`，管理员 login/session/logout 通过。证据见
  [staging 认证限流与 readiness 验收](staging-auth-readiness-acceptance.md)。随后已在真实浏览器补齐
  登录页与已登录概览页的中英文切换、`document.documentElement.lang`、本地偏好和刷新恢复验收。
- [x] Wrangler `*/5 * * * *` Cron Trigger 已随 Worker 创建；live tail 捕获到 outcome `ok`、无
  exception/应用日志的 scheduled maintenance，随后确认容量为 0 且没有 PENDING/EXPIRED upload 或
  非终态 object（2026-09-01）。失败清理仍按设计留待下一次重试。

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
当前剩余外部事项是 Generic S3 资源及其 CORS、CI/CD token、production/自定义域名决策，以及
未来有价值数据的 schema 升级所需受保护备份位置和恢复负责人。2026-09-02 所有者明确要求本次
staging 升级跳过备份，但不视为对后续升级或数据恢复的永久授权。
