# Deferred 外部步骤

本文记录本地开发无法独立完成、必须由项目所有者提供账号权限、真实凭证或远端操作授权的步骤。
这些步骤不阻塞对应功能的本地实现、Fake 测试和离线集成测试。

## Cloudflare 平台

- [x] 使用 `wrangler login` 完成交互式 Cloudflare 登录，并通过 `wrangler whoami --json` 确认唯一
  可见的 Cloudflare account（2026-09-01；账号 ID 与登录邮箱不写入仓库）。
- [x] staging 使用当前 Cloudflare account 的独立 Worker、D1、Secrets 和 Provider 资源；production
  暂不创建，正式上线前再决定是否使用独立 account（2026-09-01）。
- [x] 在 APAC 创建独立的 `openpool-staging` D1，并绑定到 `env.staging`（2026-09-01；database ID
  只保存在 Wrangler 配置所需位置）。
- [x] 已为 staging 安全生成并配置独立的 `CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER` 和管理员
  bootstrap secret，并备份到 macOS 登录钥匙串；`CREDENTIAL_MASTER_KEY_ID` 固定为 `primary-v1`
  （2026-09-01）。`admin` 初始化后已从 Worker 删除一次性 bootstrap secret，远端只保留 master
  key 和 pepper；不要在 V1 期间更换已有 vault key。
- [x] 已获授权并执行 V1 `npm run db:migrate:staging`；0001→0003 均已应用（2026-09-01）。仓库目前
  没有 production migration 命令。
- [x] Phase 2 `0004_shard_migrations.sql` 与 `0005_transactional_audit_outbox.sql` 已经所有者明确授权，
  按顺序应用到独立 staging D1，相关 Worker/Web 已部署，migration history 无待办（2026-09-02）。
  所有者因数据不重要而明确要求本次跳过备份；本地持久化 D1 和 production 未改动，未来升级不能
  继承这次免备份例外。详细证据见[升级验收记录](staging-upgrade-acceptance.md)。
- [x] 上传重试 `0006_upload_retries.sql` 与配套 Worker/Web 已经所有者重新授权并发布到 staging
  （2026-09-02），迁移列表无待办。所有者再次明确要求本次不备份；未操作本地持久化 D1 或
  production，不继承为后续免备份授权。真实 R2/B2 证据见[上传重试验收](staging-upload-retry-acceptance.md)。
- [x] 已获授权并运行 `npm run deploy:staging`，独立 Worker 已发布到 staging `workers.dev`，健康
  接口、静态控制台、`admin` 初始化、登录/session/audit/logout 及 bootstrap 删除后的再次登录均
  验证通过（2026-09-01）。管理员密码只保存在 macOS 登录钥匙串。只有同时授权 staging migration
  和部署时才使用 `npm run deploy:staging:with-migrations`。
- [x] `*/5 * * * *` Cron Trigger 已随 staging Worker 创建，并通过 Wrangler live tail 捕获到至少
  一次 outcome `ok` 的 scheduled maintenance；该次无 exception、无应用日志，CPU 1 ms
  （2026-09-01）。
- [x] staging live tail 抽样中的 session Cookie 和路径标识被 Cloudflare 标为 `REDACTED`，Worker
  没有输出 credential、token、signed URL、异常或响应正文；tail 仍包含标准客户端网络/地理 metadata，
  其访问权限和保留策略必须继续受限（2026-09-01）。
- [ ] 在下一次包含已有数据的远端 schema 升级前，项目所有者指定仓库外、受限且持久的 D1 export
  保存位置，并确认 Time Travel/恢复负责人；恢复演练会改写数据，必须另行授权。
- [ ] 正式上线前决定 production 使用当前还是独立 Cloudflare account，创建独立 D1、Secrets 和
  Provider 资源，并决定是否绑定自定义域名；不得复用 staging database、credential 或 bucket。
- [ ] 如启用 CI/CD，创建最小权限 Cloudflare API token 并通过 CI secret 注入。

## Provider 真实联调

- [x] 已在当前 staging Cloudflare account 创建 APAC 的独立空 bucket `openpool-staging-smoke`，并配置
  只允许 staging `workers.dev` origin 的 `PUT`/`GET`/`HEAD`/`DELETE`、`Content-Type` 和 `ETag`
  CORS policy（2026-09-01）。
