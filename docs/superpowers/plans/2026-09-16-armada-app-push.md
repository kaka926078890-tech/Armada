# App visible APNs Implementation Plan

> Spec: `docs/superpowers/specs/2026-09-16-armada-app-push-design.md`

**Goal:** 锁屏可见 APNs（Ask + 四终态）；无 `.p8` 时 no-op。

**Architecture:** 中转边沿 + 代发；App 只登记 token、点开 GET。Hub 零改。

## Tasks

1. `notifyEdge` 镜像中台用例（TDD）
2. `apns` JWT + 注入 post；无密钥 no-op
3. db / 登记 API / applyRunSnap 挂钩
4. iOS entitlements + 登记 + 点开 + willPresent
5. README 环境变量

无 `.p8` 不挡合代码。
