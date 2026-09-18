# Armada 远程：Android App（对齐现网 iOS）

- 日期：2026-09-17（修订：完整态一次落地；技术栈不锁）
- 状态：**实施基准（功能对等已拍板；技术架构落地自选）**
- 父文档：
  - [2026-09-12-armada-relay-mobile-design.md](./2026-09-12-armada-relay-mobile-design.md)（下称《远程》：中转 + `/mobile/*` + 邀请 URI）
  - [2026-09-16-armada-app-push-design.md](./2026-09-16-armada-app-push-design.md)（下称《推送》：可见 APNs；Android 锁屏走本文件的 FCM）
  - [2026-09-16-armada-app-run-hide-design.md](./2026-09-16-armada-app-run-hide-design.md)（隐藏闭环）
  - [armada-hub-app-parity](../../../.cursor/rules/armada-hub-app-parity.mdc)（操作员能力 App 同一轮要能看见、做完）
- 修订范围：同仓新增 `mobile/android/`；中转推送表与登记 API **向后兼容**扩 `platform=fcm`。不改 hub 状态机、不改 `runToSnap`、不改受控扩展、不把 `7380` 公网化、不重写 iOS。
- 触发：iOS 遥控器已能绑 op、看板、派发/续聊、Ask/Build、隐藏、前台 SSE、锁屏 APNs；Android 操作员没有对等入口。

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | 现网遥控器只在 `mobile/ios/`。Android 操作员无法绑中转、选仓、做完 Ask/隐藏/锁屏通知。 |
| 核心方案 | **功能对齐现网 iOS 完整态，一次落地到可验收。** 客户端只打 `/mobile/*`；锁屏用同一套 `notifyEdge` 代发可见 FCM。技术栈（Compose / Flutter / 其它）**不作为规格约束**。 |
| 关键约束 | ① 权威在 hub；Android 只打中转。② iOS `RelayAPI` + `Screens` + `Session` 能做的事，Android 都能看见、做完。③ 列表走 `?view=hidden`，禁止 `archived=1`。④ 详情每次打开强制 GET。⑤ 推送永不带 `finalText`。⑥ 无 GMS / 无服务账号 = 不推，前台 SSE 仍必须可用（与 iOS 无 `.p8` 时相同）。 |
| 明确不做 | 公网 7380；blobs / 工作区附件（iOS 也没有）；Android 专用 `/mobile/android/*` 字段；静默推送当主通道；把服务账号打进安装包；重写已发布 iOS；Play 上架；国内厂商推送（iOS 没有对等物）。 |

落地闸 = §1.1 清单全绿，**不是**「先交一个没推送的 APK 再另开一轮」。实施顺序可以先画面后接线，但不得把缺推送、缺隐藏、缺 SSE 标成已完成。

---

## 1. 背景与需求

| # | 原始诉求 | 设计映射 |
| --- | --- | --- |
| R1 | 参照 iOS 做 Android | 现网 iOS 行为是产品源。对照 `mobile/ios/ArmadaRemote/{RelayAPI,Screens,ArmadaRemoteApp,Invite}.swift` |
| R2 | 技术架构没要求 | 规格不锁语言 / UI 框架 / 网络库。只锁协议、文案、状态机、验收 |
| R3 | 落地一直跑到完整态 | 一次交付含锁屏可见推送；内部可分步，对外只有「对齐 iOS」一个完成态 |
| R4 | 功能对齐 iOS | §1.1 逐条；缺一条 = 未完成 |
| R5 | 不在局域网也能控中台 | 只连 `https` 中转；邀请仍是 `armada-relay://op?…` |
| R6 | 开源自建 | 工程在本仓 `mobile/android/`；FCM 密钥只在中转机 |

**诉求外、本规格不发明：** 远程开窗、附件 blobs、多中转集群、把 Android 做成第二份 hub、iOS 没有的厂商通道。

### 1.1 iOS 功能对等清单（完成态 = 全绿）

对照日：2026-09-17 现网 iOS。Android **必须**同等行为，不要求像素级 UI。

