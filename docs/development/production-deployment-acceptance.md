# Production 首次部署验收

日期：2026-09-07  
目标：`openpool-production`  
入口：`https://openpool-production.alwynou2806.workers.dev`

## 范围

本次在已确认的 Cloudflare account 中建立与 staging 隔离的 production 控制面。部署应用版本为
`0.1.0`；production 配置由 [PR #8](https://github.com/alwynou/openpool/pull/8) 合入受保护的
`main`，合并提交为 `1bb4e0c`。该 PR 的必需 `CI / Verify` 成功，覆盖 Oxlint、类型检查、
726 项测试、全部构建和 production Worker dry-run。

没有复用或修改 staging D1、Secret、限流 namespace、Provider credential 或 bucket。本次不创建
production Provider 账号、logical bucket、shard 或测试对象，也不把控制面验收扩大为 R2/B2
production 文件传输验收。

## D1 与 migration

- 在 APAC 创建独立 `openpool-production` D1，并绑定到 `env.production`。
- migration 前数据库为 0 张表、12,288 B、24 小时读写计数均为 0；全新空库首次安装不导出备份。
- Wrangler 按顺序成功应用 `0001_initial.sql` 至 `0006_upload_retries.sql`。
- 发布后再次执行 remote migration list，结果为 `No migrations to apply`。
- 初始化管理员后 production 已包含有价值状态；后续 schema 前滚必须按 runbook 先决定受保护
  export 位置，不能继承首次空库的免备份例外。

## Secret 与初始化

- 独立生成 `CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER`、一次性
  `ADMIN_BOOTSTRAP_TOKEN` 和管理员密码；明文未写入仓库、终端输出或 CI。
- 四项值备份在 macOS 登录钥匙串的 production 专用 service；三项 Worker Secret 通过内存管道随
  首个 version 上传，没有生成落盘 Secret 文件。
- 首次 health 为 200、`status=ok`、`environment=production`、`version=0.1.0`，setup status
  为 `initialized=false`；首页返回 HTML 200。
- 使用一次性 token 成功初始化 `admin`（HTTP 201），随后永久删除 Worker 的
  `ADMIN_BOOTSTRAP_TOKEN`。最终远端 secret list 只包含 `CREDENTIAL_MASTER_KEY` 与
  `API_KEY_PEPPER`。
- 删除 bootstrap Secret 后 health 仍为 200，setup status 为 `initialized=true`；真实
  login 返回 200，session 为 authenticated，logout 返回 204，旧 Cookie 再查询为 unauthenticated。

## Worker 与剩余边界

- 首次 Worker version 为 `cf43ab77-898b-492d-abf5-c40078b65b12`；删除 bootstrap Secret 后的
  当前活动 version 为 `314e37ce-7b76-46d5-9335-3016a929cc14`，流量比例为 100%。
- Wrangler 发布结果确认 `*/5 * * * *` Cron Trigger 已绑定；本次没有等待并采集真实 scheduled
  event，Cron 行为仍由 staging 真实证据与本地测试覆盖。
- production Provider 资源、最小 CORS、真实 R2/B2 signed transfer smoke、自定义域名、自动部署
  token/environment protection 和恢复演练均不在本次范围，继续作为显式后续步骤。

## 清理结果

验收登录 session 已撤销；没有创建 Provider 或对象数据。一次性 bootstrap Secret 已从 Worker
删除，钥匙串灾备副本仅用于重建全新实例，不得重新上传到当前已初始化实例。
