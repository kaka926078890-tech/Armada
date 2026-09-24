# Armada：运行中续发（Cursor 直发 / 队列）

- 日期：2026-09-14
- 状态：v1.1 已落地。Mac 写路径 2026-09-14 点通。Windows **2026-09-20** 续聊注入已过（`r-922b4664` followup 进 cid `4f64e60e`，旁路 cid 0 条探针）；同页双框仍 blocked，不挡本规格。
- 父文档：
  - [2026-08-31-armada-parallel-runs-design.md](../../../../docs/superpowers/specs/2026-08-31-armada-parallel-runs-design.md)（下称《并行》：v1 同 cid `409 CONVERSATION_BUSY`；v1.5 followup FIFO **被本文替代**）
  - [armada-durable-boundaries](../../../.cursor/rules/armada-durable-boundaries.mdc)（三把钥匙；Mac `followup()` 不得立刻退役 live gen）
- 修订范围：`running` 时允许同一张卡、同一 `conversation_id` 再发一条；读被控机 Cursor 默认行为决定详情形态；生成中 CDP 打进当前 composer。不改星型拓扑、不改注入槽「整机一把」、不新开 child run。
- 触发：操作员要对齐 Cursor「对话还在跑时再发下一条」：本机默认队列或直发（steer），详情立刻长得像 Cursor。

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | 同 cid 占用中 `POST /api/runs/:id/followup` → `409 CONVERSATION_BUSY`。详情只能等停。Cursor 已能在生成中 Enter：配置 `queue` 进托盘，`steer` 进当前轮用户句。 |
| 核心方案 | **方案 1：全程打进 Cursor。** `running` 续发不改 `status`；占注入槽后 `openComposer(cid)` + 现网 `COMPOSER_ENTER_JS`（普通 Enter）。心跳上报 `cursor.composer.queueMessageDefaultBehavior`；详情按该值立刻画托盘或当前轮用户句。存在 `state=queued` 时 matching completed → `QUEUE_DRAIN`（记下 `deferred_stop`，清零后重放）。 |
| 关键约束 | ① 详情无 Send/Queue 开关，不改被控机配置。② 同 cid 仍一条 live 生成。③ `running` 续发 **Mac/Win 都不得** `retireLiveGeneration` / 在注入当下 `attachHubGeneration`。④ 注入槽 = `dispatched`/`binding` **加上** `outbound.state=injecting`。⑤ `openComposer(cid)` 硬前置；v1 沿用 `COMPOSER_FOCUS_JS` 空框优先（**只保证焦点卡**）。⑥ `hasOutstandingOutbound` 计未落成用户句的 `queued` 与 `steered`。⑦ running 注入禁止 `addPending` / `bindKnown` / `FollowupStopGuard.arm`。 |
| 明确不做 | 中台 FIFO 代替 Cursor 队列；解析 `settings.json`；Cmd/Alt+Enter 按配置切换；复刻 Keep Queuing 提示；`pending_ask` / `dispatched` / `binding` 续发；v1 运行中带图；v1 CDP 读队列 DOM 纠偏；v1 改 FOCUS 拒绝第一空框。 |

**可行性（写生产前）：**

| OS | 读（DOM） | 写（Enter） | 本规格 |
| --- | --- | --- | --- |
| macOS 3.20.10 | 空框「Add a follow-up」；`.send-with-mode` 空=停、有字=上箭头 | `steer` → `.composer-human-message`；`queue` → `.composer-toolbar-queue-item-list[aria-label="Queued messages"]` → `.composer-toolbar-queue-item` | **已点通**（2026-09-14 本机，焦点卡） |
| Windows | 2026-09-20 跨窗/跨 tab 续聊进对的 cid | 同左（`outcome=injected`，探针只进目标 jsonl） | **cid 路由已过**；同页双输入框 blocked（Cursor Agents 同窗替换） |

---

## 1. 背景与需求

