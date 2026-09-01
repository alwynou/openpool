# 文档导航

先读 [架构总览](architecture/overview.md)。之后按任务进入对应文档，不需要一次性读取全部内容。

## 架构

- [架构总览](architecture/overview.md)：系统、请求流与代码层次。
- [边界与依赖规则](architecture/boundaries.md)：模块职责和禁止依赖。
- [数据模型](architecture/data-model.md)：D1 实体、不变量与状态。
- [安全模型](architecture/security.md)：凭证、API Key、上传与日志安全。
- [架构决策记录](architecture/decisions/)：已经确定的重要取舍。

## 开发

- [本地开发](development/getting-started.md)：环境、安装、迁移与调试。
- [开发工作流](development/workflow.md)：代码约定、测试和完成标准。
- [Deferred 外部步骤](development/deferred-external-steps.md)：需要账号、凭证或远端授权的待办。
- [路线图](roadmap.md)：V1 范围与后续阶段。

## 集成与运行

- [认证 API](api/authentication.md)：首次初始化、登录、session 与登出。
- [API Key API](api/api-keys.md)：管理员创建/列出/撤销 API Key，以及对象 API 的 Bearer 权限。
- [审计日志 API](api/audit-logs.md)：管理员只读查询、过滤和游标分页。
- [Storage Account API](api/storage-accounts.md)：Provider 账号、验证、健康与生命周期。
- [Bucket 与 Shard API](api/buckets.md)：逻辑命名空间和物理 Bucket 映射。
- [对象 API](api/objects.md)：reserve、complete、签名下载和幂等删除。
- [Provider 指南](providers/README.md)：Provider 端口、能力和实现顺序。
- [Cloudflare 运维](operations/cloudflare.md)：D1、Secret、部署与回滚。
- [V1 验收清单](development/v1-acceptance.md)：本地验收、迁移前滚/回滚和发布前检查。
