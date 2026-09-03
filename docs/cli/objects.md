# OpenPool 对象 CLI

OpenPool 对象 CLI 是 Node.js 22+ 的 workspace-private 工具，用于通过现有对象 API
列出、查看、上传、下载、完成和删除对象。它不是 npm 公共包，也不会自动发布、部署或执行
远端迁移。

## 安装与运行

在仓库根目录构建 CLI：

```bash
npm run build --workspace=@openpool/cli
```

构建后可以使用 workspace 命令或构建产物：

```bash
npm run --silent openpool -- <command> [options]
node apps/cli/dist/cli.js <command> [options]
```

CLI 只从环境变量读取 API Key。不要把真实 token 放在命令行、shell 历史、脚本参数或日志
中；在 Bash/Zsh 中可以静默输入后再导出环境变量（粘贴 token 后回车）：

```bash
read -r -s OPENPOOL_API_KEY
export OPENPOOL_API_KEY
export OPENPOOL_BASE_URL='https://openpool.example.com'
```

使用完后可执行 `unset OPENPOOL_API_KEY` 清理当前 shell 的变量；CLI 本身不保存它。

也可以在当前进程环境中安全注入 `OPENPOOL_API_KEY`。`--api-key` 和 `--cookie` 均不支持。
CLI 不实现管理员登录，不读取或保存 `openpool_session` Cookie，也不提供 API Key 管理。

`OPENPOOL_BASE_URL` 可由命令行的 `--base-url` 覆盖。远程控制面必须使用 HTTPS；只有
`localhost`、`127.0.0.1` 和 `::1` 允许使用 HTTP。URL 不应包含凭据、路径、查询或片段。

所有非帮助命令都有：

```text
--base-url URL       或 OPENPOOL_BASE_URL
--timeout-ms MS      默认 300000，范围 1..86400000
```

## 命令

```text
list          --bucket ID [--prefix KEY] [--after-key KEY] [--limit 1..1000] [--status STATUS]
stat          --object ID
upload        --bucket ID --key KEY --file PATH [--content-type TYPE]
upload-status --object ID
complete      --object ID --session ID
retry         --object ID --session ID --bucket ID --key KEY --file PATH [--content-type TYPE]
download      --object ID --output PATH
delete        --object ID
```

`help`、`--help`、`-h` 或不带参数会打印帮助并返回成功。对象 ID、Bucket ID 和 session ID
是 API 标识；它们不能包含首尾空白或控制字符。上传的 `--key` 会保留用户提供的空白，
但不能为空、全为空白或包含 ASCII 控制字符。上传内容类型默认为 `application/octet-stream`，
显式值不能含首尾空白或非 ASCII 可打印字符，避免与服务端签名规范化结果不一致。

### list

`list` 使用 `objects:list` scope，默认每次请求 100 个对象，最多 1000 个。支持状态
`PENDING`、`READY`、`DELETING`、`DELETED`，以及字面前缀和稳定排序游标：

```bash
npm run --silent openpool -- list \
  --bucket bucket-id --prefix reports/ --limit 1
```

输出是安全 JSON：

```json
{"data":[{"id":"object-id","logicalBucketId":"bucket-id","logicalKey":"reports/a.pdf","sizeBytes":123,"contentType":"application/pdf","checksum":null,"status":"READY","createdAt":"...","updatedAt":"..."}],"nextAfterKey":"reports/a.pdf"}
```

每次只返回一页，不是跨请求的快照。`nextAfterKey` 是 continuation hint：当返回数量达到
请求的 limit 时，使用它作为下一次请求的 `--after-key`；否则为 `null`。列表响应只包含
逻辑对象元数据，不暴露 Provider、物理 key 或凭据。

### stat 与 upload-status

`stat` 使用 `objects:read` scope，返回一个对象的逻辑元数据：

```bash
node apps/cli/dist/cli.js stat --object object-id
```

`upload-status` 使用 `objects:upload` scope，返回当前上传 session 的摘要（`PENDING`、
`COMPLETED`、`EXPIRED` 或 `ABORTED`）。它不返回 signed URL 或物理位置：

```bash
node apps/cli/dist/cli.js upload-status --object object-id
```

### upload

`upload` 使用 `objects:upload` scope，并严格执行：

```text
检查本地普通文件 → reserve → Provider signed PUT → complete
```

文件以流式、file-backed Blob 方式发送；对象字节不会经过 Worker。reserve 成功后，CLI 会
在 stderr 输出安全的 `upload-reserved` JSON 回执，其中只有 Bucket、logical key、object ID
和 upload session ID，不包含 signed URL。

例如上传本地文件：

```bash
node apps/cli/dist/cli.js upload \
  --bucket bucket-id --key reports/a.pdf --file ./a.pdf --content-type application/pdf
```

回执示例：

```json
{"event":"upload-reserved","bucketId":"bucket-id","logicalKey":"reports/a.pdf","objectId":"object-id","uploadSessionId":"session-id"}
```

成功完成的结果 JSON 写入 stdout。reservation、PUT 或 complete 任一步失败时，stderr 的错误
JSON 会带上 `upload.phase`（`INSPECT`、`RESERVE`、`PUT` 或 `COMPLETE`）、已知对象/session
标识和安全恢复提示；不会写出 API Key、Cookie、signed URL、Provider 响应正文或本地文件内容。

如果 PUT 可能已经成功但 complete 响应丢失，先使用回执中的同一 object/session 调用
`complete`：

```bash
node apps/cli/dist/cli.js complete \
  --object object-id --session session-id
```

