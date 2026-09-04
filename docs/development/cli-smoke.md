# 可重复执行的 staging CLI smoke

这是需要明确授权的真实写入测试，不属于 `npm run test` 或 `npm run verify`。
只操作指定 logical bucket 内本轮随机前缀，执行构建后的真实对象 CLI；不部署、执行 migration、
登录管理员或保存凭据。对象及传输契约见[对象 CLI](../cli/objects.md)。

## 准备与执行

1. 先确认本轮 staging 写入、删除测试文件和流量费用已获授权；不要使用 production Bucket。
2. 使用已有、正常的测试 Bucket/ACTIVE shard，确认 Provider 与逻辑容量足够。
3. 由管理员创建短期 API Key，限制到该 Bucket 和独立父前缀，例如 `cli-smoke/`；需要
   `objects:list`、`objects:read`、`objects:upload`、`objects:delete` 四个 scope。
   通过安全注入设置 `OPENPOOL_API_KEY`，不要把 token 放入参数、脚本、历史、报告或聊天。
4. 设置非敏感的 `OPENPOOL_BASE_URL`，使用 Node.js 22+，预留至少 250 MB 临时磁盘空间。

```bash
npm run smoke:cli -- --help
npm run smoke:cli -- --allow-remote-writes --bucket test-bucket-id \
  --prefix cli-smoke/ --size-mb 50
```

`--base-url` 可替代 URL 环境变量，必须是 HTTPS 根地址（只有 loopback 允许 HTTP）。
默认且最大的文件大小为 **50 MB = 50,000,000 字节**；`--size-mb` 接受 1–50 的整数，
不是 MiB。脚本还会生成 1,000,000 字节的基线文件。无参数或单独请求帮助不会访问网络；
缺少 `--allow-remote-writes` 会拒绝执行。健康接口必须明确返回 `environment: staging`，
但该检查不替代操作者对目标 URL 和资源隔离的确认。

每轮在父前缀下追加 UUID，不复用旧路径。API Key 的 prefix 必须覆盖这个子目录。
R2/B2 分别运行一轮；脚本不自动选择 Provider、更改 placement 或创建账号/资源。
50 MB 一轮正常流程约上传 101 MB、下载 151 MB，另加两次中断的部分流量；实际费用依 Provider 而定。

## 验收内容

- 1 MB 基线与指定大小的随机二进制文件上传、READY 元数据、下载字节数和 SHA-256、删除。
- 拒绝覆盖已存在的下载路径，并确认原文件哈希不变。
- 下载部分内容后仅向对应 CLI 子进程发送 SIGINT，验证退出码 130、无输出半成品或下载临时目录；
  再显式从头下载并校验。
- 上传已有部分 socket 写入后中断，查询当前 session，再显式 retry；要求 object ID 不变、
  session ID 改变，重新完整上传/下载并校验。不自动重试，也不是 multipart 断点续传。
- 同一已完成 session 的 complete 与已删除对象的 delete 可显式重复。
- CLI 控制请求仅有受限 API Key 和小型 JSON；Provider 直传/直取不携带 API Key、Cookie 或 referrer，
  所有请求拒绝重定向。每个 CLI 子进程单独记录耗时、RSS 和请求计数，不记录签名 URL/headers。

故障观察层只在中断上传时对原 file-backed Blob 的读取节奏限速，保留真实 Content-Length 和
Provider PUT；普通上传/下载不改变 body。上传中断依据 Undici `sendHeaders` 的 socket 写入计数，
并排除已触发 `bodySent` 的完整发送。该数字是本机 socket 写入观测，不是 Provider 确认接收或
持久化的字节数。下载中断依据实际读取的 response body 字节数；两者都不代表物理断网或 Provider 故障。
诊断接口具有版本相关性，缺少观测时测试失败，不把“已中断”当作成功。
参考 [Undici 6.28 诊断接口](https://raw.githubusercontent.com/nodejs/undici/v6.28.0/docs/docs/api/DiagnosticsChannel.md)。

RSS 以 25 ms 采样，记录子进程起始值和观测峰值，包含 Node/TLS/Fetch 开销、不含父测试进程。
1 MB 与 50 MB 的单次结果仅用于发现明显异常；不设跨机器内存阈值，也不能据此证明固定内存上界。

## 报告与清理

stdout 输出安全的逐步 JSON 和最终 `smoke-result`，其中给出 `reportPath`。报告保存在独立私有
临时目录，权限 `0600`；包含本轮前缀、对象/session ID、检查、耗时、数值观测及待清理项，
不含 token、signed URL、Cookie、Provider credential 或对象内容。

成功与失败都会尝试清理：精确列出本轮 UUID 前缀，核对 Bucket/路径，删除 READY/DELETING 对象；
不对不明对象操作、不强制完成 PENDING 上传。若列表截断或 reservation 回执无法对上列表，
报告失败而不是推断已清理。由本轮创建的本地 fixture/download 子目录会移除，报告保留。
当前 PENDING 对象或远端清理失败会令整轮失败；先检查报告，不要盲目重跑。

`PASSED` 只表示规定的同步检查通过，不代表以下后台或运维动作完成：

- 显式 retry 的旧 session 仍由正常签名到期 + 五分钟 grace + Cron 清理。报告保留其 session ID
  和 expiry，`OLD_ATTEMPT_AWAITS_CRON` 必须后续核对，不手改 D1 状态或缩短时钟。
- B2 等版本化 Bucket 的 S3 DELETE 可能保留 upload version/hide marker。管理员须按本轮对象映射
  精确检查，获得删除授权后先删内容版本、再删标记；等旧 session ABORTED 后复查新产生的标记。
  不能以逻辑用量归零替代物理版本检查，不能清空整个共享 Bucket。
- 撤销临时 API Key、核对原有对象/配置/容量、审计投递由操作者单独完成；脚本没有管理员权限。

收到外层 SIGINT/SIGTERM 会取消当前子进程并尝试清理；SIGKILL、断电或权限过期无法保证自动清理。
每条命令有有界超时，取消后给予五秒退出宽限再停止该子进程。报告中的剩余对象应通过正常 API/Cron
处理；不要直接删除 D1 metadata。报告目录属于临时证据，长期留存前应另行脱敏并妥善保存。
