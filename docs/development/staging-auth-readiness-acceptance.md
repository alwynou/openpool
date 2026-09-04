# Staging 认证限流与 readiness 验收

2026-09-04 经项目所有者继续授权，将本地提交 `7bb7acc` 发布到既有
`openpool-staging` Worker。此次只发布 Worker/Web，没有 D1 schema 变化、没有执行 migration，也没有
修改 Provider 资源或对象数据。Cloudflare deployment version 为
`19047e24-bfb4-48d5-b7bf-6cba3ec11d14`。

## 发布前核对

- 本地 `dev` worktree 只包含已通过 `npm run verify` 的提交；Oxlint、全部 workspace typecheck、
  726 项测试和四个构建通过。
- Wrangler OAuth 有效且只有一个可见 account；目标仍为独立 `openpool-staging` D1。
- staging Secret list 只有 `CREDENTIAL_MASTER_KEY` 与 `API_KEY_PEPPER`；一次性
  `ADMIN_BOOTSTRAP_TOKEN` 已删除。只核对名称，没有读取或输出 Secret 值。
- 使用 `npm run deploy:staging` 发布；没有调用 `db:migrate:staging` 或组合 migration 命令。

## Readiness 与静态资源

- 新版本绑定既有 D1、`AUTH_GLOBAL_RATE_LIMITER`（30/60 秒）、
  `AUTH_IDENTITY_RATE_LIMITER`（5/60 秒）、Static Assets 和稳定的 `primary-v1` key ID。
- `GET /api/v1/health` 返回 `200`、`status: ok`、`environment: staging`，证明 D1 可读、两个关键
  Secret 的实际格式/独立性、key ID、限流 bindings 和 bootstrap 生命周期均通过 runtime preflight。
- `GET /api/v1/setup/status` 返回 `initialized: true`；没有
  `ADMIN_BOOTSTRAP_TOKEN_UNEXPECTED`。
- Worker 根路径返回新版 SPA，入口资源为 `index-CUZ9e9tE.js`；本地 Web 88 项测试已覆盖英文/简体中文
  切换、浏览器语言检测、持久化和文案。Kimi WebBridge daemon 启动后仍未监听本地端口，因此本轮未把
  “线上真实浏览器切换语言”误记为完成，也没有创建浏览器测试 tab。

## 真实认证限流

使用专用的不存在用户名和无效密码请求 `POST /api/v1/auth/login`，未使用真实管理员密码。Cloudflare
Rate Limit binding 是 permissive、eventually consistent 的 per-location 计数器，因此没有把第 6 次
请求作为精确断言：在同一 HKG location 的有界请求中，前序请求统一返回
`401 INVALID_CREDENTIALS`，计数收敛后观察到 `429 RATE_LIMITED` 和 `Retry-After: 60`。等待完整窗口
62 秒后，同一身份恢复为 `401 INVALID_CREDENTIALS`。这证明限流与恢复路径真实生效，同时保留了
Cloudflare 官方精度边界。

随后通过 macOS 钥匙串的 stdin 管道完成一次真实管理员 smoke；密码与 Cookie 均未出现在命令参数、
输出或日志中：login 返回 200 并签发 Cookie，session 返回 `authenticated: true`，logout 返回 204
并清除 Cookie，旧 Cookie 再查询返回 `authenticated: false`。最后一次 health 仍为 200。

## 结论与剩余边界

staging 的关键 Secret readiness、bootstrap 删除约束、认证 bindings、429/恢复窗口以及既有管理员
session 流程通过。此次无 migration、无 Provider credential 变更、无对象写入或测试对象需要清理。
Web i18n bundle 已发布且本地交互测试通过；线上真实浏览器切换仍待 WebBridge 恢复后补一项交互证据。
此前 Wrangler D1 migration-history 查询的 `7403` 权限问题与本次无 schema 发布无关，仍需在未来
schema 升级前解决。
