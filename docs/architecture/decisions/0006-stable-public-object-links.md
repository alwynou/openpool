# ADR 0006：稳定公开对象链接通过短期签名重定向交付

- 状态：Accepted（本地实现及 staging/production R2/B2 验收完成）
- 日期：2026-09-07

`0007` 与配套 Worker/Web 已按 migration → deploy 顺序在 staging 和 production 前滚；实际 R2/B2
策略、到期和撤销窗口证据见[staging 验收](../../development/staging-public-access-acceptance.md)和
[production 验收](../../development/production-public-access-acceptance.md)。

## 背景

OpenPool 的逻辑对象可以在 R2 与 B2 之间迁移，物理 bucket/key 不是公开契约。直接暴露 Provider
公开 URL 会泄漏放置细节、使迁移改变链接，并要求不同 Provider 各自承担公开 ACL 与域名配置。
同时，ADR 0001 要求对象字节永不经过 Worker。

## 决策

公开对象使用由 OpenPool origin 承载的稳定地址：

```text
GET /public/objects/{objectId}
```

对象 ID 是不含用户路径和 Provider 信息的稳定标识；shard migration 不改变该地址。每次访问时，
Worker 只读取 D1 的当前公开策略和 primary location，解密对应 Storage Account credential，生成最长
60 秒的 Provider signed GET，然后返回不可缓存的 `302`。客户端随后直接向 R2 或 B2 读取对象字节，
Worker 不读取或转发正文。

公开策略分为两层：

- Logical Bucket 保存 `publicAccessEnabled`，开启后所有采用继承策略的现有及未来 `READY` 对象公开；
- 对象保存 `INHERIT`、`PUBLIC` 或 `PRIVATE`。`PUBLIC` 可选 canonical UTC `expiresAt`；到期后立即停止
  签发新重定向。显式对象策略优先于 Bucket 默认值，因此可在公开 Bucket 中关闭单个对象，也可在
  私有 Bucket 中公开单个对象。

只有管理员 session 可以改变公开策略；现有 API Key scope 不自动获得暴露数据的权限。不存在、
非 `READY`、私有或过期对象的匿名访问统一返回 404。策略变更写入事务 audit outbox；匿名读取不写
D1 audit，避免公开流量产生同步写放大。外层重定向使用 `Cache-Control: no-store` 和
`Referrer-Policy: no-referrer`。已经签发的 Provider URL 最多在剩余短 TTL 内继续有效，这是关闭公开
访问的明确撤销窗口。

Bucket 公开不提供匿名对象列表。管理 API 返回每个对象的稳定 `publicUrl`，即使当前为私有也可以
预先复制；未公开时访问该地址只得到 404。

## 后果

- R2 与 B2 复用现有 SigV4 signed GET 能力，不需要改变 Provider bucket 的公开 ACL；
- production 自定义域名可直接形成 `https://openpool.alwynou.com/public/objects/{objectId}`；通过
  `workers.dev` 或本地 origin 调用管理 API 时，返回值使用对应请求 origin；
- 每次公开访问产生一次 Worker/D1 读取和一次签名计算，但不产生对象带宽、对象内存或 D1 写入；
- Provider CORS 仍只影响跨域脚本读取；普通浏览器导航和图片加载跟随重定向即可；
- HTML 等主动内容在 Provider origin 渲染，而不进入 OpenPool origin，避免把用户对象提升为控制面
  同源内容。
