# Armada 远程：Android App（对齐现网 iOS）

- 日期：2026-09-17
- 状态：**实施基准（待人审后写实施计划）**
- 父文档：
  - [2026-09-12-armada-relay-mobile-design.md](./2026-09-12-armada-relay-mobile-design.md)（下称《远程》：中转 + `/mobile/*` + 邀请 URI）
  - [2026-09-16-armada-app-push-design.md](./2026-09-16-armada-app-push-design.md)（下称《推送》：可见 APNs；**明确不做 Android**，本文件补上 FCM）
  - [2026-09-16-armada-app-run-hide-design.md](./2026-09-16-armada-app-run-hide-design.md)（隐藏闭环）
  - [armada-hub-app-parity](../../../.cursor/rules/armada-hub-app-parity.mdc)（操作员能力 App 同一轮要能看见、做完）
- 修订范围：同仓新增 `mobile/android/`；中转推送表与登记 API **向后兼容**扩 `platform=fcm`。不改 hub 状态机、不改 `runToSnap`、不改受控扩展、不把 `7380` 公网化、不重写 iOS。
- 触发：iOS 遥控器已能绑 op、看板、派发/续聊、Ask/Build、隐藏、前台 SSE、锁屏 APNs；Android 操作员没有对等入口。

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | 现网遥控器只在 `mobile/ios/`。Android 操作员无法绑中转、选仓、做完 Ask/隐藏；锁屏通道也只有 APNs。 |
| 核心方案 | **方案 A：原生 Kotlin + Jetpack Compose，1:1 消费现网 `/mobile/*`。** 信息架构、文案、错误码、SSE 降级、隐藏乐观更新与 iOS 同契约。**v1 前台 SSE 即可用；v1.5** 用同一套 `notifyEdge` 代发 **FCM 可见通知**（不新造操作面）。 |
| 关键约束 | ① 权威仍在 hub；Android 只打中转。② 列表走 `?view=hidden`，禁止再发 `archived=1`。③ 详情每次打开强制 GET。④ FCM **永不带** `finalText`。⑤ 无 GMS / 无服务账号 = 不推，前台 SSE 照常。⑥ applicationId `app.armada.remote`。⑦ 不把 FCM 当 v1 上线 gate。 |
| 明确不做 | Flutter / KMP 重写 iOS；WebView 套中台网页；公网 7380；blobs / 工作区附件；华为 HMS / 小米 / OPPO 厂商通道（v1）；Play 商店上架（v1）；前台常驻 Service 假装锁屏通道；VoIP；静默 FCM 当主通道；把服务账号 JSON 打进 APK。 |

---

## 1. 背景与需求

| # | 原始诉求 | 设计映射 |
| --- | --- | --- |
| R1 | 参照 iOS 做 Android 解决方案 | 现网 iOS 行为是产品源，不是 2026-09-12 草稿五屏。对照 `mobile/ios/ArmadaRemote/{RelayAPI,Screens,ArmadaRemoteApp,Invite}.swift` |
| R2 | 不在局域网也能控中台 | 只连 `https` 中转；邀请仍是 `armada-relay://op?…` |
| R3 | 操作员能力与中台 / iOS 对等 | 列仓、派发、续聊、答 Ask、Build、取消、重试、隐藏/取消隐藏、复制全文、未读角标 |
| R4 | 开着 App 要及时 | 前台 `GET /mobile/stream`；断线退避轮询；进后台停 SSE |
| R5 | 离开 App 也要知道 Ask / 终态 | v1.5 中转代发 FCM；点进详情强制 GET |
| R6 | 开源自建 | 工程在本仓 `mobile/android/`；FCM 密钥只在中转机 |
| R7 | 国内网络 / 模拟器可测 | 模拟器 `http://10.0.2.2:8780`；`view=hidden`；HTML 403 → `NET_INTERCEPT` |

对照 iOS 现网（2026-09-17），**不是**《远程》文首「待确认的草稿五屏」，而是已落地的：

