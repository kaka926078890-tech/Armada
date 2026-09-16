# Armada App：任务隐藏（对齐中台）

- 日期：2026-09-16
- 状态：**设计草案**（方案 A 已拍板；待规格确认后写实施计划）
- 父文档：
  - [2026-09-12-armada-relay-mobile-design.md](./2026-09-12-armada-relay-mobile-design.md)（下称《远程》：§4.5 列表「最近 50，非 archive」；**无** archive 写路径）
  - [armada-hub-app-parity](../../../.cursor/rules/armada-hub-app-parity.mdc)（操作员能力 App 同一轮要能看见、做完；权威在 `runToSnap`）
- 修订范围：`RunSnap.archived`；中转列表过滤 + archive/unarchive 路由；iOS 隐藏 / 查看已隐藏 / 取消隐藏。不改 hub 状态机、不删 run、不碰 Cursor 会话、不改 stop / `generation_id`。
- 触发：中台看板能把终态卡「隐藏」，App 既不能藏、也看不到中台已经藏掉的结果。

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | 中台 `POST /api/runs/:id/archive` 只把卡从默认看板拿掉（`archived_at`，数据保留）。`runToSnap` 无该字段，中转 `GET /mobile/runs` 不过滤，App 无按钮。中台藏了，手机列表还在。 |
| 核心方案 | **方案 A：全闭环对等。** `RunSnap.archived`；`snap.run` 在 `run.archived` 时也推；中转默认列表排除已隐藏；`POST /mobile/runs/:id/archive\|unarchive` 转发 hub；App 详情与仓页对齐中台「隐藏 / 查看已隐藏 / 取消隐藏」。 |
| 关键约束 | ① 权威在 hub `archived_at`。② occupying（`queued`/`dispatched`/`binding`/`running`）不可藏 → `409 INVALID_STATE`。③ 产品文案是 **隐藏**，不是归档/删除。④ 详情 `GET by id` 仍返回已隐藏 run。⑤ 打包 hub 的 `relayAttach` 轮询必须能看见隐藏边沿。 |
| 明确不做 | 物理删除；App 本地私藏（UserDefaults）；改标题；改 occupying 集合；SSE 到手机；blobs；Android。 |

**可行性：** 本功能是操作员列表语义，不是 IDE/CDP 写路径。hub 隐藏 API 已有单测（`hub/test/archive-rename.test.ts`）。本规格不触发 `armada-feasibility-before-solution`。Mac / Windows 被控机无差异（不碰扩展）。

| OS | 是否阻塞 |
| --- | --- |
| 中台 / 中转 / iOS | 本规格范围 |
| 被控 macOS / Windows | 无关；禁止为此改 hook / CDP / `decideStop` |

---

## 1. 背景与需求

| # | 原始诉求 | 设计映射 |
| --- | --- | --- |
| R1 | Armada App 不支持任务不可见 / 归档 | App 增加与中台同语义的 **隐藏**（`archived_at`），不是新状态 |
| R2 | 中台应该已有类似能力 | 复用 `hub/src/runs.ts` `archive` / `unarchive`；不新造状态机 |
| R3 | 远程操作员能做完 | 同一轮：snap 字段 → 中转路由 → iOS 按钮与列表；缺字段 = 远程没有这个功能 |
| R4 | 中台藏了 App 也要看不见 | 默认 `GET /mobile/runs` 排除 `archived=true`；中台隐藏必须 `pushRun` |
| R5 | 藏错了能找回 | `?archived=1` + App「查看已隐藏」+ `unarchive` |

对照《远程》§4.5：

| 旧条款 | 新语义 |
| --- | --- |
| 列表「最近 50，非 archive」 | **落实**：中转按 `archived_at` 过滤；以前只是愿望（snap 无字段，SQL 不过滤） |
| v1 不做的中转路由含 ui-prefs / events | **本规格新增** archive / unarchive；其余仍不做 |
| `RunSnap` 无 archived | 增加 `archived: boolean` |

**备选（不选）：**

