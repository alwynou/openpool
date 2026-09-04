# 安全模型

## Provider 凭证

用户应创建限制到目标 Bucket 和最小操作集的凭证。OpenPool 使用 AES-256-GCM 保存版本化加密
信封；master key 只存在 Cloudflare Secret `CREDENTIAL_MASTER_KEY` 中。应用用例只在即将调用
Provider 时解密，Provider adapter 不缓存明文；日志和错误不得包含 credential、签名 URL 或
authorization header。

建议的信封字段：`version`、`algorithm`、`keyId`、`iv`、`ciphertext`。AES-GCM authentication
tag 随 Web Crypto ciphertext 保存。V1 vault 使用 32 字节 master key、每次加密生成独立的 96-bit
IV，并把 `version`、`algorithm` 和 `keyId` 作为 additional authenticated data；未知版本、错误 key、
字段篡改或非 JSON credential payload 一律 fail closed。

尚处于 `VERIFYING` 的 Storage Account 可通过管理员接口纠正 Provider 配置，并按需整体替换
write-only credential。省略 credential 时保留原加密信封；替换值不会进入响应、query cache、toast、
错误或 audit metadata。该纠错路径使用账号 `updatedAt` 条件写入，并与配置、信封一起原子更新，
防止并发验证覆盖新 credential；V1 不把它扩展为已激活账号的通用 credential rotation。

Web 新增账号同样不能把完整凭据作为请求缓存的 mutation variables。明文只留在当前表单和
正在发送的请求中；取消或成功后清空，失败时仅在当前表单保留供用户修改。创建不自动重试，
同步提交保护覆盖输入校验、创建与列表刷新；关闭弹窗会丢弃未提交输入和旧错误。
本地覆盖见[账号创建回归](../development/web-account-creation.md)。

## API Key 与会话

- API Key 使用高熵随机值，数据库只保存 prefix 和带服务端 pepper 的哈希。
- Web 创建 API Key 时，raw token 只交给当前一次性展示弹窗，不作为 query/mutation data 或
  缓存回调参数；关闭或离开页面后不可恢复。创建不自动重试，同步提交锁防止重复发放。复制只有
  在剪贴板写入成功后才显示成功提示；错误不包含 token。见[页面回归](../development/web-api-key-creation.md)。
- 管理员初始化要求 Worker Secret `ADMIN_BOOTSTRAP_TOKEN`，并使用常量时间比较；该 token 不写入
  D1 或浏览器存储。
- 管理员密码使用带 16 字节随机 salt、100,000 次迭代的 PBKDF2-SHA256 哈希；这是 Cloudflare
  Workers Web Crypto 当前允许的最大 PBKDF2 迭代次数。部署初始化应使用密码管理器生成并保存的
  高熵随机密码，不应使用短密码补偿平台 KDF 上限。登录对未知用户执行等价的 dummy derivation，
  避免通过响应内容区分用户名是否存在。
- session token 使用 32 字节 CSPRNG 随机值，D1 只保存 SHA-256 哈希。默认 8 小时过期，Cookie
  使用 `HttpOnly`、`SameSite=Strict`，非本地开发环境同时使用 `Secure`。
- 权限按 action、logical bucket 和 path prefix 组合，不把 Provider 权限暴露给客户端。

## 认证限流与部署就绪

管理员初始化与登录在 bootstrap/password 校验前使用 Cloudflare Workers Rate Limit bindings。
每个入口同时受每 location 的总量上限和规范化用户名 SHA-256 指纹上限保护；计数键不包含密码、
bootstrap token 或原始用户名。binding 抛错时认证 fail closed 为 `503`，超过上限为带
`Retry-After` 的 `429`。这是 PBKDF2 CPU 与在线猜测的第一层保护，不是永久账号锁定，也不替代
Cloudflare Access/WAF；API Key 和对象直传不使用这组限流。

公开健康接口是 deployment readiness 检查：它验证 master key 与 pepper 都是独立的 32 字节
canonical base64、key ID 合法、两个限流 binding 存在、D1 可读，并根据管理员是否已经存在检查
bootstrap token。未初始化实例必须有至少 32 字节且无控制字符的 bootstrap token；已初始化的
staging/production 实例若仍配置该 token 则不就绪。本地 development 可以保留 token 以便重建被忽略的
本地 D1。失败响应和日志只能出现稳定 issue code，不得回显任何 binding 值。

## 签名 URL

- 默认 15 分钟过期；上传签名限制 key、方法、精确 content length 和 content type，D1 按声明大小
  预留容量。
- 完成上传时通过 Provider `HEAD` 校验大小、ETag/checksum，再把对象置为 `READY`。
- API 响应和日志不持久化完整签名 URL。

Shard migration claim 同样只返回 15 分钟的一次性源 `GET` 和目标 `PUT`。目标签名绑定精确大小与
content type；搬运器流式转发字节，Worker 不读取对象内容。claim/complete 只接受管理员 session，
短期 lease token 还必须与 task 匹配；signed URL、lease token 和 session Cookie 不进入 audit、日志、
Web query cache 或命令行参数。迁移 CLI 仅从 `OPENPOOL_SESSION_COOKIE` 环境变量读取单个
`openpool_session=...` Cookie，并要求远端 control-plane URL 使用 HTTPS。

通用对象 CLI 则仅从 `OPENPOOL_API_KEY` 环境变量读取受限 OpenPool Key，不支持管理员 Cookie、
密码登录或 credential 文件。控制请求拒绝重定向；signed transfer 不附带控制面鉴权、Cookie 或
referrer，且不允许返回控制面 origin。上传回执只输出 logical bucket/key、object/session ID，不输出
signed URL；失败不自动重试 reservation。下载只写入私有临时目录，校验字节数后原子发布且不覆盖
已有路径；下载 SHA-256 供调用方校验，不把 Provider 的不透明 ETag 当作内容哈希。

## HTTP 与审计边界

- 有 JSON body 的控制面写请求只接受未压缩的 `application/json`（UTF-8），并在流式读取时限制为
  64 KiB；各请求对象按契约拒绝未知字段。
- 客户端提供的 `x-request-id` 只接受 1–128 个安全 ASCII 字符，其他值由 Worker 重新生成，避免
  不受控内容进入响应与日志关联字段。
- Phase 2 transactional audit outbox 要求业务写入与 outbox append 同一 D1 batch/事务；Cron 以 lease、
  稳定 event id 幂等投递并指数退避。查询同时读取 pending/processing outbox 与 delivered logs 并去重。
  当前覆盖全部现有 business mutation；没有对应业务写入的签名下载和 API Key 授权事件直接 append。
  outbox 仍是运维追踪，不是防篡改合规账本，metadata 继续禁止 credential、token、signed URL。

## 威胁边界

D1 泄漏不应直接导致 Provider 凭证泄漏；单个 Provider token 泄漏应被 Bucket 最小权限限制；
OpenPool 不支持或鼓励批量注册账号规避服务商条款，只管理用户合法拥有的账号。
Generic S3 endpoint 是单管理员提供的受信配置，验证与对象操作会向该 HTTPS endpoint 发送签名请求；
V1 不把它作为不可信多租户输入。部署者必须只配置自己控制或确认可信的服务端点。
