# Cloudflare 部署

OpenPool 由一个 Worker 同时提供 API 和构建后的 SPA，D1 保存 metadata，Secret 保存加密密钥。
本地默认 binding 保留占位数据库 ID；staging 与 production 分别使用 `env.staging` 和
`env.production`，绑定独立 Worker、D1、Secret 与认证限流 namespace，不能跨环境复用。
本页命令是可执行的发布 runbook。2026-09-01 已完成 Wrangler OAuth 登录、账号核对、APAC staging
D1 创建、0001→0003 migration、首次部署所需的三个 staging Secrets 和 `workers.dev` 部署；健康接口、
静态控制台、`admin` 初始化及登录/session/audit/logout 已通过远端检查。初始化后已从 Worker 删除一次性
`ADMIN_BOOTSTRAP_TOKEN`，当前只保留 `CREDENTIAL_MASTER_KEY` 和 `API_KEY_PEPPER`。同日通过 live
tail 捕获到 `*/5 * * * *` scheduled event，outcome 为 `ok`，无 exception 或应用日志。

2026-09-02 经项目所有者明确授权，staging 已前滚应用 `0004`、`0005` 并部署 shard migration、事务
审计 outbox 与 SDK 复用版本。所有者因测试数据不重要而明确要求本次跳过备份；这不改变后续有价值
数据升级前的备份要求。此次升级、测试及恢复边界见[staging 升级验收记录](../development/staging-upgrade-acceptance.md)。

同日经所有者重新授权并明确要求本次不备份，已先应用 `0006_upload_retries.sql`，再发布上传重试
Worker/Web，version 为 `a512e61f-7c6f-4b33-a0f2-16ce86c3977a`。真实 R2/B2 测试记录见
[上传重试验收](../development/staging-upload-retry-acceptance.md)。产生多次尝试的记录后，旧 Worker 的单 session 假设
不再成立，应前滚修复，不能直接回滚到旧版。重试和独立清理语义见
[ADR 0005](../architecture/decisions/0005-upload-attempt-retries.md)。

2026-09-03 经所有者授权，Web 上传恢复及账号纠错修复已部署为
`3ca24b95-40cc-4753-842a-fbd4344828e8`，未修改 Worker 逻辑或 schema，未执行 migration。
发布核对、R2 真实恢复交互与清理证据见[Web staging 验收](../development/staging-web-recovery-acceptance.md)。
此次 Wrangler 只读 migration history 查询返回 D1 `7403` 授权错误；未来涉及 schema 的升级必须
先解决该权限并重新核对历史，不应将本次 Web-only 发布当作 migration 权限验收。

同日 17:12（Asia/Shanghai）经所有者重新授权，账号创建与 API Key 表单加固发布为
`9431a58b-ef8f-492d-9308-05e1e7e8d5ad`，仍未改变 Worker 逻辑/schema 或执行 migration。
真实临时 Key 创建/复制/撤销、账号表单的客户端模拟与清理范围见
[Web 创建验收](../development/staging-web-creation-acceptance.md)。

2026-09-04 经所有者继续授权，认证限流、关键 Secret/runtime readiness preflight 与 Web i18n bundle
发布为 `19047e24-bfb4-48d5-b7bf-6cba3ec11d14`。没有 schema 变化或 migration；health、bootstrap
删除约束、真实最终一致 429/窗口恢复及管理员 session 通过，见
[认证限流与 readiness 验收](../development/staging-auth-readiness-acceptance.md)。同日补齐 staging
真实浏览器 i18n 验收：登录页和已登录概览页中英文切换、`document.documentElement.lang`、本地偏好
及刷新恢复均通过，没有修改 Provider 或对象数据。