| # | 原始诉求 | 设计映射 |
| --- | --- | --- |
| R1 | 对话任务执行中还能发下一条 | `running` 解除 `CONVERSATION_BUSY`；仍同一张卡、同一 cid |
| R2 | 对标 Cursor 直发 / 队列 | 行为交给被控机 `queueMessageDefaultBehavior`；中台只读、不选、不改 |
| R3 | 详情形态要像 Cursor | `queue` 画托盘；`steer` 画当前轮用户句；一点续发就画，不等 jsonl |
| R4 | 配置在各机 Cursor 上 | 扩展 `getConfiguration("cursor.composer")`，心跳上报；禁止详情切换 |
| R5 | Mac / Windows 一起实现 | 同一注入路径；Win 无 hook：jsonl 认领后签发 **新** hub gen **并 WS 推到扩展**。Win 续聊注入 2026-09-20 已过，不单开 Darwin 分支 |

对照被本方案废止的旧条款：

| 旧条款 | 新语义 |
| --- | --- |
| 《并行》v1「followup 占用中 409」 | `running` 可续发；`queued`/`dispatched`/`binding` 仍 409 |
| 《并行》v1.5「该 cid 的 followup FIFO」 | **不选。** 队列在 Cursor 里；hub outbound 只服务展示、占槽、QUEUE_DRAIN |
| 终态续聊才 `run.followup` | `running` 也可发 `run.followup`；**不**把卡打回 `dispatched` |
| 《并行》P5「正在生成时注入会打断」 | 本机已点通生成中 Enter；打断/排队由 Cursor 配置决定 |

**备选（不选）：**

| 方案 | 为什么不选 |
| --- | --- |
| 方案 2：按配置分流（queue 时 hub 等 stop 再 followup） | 产品要 Cursor 自己消化；hub 再排会双队列 |
| 方案 3：只做中台队列 | 本机默认已是 `steer`，详情会长期画错 |
| 详情里选 Send/Queue | 配置在被控机，不是操作员选项 |

---

## 2. 现状盘点

| 类别 | 内容 |
| --- | --- |
| 可复用 | `openComposer(cid)` + `COMPOSER_ENTER_JS`（**仅注入段**）；注入槽 / `cdp.lock`；`decideStop` 决策表；详情 `RunDetail` 续发框；`normalizePrompt` + `extractUserText` |
| 需新建 | `run_outbound`；心跳字段；`injectSlotCount` 计入 `injecting`；`decideStop` + `deferred_stop` + 重放；`onRunAck` running 分支；WS `run.generation`；详情托盘 / 乐观用户句 |
| 不复用 / 有害 | occupying 一律 409；`running` → `dispatched`；现网 `onRunAck` 非 dispatched 直接 return；现网 `Executor.followup` 全套（`addPending`+`bindKnown` 会 `FollowupStopGuard.arm`，吞当前轮 synth stop）；Win 注入当下 `attachHubGeneration`；hub-only 签发不推扩展；2s 时间窗把 unknown 当成 queued 闸 stop |

代码锚点：

| 位置 | 今天 | 目标 |
| --- | --- | --- |
| `hub/src/runs.ts` `followup` | occupying → 409；成功则 `dispatched` | `running` 保持 status；插 outbound `injecting` |
| 同文件 `onRunAck` | `status !== dispatched` return | running + injecting：只改 outbound，**禁止** `setStatus(binding/error)` |
| 同文件 Win 签发 | `isWindows \|\| !live` 总签发 | **仅终态续聊**；running 注入不签发；认领后 Win 签发 **并** `run.generation` |
| `hub/src/generationOwnership.ts` `decideStop` | 无队列闸 | `hasOutstandingOutbound` 计 `queued` 与未落成的 `steered`；`QUEUE_DRAIN` + deferred 重放 |
| `extension/src/executor.ts` `followup` | 成功后 `addPending`+`bindKnown` | running：只 openComposer+Enter+ack；**不** bindKnown |
| `extension/src/extension.ts` | `noteHubGeneration` 只吃 start/followup | 增加 `run.generation` → `noteHubGeneration` |
| 心跳 | `openWorkspaces` / `activeRunIds` | `queueMessageDefaultBehavior` |
| `RunDetail.tsx` | busy「等它停再续」 | `running` 可发；outbound 画托盘/气泡 |

---

## 3. 设计原则