| ID | iOS 源 | 行为 | Android 验收 |
| --- | --- | --- | --- |
| P1 | `Invite.swift` | 解析 `armada-relay://op`；拒 pair；公网必须 https；loopback 才允许 http | 同文案 |
| P2 | `BindView` | 粘贴绑定；失败红字 | 同 |
| P3 | `onOpenURL` | scheme `armada-relay` 热启动 / 冷启动都进 `bind` | 同 |
| P4 | `OperatorKeychain` | operator token 不明文持久化；解绑删除 | 同语义，存储实现自选 |
| P5 | `WorkspaceListView` | 按机器分组；在线绿点；仓 label + 路径；live 转圈；未读胶囊；解绑；下拉刷新 | 同信息与入口 |
| P6 | `hubOffline` | 空态「中台离线或没有打开的仓」 | 同句 |
| P7 | `BoardColumn` | 五列：待回车 / 运行中 / 已完成 / 已取消 / 异常 | 同列、同 status 映射 |
| P8 | `WorkspaceHome` | 列计数；列上红点（Ask / 未读失败）；派发；查看已隐藏 N；滑动隐藏 / 取消隐藏 | 同 |
| P9 | `DispatchSheet` | 无字数 cap；字数脚注；派发与续聊共用；键盘挡导航栏时仍能点发送 | 同能力 |
| P10 | `RelayAPI.dispatch` | POST `/mobile/runs` 只认 **201** | 同 |
| P11 | `followup` | POST 认 **200 或 201**；`canFollowup = pendingAsk == nil`；运行中可续聊 | 同 |
| P12 | `RunDetailView` | 打开强制 GET；Markdown 提示词 / 正文；复制正文；队列托盘 | 同 |
| P13 | `AskView` | 普通 Ask：选项 + 跳过 + 继续；未选不能继续 | 同文案与禁用 |
| P14 | `AskView.isPlan` | 唯一选项 `id==build` → 黄底 Build，不走普通选项 UI | 同判断，不另解析 `kind` |
| P15 | 取消 / 重试 | live → 取消；`showsRetry` → 重试 | 同 |
| P16 | 隐藏 | 非 live 可藏；occupying →「运行中不能隐藏」且乐观更新回滚 | 同 |
| P17 | `runs(archived:)` | 查询 `view=hidden`；**禁止** `archived=1`；失败不打红整页 | 同 |
| P18 | `keepListBodies` | 列表无 `finalText` 时保留本地已有正文 | 同 |
| P19 | `applyLocalArchive` | 先本地再 POST；SSE 忽略 pending 反向 snap | 同 |
| P20 | `Session.runLive` | 前台 SSE；失败 2s→60s 轮询；进后台停 | 同 |
| P21 | `streamEvents` | `Accept: text/event-stream`；忽略 `: ping`；只解析 `data:` | 同 |
| P22 | 详情轮询 | SSE 健康则 1s 只跟 stream；不健康且 live/Ask 则 3s GET | 同 |
| P23 | `RelayAPIError` | §4.6 文案逐句相同；403+HTML → `NET_INTERCEPT` | 同句 |
| P24 | 未读 / 角标 | `isUnread` + 打开 `markOpened`；已读可标回未读（删 `readAt`；详情 `unreadHold`）；角标=未读和（系统不显示则忽略） | 同规则 |
| P25 | 推送登记 | 绑定后登记；解绑 DELETE；token 刷新再 POST | Android：`platform=fcm` |
| P26 | 锁屏可见通知 | Ask + `completed/error/unknown/aborted`；`cancelled` 不推；载荷无 `finalText` | 同边沿（`notifyEdge`） |
| P27 | 点通知 | `runId` → 清空栈进详情 → 强制 GET | 同 |
| P28 | 前台去重 | `watchingId == runId` 不弹横幅；列表页仍弹 | 同 |
| P29 | `completed` 正文 | 与中台「复制正文」逐字节相同 | 同 |
| P30 | 超长 prompt | < 20 MiB 不截断；无 UI cap | 同 |

iOS 没有的能力（附件 blobs、远程开窗、厂商推送、Play 商店）**不进本清单**。

---

## 2. 现状盘点

### 2.1 可复用