| 方案 | 为什么不选 |
| --- | --- |
| B. 只同步中台隐藏，App 无按钮 | 操作员在手机做不完；违反 hub-app-parity |
| C. App UserDefaults 本地藏 id | 两边列表分裂；中台藏了手机仍在；权威不在 hub |
| 物理删除 / 新 status=`archived` | 中台已明确「隐藏不删数据、不碰 Cursor 会话」 |
| 只在 App 用 `isLive` 关入口 | 终态必须能藏；`isLive` 误伤完成卡 |

---

## 2. 现状盘点

### 2.1 可复用

| 能力 | 代码位置 | 本规格怎么用 |
| --- | --- | --- |
| 隐藏语义 | `hub/src/runs.ts` `archive` / `unarchive`；`archived_at INTEGER` | 唯一写路径；中转只转发 |
| 占用闸 | `hub/src/concurrency.ts` `OCCUPYING_STATUSES` | archive 已用此闸；App/中转透传 `INVALID_STATE` |
| 中台 UI | `hub/web/src/App.tsx` `showArchived`；`Board.tsx` 隐藏/取消隐藏；`RunDetail.tsx` 按钮 | App 文案与入口对齐 |
| 按钮规则 | `hub/web/src/boardState.ts` `canArchiveRun` = 非 `LIVE` | App 同规则（见 §4.3 与 API 闸的差） |
| cmd 模板 | `cmd.retry`：`relay/src/server.ts` → `relayClient.ts` / `relayAttach.ts` → hub HTTP | archive / unarchive 抄此形 |
| 快照回写 | `relay/src/server.ts` `applyRunSnap` / `runToJson` | 加列 `archived_at`；JSON 出 `archived` |
| iOS 动作 | `RelayAPI.retry` + `RunDetailView`「重试」 | 同文件加 archive / unarchive |

### 2.2 需新建

| 能力 | 落点 |
| --- | --- |
| snap 字段 | `hub/src/relayClient.ts` `RunSnap.archived` |
| 隐藏边沿推送 | `relayClient` `onEvent` 增加 `run.archived`；`relayAttach` 检测从默认列表消失 |
| 中转列 / 过滤 | `relay/src/db.ts` `ensureColumn(..., archived_at)`；`GET /mobile/runs` |
| 中转写路由 | `POST /mobile/runs/:id/archive`、`/unarchive`；`cmd.archive` / `cmd.unarchive` |
| iOS | `RunDTO.archived`；详情按钮；仓页「查看已隐藏」；未读不计已隐藏 |

### 2.3 今天的缺口（证据）

| 层 | 今天 | 目标 |
| --- | --- | --- |
| `runToSnap` | 无 `archived` | `archived: Number(run.archived_at) > 0` |
| `sse.onEvent` | 只推 `run.status` / `run.ask` / `run.outbound` | 加上 `run.archived` |
| `relayAttach.pollHub` | 只 `GET /api/runs`（默认非 archive）；`fpOf` 不含 `archived_at` | 默认列表消失的已知 id 必须 `pushRun`（GET by id 仍有行） |
| `GET /mobile/runs` | `SELECT * ... LIMIT 50` 不过滤 | 默认 `archived_at IS NULL`；`?archived=1` 相反 |
| iOS | 无字段、无 API、无按钮 | 与中台同一闭环 |

---

## 3. 设计原则

| # | 原则 | 可执行含义 |
| --- | --- | --- |
| P1 | 权威在 hub | 中转不自己把 run 标隐藏；只存 snap 并转发 cmd |
| P2 | 隐藏 ≠ 删除 | 禁止 `DELETE FROM runs`；详情与 `GET /api/runs/:id` 仍 200 |
| P3 | 占用中不可藏 | 与 `runs.archive` 同一闸；运行中入口关掉，不是藏入口再 409 才发现（按钮仍以 LIVE 为准） |
| P4 | 缺字段 = 没有功能 | App 不得在本地猜；列表过滤以 snap `archived` 为准 |
| P5 | 文案对齐中台 | 按钮「隐藏」「取消隐藏」「查看已隐藏」；错误「运行中不能隐藏」 |
| P6 | 最小边界 | 只扩 snap + mobile 写路径 + App 入口；不改 ingest / stop / 并行 |

