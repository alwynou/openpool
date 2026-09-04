# Staging Web 账号创建与 API Key 验收

## 发布与授权（2026-09-03）

所有者在“将 API Key 和新增账号表单修复一起发布到 staging 验收，需要授权”后确认继续。
本轮不执行 D1 migration、不操作 production、不推送 Git，也不读取或替换现有 Provider 凭据。

- 发布提交 `0f26d67`，包含 `87d9a7f` 账号创建与 `0f26d67` API Key 创建加固。
- 相对前次发布提交 `f1b031c`，Worker、packages、数据库、依赖及部署配置没有变化；仅 Web 与文档变化。
- 发布前 `npm run verify` 通过：715 个测试（230 + 306 + 7 + 172），Oxlint、类型检查与构建通过。
- 唯一可见 Cloudflare account 已登录；staging D1 名称/ID/APAC 与配置匹配，Secret 名称仍只有
  `API_KEY_PEPPER` 和 `CREDENTIAL_MASTER_KEY`，未读取 Secret 值。
- `npm run deploy:staging` 于 17:12（Asia/Shanghai）完成，新版本
  `9431a58b-ef8f-492d-9308-05e1e7e8d5ad` 接收 100% 流量，前版为
  `3ca24b95-40cc-4753-842a-fbd4344828e8`。Cron 仍为 `*/5 * * * *`。
- 健康 API 返回 200、`status=ok`、`environment=staging`。远端首页、入口 JS/CSS、Accounts 与
  API Keys chunk 共五个资源的 SHA-256 与本地构建一致；已有管理员 session 可用。

本次没有 schema 变化，不执行 migration history 查询、export 或 restore；较早的 D1 query `7403`
权限问题仍未解决，不能因本次发布正常而认为 migration 权限恢复。

## 浏览器与隔离边界

使用 Kimi Browser Extension 操作真实 Chrome，标签组为「OpenPool 表单发布验收」。测试前保存公开
metadata 基线：7 个 Storage Account、6 个 logical bucket、16 个 API Key，不保存 raw token。

仅真实创建一个临时 Key，限定既有 `smoke-test` Bucket、`web-issuance-20260903-8nlnuz/` 路径、
`objects:list`/`objects:read` scope 和 `2026-09-04T00:00:00.000Z` 过期时间；不上传或修改对象。
账号测试只用假凭据与客户端模拟响应，**不创建真实 Storage Account**：VERIFYING 不能直接移除，
而此前专用 R2 Token 已由所有者删除，本轮没有重新索取凭据或通过 D1 绕过生命周期。

SDK 在初始化时绑定 fetch。首次页面加载后安装的网络探针没有拦截 SDK 请求，因此不将该阶段记为
网络等待/故障注入成功；真实 Key 创建由返回状态、列表和审计确认。之后改为页面启动前注入，
确认等待 gate 实际生效才继续；后续全部 Key 创建请求被拦截，不能再发放真实 Key。

## 真实 API Key 与剪贴板结果

1. 表单填写过去的到期日期，真实创建请求返回 400，显示稳定错误及 request ID，并保留输入。
   修改日期后同步重复 submit，实际只有一个 201 与一条新 Key，未出现重复创建。
2. token 在一次性弹窗显示。通过真实浏览器点击 Copy，原生 `clipboard.writeText` 成功返回后才
   出现 `Token copied`；探针仅记录传入值与展示值匹配的布尔值，不保存或输出 token，也不回读剪贴板。
3. 客户端模拟剪贴板拒绝或不可用，界面显示手动复制提示、保留 token，不误报成功。
4. 客户端暂停复制并同步点击两次，仅进入一次复制，Copy 禁用；关闭弹窗后释放等待，不再出现迟到通知。
5. 17:18:38 通过页面确认撤销唯一临时 Key，公开列表的 `revokedAt` 非空。审计查询只有
   `API_KEY_CREATED`（17:15:50）和 `API_KEY_REVOKED`，创建 metadata 仅含 `keyPrefix`，撤销为空。
   这是公开事件可见性检查，不声称重新检查了 D1 outbox 投递状态。

Key 名称为 `web-issuance-20260903-8nlnuz-key`。撤销保留正常 metadata 与审计记录，不是硬删除 D1。
复制过的 token 已失效；清理不回读或强制覆盖用户当前系统剪贴板。

## 客户端故障与账号模拟结果

- API Key 请求在发送前暂停：重复 submit 只有一次拦截，字段、scope、提交和取消禁用，Close/Escape
  不能关闭；释放为客户端 503 后显示错误并保留输入。取消再打开时名称、Bucket、路径、日期和旧错误
  清空，scope 回到默认 list/read。未增加任何真实 Key。
- 账号创建在发送前返回客户端 503：三个假凭据输入保留；取消再打开时所有输入/错误清空，Provider
  回到 R2、priority 回到 100。
- 再次填写假数据并暂停创建：同步重复 submit 与立即关闭只进入一次请求；Provider、全部字段与取消
  禁用，Escape 不关闭。
- 释放为明确标记的模拟 201，三个凭据字段立即清空；列表刷新暂停时，全部字段和关闭仍锁定，重发
  不增加请求。释放列表后弹窗关闭，显示仅在该浏览器探针中存在的 VERIFYING 行，没有自动 verify。

以上账号两个 POST 都在到达 Worker 前拦截；成功响应和新增行是模拟数据，不等于真实 credential
加密、Provider 验证或完整账号创建端到端验收。API Key 列表刷新失败/未结束时的更多分支，以及
query/mutation 缓存检查，继续以[本地回归](web-api-key-creation.md)为证据，不扩大此次浏览器覆盖声明。

## 清理与保留范围

- 原有账号、Bucket 和 16 个 Key 的公开 metadata 与基线逐项一致，未修改现有 Provider 配置。
- 唯一新增 Key 已撤销，总 Key 数为 17；Storage Account 仍为 7，无本轮测试账号。原 Staging R2/B2
  保持 ACTIVE、usedBytes 为 0；本轮未创建对象或上传会话。
- 已移除 document-start 脚本、恢复 fetch/剪贴板函数并重新加载，确认探针和模拟行均不存在；临时
  本地脚本及空目录已删除。没有自动关闭用户标签组。
- 本轮仓库变更仅验收文档，没有单独适用的新增行为测试。真实 Provider 成功创建若需重验，仍须
  所有者提供新的隔离凭据；不复用此前删除 Token 的旧授权。

收尾再次运行 `npm run verify`：715 个测试、Oxlint、全部类型检查与构建通过；Worker build 仅
dry-run，没有二次发布。7 个变更 Markdown 文件的 73 个相对链接及 diff 检查通过。