| iOS 面 | 行为 | Android 必须 |
| --- | --- | --- |
| `BindView` | 粘贴 op URI；拒 pair | 同 |
| `WorkspaceListView` | 按机器分组；未读胶囊；解绑 / 刷新 | 同 |
| `WorkspaceHome` | 五列看板；派发；查看已隐藏；滑动隐藏 | 同 |
| `DispatchSheet` | 无字数 cap；派发 / 续聊共用 | 同 |
| `RunDetailView` | 强制 GET；Markdown；Ask / Build；队列托盘；取消 / 重试 / 隐藏 | 同 |
| `Session` | Keychain token；前台 SSE；隐藏乐观更新；推送登记 | EncryptedSharedPreferences + 同状态机 |
| Deep link | `armada-relay://` | Intent-filter 同 scheme |

**诉求外、本规格不发明：** 远程开窗、附件 blobs、多中转集群、把 Android 做成第二份 hub。

---

## 2. 现状盘点

### 2.1 可复用（零改或只加测试）

| 能力 | 代码位置 | Android 怎么用 |
| --- | --- | --- |
| 邀请 URI | `relay/src/uri.ts`；iOS `Invite.swift` | 同解析规则；Android 再写一份 Kotlin，单测对齐 `relay/test/uri.test.ts` |
| 列仓 / 派发 / 详情 | `relay/src/server.ts` `/mobile/*` | 路径、HTTP 码、JSON 字段与 iOS `RelayAPI` 逐接口对齐 |
| 隐藏 | `GET ?view=hidden`；`POST archive\|unarchive` | 同 iOS；客户端再按 `archived` 过滤 |
| 续聊 | `POST /mobile/runs/:id/followup` → 201/200 | 同；运行中可发，入口不看 `isLive` |
| Ask / Build | `POST .../answer`；UI 闸 = 唯一选项 `id=build`（同 iOS `AskView.isPlan`） | 同 `AskView` |
| 前台 SSE | `GET /mobile/stream` | OkHttp SSE；注释行 `: ping` 忽略 |
| 错误码文案 | iOS `RelayAPIError.operatorMessage` | 拷同一张表（见 §4.6） |
| 通知边沿 | `relay/src/notifyEdge.ts` | **不改函数**；发送端再走 FCM |
| 完成门禁 | `finalText` = `assistantBodyText` | 详情 GET；列表不依赖 `finalText` |
| Markdown 子集 | iOS `MarkdownView.swift` | 移植同一 HTML 生成，WebView 渲染 |

### 2.2 需新建

| 能力 | 落点 |
| --- | --- |
| Android 工程 | `mobile/android/`（Gradle + Compose） |
| 会话 / 导航 / 看板 | Kotlin，模块边界对齐 iOS 文件 |
| operator token 存储 | EncryptedSharedPreferences（对齐 Keychain，不明文 SharedPreferences） |
| FCM 登记与点击 | App：Firebase Messaging；中转：`platform=fcm` |
| 中转 FCM 发送 | `relay/src/fcm.ts`；`applyRunSnap` 后按 platform 分发 |
| 网络配置 | 仅允许模拟器 / 本机 cleartext；生产只 https |

### 2.3 不复用 / 有害

- 把 `hub/web` 塞进 WebView：中台网页吃局域网 token，不是 op Bearer，也没有手机信息架构。
- 复用 `POST /mobile/push-token` 的 **64 hex** 校验去登记 FCM：FCM token 不是 64 hex，会 400，Android 永远登不上。
- 后台 Foreground Service 挂 SSE：用户可见常驻通知，且国产 ROM 仍会杀；不能当锁屏 SLA。
- 再打 `?archived=1`：公网网关会掐流（iOS 已踩过）。
- 厂商推送 SDK 进开源 APK：账号、隐私协议、每 ROM 一套；v1 不做。
- KMP 抽共享层并改 iOS：本规格窗口只补 Android，禁止顺手重写已在 TestFlight 的包。

---

## 3. 设计原则

