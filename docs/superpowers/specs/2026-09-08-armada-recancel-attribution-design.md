# Armada 重取消的注入归属判据

- 日期：2026-09-08
- 状态：**已实现 + 单测通过；真机验收未完成 → 不得标记为上线基准**
- 修订范围：`CancelWatcher.shouldCancelAgain` 增加「提交是否由 Armada 自身注入造成」判据。**不改** `composer.cancelChat` 调用方式、`run.cancel` 协议、`generation_id` 忙闲判定、`decideStop` 决策表、ingest 归卡。
- 相关规则：`.cursor/rules/armada-durable-boundaries.mdc`（prompt 不得当闩）、`armada-os-invariants.mdc`（Mac/Windows 对照）、`armada-feasibility-before-solution.mdc`（真机未过不得宣称完成）

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | 重取消只认「同 `conversation_id` + 同 `prompt` + 20s 内」。人手动重发一段与之前相同的文字，形状与 Armada 残留注入完全一致，会被误取消；`composer.cancelChat` 连带把该轮在飞的 subagent 标记为 cancelled，表现为「subagent stopped，主 Agent 一直 wait」。 |
| 核心方案 | 引入**注入归属闸**：`CancelWatcher` 记录 Armada 自己最后一次提交落地的时刻（按 `runId`），仅当候选 `beforeSubmitPrompt` 落在该时刻后 5s 宽限内才允许重取消。判据从「文本相同」换成「这次提交是不是我造成的」。 |
| 关键约束 | ① 严格收窄，触发条件只减不增，竞态保护原样保留。② 归属时刻只由 `Executor` 在自身提交成功后打点，不从正文/gen 推断。③ 宽限 5000ms = spool 轮询 1000ms 的 5 倍余量。④ 20s 记录窗与 2 次上限不变。⑤ `onInjected` 可选，未接线时降级为**永不重取消**。⑥ 重取消只存在于装了 hooks 的 macOS。 |
| 明确不做 | 用 `generation_id` 做判据（**已证伪**，见 §3 D1）；改成状态验证式取消（列为 v2）；缩窗降次的纯风险规避；去掉 prompt 判据；修 Windows 侧缺口；修 `cdpInject.ts` 裸 Escape / `pending_ask` 归属 / 窗口定向三项相邻缺陷。 |

---

## 1. 背景与需求

| # | 原始诉求 | 设计映射 |
| --- | --- | --- |
| R1 | 修复 Armada 频繁导致 subagent 进入停止状态 | 归属闸阻断「人工重发被误取消」这条唯一已证的 Armada 侧致停路径 |
| R2 | 要长期方案，不要再叠一道 seam 守卫 | 判据换轴（文本 → 因果归属），单一共享边界 `CancelWatcher`，不新增并行门 |
| R3 | 三阶段完整修复 | Phase 1 红测试 / Phase 2 实现 / Phase 3 回归，见 §7 |
| R4 | 相邻问题不要静默扩大范围 | §8 列出四项已发现未修项，等开发者决定 |
| R5 | 该机制此前无任何规格记载 | 本文档；`git log -S shouldCancelAgain` 仅追到 `32362dc`，commit body 为空 |

### 1.1 缺陷复现形状

| 场景 | `conversation_id` | `prompt` | `generation_id` | 旧行为 | 期望 |
| --- | --- | --- | --- | --- | --- |
| A：Armada 迟到的注入落地 | 相同 | 相同 | 全新 | 重取消 ✅ | 重取消 |
| B：人手动重发同一段文字 | 相同 | 相同 | 全新 | 重取消 ❌ | 放过 |

A 是真实竞态而非假想：`startRun` 可持 CDP 锁 25s（`executor.ts` `acquireCdpLock` `timeoutMs: 25_000`），`injectPrompt` 还要先 `sleep(1500)` 再粘贴提交，而 `run.cancel` 随时可能在这中间到达（`extension.ts:511-514`）。所以取消之后仍会落地一次由 Armada 造成的同文本提交。

A 与 B 在事件层面**逐字段同形**，因此文本判据与 gen 判据都无法区分（§3 D1）。

