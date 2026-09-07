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

## 远端验收待办

以下步骤均有远端副作用，必须由项目所有者分别确认目标环境、备份决策并明确授权：

1. 核对 staging D1 history，应用 `0007`，再部署同一提交的 Worker/Web；
2. 分别用真实 R2 与 B2 READY 图片验证单文件永久公开、定时公开、到期 404 和关闭后的最长 60 秒
   撤销窗口；
3. 验证 Bucket 开启后既有/新上传 INHERIT 文件公开、显式 PRIVATE 仍不可访问、关闭后显式 PUBLIC
   不受影响；
4. 从 staging origin 检查 Location 指向当前 Provider 且图片字节不经过 Worker；
5. staging 通过后，对 production 重复 migration history/备份核对、`0007`、部署，并从规范域名
   `https://openpool.alwynou.com/public/objects/:objectId` 验证；
6. 精确清理专用测试对象；不删除正式 Bucket、Storage Account 或 credential。

部署顺序不能反转：新 Worker 会读取 `0007` 新列。migration 使用私有默认值，不会自动公开现有
对象；旧 Worker 会忽略新列，因此应用回滚无需回滚 schema。
