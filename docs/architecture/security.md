# 安全模型

## Provider 凭证

用户应创建限制到目标 Bucket 和最小操作集的凭证。OpenPool 使用 AES-256-GCM 保存版本化加密
信封；master key 只存在 Cloudflare Secret `CREDENTIAL_MASTER_KEY` 中。解密只发生在需要调用
Provider 的适配器内，日志和错误不得包含 credential、签名 URL 或 authorization header。

建议的信封字段：`version`、`algorithm`、`keyId`、`iv`、`ciphertext`。AES-GCM authentication
tag 随 Web Crypto ciphertext 保存。

## API Key 与会话

- API Key 使用高熵随机值，数据库只保存 prefix 和带服务端 pepper 的哈希。
- 管理员初始化要求 Worker Secret `ADMIN_BOOTSTRAP_TOKEN`，并使用常量时间比较；该 token 不写入
  D1 或浏览器存储。
- 管理员密码使用带随机 salt 的 PBKDF2-SHA256 哈希；登录对未知用户执行等价的 dummy derivation，
  避免通过响应内容区分用户名是否存在。
- session token 使用 32 字节 CSPRNG 随机值，D1 只保存 SHA-256 哈希。默认 8 小时过期，Cookie
  使用 `HttpOnly`、`SameSite=Strict`，非本地开发环境同时使用 `Secure`。
- 权限按 action、logical bucket 和 path prefix 组合，不把 Provider 权限暴露给客户端。

## 签名 URL

- 默认 15 分钟过期；上传限制 key、方法、content type 和已知大小。
- 完成上传时通过 Provider `HEAD` 校验大小、ETag/checksum，再把对象置为 `READY`。
- API 响应和日志不持久化完整签名 URL。

## 威胁边界

D1 泄漏不应直接导致 Provider 凭证泄漏；单个 Provider token 泄漏应被 Bucket 最小权限限制；
OpenPool 不支持或鼓励批量注册账号规避服务商条款，只管理用户合法拥有的账号。
