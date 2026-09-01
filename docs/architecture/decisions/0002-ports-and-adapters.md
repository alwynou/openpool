# ADR 0002：采用 Ports and Adapters

- 状态：Accepted
- 日期：2026-09-01

## 决策

领域和用例放在独立 packages；Cloudflare Worker、D1、HTTP 和 Provider SDK 作为外部适配器，
在单一 composition root 装配。

## 原因

Cloudflare-native 是首发部署方式，不应成为核心规则的编译期前提。这个边界允许未来共享核心逻辑
到 SQLite/单二进制版本，并让 Provider 与 Placement 测试不依赖网络。

## 后果

需要显式 mapper 和较多小接口。禁止为了减少文件数量而让 route 直接写 D1 或让 domain 导入 SDK。
