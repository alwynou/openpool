# Staging CLI 50 MB 验收（2026-09-03）

## 范围

所有者明确指定大文件测试以 **50 MB（50,000,000 字节）** 为限，不跑 100 MiB。
Git 基线为 `bf978d4`，在其上新增[可重复 smoke 脚本](cli-smoke.md)，运行构建后的 Node CLI。
本次使用 Node.js 22.23.2 / Undici 6.28.0、既有 staging Worker 和隔离 R2/B2 测试资源；
没有部署、执行 migration、直接修改 D1 或操作 production。CLI、SDK 和 Worker 的业务实现未变。

每 Provider 使用一个限定 logical bucket/随机父前缀、有效期一小时的 API Key，CLI 只收到该 Key，
不接收管理员 Cookie 或 Provider credential。管理员凭据仅在仓库外管理进程中由钥匙串注入，
用于创建/撤销 Key 和比较前后状态；不写报告或仓库。随机测试字节在本地逐块生成，直接传输 Provider。

## 实测结果

2026-09-03 11:07–11:11（Asia/Shanghai），R2 和 B2 均通过：

- 1,000,000 字节基线与 50,000,000 字节文件的上传、READY 元数据、下载字节数/SHA-256、删除。
- 对已存在路径下载返回 `OUTPUT_EXISTS`，没有网络请求，原文件哈希不变。
- 下载部分内容后 SIGINT，退出码 130；最终路径和 `.openpool-download-*` 临时目录均无半成品。
  显式重新完整下载的大小、SHA-256 与源文件一致。
- 上传部分 socket 写入后 SIGINT，退出码 130；查询旧 session、显式 retry，保持同一 object ID/key，
  使用新 session，重新完整上传及下载校验通过。同一 session 再 complete 返回 `alreadyCompleted: true`。
- 三个对象/Provider 删除成功，重试对象的重复删除也成功；没有盲目覆盖或自动重跑。

| Provider | 50 MB 上传耗时 | 50 MB 下载耗时 | 上传中断观测值 | 下载中断观测值 |
| --- | ---: | ---: | ---: | ---: |
| R2 | 17.593 s | 16.779 s | 1,048,604 B | 1,015,808 B |
| B2 | 21.586 s | 18.237 s | 1,048,604 B | 1,001,341 B |

耗时是单个 CLI 命令从启动到退出，包含控制请求，不能视为纯网络吞吐基准。
上传中断值来自本机 socket 写入计数估算（含诊断/协议计数差异），不是 Provider 已确认接收或持久化的
精确 payload 长度。中断前未观察到 `bodySent`；下载中断值是实际 response body 读取字节。
这是已开始真实传输后的客户端取消，不是物理断网、Provider 故障或断点续传。

32 个 CLI 子进程共观察到 48 次控制请求，最大正文 289 B；8 次 Provider PUT（其中 2 次中断）、
10 次 Provider GET（其中 2 次中断）。这些统计不包含父进程的 health、清理、管理员或 B2 版本检查。
控制面只接受受限 Key 和小型 JSON；直传/直取没有 Authorization/Cookie/referrer，均拒绝重定向。
没有把文件字节发送给 Worker，报告没有保存 signed URL、凭据或对象内容。

## 内存观察

每条 CLI 命令为独立子进程，起始 RSS 约 43 MB；25 ms 采样的观测峰值如下，单位均为十进制 MB：

| Provider / 命令 | 1 MB 文件峰值 RSS | 50 MB 文件峰值 RSS |
| --- | ---: | ---: |
| R2 上传 | 82.7 MB | 99.6 MB |
| R2 下载 | 85.2 MB | 96.2 MB |
| B2 上传 | 82.3 MB | 96.5 MB |
| B2 下载 | 85.2 MB | 94.2 MB |

