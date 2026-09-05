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

Web 定向检查运行 `npm run test:web`。需要 DOM 的页面测试使用文件级 jsdom、真实组件和查询缓存，
只替换 API I/O；每例清理 DOM/缓存，禁止访问真实服务。上传恢复的覆盖范围与执行说明见
[Web 上传恢复交互回归](web-upload-recovery.md)，账号表单与凭据边界见
[Web 账号纠错交互回归](web-account-recovery.md)和[Web 账号创建交互回归](web-account-creation.md)；
一次性 token、创建锁与剪贴板结果见[Web API Key 创建交互回归](web-api-key-creation.md)。
组件测试不替代真实浏览器/CORS 验收。

## 持续集成

`.github/workflows/ci.yml` 在 pull request 和手动触发时使用 `.nvmrc` 中的 Node.js 版本执行 `npm ci` 与
`npm run verify`。branch push 不自动触发，避免开放 PR 或合并前后对同一变更重复运行 CI。工作流只授予
`contents: read`，checkout 不持久化 GitHub credential，不配置 Cloudflare Secret，也不运行远端 D1
migration 或 Worker 部署。并发的新提交会取消同一 PR ref 上的旧验证，避免消耗资源验证过时提交。

`main` 使用 GitHub branch protection：包括管理员在内都不能直接推送，只能通过非 `main` 分支的
pull request 集成。GitHub 要求 PR 分支跟上最新 `main`，并由 GitHub Actions app 提供的
`CI / Verify` 成功后才允许合并；pending、skipped、cancelled 或失败都不满足门槛。不得为合并临时
绕过、关闭或削弱保护规则。当前单维护者流程不要求额外 approval；如增加协作者，再单独决定 review
数量和 CODEOWNERS。

## 完成标准

1. 相关测试先通过，再运行 `npm run verify`。
2. API 或 schema 变化同步契约、迁移和文档。
3. 新外部调用有超时、错误分类和不泄密日志。
4. 不提交 `.dev.vars`、真实账号 ID、token、签名 URL 或本地 D1 状态。
5. 远端部署与迁移必须由用户明确授权。
6. 集成到 `main` 必须创建 pull request，并等待必需的 `CI / Verify` 成功。
