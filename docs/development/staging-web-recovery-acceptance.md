# Staging Web 恢复交互验收

## 发布与授权（2026-09-03）

项目所有者在“将两轮 Web 修复部署到 staging 并进行真实交互验收，需要授权部署及测试写入”后确认继续。
本轮仅更新现有 `openpool-staging`，不操作 production、不执行 D1 migration、不推送 Git。

- 发布提交：`f1b031c`，包含 `35a99c3` 上传恢复和 `f1b031c` 账号纠错修复。
- 与已部署的 `9a408dc` 比较，Worker、domain/application、SDK、contracts 和 migrations 无变化。
- 发布前 `npm run verify` 通过：691 个测试（206 + 306 + 7 + 172），lint、类型检查与构建通过。
- `npm run deploy:staging` 于 2026-09-03 15:15（Asia/Shanghai）完成。
  新版本 `3ca24b95-40cc-4753-842a-fbd4344828e8`，100% 流量；前版为
  `a512e61f-7c6f-4b33-a0f2-16ce86c3977a`。
- 远端首页、入口 JS、Files chunk、Accounts chunk 的 SHA-256 与本地构建一致。
- OAuth 账号、staging D1 名称/ID/APAC、两个现有 Secret 名称已核对；没有读取或更换 Secret 值。
  健康 API 返回 `status=ok`、`environment=staging`，浏览器既有管理员 session 可用。
- 只读 `d1 migrations list` 返回 Cloudflare `7403` 授权错误，未通过其他身份或接口绕过；本轮没有
  schema 变更，未执行 apply，也不声称重新读取了 migration history。后续 schema 升级前仍须解决该权限。

## 浏览器与测试边界

使用 Kimi Browser Extension 操作真实 Chrome，标签组为「OpenPool staging 验收」。首次文件选择因扩展
缺少“允许访问文件网址”被拒绝；所有者开启后才继续，没有绕过权限。

上传测试使用既有 R2 隔离 logical bucket 的唯一 `web-recovery-20260903-6vcftt/` 前缀，
原有账号配置、生命周期和对象保持不变。只对本轮测试请求注入客户端失败/等待，未修改 Worker 或
Provider 配置；成功路径仍请求真实控制 API，并由浏览器直接 PUT/GET R2。探针输出不包含 signed URL、Cookie
或 credential。测试文件为小文本，不重复 50 MB 性能测试。

账号纠错只使用一次性、无 shard 的测试账号；原 ACTIVE 账号不参与配置修改。有效凭据由所有者
直接填写浏览器表单，不通过聊天或测试记录传递。

## 交互结果（2026-09-03，Asia/Shanghai）

- [x] PUT 发送前注入失败：创建真实 PENDING 对象，Bucket/key 锁定，File 仍可更换；失败的 PUT
  未发往 Provider。
- [x] 显式重试使用替换文件、同一 object/key 和新 session。
- [x] 确认失败后仅重试 complete，同行 Retry 不丢状态，picker/drop 锁定。
- [x] 请求等待时不能重复提交，完成后表单重置，真实下载字节校验通过。
- [x] 账号验证失败后编辑、保存、再次验证、并发冲突重新加载。
- [x] 本轮测试对象删除与容量归零，测试账号沿正常生命周期移除。

### 上传恢复

仅创建一个 logical object：`web-recovery-20260903-6vcftt/retry-original.txt`，累计两个 session。

1. 首次 reservation 为 69 B，PUT 在发送前被客户端探针拒绝。等待所有者提供账号测试凭据期间，
   原 session 自然过期；15:45:25 的 `OBJECT_UPLOAD_EXPIRED` 和 `OBJECT_UPLOAD_ABORTED` 审计
   及随后当前 session 查询确认 Cron 已清理，没有修改时钟或 expiry，也未直接写 D1。
2. 重新打开 Files 后本地 File 为空；选择 PENDING 行会固定 Bucket/key 并要求重新选择文件。
   选择文件后点击 `Choose a new upload`，确认 key/File/重试状态全部清空、Bucket 解锁，
   原 PENDING 对象仍在。
3. 重新选择该行与 72 B 的 `replacement.txt`。首次 status lookup 注入失败时，页面明确显示
   `No new upload was started`，探针没有新增 reservation、PUT 或 complete。
4. 下一次显式重试读取当前 ABORTED session，真实 reservation 返回 201；保留同一 object/key，
   使用新 session。暂停 PUT 期间 Bucket/key/File、行级 Retry 和主按钮均禁用，重复点击没有额外请求，
   拖放也不替换文件。释放等待后真实 R2 PUT 返回 200。
