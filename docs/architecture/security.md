# 安全模型

## Provider 凭证

用户应创建限制到目标 Bucket 和最小操作集的凭证。OpenPool 使用 AES-256-GCM 保存版本化加密
信封；master key 只存在 Cloudflare Secret `CREDENTIAL_MASTER_KEY` 中。解密只发生在需要调用
Provider 的适配器内，日志和错误不得包含 credential、签名 URL 或 authorization header。

建议的信封字段：`version`、`algorithm`、`keyId`、`iv`、`ciphertext`。AES-GCM authentication
tag 随 Web Crypto ciphertext 保存。

## API Key 与会话

- API Key 使用高熵随机值，数据库只保存 prefix 和带服务端 pepper 的哈希。
- session token 同样只保存哈希，设置短过期时间与安全 Cookie。
- 权限按 action、logical bucket 和 path prefix 组合，不把 Provider 权限暴露给客户端。

## 签名 URL

- 默认 15 分钟过期；上传限制 key、方法、content type 和已知大小。
- 完成上传时通过 Provider `HEAD` 校验大小、ETag/checksum，再把对象置为 `READY`。
- API 响应和日志不持久化完整签名 URL。

## 威胁边界

D1 泄漏不应直接导致 Provider 凭证泄漏；单个 Provider token 泄漏应被 Bucket 最小权限限制；
OpenPool 不支持或鼓励批量注册账号规避服务商条款，只管理用户合法拥有的账号。
