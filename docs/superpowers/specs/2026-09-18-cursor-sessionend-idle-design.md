# Armada：按 Cursor 时钟收口（sessionEnd.final_status）

- 日期：2026-09-18
- 状态：v1 实施基准（真机形状 `r-a0bc34a5` 同期 `hub.db` sessionEnd）
- 父文档：`armada-durable-boundaries`；相关 `2026-09-17-armada-idle-transcript-and-tool-fold-design.md`
- 触发：Composer 已 “Worked for …”，hub 仍 running。`stop` / jsonl `turn_ended` / AAR 都没到。

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | Cursor 一轮结束认 hook `stop`；磁盘认 `turn_ended`。两者都缺时，UI 已闲，live gen 仍在。 |
| 核心方案 | 把 Cursor **`sessionEnd.final_status`** 映射成现有 `stop` 合同，再走 `onStopEvent` → `decideStop`。`generating` = 仍忙。 |
| 关键约束 | **不改** `decideStop` 出口码；不用 AAR 正文；不用墙钟 IDLE_DRAIN；`user_close` 单独不够。 |
| 明确不做 | 改决策表；CDP 读 Composer generating（未点通）；Win 装 hooks。 |

## 1. Cursor 逻辑（本版只跟这一层）

| Cursor 信号 | 含义 | Armada |
| --- | --- | --- |
| hook `stop` | agent loop 结束 | 已有 `onStopEvent` |
| jsonl `turn_ended` | 耐久一轮结束 | 已有合成 stop |
| `sessionEnd` + `final_status=generating` | 会话在拆，loop **还在跑** | **忽略**（`r-a0bc34a5` 18:05:27 之后 hook 仍打） |
| `sessionEnd` + 非 generating | Composer 已不 generating | 映射为 `stop`，盖 live gen |
| `afterAgentResponse` | 一句助手写完 | 不当完成闸 |

`user_close` + `final_status=aborted`：Cursor 拆掉已闲的 composer（不是用户点 Stop）。映射 **`completed`**。`reason=aborted` 才是取消 → `aborted`。

## 2. Mac vs Windows

| | macOS | Windows |
| --- | --- | --- |
| 本路径 | 有 Armada hooks，能收到 `sessionEnd` | **不装** hooks，本路径不跑 |
| 仍有效的闲信号 | `stop` + jsonl `turn_ended` + 本映射 | hub 签发 gen + jsonl `turn_ended` 合成 stop |
| 无 `sessionEnd` 的假跑 | 仍靠 jsonl / 操作员停跑 | 同左（jsonl） |

## 3. 映射

`hub/src/generationOwnership.ts` `stopFromCursorSessionEnd`：

| 输入 | 输出 |
| --- | --- |
| `final_status` 空或 `generating` | `null` |
| `reason=error` 或 `final_status=error` | `{ status:"error", gen, cid }` |
| `reason=aborted` | `{ status:"aborted", gen, cid }` |
| `reason=user_close\|window_close` 且非 generating | `{ status:"completed", gen, cid }` |
| `final_status=completed\|success` | `{ status:"completed", gen, cid }` |

ingest：`sessionEnd` 若映射非空 → `onStopEvent`。sweep 对 running 回放**最新一条** sessionEnd（旧 hub 已入库的 `r-a0bc34a5`）。

## 4. 验收

- 夹具 `r-a0bc34a5` generating → 仍 running；随后 user_close+aborted → completed。
- 库里已有 aborted sessionEnd、尚未 onStopEvent → `sweepTimeouts` 收口。
- `decideStop` 测试全绿。

## 5. 风险

| 风险 | 应对 |
| --- | --- |
| 无任何 sessionEnd 的假跑（`r-81d114a1` 扩展宿主重启后无 teardown） | 本版不收；等 jsonl `turn_ended` / `stop` / 操作员停跑 |
| 把进行中的关窗当成完成 | `generating` 挡住；关窗当时若仍 generating 则不收 |

## 6. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-18 | 初稿并落地。真机两条 sessionEnd。不改 `decideStop`。 |