1. **一份契约，两份客户端。** `/mobile/*` 与 `RunSnap` 是唯一远程协议；Android 不得要「安卓专用 run 字段」。
2. **iOS 现网是产品源。** 文案、五列、Ask/Build、隐藏乐观更新、SSE 前后台，以 Swift 为准，不回到 09-12 草稿。
3. **出站优于入站。** App 永远不碰 `7380`。
4. **推送是叫醒。** 可见通知 + `runId` + `kind`；正文只 GET。
5. **失败可降级。** 无 FCM / 无 GMS / 用户关通知 → 前台仍可用。
6. **能测再写生产。** URI / DTO / 错误码 / `view=hidden` 先 JVM 单测；FCM 发送注入 transport；锁屏必须真机。
7. **最小中转切口。** 只为 FCM 扩 token 表与登记体；`notifyEdge` 与 APNs 载荷文案保持不变。

### 3.1 已否决方案

| 方案 | 为什么不选 |
| --- | --- |
| B. Flutter 一套 UI 打 iOS+Android | 要重写已发布 iOS；审核/推送/Keychain 仍分平台；工期比「只补 Android」长 |
| C. KMP 共享网络层 | 合理长期项，但本轮会改 iOS 调用栈；标 v2 触发：出现第三次客户端 |
| D. WebView 打开中台 | 中台不面向公网 op；Ask/隐藏/SSE 都不是那套页面 |
| 只做 APK、推送永远不做 | 违反「锁屏 Ask」已在 iOS 落地的对等；允许 **分阶段**，不允许永久缺 |
| 用极光 / 个推当主通道 | 闭源依赖 + 中转要把别家 master secret 放进自建；与开源自建冲突 |
| 静默 FCM data-only | 国产 ROM / 省电常丢；Ask 必须可见 notification |
| HMS + FCM 双通道 v1 | 账号、签名、测试矩阵爆炸；无 GMS 写进风险，不挡 v1 APK |

### 3.2 范围

| 阶段 | 做 | 不做 | 触发 |
| --- | --- | --- | --- |
| **v1** | Compose 全操作面；https 绑定；SSE + 退避轮询；`view=hidden`；错误码表；debug APK 旁加载 | FCM；Play 上架；厂商通道；blobs | 本 spec；先求模拟器 / USB 真机能做完 Ask |
| **v1.5** | FCM 可见通知；`platform` 列；点通知进详情 GET；前台正在看该 run 不弹 | HMS；data-only 主通道 | v1 A1–A8 过 + 要锁屏 |
| **v2** | Play Internal testing **另开闸**；KMP 抽取 **另开闸**；国内厂商通道 **另开闸**（仅当目标机无 GMS 且产品要锁屏） | 把 7380 公网化 | 商店分发或无 GMS 成为真实阻塞 |

Hub / 受控扩展：**本规格零改。** 中转仅 v1.5 改推送登记与发送。

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

落盘：

| 键 | 位置 |
| --- | --- |
| `relay` / `fleet` | 普通 SharedPreferences（非秘密） |
| operator token | EncryptedSharedPreferences，keystore AES256；禁止再写明文 `token` |
| `readAt` | 普通 prefs JSON，同 iOS `armada.readAt` |
| FCM token（v1.5） | 普通 prefs 只存当前串，解绑 DELETE |

解绑：清 prefs + DELETE FCM token（能调则调）+ 停 SSE。

Deep link：`AndroidManifest` `intent-filter` `android:scheme="armada-relay"`；冷启动与热启动都进同一 `bind(uri)`。

**备选不选只填 https URL：** 无身份，已在《远程》否决。  
**备选不选 Android App Links（https 校验）：** 自建中转域名不固定，必须继续用自定义 scheme。

### 4.2 App ↔ 中转 HTTPS（v1 零新路由）

鉴权：`Authorization: Bearer {operatorToken}`。禁止 `?token=`。

与 iOS `RelayAPI.swift` 逐条对齐：

