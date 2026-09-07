# Production 公开对象访问验收（2026-09-07）

## 授权与升级前状态

- 项目所有者在 staging 验收完成后明确要求 production 不备份并直接进行下一步，授权范围为
  `0007_public_access.sql`、Worker/Web 部署、R2/B2 临时测试图片及精确清理。
- 目标是 APAC `openpool-production` D1、`openpool-production` Worker、规范入口
  `https://openpool.alwynou.com` 与对应 production Provider；未修改 staging、本地持久化 D1、
  credential、CORS 或 Provider bucket 配置。
- 升级前只剩 0007 待执行，D1 为 17 张表、299 kB；当前 Worker version 为
  `c06a8647-32db-429a-a64b-0c7d194ded30`，规范入口与 `workers.dev` 回退入口 health 均为 200。
- `r2-storage` 中已有一个 2,120,751 字节 READY 图片，`b2-storage` 为空。升级及验收不改变已有图片的
  对象策略，也不在 R2 Bucket 层短暂公开它。

## Migration 与部署

- [x] `npm run db:migrate:production` 只应用 0007，6 条语句成功；随后 migration history 无待办。
  Bucket/object 新列、私有/`INHERIT` 默认值及两个 expiry guard trigger 均经远端只读 SQL 核对。
- [x] 迁移后两个正式 Bucket 均保持 `public_access_enabled=0`；已有 R2 图片保持 READY、`INHERIT`、
  无到期时间，没有因 schema 前滚意外公开。
- [x] 从受保护 `main` 合并提交 `5a0b0f9` 执行 `npm run deploy:production`，Web build 与 Wrangler
  strict deploy 成功，活动 version 为 `0404cc4d-ebf0-45c4-90fe-efb38afdb005`。
- [x] 部署后规范入口与回退入口 health 均为 200。升级前不存在的 `/public/objects/:id` 被 SPA
  fallback 返回 HTML 200；升级后从规范入口返回带 `no-store`、`no-referrer`、`nosniff` 的空 404，
  证明 `/public/*` 已优先进入 Worker。

## R2、B2 与公开策略

测试源为仓库 Logo，22,521 字节，SHA-256 为
`e0ec8457f83b30ada4c29dd005f9a2ee35cf1795e791ffdec294588a238edc99`。两张图片均从 production Web
经 signed PUT 直接上传并成为 READY/`INHERIT`；初始稳定链接均为空 404。

- [x] 仅在没有正式对象的 `b2-storage` 开启 Bucket 默认公开；已有测试对象立即从规范入口空 body
  302 到 `s3.us-east-005.backblazeb2.com`，`X-Amz-Expires=60`，Provider 返回 `image/png`、22,521
  字节且哈希一致。
- [x] B2 Bucket 公开时将测试对象显式设为 `PRIVATE`，稳定链接立即为空 404，证明对象覆盖优先；随后
  Bucket 恢复私有，没有在 `r2-storage` 执行 Bucket 公开测试。
- [x] B2 测试对象在私有 Bucket 中显式设为 `PUBLIC`，到期时间为
  `2026-09-07T12:46:00.000Z`。到期前按剩余 1 秒签发并成功下载，到期后立即返回带安全 header 的空
  404，无需 Cron。
- [x] R2 测试对象在私有 Bucket 中显式永久公开；规范入口空 body 302 到
  `*.r2.cloudflarestorage.com`，签名 60 秒，Provider 下载字节与哈希一致。
- [x] 先保存一个 R2 signed URL，再把对象设为 `PRIVATE`：稳定链接立即为空 404，已签发 URL 在窗口内
  仍返回 200/正确哈希，签发后 60 秒返回 403；保存 URL 的 0700 临时目录随即永久删除。
- [x] Bucket/对象策略 mutation 的 audit outbox 均已投递到 audit log；测试对象的多次匿名公开 GET
  没有产生 `OBJECT_DOWNLOAD_SIGNED`，符合无 D1 写放大设计。

## 清理与结束状态

- [x] 两张测试对象均通过 OpenPool Web 删除并成为 `DELETED`，稳定链接均为空 404；两个 Bucket
  恢复私有，B2 ACTIVE shard 用量回到 0，R2 ACTIVE shard 用量精确恢复到已有图片的 2,120,751
  字节。已有图片仍为 READY/`INHERIT`/无到期时间。
- [x] R2 测试物理键 `objects/2f/2f56ec8d-e5e9-4be7-8356-0bca0e44ff6f` 已不存在。
- [x] B2 使用 `Keep all versions`；通过已有的 Bucket-scoped production application key 调用 B2
  Native API，仅永久删除测试物理键 `objects/cb/cb90fb9a-6a74-4fc8-ac0a-ea74ff55dfb2` 的一个
  22,521 字节 upload version 与一个 0 字节 hide marker。按精确键重新列举后剩余版本为 0，没有删除
  Bucket 或其他文件。
- [x] 最终 production health 为 200，migration history 无待办；Storage Account、正式逻辑 Bucket、
  shard、credential、CORS 和 staging 均未删除或重配。
