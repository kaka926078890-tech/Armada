# Armada 架构债真机验收清单（0.4.29 / App 20）

- 日期：2026-09-20
- 状态：**操作员验收清单**（不是新功能设计。CDP 写路径未点通不得改生产选择器。）
- 父文档：[2026-09-19-armada-architecture-debt-design.md](./2026-09-19-armada-architecture-debt-design.md)
- 打包：中台 overlay `/Applications/Armada.app`；扩展 `armada-agent` **0.4.29**；iOS TestFlight **20**（营销号仍 0.1.0）；Android **0.1.7**（versionCode 8）
- HEAD 债落地：`0756f83` 及此前 P0–P1 提交；本文件随版本号提交。

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | 债已进 `master`，但 0.4.28 同号 vsix 不会 Reload；Windows CDP 写入、手机契约、attach toast 还没关门。 |
| 核心方案 | 升扩展 **0.4.29** 再 overlay；Windows Reload 后按本表点通；手机装新包对 snap 契约。 |
| 关键约束 | 7380 必须是 bundled bun。CDP **写**路径 Mac+Windows 都点通才算 P2-a。禁止把源码 hub attach 当成打包绿。 |
| 明确不做 | 不测手机发图（另文）；不在未点通时改 CDP 选择器；不把 §7.5 P3 塞进本轮验收。 |

**Windows 操作员先做：Cursor 空闲 → Reload Window → 看板机器扩展显示 0.4.29。**

---

## 1. 背景与需求

| # | 原始诉求 | 映射 |
| --- | --- | --- |
| R1 | Windows 配合测试 | 本文 §4 Windows 闸 |
| R2 | 要测的内容写进文档 | 本文件；债文档只加修订指针 |
| R3 | 手机要不要升版并出包 | 要。TF 19 / Android 0.1.6 之后还有 IME 修复 + Plan kind / title / cid / followup `outcome` / Other / 完成门禁 |

---

## 2. 版本闸（测功能前必须绿）

| 面 | 要看到 | 怎么确认 |
| --- | --- | --- |
| 中台 | `/Applications/Armada.app`，7380 进程 args 含 `Contents/Resources/bun` | `ps -ww -p "$(lsof -t -nP -iTCP:7380 -sTCP:LISTEN)" -o args=` |
| 扩展 | 在线机器 `extension_version=0.4.29` | 看板左侧机器行；落后会提示「需 0.4.29」 |
| Windows Cursor | Reload 后扩展号 0.4.29 | 该窗无 Armada live run 时 Reload；15 分钟仍忙则横幅「现在 Reload」 |
| iOS | TestFlight build **20** | 设置 → 关于 |
| Android | 0.1.7 | 关于页 / `adb shell dumpsys package app.armada.remote` |

0.4.28 即使「已安装」也不算过：20:12 那包没有后续 Ask 三态 / Plan kind 点击 / 卡内配对 / generation 重取消。

---

## 3. 已在 Mac 打包 hub 过的（Windows 不必重复，除非回归）

| ID | 项 | Mac 结果 2026-09-20 |
| --- | --- | --- |
| K7 | `POST /api/blobs?token=` 401；html GET `octet-stream` + `attachment` + `nosniff` | 过 |
| K7 | 导出审计走 Bearer，不把 token 放 URL | 过 |
| H10 | 本次 restore 为 **spawn**，无「非本应用启动」 | 场景正确；**attach 占用 7380 未测** |
| K3/K4 | Other 闸：卡片「待处理」、Ask A/B/C + Other 框、答完仍 `completed` | 过（并行闸） |

---

## 4. Windows 必须测（P2-a 可行性闸）

被控机：在线 `win32`（例如 PF39WTSM）。扩展 **0.4.29**。该 Cursor **两个 composer / 两个 Plan 卡同时在屏**。

