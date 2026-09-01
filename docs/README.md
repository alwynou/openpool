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
- [Provider 指南](providers/README.md)：Provider 端口、能力和实现顺序。
- [Cloudflare 运维](operations/cloudflare.md)：D1、Secret、部署与回滚。
