# 公开对象访问本地验收

## 范围

当前实现提供稳定地址 `GET /public/objects/:objectId`。Logical Bucket 可设置继承对象的公开默认值，
单个 READY 对象可选择 `INHERIT`、`PUBLIC` 或 `PRIVATE`；显式 PUBLIC 可设置未来到期时间。Worker
只判断策略、解析当前 primary location 并返回最长 60 秒的 Provider signed GET `302`，不代理对象
字节。

## 已覆盖的本地证据

- domain：READY 要求、Bucket 继承、对象显式覆盖、到期边界；
- application：输入与 canonical 时间校验、乐观并发、管理员审计、60 秒签名上限和 Provider 响应
  fail-closed；
- D1：`0007` 私有默认值、模式 CHECK、非 PUBLIC expiry trigger、条件更新与 audit outbox 原子回滚；
- HTTP/composition：未完成/私有/过期统一 404、允许时空 body 302、安全 header、API Key mutation 403；
- Web：Bucket 影响范围确认、READY 文件策略编辑、未来到期校验和稳定链接展示；
- SDK/CLI：新增公开元数据字段和两项管理员 mutation 的契约兼容。

上述 D1 测试通过 `cloudflare:test` 在隔离临时数据库依次应用全部 migration，不修改 Wrangler 本地
持久化 D1。

## 远端验收状态

staging 与 production 的 0007、部署、真实 R2/B2 策略、到期、撤销窗口、审计和精确清理均于
2026-09-07 经各自明确授权完成。证据见[staging 验收](staging-public-access-acceptance.md)和
[production 验收](production-public-access-acceptance.md)。production 从规范域名
`https://openpool.alwynou.com/public/objects/:objectId` 验证，未修改已有对象策略或删除正式 Bucket、
Storage Account、shard、credential。

部署顺序不能反转：新 Worker 会读取 `0007` 新列。migration 使用私有默认值，不会自动公开现有
对象；旧 Worker 会忽略新列，因此应用回滚无需回滚 schema。