| 动作 | 方法 | 成功码 | 客户端要点 |
| --- | --- | --- | --- |
| 列仓 | `GET /mobile/workspaces` | 200 | `hubOffline` |
| 派发 | `POST /mobile/runs` `{workspaceId,prompt}` | **201** | 只认 201 |
| 列表 | `GET /mobile/runs?limit=50` | 200 | 再 `filter { !archived }` |
| 已隐藏 | `GET /mobile/runs?limit=50&view=hidden` | 200 | **禁止** `archived=1`；失败不打红整页（同 iOS `refresh`） |
| 详情 | `GET /mobile/runs/:id` | 200 | 含 `finalText`；已隐藏也 200 |
| 续聊 | `POST /mobile/runs/:id/followup` `{prompt}` | **200 或 201** | 两者都成功 |
| 重试 | `POST /mobile/runs/:id/retry` | 200 | |
| 隐藏 / 取消 | `POST .../archive\|unarchive` | 200 | occupying → 409 `INVALID_STATE` → 「运行中不能隐藏」 |
| 回答 | `POST .../answer` | 202 或 200 | 允许空 body |
| 取消 | `POST .../cancel` | 200 | 允许空 body |
| SSE | `GET /mobile/stream` `Accept: text/event-stream` | 200 | 忽略 `: ping`；只解析 `data:` |

超时：普通 REST 30s；SSE 读超时 ≥ 90s（对齐 iOS）。请求体上限仍是中转 20 MiB；客户端不设字数 UI cap。

列表无 `finalText`：Android 必须像 iOS `keepListBodies` 一样，刷新时保留本地已有正文，避免详情闪空。

隐藏乐观更新：先 `applyLocalArchive` 再 POST；失败 `revertLocalArchive`。进行中的 id 在 SSE 回包时按 pending 集合忽略反向 snap（抄 `Session.applyStreamRun`）。

**v1 不做的路由：** blobs、ui-prefs、events 全文、任何 Android 专用 `/mobile/android/*`。

### 4.3 前台通道（对齐 iOS 现网，不是回到 10s 纯轮询）

```text
前台：SSE
SSE 失败 / 进后台：停连接；失败则 2s→60s 退避后 GET 三件套（仓 + 列表 + 隐藏）
详情：打开强制 GET；SSE 健康时 1s 心跳只跟 stream；不健康且 live/Ask 时 3s 再 GET
```

`ProcessLifecycleOwner`：`ON_START` = 前台 `startLive()`；`ON_STOP` = `stopLive()`。不要用 `ON_PAUSE`（多窗口会误停）。

验收 A7：模拟器前台，hub 出 `snap.run` 后列表 **p95 < 1s**（同区域）；拔 SSE 后仍能派发，15s 内轮询看到非 queued。

**备选不选 v1 只轮询：** iOS 已上 SSE；再做一轮 10s 钝的 Android 违反对等。  
**备选不选后台保活 SSE：** 见 §3.1。

### 4.4 信息架构与状态机（对齐 Screens.swift）

导航：`舰队 → 仓看板 → 详情`；派发 / 续聊为 Modal。通知 / 冷启动 `pendingOpenRunId`：清空栈后直达详情。

看板列（`BoardColumn`）：

| status | 列 |
| --- | --- |
| `created` `queued` `dispatched` `binding` | 待回车 |
| `running` | 运行中 |
| `completed` | 已完成 |
| `cancelled` `aborted` | 已取消 |
| 其它 | 异常 |

未读（同 iOS `isUnread`）：

- 有 `pendingAsk`：未见过，或 `updatedAt > readAt`
- `completed` / `error` / `unknown` / `aborted`：同上
- 打开详情即 `markOpened`

Ask：

- 普通：选项 +「跳过」+「继续」（未选不能继续）
- Plan：与 iOS `AskView.isPlan` 完全相同——`questions[0].options` **恰好 1 条且 `id=="build"`** → 黄底 **Build**，不走普通选项 UI。不另解析 `pendingAsk.kind`（中台有 `kind=plan` 只保证选项形如此）