| 能力 | 代码位置 | Android 怎么用 |
| --- | --- | --- |
| 邀请 URI | `relay/src/uri.ts`；iOS `Invite.swift` | 同解析规则；客户端单测对齐 `relay/test/uri.test.ts` |
| 列仓 / 派发 / 详情 | `relay/src/server.ts` `/mobile/*` | 路径、HTTP 码、JSON 字段与 iOS `RelayAPI` 逐接口对齐 |
| 隐藏 | `GET ?view=hidden`；`POST archive\|unarchive` | 同 iOS |
| 续聊 | `POST /mobile/runs/:id/followup` → 201/200 | 同 |
| Ask / Build | `POST .../answer`；UI 闸 = `AskView.isPlan` | 同 |
| 前台 SSE | `GET /mobile/stream` | 同头、同行协议 |
| 错误码文案 | iOS `RelayAPIError.operatorMessage` | 拷 §4.6 |
| 通知边沿 | `relay/src/notifyEdge.ts` | **不改函数**；发送端加 FCM |
| 完成门禁 | `finalText` = `assistantBodyText` | 详情 GET |
| Markdown 子集 | iOS `MarkdownView.swift` | **同一套规则**生成 HTML（语言自选）；禁止换语法导致版式漂 |

### 2.2 需新建

| 能力 | 落点 |
| --- | --- |
| Android 客户端 | `mobile/android/`（框架自选） |
| 会话 / 导航 / 看板 | 行为对齐 iOS 文件，文件切分不锁 |
| token 存储 | 不明文；解绑可删 |
| FCM 登记与点击 | 客户端 + 中转 `platform=fcm` |
| 中转 FCM 发送 | `relay/src/fcm.ts`；`applyRunSnap` 后按 platform 分发 |
| 明文 HTTP | 仅 loopback / 模拟器 host；生产只 https |

### 2.3 不复用 / 有害

- 把 `hub/web` 当操作面：吃局域网 token，不是 op Bearer。
- 用 `POST /mobile/push-token` 的 **64 hex** 校验登记 FCM：FCM token 不是 64 hex。
- 后台常驻连接当锁屏通道：iOS 也否定；Android 不得用常驻通知 Service 冒充 P26。
- 再打 `?archived=1`：公网网关会掐流。
- 为 Android 改 iOS / 抽 KMP 重写 TestFlight 包：本轮只补客户端，禁止顺手动 iOS。

---

## 3. 设计原则

1. **功能对等优先。** 完成态只看 §1.1，不看用了什么 UI 框架。
2. **一份契约，两份客户端。** `/mobile/*` 与 `RunSnap` 是唯一远程协议；不得要「安卓专用 run 字段」。
3. **iOS 现网是产品源。** 文案、五列、Ask/Build、隐藏乐观更新、SSE、推送边沿，以 Swift 为准。
4. **一次完整态。** 实施可分步提交，验收不得拆成「无推送版已上线」。
5. **推送是叫醒。** 可见通知 + `runId` + `kind`；正文只 GET。
6. **失败可降级。** 无 FCM 配置 / 无 GMS / 用户关通知 → 前台 P20 仍可用（对齐 iOS 无 `.p8`）。
7. **最小中转切口。** 只为 FCM 扩 token 表与登记体；`notifyEdge` 与 APNs 文案不变。

### 3.1 已否决（产品 / 协议，不是技术栈）

| 方案 | 为什么不选 |
| --- | --- |
| 只做画面、推送永远不做 / 另开产品轮 | 违反对齐 iOS 完整态（P25–P28） |
| 中台网页 WebView | 不是 op 遥控器 |
| 极光 / 个推当主通道 | 闭源 + 中转持有第三方 master secret |
| 静默 data-only FCM 当 Ask 通道 | 不保证到达；iOS 用的是可见通知 |
| `archived=1` 拉隐藏列表 | 公网掐流 |
| Android 专用 REST | 与 iOS 漂移，违反 hub-app-parity |
| 公网映射 7380 | 《远程》已否决 |

**不否决：** Compose、Flutter、View 系统、KMP **只写 Android 侧**。落地自选；规格不评审技术栈。

### 3.2 范围

