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
`400 VALIDATION_ERROR`。

## 登录与 session

`POST /api/v1/auth/login` 接收 `username` 和 `password`，成功后返回管理员公开信息与过期时间，
并设置 `openpool_session` Cookie。用户名不存在与密码错误统一返回
`401 INVALID_CREDENTIALS`。

`GET /api/v1/auth/session` 返回当前登录状态。Cookie 缺失、无效或过期时返回
`authenticated: false`，不会暴露具体失败原因。

`DELETE /api/v1/auth/session` 撤销服务端 session 并清除 Cookie；重复调用仍返回 `204`。

浏览器控制台使用同源 Cookie，不把 session token 放入 JavaScript 可访问的存储。