1. **Cursor 消化，中台镜像。** 队列/直发权威在 Composer；hub outbound 服务展示、占槽、QUEUE_DRAIN。
2. **配置只当先验。** 读 VS Code API，不拆 `settings.json`。未知配置不得写成 `queued` 去挡 completed。
3. **三把钥匙不动。** 窗口+工作区走注入；cid 走 ingest；`generation_id` 走忙闲。禁止用 2s 时间窗 / prompt 字符串当 stop 闸。
4. **OS 共用注入，停跑分表。** 禁止 Darwin 复制 followup。Win 差只在认领后签发新 hub gen **并推扩展**。
5. **先红后绿。** §9 夹具入仓必红。测不红不准改 `followup` / `decideStop` / `onRunAck`。
6. **先拒错再求快。** 注入失败不留假托盘/假用户句；ack 丢了不得把 running 打成 error。
7. **展示单一合并。** running 续发不写 hub `beforeSubmitPrompt`。详情 = `eventsToChat` ∪ outbound。

---

## 4. 数据模型 / 接口契约

### 4.1 心跳

扩展 → hub `heartbeat` 增加只读：

| 字段 | 来源 | 约束 |
| --- | --- | --- |
| `queueMessageDefaultBehavior` | `vscode.workspace.getConfiguration("cursor.composer").get("queueMessageDefaultBehavior")` | 原样字符串。本机已见 `steer` / `queue` |

落在 `machines`（按机）。详情用该 run 所在机器最新值。配置变更只影响**之后**的续发。

v1 识别与 outstanding：

| 心跳值 | ack 后 `state` | 计入 `hasOutstandingOutbound` | 详情 |
| --- | --- | --- | --- |
| `queue` | `queued` | **是** | 托盘 |
| `steer` | `steered` | 否 | 当前轮乐观用户句 |
| 其它 / 缺失 `unknown` | `steered`（按吃当前 gen） | **否** | 「已提交」；**禁止** 2s 分拣写成 `queued` |

**备选：** unknown 用 2s jsonl 分拣。不选：jsonl 滞后会把 steer 当成 queued，卡片卡 running；等于用时间窗当 stop 闸。

### 4.2 待消化续发（表 `run_outbound`）

同一张卡、同一 cid，不 insert child run。

| 字段 | 约束 |
| --- | --- |
| `id` / `run_id` | PK；FK `runs.id` |
| `prompt` / `attachments` | 与现网 followup 相同；v1 running **纯文本**（`attachmentIds.length>0` → 409 `OUTBOUND_TEXT_ONLY`） |
| `expected_mode` | 注入当时心跳：`queue` / `steer` / `unknown` |
| `state` | `injecting` → `queued` \| `steered` \| `failed`；增量 jsonl user 认领 → `consumed` |
| `created_at` | epoch ms；认领下界 |
| 唯一 | 同 run 未 `consumed`/`failed` 的规范化 prompt 不可重复 → 409 `PROMPT_COLLISION` |
| 每卡上限 | 未消耗（含 injecting/queued/steered）≤ **8** → 429 `OUTBOUND_LIMIT`（**不是** `RUN_LIMIT`） |

另保留现网工作区闸：同机同 `workspace_root`、其它 occupying 卡规范化 prompt 全等 → 409 `PROMPT_COLLISION`（except 本 `runId`）。两道都要，见《并行》P4。

**注入槽：**

```sql
-- 仍 ≤ 1
COUNT(*) dispatched/binding on machine
+ COUNT(*) run_outbound.state='injecting' on that machine
```

`injecting` 超过 **30s** 无 ack → `failed`，释放槽（对齐 `DISPATCH_TIMEOUT`）。**不**因此改 run.status。

`runs` 增加（或同表 JSON）：`deferred_stop` TEXT NULL — QUEUE_DRAIN 时保存被 ignore 的 stop payload 快照 + 当时 `live_generation_id`。

### 4.3 REST / WS

`POST /api/runs/:id/followup` body 不变。带图的 running 请求 → 409 `OUTBOUND_TEXT_ONLY`。

| 原状态 | 结果 |
| --- | --- |
| `running` 且无 `pending_ask`、有 cid、纯文本 | 201；outbound `injecting`；**status 仍 `running`** |
| `queued` / `dispatched` / `binding` | 409 `CONVERSATION_BUSY` |
| `pending_ask` | 409 `CONVERSATION_BUSY` |
| 注入槽忙 | 409 `INJECT_SLOT_BUSY`；不插 outbound |
| 终态 | 现网：`dispatched` + 可签发 hub gen（Win / live 空） |

