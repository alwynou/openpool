# 认证 API

所有响应都包含 `requestId`。认证响应使用 `Cache-Control: no-store`，管理员密码、密码哈希与原始
session token 不出现在 JSON 响应或 D1 中。

## 首次初始化

`GET /api/v1/setup/status` 返回 `{ "initialized": boolean }`。

`POST /api/v1/setup` 只允许成功一次。请求体为：

```json
{
  "username": "administrator",
  "password": "a password with at least 12 characters"
}
```

请求必须携带 `x-openpool-bootstrap-token`，其值与 Worker Secret `ADMIN_BOOTSTRAP_TOKEN` 相同。
用户名去除首尾空白后需为 3–64 个字符，密码需为 12–256 个字符。成功返回 `201`；token 无效
返回 `403 INVALID_BOOTSTRAP_TOKEN`，已经初始化返回 `409 ALREADY_INITIALIZED`，输入不合规返回
`400 VALIDATION_ERROR`。初始化和登录在执行凭证校验前都会经过认证限流；超过限制返回
`429 RATE_LIMITED` 和 `Retry-After: 60`，限流 binding 不可用时返回
`503 SERVICE_UNAVAILABLE`，不会退化为无限制认证。

## 登录与 session

`POST /api/v1/auth/login` 接收 `username` 和 `password`，成功后返回管理员公开信息与过期时间，
并设置 `openpool_session` Cookie。用户名不存在与密码错误统一返回
`401 INVALID_CREDENTIALS`。

`GET /api/v1/auth/session` 返回当前登录状态。Cookie 缺失、无效或过期时返回
`authenticated: false`，不会暴露具体失败原因。

`DELETE /api/v1/auth/session` 撤销服务端 session 并清除 Cookie；重复调用仍返回 `204`。

浏览器控制台使用同源 Cookie，不把 session token 放入 JavaScript 可访问的存储。

## 认证限流

Worker 使用两个 Cloudflare Rate Limit bindings：每个 Cloudflare location、每个认证入口最多
30 次/分钟；规范化用户名对应的身份指纹最多 5 次/分钟。身份键是入口类型与去除首尾空白后的用户名
所生成的 SHA-256 指纹，不包含原始用户名、密码或 bootstrap token。全局入口上限避免攻击者通过轮换
用户名绕过昂贵的 PBKDF2 保护；身份上限限制针对单一管理员的持续猜测。

限流计数是短时保护，不会在 D1 中创建永久锁定状态，也不影响 session/API Key 请求、对象控制 API
或 Provider 直传。Cloudflare 原生计数按 location 生效，因此 production 仍应结合 Cloudflare Access、
WAF/Rate Limiting Rules 和告警形成纵深防护。

## 部署就绪检查

`GET /api/v1/health` 在 D1 和关键配置都可用时返回 `200`。未就绪时返回 `503`：

```json
{
  "error": {
    "code": "DEPLOYMENT_NOT_READY",
    "message": "OpenPool deployment configuration is not ready.",
    "issues": ["CREDENTIAL_MASTER_KEY_MISSING"]
  },
  "requestId": "..."
}
```

`issues` 只包含稳定的缺失、格式错误、Secret 复用、bootstrap 生命周期、binding 或 D1 状态码，
永远不返回 Secret 值。`CREDENTIAL_MASTER_KEY`、`API_KEY_PEPPER`、key ID 或认证限流 binding 的
静态检查失败时，其他 `/api/*` 请求也直接返回同一 503，而不是等到加解密或 API Key 鉴权时才失败。
