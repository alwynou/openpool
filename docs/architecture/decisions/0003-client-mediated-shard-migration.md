# ADR 0003：Shard migration 使用客户端直传

- 状态：Accepted
- 日期：2026-09-01

## 背景

Account drain 必须在停止新 placement 后，把既有对象从源 shard 搬到健康、可写且容量足够的目标
shard。R2、B2 与 Generic S3 没有一个能覆盖跨 Provider、跨账号复制的共同服务端 API；让 Worker
读取源对象并写入目标 Provider 又会违反 [ADR 0001](0001-control-plane-data-plane.md) 的控制面/数据面
分离，并受到 Worker 内存、时长和带宽限制。

仅把 shard 标为 `MIGRATING` 也不等于完成迁移：系统仍需持久化任务进度、为目标位置预留容量、
校验复制结果、原子切换 primary location，并在切换后幂等清理源对象。

## 决策

Shard migration 的通用基线采用持久化控制面任务和客户端数据搬运器：

1. Worker 创建可恢复的 migration 及对象级任务，并为每个目标副本预留容量；
2. Worker 只向已认证的搬运器返回短期源签名 `GET` 与目标签名 `PUT`；
3. 搬运器把对象字节从源 Provider 直接流向客户端再流向目标 Provider，字节不经过 Worker；
4. 搬运器报告传输完成后，Worker 对目标执行 `HEAD`，校验大小及可用 checksum；
5. D1 在一个条件事务中把已验证目标位置设为 primary，并保留源位置用于可重试清理；
6. Worker 删除源 Provider 对象成功后，D1 幂等释放源 shard/account 容量并完成对象任务；
7. 所有对象任务完成且源引用、容量和进行中上传均清空后，migration 才能完成并退休源 shard。

Account `ACTIVE → DRAINING` 会立即停止该账号的新 placement，但不会破坏既有对象的下载、完成上传
或删除。迁移开始时，源 `ACTIVE` shard 与目标 `STANDBY` shard 必须用同一条件事务切换为
`MIGRATING` 与 `ACTIVE`，使新上传在迁移期间进入目标 shard。

Provider 原生 copy 可以在未来作为 capability-gated 优化，但不能成为通用语义，也不能改变上述
校验、primary 切换、容量和恢复边界。

## 故障与重试语义

- 目标未校验前，源位置始终是唯一 primary；复制或校验失败不会影响读路径。
- 目标已写入但 D1 切换失败时，任务保留目标位置并通过 `HEAD` 重用或清理，不重复预留容量。
- D1 已切换但源删除失败时，目标继续作为 primary，后台或搬运器只重试源清理，不回退位置。
- claim 使用租约和版本条件更新；租约过期可接管，同一对象最多有一个活动任务。
- 迁移期间源与目标同时占用实际容量，因此计数采用双预留；只有源清理成功才释放源计数。
- `PENDING`、`DELETING` 或状态并发变化的对象不切换，迁移保持可恢复/阻塞状态并明确报告。

## 安全边界

- 签名 URL 只在 claim 响应出现，不写入 D1、audit、日志或 Web query cache。
- credential 仍只在 Worker 内解密并用于签名或 Provider metadata/delete 操作，不交给搬运器。
- migration 控制 API 只允许管理员 session；未来 CLI 使用单独、最小权限且可撤销的搬运授权，不能
  复用普通对象 API Key 权限。
- signed transfer 必须绑定精确方法、key、大小和 content type，并使用短 TTL。

## 后果

需要新增 migration 与对象任务模型、D1 migration、条件 repository、签名 claim/complete API、
scheduled cleanup、管理界面，以及能够流式传输并设置精确 `Content-Length` 的客户端/CLI。迁移不会
成为单个同步 HTTP 请求，也不能只靠现有 shard 状态下拉框实现。

这一选择允许跨 R2、B2 与 Generic S3 迁移，同时保持逻辑 key 稳定和 Worker 无对象字节。代价是
迁移需要一个在线数据搬运器；纯 Provider-to-Provider 的无人值守复制不是通用保证。
