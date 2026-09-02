# Staging 0004/0005 升级验收（2026-09-02）

## 授权与范围

- 项目所有者明确授权 staging 数据库升级、部署和 R2 ↔ B2 真实 shard migration smoke。
- 所有者确认现有 staging 数据不重要，并明确要求跳过本次备份；未执行 export 或恢复。
- 只使用既有独立 APAC staging D1、Worker 和隔离 Provider Bucket。未修改 production，也未执行
  本地持久化 D1 migration。未来有价值数据的升级仍要求受保护备份和单独授权。
- 原有两个 `ACTIVE` Storage Account 和两个 `ACTIVE` shard 保持不变。搬运测试使用新建的独立
  OpenPool 账号记录、logical bucket 与 shard，复用既有受限 Provider credential 和隔离物理 Bucket，
  不创建新的云账号，不把正常使用的 OpenPool 账号设为 `DRAINING`。
- 管理员 session 与 Provider credential 只在受控进程内使用，未写入仓库、日志、命令参数或验收记录。

## 升级证据

- [x] Git 基线 `6e3592d`；升级前 `npm run verify` 通过 440 个测试。
- [x] Wrangler OAuth 有效，目标为既有独立 staging D1；待执行列表只有 `0004`、`0005`，必要 Secret
  仍为 `CREDENTIAL_MASTER_KEY` 与 `API_KEY_PEPPER`。
- [x] 按顺序应用 0004、0005 成功；重新列出 migration history 无待办。发布后的 migration SQL 未改写。
- [x] Worker/Web 部署成功，health 为 `staging/ok`，旧管理员初始化状态、登录/session/登出及旧审计可读。
- [x] 真实 smoke 发现空 POST 在 Worker ingress 中可能是非 null 的零字节流。旧 claim route 误返回
  `400 SHARD_MIGRATION_INVALID`；修复为读取并验证实际为空，非空与读取失败仍拒绝。
- [x] 修复提交 `779e9fd`；新增 4 项回归，完整 `verify` 通过 444 个测试（根 146、Worker 291、migrator 7）。
- [x] 最终 Worker deployment version：`90969958-6c6d-4120-912c-410eb8580d37`；Cron 为 `*/5 * * * *`。

## 真实搬运与审计

- [x] B2 → R2：45 B 文本与 64 KiB 二进制文件，迁移前后 SHA-256 一致，逻辑 key/object id 不变；
  每个目标是唯一 primary，源 GET 返回 404，源容量归零，源 shard 自动进入 `RETIRED`。
- [x] R2 → B2：同规模文件，最终 SHA-256、唯一 primary、源删除、源容量归零和 shard retirement 均通过。
  首次二进制流式调用失败后任务保留为 `RESERVED`，源内容 SHA-256 仍正确；等待原租约到期后，正式
  CLI 重领并完成同一任务，`attempt_count=2`，未手工修改任务/租约，也未重复预留容量。
  首次传输失败的具体来源未留存足够诊断证据，不能推断为已修复的 Provider 缺陷；后续恢复成功。
- [x] 领取任务后源容量仍保留，目标精确预留当前对象容量；目标尚未写入时 complete 返回
  `404 PROVIDER_NOT_FOUND`，源仍可下载且未切换 primary；写入后再次 complete 成功。
- [x] 重复 complete/删除未重复释放容量；已完成方向的测试文件已删除，测试 shard 退休、测试账号
  进入 `REMOVED`，业务与审计 tombstone 保留。
- [x] 最终 2 个 migration、4 个对象任务全部 `COMPLETED`；4 个测试账号 `REMOVED`，4 个测试 shard
  `RETIRED`，测试账号/分片用量均为 0。原有两个账号、两个分片及原有 6 条对象记录保持基线状态。
- [x] 捕获到最终 Worker 版本的真实 scheduled event：outcome `ok`，无 exception 和应用日志。
- [x] 审计 outbox：先验证 20 条事件（含 4 条待投递），最终验证双向搬运和清理共 43 条相关事件
  （快照时含 10 条待投递）；下一次 Cron 后 43 条全部 `DELIVERED`，公开 ID 不变、无重复，旧 72 条
  审计保留。验收进程新建的 session 均已主动登出撤销。
- [x] 已逐 key 核对并永久删除本次 B2 测试的 8 个 upload/hide versions，涉及 4 个物理 key、
  131,162 字节；再次列出对应 key 的版本为零，未删除其他对象或历史版本。本次测试版本不可恢复。
- [x] 对本次 R2 的 4 个源/目标物理 key 重新签名并读取，全部返回 404，确认 Provider 无测试对象残留。

## 验收边界

本次不是性能/大文件/长时间压测。未人为撤销共享 Provider 权限来制造源删除失败；scheduled source
cleanup 的故障注入、租约竞争等仍由本地 Fake/Worker 测试覆盖，不能把正常 Cron 成功称为真实故障
注入验收。Generic S3、production、备份恢复演练、多副本与无人值守自动迁移不在本次验收范围。

新版 Web 静态资源已通过 HTTP 核对；本次额外浏览器目视检查因 WebBridge 扩展未连接而跳过，
不把静态资源验证声称为浏览器交互回归。核心验收通过真实 control API、Provider 请求和 Node CLI 完成。