---

## 2. 现状盘点

| 类别 | 内容 |
| --- | --- |
| 可复用 | `CancelWatcher.records`（`runId → {cid, prompt, at, count}`）；`SpoolForwarder` 的 `beforeSubmitPrompt` 投递（`extension.ts:321`）；`Executor.startRun` / `followup` 已有明确的「提交成功」收口点；`ExecutorDeps` 的可选回调惯例（`addPending` / `removePending`） |
| 需新建 | `CancelWatcher.lastInjectAt` + `noteInjection()`（`executor.ts:18,21`）；`ExecutorDeps.onInjected`（`executor.ts:62`）；两处调用点（`executor.ts:185,289`）；`extension.ts:258` 接线；4 条测试 |
| 不复用 / 有害 | `generation_id`（A/B 两场景都是全新 gen，无区分力）；助手正文 / thought / AAR（`armada-durable-boundaries` 明令禁止用于推断）；`pendingRuns` 存活状态（bind 后即移除，覆盖不到注入后窗口） |

### 2.1 Mac vs Windows 对照

| | macOS | Windows |
| --- | --- | --- |
| Armada hooks | 安装（`spoolScriptName` → `armada-spool.sh`，`hooksInstall.ts:13-14`） | **不安装**（`shouldInstallArmadaHooks` 对 `.exe`/`.ps1` 返回 false，`hooksInstall.ts:71-74`） |
| `beforeSubmitPrompt` 进 spool | 是 | **否** |
| 重取消是否可能触发 | 是 | **从不触发**（无 BSP 事件源） |
| 本次缺陷 B 是否存在 | 存在 → 本次修复 | 不存在 |
| 场景 A 竞态保护 | 有（本次保留） | **缺口，既有，本次不修**（见 §8 U3） |
| 本次改动是否影响 | 是 | 否（死路径，行为不变） |

结论：本修复是 **macOS 侧行为变更，Windows 侧零影响**。不得据此声称 Windows 已验。

---

## 3. 设计原则

1. **判据必须落在因果上，不落在文本上。** 同文本是巧合，「我按了回车」是事实。`armada-durable-boundaries` 已规定 prompt 一旦有 cid 就不得参与 stop 或重建。
2. **只收窄，不放宽。** 任何新判据必须使重取消的触发集合成为原集合的真子集，否则会引入新的误取消。
3. **归属信号由动作方打点，不由观察方推断。** 只有 `Executor` 知道自己何时提交，就由它上报；`CancelWatcher` 不去猜。
4. **缺信号时向安全侧降级。** `onInjected` 未接线 → 永不重取消（宁可漏掉竞态保护，不可误停用户轮次）。
5. **共享边界只有一处。** 判据集中在 `CancelWatcher.shouldCancelAgain`，不在 Finclaw / ACP / 各调用点各加一道。
6. **常量要有推导依据。** 宽限值必须从可观测的系统参数（轮询周期）推出，不取魔数。

### 3.1 关键决策与备选方案

**D1：判据用什么？**

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **注入归属时刻**（采纳） | ✅ | 唯一能区分 A/B 的信号。Armada 知道自己的提交时刻，人工重发不在该时刻的宽限内。 |
| `generation_id` 比对 | ❌ **证伪** | A 与 B 都产生全新 gen（`generationStamp.ts:9` 的 BSP 确实带 gen，但两场景取值特征一致）。加此判据会把 A 一并压掉，等于删除竞态保护。这是本次设计的首个错误方向，记录在此以免重犯。 |
| 状态验证式取消 | ⏸ 推 v2 | 最持久：`cancelChat` 后看真实空闲信号（`turn_ended` / stop）确认是否生效，未生效才重试，彻底不需要匹配提交事件。但要新接确认信号通路，改动面远超本次。 |
| 缩窗降次（20s→3s、2→1） | ❌ | 不改语义、只降概率，正是 `long-term-minimal-fixes` 所禁的「叠加又一道 seam 守卫」。 |