`canFollowup` = `pendingAsk == nil`（运行中也可续聊）。  
`showsRetry` = `canRetry` 或 status ∈ {error, unknown, aborted}。  
`showsArchive` = 非 live 且未隐藏。

角标：未读条数之和写 `NotificationManager` / launcher badge（Android 8+ 厂商不一定显示；失败忽略，不挡主路径）。

Markdown：移植 iOS fence / 行内规则到 Kotlin 纯函数，JVM 单测夹具与 Swift 同一输入；UI 用 WebView。禁止换一套 Markdown 库导致终态版式漂移。

### 4.5 FCM（v1.5；v1 文档先行，代码后置）

#### 4.5.1 表

现网：

```sql
PRIMARY KEY (fleet_id, token)
environment CHECK (environment = 'production')
```

v1.5 增加列，**默认 `apns`，旧行不用迁移脚本改 token：**

```sql
-- ensureColumn
platform TEXT NOT NULL DEFAULT 'apns' CHECK (platform IN ('apns','fcm'))
```

查询发送改为 `SELECT token, platform`。同 fleet 仍最多 **20** 行（iOS+Android 合计）；超出按 `updated_at ASC` 删。audit 只留 token 后 8 位。

**备选不选两张表：** 边沿发送循环会分叉，20 上限难共享。  
**备选不选改 PRIMARY KEY 为全局 token：** 解绑换舰队会撞。

#### 4.5.2 登记 API（向后兼容）

```
POST /mobile/push-token
{ "token": "…", "environment": "production", "platform": "apns" | "fcm" }
→ 204
```

| 条件 | 行为 |
| --- | --- |
| 无 `platform` | **视为 `apns`**（现网 iOS 不改包也能登） |
| `platform=apns` | token 仍须 64 hex；否则 400 `INVALID` |
| `platform=fcm` | token 长度 32–4096，字符集 `[A-Za-z0-9_:\-.]`；否则 400 `INVALID` |
| `environment` ≠ `production` | 400 `INVALID` |
| pair secret | 403 `OPERATOR_REQUIRED` |
| 无 Bearer | 401 |

```
DELETE /mobile/push-token
{ "token": "…" }
→ 204
```

DELETE 仍按 `(fleet, token)` 删，**不要求** body 带 platform（token 在 fleets 内唯一）。不存在也 204。

不升 `protocolVersion`：缺字段旧客户端仍合法。

#### 4.5.3 发送

`notifyEdge` **零改**。`applyRunSnap` 在现有 APNs 循环旁：

```text
edges = notifyEdges(prev, snap)
for (token, platform) in fleetTokens:
  if platform == apns → 现有 apnsSender
  if platform == fcm  → fcmSender
```

无 FCM 配置：`FCM_DISABLED` 一条 warn，fcm 分支 no-op；APNs 不受影响。  
无 GMS 的手机登不上 token：同「无 APNs 证书」。

FCM HTTP v1：

```
POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
Authorization: Bearer {service-account OAuth}
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
      "notification": {
        "channel_id": "armada.alerts",
        "notification_count": 1
      }
    }
  }
}
```

| 禁止 | 原因 |
| --- | --- |
| `data.finalText` / 完整 prompt | 与 APNs 相同 |
| 只发 data、不发 notification | 会被当静默；Ask 必须可见 |
| 把服务账号放进 APK | 任何人可冒充中转发推 |

环境变量（中转机）：

| 变量 | 含义 |
| --- | --- |
| `RELAY_FCM_SERVICE_ACCOUNT_PATH` | GCP 服务账号 JSON，mode `0600` |
| `RELAY_FCM_PROJECT_ID` | 可省略：用 JSON 里的 `project_id` |

缺任一项 → 不发 FCM。发送模块注入 `post(url, headers, body)`，单测不碰 Google。

| FCM HTTP | 行为 |
| --- | --- |
| 200 | audit `fcm.ok` |
| 404 / 400 `UNREGISTERED` `INVALID_ARGUMENT`（坏 token） | 删该行 |
| 401 / 403 账号失效 | 丢弃 OAuth 缓存，重签一次；仍失败进重试 |
| 429 / 5xx | 该 token 最多 3 次，2s / 8s / 30s |
| 其它 4xx | audit `fcm.fail`；不重试 |