SSE：`run.outbound` `{ runId, outboundId, state, expected_mode, prompt }`。

Hub → Ext 新消息（旧扩展可忽略）：

```text
run.generation { runId, generation_id }
```

**只**调用 `noteHubGeneration`。禁止当成 `run.followup` 再注入。认领后 Win 签发新 gen 必须发这条。Mac 认领后不发（等 BSP `decideArm`）。

`httpStatusForRunError`：`OUTBOUND_LIMIT` / `OUTBOUND_TEXT_ONLY` → 429 / 409。

### 4.4 `onRunAck`（running）

现网：`status !== dispatched` 则 return。必须加分支：

| 条件 | 行为 |
| --- | --- |
| `status=running` 且存在 `outbound.state=injecting` | **只**改该 outbound + SSE；**禁止** `setStatus(binding/error)` |
| accepted + `expected_mode=queue` | → `queued` |
| accepted + `steer` / `unknown` | → `steered` |
| rejected / `NON_EMPTY_INPUT` / `CDP_LOCK_TIMEOUT` / `FOLLOWUP_FAILED` | → `failed`；释放槽；run 保持 running；详情不留气泡 |

终态续聊的 dispatched ack 保持现网（可 binding / error）。

### 4.5 `decideStop`

禁止在 `onStopEvent` 旁路。必须改 `generationOwnership.ts` 决策表 + 规格 + 真形状测试。

新输入：`hasOutstandingOutbound` = 该 run 存在 **`state=queued` 或 `state=steered`**（不含 injecting / unknown）。用户句认领 steered 后清掉 deferred stop，避免上一轮完成盖住新轮。

| 条件 | action | audit |
| --- | --- | --- |
| 本会 **apply** 的 completed/success（含 `STOP_SESSION_GEN`）且存在 `queued` | `ignore` | `QUEUE_DRAIN` |
| aborted / error / user abort / 操作员 cancel | **apply** | 现网；所有未消耗 outbound → `failed`；清空 `deferred_stop` |
| `steered` / `injecting` / `unknown` | 不挡 | injecting 只占槽；steer 吃当前 gen |
| 无 `queued` | 现网表 | 不变 |

**QUEUE_DRAIN / BG_DRAIN 闭合（必须）：**

1. ignore 时把本次 stop payload + 当时 `live_generation_id` 写入 `deferred_stop`（覆盖同 gen 的旧快照；BG_DRAIN 带 `reason`）。
2. outstanding `queued` 清零后：若 `deferred_stop` 非空且 live 仍是该 gen 且期间未 rearm / 未 `attachHubGeneration` 新 gen → **同步重放** `onStopEvent(deferred_stop)`，然后清空。
3. 认领导致 Mac BSP rearm、主人 UUID `preToolUse` rearm 或 Win `attachHubGeneration` 新 gen → **立刻作废** `deferred_stop`（旧轮 stop 不得盖新 gen）。
4. 120s 超时 **从第一次 drain 写入 `deferred_stop` 起算**，不得从 inject/`created_at` 起算。QUEUE_DRAIN 超时：仍 `queued` 或 `steered` 的条 → `failed`，然后走 2。BG_DRAIN 同一时钟：`hasOpenSubagentTranscript` **只计本轮**（`ts >= COALESCE(started_at, created_at)`，续发会重置 `started_at`）。未到 120s 且本轮 child 仍开着 → `maybeReplay` return。120s 到点且 live 未换 → 重放 completed，即使 child 从未 `turn_ended`（`r-b770619c` 孤儿 jsonl 不得永久挂 loading）。重放时 `onStopEvent(..., { replayDeferred: true })`，避免清掉 `deferred_stop` 后又被同一条开着的 child 再次 `BG_DRAIN`。不在子代理 `turn_ended` 当下同步重放——协议续轮的 UUID `preToolUse` 可能晚于最后一条 child jsonl（`r-43b92cc0`）。不新开 `decideStop` 出口码。

**备选：** 超时直接 `setStatus(completed)`。不选：没有 matching stop 重放会与 `generation_id` 合同脱节；Win synth 依赖 stamp。

### 4.6 认领 → `consumed`

