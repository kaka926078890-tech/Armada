# Armada Android Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Android remote that matches live iOS ArmadaRemote (P1–P30), including visible FCM, without exposing hub `:7380`.

**Architecture:** Same `/mobile/*` as iOS. Relay gains `platform=fcm` on the existing push-token table. Android lives in `mobile/android/`: JVM `:core` for URI/DTO/session rules, Compose `:app` for UI.

**Tech Stack (implementation default, not a spec lock):** Kotlin 2.x, Jetpack Compose, OkHttp, kotlinx.serialization, EncryptedSharedPreferences, Firebase Cloud Messaging. Relay FCM HTTP v1 with injected `post` in tests.

**Spec:** `docs/superpowers/specs/2026-09-17-armada-android-app-design.md`

## Global Constraints

- Do not map hub `7380` to the public internet.
- Hidden list query is `view=hidden` only — never `archived=1`.
- Followup success codes are 200 and 201; dispatch is 201 only.
- `notifyEdge` stays unchanged; APNs clients omit `platform` and still register.
- FCM payloads never include `finalText`.
- Operator token is not stored in plaintext.
- Work on `armada` `origin/master` (trunk).
- Complete-state gate is A1–A14 / P1–P30; do not call it done without FCM wiring (no-op without credentials is OK).

---

### Task 1: Relay `10.0.2.2` http origin + FCM unit tests (RED)

**Files:** `relay/test/uri.test.ts`, `relay/test/fcm.test.ts`, `relay/test/server.test.ts`

- [ ] RED: `http://10.0.2.2:8780` parses; public http still insecure
- [ ] RED: `buildFcmRequest` has notification + `runId`/`kind`, no `finalText`
- [ ] RED: POST `platform=fcm` 204; 64-hex still apns; missing platform = apns; FCM snap hits FCM not APNs
- [ ] `bun test relay/test/uri.test.ts relay/test/fcm.test.ts relay/test/server.test.ts` fails for the new cases

### Task 2: Relay FCM implementation (GREEN)

**Files:** `relay/src/uri.ts`, `relay/src/fcm.ts`, `relay/src/db.ts`, `relay/src/server.ts`, `relay/src/index.ts`

- [ ] Allow emulator host in `originOf`
- [ ] `createFcmSender` / `loadFcmFromEnv`; missing file = disabled
- [ ] `push_tokens.platform` default `apns`; register/delete as spec
- [ ] `dispatchEdges` fans out by platform; APNs-only and FCM-only both work
- [ ] `bun test relay/test`

### Task 3: Android `:core` JVM (TDD)

**Files:** `mobile/android/core/...`

- [ ] Invite parse (pair reject, https, 10.0.2.2, 64 hex)
- [ ] BoardColumn, unread, archive optimistic merge, operator messages, `view=hidden` URL
- [ ] Markdown HTML subset vs iOS fences
- [ ] `./gradlew :core:test`

### Task 4: Compose `:app` screens + SSE

**Files:** `mobile/android/app/...`

- [ ] Bind / fleet / board / dispatch / detail / Ask+Build / hide
- [ ] OkHttp REST + SSE; foreground start / background stop
- [ ] Deep link `armada-relay`; encrypted token store
- [ ] Assemble debug if Android SDK present

### Task 5: FCM client + README + parity rule

- [ ] Register `platform=fcm`; click `runId`; watchingId suppresses banner
- [ ] README: emulator `10.0.2.2`, FCM env, do not frp 7380
- [ ] `armada-hub-app-parity` Surfaces include `mobile/android/`