reserve 阶段失败时，先用 `list` 检查 logical key，再决定是否重新发起上传；不要把未知的
reserve 请求当作可安全重放。

### complete

`complete` 使用 `objects:upload` scope，带上预期的 object ID 和原 upload session ID。该
操作可显式重复，用于确认 PUT 成功但上一次 complete 响应不明的上传。它不会创建新 session，
也不会重新发送文件。

### retry

`retry` 是显式的新上传尝试，使用 `objects:upload` scope，必须同时提供：

```text
--object OBJECT_ID --session EXPECTED_SESSION
--bucket BUCKET_ID --key LOGICAL_KEY --file PATH [--content-type TYPE]
```

CLI 会先查询当前 session，并要求它仍等于 `--session`；session 已被其他尝试替换时返回
冲突，不会盲目抢占。当前 session 已为 `COMPLETED` 时也会拒绝替换。通过检查后，CLI 将
`retryUploadSessionId` 发送给控制面，使用返回的新 signed URL/session 执行 PUT 和 complete。

重试不能覆盖 `READY`、`DELETED` 或其他不可重试状态，CLI 不会自动重试、自动创建下一次
尝试或复用旧 signed URL。响应不明时，先用 `upload-status` 检查状态；PUT 成功可能只需要
对原 session 执行 `complete`。

### download

`download` 使用 `objects:read` scope，先检查对象为 `READY`，再取得 signed GET 并从
Provider 流式下载：

```bash
node apps/cli/dist/cli.js download \
  --object object-id --output ./reports/a.pdf
```

现有输出路径会立即拒绝，永远不会覆盖。下载内容先写入输出目录中的 CLI 私有临时目录；
临时内容文件权限为 `0600`，输出的父目录必须已存在。CLI 会将实际字节数与对象声明的大小比较，
并计算 SHA-256 供调用方与原文件校验；不将 Provider 的不透明 ETag/checksum 当作可信 SHA-256。
校验通过后，在同一文件系统中使用 hard-link 原子发布；并发创建目标文件也会失败而不会
覆盖。传输、校验或发布失败都会清理临时目录和部分文件。

成功输出包含 `objectId`、最终输出路径、`bytes` 和 `sha256`。signed URL 只在内存中用于
这一次 Provider 请求，不会出现在 stdout、stderr、错误、JSON 或命令行参数中。

### delete

`delete` 使用 `objects:delete` scope，删除指定对象并要求控制面返回 `DELETED` 元数据：

```bash
node apps/cli/dist/cli.js delete --object object-id
```

删除请求不会自动重试；如果请求结果不明，用户可以根据对象状态显式重新执行。服务端对
Provider 404 和容量释放提供幂等处理，但 CLI 不替用户重放请求。

## Scope 与数据边界

| 命令 | 所需 API Key scope | 控制面操作 |
| --- | --- | --- |
| `list` | `objects:list` | 列出 Bucket 对象 |
| `stat` | `objects:read` | 读取对象元数据 |
| `download` | `objects:read` | 读取元数据、取得 signed GET；正文直取 Provider |
| `upload` | `objects:upload` | reserve、signed PUT、complete |
| `upload-status` | `objects:upload` | 查询当前 upload session |
| `complete` | `objects:upload` | 完成同一 upload session |
| `retry` | `objects:upload` | 查询 session、显式创建新尝试、signed PUT、complete |
| `delete` | `objects:delete` | 删除对象 |

API Key 应限制到所需的 Bucket 和 path prefix，并使用最小 scope。CLI 不支持管理员登录、
管理员 session、Storage Account/Bucket/Shard 管理、API Key 管理、audit-log 查询、远端
Shard Migration、自动重试或 READY/DELETED 路径覆盖。

## 输出与退出码

成功结果和帮助写 stdout；上传 reservation 回执及错误写 stderr。帮助为纯文本，其余输出采用 JSON，错误
只保留稳定错误 code、通用 message、必要的 HTTP status/request ID，以及上传阶段恢复信息。
不会输出 token、Cookie、Authorization header、signed URL、Provider 错误正文或对象内容。

| 退出码 | 含义 |
| ---: | --- |
| `0` | 成功 |
| `1` | 对象 API、Provider、协议、文件或其他操作失败 |
| `2` | 参数、环境或配置错误 |
| `124` | `--timeout-ms` 超时 |
| `130` | 收到 SIGINT（通常为 Ctrl-C） |
| `143` | 收到 SIGTERM |

超时或信号不会自动重试上传。stderr 会给出安全的 `upload.phase` 和下一步检查提示；根据
阶段执行 `upload-status`、同 session 的 `complete`，或用户明确发起 `retry`。增加 timeout 不会延长
服务端签名的有效期，也不提供 multipart 或断点续传。SIGKILL、断电等无法捕获的退出可能留下
`.openpool-download-*` 临时目录；确认对应进程已结束后再清理，目标文件仍不会被半成品替代。

## 验收边界

2026-09-03 本地验收通过：`npm run verify` 完成 Oxlint、所有 workspace 类型检查、
582 个测试和全部构建，其中 CLI 有 100 个测试。覆盖实际本机 HTTP 连接上的二进制文件
往返、complete 响应断开后的同 session 恢复、显式 retry、下载防覆盖与失败清理，以及
构建产物的超时、SIGINT/SIGTERM 和输出管道关闭处理。Worker 构建仅执行 dry-run。

本轮 CLI 验证仅覆盖本地模拟网络和文件系统测试；未获授权执行真实 Provider smoke、远端
部署、远端迁移或数据库迁移，因此本文不宣称真实 R2、B2 或 S3-compatible Provider 验收。
