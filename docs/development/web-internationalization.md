# Web 中英文国际化

Web 管理控制台支持英文（`en`）和简体中文（`zh-CN`）。未保存偏好时，页面根据
浏览器语言选择中文或英文；用户也可以在登录页或管理页顶部直接切换。选择保存在
`localStorage` 的 `openpool.locale` 中，该值只是语言标识，不包含凭据或用户数据。

## 实现边界

- `apps/web/src/i18n.tsx` 负责语言检测、持久化、命名参数插值和 React context；
- 英文文本同时是 fallback key，缺失中文翻译时 fail soft 为英文，不会显示空白文本；
- 页面标题、导航、表单、校验、对话框、Toast、状态和日期格式跟随当前语言；
- Provider 名称、对象 key、账号名称、audit action/resource code 和 API 返回的错误原文
  保持原值，避免改写运维识别符或丢失服务端诊断信息。

## 验收

`apps/web/src/i18n.test.tsx` 覆盖英文 fallback、中文插值、浏览器语言检测、即时切换、
`document.lang` 和刷新后偏好恢复。现有页面交互测试默认使用英文，用于确认国际化
接入没有改变原有表单、安全和请求语义。

本能力只修改 Web 静态资源，不改变 Worker、API contract、D1 schema、Provider 凭据或对象传输路径。