---

## 4. 数据模型 / 接口契约

### 4.1 Hub（已存在，本规格不改语义）

| 项 | 值 |
| --- | --- |
| 列 | `hub/src/db.ts` `runs.archived_at INTEGER`；`NULL` = 可见 |
| 默认列表 | `GET /api/runs` → `archived_at IS NULL`（`hub/src/runs.ts` `list`） |
| 已隐藏 | `GET /api/runs?archived=1` |
| 全部 | `GET /api/runs?archived=all`（attach 可用，App 不用） |
| 隐藏 | `POST /api/runs/:id/archive` → `{ run }`；幂等（已隐藏再藏仍 200） |
| 取消 | `POST /api/runs/:id/unarchive` → `{ run }` |
| occupying | `409 { error: "INVALID_STATE" }`（`queued`/`dispatched`/`binding`/`running`） |
| 缺失 | `404 { error: "NOT_FOUND" }` |
| SSE | `{ type: "run.archived", runId, archived: boolean }` |

`created`：**API 允许**隐藏（不在 occupying）。中台看板 `canArchiveRun` 与详情按钮把 `created` 当成 LIVE，**不给按钮**。本规格 **不改** hub API 闸（避免中台行为变化）。App 按钮跟 UI，不跟「API  theoretically 允许」。

**备选不选：** 把 `created` 加进 occupying。会改变中台 API；无产品需求。

### 4.2 `RunSnap`（权威出站）

`hub/src/relayClient.ts` 与 `relay/src/server.ts` 的 `RunSnap` 增加：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `archived` | `boolean` | `Number(run.archived_at) > 0`；缺省按 `false`（旧中转行） |

不导出 `archivedAt`（中台 UI 不用时间戳；YAGNI）。

`canRetry` 仍按 status 派生，与是否隐藏无关。已隐藏的失败卡在「查看已隐藏」里仍可重试（中台看板已隐藏视图同样露出卡片）。

### 4.3 中转 HTTP

鉴权仍是 `Authorization: Bearer {operatorToken}`。成功码与现有 mobile 写路径一致：**200** + `{ run }`（对齐 hub archive 的 200，不是 retry 之外另造 201）。

| 动作 | 方法 | 成功 | 错误 |
| --- | --- | --- | --- |
| 默认列表 | `GET /mobile/runs?limit=50` | `{ runs }` 仅 `archived=false`；最多 50 | 401 |
| 已隐藏 | `GET /mobile/runs?archived=1` | `{ runs }` 仅 `archived=true`；最多 50 | 401 |
| 详情 | `GET /mobile/runs/:id` | 含 `archived`；已隐藏也 200 | 404 |
| 隐藏 | `POST /mobile/runs/:id/archive` | `200 { run }` 且 `run.archived===true` | `404 NOT_FOUND`；`409 INVALID_STATE`；`503 HUB_OFFLINE` |
| 取消隐藏 | `POST /mobile/runs/:id/unarchive` | `200 { run }` 且 `run.archived===false` | `404`；`503 HUB_OFFLINE` |

`hubCmdStatus` 已把 `INVALID_STATE` 映射 409，无需新码。

限流：archive / unarchive **不计入** 派发 20/5min（不是 dispatch）。失败不改中转行。

中转表：`ensureColumn(db, "runs", "archived_at", "archived_at INTEGER")`。`applyRunSnap`：`archived === true` 写 `Date.now()`（若已有非空则保留原值）；`false`/`缺省` 写 `NULL`。不要求与 hub 时间戳逐毫秒相等；列表过滤只认是否非空。

**备选不选：** 中转收到 `archived:true` 就 `DELETE` 行。详情打不开，违反 P2。

### 4.4 WSS cmd

| 中转 → hub | hub 落地 |
| --- | --- |
| `{ type: "cmd.archive", requestId, runId }` | `POST /api/runs/:id/archive` |
| `{ type: "cmd.unarchive", requestId, runId }` | `POST /api/runs/:id/unarchive` |

成功：`cmd.result` + `snap.run`（含 `archived`）。`relayClient.ts` 与 `relayAttach.ts` **两边都要接**，与 retry 相同。