5. complete 在发送前注入一次失败，页面切换为 `Retry confirmation`。再次点击同行 Retry 后仍为
   confirmation-only；File 禁用，拖放被忽略。暂停下一次 complete 并重复点击，只有一个等待中的
   complete；释放后返回 200，object 为 READY，表单与错误状态清空，没有额外 reservation 或 PUT。
6. 浏览器测试辅助函数调用真实签名下载 API，再直接 GET R2；HTTP 200、72 B，SHA-256 为
   `fef318e78d8f263f7a93bac52d51c2459ba2e328d7edc2f4d32f5e23eee1b814`，与本次上传 File 一致。
   此处是浏览器 Fetch 字节校验，不将其称为点击 Download 按钮的验收。

### 账号纠错

一次性账号名称为 `web-recovery-20260903-6vcftt-r2`，配置容量 1 MiB、priority 0，没有创建 shard。

1. 所有者在创建表单填写有效 R2 凭据，validation bucket 故意指向不存在的测试名称。创建成功后
   表单关闭且凭据输入清空；显式 Verify 返回 Provider 拒绝，账号仍为 VERIFYING，并显示 `Edit & retry`。
2. 编辑时 Provider 不可更改、三个 credential 字段均为空。保留错误 Bucket 提交后，真实配置保存成功、
   再验证失败，页面明确显示 `Configuration saved, but verification failed`。
   保存/验证等待期间字段与提交/取消禁用；最终成功那次等待中点击关闭按钮也没有关闭表单。
3. 通过同源控制 API 对该测试账号单独执行一次配置 PATCH，模拟另一客户端修改；不提供 credentials。
   旧编辑表单提交触发真实版本冲突，字段/保存禁用，没有自动覆盖。显式点击
   `Reload latest configuration` 后读到并发写入的 Bucket，清空未保存输入并恢复编辑。
4. 将 Bucket 改为 `openpool-staging-smoke`，credential 全部留空，保存后使用已加密保存的凭据验证成功。
   15:49:06 账号变为 ACTIVE/HEALTHY，表单关闭；ACTIVE 菜单没有验证或配置纠错入口。
   审计共三次成功配置更新，均为 `credentialsChanged=false`，以及一次成功验证；冲突未追加成功更新。

### 清理与检查

- 通过账号页面依次执行 ACTIVE → DRAINING → READ_ONLY → REMOVED；15:51:06 完成，三个状态审计
  与 API 查询一致，测试账号 usedBytes 为 0。REMOVED 是生命周期记录，不代表硬删除 D1 或擦除凭据信封。
- 15:55:07 在 Files 页面确认删除本轮唯一测试对象，API 返回状态 DELETED；R2 账号与 ACTIVE shard
  usedBytes 均为 0。当前 session 为 COMPLETED，旧 session 已 ABORTED，没有待清理的失败尝试。
  原 Staging R2/B2 均保持 ACTIVE、usedBytes 为 0，没有修改它们的配置或生命周期。
- 对象审计共八条：reserved、expired、aborted、retried、completed、download signed、delete started、
  deleted；账号审计共八条。只核对公开审计事件，不将可见性误记为已重新检查 outbox 投递状态。
- 移除新文档注入脚本并重载页面，确认浏览器探针已不存在；没有自动关闭所有者的标签页。
- 验收后再次运行 `npm run verify`：691 个测试、Oxlint、全部类型检查与构建通过；Worker build
  仅 dry-run，没有二次部署。提交范围仅文档，无单独适用的行为测试；Markdown 路径与 diff 检查通过。

## 保留边界

本轮上述 R2 Web 恢复与配置纠错 smoke 已完成，不等于所有故障或 Provider 的完整端到端覆盖。
失败来自仅针对测试请求的客户端注入，不是物理断网，也不是后端 complete 已提交后的响应丢失。
真实 credential 替换后失败再恢复、部分凭据表单校验、重新加载失败等更多分支继续由本地组件测试覆盖；
未为它们反复读取或索取真实 secret。没有重复 B2、Generic S3、50 MB 或压力测试。

所有者随后确认已删除此轮专用 R2 API Token（2026-09-03）；这是所有者回报，未再次登录 Cloudflare
独立核对。本轮未自动修改 Cloudflare Token，账号 REMOVED 本身不会在 Cloudflare 撤销凭据。
D1 query 的 `7403` 权限问题仍需在下一次 schema 升级前解决，未因本轮成功而视为恢复。
