# Web API Key 创建交互回归

覆盖 API Keys 页的创建与一次性 token 展示，沿用现有管理员 API、scope、Bucket/path 和有效期
约束。不改变 Key 格式、哈希、授权模型、撤销 API 或数据库。

## 交互与安全约定

- 创建响应中的 raw token 只交给当前展示弹窗；mutation 返回安全 Key metadata，token 不进入
  query/mutation state 或缓存回调，不写入浏览器存储、toast 或日志。关闭弹窗或离开页面后不能恢复。
- 创建不是幂等命令，不继承 QueryClient 的默认自动重试。失败保留当前输入供用户修改或明确重试；
  若网络中断导致结果不确定，应先刷新 Key 列表，撤销无法取得 token 的多余 Key，再决定是否重新创建。
- 同步提交锁防止重复发放 Key。请求期间锁定全部输入、scope、提交、取消、关闭与 Escape；创建成功
  后立即展示 token，不依赖列表刷新成功。列表刷新未结束或 token 尚未关闭时，不能再次创建。
- 取消、关闭或 Escape 退出失败表单后，重新打开不保留旧输入和错误；默认仅选择 list/read scope。
- 复制操作等待剪贴板成功后才提示已复制；不支持或被拒绝时给出安全的手动复制提示，保留 token。
  复制期间不重复调用剪贴板，关闭弹窗后不弹出迟到的成功或失败通知。用户主动复制会将 token 写入
  系统剪贴板；关闭弹窗不声称安全擦除剪贴板或 JavaScript 引擎内存。

## 本地检查

```bash
npx vitest run apps/web/src/pages/api-keys-page.test.tsx
npm run test:web
npm run verify
```

页面测试使用 StrictMode、真实 Radix 弹窗与 QueryClient，只模拟 API、toast 和剪贴板 I/O；
使用假 token、禁止网络，并清理 DOM、缓存和全局替换。不创建或撤销真实 Key。

## 2026-09-03 本地证据

14 个新增测试覆盖默认/受限请求映射、scope 校验后的纠正、同步重复提交、全部字段与关闭保护、
失败后明确重试、三种关闭入口的默认值/错误重置、实际等待中的列表刷新、刷新失败、页面卸载，
以及剪贴板等待、重复复制、不可用、拒绝和关闭后的迟到通知。缓存检查包含 mutation 状态变更快照，
不依赖缓存回收才移除 token。

同一组测试在 `87d9a7f` 页面副本上为 2 项通过、12 项失败，检出重复创建、继承重试、旧错误残留、
刷新期间可再次创建、token 缓存驻留和复制结果误报；修复后 14 项全部通过。副本已删除，没有回退
工作区或改写历史提交。

最终 `npm run verify` 通过：全仓 Oxlint、类型检查、715 个测试
（根目录 230、Worker 306、Migrator 7、CLI 172）及构建全部通过。Worker 构建仅本地 dry-run；
没有部署或执行 migration。变更文档的 69 个相对链接和 diff 检查通过。

## 发布边界

本次仅加固 Web 创建与展示流程，不修改 Worker、SDK、contract、migration 或 Provider 配置。
本地页面测试不替代真实浏览器的剪贴板权限验收；staging 发布与真实 Key 操作须后续单独授权。