### 4.5 iOS DTO / 文案

`mobile/ios/ArmadaRemote/RelayAPI.swift`：

```text
RunDTO.archived: Bool?          // 缺省 false
showsArchive: Bool             // !isLive && archived != true
```

`isLive` 已含 `created`/`queued`/`dispatched`/`binding`/`running`，与 `LIVE` / `canArchiveRun` 一致。

| 码 | App 文案 |
| --- | --- |
| `INVALID_STATE` | 运行中不能隐藏 |
| `NOT_FOUND` | 任务不存在 |
| `HUB_OFFLINE` | 中台离线（已有） |

---

## 5. 运行时链路

### 5.1 App 隐藏

```text
App POST /mobile/runs/:id/archive
  → relay 校验 fleet 有该 id，否则 404
  → sendHub cmd.archive
  → hub archive()
      occupying → fail INVALID_STATE
      else SET archived_at=now；SSE run.archived archived:true
  → cmd.result { run: runToSnap(...) }
  → applyRunSnap（archived_at 非空）
  → App 200；默认列表刷新后消失；若在详情则 pop 回仓页（对齐中台详情隐藏后 onClose）
```

取消隐藏：详情留在当前页（对齐中台详情「取消隐藏」）。

### 5.2 中台隐藏 → App

**在线 hub（`relayClient`）：** `sse.onEvent` 见 `run.archived` → `pushRun`。App 10s 轮询默认列表即消失。p95：下一轮轮询（≤10s），不是即时 SSE 到手机。

**打包/旧 hub（`relayAttach`）：** 不订阅 SSE。必须：

1. `fpOf` 追加 `archived_at`
2. 轮询 `GET /api/runs` 后，对 `lastRunFp` 里 **本轮默认列表没有的 id** 调用 `pushRun(id)`（`GET /api/runs/:id` 仍返回该行，`runToSnap.archived===true`）

不把「只扩到 `?archived=all` 再 slice(0,30)」当唯一手段：刚隐藏的旧卡可能掉出 30 条窗口，手机列表会残留。

**缓存：** 无额外 TTL。失效 = 下一次 `snap.run` 或 App `refresh`。  
**降级：** hub 离线 → 503，中转行保持上一快照；App 提示「中台离线」，不在本地改 `archived`。

### 5.3 列表与未读

`Session.refresh`：**始终**并行拉默认列表与 `?archived=1`（对齐中台 `api.runs()` + `api.runs({ archived: true })`），客户端按仓页开关选用。未读红点 **只计默认列表**（已隐藏不贡献 workspace 红点）。

### 5.4 失败路径

| 场景 | 行为 |
| --- | --- |
| 运行中点隐藏 | App 不画按钮；若直打 API → 409，文案见 §4.5 |
| 中转无此 id | 404，不发 cmd |
| hub 超时 | 现有 `HUB_TIMEOUT` → 502；不改 snap |
| 仅中台隐藏、attach 未 push | 视为回归；测试必须覆盖「默认列表消失 → 中转默认列表不含该 id」 |

回滚：停发 App；旧 App 忽略未知字段 `archived`；新中转默认过滤后，旧 App 会看到「任务变少」——这是期望。旧中转无列时 `ensureColumn` 后旧行 `archived_at NULL`，行为与今天相同。

---

## 6. 安全与威胁模型

| 威胁 | 缓解 | 指标 / 约束 |
| --- | --- | --- |
| 用 operator token 藏别人的 run | 中转 `id + fleet_id` 命中才转发；hub token 仍是局域网 loopback | 跨 fleet 404 |
| 把隐藏当删除毁灭审计 | 不删行；hub `audit` 已有 `run.archive` / `run.unarchive`；中转 `audit` 同样记 | 审计可还原 |
| 隐藏绕过占用去拆会话 | occupying 409；不发取消、不改 cid | 与中台同闸 |
| 列表泄漏已隐藏 prompt | 默认列表不返回；详情仍需知道 `runId`（操作员本就能 GET） | 不把 hidden 当 ACL |
| 枚举 id 取消隐藏 | 有 op token 即可操作本 fleet 的 id；与 followup 同模型 | 不新造 ACL |