| 阶段 | 做 | 不做 | 触发 |
| --- | --- | --- | --- |
| **完整态（本规格唯一交付）** | §1.1 P1–P30；中转 `platform=fcm`；旁加载 APK | Play 上架；HMS/小米/OPPO；blobs；改 iOS | 本 spec |
| **以后** | Play Internal；无 GMS 机的厂商通道 | 把 7380 公网化 | 商店分发，或无 GMS 成为真实阻塞 |

Hub / 受控扩展：**零改。** 中转只加 FCM 发送与登记兼容。

实施时内部顺序建议（**不是**可单独上线的里程碑）：绑定/看板 → 派发详情 Ask 隐藏 → SSE → FCM。每步可提交，完整态才算对齐 iOS。

---

## 4. 数据模型 / 接口契约

### 4.1 绑定与存储

邀请与《远程》§4.1 完全相同：

```
armada-relay://op?relay=https%3A%2F%2F…&fleet={fleetId}&token={64hex}
```

| 规则 | 验收 |
| --- | --- |
| scheme `armada-relay`，host/path 为 `op` | 其它 → 「邀请格式无效」 |
| `relay` 必须 `https://` origin；仅 loopback 允许 `http://127.0.0.1` 或模拟器 `http://10.0.2.2` | 公网 http → 「中转必须是 https…」 |
| `fleet` `[a-z0-9-]{8,64}`；token 64 hex | 否则 incomplete |
| 贴 `pair` URI | 不写存储；文案「这是中台链接，请粘贴 App 邀请（armada-relay://op）」 |

落盘语义（实现自选）：

| 数据 | 约束 |
| --- | --- |
| `relay` / `fleet` | 可普通持久化 |
| operator token | **禁止明文**；解绑必须删掉 |
| `readAt` | 持久化；规则同 iOS `armada.readAt` |
| FCM token | 可存当前串；解绑 DELETE 中转后再清 |

解绑：清本地 + DELETE 推送 token（能调则调）+ 停 SSE。

Deep link：自定义 scheme `armada-relay`；冷/热启动同一 `bind(uri)`。

**备选不选只填 https URL：** 无身份。  
**备选不选 Android App Links：** 自建中转域名不固定。

### 4.2 App ↔ 中转 HTTPS

鉴权：`Authorization: Bearer {operatorToken}`。禁止 `?token=`。

与 iOS `RelayAPI.swift` 逐条对齐：

| 动作 | 方法 | 成功码 | 客户端要点 |
| --- | --- | --- | --- |
| 列仓 | `GET /mobile/workspaces` | 200 | `hubOffline` |
| 派发 | `POST /mobile/runs` `{workspaceId,prompt}` | **201** | 只认 201 |
| 列表 | `GET /mobile/runs?limit=50` | 200 | 再过滤未隐藏 |
| 已隐藏 | `GET /mobile/runs?limit=50&view=hidden` | 200 | **禁止** `archived=1`；失败不打红整页 |
| 详情 | `GET /mobile/runs/:id` | 200 | 含 `finalText`；已隐藏也 200 |
| 续聊 | `POST /mobile/runs/:id/followup` `{prompt}` | **200 或 201** | |
| 重试 | `POST /mobile/runs/:id/retry` | 200 | |
| 隐藏 / 取消 | `POST .../archive\|unarchive` | 200 | occupying → 409 `INVALID_STATE` |
| 回答 | `POST .../answer` | 202 或 200 | 允许空 body |
| 取消 | `POST .../cancel` | 200 | 允许空 body |
| SSE | `GET /mobile/stream` | 200 | 忽略 `: ping` |
| 登记推送 | `POST /mobile/push-token` | 204 | body 含 `platform=fcm` |
| 删除推送 | `DELETE /mobile/push-token` | 204 | |

超时：REST 30s；SSE 读超时 ≥ 90s。请求体上限中转 20 MiB；客户端无字数 cap。

**不做的路由：** blobs、ui-prefs、events 全文、`/mobile/android/*`。

### 4.3 前台通道（对齐 iOS 现网 Session）

```text
前台：SSE
SSE 失败 / 进后台：停连接；失败则 2s→60s 退避后 GET 三件套（仓 + 列表 + 隐藏）
详情：打开强制 GET；SSE 健康时 1s 只跟 stream；不健康且 live/Ask 时 3s 再 GET
```

