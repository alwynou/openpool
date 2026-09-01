# 开发工作流

## 开始前

先定位变更属于 domain、application、adapter 还是 contract。跨层功能从不变量和用例测试开始，
再实现外部适配器和 HTTP route。

## 代码约定

- TypeScript strict；避免 `any` 和无理由的类型断言。
- 时间、ID、repository、Provider 与随机性通过端口注入。
- 错误使用稳定 code 映射到 HTTP；内部异常信息不直接返回。
- route 只负责解析、鉴权、调用用例和映射响应。
- 对重试可见的命令必须定义幂等语义。
- Provider capability 显式建模，不假设所有 S3-compatible 行为完全一致。

## 测试层次

- domain：纯单元测试，覆盖边界值和状态规则；
- application：Fake ports，覆盖成功、无容量、冲突、重试和补偿；
- Worker：Cloudflare Vitest runtime，覆盖 binding、route 和 D1 adapter；
- Web：优先测试用户行为，不测试实现细节。

## 完成标准

1. 相关测试先通过，再运行 `npm run verify`。
2. API 或 schema 变化同步契约、迁移和文档。
3. 新外部调用有超时、错误分类和不泄密日志。
4. 不提交 `.dev.vars`、真实账号 ID、token、签名 URL 或本地 D1 状态。
5. 远端部署与迁移必须由用户明确授权。