边界外：丢失 op 邀请 = 操作员能力全丢（含隐藏）。本规格不改邀请模型。

---

## 7. 实施路线图

发布顺序（**同一 commit 可含三层**；若拆发：中转/hub 先于 App，旧 App 只是少看到已隐藏卡）：

| 阶段 | 内容 | 验收 | 上线 gate |
| --- | --- | --- | --- |
| v1 | 本规格全闭环 | 单测见下；Simulator 能藏/找回 | `bun test hub/test/relayClient.test.ts hub/test/relayAttach.test.ts relay/test`；iOS 编译 |
| v1.5 | 无 | — | 不预留第二套隐藏模型 |
| v2 | 无 | — | 列表滑动隐藏若 v1 已做则关闭此项 |

v1 任务切分（实施计划展开）：

1. `runToSnap.archived` + `run.archived` 推送（先红测）
2. 中转列、列表过滤、cmd 路由
3. `relayAttach` 消失检测
4. iOS DTO / API / 详情 + 仓页开关
5. README 中转表补两行

每阶段验收（可测）：

- [ ] `runToSnap({ archived_at: 9 }).archived === true`；`null` → `false`
- [ ] 终态 archive 后 `GET /mobile/runs` 不含该 id；`?archived=1` 含；`GET /:id` 200 且 `archived: true`
- [ ] 运行中 archive → 409 `INVALID_STATE`
- [ ] unarchive 后默认列表含该 id
- [ ] 中台 archive 后（relayClient **或** attach）中转默认列表不含该 id
- [ ] App：终态详情有「隐藏」；隐藏后默认列消失；「查看已隐藏」能「取消隐藏」；运行中无隐藏按钮

---

## 8. 风险与未决

| 风险 | 影响 | 应对 | 状态 |
| --- | --- | --- | --- |
| attach 只轮询可见列表 | 中台隐藏后 App 残留 | §5.2 消失检测；单测 | 规格已写，实施必测 |
| 旧 App 忽略 `archived` | 若中转已过滤，旧 App 只是少卡 | 可接受 | 关闭 |
| 已隐藏卡仍占 `GET /mobile/runs` 的 50 限额 | 默认列表已被排除，不占限额 | 已隐藏走 `?archived=1` 自己的 50 | 关闭 |
| `created` API 可藏、UI 不给按钮 | 直打 API 的脚本能藏 created | 不改 hub；记入差异 | 不修 |
| 隐藏后 APNs 仍按旧 snap 弹 | 若 push 规格按 status 边沿 | 隐藏不是完成边沿；不新发 APNs | 本规格不改 push |

**阻塞项：** 无。不依赖 APNs、不依赖被控机 OS。

**发现但本轮不修：**

- 中台 `created` 的 API vs UI 闸不一致
- 已隐藏 run 的重试 / 续聊是否要在 App 已隐藏视图露出（v1 **露出**，与中台已隐藏看板一致；若产品只要「藏了就不能动」需另说）
- `relayAttach` 30 条窗口对其它字段的陈旧 snap（既有问题，本规格只修隐藏边沿）

---

## 9. 评审检查清单

- [x] 固定章节：TL;DR / 背景 / 现状 / 原则 / 契约 / 链路 / 安全 / 路线 / 风险 / 修订
- [x] MVP/v1 切分：v1 全闭环；无 v1.5 第二模型
- [x] 非目标、风险、阻塞、验收
- [x] 跨层发布：hub snap → 中转 → App；旧 App 兼容策略
- [x] 路径可落到 `relayClient.ts` / `relayAttach.ts` / `relay/src/server.ts` / `RelayAPI.swift` / `Screens.swift`
- [x] 每个必须做有验收；性能承诺 = App 轮询 ≤10s，无新 SLA
- [ ] 用户确认本文后 → 写 `docs/superpowers/plans/2026-09-16-armada-app-run-hide.md`

---

## 10. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-16 | 初稿。方案 A（全闭环对等）已在对话拍板。 |