游标策略 **复用 APNs**：第一次尝试发出前写 `notified_*`，避免双通道连弹。SLA：边沿后 **5s 内**发出第一次 HTTP（不计 Google 到达）。同 `runId` 发送串行。

App（v1.5）：

1. 通知渠道 `armada.alerts`，importance HIGH  
2. 绑定成功：`POST_NOTIFICATIONS`（API 33+）→ `FirebaseMessaging.getToken()` → POST `platform=fcm`  
3. token 刷新回调再 POST  
4. 点击：`data.runId` → `pendingOpenRunId` → 详情 GET  
5. 前台：`watchingId == runId` 则取消系统横幅（`onMessageReceived` 里 drop）；列表页仍展示  
6. 解绑 DELETE

Firebase `google-services.json`：**可以**进开源仓的 debug 占位说明，但生产项目文件由部署方提供；文档写清「自建者自己建 Firebase 项目」。没有 JSON 时 debug 包仍能跑完 v1（推送 no-op）。

### 4.6 错误码文案（必须与 iOS 同句）

拷 `RelayAPIError.operatorMessage`：

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

HTTP 403 且 body 是 HTML → `NET_INTERCEPT`（公司网 / 酒店门户）。

### 4.7 工程与发布（运维，非协议）

| 项 | v1 |
| --- | --- |
| 路径 | `armada/mobile/android/` |
| applicationId | `app.armada.remote` |
| minSdk / target | 26 / 35 |
| UI | Jetpack Compose Material3 |
| 网络 | OkHttp + kotlinx.serialization（字段名与 JSON 相同，不写 `final_text`） |
| SSE | okhttp-sse 或等价 bytes 解析，注释行跳过 |
| 构建 | `./gradlew :app:testDebugUnitTest :app:assembleDebug` |
| 分发 | USB / 内部分享 APK；**不上架** |
| 模拟器中转 | `http://10.0.2.2:8780`（对应宿主机 8780） |

签名：debug 用默认 debug keystore。release 密钥不进 git。

**备选不选把 Android 拆独立仓：** 协议与 DTO 每周都在本仓变；拆仓必漂。与 iOS 同仓策略一致。

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
  Note over And,FCM: v1.5 才有下面
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
| 隐藏列表被网关掐 | 保留旧 `hiddenRuns`；**不**写 `lastError` | 与 iOS 2026-09-17 修复一致 |
| 请求体 > 20 MiB | 413 | 文案透传；不改摘要存储 |
| 无 FCM / 无 GMS | 不登记或不发送 | 前台 SSE 仍可用 |
| FCM 4xx UNREGISTERED | 删 token | 其它设备继续 |
| 点通知时未绑定 | 丢弃 `runId` | 不能靠通知写入 op token |

缓存：详情每次打开强制 GET。列表 TTL = SSE 或轮询间隔。FCM OAuth token 缓存至过期前 5 min。

指标（同区域 VPS，排除 DERP / 运营商）：

| 项 | 指标 |
| --- | --- |
| `GET /mobile/workspaces` | p95 < 400ms |
| `POST /mobile/runs` 到中台 ack | p95 < 1s |
| SSE UI | hub `snap.run` 后 p95 < 1s |
| FCM 发出 | 边沿后 5s 内第一次 POST |
| 载荷 | 通知 JSON 无 `finalText`；title/body 沿用 `clip120` |

---

## 6. 安全与威胁模型

