# Web 上传恢复交互回归

本地组件回归覆盖 Files 页面真实按钮、文件输入、拖放事件、React Query 缓存及上传工作流的联动。
它不是远端 Provider、真实浏览器、CORS 或视觉验收；不替代已有的
[staging 上传重试验收](staging-upload-retry-acceptance.md)或 [50 MB CLI 验收](staging-cli-50mb-acceptance.md)。
重试语义继续遵守 [ADR 0005](../architecture/decisions/0005-upload-attempt-retries.md)，没有修改公共 API 或 schema。

## 运行

```bash
npm run test:web
npx vitest run apps/web/src/pages/files-page.test.tsx
npm run verify
```

页面测试使用文件级 `jsdom` 环境，其他既有测试继续使用其原有环境，参见
[Vitest 环境说明](https://vitest.dev/guide/environment.html)。React Testing Library 渲染真实页面，
保留 StrictMode、MemoryRouter、QueryClient、UI 组件及 `runUploadWorkflow`，只替换 API I/O 和 toast。
文件选择和点击通过 [user-event](https://testing-library.com/docs/user-event/intro/) 驱动，拖放用 DOM 事件模拟。
异步请求通过受控 Promise 和可观察页面状态等待，不使用固定 sleep。

每个测试有独立 QueryClient 和假数据，结束后卸载页面、清理缓存并恢复全局变量。所有 API 方法默认
拒绝未配置调用，fetch 另设失败保护；不读取 session/Provider credential，不连接 localhost 服务或远端，
不创建数据库或实际存储对象。测试库只加入 devDependencies，正常 Web 构建不包含它们。
这些测试已被根 `npm run test` / `verify` 收集，不需要改变 CI 或提供 CI secret。

## 交互约定与验收范围

- 普通上传成功：只进行一次 create/PUT/complete，列表刷新到 READY，路径、文件、错误及恢复状态清空。
- PUT 失败：保留原 Bucket/key；用户可选择原文件或替换文件，再显式获取新 session 并完整上传。
- PUT 已成功、complete 结果不确定：主按钮为 `Retry confirmation`，只重试原 session 的 complete，
  不另建 reservation 或 PUT。此时禁用文件选择并忽略拖放，避免界面选了新文件却只确认旧文件。
- 同一对象行的 `Retry` 不丢弃当前恢复状态；选择另一个 PENDING 对象则清除旧 attempt/文件并固定新目标。
- complete 返回终态错误（例如 session 过期）：回到 `Retry upload` 并允许重新选文件。
- `Choose a new upload` 清空旧路径、文件和恢复状态；不删除原 PENDING 对象，原尝试仍由现有 API/Cron 管理。
- 请求进行中禁用提交、Bucket/key、文件选择及行级 Retry；重复点击不额外发起上传，拖放不替换本次文件。
- 页面重新加载后不恢复本地 File；选择 PENDING 行后必须重新选文件。READY/DELETING/DELETED 不开放 Retry。
- session 冲突保留目标并显示冲突提示，不自动重试；下一次显式操作重新读取当前 session。
- 当前 session 查询失败标为客户端 `lookup` 阶段，明确说明未开始新上传；不调用 create/PUT/complete。

## 2026-09-03 本地证据

基线 `6a84e8f`。先通过页面测试复现同一行 Retry 丢失确认状态、确认阶段允许 picker/drop 替换文件、
选择新上传未清空旧输入四个失败场景；修复后全部通过。随后用工作流和页面各一个红测试复现
lookup 失败被误报为创建失败，再修复提示分类。其余正常、失败、冲突与禁用场景一起回归。

新增 14 个页面交互测试和 1 个工作流测试，Web 共 39 个测试通过；改动范围的 Oxlint、Web 类型检查通过。
完整 `npm run verify` 通过：共 669 个测试（根目录 184、Worker 306、Migrator 7、CLI 172），
全仓 lint、类型检查和构建通过；Worker 构建仅执行本地 `wrangler deploy --dry-run`。
本轮修复仅在本地，没有部署、migration 或真实浏览器操作；下一次 staging 发布与真实浏览器回归
仍需单独授权，不能把本地通过记录为线上已经生效。
