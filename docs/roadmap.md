# 路线图

## Phase 0：Foundation（完成）

- workspace、严格 TypeScript、Oxlint、test/build；
- Worker + Static Assets + D1；
- domain/application/adapters 分层；
- 初始 schema、Placement 规则与文档。

## Phase 1：V1

1. 单管理员初始化、登录与 session（完成）；
2. AES-GCM credential vault（完成）；
3. R2 Provider 验证与签名上传/下载；
4. logical bucket、对象 reserve/complete/delete；
5. Storage Account、容量、健康检查和简单 Placement；
6. Generic S3 与 B2；
7. API Key、文件管理、审计日志；
8. 一键 Cloudflare 部署和升级说明。

## Phase 2

- account drain 与 shard migration；
- GitHub/static tier；
- replication 与校验修复；
- SDK、CLI 与有限 S3 compatibility gateway；
- multi-user、quota 和细粒度 RBAC。

在 V1 真实使用证明需要之前，不引入复杂一致性哈希、自动分层、完整 S3 API 或计费系统。
