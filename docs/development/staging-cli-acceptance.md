# Staging 对象 CLI 验收（2026-09-03）

## 范围与隔离

- 所有者在对象 CLI 首版完成后明确要求继续下一步 R2/B2 staging CLI 实测。
- Git 基线为 `a419fac`，Node.js 为 `22.23.2`。运行真实构建产物 `apps/cli/bin/openpool.mjs`，
  连接既有 staging Worker 和既有 R2/B2 隔离物理 Bucket；未部署、执行 migration 或直接改写 D1。
- 复用既有测试 logical bucket/ACTIVE shard，不创建或改变 Storage Account、Provider credential、
  Bucket 配置或 shard 生命周期。每轮使用随机独立 logical key 前缀。
- 管理员凭据仅由 macOS 钥匙串注入测试管理进程，用于创建和撤销短期 API Key。CLI 子进程只收到
  限定单 Bucket/测试前缀、最长一小时的 API Key；不接收管理员 Cookie 或 Provider credential。
- 测试观察层检查真实 Fetch 参数和控制请求正文大小；仅通过私有进程通信关联签名传输，完整
  signed URL 不进入日志、证据文件或仓库。故障注入只影响指定 CLI 进程，不改变远端服务或共享凭据。

## 正式完整流程

2026-09-03 10:28–10:29（Asia/Shanghai）R2 与 B2 各完成以下流程：

| 场景 | 文件大小 | 验收结果 |
| --- | ---: | --- |
| 正常上传/下载 | 1,048,593 B | READY、元数据与 SHA-256 一致，含中文和空格的 logical key 保持不变 |
| complete 响应丢失 | 32,771 B | 远端 complete 成功后本地丢弃响应；同 object/session 再次 complete 返回 `alreadyCompleted: true`，无需重传 |
| PUT 前中断后显式 retry | 原声明 32,771 B，替换 16,395 B | 旧 PUT 未发送，首次 complete 返回 `PROVIDER_NOT_FOUND`；新 session/物理 key 独立，object ID/key 不变，可修改 size/contentType，下载哈希一致 |

- [x] `upload`、`stat`、`upload-status`、`complete`、`retry`、`list`、`download`、`delete` 全部实测。
- [x] `complete` 可显式重复；旧 session complete 返回 `OBJECT_UPLOAD_NOT_FOUND`，过时 expected
  session retry 返回 `OBJECT_CONFLICT`，已完成 session retry 被拒绝。
- [x] 每 Provider 三个对象按 `limit=2` 分两页列出，游标正确、无重复；未传 prefix 时服务端仍应用
  Key 的路径限制。普通上传不能覆盖 READY 或复用 DELETED 路径。
- [x] 目标文件已存在时，下载在发起网络请求前返回 `OUTPUT_EXISTS`，原文件哈希不变；新下载文件
  权限为 `0600`，字节数与 SHA-256 均与源文件一致。
- [x] upload-only Key 可完成上传、状态查询、显式 retry 和 complete，但不能读取对象 metadata；
  跨 Bucket 和跨 path prefix 请求返回 `403 FORBIDDEN`。四个正式验收 Key 撤销后均返回
  `401 UNAUTHORIZED`。
- [x] 观察到 78 次控制 API 请求，单次正文最大 243 B；六次真实 Provider PUT、六次真实 GET。
  两个 Provider 各注入一次 PUT 前中断和一次 complete 响应丢失。控制请求携带 API Key，直传/直取
  不携带 Authorization/Cookie/referrer，均拒绝重定向，对象字节未发送给 Worker。
- [x] 六个正式测试对象删除及重复删除均成功；删除后使用先前签发的 GET URL 直读 Provider，全部
  返回 404。每个对象的 reserve/complete/delete 审计可查询，retry 各只有一个成功事件，无重复 ID。
- [x] CLI stdout/stderr 和对象审计中未发现本次 token、Cookie、signed URL 或 Provider 响应正文。

## 测试脚本修正与累计清理

正式通过前，两轮 R2 试跑分别遇到验收脚本的错误码预期写错，以及复用本地输出路径。
应用分别按契约返回 `OBJECT_UPLOAD_NOT_FOUND` 和 `OUTPUT_EXISTS`；修正预期、为每轮生成独立
本地目录后重新完整执行。没有因此修改 CLI、SDK、Worker 或测试代码。

- 累计产生十个测试逻辑对象（正式六个、试跑四个），全部进入 DELETED；八个临时 API Key 全部
  撤销。三轮执行器的管理员 session 均通过 `DELETE /api/v1/auth/session` 撤销并确认失效。
- 原有十六条 object 的 ID、metadata 和 updatedAt 保持不变；原 Account 配置、状态及 shard 状态
  未改变，账号和 shard 逻辑用量均恢复到开始时的 0。容量写入导致的 updatedAt 不作为配置变更。
- 10:32 的只读 D1 检查确认十个测试对象均 DELETED，十三个 location 精确对应本次 allowlist；
  不直接删除 object/session/location/audit metadata。
- B2 三次实际 PUT 的六个 upload/hide versions，共 1,097,759 B，已使用既有单 Bucket 受限 Key
  永久删除；四个本次 B2 physical key 逐一列版本确认当时无残留。先删除内容版本再删除 hide marker，
  避免清理途中重新暴露旧版本。凭据仅在清理进程内按现有 vault 格式解密，未落盘、输出或扩大权限。
  版本清理语义依据 [Backblaze 文件版本列表](https://www.backblaze.com/apidocs/b2-list-file-versions)
  与[删除指定版本](https://www.backblaze.com/apidocs/b2-delete-file-version)。

## 尚未观察到的后台收敛与边界

- 10:32 检查时，三个旧失败 session 均为 EXPIRED、非 current，原签名分别在 10:41:58、10:43:46、
  10:44:16 到期。这些旧 PUT 被测试观察层在发送前阻止，没有上传字节，容量已释放。
  仍需原签名到期后再过五分钟 grace，才由正常 Cron 删除旧位置并转为 ABORTED；本轮不提前清理、
  不手改时钟或 D1 状态，也不把此前 Cron 验收替代为本轮完成证据。
- 后续 Cron 对未写入的 B2 旧位置执行删除时，可能留下零字节 hide marker；10:32 的版本清理结果
  仅表示当时无残留，不承诺未来也没有标记。这不影响本次逻辑容量或已完成的文件哈希验收。
- 10:32 的对象 outbox 快照为 30 条 DELIVERED、21 条 PENDING；合并审计查询已验证可见与去重，
  但没有在本轮等待全部投递完成。
- 单独只读预检的临时管理员 session 因脚本误用登出路径未撤销；其 token 仅存在于已结束进程，
  未落盘或输出，将按默认八小时有效期过期。没有为清理该记录直接改写 D1；后续正式执行器已使用
  正确的 DELETE session 接口。
- 这是小文件真实 CLI 集成验收。故障为客户端精确注入，不代表 Provider 故障、真实半包传输、
  浏览器回归、压力/长时间测试、multipart、Generic S3 或 production 验收。

## 本次仓库交付

只更新验收记录与文档状态，未修改应用或数据库 schema。文档变更没有新增功能测试要求；
本轮仍运行完整 `npm run verify`，582 个测试（根 169、Worker 306、migrator 7、CLI 100）、
Oxlint、类型检查和全部构建均通过，Worker 构建仅 dry-run。提交前另核对文档链接和
`git diff --check`。仅本地 Conventional Commit，不 push。
