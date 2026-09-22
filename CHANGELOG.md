# Changelog

Armada 按 **面** 发版：扩展、桌面、iOS、Android 可以不同号。README 顶部「当前版本」表只反映此刻要装的号；本文件按日期记下每个号修了什么、新了什么。

格式：[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本号来源见 skill `armada-release-docs`。

未打新号就合进 `master` 的改动先写在 **Unreleased**；下次升号时整段搬进对应版本。

---

## Unreleased

### 修复

- macOS / Linux 安装扩展时直接解包到 `~/.cursor/extensions`，并改写 `extensions.json`。不再调用 `cursor --install-extension`（8 秒超时，失败被丢掉，空闲 Reload 一直看到旧目录）。

---

## 2026-09-22 — 扩展 0.4.44 · iOS TF 30 · Android 0.1.13 · 桌面 0.1.0

### 新增

- 中台任务详情和手机详情可以点开回复里的 md/txt 等文本链接，以及中台「已编辑」文件，直接读被控工作区内容。需 **armada-agent 0.4.44**。手机源码已在仓库里；当前 TestFlight **30** / Android **0.1.13** 还没有这个入口。
- 中台设置里可以「全部已读」（含已隐藏卡片）。免打扰只把未读红点改成灰点；已完成未读仍是绿点。这是看板改动，不另开扩展号，跟 **0.4.44** 同一次 overlay。

### 操作员注意

装扩展 **0.4.44**。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.44` 的包装 hub；只装 vsix、看板仍是 0.4.43 时，空闲 Reload 不会升级。桌面仍是 **0.1.0**；iOS TestFlight **30**；Android **0.1.13**。

---

## 2026-09-22 — 扩展 0.4.43 · iOS TF 30 · Android 0.1.13 · 桌面 0.1.0

### 新增

- 中台派发/续聊选中的 PNG/JPEG 显示 Cursor 式 56px 圆角缩略图，点开可看大图；详情用户气泡同样出缩略图（blob 走 Header 鉴权，不把 token 写进图片 URL）。

### 修复

- 带图派发时，旁边若有一个只挂了文件引用的输入框，图片会贴进空框，计数却去数文件框，任务以 `CHIP_COUNT` 失败、正文不会提交。现在贴图、计数和回车使用同一个输入框。
- 同工作区再派一条新任务：回到原先 Desk 里的 `composer.createNew`。已打开的窗不再 `duplicateWorkspaceInNewWindow` 出 `Untitled (Workspace)`（16:28 v4），也不再因此整卡排队。注入槽仍串行；未答 Ask 仍占窗。续聊仍跟 Cursor 的 steer/queue。
- 扩展收到 `run.openWindow` 时，本窗已经打开该文件夹则直接返回，不再复制窗口。CDP 不再把 `Untitled (Workspace)` 当成注入目标。选窗也不再挑已经打开该文件夹的那一扇。

### 操作员注意

装扩展 **0.4.43**。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.43` 的包装 hub；只装 vsix、看板仍是旧号时，空闲 Reload 不会升级。桌面仍是 **0.1.0**；iOS TestFlight **30**；Android **0.1.13**。

---

## 2026-09-21 — 扩展 0.4.42 · iOS TF 30 · Android 0.1.13 · 桌面 0.1.0

### 修复

- 仓页五列标签旁不再多一个「本列已读」胶囊。一键已读只留舰队页：机器名右侧、工作区左滑。

### 操作员注意

装 iOS TestFlight **30**。TF **29** 仓页仍会在五列旁出现「本列已读」。扩展仍是 **0.4.42**；Android 仍是 **0.1.13**；桌面仍是 **0.1.0**。

---

## 2026-09-21 — 扩展 0.4.42 · iOS TF 29 · Android 0.1.13 · 桌面 0.1.0

### 修复

- 舰队页有未读的工作区仍用红点标出；「全部已读」旁不再叠数字角标。

### 操作员注意

装 iOS TestFlight **29**。TF **28** 去掉了数字，但工作区行没有红点。扩展仍是 **0.4.42**；Android 仍是 **0.1.13**；桌面仍是 **0.1.0**。

---

## 2026-09-21 — 扩展 0.4.42 · iOS TF 28 · Android 0.1.13 · 桌面 0.1.0

### 修复

- 舰队页不再在「全部已读」和工作区行旁叠红色数字角标，只留一个全部已读按钮。

### 操作员注意

装 iOS TestFlight **28**。TF **27** 舰队页仍会显示红色未读数字。扩展仍是 **0.4.42**；Android 仍是 **0.1.13**；桌面仍是 **0.1.0**。

---

## 2026-09-21 — 扩展 0.4.42 · iOS TF 27 · Android 0.1.13 · 桌面 0.1.0

### 修复

- 同仓再开一扇窗仍走 `duplicateWorkspaceInNewWindow`，不改 Cursor 启动方式、也不重开 `.code-workspace`。duplicate 出来的标题是 `Untitled (Workspace)`（16:09 v2 真机 `/json`），CDP 给这一页盖章再注入，不再 `WINDOW_TARGET_NOT_FOUND`。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.42.vsix` 再 Reload。只空闲、只点 Reload，本地没有这个包不会升级。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.42` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **27**；Android **0.1.13**。

---

## 2026-09-21 — 扩展 0.4.41 · iOS TF 27 · Android 0.1.13 · 桌面 0.1.0

### 修复

- 空闲 Reload 的磁盘闩按窗口记：finclip 先 Reload 不再把 desk 那扇还在跑的窗一并闩死（任务收口后等了三分钟也不升）。旧文件没有 `windowIds` 时仍当整机闩，避免 10 秒连刷。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.41.vsix` 再 Reload。只空闲、只点 Reload，本地没有这个包不会升级。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.41` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **27**；Android **0.1.13**。

---

## 2026-09-21 — 扩展 0.4.40 · iOS TF 27 · Android 0.1.13 · 桌面 0.1.0

### 修复

- 同机并排第二条新任务：peer 窗用 `cursor --new-window` 打开以文件夹命名的 `.code-workspace`（标题 `desk (Workspace)`），不再 `openFolder` 已经打开的目录（Cursor 会复用原窗，新窗从不 register）。
- 两扇同仓窗时 CDP 不再把注入打进已盖章的忙碌窗（本机「测试：你好v1 / 测试你好：v2」进了正在跑的 desk 对话，新窗 `BIND_TIMEOUT`）。只给未盖章的那一页盖章。
- `run.openWindow` 发给已是 0.4.40 的窗，不再发给仍是 0.4.38、正在跑任务因而没 Reload 的忙碌窗。
- overlay / hub 重启时，先连上的 sibling 窗不再把其它工作区的排队卡打成 `WORKSPACE_NOT_OPEN`（15:23 v1/v2 进异常）。只有本进程已经见过该工作区、随后从心跳并集里消失，才算关仓。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.40.vsix` 再 Reload。只空闲、只点 Reload，本地没有这个包不会升级。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.40` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **27**；Android **0.1.13**。

---

## 2026-09-21 — 扩展 0.4.39 · iOS TF 27 · Android 0.1.13 · 桌面 0.1.0

### 修复

- Windows 同工作区第二条新任务不再假排队：忙碌窗改走 Cursor 的 `duplicateWorkspaceInNewWindow`，不再 `openFolder` 同一个已打开目录（Windows 会复用原窗，新窗从不 register，`r-d4aa8dc3` 一直停在排队中）。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.39.vsix` 再 Reload。只空闲、只点 Reload，本地没有这个包不会升级。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.39` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **27**；Android **0.1.13**。

---

## 2026-09-21 — 扩展 0.4.38 · iOS TF 27 · Android 0.1.13 · 桌面 0.1.0

### 新增

- App 舰队页可按机器或工作区一键全部已读；仓内当前列（已完成、异常等）可「本列已读」，不必逐条点开。

### 操作员注意

装 iOS TestFlight **27**（或 Android **0.1.13**）。TF **26** / Android **0.1.12** 没有一键已读。扩展仍是 **0.4.38**；桌面仍是 **0.1.0**。

---

## 2026-09-21 — 扩展 0.4.38 · iOS TF 26 · Android 0.1.12 · 桌面 0.1.0

### 修复

- 同工作区再派一条新任务：不再在忙碌窗 `createNew`（Windows `r-a7cce90d` 会换掉当前对话），也不再整卡等到上一条跑完。中台让已有窗 `vscode.openFolder` 开新窗，新窗 register 后注入；注入槽空了就可以并发。续聊仍跟 Cursor 的 steer/queue。
- 注入前探 9222：闪断重试三次，减少 Windows 续聊被打成 `CDP_NOT_READY`。心跳探口仍是一次。
- 包装桌面时 `hub/web` 构建目标改为 es2022，避免 esbuild 在默认 chrome87 下无法降级 shadcn 大段解构（Windows `tauri build`）。
- overlay 不再用 ad-hoc 签名。TCC「允许访问桌面」跟证书走，点一次之后覆盖安装不再当新 App 重弹；那个系统框没法无人值守代点。第一次从 ad-hoc 换到开发证书仍要点一次。
- 某一机的单机 Reload leftover 不再把其它落后机器的「现在 / 空闲 Reload」按钮藏掉。执行仍只打那一台；看板按钮按机是否落后独立画。中台须 overlay 这份 hub，不必升 vsix。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.38.vsix` 再 Reload。只空闲、只点 Reload，本地没有这个包不会升级。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.38` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **26**；Android **0.1.12**。

---

## 2026-09-21 — 扩展 0.4.37 · iOS TF 26 · Android 0.1.12 · 桌面 0.1.0

### 修复

- 上一轮没写完 `turn_ended` 的子代理 jsonl 不再把续发后的卡永远闩在 loading。BG_DRAIN 只计本轮 child；120s 仍开着则重放 completed（`r-b770619c`）。
- Windows 贴图：剪贴板 15s 超时会杀掉卡住的 PowerShell 再拉起，并把 `CLIPBOARD_TIMEOUT` / `CHIP_COUNT:*` 透传到看板，不再一律改写成 `IMAGE_PASTE_FAILED`。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.37.vsix` 再 Reload。只空闲、只点 Reload，本地没有这个号也不会升级。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.37` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **26**；Android **0.1.12**。

---

## 2026-09-21 — 扩展 0.4.36 · iOS TF 26 · Android 0.1.12 · 桌面 0.1.0

### 修复

- 公网 uuWAF 会把大约 10KiB 以上的 JSON 打成 HTML 500。派发 / 续发长提示词改成和发图一样的 6KiB JSON 分片，中转拼好再一次 `cmd.dispatch` / `cmd.followup`。iOS 不再把长任务误报成 HTTP 500。

### 操作员注意

装 iOS TestFlight **26**（或 Android **0.1.12**）。TF **25** 仍会把长任务一次 POST，被 WAF 打成 500。扩展仍是 **0.4.36**；桌面仍是 **0.1.0**。公网中转须先于 App 装上这版分片协议。

---

## 2026-09-20 — 扩展 0.4.36 · iOS TF 25 · Android 0.1.11 · 桌面 0.1.0

### 修复

- TestFlight 锁屏通知：Rel-M6 把 `sandboxReceipt` 误当成 APNs sandbox，token 打到 `api.sandbox.push.apple.com` 全部失败。Release 仍登记 production；中转对误标 sandbox 的 token 先打生产主机。

### 操作员注意

装 iOS TestFlight **25**。24 仍会把 device token 报成 sandbox。扩展仍是 **0.4.36**；Android **0.1.11**；桌面 **0.1.0**。

---

## 2026-09-20 — 扩展 0.4.36 · iOS TF 24 · Android 0.1.11 · 桌面 0.1.0

### 修复

- 本机 `~/.cursor/extensions` 还没有 pending 那个 vsix 时，空闲（以及「现在 Reload」）都判定 `missing` / `need-pack`，不再因为窗口空闲就 Reload Window。中台旁有包不够：没装包的 Windows / Intel 不会被 when-idle 白闪成死循环。
- 机器已经跑着 pending 号时，hub 注册不再重推 `ext.cursorReload`。

### 操作员注意

Windows 被控须 **先装** `armada-agent-0.4.36.vsix` 再 Reload。只空闲、只点 Reload，本地没有这个号也不会升级。中台须 overlay 到含 `REQUIRED_EXTENSION_VERSION=0.4.36` 的包装 hub。桌面仍是 **0.1.0**；iOS TestFlight **24**；Android **0.1.11**。

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