**D2：归属信号如何传给 `CancelWatcher`？**

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **`ExecutorDeps.onInjected` 可选回调**（采纳） | ✅ | 与 `addPending` / `removePending` 同惯例；`CancelWatcher` 保持无 vscode 依赖、可 bun 单测；接线一行。 |
| `CancelWatcher` 直接持有 `Executor` 引用 | ❌ | 造成双向依赖，且 `CancelWatcher` 的可测性（当前无 vscode 运行时即可测）会被破坏。 |
| 复用 `pendingRuns` 判存活 | ❌ | `pendingRuns` 在 bind 成功即移除，覆盖不到「注入已完成、取消随后到达」的窗口，判据会漏。 |

**D3：是否保留 `prompt` 判据？**

保留，但**降级为记录选择器**而非放行闩。备选是完全删除、仅按 cid 选记录——被否，因为那会让「取消后该 cid 下任意提交」都进入候选，属于放宽，违反原则 2。放行与否完全由归属闸决定，符合 `armada-durable-boundaries` 对 prompt 的限制。

**D4：宽限取 5000ms？**

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| **5000ms**（采纳） | ✅ | spool 轮询 1000ms（`extension.ts:387-391`），留 5 倍余量吸收事件积压与 hook 脚本执行开销。 |
| 1000ms | ❌ | 等于轮询周期本身，零余量；一次积压就漏掉场景 A。 |
| 20000ms | ❌ | 等于原记录窗，收窄效果归零，缺陷 B 依旧。 |

---

## 4. 数据模型 / 接口契约

### 4.1 `CancelWatcher` 内部状态

| 字段 | 类型 | 唯一键 | 约束 |
| --- | --- | --- | --- |
| `records` | `Map<runId, {cid, prompt, at, count}>` | `runId` | 仅由 `run.cancel` 写入（`extension.ts:514`）；`at` 超 `CANCEL_RECORD_WINDOW_MS` 即删；`count` 上限 2 |
| `lastInjectAt` | `Map<runId, number>` | `runId` | 仅由 `Executor` 自身提交成功写入；`noteInjection` 时机会性清理超 20s 条目（`executor.ts:22-24`），故条目数上界 = 近 20s 内派发的 run 数 |

### 4.2 常量

| 常量 | 值 | 位置 | 依据 |
| --- | --- | --- | --- |
| `CANCEL_RECORD_WINDOW_MS` | 20_000 | `executor.ts:7` | 沿用原有行为，未改 |
| `INJECT_ATTRIBUTION_MS` | 5_000 | `executor.ts:13` | spool 轮询 1000ms × 5 余量，见 D4 |
| 重取消次数上限 | 2 | `executor.ts:42` | 沿用原有行为，未改 |

### 4.3 方法契约

| 签名 | 语义 | 兼容策略 |
| --- | --- | --- |
| `noteInjection(runId: string, nowMs: number): void` | 记录 Armada 自身提交落地时刻；顺带清理过期条目 | 新增方法，无调用方时不影响既有行为 |
| `record(runId, conversationId, prompt, nowMs): void` | 不变 | 签名未改 |
| `shouldCancelAgain(ev, nowMs): string \| null` | 返回需重取消的 `cid`，否则 `null` | 签名未改；**返回 `null` 的情形严格增多** |
| `ExecutorDeps.onInjected?: (runId) => void` | 自身提交落地回调 | **可选**。不传 → `lastInjectAt` 恒空 → 永不重取消（安全降级） |

### 4.4 放行决策表

| `records` 命中 | 20s 记录窗 | `lastInjectAt` 有值 | 距注入 ≤5s | `count` | 结果 |
| --- | --- | --- | --- | --- | --- |
| 否 | — | — | — | — | `null` |
| 是 | 超期 | — | — | — | 删记录，继续扫下一条 |
| 是 | 内 | **否** | — | — | **`continue`（本次新增）** |
| 是 | 内 | 是 | **否** | — | **`continue`（本次新增）** |
| 是 | 内 | 是 | 是 | ≥2 | `null` |
| 是 | 内 | 是 | 是 | <2 | `count+1`，返回 `cid` |

未归属时用 `continue` 而非 `return null`：同 cid 同 prompt 可能对应并发的多个 run，跳过本条仍应给其余记录机会。

