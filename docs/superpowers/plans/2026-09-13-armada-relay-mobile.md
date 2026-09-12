# Armada Relay + iOS App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-hosted relay and a Simulator-testable iOS remote so operators can bind via invite URIs, list open workspaces, dispatch prompts, see full `finalText`, and answer Ask — without exposing hub `:7380`.

**Architecture:** `relay/` is the only public HTTPS process. Hub dials out over WSS. iOS talks Bearer REST. Hub remains source of truth; relay stores snapshots.

**Tech Stack:** Bun, Hono, bun:sqlite, bun:test, SwiftUI (iOS Simulator).

**Spec:** `docs/superpowers/specs/2026-09-12-armada-relay-mobile-design.md`

## Handoff（2026-09-13）

代码已进本仓，供换到中台电脑继续协议联调。

**先不要把 `mobile/ios/` 当定稿。** 下一步是产品确认（spec 文首 N1–N3）：

1. App 交互（五屏、派发后跳转、Ask、解绑）
2. 启动路径（中转 / `relay.json` / Simulator）
3. 中台如何消化 pair（网页 vs 手写 json）

Task 1–3、5 的协议实现可在中台继续测：`bun test relay/test hub/test/relayClient.test.ts`。

---

## Global Constraints

- Do not map or bind hub `7380` to the public internet.
- `armada-relay://pair` vs `armada-relay://op` must not be interchangeable.
- `completed` requires non-empty `finalText` from `assistantBodyText` semantics.
- Prompt/`finalText` are not truncated in storage; HTTP body cap 20 MiB.
- Controlled Cursor extensions keep LAN `armada.hubUrl`.
- Simulator tests use `http://127.0.0.1:8780` (Simulator shares Mac localhost).
- Paid Apple Developer is not required for Simulator; TestFlight waits for Active membership.

---

### Task 1: Invite URI parse/format

**Files:**
- Create: `relay/src/uri.ts`
- Test: `relay/test/uri.test.ts`

**Interfaces:**
- Produces: `parseRelayUri`, `formatPairUri`, `formatOpUri`

- [ ] Tests for pair/op, missing fields, http rejected, cross-kind detection
- [ ] Implement
- [ ] `bun test relay/test/uri.test.ts`

### Task 2: Relay store + mobile HTTP + hub WS

**Files:**
- Create: `relay/src/db.ts`, `relay/src/server.ts`, `relay/src/index.ts`, `relay/package.json`
- Test: `relay/test/server.test.ts`

**Interfaces:**
- `GET /health`, `POST /admin/fleets`, mobile CRUD, `/hub` WebSocket
- `cmd.dispatch` / `snap.run` / `snap.workspaces`

- [ ] Tests: no token 401; pair on mobile 403; op on hub 403; hubOffline 503; completed gate; dispatch roundtrip with fake hub
- [ ] Implement
- [ ] `bun test relay/test/server.test.ts`

### Task 3: Hub outbound

**Files:**
- Create: `hub/src/relayClient.ts`
- Modify: `hub/src/index.ts`
- Test: `hub/test/relayClient.test.ts`

- [ ] Load `~/.armada/relay.json`; ignore if missing
- [ ] Loopback `POST /api/runs` on dispatch
- [ ] Push workspace + run snapshots including `finalText`

### Task 4: iOS Simulator app

**Files:**
- Create: `mobile/ios/ArmadaRemote/*`

- [ ] Five screens against local relay
- [ ] Run in Simulator (no paid team)

### Task 5: Root scripts

- Modify: `package.json` workspaces + `test` to include `relay/test`