| 威胁 | 缓解 | 指标 / 约束 |
| --- | --- | --- |
| 明文存 op token | EncryptedSharedPreferences | 备份排除；卸载即无 |
| 备份 / root 导出 prefs | 不把 token 放可备份明文；文档警告 root 设备 | 不承诺对抗物理 root |
| 只配 URL | 邀请必须 token | 无凭证 401 |
| pair 当 op | 解析期拒绝 + 403 | 文案固定 |
| 截屏 / 多任务预览泄露终态 | v1 不做 FLAG_SECURE（操作员要复制）；标已知 | 不挡 |
| `google-services.json` / 服务账号进 APK | 服务账号只在中转；JSON 不含发推私钥 | review 禁 `private_key` 进 `app/` |
| 任意 App 登记别人的 FCM token | 仍要 op Bearer；刷屏靠 20 行上限 | 无凭证 401 |
| 伪造通知打开钓鱼 URL | 只读 `runId`；GET 仍 Bearer | 未绑定丢弃 |
| 公司网 HTML 劫持 | 403+HTML → `NET_INTERCEPT` | 不把 HTML 当 JSON 解码 |
| cleartext 到公网 | network-security-config 仅 loopback / 10.0.2.2 | 生产 https |
| 无 GMS 还假装有锁屏 SLA | 文档 + 验收不含无 GMS 锁屏 | v1.5 A9 必须有 Play Services 的真机 |

边界外：受控 Cursor 账号、CDP、局域网 hub token、Play 审核隐私问卷（v2 商店闸才做）。

回滚：

- App：卸包即无远程入口；中转不停。
- FCM：去掉 env 即 `FCM_DISABLED`；iOS APNs 不动。
- 表 `platform` 列：旧 APNs 默认 `apns`，回退二进制只要 SELECT 仍含 token 列即可。

---

## 7. 实施路线图

### 7.1 仓库与发布顺序

| 顺序 | 产物 | 验收 |
| --- | --- | --- |
| 1 | Android URI 解析 + DTO + 错误码 JVM 单测（先红） | `./gradlew :app:testDebugUnitTest` |
| 2 | Compose 绑定 / 舰队 / 看板 / 派发 / 详情 / Ask / 隐藏；对本地中转 | 模拟器：绑 op → 选仓 → 派发 → 详情全文 → Ask |
| 3 | SSE + 前后台 + 隐藏乐观更新 + `view=hidden` | 拔 SSE 仍派发；隐藏失败不整页红字 |
| 4 | README：模拟器 `10.0.2.2`、旁加载、反模式（勿 frp 7380） | 外链本 spec |
| 5（v1.5） | 中转 `platform` + `fcm.ts` 单测先红；再接线 `applyRunSnap` | `bun test relay/test`；无 JSON 时 FCM no-op、APNs 单测仍绿 |
| 6（v1.5） | App FCM 登记 / 点击 / 前台去重 | 真机锁屏 Ask；点进正文与中台「复制正文」逐字节相同 |

跨仓：只动本仓 `armada`。受控扩展不必升级。iOS 包 **不必**为 Android 发版（登记 API 缺 `platform` 仍当 apns）。

版本对齐：中转 `protocolVersion` 仍为 1。Hub / iOS / Android 拒绝更高主版本的规则不变。

**不改** `hub/src/relayClient.ts`。v1.5 只改 `relay/src/{db,server,fcm}.ts` 与测试。

落地后把 [armada-hub-app-parity](../../../.cursor/rules/armada-hub-app-parity.mdc) Surfaces 表 App 行补上 `mobile/android/`（与 iOS 并列）。**本轮规格批准前不改该 rule。**

### 7.2 每阶段验收（必须可测）

| ID | 阶段 | 验收 |
| --- | --- | --- |
| A1 | v1 | 无 token 的 https 中转无法派发 |
| A2 | v1 | 粘贴 pair → 明确中台链接文案；不写 Keystore |
| A3 | v1 | 关仓后菜单无该项；派发得 `WORKSPACE_NOT_OPEN` |
| A4 | v1 | `completed` 的 `finalText` 与中台「复制正文」逐字节相同 |
| A5 | v1 | >100KB prompt 往返不截断（< 20 MiB） |
| A6 | v1 | 中台离线：仓空 + `hubOffline`，不假装 running |
| A7 | v1 | 前台 SSE：`snap.run` 后 1s 内 UI 更新；SSE 断开回退轮询 |
| A8 | v1 | `view=hidden` 能列出已隐藏；`archived=1` **不得**出现在客户端源码 |
| A9 | v1 | 运行中详情有「续聊」；Ask 存在时续聊入口禁用；Build 唯一选项走黄按钮 |
| A10 | v1 | occupying 隐藏 → 「运行中不能隐藏」且列表回滚 |
| A11 | v1.5 | 有 GMS 真机锁屏可见 FCM；点击 GET 全文；载荷无 `finalText` |
| A12 | v1.5 | 正在看该 `runId` 时前台不弹；无服务账号时 iOS APNs 测试仍绿 |
| A13 | v1.5 | 旧 iOS POST（无 platform）仍 204 且 `platform=apns` |

