# Staging 0006 上传重试验收（2026-09-02）

## 授权与隔离

- 所有者明确要求继续 staging migration、部署和真实重试验收，并再次明确要求本次不备份。
- 未执行 D1 export/恢复；未操作 production 或本地持久化 D1。
- 使用既有隔离 R2/B2 物理 Bucket，新增两个测试 logical bucket/shard，共六个独立逻辑对象。
  复用原有受限账号，不修改其配置、凭据、生命周期或原有文件；测试字节直接传输 Provider。
- 管理员 session token、Provider credential 和 signed URL 仅在受控进程内使用，不写入验收记录或仓库。

## 发布与已完成验证

- [x] Git 基线 `9a408dc`，工作区干净；`npm run verify` 通过 482 个测试（根 169、Worker 306、migrator 7）、
  lint、typecheck、Web build、Worker dry-run 和 CLI build。
- [x] 核对当前 OAuth、唯一可见 Cloudflare account、既有 APAC staging D1 和 Secret 名称。
  升级前只有 0006 待执行；原有 10 个 upload session 均有 primary location。
- [x] 0006 远端成功执行；迁移列表无待办。升级后 10 个旧 session 均为 current 且 location 绑定已回填。
- [x] Worker/Web 发布成功；version `a512e61f-7c6f-4b33-a0f2-16ce86c3977a`，Cron `*/5 * * * *`。
  staging health、管理员登录/登出和新 Web 静态资源通过 HTTP 核对。
- [x] R2/B2 各自验证：首次未上传时 complete 返回 `404 PROVIDER_NOT_FOUND`；同一 expected session
  并发重试一个 201、一个 409 OBJECT_CONFLICT；新旧 session/physical key 不同，object ID/路径不变。
- [x] 两个 Provider 的 replacement 均为 64 KiB；旧会话 complete 被拒绝，新 complete 可幂等重试，
  READY 覆盖被拒绝，下载 SHA-256 正确。替换完成后再次使用旧 PUT 签名，新的下载内容仍保持不变。
- [x] B2 的立即重试对象在旧清理完成前先进入 DELETED，用于验证历史清理不依赖当前 object 状态。
- [x] 短期、限定 Bucket/path 的 `objects:upload` API Key 可查询当前上传，响应只含四个公开字段；
  跨 Bucket/path、缺少 scope 和跨 Bucket retry 均返回 403，管理员接口和撤销后查询返回 401。
  三个 smoke Key 均已撤销，raw token 只在进程内使用；补齐 API Key 文档中的新查询接口和管理鉴权说明。

## 实际时钟与清理验证

- [x] 在签名到期前及到期后的 grace 内，直读六个旧物理 key，均返回 200 且旧内容 SHA-256 匹配。
  审计查询的 16 条初期事件已全部投递，重复查询保持相同 event id 且无重复。
- [x] 16:49（Asia/Shanghai）等待真实签名到期后，两个 Provider 的旧 complete 均返回
  `410 OBJECT_UPLOAD_EXPIRED` 并持久化 EXPIRED；重试为新 1 KiB 文件后 complete、幂等重复和
  下载 SHA-256 均通过。R2/B2 预留计数分别为 66,610/1,074 B；未手改 D1 会话时间。
- [x] 16:55:35（Asia/Shanghai）的真实 `*/5 * * * *` Cron outcome 为 `ok`，无 exception/应用日志；
  六个旧 session 均变为 ABORTED，旧物理 key 全部返回 404。新 READY 文件内容不变，B2 已 DELETED
  对象的历史 EXPIRED 尝试同样得到清理。
- [x] 两个 Provider 的 ABORTED 当前尝试均可重新上传 1 KiB 文件，保持同一 object/key；新旧尝试
  隔离、complete 幂等和 SHA-256 均通过，账号/测试 shard 逻辑计数分别为 R2 67,584 B、B2 2,048 B。
- [x] 六个逻辑对象均进入 DELETED，重复删除幂等；两个测试 shard 均转为 RETIRED，原账号与测试
  shard 的 usedBytes 均回到 0。十二个新旧物理 key 均返回 404；logical bucket、tombstone、session、
  location 与审计 metadata 保留用于追踪，不直接删除 D1 记录。
- [x] 六个旧 session 为 ABORTED/非 current，六个新 session 为 COMPLETED/current，每对象保留唯一
  primary；本次 B2 六个物理 key 的 13 个 upload/hide versions（67,788 字节）已永久删除，逐 key
  list versions 确认无残留。仅使用已有 bucket-scoped key 和精确 key allowlist，未扩大权限或删除其他文件。
- [x] 17:00:35（Asia/Shanghai）的下一轮 Cron outcome 为 `ok`、无 exception/应用日志；结束后复查，
  51 条对象审计事件全部 DELIVERED（首次收尾查询 32 条已投递）。六次成功 retry 各有唯一事件，
  pending/delivered 合并查询在投递前后均可见且无重复，所有先前观察到的 event id 保持不变。
- [x] 原有十条 object 的 ID、状态、大小和 updatedAt 与 smoke 前完全一致；两个原账号仍为 ACTIVE，
  配置/credential 未变更，逻辑用量回到测试前的 0。

## 边界

浏览器扩展未连接，按 WebBridge 技能约定跳过额外浏览器交互检查；不将 HTTP 静态资源验证称为
浏览器回归。本次为小文件 control API/Provider 集成验收，不是压力测试、multipart 或所有故障注入。
Generic S3、production、备份恢复和共享 Provider 凭据故障注入不在范围内。

## 本次仓库交付

升级使用已提交的 `9a408dc`，本次没有改动应用代码或 migration SQL；只更新验收证据、发布状态和
API Key 权限文档。文档变更没有新增功能测试要求；升级前及验收期间均通过完整 `npm run verify`
（482 个测试、Oxlint、typecheck 和全部构建），另核对 Markdown 本地链接及 `git diff --check`。
只做本地 Conventional Commit，不 push。