- [x] 已为 `openpool-staging-smoke` 创建只授权该 bucket 的 Object Read & Write S3 API credentials，
  并通过 OpenPool 完成账号验证、逻辑 Bucket/ACTIVE shard、签名 PUT、complete/HEAD、签名 GET 字节
  比对及 DELETE smoke；删除后账号与 shard 用量均回到 0，R2 bucket 为空，审计事件完整
  （2026-09-01）。credential 未经过仓库或聊天。
- [x] 已创建私有 B2 隔离 bucket `openpool-b2-staging-5dfebd7d02` 和 bucket-scoped Read & Write
  application key；使用 `us-east-005` 完成账号验证、逻辑 Bucket/ACTIVE shard、浏览器签名 PUT、
  complete、签名 GET 字节比对和 DELETE smoke，OpenPool 容量回到 0（2026-09-01）。B2 的
  `Keep all versions` 会在 S3 DELETE 后保留历史版本；本次 smoke 的遗留版本已按下方记录手工清理。
- [ ] 为 Generic S3 提供测试 endpoint、region、bucket、访问凭证和 path-style/TLS 等兼容性要求。
- [x] 已从 staging 控制台浏览器实际完成 R2 文件上传、下载和删除，确认 signed PUT/GET 与最小化
  CORS policy 生效（2026-09-01）。
- [x] B2 已写入只允许 staging `workers.dev` origin 的自定义 S3 CORS，覆盖 `PUT`/`GET`/`HEAD` 和
  `Content-Type`/`Authorization`/`Range`；真实 `OPTIONS` 预检、浏览器上传和下载通过。用于写 CORS
  的临时全账户 application key 已立即撤销（2026-09-01）。
- [ ] Generic S3 bucket 仍需配置并实测最小化 CORS：仅允许管理后台实际 origin 和直传/直取所需
  method/header，不开放不必要权限。否则 signed URL 会被浏览器拦截。
- [x] 经所有者授权，独立测试账号/shard 的 R2 ↔ B2 drain → migration 已完成：每方向 45 B 文本与
  64 KiB 二进制文件，CLI 流式传输、目标 HEAD、SHA-256 对比、primary 切换、源删除、容量计数和源
  shard retirement 均通过；一次中断任务在租约到期后由 CLI 成功恢复（2026-09-02）。
  正常 Cron/outbox 投递已取得远端证据；未对共享凭据注入源删除失败，相关故障恢复仍由本地测试覆盖。
- [x] 已在 Backblaze 浏览器中永久删除 B2 smoke 遗留的 52 B upload version、hide marker 和此前重试
  产生的隐藏版本；测试 bucket 已恢复为空（2026-09-02）。
- [x] 后续双向迁移 smoke 的 4 个 B2 物理 key、8 个 upload/hide versions（131,162 字节）已使用
  既有 bucket-scoped key 精确清理，并逐 key 验证没有残留；未扩大权限或改动其他版本（2026-09-02）。
- [x] `0006` 的 R2/B2 立即、过期及 ABORTED 后同路径重试均通过真实 API/Provider 验收，包含
  并发冲突、旧签名写入隔离、真实 grace/Cron 清理、容量和稳定审计。六个测试文件已删除，两个测试
  shard 已退休，B2 六个物理 key 的 13 个 upload/hide versions（67,788 字节）已永久清理；原有记录
  不变。该轮额外浏览器重试因扩展未连接跳过，见[上传重试验收](staging-upload-retry-acceptance.md)；
  随后已完成限定 R2 的[Web 恢复交互验收](staging-web-recovery-acceptance.md)，不将其扩大为 B2 全分支回归。

## 待项目所有者决定的产品与架构边界

- [ ] GitHub/static tier：决定其作为只读 source 还是 publish target、repo/ref/path 映射、版本/删除语义，
  以及是否允许进入普通写 placement；在此之前不能把 GitHub 伪装成 Generic S3。
- [ ] replication/repair：决定副本数、Provider/故障域分散、checksum 缺失行为、删除传播、容量计费、
  修复触发和限流；在此之前只保留现有 client-mediated shard migration，不启用自动复制/修复。
- [x] 通用对象 CLI 首版采用 workspace-private、API Key-only、无管理员登录/credential 持久化、无
  自动重试/覆盖的边界，复用现有 SDK；本地文件、模拟网络、真实 loopback HTTP 和 Node 子进程测试
  已覆盖，使用说明见[对象 CLI](../cli/objects.md)。
