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
