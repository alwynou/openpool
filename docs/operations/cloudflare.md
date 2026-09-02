# Cloudflare 部署

OpenPool 由一个 Worker 同时提供 API 和构建后的 SPA，D1 保存 metadata，Secret 保存加密密钥。
本地默认 binding 保留占位数据库 ID；已创建的 staging D1 只配置在 `env.staging`。production 尚未
创建，正式部署前必须新增独立 production environment 和数据库，不能复用 staging ID。
本页命令是可执行的发布 runbook。2026-09-01 已完成 Wrangler OAuth 登录、账号核对、APAC staging
D1 创建、0001→0003 migration、首次部署所需的三个 staging Secrets 和 `workers.dev` 部署；健康接口、
静态控制台、`admin` 初始化及登录/session/audit/logout 已通过远端检查。初始化后已从 Worker 删除一次性
`ADMIN_BOOTSTRAP_TOKEN`，当前只保留 `CREDENTIAL_MASTER_KEY` 和 `API_KEY_PEPPER`。同日通过 live
tail 捕获到 `*/5 * * * *` scheduled event，outcome 为 `ok`，无 exception 或应用日志。

2026-09-02 经项目所有者明确授权，staging 已前滚应用 `0004`、`0005` 并部署 shard migration、事务
审计 outbox 与 SDK 复用版本。所有者因测试数据不重要而明确要求本次跳过备份；这不改变后续有价值
数据升级前的备份要求。此次升级、测试及恢复边界见[staging 升级验收记录](../development/staging-upgrade-acceptance.md)。

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

初始化成功后必须删除 Worker 的 `ADMIN_BOOTSTRAP_TOKEN` 以缩小暴露面；可用
`wrangler secret list --env staging` 确认它已不存在。系统已经初始化时不再接受 bootstrap 请求。
只有重建一个全新的 D1/实例并重新执行初始化时，才需要为该实例生成新的 token。

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

不要单独跳过或手工重排迁移，也不要编辑已经在共享/远端环境执行过的 SQL。迁移前由所有者确认账号、
D1 database ID、当前版本和维护窗口，保存受保护的 D1 export（导出含 schema、metadata、audit 和
加密 credential envelope）：

```bash
npx wrangler whoami --json
npx wrangler d1 info DB --env staging --config apps/worker/wrangler.jsonc
npx wrangler d1 migrations list DB --remote --env staging --config apps/worker/wrangler.jsonc
npx wrangler d1 export DB --remote --env staging --output <secure-path>/openpool-staging-before-upgrade.sql --config apps/worker/wrangler.jsonc
```

`<secure-path>` 必须是仓库外、访问受限且有保留策略的位置；不要把导出文件提交或粘贴到聊天。需要
升级 migration history 时，先逐项核对将执行的文件，再明确授权：

```bash
npm install
npm run verify
npm run db:migrate:staging
```

迁移命令只应用尚未应用的 migration；若任一 migration 失败，按 Wrangler 语义该次迁移会回滚，
之前成功的 migration 保持不变。远端迁移和部署是独立的破坏面：先确认目标 Cloudflare 账号和 D1
数据库，再进行 Worker 部署。生产 `APP_ENV` 应使用 Wrangler environment 或 CI 配置覆盖，不能保留
`development`。

### 发布命令

仓库根目录的 `npm run deploy:staging` 只构建 Web 并部署 `openpool-staging` Worker，不会隐式修改
D1。它不是 dry-run，仍有远端发布副作用；只有在完成登录、账号/D1/Secrets 核对并得到明确授权后
才能执行。staging migration 始终使用独立的 `npm run db:migrate:staging`，以便先完成备份和
migration history 核对。仓库目前不提供 production migration/deploy 命令。

`npm run deploy:staging:with-migrations` 是明确选择“先 staging migration、再部署”的便利命令，
同时具有两类远端副作用；只允许在首次安装或升级维护窗口中，经项目所有者确认目标账号、D1、备份
和授权后使用。只构建或只发布 staging Worker 时，分别使用 `npm run build` 或
`npm run deploy:staging --workspace=@openpool/worker`。

当前仓库没有可用于 Cloudflare Deploy Button 的公开 git remote URL，因此按钮尚未发布，也不应在
这里声称“一键按钮”可用。未来若发布公开仓库，可按
[Cloudflare Deploy Buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) 添加
按钮；该能力对 monorepo/非根目录 Worker 有额外限制，仍需把 Worker 目录、配置、D1 和 Secrets
输入方式明确化，按钮不会替代真实 Provider smoke 或人工安全核对。

## 自定义域名

首个部署成功后，在 Cloudflare Dashboard 的 Worker Routes/Custom Domains 为 Worker 绑定例如
`oss.example.com`。API 与后台共用该域名，`/api/*` 先进入 Worker，其余路径优先由 Static Assets
处理并支持 SPA fallback。

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
[D1 本地开发](https://developers.cloudflare.com/d1/best-practices/local-development/)、
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)、
[Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)。