2026-09-07 经所有者明确授权并要求不备份，staging 已前滚应用 `0007_public_access.sql`，随后发布
稳定公开链接 Worker/Web。真实 B2 首测发现合法 60 秒签名因调用前时钟校验被误判为 503；修复经
[PR #15](https://github.com/alwynou/openpool/pull/15) 的完整 CI 合并后重新发布，当前验收 version 为
`2dbbf053-b02b-460f-91dd-19dcc4a4c7ad`。R2/B2 公开、到期、Bucket 继承、对象覆盖、60 秒撤销窗口、
无读取审计写放大和清理均已验证，见
[staging 公开对象访问验收](../development/staging-public-access-acceptance.md)。

2026-09-07 已在当前账号 APAC 创建独立 `openpool-production` D1，并把其 UUID 绑定到
`env.production`；生产 Worker 名称为 `openpool-production`，首次 migration、Secret、部署与
bootstrap 必须按下文顺序执行。production 不复用 staging 数据、Secret、限流 namespace 或
Provider bucket。

同日经所有者授权完成首次 production 前滚与部署：`0001`→`0006` 无待办，Worker/Web、
bootstrap 删除前后 readiness 与管理员 session 均通过；当前活动 version 与未覆盖边界见
[production 首次部署验收](../development/production-deployment-acceptance.md)。

同日通过受保护 `main` 的 [PR #10](https://github.com/alwynou/openpool/pull/10) 声明 production
自定义域名，发布后的活动 Worker version 为 `c06a8647-32db-429a-a64b-0c7d194ded30`。规范入口
`https://openpool.alwynou.com` 与 `workers.dev` 回退入口 health 均为 production 200。随后配置独立
R2/B2 bucket、bucket-scoped credential 和最小 CORS，并从规范入口完成真实浏览器直传、签名下载
哈希比对和删除；完整范围与清理证据见
[production Provider 验收](../development/production-provider-acceptance.md)。
所有者随后决定 R2 与 B2 分别使用，正式逻辑命名空间为 `r2-storage` 与 `b2-storage`，各自映射到
对应 production Provider 的 ACTIVE shard；两者不构成主备、复制或自动故障切换关系。物理 smoke
对象清理完成后，所有者另行授权精确删除两个 production smoke 逻辑命名空间及关联 D1 metadata；
正式命名空间、Storage Account 和 Provider bucket 均保留。

同日所有者明确要求 production 本次不备份并直接继续，已先应用 `0007_public_access.sql`，再从
受保护 `main` 部署公开链接 Worker/Web，活动 version 为
`0404cc4d-ebf0-45c4-90fe-efb38afdb005`。规范域名与回退入口 health 均为 200；真实 R2/B2 公开、
到期、Bucket 继承、对象覆盖、60 秒撤销窗口、无读取审计写放大和隔离清理均通过。已有 R2 图片保持
私有且未改策略，完整证据见
[production 公开对象访问验收](../development/production-public-access-acceptance.md)。

Worker 的 `*/5 * * * *` cron 扫描超过签名 expiry 5 分钟 grace 的 direct-upload session、恢复已切换
shard migration 的源清理，并投递审计 outbox。上传清理会原子释放预留、保留 `PENDING` object
tombstone，并重试 Provider 残留清理；成功后 upload session 变为 `ABORTED`，Provider 失败则保留
`EXPIRED` 等下一轮。审计事件以短 lease claim、稳定 event id 幂等写入 `audit_logs`，失败指数退避。
Cron 不是自动 migration、replication 或 gateway。

## 首次配置

```bash
npx wrangler login
npx wrangler d1 create openpool-staging --location apac
```

`wrangler login`、Cloudflare account 选择和 D1 location/jurisdiction 都需要项目所有者参与。staging
使用独立 `openpool-staging` D1 和 `env.staging`；不要把本地占位 UUID 或 staging UUID 部署到
production。然后为 staging Worker 配置三个独立 Secrets：

```bash
openssl rand -base64 32 # CREDENTIAL_MASTER_KEY；把输出交给下一条交互命令
npx wrangler secret put CREDENTIAL_MASTER_KEY --env staging --config apps/worker/wrangler.jsonc
openssl rand -base64 32 # API_KEY_PEPPER；必须与 master key 分开生成
npx wrangler secret put API_KEY_PEPPER --env staging --config apps/worker/wrangler.jsonc
openssl rand -base64 32 # ADMIN_BOOTSTRAP_TOKEN
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env staging --config apps/worker/wrangler.jsonc
```

上述 `openssl` 输出不可作为命令参数复制进 shell history；应在交互提示中粘贴，或由外部 secret
manager 注入。`CREDENTIAL_MASTER_KEY` 和 `API_KEY_PEPPER` 必须是各自独立、恰好 32 字节的
canonical base64；`ADMIN_BOOTSTRAP_TOKEN` 也必须是高熵随机值。`CREDENTIAL_MASTER_KEY_ID` 不是
Secret，V1 默认值是 `primary-v1`；部署配置若显式设置它，首次写入后必须保持不变。
staging 的三项 Secret 还应备份在受保护的密码管理器或操作系统钥匙串中，因为 Cloudflare 不提供
Secret 明文回读；不得使用 staging 值创建 production 环境。
当前 staging Secret 备份保存在 macOS 登录钥匙串，account 为 `openpool-staging`，service 分别为
`OpenPool Staging CREDENTIAL_MASTER_KEY`、`OpenPool Staging API_KEY_PEPPER` 和
`OpenPool Staging ADMIN_BOOTSTRAP_TOKEN`。最后一项仅作为重建全新 staging 实例时的灾备记录，当前
Worker 已不再持有它。`admin` 的高熵随机密码另存于 account `admin`、service
`OpenPool Staging Administrator Password`；需要人工登录时可直接送入剪贴板，避免显示在终端：

```bash
security find-generic-password -a admin \
  -s "OpenPool Staging Administrator Password" -w | pbcopy
```

production 使用完全独立的值，钥匙串 account 为 `openpool-production`，service 分别为
`OpenPool Production CREDENTIAL_MASTER_KEY`、`OpenPool Production API_KEY_PEPPER` 与
`OpenPool Production ADMIN_BOOTSTRAP_TOKEN`；管理员密码使用 account `admin`、service
`OpenPool Production Administrator Password`。首次部署可以通过仓库外、权限受限的临时
`--secrets-file` 将三项 Secret 与 Worker version 原子上传，成功后必须立即删除临时文件；不得把
Secret 文件写入仓库或 CI artifact。

初始化成功后必须删除 Worker 的 `ADMIN_BOOTSTRAP_TOKEN` 以缩小暴露面；可用
`wrangler secret list --env staging` 确认它已不存在。系统已经初始化时不再接受 bootstrap 请求。
只有重建一个全新的 D1/实例并重新执行初始化时，才需要为该实例生成新的 token。

## 认证限流与 readiness preflight

`wrangler.jsonc` 为 staging 和 production 分别显式声明 `AUTH_GLOBAL_RATE_LIMITER` 和
`AUTH_IDENTITY_RATE_LIMITER`，因为 Rate Limit bindings 不会自动继承到 named environment。前者对
setup/login 各限制为每 Cloudflare location 30 次/分钟，后者对每个规范化用户名指纹限制为
5 次/分钟。两个环境使用不同 namespace ID，避免共享计数器。计数键不含密码、bootstrap token 或
原始用户名。

Cloudflare 不允许回读 Secret 明文，因此 `wrangler secret list` 只能核对名称，不能证明长度、编码或
两项 Secret 是否复用。Worker 在处理请求时执行权威 readiness preflight：

- `CREDENTIAL_MASTER_KEY` 与 `API_KEY_PEPPER` 必须分别为 canonical base64 的 32 字节值且不能相同；
- `CREDENTIAL_MASTER_KEY_ID` 必须是安全、稳定的 ID；
- 两个认证限流 binding 必须存在；
- D1 必须可读；新实例必须配置合法 bootstrap token，已初始化的非 development 实例必须删除它。

任一检查失败时 `/api/v1/health` 返回 `503 DEPLOYMENT_NOT_READY`，`issues` 只包含稳定状态码，不回显
值。静态关键配置失败时其他 API 也返回 503；scheduled maintenance 同样 fail closed。发布后必须先
检查这个接口，再进行登录、Provider 或对象 smoke：

```bash
curl --fail-with-body https://openpool-staging.alwynou2806.workers.dev/api/v1/health
```

初始化新实例后，删除 bootstrap Secret 并再次确认 health 恢复 `200`。部署新版本前可先用
`wrangler secret list` 与配置 diff 核对名称和 bindings，但只有部署后的 runtime preflight 能验证
Cloudflare 保存的 Secret 实际格式。

## 迁移与部署

### 迁移顺序与备份

迁移必须按 Wrangler 的 migration history 由旧到新应用，顺序固定为：

1. `0001_initial.sql`：基础管理员、session、Storage Account、logical bucket、objects、locations、
   upload session、API key 和 audit log schema；
2. `0002_storage_account_metadata.sql`：Storage Account capabilities 与 `capacity_accuracy`；
3. `0003_object_capacity_reservations.sql`：每对象一个 upload session 的约束、D1 断言 guard 和
   reservation/expiry/deletion capacity triggers；
4. `0004_shard_migrations.sql`：持久化迁移任务、对象租约与目标容量预留；
5. `0005_transactional_audit_outbox.sql`：同事务审计 outbox、幂等投递与重试。
6. `0006_upload_retries.sql`：每对象一个 current session、历史上传 location 绑定与重试约束。
7. `0007_public_access.sql`：Bucket 公开默认值、对象公开覆盖策略及到期约束。

不要单独跳过或手工重排迁移，也不要编辑已经在共享/远端环境执行过的 SQL。迁移前由所有者确认账号、
D1 database ID、当前版本和维护窗口，保存受保护的 D1 export（导出含 schema、metadata、audit 和
加密 credential envelope）：

```bash
npx wrangler whoami --json
npx wrangler d1 info DB --env staging --config apps/worker/wrangler.jsonc
npx wrangler d1 migrations list DB --remote --env staging --config apps/worker/wrangler.jsonc
npx wrangler d1 export DB --remote --env staging --output <secure-path>/openpool-staging-before-upgrade.sql --config apps/worker/wrangler.jsonc
```

`production` 使用相同核对顺序，但目标必须明确为 `env.production` 和
`openpool-production`：

```bash
npx wrangler d1 info DB --env production --config apps/worker/wrangler.jsonc
npx wrangler d1 migrations list DB --remote --env production --config apps/worker/wrangler.jsonc
npx wrangler d1 export DB --remote --env production --output <secure-path>/openpool-production-before-upgrade.sql --config apps/worker/wrangler.jsonc
```

全新空 production 数据库首次安装不需要导出空库；一旦写入管理员或业务数据，后续 migration 不得
沿用这个例外。

`<secure-path>` 必须是仓库外、访问受限且有保留策略的位置；不要把导出文件提交或粘贴到聊天。需要
升级 migration history 时，先逐项核对将执行的文件，再明确授权：

```bash
npm install
npm run verify
npm run db:migrate:staging
```

production migration 使用独立命令，不能把环境名省略或退回默认占位 binding：

```bash
npm run db:migrate:production
```

迁移命令只应用尚未应用的 migration；若任一 migration 失败，按 Wrangler 语义该次迁移会回滚，
之前成功的 migration 保持不变。远端迁移和部署是独立的破坏面：先确认目标 Cloudflare 账号和 D1
数据库，再进行 Worker 部署。生产 `APP_ENV` 应使用 Wrangler environment 或 CI 配置覆盖，不能保留
`development`。

`0007` 是配套 Worker 的前置条件：新 Worker 的对象与 Bucket 查询会读取新增列，所以必须先迁移
目标 D1，再部署 Worker/Web。迁移本身使用私有默认值，不会把既有对象意外公开；旧 Worker 会忽略
新增列，因此需要回滚应用版本时无需回滚 schema。`0007` 已经所有者分别授权应用到 staging 与
production，并在两套环境通过真实 R2/B2 验收；两次免备份决定均只记录各自已完成的操作，不构成
未来 migration 的持续授权。

### 发布命令

仓库根目录的 `npm run deploy:staging` 和 `npm run deploy:production` 都先构建 Web，再部署对应
Worker，不会隐式修改 D1。两者都不是 dry-run，只有在完成登录、账号/D1/Secrets 核对并得到明确
授权后才能执行。migration 始终使用独立的 `db:migrate:staging` 或 `db:migrate:production`，
以便先完成备份和 migration history 核对。production deploy 使用 Wrangler strict mode，远端配置
发生冲突时拒绝覆盖。

GitHub Actions 的 `CI` 工作流只运行 `npm ci` 和 `npm run verify`，权限限定为 `contents: read`；它不
持有 Cloudflare Secret，不调用本节中的 migration 或 deploy 命令。未来若增加自动部署，必须使用独立
最小权限 token、environment protection 和明确的 production 配置，不能把验证 job 隐式升级为发布 job。

`npm run deploy:staging:with-migrations` 与 `npm run deploy:production:with-migrations` 是明确
选择“先 migration、再部署”的便利命令，同时具有两类远端副作用；只允许在首次安装或升级维护窗口
中，经项目所有者确认目标账号、D1、备份和授权后使用。普通 `npm run build` 会同时 dry-run 默认
Worker 与 production 配置，不访问远端。

仓库已经公开，但尚未提供 Cloudflare Deploy Button，也不应声称“一键部署”可用。按
[Cloudflare Deploy Buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) 接入前，
仍需明确 monorepo Worker 目录、production D1 自动创建/绑定、Secrets 输入和首次 migration 流程；
按钮不能复用 staging 资源，也不会替代真实 Provider smoke 或人工安全核对。

## 自定义域名

首个部署成功后，在 Cloudflare Dashboard 的 Worker Routes/Custom Domains 为 Worker 绑定例如
`oss.example.com`。API 与后台共用该域名，`/api/*` 和 `/public/*` 必须先进入 Worker，其余路径优先
由 Static Assets 处理并支持 SPA fallback。若 `/public/*` 未配置 `run_worker_first`，不存在的静态资源
可能被 SPA fallback 吞掉，公开链接将无法签名或返回正确的 404。

当前 production 的规范入口为 `https://openpool.alwynou.com`，通过 `env.production.routes` 的
`custom_domain` 声明绑定；`workers_dev` 保持启用，使
`https://openpool-production.alwynou2806.workers.dev` 可作为回退和运维入口。Provider bucket 的
CORS 必须同时允许规范入口与仍支持直接访问的 `workers.dev` 入口，不能用通配 origin，也不能把
staging origin 加入 production bucket。

## 回滚与前滚

- Worker 代码使用 Cloudflare deployment versions 回滚；回滚前确认它仍能读取当前 D1 schema 和
  已有 credential envelope。
- D1 migration 默认只前进，不能用回滚 SQL 或改写旧文件“降级”。已应用的 schema 修复必须新增
  补偿 migration；应用版本应先与 schema 兼容，再前滚部署。
- 如果确实需要恢复数据，先停止写入并由所有者批准。优先使用受保护 export 或 D1 Time Travel
  的明确 bookmark/timestamp；这是可能丢失恢复点之后数据的破坏性操作：

  ```bash
  npx wrangler d1 time-travel restore openpool --timestamp <RFC3339-or-unix-seconds> --config apps/worker/wrangler.jsonc
  ```

- Provider credential rotation 与代码回滚分开操作；V1 只允许尚未激活的 `VERIFYING` 账号纠正
  credential，没有 `ACTIVE` 账号 rotation 或批量 credential re-encryption workflow，不得仅为回滚
  更改 `CREDENTIAL_MASTER_KEY` 或 `CREDENTIAL_MASTER_KEY_ID`。
- 任何回滚都不得让已签发上传写入一个 D1 不再认识的位置。恢复后重新检查 migration history、
  health、账号状态、容量计数和签名 URL，再恢复流量。

参考 Cloudflare 官方文档：[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、
[Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、
[D1 本地开发](https://developers.cloudflare.com/d1/best-practices/local-development/)、
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)、
[Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)。
