# Changelog

Armada 按 **面** 发版：扩展、桌面、iOS、Android 可以不同号。README 顶部「当前版本」表只反映此刻要装的号；本文件按日期记下每个号修了什么、新了什么。

格式：[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本号来源见 skill `armada-release-docs`。

未打新号就合进 `master` 的改动先写在 **Unreleased**；下次升号时整段搬进对应版本。

---

## Unreleased

---

## 2026-09-20 — 扩展 0.4.35 · iOS TF 24 · Android 0.1.11 · 桌面 0.1.0

### 修复

- 空闲 Reload 在本窗刚合成 stop / 刚写完 `turn_ended` 后等 2 分钟，不再一收口就 Reload Window 把当前对话清掉。
- Reload 成功后不再清掉 `pending-reload-attempt.json`，同一条 pending 不会每 10 秒再打一次（今早 0.4.30 那种环）。
- 扩展包还不在中台旁时，看板和 App 写明「需要先打包」，不再给出点了没反应的 Reload。`POST /api/cursor-reload` 返回 409 `PACK_MISSING`。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.35.vsix` 再空闲 Reload。只 Reload 不会从 0.4.34 升上去。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.35` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **24**；Android **0.1.11**。

---

## 2026-09-20 — 扩展 0.4.34 · iOS TF 24 · Android 0.1.11 · 桌面 0.1.0

### 修复

- 手机舰队只在**还落后的机器**下给出 Reload，已 Reload 的中台机不再跟整队 `needed` 一起出按钮；状态跟工作区 SSE 一起到。
- 中台看板卡片不再重复「需 Reload」；只写在侧栏机器区域。打开详情不再挡住顶栏/侧栏按钮。

### 操作员注意

装 TestFlight **24** / Android **0.1.11**（versionCode 12）。TF **23** 仍会在每台机器下重复 Reload。扩展当前是 **0.4.34**；Windows 被控须先装对应 vsix 再空闲 Reload。

---

## 2026-09-20 — 扩展 0.4.34 · iOS TF 23 · Android 0.1.10 · 桌面 0.1.0

### 修复

- 空闲 Reload 把本窗工作区里尚未 `turn_ended`、且 15 分钟内还在写的 composer jsonl 也算忙。本地 Agent 还在跑时不再调用 Reload Window，避免 Cursor 弹出「N agents are still working」。`now` 仍不回避只有 Armada pending/bind、还没有 jsonl 的注入，但同样会等这些未收口 jsonl。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.34.vsix` 再空闲 Reload。只 Reload 不会从 0.4.33 升上去（同号会被 `skipped-same-version` 跳过）。看板落后会提示「需 0.4.34」。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.34` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **23**；Android **0.1.10**。

---

## 2026-09-20 — 扩展 0.4.33 · iOS TF 23 · Android 0.1.10 · 桌面 0.1.0

### 修复

- 公网 uuWAF 会把大约 10KiB 以上的请求打成 HTML 500；手机发图改成 6KiB JSON 分片，中转拼好再一次 `cmd.blobPut`。HTML 500 不再误报成「关掉 Wi-Fi」。

### 操作员注意

关 Wi-Fi 解决不了。要先有新中转，再装 TestFlight **23** / Android **0.1.10**（versionCode 11）。旧包仍走整段 multipart，会被网关拦下。

---

## 2026-09-20 — 扩展 0.4.33 · iOS TF 22 · Android 0.1.9 · 桌面 0.1.0

### 修复

- Windows 窗口标题带 Untracked / Modified / 1 problem 等装饰时仍能选中工作区页：按官方 `window.title` 模板切段，只在产品名左侧全等匹配文件夹，不再跟装饰文案打地鼠。
- 连上工作区页后把 `vscode.env.sessionId` 盖到 `document.documentElement[data-armada-window-id]`；之后选页先认盖章，标题只做冷启动。
- 带图 / 文件提及选窗失败时 Hub ack 透传 `WINDOW_TARGET_*` / `NO_WS_URL` / `CDP_*`，不再一律改写成 `IMAGE_PASTE_FAILED` / `FILE_MENTION_FAILED`。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.33.vsix` 再空闲 Reload。只 Reload 不会从 0.4.32 升上去（同号会被 `skipped-same-version` 跳过）。看板落后会提示「需 0.4.33」。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.33` 的包装 hub，否则 Reload 按钮仍写旧号。桌面仍是 **0.1.0**；iOS TestFlight **22**；Android **0.1.9**（versionCode 10）。

---

## 2026-09-20 — iOS TF 22 · Android 0.1.9 · 桌面 overlay

### 新增

- 手机派发、终态续聊可发最多 4 张 PNG/JPEG（HEIC 在设备上转 JPEG，原像素、质量 0.92）；只附图也能发，空 prompt 列表标题是 `[N 张图片]`。
- 中转 `POST /mobile/blobs`；中台 `cmd.blobPut` 把图交给现网 CDP 贴芯片。运行中续聊仍只能发文字。

### 操作员注意

要用上发图，三端一起升：包装中台 overlay（号仍 **0.1.0**）、公网中转、TestFlight **22** / Android **0.1.9**（versionCode 10）。旧中转没有 `/mobile/blobs` 时，App 会藏掉相册，不会把图当纯文本发出去。

---

## 2026-09-20 — 扩展 0.4.32 · iOS TF 21 · Android 0.1.8 · 桌面 0.1.0

### 修复

- 取消 Plan 后 leftover Build 不再当 pending，也不挂到同窗下一条（Cursor 的 Created Plan transcript 卡没有关闭按钮，屏上仍可能留着 View Plan / Build）。
- 窗上有未答 Ask 时新任务排队；取消普通 Ask 会先 Skip 再停跑。
- 中转限制手机请求体体积；桌面看板 CSP 收到 `http://*:7380`，不再放行任意端口。
- 看板派发框留在视口内；五列卡片标题过长截断。
- 中转 run 快照按 `fleet` 隔离；畸形 `register` / JSON 直接 400。

### 文档

- README 换成现网桌面看板 / 任务详情 / iOS 舰队·仓列表·详情截图；顶部增加四行当前版本表。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.32.vsix` 再空闲 Reload。只 Reload 不会从 0.4.31 升上去（同号会被 `skipped-same-version` 跳过）。看板落后会提示「需 0.4.32」。App 这一轮没有新按钮。iOS 仍是 TestFlight **21**；Android **0.1.8**（versionCode 9）；桌面仍是 **0.1.0**。

---

## 2026-09-20 — 扩展 0.4.31 · iOS TF 21 · Android 0.1.8 · 桌面 0.1.0

### 新增

- Ask 卡把 Cursor **Other** 显示为选项 D，自由文本可过中台/App。
- 手机快照带 `title`、`conversationId`；`unknown` 快照带 `finalText`。
- 空闲 Reload：扩展 ≥ 0.4.27 按窗口在无 live run 时 Reload；**0.4.31** 把这次闩打进新 vsix 号（同号 0.4.30 会被 `skipped-same-version` 跳过）。

### 修复

- Ask **Skip** 点 Cursor 的 Skip 按钮，不再误点 Continue。
- Hub 进程启动不把 leftover `online` 当成掉线，避免误杀 running。
- Plan 点击按 `kind` 配对到卡，不按乱码 prompt；Build 选项 id 由 hub 下发。
- 续聊 `outcome`、按 fleet 答 Ask；列表 SSE 不再带整段正文。
- Reload 失败尝试落盘，避免同一窗口反复叠 `Reload Window`。
- 中台重启后 leftover 在线机不当 `MACHINE_OFFLINE`。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.31.vsix` 再空闲 Reload。只 Reload 不会从 0.4.28 升上去。iOS 装 TestFlight **21**；Android **0.1.8**（versionCode 9）。

---

## 2026-09-20 — 扩展 0.4.29 · iOS TF 20 · Android 0.1.7

### 新增

- 架构债真机验收清单（Windows CDP 写入仍等双端点通，不改生产选择器）。

### 修复

- Ask Other 自由文本过 hub / App。
- 按 `generation_id` 重取消；Plan inspect 配对到卡。
- 手机 IME：SSE 快照不再重建输入框。

---

## 2026-09 — 更早里程碑（摘要）

| 面 / 号 | 记什么 |
| --- | --- |
| 扩展 0.4.22 | 工作区文件附件；Windows `@` 等 typeahead |
| 扩展 0.4.19 | 绑定扫描窗、续聊收口 |
| 扩展 0.4.18 | 全平台合成 jsonl stop；`status: success` → completed |
| 扩展 0.4.0 | 同窗并行第二条 |
| 桌面 0.1.0 | 创建/加入舰队、代装 vsix、CDP 打开工作区；包装版仍不自己拨中转 |
| iOS TF 1–19 | 中转遥控、Keychain token、前台 SSE、APNs、语音派发 |
| Android 0.1.0–0.1.6 | 与 iOS 操作员面 parity、FCM、分组列表与系统蓝 |

更早逐条提交见 `git log`。新发版不要往这张摘要表堆细节，写进上面带日期的版本节。