| # | ID | 步骤 | 通过 | 失败样子 |
| --- | --- | --- | --- | --- |
| W1 | 版本 | Reload 后看板该机 0.4.29 | 无落后横幅 | 仍 0.4.28 / 需 0.4.29 |
| W2 | **B4** | 同一窗口两个 composer；中台对该 run **续聊回车** | 字只进 **该 cid** 的框 | 打进旁路框或第一个框 |
| W3 | **B5** | 两个 Ask/composer 在屏；中台点其中一个 Ask 选项 | 只点对的控件；错 cid 应 `CID_MISMATCH` 而不是点错 | 点了全页第一个按钮 |
| W4 | **P12** | 两张 Plan：卡1 已 Building、卡2 仍 Build；中台点 Build | 点的是**第二张活按钮** | inspect/点击落到卡1 |
| W5 | Ask Other | 一问三选项 + Other；中台只填 Other 提交 | 409 不再；被控收到自由文本 | `ASK_INVALID_OPTION` / 空 `option_ids` |
| W6 | K3 | 人为掐 CDP 或关调试口，Ask 仍在屏 | 中台卡保持 pending，不误 resolve | 探测失败立刻「已处理」 |

**Mac 用同一张表再走一遍 W2–W6**（本机已 overlay）。两台都过才许改生产 CDP 选择器。

不要在本轮改 `cdpInject` 选择器来「先绿」。点不通就记失败步骤 + 当时 DOM/jsonl。

---

## 5. 手机必须测（新包）

装 **iOS 20** 和 **Android 0.1.7**。中转仍是现网 relay；不要映射 7380。

| # | ID | 步骤 | 通过 |
| --- | --- | --- | --- |
| M1 | P2 | 列表标题 = hub `title`（无则 prompt） | 与看板同一条 |
| M2 | P2 | 无 `conversationId` 的终态 **不出现续聊** | 有 cid 才有输入框 |
| M3 | P7 | 运行中续聊 | 响应带 `outcome: queued` 或 `injected`，App **不要**用 HTTP 200/201 猜 |
| M4 | K4 | `kind=plan` 且 option id 不是 `build` | 仍是 Plan/Build 黄卡 |
| M5 | K4 | 普通 Ask 单选项 id=`build` | **不是** Plan 卡 |
| M6 | K5 | 多问 Ask | 没有「继续」 |
| M7 | Other | 与 W5 同一 run | App 也能走 Other 文本 |
| M8 | K1 | hub `completed` 且 `finalText` 空 | App 显示已完成 + 占位，**没有**假重试 |
| M9 | P5/H11 | 打开详情后内容未变 | 输入框不因 SSE 重建（尤其 iOS IME） |

发图 / `cmd.blobPut`：**不测**（`2026-09-19-armada-mobile-image-send-design.md`）。

---

## 6. 可选（不挡 P2-a）

| # | ID | 步骤 | 说明 |
| --- | --- | --- | --- |
| O1 | H10 | 先占 7380 再 overlay | toast 须含「非本应用启动」 |
| O2 | B8 | 运行中连点两次取消 | 归因到期望的 generation，不误伤下一折 |
| O3 | K6 | App 答错 option | 中文 409，不是 502 |

---

## 7. 操作员步骤（Windows）

1. 等中台 overlay 完成、看板不再提示扩展落后。
2. **关掉该 Windows 上所有 Armada 正在跑的 Composer 任务**（或等停），Reload Window。
3. 确认扩展 0.4.29。
4. 按 §4 W2→W6 做；每条记下：过 / 失败现象 / 窗口里几个 composer。
5. 把结果回中台操作员（本清单 ID 即可）。

Mac overlay 后也会 `when-idle` Reload；**正在跑的「真机测试」窗口会等到闲。**

---

## 8. 风险与未决

| ID | 风险 | 应对 |
| --- | --- | --- |
| R3 | 未点通就改 CDP 选择器 | 本清单失败则停，只收 DOM/jsonl |
| Win-reload | 窗口仍 busy，15 分钟不 Reload | 操作员点「现在 Reload」或停跑后再 Reload |
| TF | 账号/证书导致 build 20 传不上去 | IPA 仍在 `mobile/ios/build/export/`；改用本机安装并说明 |
| P3 | §7.5 其余项 | 不进本轮；另开 |

---

## 9. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-20 | 初稿。配合扩展 0.4.29、iOS 20、Android 0.1.7；Windows CDP 写路径 + 手机契约为必须项。 |