### 4.5 错误码

本路径不产生新错误码。`onInjected` 是纯本地打点，无 I/O、无抛出面。既有 `INJECT_FAILED` / `NON_EMPTY_INPUT` / `CDP_LOCK_TIMEOUT` 语义不变；注入失败时 `startRun` / `followup` 提前 return，**不会**打归属点（`executor.ts:185,289` 位于成功分支之后），因此失败注入不会误开放重取消窗口。

---

## 5. 运行时链路

### 5.1 场景 A：Armada 迟到的注入（必须重取消）

```
t=0      hub → run.start
t=0      startRun 取 CDP 锁，addPending
t=1.0s   hub → run.cancel
           ├ clearGeneration(runId)              extension.ts:511
           ├ cancelWatcher.record(runId,cid,…)   extension.ts:514
           └ executor.cancel(cid) → composer.cancelChat
t=1.5s   injectPrompt 粘贴 + 回车落地
           └ onInjected(runId) → noteInjection(runId, 1.5s)   executor.ts:185
t=1.6s   BSP 经 spool 轮询送达 shouldCancelAgain
           判据：距注入 0.1s ≤ 5s  → 放行，返回 cid → 重取消 ✅
```

### 5.2 场景 B：人工重发（必须放过）

```
t=0      startRun，注入于 t=1.5s 落地 → noteInjection(runId, 1.5s)
t=5.0s   hub → run.cancel → record(runId, cid, prompt)
t=8.0s   人手动重发同一段文字 → BSP
           判据：距注入 6.5s > 5s  → continue → 返回 null → 放过 ✅
           （旧实现在此返回 cid，取消掉用户自己的新轮次并停掉其 subagent）
```

### 5.3 失效与降级策略

| 情形 | 行为 | 后果 |
| --- | --- | --- |
| `onInjected` 未接线（外部嵌入 / 老接线） | `lastInjectAt` 恒空 → 永不重取消 | 安全侧：丢竞态保护，不误停 |
| CDP 不可用，走剪贴板回退且无 `autoSubmit` | Armada 只粘贴不回车，归属点从**粘贴时刻**起算 | 若人工回车晚于 5s，场景 A 漏保护（见 §8 U4） |
| spool 事件积压 > 5s | 场景 A 漏保护 | 只漏保护，不误停；5 倍余量已按 1s 轮询留足 |
| Windows | 无 BSP 事件源，整条路径不触发 | 行为不变 |

无缓存需引入；两张 Map 均为进程内状态，随扩展 `deactivate` 释放。

---

## 6. 安全与威胁模型

| 威胁 | 缓解 | 状态 |
| --- | --- | --- |
| 误取消用户自己的轮次，连带停掉其 subagent（本次缺陷） | 归属闸要求提交在 Armada 自身注入的 5s 宽限内 | 本次修复 |
| 伪造 spool 事件（同 cid + 同 prompt）诱发取消 | 攻击面收窄：还需恰好落在 Armada 注入后 5s 内，攻击者无法仅凭文本触发 | 收窄，非闭合 |
| 取消影响错误的会话 | 取消目标始终取自 `records` 里的 `cid`，不从事件载荷取 | 既有，未变 |
| spool 目录写权限本身 | 本机用户级目录，属边界外风险 | 不在本次范围 |

审计：重取消决策与注入打点均可由扩展 `log()` 观察；`extension.ts:321` 的 `reCancel` 分支是唯一触发点，便于对账。本次不新增日志字段。

---

## 7. 实施路线图

| Phase | 内容 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| 0 | 事实核准：BSP 是否带 gen、A/B 是否同形、Windows 是否有 BSP、轮询周期 | 四问均有代码位置佐证（`generationStamp.ts:9`、§1.1、`hooksInstall.ts:71-74`、`extension.ts:387-391`） | ✅ |
| 1 | 红测试 | `bun test extension/test/cancelWatch.test.ts` 出现**真实断言失败**（非方法缺失）：`no injection ever attributed` 期望 `null` 实收 `"cid-1"` | ✅ 4 fail |
| 2 | 实现 + 接线 | 同套件 7 pass / 0 fail；场景 A 用例（`Armada's own late injection lands after cancel`）必须为 pass，证明未误删竞态保护 | ✅ |
| 3 | 质量门回归 | `bun test hub/test extension/test hooks/test hub/web/test desktop-core/test` → 0 fail；`tsc --noEmit` 无新增错 | ✅ 447 pass / 5 skip / 0 fail |
| 4 | **真机验收（上线 gate）** | 见 §7.1 | ❌ **未完成** |

