# Armada 架构债真机验收台账（0.4.32 / App 21）

- 日期：2026-09-20
- 状态：**台账**（不是待派发的新提示词。Windows vsix 回归已过；**0.4.32 overlay 后的打包功能验收未做。**）
- 父文档：[2026-09-19-armada-architecture-debt-design.md](./2026-09-19-armada-architecture-debt-design.md)
- 打包：中台 overlay `/Applications/Armada.app`（bun mtime **15:35**）；扩展 **0.4.32**；iOS TestFlight **21**；Android **0.1.8**
- 机器：Win Destop `m-44ff077a` / PF39WTSM；Mac Intel `m-f9b648b5`；Mac Arm New `m-a713c1d0`

禁止再把 §2 已过项写成「Windows 必须再装 vsix / 再跑 W1–W6」。助手不得为此再发安装提示词。

---

## 0. TL;DR

| 层 | 内容 | 状态 |
| --- | --- | --- |
| 扩展 0.4.32 | 三台 Install from VSIX + Reload，看板 `extension_version=0.4.32` | **过** |
| Windows / Intel / Arm **vsix 回归** B1–B3 | 未答 Ask 占位、取消先 Skip、leftover Plan 不挂 next | **过**（Arm 的 B3 首轮没出卡，Intel+Win 出到 Plan 卡） |
| cid 续聊不串台 | Windows 跨窗/跨 tab：探针进对的 cid | **过**（规格 W2 的「同页双框」是另一回事） |
| Other `freeform` | Windows 10:43 `P2A-W5-OTHER-FREEFORM-round2-indigo`；Mac §3 Other | **过** |
| 同页双 composer / 双 Plan | Cursor Agents 同窗只有 1 个输入框；New Agent 会替换 | **blocked**（产品/IDE，不是没测） |
| **0.4.32 overlay 后打包验收** | 15:35 spawn bundled bun、`REQUIRED=0.4.32`；**没有**在这套 hub 上再走占用/Ask/Plan | **未做** |

发图 / `cmd.blobPut`：另文，不进本台账。

---

## 1. 两层不要混

| 层 | 测的是什么 | 2026-09-20 事实 |
| --- | --- | --- |
| **A. 被控扩展** | `armada-agent-0.4.32.vsix` 在 win32 / darwin 上的占用、Skip、leftover Plan | Windows 15:16–15:22、Intel 15:08–15:10、Arm B1/B2 同日。当时 7380 仍是 **上一份** 包装 hub（`REQUIRED` 还是 0.4.31） |
| **B. 打包中台** | `/Applications/Armada.app` 里的 bun：`restoreOwnedHub` spawn、看板 Reload 写对号、占用契约、Ask 卡 | **安装过**：15:35 spawn、`REQUIRED_EXTENSION_VERSION=0.4.32`、三台已是 0.4.32 故 `skipped-same-version`。**功能没在这套 hub 上重跑** |

验收合同（`armada-desktop-packaged-verify`）：overlay **之后**还要在 bundled bun 上把改动走一遍。只确认 7380 是包内 bun ≠ 功能验收过。

---

## 2. 已过（不要再派 Windows 重装 / 重测）

证据在 `~/.armada/hub.db` 与当日会话 [Windows B1–B3](44aa4601-e6e0-4005-a135-e7413df43578)、[0.4.31 占用](bc15794d-118c-40b9-8c07-310e071517a5)、[W1–W6 两轮](33ed49fe-8973-4715-b24f-e45e270d8338)。

### 2.1 版本

| 何时 | 机 | 结果 |
| --- | --- | --- |
| 10:26 | Win Destop | W1 过：`0.4.31`，`needed=false` |
| 15:16 | Win Destop | A 过：`0.4.32`，本机无 7380，pending 已清 |
| 15:08 | Mac Intel | `darwin-x64` **0.4.32**，9222 仍在 |
| 15:00 左右 | Mac Arm New | 看板 **0.4.32**，CDP 就绪 |

### 2.2 占用 / leftover（0.4.32 vsix）

| 闸 | Win Destop | Mac Intel | Mac Arm New |
| --- | --- | --- | --- |
| B1 未答 Ask → decoy `queued` | **过** `r-e42c5eb9` / decoy `r-5fb5b0fe` | **过** `r-137035bf` / decoy `r-b711df1a` | **过**（`r-7bc1312b` 等） |
| B2 取消普通 Ask 先 Skip | **过** 同毫秒 `answerAsk skip` → `cancel` | **过** | **过** |
| B3 leftover Plan 不挂 next | **过** `r-47f4f33a` → next `r-55d32f6d` 无 `kind=plan` | **过** `r-9d705fc5` → next `r-cad28e8d` | 首轮 SwitchMode 被拒没出卡；不挡 Win/Intel |

11:54 还有一轮 **0.4.31 + 11:44 overlay hub** 的 R1/R2/R3（`r-8b422037` 等），占用合同当时已绿。

### 2.3 写路径里已经有结论的