禁止扫全量历史、禁止用首轮 `run.prompt` 对上立刻 consumed。

| 规则 | 值 |
| --- | --- |
| 来源 | `source=transcript` 且 role=user 的 **新** ingest 行，`ts`/`seq` ≥ 该 outbound `created_at` 之后 |
| 文本 | `normalizePrompt(extractUserText(text))` 与 outbound 规范化 prompt 全等 |
| 顺序 | 未消耗 outbound 按 `id` FIFO；每条最多认领一次 |
| Mac BSP | 同 prompt 的主会话 BSP 可作加速认领，**不得**替代 jsonl 增量规则 |
| 认领后 | `consumed`；若无剩余 `queued` 且有 `deferred_stop` → 按 4.5 作废或重放 |

Windows 认领后：`attachHubGeneration("hub_windows")` **并且** `registry.sendTo` `run.generation`。禁止只改 SQLite。

---

## 5. 运行时链路

`running` 续发 **不** `setStatus(dispatched)`。

```text
POST followup (status=running, 纯文本)
  → pending_ask / 未 bind → 409 CONVERSATION_BUSY
  → 槽忙 → 409 INJECT_SLOT_BUSY
  → insert outbound injecting；send run.followup（不带新 hub gen）
  → Ext: openComposer(cid) + COMPOSER_ENTER_JS
       禁止 addPending / bindKnown / FollowupStopGuard.arm / 二次 run.bound
  → onRunAck: 只改 outbound（§4.4）

onStopEvent 本会 apply 的 completed/success
  → 有 queued → ignore QUEUE_DRAIN + 写 deferred_stop
  → 无 queued → 现网 completed

queued 被增量 jsonl user 认领
  → consumed；作废 deferred_stop
  → Mac: 等 BSP decideArm
  → Win: attachHubGeneration + run.generation（扩展 noteHubGeneration）
  → 后一次 stamp 了新 live gen 的 turn_ended → completed

queued 在 drain 后 120s 仍未认领（含人手删 Cursor 队列）
  → queued→failed；重放 deferred_stop
```

**注入键：** 始终普通 Enter。不按配置改 Cmd/Alt+Enter。

**展示合并（唯一 SoT）：**

| 层 | 内容 |
| --- | --- |
| `eventsToChat` | 现网 jsonl/hooks；running 续发 **不** `recordFollowupPrompt`（queue 与 steer 都不写） |
| outbound `queued` | 托盘，**不**进用户气泡 |
| outbound `steered` | 当前轮乐观用户句；jsonl 同文到达后只留 transcript |
| DOM 纠偏 | **v1 不做** |

**降级：**

| 失败 | 行为 | 指标 |
| --- | --- | --- |
| `INJECT_SLOT_BUSY` | 不写 outbound | 无假托盘 |
| `NON_EMPTY_INPUT` / CDP / `FOLLOWUP_FAILED` | outbound `failed`；run 仍 running | 输入框保留原文 |
| `openComposer` throw | 同上 | 现网 reason，不新码 `FOLLOWUP_FOCUS` |
| stop 与 injecting 重叠 | injecting **不**闸 stop；失败 → failed；成功且 queue → `queued`，若已有 deferred_stop 则继续 drain；steer 成功 → 立即重放 deferred completed | — |
| 人手删队列 | drain 起 120s → failed + 重放 | 不永远 running |
| 操作员取消 / abort | apply 终态；outbound `failed` | 不自动再 followup |
| 机器离线 | 现网 `MACHINE_OFFLINE`；outbound `failed`；清空 deferred_stop | 不上线补发 |
| 回滚 | `running` 再 409；`UPDATE run_outbound SET state='failed'`（或丢表）；心跳列可留 | 续发再 409；UI 无托盘 |

**性能：** 生成中注入占槽 p95 ≤ 8s、p99 ≤ 20s。每卡未消耗 outbound ≤ 8。

### 5.1 Mac vs Windows