### 7.1 上线 gate（Phase 4 验收条件）

必须在带 `--remote-debugging-port` 的 Cursor 真机上逐条取得证据，缺一不得标记上线基准：

1. 派发一个 run，取消后**在 3s 内**由 Armada 迟到注入落地 → 观察到重取消发生（场景 A 未被本次修复削弱）。
2. 派发一个 run，取消后**等待 >5s** 再由人工重发同一段文字 → 观察到**不发生**重取消，且该轮 subagent 正常跑完（缺陷 B 已修）。
3. 确认 `composer.cancelChat` 对父 cid 生效时，在飞 subagent 确实被标记 cancelled——当前此结论来自 Cursor 打包代码 `setLoadingToolFormerToolsToCancelled` 的**静态推断**，未真机观测。

按 `armada-feasibility-before-solution`，第 3 条未过之前，不得声称「已定位并修复 subagent 致停根因」，只能声称「已修复一条可复现的误取消路径」。

---

## 8. 风险与未决

| # | 项 | 影响 | 应对 | 阻塞状态 |
| --- | --- | --- | --- | --- |
| U1 | 真机验收未做 | 无法确认缺陷 B 是用户实际遭遇的那条路径 | §7.1 三条 | **阻塞上线**；需重启 Cursor，会杀当前会话 |
| U2 | `cancelChat` → subagent cancelled 为静态推断 | 因果链最后一环未实测 | 并入 §7.1 第 3 条 | 阻塞「根因已修」表述 |
| U3 | Windows 侧重取消从不触发 | 场景 A 竞态在 Windows 完全无保护 | 既有缺口，非本次引入 | 待开发者决定 |
| U4 | 剪贴板回退下人工回车 >5s 会漏保护 | 场景 A 在无 CDP 环境下可能漏 | 可选：回退路径改为在回车确认后打点 | 待决 |
| U5 | 相邻缺陷未修：`cdpInject.ts` skip 分支无条件发裸 Escape（会误跳过待批准 shell 命令）、`pending_ask` 归属错误、窗口定向 | 各自独立 | 按 `long-term-minimal-fixes` 列出不静默扩大范围 | 待开发者决定 |
| U6 | v2 状态验证式取消未落地 | 当前仍需匹配提交事件才能重取消 | 若 U1 验收暴露漏取消，升级到 D1 的 v2 方案 | 触发条件：真机出现漏取消 |

---

## 9. 评审检查清单

- [x] 覆盖固定章节骨架
- [x] 含 Mac vs Windows 对照表（§2.1）
- [x] 每个关键决策写了备选方案与否决理由（§3.1 D1–D4）
- [x] 每个常量给出推导依据而非魔数（§4.2、§3.1 D4）
- [x] 路径 / 字段 / 行号可落到真实代码位置
- [x] 写了失败路径与降级策略（§5.3）
- [x] 写了非目标（§0 明确不做）与风险未决（§8）
- [x] 阶段验收标准可验证（§7），上线 gate 明确（§7.1）
- [x] 记录了被证伪的设计方向（§3.1 D1 的 gen 判据）以免重犯
- [ ] **真机验收通过** → 未完成，故本文档状态非「上线基准」
- [x] 跨仓发布顺序：仅 `armada/extension` 单点变更，无跨仓/跨服务对齐需求

---

## 10. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-08 | 首版。补记此前完全无规格的重取消机制；将判据由「同 cid + 同 prompt + 20s」改为「同 cid + 同 prompt + **由 Armada 自身注入造成**」；记录 `generation_id` 判据被证伪的过程；列出 Windows 缺口与三项相邻缺陷为未决。 |
