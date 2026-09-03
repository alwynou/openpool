# Web 账号纠错交互回归

覆盖 Storage Accounts 页面中 `VERIFYING` 账号的“验证失败 → 编辑 → 保存 → 再验证”。
继续使用现有配置纠错 API 与 `expectedUpdatedAt` 条件写入，不新增账号、不删除远端记录，
不开放已激活账号的 credential rotation；边界见[安全模型](../architecture/security.md)。

## 本地检查

```bash
npx vitest run apps/web/src/pages/accounts-page.test.tsx
npm run test:web
npm run verify
```

页面测试沿用文件级 jsdom 和 React Testing Library，保留真实表单校验、Radix 菜单/弹窗、
查询缓存及页面组件，只模拟 API I/O 和 toast。API 默认拒绝未配置调用，fetch 额外禁止网络；
仅使用测试凭据，每例清理 DOM、缓存及全局替换，不连接本地 Worker 或真实 Provider。
保留 StrictMode 和键盘入口；测试只补齐缺失的 PointerEvent 事件字段，以及 jsdom 不支持的
全屏状态（`:fullscreen` 为 false），避免 nwsapi 原生 fallback 递归。其他 DOM selector 保持真实实现；
不绕过菜单、禁用状态或表单校验，也不增加测试超时。

## 交互与安全约定

- R2、B2、Generic S3 验证失败都能在原账号上 `Edit & retry`，Provider 类型不可更改。
- 配置预填，但三个 credential 字段始终从空值开始；全部留空表示保留已保存凭据。
- 替换 credential 必须同时提供 key ID 和 secret，session token 可选；只填部分字段不发请求。
  未修改的 Provider 配置（如 addressing style）继续保留。
- 先保存，再验证。保存失败不开始验证，保留未保存输入；保存成功而验证失败则明确提示已保存，
  清空已接受的 credential 输入，下次提交使用保存响应的新版本，不无意重发旧明文。
- credential 不作为 React Query mutation variables；不进入 query/mutation state、toast 或页面错误文案。
- 保存与验证期间锁定输入和关闭操作，重复提交不再发请求；行级验证/健康检查期间不能同时打开纠错。
- 遇到版本冲突、账号不再处于 VERIFYING 或账号不存在时，停止再次保存。用户显式选择
  `Reload latest configuration` 后才读取最新配置并清空未保存输入；不自动套用新版本覆盖并发修改。
  最新账号已激活或不存在时关闭编辑；取消也丢弃未保存凭据。
- ACTIVE、DRAINING、READ_ONLY、REMOVED 账号没有验证/纠错入口。

## 2026-09-03 本地证据

将首批 18 个测试对照基线 `35a99c3` 的页面副本运行：12 个通过，6 个失败，复现已保存凭据未清空、
凭据留在 mutation state、保存期间仍能编辑，以及冲突/已激活状态仍能反复保存。副本仅供对照，
已移除，没有回退工作区改动。相同断言在修复后通过；再补齐验证等待、重新加载失败、行级并发入口
和键盘导航，共 22 个页面测试通过。

`npm run test:web` 的 61 个测试通过；完整 `npm run verify` 通过，共 691 个测试
（根目录 206、Worker 306、Migrator 7、CLI 172），全仓 Oxlint、类型检查与构建通过。
Worker 构建仅为 `wrangler deploy --dry-run`，没有发布或执行 migration。

## 发布边界

这些是本地组件交互回归，不是实际浏览器、Provider 验证或加密存储的端到端验收。
没有修改 Worker、公共 API、contract 或 migration；不因本地检查通过而标记 staging 已更新。
本轮修复与[上传恢复修复](web-upload-recovery.md)后续发布及真实浏览器测试仍需单独授权。