| | macOS | Windows |
| --- | --- | --- |
| 验证 | 2026-09-14 本机焦点卡：steer 用户句、queue 托盘 | **未验证**；实现仍要写 |
| Hooks | 有；BSP 武装 / rearm | 不装 |
| `running` 注入当下签发 hub gen | **禁止** | **禁止** |
| `FollowupStopGuard` | running 注入不得 arm（否则 Win 更惨；Mac hook stop 本不受 guard，禁止分叉实现） | 同左 |
| 队列条真正提交 | 增量 jsonl user + BSP `decideArm` | 增量 jsonl user 认领 → 签发新 hub gen **+ `run.generation`**；无 `lastGenerationId` 不得合成 stop |
| 合成 stop | stamp live gen | 同左 |
| v1 焦点 | 只保证 `openComposer` 后的焦点卡 | 同左 |
| 选择器 | 冻 3.20.10 见 §0 | 未冻 |

真形状（Win 必红，禁止用 Darwin hook 代替）：

```text
turn_ended(G1) + queued → ignore QUEUE_DRAIN
→ transcript role=user 匹配 outbound
→ 扩展收到 run.generation G2
→ turn_ended stamp G2 → completed
```

---

## 6. 安全与威胁模型

| 威胁 | 缓解 | 边界外 | 审计 |
| --- | --- | --- | --- |
| 打进别人的对话 | `openComposer(cid)` 硬前置 | 同窗两张 running：v1 FOCUS 仍空框优先 | openComposer 失败 → `FOLLOWUP_FAILED` |
| 假用户句 | running 不写 hub BSP；queue 只进托盘 | 心跳滞后一轮把 steer 画成已提交（unknown 当 steered，不挡 stop） | — |
| 队列未空却 completed | QUEUE_DRAIN + deferred 重放 | Cursor 清空队列 | drain+120s failed 后重放 |
| 扫历史 user 假认领 | 仅 outbound.created_at 之后增量 | 操作员发了相同原文的更早轮次 | — |
| 只改 hub gen 扩展不合成 | `run.generation` 合同 | 旧扩展忽略该消息 → Win 队列后可能永 running | 发布顺序：先扩展再依赖 Win 队列 |
| 读取配置泄漏 | 只上报枚举字符串 | 工作区覆盖 user 设置 | — |

---

## 7. 实施路线图

| 阶段 | 范围 | 验收 | 上线 gate |
| --- | --- | --- | --- |
| v1 | outbound + running followup；心跳；QUEUE_DRAIN+deferred；onRunAck 分支；run.generation；详情托盘/气泡；running 注入不 bindKnown | §9 夹具全红 | Mac overlay：焦点卡 queue + steer 各一次（可临时改配置，测完改回）。停源码 7380 再 pack |
| v1 Win 验证 | 被控 Win 同一套 Enter + G1/G2 真形状 | 生成中回车；队列发出后能 completed | **未过不得宣称 Win 完成** |
| v1.5 | 两张 running 只打中目标 cid；可见框属于该 cid / 多空框 fail-closed | 非焦点卡真机 | 未过则发布说明写「v1 只保证焦点卡」 |
| v2 | 托盘拖拽 / 中台删 Cursor 队列 | 未立项 | — |

发布顺序：hub（闸门 + outbound + deferred）→ 扩展（心跳 + `run.generation` + running 不 bindKnown）→ UI。禁止只改 UI。旧扩展无心跳 → `unknown`（当 steered，不挡 stop）。

---

## 8. 风险与未决

| 风险 | 影响 | 应对 | 状态 |
| --- | --- | --- | --- |
| Win 生成中 Enter 被吞 | 共用代码 `failed` | 失败走错误条；不宣称 Win | 阻塞验证，不阻塞 Mac 验收 |
| 非焦点卡打错框 | 串台 | v1 只保证焦点卡；v1.5 收紧 | Mac 焦点卡已过 |
| `steer` jsonl 滞后 | 乐观气泡 | 不写 hub BSP；同文去重 | 已观测 |
| 旧扩展忽略 `run.generation` | Win 队列后永 running | 先发扩展 | 发布顺序 |
| Cursor 改 class | 中台不靠 DOM | 展示权威 outbound | — |

**阻塞项：** 无（Windows 验证非合入 gate）。Mac 生产仍须 overlay，不是 `tauri dev`。

---

## 9. 评审检查清单

