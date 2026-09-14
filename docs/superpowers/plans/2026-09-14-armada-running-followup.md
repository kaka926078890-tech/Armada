# Running followup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Spec: `armada/docs/superpowers/specs/2026-09-14-armada-running-followup-design.md` v1.1.

**Goal:** `running` 时同一张卡可续发；Cursor 按本机 `queue`/`steer` 消化；详情立刻画托盘或当前轮用户句。

**Architecture:** Hub `run_outbound` 记待消化条；`running` 不改 status、不签发 live gen。扩展 `openComposer`+Enter；`live:true` 时不 `bindKnown`。`queued` 挡住 matching completed（`QUEUE_DRAIN` + `deferred_stop` 重放）。Win 认领后 `run.generation` 推扩展。

**Tech Stack:** bun, SQLite, Hono, VS Code extension, React.

## Global Constraints

- 不 Darwin 特判注入。Win 差只在认领后签发 hub gen + `run.generation`。
- `hasOutstandingOutbound` 只计 `state=queued`。
- running 续发不写 hub `beforeSubmitPrompt`。
- 测不红不准改 `followup` / `decideStop` / `onRunAck`。
- Armada 主干 `master`。

## Files

| File | Role |
| --- | --- |
| `hub/src/generationOwnership.ts` | `hasOutstandingOutbound` → `QUEUE_DRAIN` |
| `hub/src/db.ts` | `run_outbound`；`runs.deferred_stop`；`machines.queue_message_default_behavior` |
| `hub/src/outboundClaim.ts` | transcript user 文本规范化 |
| `hub/src/runs.ts` | followup running；ack；drain；认领；sweep |
| `hub/src/ingest.ts` | 增量 user 认领 |
| `hub/src/concurrency.ts` | `OUTBOUND_LIMIT` / `OUTBOUND_TEXT_ONLY` |
| `hub/src/registry.ts` | 心跳字段 |
| `extension/src/executor.ts` | `live` 不 bindKnown |
| `extension/src/extension.ts` | 心跳 + `run.generation` |
| `hub/web` | RunDetail 托盘/乐观句 |
| tests | 规格 §9 夹具 |

## Tasks (TDD)

1. `decideStop` QUEUE_DRAIN 表测 → 改决策表
2. hub 集成：running followup / ack / drain+replay / claim / Win generation WS
3. extension：live 不 arm guard；`run.generation`
4. UI：outbound 托盘 + steered 气泡
5. README 错误码；`bun test` 全绿

单测命令：`bun test hub/test/generationOwnership.test.ts hub/test/runs.test.ts hub/test/ingest.test.ts extension/test/executor.test.ts extension/test/generationStamp.test.ts hub/web/test/chatView.test.ts`