生命周期语义：进程到前台 `startLive()`，到后台 `stopLive()`。具体 API 自选。

验收：hub 出 `snap.run` 后前台列表 **p95 < 1s**（同区域）；拔 SSE 后仍能派发，15s 内轮询看到非 queued。

### 4.4 信息架构与状态机

导航：`舰队 → 仓看板 → 详情`；派发 / 续聊为模态。通知 / 冷启动：清空栈后直达详情。

看板列：

| status | 列 |
| --- | --- |
| `created` `queued` `dispatched` `binding` | 待回车 |
| `running` | 运行中 |
| `completed` | 已完成 |
| `cancelled` `aborted` | 已取消 |
| 其它 | 异常 |

未读：有 `pendingAsk`，或终态 ∈ {completed, error, unknown, aborted}，且未见过或 `updatedAt > readAt`。打开详情即已读。

Ask：普通选项 +「跳过」+「继续」。Plan：`questions[0].options` 恰好 1 条且 `id=="build"` → Build。

`canFollowup` = `pendingAsk == nil`。  
`showsRetry` = `canRetry` 或 status ∈ {error, unknown, aborted}。  
`showsArchive` = 非 live 且未隐藏。

Markdown：与 iOS `MarkdownHTML` 同一输入同一 HTML 结构（夹具可共享字符串）；渲染控件自选。

### 4.5 FCM（完整态内，不是下一轮产品）

#### 4.5.1 表

```sql
-- ensureColumn，默认 apns，旧 iOS 行不用改 token
platform TEXT NOT NULL DEFAULT 'apns' CHECK (platform IN ('apns','fcm'))
```

发送：`SELECT token, platform`。同 fleet 最多 **20** 行（iOS+Android 合计）；超出按 `updated_at ASC` 删。audit 只留后 8 位。

#### 4.5.2 登记 API（向后兼容）

```
POST /mobile/push-token
{ "token": "…", "environment": "production", "platform": "apns" | "fcm" }
→ 204
```

| 条件 | 行为 |
| --- | --- |
| 无 `platform` | **视为 `apns`**（现网 iOS 不改包） |
| `platform=apns` | token 64 hex，否则 400 `INVALID` |
| `platform=fcm` | 长度 32–4096，字符集 `[A-Za-z0-9_:\-.]`，否则 400 |
| `environment` ≠ `production` | 400 `INVALID` |
| pair secret | 403 `OPERATOR_REQUIRED` |
| 无 Bearer | 401 |

`DELETE` 按 `(fleet, token)`，不要求 platform；不存在也 204。不升 `protocolVersion`。

#### 4.5.3 发送

`notifyEdge` **零改**。

```text
edges = notifyEdges(prev, snap)
for (token, platform) in fleetTokens:
  apns → 现有 apnsSender
  fcm  → fcmSender
```

无 FCM 配置：`FCM_DISABLED` 一条 warn，fcm 分支 no-op；**APNs 不受影响**。无 GMS 登不上 token：同 iOS 无 Push 权限。

FCM HTTP v1：

```
POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
```

```json
{
  "message": {
    "token": "<fcm-token>",
    "notification": { "title": "<edge.title>", "body": "<edge.body>" },
    "data": { "runId": "<id>", "kind": "<ask|completed|error|unknown|aborted>" },
    "android": {
      "priority": "HIGH",
      "collapse_key": "run-<id-truncated>",
      "notification": { "channel_id": "armada.alerts", "notification_count": 1 }
    }
  }
}
```

禁止：`finalText`、完整 prompt、只发 data 不发 notification、服务账号进安装包。

| 变量 | 含义 |
| --- | --- |
| `RELAY_FCM_SERVICE_ACCOUNT_PATH` | GCP JSON，mode `0600` |
| `RELAY_FCM_PROJECT_ID` | 可省略：用 JSON `project_id` |

发送注入 `post(...)`，单测不碰 Google。

| FCM HTTP | 行为 |
| --- | --- |
| 200 | audit `fcm.ok` |
| UNREGISTERED / 坏 token | 删该行 |
| 401 / 403 | 重签一次再失败则重试 |
| 429 / 5xx | 最多 3 次，2s / 8s / 30s |
| 其它 4xx | audit `fcm.fail`；不重试 |

