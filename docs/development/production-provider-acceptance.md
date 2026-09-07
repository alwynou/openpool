# Production Provider 与自定义域名验收

- 日期：2026-09-07
- 规范入口：`https://openpool.alwynou.com`
- 回退入口：`https://openpool-production.alwynou2806.workers.dev`

## 范围

本轮在既有、已初始化的 production 控制面上完成自定义域名、独立 R2/B2 Provider、最小 CORS、
逻辑 Bucket/ACTIVE shard 和真实浏览器直传验收。没有执行 D1 migration，没有修改 staging 资源，
也没有把对象字节代理经过 Worker。

自定义域名配置由 [PR #10](https://github.com/alwynou/openpool/pull/10) 通过受保护的 `main` 合入；
必需的 `CI / Verify` 成功且分支与 `main` 同步后才合并。发布后的活动 Worker version 为
`c06a8647-32db-429a-a64b-0c7d194ded30`，规范入口与 `workers.dev` 回退入口的
`/api/v1/health` 均返回 200、`environment=production`。

## Provider 资源与凭据边界

- Cloudflare R2 使用独立 APAC bucket `openpool-production-r2`；S3 API credential 仅允许该 bucket
  的 Object Read & Write。
- Backblaze B2 使用独立私有 bucket `openpool-b2-production-5649cdbfcc`，region 为 `us-east-005`，
  默认加密启用、Object Lock 关闭、版本策略为 Keep all versions；application key 只限制到该 bucket
  并包含验收所需读写与删除能力。
- 两组明文 credential 只保存在 macOS 登录钥匙串并通过 production Web 表单送入控制面；D1 仅保存
  加密 envelope。凭据值、签名 URL、session Cookie 和 Cloudflare account ID 未进入仓库或本记录。
- `Production R2` 与 `Production B2` 均验证为 `ACTIVE`、可读写且健康；优先级均为 100，配置容量均为
  100 GiB。

## CORS 与逻辑配置

R2 CORS 只允许规范入口和 `workers.dev` 回退入口，允许 `PUT`、`GET`、`HEAD`、`DELETE`，请求头
`Content-Type`，暴露 `ETag`，max age 为 3600 秒。

B2 自定义 CORS 同样只允许上述两个 production origin，操作为 `s3_put`、`s3_get`、`s3_head`，
允许 `Authorization`、`Content-Type`、`Range`，暴露 `ETag`，max age 为 3600 秒。没有加入 staging
origin 或通配 origin。

传输验收首先建立两个明确标注为验收用途的稳定命名空间：

- `production-r2-smoke` → `openpool-production-r2`，ACTIVE，100 GiB；
- `production-b2-smoke` → `openpool-b2-production-5649cdbfcc`，ACTIVE，100 GiB。

验收完成后，所有者决定 R2 与 B2 分别使用，并授权由维护者命名。正式生产逻辑命名空间为：

- `r2-storage` → `openpool-production-r2`，ACTIVE，100 GiB；
- `b2-storage` → `openpool-b2-production-5649cdbfcc`，ACTIVE，100 GiB。

客户端按逻辑 Bucket 显式选择 Provider；两者之间不做自动放置、复制或故障切换。验收用逻辑 Bucket
仅用于本轮真实传输；完成物理对象清理后，所有者明确授权从 production D1 精确删除两个 smoke
命名空间及其关联 metadata。当前只保留 `r2-storage` 与 `b2-storage` 两个正式逻辑命名空间。

## 真实浏览器直传与下载

在 `https://openpool.alwynou.com/files` 使用 production 管理员 session，分别向 R2 与 B2 命名空间
上传仓库中的 `openpool-logo.png`。源文件大小为 22,521 字节，SHA-256 为
`e0ec8457f83b30ada4c29dd005f9a2ee35cf1795e791ffdec294588a238edc99`。

两轮均完成以下检查：

1. Web 从控制面取得短期 signed PUT，浏览器直接把 22,521 字节写入 Provider；
2. complete 通过 Provider HEAD 确认，逻辑对象进入 `READY`；
3. 浏览器取得短期 signed GET，并以 `credentials=omit`、`no-referrer` 直接下载；
4. 下载响应为 `image/png`、22,521 字节，SHA-256 与源文件完全一致；
5. 控制面没有接收对象字节，production 自定义域名的真实 CORS 预检与传输链路通过。

## 删除与清理

- 两个对象均通过 OpenPool 正常删除并进入 `DELETED`，对应 Storage Account 与 shard 的
  `usedBytes` 全部回到 0。
- 使用对象映射的精确物理 key 查询 R2，结果为 key 不存在。
- B2 的 S3 DELETE 按 Keep all versions 语义产生一个 hide marker；随后只针对本轮精确物理 key，
  先永久删除唯一 upload version，再删除唯一 hide marker。再次列举该 key 的版本，剩余数量为 0。
- 经所有者后续明确授权，在确认两个 smoke 命名空间均无 API key 或 shard migration 后，按外键顺序
  精确删除其 audit log/outbox、对象墓碑、location、上传会话、shard 与 logical Bucket。反向查询确认
  上述关联记录均为 0。
- 未清空或删除 Provider bucket，未删除 Storage Account，也未改动正式的 `r2-storage`、`b2-storage`
  及任何不属于本轮的对象。

## 剩余运维边界

自动 production CD、Cloudflare 最小权限部署 token、environment protection 和恢复演练尚未完成。
未来包含已有数据的 D1 schema 升级仍须重新确认备份位置、migration history、维护窗口和明确授权；
本次 Provider 配置与 smoke 不构成后续远端写入或删除的持续授权。
