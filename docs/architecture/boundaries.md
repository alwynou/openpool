# 边界与依赖规则

## Domain

`packages/domain` 只包含可以在任意 JavaScript 运行时执行的业务规则。允许依赖标准语言能力，
不允许导入 Hono、React、Cloudflare 类型、D1、AWS SDK 或环境变量。

## Application

`packages/application` 编排领域对象，并声明它需要的端口，例如 `ObjectRepository`、
`ProviderRegistry`、`Clock`。它不知道端口由 D1、SQLite、R2 还是测试 Fake 实现。

## Adapters

适配器把外部世界翻译为 application 端口：

- inbound：HTTP route、scheduled event、未来的 queue consumer；
- outbound：D1 repository、AES-GCM credential vault、S3/R2/B2 provider。

适配器之间不直接调用。HTTP route 调用用例，而不是绕过用例直接写 D1。

## Composition root

`apps/worker/src/composition` 是唯一装配实现。它可以依赖所有内部包和适配器，但不放业务规则。
测试可用 Fake 替换任意 outbound adapter。

## Contracts

`packages/contracts` 是跨进程边界的数据形状。它只定义公开请求、响应、错误码和运行时校验所需
schema。数据库 row 和 Provider SDK 类型不能泄漏为 API 契约。

## SDK 与对象 CLI

`packages/sdk` 依赖 contracts；`apps/cli` 依赖 SDK，并在客户端边界处理 Node 文件 I/O、参数和进程
信号。CLI 不导入 domain/application、Worker、D1 或 Provider SDK，不绕过控制 API。它使用 API Key，
不能调用管理员 session-only 管理面；迁移 CLI 仍保留独立的管理员授权流程。

## 变更检查

新增功能时依次确认：

1. 不变量是否属于 domain；
2. 流程是否属于 application use case；
3. 外部 I/O 是否通过端口；
4. HTTP 与数据库形状是否被显式映射；
5. 失败、重试和幂等边界是否有测试。
