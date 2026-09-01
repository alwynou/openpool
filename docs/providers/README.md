# Provider 开发指南

Provider 适配器实现 application 定义的端口。V1 顺序是 R2、Backblaze B2、Generic S3；R2 和 B2
都优先复用 S3-compatible 基础实现，只把 endpoint、认证和 capability 差异留在薄适配层。

## 最小能力

- credential validation；
- `HEAD`、`PUT`、`GET`、`DELETE`；
- presigned upload/download URL；
- bucket 与配额/使用量探测（无法精确时明确标为 estimated）；
- 超时、鉴权失败、配额不足、限流与临时故障的统一错误分类。

Provider 不负责选择账号，也不写对象元数据。Placement 属于 domain/application，对象位置由
repository 保存。

## 新增 Provider

1. 在 domain/contract 中声明稳定 provider kind 和 capability；
2. 在 application 端口之外避免暴露 SDK 类型；
3. 在 `apps/worker/src/adapters/providers/<name>` 实现；
4. 用录制/模拟 HTTP 覆盖签名和错误映射，真实凭证测试保持 opt-in；
5. 在 composition root 注册；
6. 更新安全、部署和用户配置文档。

GitHub、WebDAV、本地文件系统不满足标准对象存储假设，必须作为特殊 tier 单独设计，不能伪装成
Generic S3。

## 当前 S3-compatible 基础层

Worker 使用 Web Crypto 兼容的低层 AWS SigV4 presigner，不引入 S3 client、Node credential chain，
也不让 SDK 类型越过 adapter 边界。基础 signer 支持 `PUT`、`GET`、`HEAD`、`DELETE` 对象请求和
`HEAD Bucket`；默认 URL 有效期为 15 分钟，最长不超过 SigV4 允许的 7 天。签名 `PUT` 的
`content-type` 必须由客户端原样发送。

R2 是当前第一个薄适配层：endpoint 从 Cloudflare account ID 和可选 jurisdiction 构造，region 固定
为 `auto`。账号验证与健康探测使用短期签名的 `HEAD Bucket`。R2 无法通过 S3 API 准确探测配额与
用量，因此 capability 明确报告 `usageProbe: false`，容量来自管理员配置并标记为 `CONFIGURED`。

Provider 实例不保存 credential；应用用例只在 Provider 操作前解密，并把明文限定在该次调用。所有
transport、签名和解析错误都转换为无敏感上下文的稳定 `ProviderError`。

Backblaze B2 同样复用该基础层。其非敏感配置为 `region`、`validationBucket` 和可选
`addressingStyle`，endpoint 固定构造为 `https://s3.<region>.backblazeb2.com`，不接受调用方覆盖。
region 必须与 B2 账号区域一致。B2 S3 API 同样不提供 OpenPool 可依赖的精确容量探测，因此需要
管理员配置容量。

参考 Backblaze 官方文档：[调用 S3-compatible API](https://www.backblaze.com/docs/en/cloud-storage-call-the-s3-compatible-api)。

Generic S3 配置显式包含 `endpoint`、`region`、`validationBucket` 和可选 `addressingStyle`。endpoint
必须为没有 userinfo、query 或 fragment 的 HTTPS URL；自签证书、明文 HTTP、运行时 ambient
credential chain 和任意 endpoint override 都不属于 V1 安全默认值。