游标：第一次尝试发出前写 `notified_*`（与 APNs 相同）。边沿后 **5s 内**发出第一次 HTTP。同 `runId` 串行。

App：

1. 高优先级通知渠道（id 与 `channel_id` 一致即可）  
2. 绑定成功后要通知权限 → 取 FCM token → POST `platform=fcm`  
3. token 刷新再 POST  
4. 点击 `data.runId` → 详情 GET  
5. 前台 `watchingId == runId` 丢弃横幅  
6. 解绑 DELETE  

无 Firebase 配置时：前台功能仍须全绿；P26 在该构建上与「iOS 无 `.p8`」同等降级，**完整态验收机必须是能收到可见通知的真机**（有 GMS + 中转已配服务账号）。

### 4.6 错误码文案（必须与 iOS 同句）

| code | 文案 |
| --- | --- |
| `CONVERSATION_BUSY` | 该对话仍在排队或绑定，结束后才能续聊 |
| `NO_CONVERSATION` | 还没有绑上 Cursor 对话，不能续聊 |
| `INJECT_SLOT_BUSY` | 这台机器正在注入另一条任务，稍后再试 |
| `WORKSPACE_NOT_OPEN` | 工作区没有打开 |
| `CLOSED` | 这条对话已关闭 |
| `PROMPT_COLLISION` | 同一工作区已有相同内容的任务 |
| `HUB_OFFLINE` | 中台离线 |
| `HUB_TIMEOUT` | 中台处理超时，请再发一次 |
| `RATE_LIMIT` | 点得太快，请稍后再发 |
| `EMPTY_PROMPT` | 提示词是空的 |
| `NET_INTERCEPT` | 当前网络拦截了中转。请关掉 Wi‑Fi 改用蜂窝，或换一个网络后再打开。 |
| `OUTBOUND_LIMIT` | 待消化续发已达上限，等 Cursor 消化后再发 |
| `OUTBOUND_TEXT_ONLY` | 运行中续发暂只支持纯文本 |
| `INVALID_STATE` | 当前状态不能重试 / 隐藏时改写「运行中不能隐藏」 |
| `NOT_FOUND` | 任务不存在 |
| `INVALID` | 推送登记失败 |
| `MACHINE_OFFLINE` | 机器离线 |
| `RUN_LIMIT` | 这台机器任务数已满 |
| `WINDOW_BUSY` | 该窗口正忙 |
| `OPERATOR_REQUIRED` | 走 pair 专用文案 |

HTTP 403 且 body 是 HTML → `NET_INTERCEPT`。

### 4.7 工程位置（非技术栈）

| 项 | 约束 |
| --- | --- |
| 路径 | `armada/mobile/android/`（与 iOS 同仓，协议才不漂） |
| 应用 id | 建议 `app.armada.remote`，不锁死；Firebase 包名与登记一致即可 |
| 分发 | 旁加载 / 内部分享；**不上架**（对齐 iOS 现网不上 App Store） |
| 模拟器中转 | `http://10.0.2.2:8780` |
| 构建命令 | 落地时写入 README；规格不锁 Gradle / Flutter |

签名密钥不进 git。

---

## 5. 运行时链路

```mermaid
sequenceDiagram
  participant And as Android App
  participant Relay as 中转
  participant Hub as 中台 hub
  participant FCM as FCM HTTP v1
  participant Ext as 受控扩展

  And->>Relay: 粘贴 op / GET workspaces
  And->>Relay: GET /mobile/stream
  And->>Relay: POST /mobile/runs
  Relay->>Hub: cmd.dispatch
  Hub->>Ext: 现有派发
  Hub->>Relay: snap.run
  Relay-->>And: SSE data: run
  And->>Relay: POST /mobile/push-token platform=fcm
  Hub->>Relay: snap.run（Ask / 终态）
  Relay->>Relay: notifyEdge
  Relay->>FCM: notification + runId
  FCM-->>And: 系统横幅
  And->>Relay: GET /mobile/runs/:id
```

