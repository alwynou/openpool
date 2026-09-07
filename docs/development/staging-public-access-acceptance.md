# Staging 公开对象访问验收（2026-09-07）

## 授权与隔离

- 项目所有者明确授权 staging `0007_public_access.sql`、Worker/Web 部署，以及创建并清理真实 R2/B2
  测试图片；所有者明确要求本次不备份。
- 目标为既有 APAC `openpool-staging` D1 与 `openpool-staging` Worker。未执行 D1 export/恢复，未修改
  production、本地持久化 D1、Storage Account credential 或 Provider CORS。
- 使用既有 `smoke-test`（R2）和 `b2-smoke-test`（B2）逻辑 Bucket/ACTIVE shard。测试文件为仓库
  Logo，22,521 字节，SHA-256 为
  `e0ec8457f83b30ada4c29dd005f9a2ee35cf1795e791ffdec294588a238edc99`。
- 管理员密码只从 macOS 钥匙串送入浏览器；session、credential 与完整 Provider signed URL 没有写入
  命令输出、仓库或本文。

## Migration、发布与线上修复

- [x] 核对唯一可见 Cloudflare account、staging D1 名称/UUID/APAC region、干净的 `main` 和
  [PR #14](https://github.com/alwynou/openpool/pull/14) 的成功 `CI / Verify`；升级前仅 0007 待执行。
- [x] 按所有者的免备份决定执行 `npm run db:migrate:staging`；0007 的 6 条语句成功，migration
  history 随后无待办。新增列、两个 expiry guard trigger、既有 Bucket 私有默认值和既有对象
  `INHERIT` 默认值均通过远端只读 SQL 核对。
- [x] 首次部署 version `23578982-b6e2-4fdd-98bf-8264f2b584be` 后，health 为 200，不存在的
  `/public/objects/:id` 返回带安全 header 的空 404，证明 `/public/*` 已进入 Worker 而非 SPA fallback。
- [x] 真实 B2 `PUBLIC` 对象暴露出签名时钟边界：策略写入成功但公开 GET 返回 503。live tail 显示
  Worker outcome `ok`、无 exception/应用日志，路径由 Cloudflare 标记为 `REDACTED`。根因是应用用
  Provider 调用前的时间校验合法的 `签名时刻 + 60 秒`，B2 路径约 200ms 延迟导致误判。
- [x] [PR #15](https://github.com/alwynou/openpool/pull/15) 改为在 Provider 签名完成后校验到期时间，
  仍把 `expiresInSeconds` 限制为最多 60；新增 250ms 延迟回归。完整 `npm run verify` 通过 Oxlint、
  全部 workspace typecheck、746 项测试和全部 build/dry-run；GitHub `CI / Verify` 成功且 PR 为
  `CLEAN` 后合并到 `main`。
- [x] 从合并提交 `00d43c2` 重新发布 version `2dbbf053-b02b-460f-91dd-19dcc4a4c7ad`；health 保持
  200，后续全部 R2/B2 公开签名通过。

## R2、B2 与策略矩阵

- [x] 两个 Bucket 初始均为私有；R2/B2 新 READY 图片都是 `INHERIT`，稳定链接均为空 404。
- [x] B2 对象显式设为永久 `PUBLIC` 后返回空 body 302，目标 host 为
  `s3.us-east-005.backblazeb2.com`，`X-Amz-Expires=60`；跟随重定向得到 22,521 字节且 SHA-256 与源
  Logo 一致，证明对象字节没有经过 Worker。
- [x] 通过真实 Web `datetime-local` 输入把同一 B2 对象设为
  `2026-09-07T09:32:00.000Z` 到期；到期前 302，到期后稳定链接立即为空 404，无需 Cron。
- [x] 开启 R2 Bucket 后，开启前已存在的 `INHERIT` 对象立即 302 到
  `*.r2.cloudflarestorage.com`，签名 60 秒且下载哈希一致。公开 Bucket 中将该对象显式设为
  `PRIVATE` 后立即为空 404。
- [x] R2 Bucket 保持公开时新上传第二张图片；对象以 `INHERIT` 创建并立即 302 到 R2，下载哈希
  一致。关闭 Bucket 后稳定链接立即为空 404；再将该对象显式设为 `PUBLIC` 后，即使 Bucket 私有也
  恢复 302，验证对象策略优先。
- [x] 对一个 R2 显式公开对象先签发 60 秒 Provider URL，再关闭对象策略：稳定链接立即为空 404，
  已签发 URL 在窗口内仍返回 200/正确哈希，并在签发时间加 60 秒后返回 403。临时 URL 文件随即删除。
- [x] 所有 302 与 404 响应均为 empty body，并带 `Cache-Control: no-store`、
  `Referrer-Policy: no-referrer` 和 `X-Content-Type-Options: nosniff`；不存在匿名 Bucket 列表。
- [x] Bucket/对象公开策略 mutation 已写入事务 audit outbox，并由 Cron 投递到 audit log；多次匿名
  公开 GET 没有产生 `OBJECT_DOWNLOAD_SIGNED`，符合无 D1 写放大设计。

## 清理与结束状态

- [x] 三个测试对象的 OpenPool DELETE 均返回 200；D1 tombstone 全部为 `DELETED`，三个稳定链接均
  为空 404。R2/B2 测试 Bucket 均恢复 `public_access_enabled=0`，两只 ACTIVE shard 的
  `used_bytes=0`，原有 Bucket、shard、Storage Account 和 credential 未删除。
- [x] B2 Bucket 使用 `Keep all versions`；在 Backblaze 控制台精确核对物理键
  `objects/a8/a8dc46f9-200e-488c-8ff5-5319991ec1f8` 后，永久删除 1 个 22,521 字节 upload version
  与 1 个 0 字节 hide marker。删除后 Bucket 文件浏览器为空且 `objects/` 前缀消失；未删除 Bucket
  或其他文件。
- [x] 最终 staging health 为 200，migration history 无待办；本地 `main` 与 `origin/main` 一致且
  工作树干净。production 仍停留在 0006/旧 Worker，本次未触碰。

## 后续

production 上线必须重新核对 account、D1 history、当前 Worker version、备份决定和维护窗口，并取得
单独授权。顺序仍是先应用 0007，再部署同一 `main` build，最后从规范域名
`https://openpool.alwynou.com/public/objects/{objectId}` 验证；不得把本次 staging 免备份决定或测试写入
授权自动扩展到 production。
