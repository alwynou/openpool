# Web 账号创建交互回归

覆盖 Storage Accounts 页的 `Add account` 表单，与已有的
[VERIFYING 账号纠错](web-account-recovery.md)分开记录。沿用现有创建 API：创建只保存加密凭据，
账号保持 VERIFYING，必须由用户显式验证后才能参与 placement。不改变契约、生命周期或 schema。

## 交互与安全约定

- R2、B2、Generic S3 使用现有表单校验和 Provider 配置映射；不自动调用验证。
- 创建凭据只留在当前表单与正在发送的 API 请求，不作为 React Query mutation variables，
  不进入 query/mutation state。关闭后不保留旧表单或错误。
- 创建请求不自动重试，即使外层 QueryClient 配置了默认重试。创建不是幂等命令；若结果不确定，
  应先刷新账号列表确认，不能盲目重发。
- 验证输入、创建请求与随后的列表刷新期间，字段、Provider、提交、取消和关闭操作保持锁定。
  同步提交保护覆盖重复点击与原生 form submit，不在异步校验间隙发出第二次创建。
- 创建 API 失败时，当前表单保留未保存输入，用户可修改或明确重试；取消、关闭按钮、Escape
  均会丢弃表单和错误，重新打开回到默认值。
- 创建成功立即清空已接受的凭据，然后刷新列表、关闭表单；列表刷新等待期间不能重发创建。

## 本地检查

```bash
npx vitest run apps/web/src/pages/accounts-create.test.tsx
npm run test:web
npm run verify
```

页面测试保留 StrictMode、真实表单校验、Radix 弹窗和 QueryClient，仅模拟 API I/O 与 toast。
只使用假凭据、禁止访问网络，并在每例清理 DOM、缓存和全局替换。测试不访问 Cloudflare、
不创建远端账号，不将本地回归记为真实凭据或浏览器端到端验收。

## 2026-09-03 本地证据

10 个新增页面测试覆盖三种 Provider 的请求映射、必填凭据、待处理/成功/失败的缓存边界、
显式重试、校验期间的同步提交与关闭、失败后取消/关闭/Escape 的重置、成功后的 VERIFYING 状态，
以及列表刷新尚未结束时的清空和锁定。QueryClient 的默认 mutation retry 刻意开启，确认创建流程
仍不自动重试；取消重置用例单独关闭该默认值，以独立验证旧表单残留。

将同一组测试运行在 `cd13126` 的页面副本上，5 个通过、5 个失败，分别检出凭据进入缓存、
继承自动重试、同步重复请求、关闭后保留旧输入和刷新期间字段未锁定。修复后的 10 个全部通过。
副本仅用于本地对照，完成后已删除，没有回退工作区或修改历史提交。

Web 全部 71 个测试通过；最终 `npm run verify` 通过，共 701 个测试
（根目录 216、Worker 306、Migrator 7、CLI 172），全仓 Oxlint、类型检查与构建通过。
Worker 构建仅执行本地 dry-run，没有部署或执行 migration。Markdown 相对路径与 diff 检查通过。

## 发布边界

本次只修改 Web 创建表单与本地测试，不修改 Worker、SDK、contract、migration 或 Provider 配置。
已有 staging Web 验收对应较早提交，不包含这次创建表单修复；后续部署及真实写入验收仍须单独授权。