上线 gate：A1–A10 全过才标「可旁加载 / 可模拟器」。A11–A13 不挡 v1，且 A11 必须真机 + GMS。禁止 README 出现映射 7380。

---

## 8. 风险与未决

| 风险 | 影响 | 应对 | 状态 |
| --- | --- | --- | --- |
| 无 GMS（华为等）锁屏收不到 | v1.5 对该机失效 | 前台仍可用；厂商通道进 v2 闸 | **已知，不挡 v1** |
| 国内访问 `fcm.googleapis.com` 不稳定 | 发出失败 | 3 次退避；不改 run；文档写中转机网络要能访问 Google | 已知 |
| OEM 不显示角标 | 未读只在 App 内 | 不承诺桌面角标 SLA | 已知 |
| Compose 与 SwiftUI 视觉差 | 操作员觉得「不是同一个 App」 | 文案 / 五列 / 按钮集合强制同；像素不强制 | 已知 |
| Markdown 移植漏 fence | 终态版式错 | JVM 夹具对同一 prompt | 实施时测 |
| `google-services.json` 误提交私钥 | 伪造推送 | code review；CI 可加简单扫 `private_key` | 已知 |
| 20 token 含两台 Android + 多 iPhone | 挤掉旧机 | 与现网 APNs 同一上限；可接受 | 已知 |
| 模拟器无 FCM | 不能用模拟器验 A11 | 写进验收；v1 不依赖 | 已关闭 |

| 未决 | 阻塞？ |
| --- | --- |
| Firebase 生产项目由谁建（自建中转方 vs 内部统一项目） | 只阻塞 v1.5，不阻塞 v1 APK |
| 是否要内部 Play 轨道 | 否；v1 旁加载 |
| 是否在本轮改 hub-app-parity 文件 | 否；Android 合入后再改 Surfaces 一行 |

阻塞项：**本文件人审。** 审过再写 `docs/superpowers/plans/2026-09-17-armada-android-app.md`。无 CDP / IDE 控件，不触发 `armada-feasibility-before-solution`。

---

## 9. 评审检查清单

- [x] 固定章节骨架
- [x] MVP/v1/v1.5/v2
- [x] 非目标、风险、验收、回滚
- [x] 发布顺序：Android App →（v1.5）中转 FCM；hub / 扩展不改；iOS 包不必发版
- [x] 路径落到 `mobile/ios/ArmadaRemote/*.swift`、`relay/src/server.ts`、`relay/src/notifyEdge.ts`、`mobile/android/`
- [x] 与 iOS 现网对等表（含 `view=hidden`、SSE、Ask/Build、隐藏乐观更新）
- [x] FCM 与 APNs 共存、缺 platform 兼容
- [ ] **人审本 spec**
- [x] 修订记录

**未勾：** 人审；实施计划；APK；FCM 真机。

---

## 10. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-17 | 初稿。方案 A：Compose 对齐 iOS 现网 `/mobile/*`。v1 不做 FCM；v1.5 扩 `platform=fcm` 且不升 protocolVersion。否决 Flutter/KMP/WebView/厂商推送/后台 Service。 |

本文件为 Android 远程入口的 **实施基准**。变更 `/mobile/*` 字段或完成门禁须改《远程》并评估 `protocolVersion`；仅 Android UI 不升协议。
