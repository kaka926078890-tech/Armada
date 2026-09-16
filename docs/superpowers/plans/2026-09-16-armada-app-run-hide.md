# App run hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Spec: `armada/docs/superpowers/specs/2026-09-16-armada-app-run-hide-design.md`.

**Goal:** App 与中台同一套「隐藏 / 查看已隐藏 / 取消隐藏」；中台藏了的卡默认手机列表也不再出现。

**Architecture:** Hub `archived_at` 仍是唯一写路径。`runToSnap.archived` 出站；中转存列、默认列表过滤、转发 `cmd.archive`/`cmd.unarchive`。`relayClient` 听 `run.archived`；`relayAttach` 对默认列表消失的已知 id `pushRun`。iOS 消费字段与按钮。

**Tech Stack:** bun, SQLite, Hono, SwiftUI.

## Global Constraints

- 权威在 hub；中转不自己标隐藏、不删行。
- occupying（queued/dispatched/binding/running）→ `409 INVALID_STATE`。
- 产品文案「隐藏」，不是归档/删除。
- 详情 GET by id 对已隐藏仍 200。
- 不改 ingest / stop / generation_id；不碰扩展。
- Armada 主干 `master`。测不红不准改生产。

## Files

| File | Role |
| --- | --- |
| `hub/src/relayClient.ts` | `RunSnap.archived`；`run.archived` 推 snap；`cmd.archive`/`unarchive` |
| `hub/src/relayAttach.ts` | 同上 cmd；`fpOf`+消失检测 |
| `relay/src/db.ts` | `runs.archived_at` |
| `relay/src/server.ts` | 列表过滤、applySnap、两条 POST |
| `mobile/ios/ArmadaRemote/{RelayAPI,Screens,ArmadaRemoteApp}.swift` | DTO、API、详情按钮、仓页开关 |
| `README.md` | 中转表两行 |
| tests | 下列任务 |

## Tasks (TDD)

### Task 1: `runToSnap.archived`

**Files:** `hub/src/relayClient.ts`；`hub/test/relayClient.test.ts`

- [ ] 红测：`archived_at: 9` → `archived: true`；`null`/缺省 → `false`
- [ ] 实现 `RunSnap.archived`
- [ ] `bun test hub/test/relayClient.test.ts`

### Task 2: 中转列 + 列表过滤 + archive 路由

**Files:** `relay/src/{db,server}.ts`；`relay/test/server.test.ts`

- [ ] 红测：`snap.run archived:true` 后默认列表不含、`?archived=1` 含、详情 `archived:true`
- [ ] 红测：假 hub `cmd.archive` → 200；running 回 `INVALID_STATE` → 409
- [ ] 实现列、过滤、`cmd.archive`/`unarchive`（不计入派发限流）
- [ ] `bun test relay/test`

### Task 3: hub 出站推送 + attach 消失检测

**Files:** `hub/src/relayClient.ts`；`hub/src/relayAttach.ts`；`hub/test/relayClient.test.ts`；`hub/test/relayAttach.test.ts`

- [ ] 红测：终态后 hub archive，relayClient 路径下 `GET /mobile/runs` 不含该 id
- [ ] 红测：attach 路径同样
- [ ] `onEvent` 加 `run.archived`；attach `fpOf` 含 `archived_at`；已知 id 离开默认列表则 `pushRun`
- [ ] 两边 `cmd.archive`/`unarchive` 打 hub HTTP

### Task 4: iOS

**Files:** `RelayAPI.swift`；`ArmadaRemoteApp.swift`；`Screens.swift`

- `RunDTO.archived`；`showsArchive = !isLive && !(archived ?? false)`
- `GET ?archived=1`；`POST .../archive|unarchive`
- `INVALID_STATE` → 「运行中不能隐藏」；`NOT_FOUND` → 「任务不存在」
- 详情隐藏后 dismiss；取消隐藏留在详情
- 仓页「查看已隐藏」；`refresh` 始终拉两份；未读只计默认列表
- 列表 swipe 隐藏/取消隐藏（对齐看板卡片）

### Task 5: README + 规格状态

- README 中转表：`?archived=1`、archive、unarchive
- 规格状态改为实施基准

## Verify

```bash
bun test hub/test/relayClient.test.ts hub/test/relayAttach.test.ts relay/test
```