| 环节 | 策略 | 失败 / 降级 |
| --- | --- | --- |
| 中转宕机 | 绑定/刷新失败 | 局域网指挥台不受影响 |
| 中台休眠 | `hubOffline`；派发 `503 HUB_OFFLINE` | 不假装 running |
| SSE 断 | 2s→60s 轮询 | 用户无感失败 |
| 隐藏列表被掐 | 保留旧隐藏列表；**不**写整页红字 | 与 iOS 一致 |
| 请求体 > 20 MiB | 413 | 不改摘要存储 |
| 无 FCM / 无 GMS | 不登记或不发送 | 前台 SSE 仍可用；完整态验收不用这台机当 P26 |
| FCM UNREGISTERED | 删 token | 其它设备继续 |
| 点通知未绑定 | 丢弃 `runId` | 不能靠通知写入 op token |

缓存：详情每次打开强制 GET。FCM OAuth 缓存至过期前 5 min。

| 项 | 指标 |
| --- | --- |
| `GET /mobile/workspaces` | p95 < 400ms（同区域） |
| `POST /mobile/runs` 到中台 ack | p95 < 1s |
| SSE UI | hub `snap.run` 后 p95 < 1s |
| FCM 发出 | 边沿后 5s 内第一次 POST |
| 载荷 | 无 `finalText`；title/body `clip120` |

---

## 6. 安全与威胁模型

| 威胁 | 缓解 | 指标 / 约束 |
| --- | --- | --- |
| 明文存 op token | 禁止明文持久化 | 解绑后存储层读不到 |
| 只配 URL | 邀请必须 token | 无凭证 401 |
| pair 当 op | 解析期拒绝 | 文案固定 |
| 服务账号进安装包 | 只放中转机 | review 禁 `private_key` 进客户端 |
| 任意登记 FCM token | op Bearer；fleet ≤20 | 无凭证 401 |
| 伪造通知钓鱼 | 只读 `runId`；GET 仍 Bearer | 未绑定丢弃 |
| 公司网 HTML 劫持 | 403+HTML → `NET_INTERCEPT` | 不当 JSON 解码 |
| 公网 cleartext | 仅 loopback / 10.0.2.2 | 生产 https |
| 无 GMS 声称锁屏 SLA | P26 验收机必须有 GMS | 不把无 GMS 机标 P26 通过 |

边界外：受控 Cursor、CDP、局域网 hub token、Play 隐私问卷。

回滚：卸包即无远程入口；去掉 FCM env → `FCM_DISABLED`，iOS APNs 不动；`platform` 列默认 `apns`。

---

## 7. 实施路线图

### 7.1 仓库与发布顺序（同一次完整态内）

| 顺序 | 产物 | 说明 |
| --- | --- | --- |
| 1 | URI / DTO / 错误码单测先红 | 框架自选 |
| 2 | 绑定 / 舰队 / 看板 / 派发 / 详情 / Ask / 隐藏 | 对本地中转 |
| 3 | SSE + 前后台 + 隐藏乐观更新 + `view=hidden` | |
| 4 | 中转 `platform` + `fcm.ts` 单测先红，再挂 `applyRunSnap` | `bun test relay/test`；无 JSON 时 FCM no-op、APNs 仍绿 |
| 5 | 客户端 FCM 登记 / 点击 / 前台去重 | 真机 P26–P28 |
| 6 | README：怎么跑、勿 frp 7380 | 外链本 spec；**写明所用技术栈**（规格不预先指定） |

跨仓：只动 `armada`。iOS 包不必发版。`protocolVersion` 仍为 1。不改 `hub/src/relayClient.ts`。

落地后 [armada-hub-app-parity](../../../.cursor/rules/armada-hub-app-parity.mdc) Surfaces 补 `mobile/android/`。合入后再改 rule。

### 7.2 验收（全部属于完整态）