- [x] 固定章节骨架
- [x] MVP/v1/v1.5 切分（Win **实现在 v1、验证单独**）
- [x] 非目标、风险、阻塞、验收
- [x] 跨仓：仅 armada；hub → 扩展 → UI
- [x] Mac vs Windows 对照表
- [x] 修订记录
- [x] Grok 4.6 独立评审闭合项（QUEUE_DRAIN / gen 推送 / bindKnown / unknown / ack）

夹具入仓必红（测不红不准改生产）：

| ID | 条件 | 通过 |
| --- | --- | --- |
| A1 | `running` 无 ask 时 followup 201 且 status 仍 running | hub |
| A2 | occupying 非 running 仍 409 | hub |
| A3 | running 续发 **不** insert hub `beforeSubmitPrompt`（queue 与 steer） | hub |
| A4 | `queued` + matching completed/success（含 `STOP_SESSION_GEN`）→ ignore `QUEUE_DRAIN` 且写入 `deferred_stop` | `generationOwnership` + runs 集成 |
| A5 | 终态续聊 Win 仍签发 hub gen；running 注入当下不签发 | hub |
| A6 | `onRunAck` running+injecting accepted 不 `setStatus(binding)`；rejected 不 `setStatus(error)` | hub |
| A7 | `injecting` 不计入 outstanding：stop 在 injecting 期间仍可 apply | hub |
| A8 | `unknown`/`steer` ack 后不计入 outstanding | hub |
| A9 | drain 后 queued 清零（认领或 120s from drain）→ 重放 deferred_stop → completed | hub |
| A10 | rearm / Win 新 gen 作废 deferred_stop | hub |
| A11 | 认领只用 created_at 之后 transcript user + `normalizePrompt(extractUserText)`；不扫历史 | hub ingest |
| A12 | abort/error/cancel → apply；outbound `failed` | hub |
| A13 | `OUTBOUND_LIMIT` 429；带图 running → `OUTBOUND_TEXT_ONLY` | hub |
| A14 | 工作区 occupying `PROMPT_COLLISION` 仍在 | hub |
| A15 | slot COUNT 含 injecting 时 `promoteNextQueued` 被挡 | hub |
| A16 | offline → outbound failed | hub |
| E1 | running 注入不 `FollowupStopGuard.arm`；当前轮 `turn_ended` 仍可 synth | extension |
| E2 | `run.generation` → `noteHubGeneration`；无 lastGenerationId 不合成 | `generationStamp` |
| E3 | Win 真形状：`turn_ended(G1)` ignore → user → G2 `turn_ended` completed | 集成，禁止 Darwin hook 代替 |
| M1 | Mac overlay 焦点卡：steer 用户句；queue 托盘 | 真机 |
| W1 | Win 同一套 Enter + E3 | **2026-09-20 过**（followup 进目标 cid）；同页双框不挡本规格 |

---

## 10. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-14 | 初稿。方案 1。Mac steer/queue Enter 已点通。Windows 一起实现、未验证。 |
| 2026-09-14 | v1.1：Grok 4.6 独立评审。闭合 QUEUE_DRAIN（`deferred_stop` + 重放；120s 从 drain 起算）；outstanding 只计 `queued`；unknown 不当 queued；`onRunAck` running 分支；running 禁止 bindKnown/FollowupStopGuard；Win 认领必须 `run.generation`；认领限增量 jsonl；展示不写 hub BSP；v1 只保证焦点卡；`OUTBOUND_LIMIT`；running 纯文本；回滚清 outbound 表。 |
| 2026-09-18 | BG_DRAIN 与 QUEUE_DRAIN 共用 120s 重放。子代理 jsonl 收口且 live 未换才 apply；不在 child `turn_ended` 当下重放（`r-43b92cc0` 协议续轮）。 |
| 2026-09-20 | Windows 续聊注入记过（`r-922b4664` / cid `4f64e60e`）。同页双框仍 blocked。 |
| 2026-09-21 | BG_DRAIN 闩只计本轮 child。120s 超时即使孤儿 jsonl 未 `turn_ended` 也重放；`replayDeferred` 防止二次 BG_DRAIN。不新开 decideStop 码（`r-b770619c`）。 |
| 2026-09-24 | 未落成用户句的 `steered` 与 `queued` 一样挡住上一轮 completed。认领后清 deferred；120s 仍未认领则失败并重放。不新开 decideStop 码。 |