| ID | 结论 | 不要再做什么 |
| --- | --- | --- |
| W2 同页双框 | **blocked**。New Agent 替换当前对话。跨窗续聊探针 `P2A-W2-MARKER` 进了对的 cid（`4f64e60e`，没进旁路） | 禁止再派「造第二个 composer」；禁止把跨窗 jsonl 写成同页双框过 |
| W3 同页双 Ask | **blocked**。连派第二条会 `User aborted` 上一条（已用占用合同修，B1 覆盖） | 禁止连派两个 Ask 当双框夹具 |
| W4 双 Plan | **blocked**。同页摆不出卡1 Building + 卡2 Build | 禁止 New Agent 硬造 |
| W5 Other | **过**（10:43 freeform；0.4.32 回归合同写明不重测） | 不要再当未测 |
| W6 掐 9222 | **不做**。9222 是该 Cursor 调试口，掐了掉窗 | 不要写进 overlay 后清单 |
| O3 409 | 已报过，可选 | 不挡 |

P2-a「给 click JS 加 `expectedCid`」：**同页双控件没摆出来，选择器不能冻。** 不是「Windows 没来测」。未点通双控件前仍不准改生产 CDP 选择器。

### 2.4 Mac 包装 hub（11:44 那次 overlay，不是 15:35）

| ID | 结果 |
| --- | --- |
| K7 blob | 过 |
| H1 overlay 时 running | 过（当时卡未变 unknown） |
| H2 unknown 带正文 | 过 `r-277352f7` |
| H3 Skip / H4 Skip 后续聊 | 过 |

H10 attach 占用 7380：**未测**（可选）。

---

## 3. 未做：0.4.32 overlay 后的打包功能验收

15:35：`ditto` 覆盖 `/Applications/Armada.app`，7380 为

`/Applications/Armada.app/Contents/Resources/bun src/index.ts --lan`

包内 `REQUIRED_EXTENSION_VERSION = "0.4.32"`。三台扩展已是 0.4.32 → Reload `skipped-same-version`。

Windows B1–B3（15:16）**早于**这次 overlay（15:35），测的是上一份包装 hub。扩展侧 leftover 仍算数；**中台占用 / Ask 卡 / Reload 写号**要在 **15:35 这份 bun** 上再走一遍才算打包验收。

### 3.1 overlay 后要做（短回归，不要重装 vsix）

三台已经是 0.4.32。不要 Install from VSIX，不要为版本 Reload，不要掐 9222，不要 New Agent。

| # | 在谁身上 | 步骤 | 过 |
| --- | --- | --- | --- |
| P1 | 中台本机 | 确认 7380 args 仍含 `Contents/Resources/bun`；看板 Reload 目标号 0.4.32 | 不是源码 hub、不是 `attach` |
| P2 | Win Destop **或** Intel（一台即可） | 未答 Ask → 立刻 decoy → decoy `queued`；中台取消 Ask（不手点 Skip）→ 审计 skip→cancel，decoy start | 与 §2.2 同形，但 **hub 必须是 15:35 这份** |
| P3 | 同上，能出 Created Plan 时 | 取消 Plan（不 Skip、不 Build）→ next 不挂 leftover `kind=plan` | 屏上 View Plan 仍在不算失败 |
| P4 | 中台 | 当时若有 running：overlay 后卡仍 running，不变 `MACHINE_OFFLINE` | H1 在这包上 |

同页双框 / 双 Plan：**不测**（§2.3 blocked）。手机 M1–M13：包已出，整表未打勾，另排，不和 Windows 提示词绑在一起。

---

## 4. 历史清单（已冻结，只作对照）

初稿把 W1–W6 写成「Windows 必须测」。实测后口径见 §2。下面留作对照，**不是待办。**

| # | 初稿要求 | 台账 |
| --- | --- | --- |
| W1 | 装 vsix 看板 0.4.31/0.4.32 | 过 |
| W2 | 同窗两个 composer 续聊 | blocked；cid 不串台已过 |
| W3 | 两个 Ask 点对 cid | blocked；占用合同已过 |
| W4 | 两张 Plan 点第二张 Build | blocked |
| W5 | Other 自由文本 | 过 |
| W6 | 掐 CDP | 明确不做 |

手机表、可选 O1–O3：仍在初稿 §5–§6 语义里；O1/O2 未测。

---

## 5. 风险

| ID | 风险 | 应对 |
| --- | --- | --- |
| 混层 | 把 vsix 回归当成 overlay 后验收 | 以 §1 为准；15:35 之后没有 P2/P3 run 就不算 B |
| 假绿选择器 | 同页双框 blocked 仍去改 `cdpInject` | 禁止 |
| 重派 | 助手忘记台账又发「先装 0.4.32」 | 先读本文 §2 |

---

## 6. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-20 | 初稿。配合扩展 0.4.29、iOS 20、Android 0.1.7。 |
| 2026-09-20 | 扩展 **0.4.30** / **0.4.31** / **0.4.32**。 |
| 2026-09-20 | 改成台账：vsix 三台 B1–B3 已过；同页双框 blocked；**15:35 overlay 后打包功能验收未做**。 |