| ID | 验收 |
| --- | --- |
| A1 | 无 token 无法派发 |
| A2 | 粘贴 pair → 中台链接文案；不写 token |
| A3 | 关仓后菜单无该项；`WORKSPACE_NOT_OPEN` |
| A4 | `completed` 的 `finalText` 与中台「复制正文」逐字节相同 |
| A5 | >100KB prompt 不截断（< 20 MiB） |
| A6 | 中台离线：仓空 + `hubOffline` |
| A7 | 前台 SSE：`snap.run` 后 1s 内 UI 更新；断开回退轮询 |
| A8 | `view=hidden` 列出已隐藏；客户端源码无 `archived=1` |
| A9 | 运行中可续聊；有 Ask 时续聊禁用；Build 走黄按钮 |
| A10 | occupying 隐藏 →「运行中不能隐藏」且回滚 |
| A11 | 有 GMS 真机锁屏可见通知；点击 GET 全文；载荷无 `finalText` |
| A12 | 正在看该 `runId` 时前台不弹；无服务账号时 iOS APNs 测试仍绿 |
| A13 | 旧 iOS POST（无 platform）仍 204 且 `platform=apns` |
| A14 | §1.1 P1–P30 勾完 |

**完整态 gate：A1–A14 全过。** 禁止把 A1–A10 单独标「已对齐 iOS」。A11 必须真机 + GMS。禁止 README 映射 7380。

无 FCM 配置的开发机构建：可继续开发前台，**不得**对外宣称完整态。

---

## 8. 风险与未决

| 风险 | 影响 | 应对 | 状态 |
| --- | --- | --- | --- |
| 无 GMS 锁屏收不到 | 该机无 P26 | 前台仍可用；厂商通道不在本规格 | 已知 |
| 国内访问 FCM 不稳定 | 发出失败 | 3 次退避；不改 run；中转机要能访问 Google | 已知 |
| OEM 不显示角标 | 未读只在 App 内 | 不承诺桌面角标 | 已知 |
| 自选框架与 SwiftUI 视觉差 | 不像同一个 App | **功能 / 文案 / 入口**强制同；像素不强制 | 已拍板 |
| Markdown 规则漂 | 终态版式错 | 与 iOS 同一输入夹具 | 实施时测 |
| 服务账号误提交 | 伪造推送 | review 禁 `private_key` | 已知 |
| 20 token 含多台手机 | 挤掉旧机 | 与现网 APNs 同一上限 | 已知 |
| 模拟器无 FCM | 不能在模拟器验 A11 | A11 真机 | 已关闭 |

| 未决 | 阻塞完整态？ |
| --- | --- |
| 用 Compose 还是 Flutter | **否**（规格不锁） |
| Firebase 项目由谁建 | 阻塞 A11，不阻塞前台开发 |
| 内部 Play 轨道 | 否 |
| 是否改 hub-app-parity 文件 | 否；合入后再改一行 |

阻塞项：无 CDP，不触发 `armada-feasibility-before-solution`。写实施计划时再钉技术栈。

---

## 9. 评审检查清单

- [x] 固定章节骨架
- [x] 唯一交付 = iOS 完整态（含推送）；不上架 / 厂商通道为以后
- [x] 非目标、风险、验收、回滚
- [x] 发布顺序：客户端 + 中转 FCM 同一次完整态；hub / 扩展 / iOS 包不改
- [x] 路径落到 `mobile/ios/ArmadaRemote/*.swift`、`relay/src/server.ts`、`relay/src/notifyEdge.ts`、`mobile/android/`
- [x] §1.1 功能对等表
- [x] 技术栈明确不锁
- [ ] 实施计划（技术栈由落地选定）
- [x] 修订记录

**未勾：** 实施计划；APK；真机 A11。

---

## 10. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-17 | 初稿。曾锁 Compose，并拆 v1（无 FCM）/ v1.5。 |
| 2026-09-17 | **产品确认：** 技术架构不要求；落地跑到 iOS 完整态（含锁屏推送）；功能必须对齐现网 iOS。取消技术栈否决与「无推送可上线」。§1.1 列为完成定义。 |
| 2026-09-18 | P24 补已读标回未读（与 iOS 同一套 `readAt` / `unreadHold`）。页内主操作按钮有体积；导航栏用系统/TopAppBar 按钮。仓页按 id 回查 live slot。 |

本文件为 Android 远程入口的 **实施基准**。变更 `/mobile/*` 字段或完成门禁须改《远程》并评估 `protocolVersion`；仅客户端 UI 实现不升协议。
