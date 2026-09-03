# 文档导航

先读 [架构总览](architecture/overview.md)。之后按任务进入对应文档，不需要一次性读取全部内容。

## 架构

- [架构总览](architecture/overview.md)：系统、请求流与代码层次。
- [边界与依赖规则](architecture/boundaries.md)：模块职责和禁止依赖。
- [数据模型](architecture/data-model.md)：D1 实体、不变量与状态。
- [安全模型](architecture/security.md)：凭证、API Key、上传与日志安全。
- [架构决策记录](architecture/decisions/)：已经确定的重要取舍。
  - [ADR 0004：事务审计 Outbox](architecture/decisions/0004-transactional-audit-outbox.md)
  - [ADR 0005：显式上传尝试重试](architecture/decisions/0005-upload-attempt-retries.md)

## 开发

- [本地开发](development/getting-started.md)：环境、安装、迁移与调试。
- [开发工作流](development/workflow.md)：代码约定、测试和完成标准。
- [Web 上传恢复交互回归](development/web-upload-recovery.md)：本地页面测试、确认重试和输入状态边界。
- [Web 账号纠错交互回归](development/web-account-recovery.md)：验证失败后编辑、凭据留空/替换和并发冲突恢复。
- [Web 账号创建交互回归](development/web-account-creation.md)：新增账号的凭据清理、显式重试与重复提交保护。
- [Staging Web 恢复验收](development/staging-web-recovery-acceptance.md)：两轮 Web 修复的发布、R2 真实交互及清理证据。
- [Deferred 外部步骤](development/deferred-external-steps.md)：需要账号、凭证或远端授权的待办。
- [路线图](roadmap.md)：V1 范围与后续阶段。

## 集成与运行

- [认证 API](api/authentication.md)：首次初始化、登录、session 与登出。
- [API Key API](api/api-keys.md)：管理员创建/列出/撤销 API Key，以及对象 API 的 Bearer 权限。
- [审计日志 API](api/audit-logs.md)：管理员只读查询、过滤和游标分页。
- [Storage Account API](api/storage-accounts.md)：Provider 账号、验证、健康与生命周期。
- [Bucket 与 Shard API](api/buckets.md)：逻辑命名空间和物理 Bucket 映射。
- [Shard Migration API 与搬运器](api/shard-migrations.md)：account drain、持久化迁移和流式 CLI。
- [对象 API](api/objects.md)：reserve、complete、签名下载和幂等删除。
- [TypeScript SDK](sdk/typescript.md)：私有预览对象客户端与签名直传/直取边界。
- [对象 CLI](cli/objects.md)：受限 API Key、文件直传/直取、显式重试与失败恢复。
- [Provider 指南](providers/README.md)：Provider 端口、能力和实现顺序。
- [Cloudflare 运维](operations/cloudflare.md)：D1、Secret、部署与回滚。
- [V1 验收清单](development/v1-acceptance.md)：本地验收、迁移前滚/回滚和发布前检查。
- [Staging 升级验收](development/staging-upgrade-acceptance.md)：0004/0005、双向迁移与事务审计证据。
- [Staging 上传重试验收](development/staging-upload-retry-acceptance.md)：0006、R2/B2 重试与旧尝试清理证据。
- [Staging 对象 CLI 验收](development/staging-cli-acceptance.md)：真实 R2/B2 命令、权限、文件校验与失败恢复。
- [可重复 CLI smoke](development/cli-smoke.md)：显式授权、50 MB 上限、真实传输取消、报告和清理边界。
- [Staging CLI 50 MB 验收](development/staging-cli-50mb-acceptance.md)：R2/B2 部分传输中断、显式重试及内存观察。