包含显式重试在内，本轮最大观测 RSS 为 100,745,216 字节。文件从 1 MB 增大到 50 MB 时，本轮普通
传输峰值增加约 9–17 MB；实现仍为 file-backed Blob 上传和流式下载，没有引入整个文件读入内存。
RSS 包括 Node/TLS/Fetch 缓冲，不含测试父进程；单次采样不能证明固定内存上界或代表并发/长期表现。

## 清理与隔离核对

- 六个本轮逻辑对象全部 DELETED，八个 location 精确对应本轮对象；不删除 object/session/location
  或 audit metadata。两个临时 API Key 已撤销，继续使用均返回 401；管理员 session 已经
  `DELETE /api/v1/auth/session` 撤销并确认失效。
- 开始时已有的 26 个对象 metadata/updatedAt 保持不变。Account、Bucket、shard 配置及生命周期
  状态未变；账号/shard 用量均回到原有的 0，仅容量更新导致的 updatedAt 不作为配置变更。
- 两轮测试的本地 fixture、完整下载、部分下载目录均已移除，仅保留私有、脱敏报告。
- 11:14 的只读检查确认两个旧 session 均 EXPIRED、非 current，签名在 11:23:23 和 11:25:30 到期，
  仍需正常五分钟 grace 和 Cron。此时对象 outbox 为 34 条 DELIVERED、2 条 PENDING；B2 四个本轮
  physical key 中有六个 upload/hide versions，共 101,000,000 字节。

- 11:30 的只读跟进中，36 条已有对象 outbox 全部 DELIVERED，两个旧 session 尚为 EXPIRED。
  11:36 再核对时，两者均已由正常 Cron 转为 ABORTED、非 current；新增两条 abort 后的全部
  38 条对象 outbox 均 DELIVERED。没有提前修改时间或 D1 状态。
- 待上述后台收敛后，使用既有单 Bucket 受限 B2 Key，按本轮六个 object / 八个 location 映射
  解析出四个 B2 physical key。只永久删除它们的七个 upload/hide versions（含 Cron 后新增的
  零字节 hide marker），共 101,000,000 字节；先删内容版本再删 hide marker，逐 key 复查均无残留。
  此操作不可恢复，未更改 Bucket 生命周期或扩大权限。版本语义依据
  [B2 文件版本列表](https://www.backblaze.com/apidocs/b2-list-file-versions)和
  [删除指定版本](https://www.backblaze.com/apidocs/b2-delete-file-version)。凭据仅在清理进程内按现有
  vault 格式解密，不落盘或输出。
- 清理后再次只读核对所有 Account/shard 的数量、状态和用量，与本轮 baseline 一致。旧尝试已
  ABORTED，本轮没有待执行的旧位置删除，不再预留“未来可能出现 hide marker”的未检查项。

本轮文件、临时 Key、旧上传尝试、审计投递与 B2 历史版本均已完成收尾；不以逻辑删除或容量归零
替代物理版本检查。

## 仓库交付与边界

新增显式 opt-in 的 `npm run smoke:cli`，支持最多 50 MB、独立命名空间、实际 CLI 子进程、部分传输
SIGINT、显式 retry、哈希、内存/传输数值报告及有界清理。帮助、参数、观察边界、完整假客户端流程和
失败清理使用离线测试覆盖；日常 verify 不触发远端 smoke。

随后按独立复核建议，对 IPC 观测增加字段白名单、数值范围和逐命令请求计数校验；对已保存的全部
32 条真实命令观测用最终校验器离线复核通过，没有为这项报告校验改动重复制造远端测试文件。
最终完整 `npm run verify` 通过：654 个测试（根 169、Worker 306、migrator 7、CLI 172）、Oxlint、
所有 workspace 类型检查及全部构建。Worker 构建仅 dry-run。提交前核对文档链接和 `git diff --check`，
仅本地 Conventional Commit，不 push。

此结果补充[小文件 CLI 验收](staging-cli-acceptance.md)，不替代其中的权限、分页和 complete 响应丢失
验收，也不代表 Generic S3、浏览器交互、multipart、并发/压力/长期测试、公开 npm 发布或 production。