- [x] 通用对象 CLI 真实 R2/B2 小文件 smoke 已由所有者授权并完成（2026-09-03）：构建产物的上传、
  下载、哈希比对、分页、权限、防覆盖、幂等完成、客户端故障注入后的显式恢复及删除均通过。
  十个累计测试对象已 DELETED，八个 Key 已撤销，用量恢复到 0，B2 已有版本已精确清理；
  三个旧失败 session 已由 Cron 转为 ABORTED，54 条对象 outbox 全部 DELIVERED，后续 B2 hide marker
  也已精确清理；预检 session 的到期边界仍见[CLI 验收记录](staging-cli-acceptance.md)。没有部署或执行 migration。
- [x] 所有者指定的 50 MB（50,000,000 字节）R2/B2 CLI smoke 已通过（2026-09-03）：正常上传/下载
  哈希、部分传输 SIGINT、下载临时文件清理、显式 retry、幂等 complete/delete 和内存观察均完成。
  六个测试对象已 DELETED，两个临时 Key 已撤销，原有 26 个对象不变、用量恢复到 0；两个旧尝试已
  ABORTED，38 条对象 outbox 全部投递，七个 B2 历史版本已永久清理。证据见
  [50 MB 验收记录](staging-cli-50mb-acceptance.md)。提供[可重复脚本](cli-smoke.md)，
  不把本次授权扩展为之后自动执行远端写测试的授权。
- [x] 所有者授权 Web 上传恢复与账号纠错修复的 staging 部署及测试写入；2026-09-03 已发布
  `3ca24b95-40cc-4753-842a-fbd4344828e8`，未执行 migration，静态资源哈希与本地构建一致。
  本地覆盖见[上传恢复](web-upload-recovery.md)与[账号纠错](web-account-recovery.md)。
- [x] 完成此次[Web staging 交互验收](staging-web-recovery-acceptance.md)及测试数据清理（2026-09-03）。
  所有者开启 Kimi 文件访问并在一次性账号表单填写有效 R2 凭据；验证失败纠错、并发配置重载、
  换文件重试、confirmation-only、重复提交保护与 72 B 下载哈希通过。唯一对象已 DELETED，旧 session
  已由 Cron 清理为 ABORTED，容量归零，无 shard 测试账号已 REMOVED；原 ACTIVE 账号配置不变。
- [x] 所有者确认已删除上述验收的专用 R2 API Token（2026-09-03，所有者回报，未再次登录
  Cloudflare 独立核对）。OpenPool REMOVED 状态本身不等于撤销 Cloudflare 凭据。
- [ ] [Web 新增账号表单加固](web-account-creation.md)的 staging 发布与真实交互验收需后续单独授权；
  不包含在较早的 Web 恢复验收中，不复用该轮部署和测试写入授权。
- [ ] [Web API Key 创建交互加固](web-api-key-creation.md)的 staging 发布与真实 Key/剪贴板权限验收
  需后续单独授权；目前仅本地实现与页面回归，不创建或撤销真实 Key。
- [ ] 后续 schema 升级前解决 Wrangler 的 D1 query 授权：2026-09-03 只读 migration history 查询
  返回 Cloudflare `7403`；D1 info、现有应用 API 与 Web-only 发布正常，本轮未绕过该限制或执行 migration。
- [ ] SDK/CLI 后续：公开包名和版本承诺、Node 管理员 Cookie 策略、自动重试及 migration 最小权限
  授权仍待决定。通用对象 CLI 超过 50 MB 的文件、物理断网、并发及压力/长时间验收需另行确认范围；不自动
  复用此前 staging 测试或部署授权。
- [ ] limited S3 gateway：必须继续遵守对象字节不经过 Worker 的 ADR；需决定支持的 metadata、
  presigned redirect、鉴权、Range/multipart 和兼容范围后才能实现。
- [ ] multi-user/quota/RBAC：决定 tenant 层级、默认 owner 迁移、角色/共享、API Key 继承以及 hard/soft
  quota 与 replica 计费，再新增 schema 和授权模型。

所有 secret 都只能通过本地忽略文件、交互式命令、Cloudflare Secret 或外部 secret manager 注入，不能写入
仓库、测试快照、日志或聊天记录。
