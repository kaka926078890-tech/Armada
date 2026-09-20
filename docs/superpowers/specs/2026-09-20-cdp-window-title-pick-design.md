# CDP 选窗：标题模板切段 + sessionId 盖章

- 日期：2026-09-20
- 状态：**实施基准**（v1+v2 同轮落地）
- 范围：仅 `armada-agent` 扩展。Hub / relay / App 协议不变。
- 真机可行性：2026-09-20 Windows `PF39WTSM`，CDP 页 `SKILL.md - work - Cursor - Modified`（url `vscode-file://…/workbench/`）。`Runtime.evaluate` 对 `document.documentElement` 写入并读回自定义属性成功，随后已清除探测值。

---

## 0. TL;DR

| 项 | 内容 |
|---|---|
| 问题 | `pickCdpPage` 假定标题以 ` - Cursor` 结束。`activeEditorState` 把 `Untracked` / `Modified` 接到右侧，文件夹段对不上 → `WINDOW_TARGET_NOT_FOUND`。带图派发再被包装成 `IMAGE_PASTE_FAILED`。 |
| v1 | 按官方 `window.title` 模板切段：定位产品名 token，**只在它左侧**全等匹配工作区文件夹；右侧噪声丢弃。 |
| v2 | 连上工作区页后把 `vscode.env.sessionId` 盖到 `document.documentElement[data-armada-window-id]`。之后选页**先按盖章**，标题只做冷启动。 |
| 关键约束 | 禁止 `title.includes(folder)`；0 页 NOT_FOUND、>1 页 AMBIGUOUS；不改 composer DOM 选择器；Mac/Windows 同一函数。 |
| 明确不做 | git 状态词白名单；改 Hub 路由；v1 失败时连接全部 page 盲盖章。 |

---

## 1. 背景与需求

| # | 诉求 | 映射 | 验收 |
|---|---|---|---|
| R1 | 未跟踪/已修改文件打开时能派发 | v1 切段 | 标题 `… - work - Cursor - Untracked` / `Modified` → pick ok |
| R2 | 不再跟装饰文案打地鼠 | 不维护词表 | 单测 `1 problem` / `Conflict: Both Added` 同样绿 |
| R3 | 不误伤兄弟文件夹 | token 全等 | `armada-test-ws` 不命中 `armada` |
| R4 | 多窗口 fail-closed | >1 仍 AMBIGUOUS | 两页同 folder 或两页同 stamp → 不注入 |
| R5 | 标题再变仍能选页 | v2 盖章优先 | 盖章命中时即使标题无 folder 也 ok |
| R6 | 中台原因码不撒谎 | 贴图失败透传选页码 | `WINDOW_TARGET_NOT_FOUND` 不再变成 `IMAGE_PASTE_FAILED` |

活失败（2026-09-20）：

- 11:04 `… - Cursor - Untracked` → `WINDOW_TARGET_NOT_FOUND`
- 16:13 `r-5b855891` 续聊三次同上
- 16:14 `r-45cc545b` 带图 → 日志 `image paste failed: WINDOW_TARGET_NOT_FOUND`，Hub `end_reason=IMAGE_PASTE_FAILED`

---

## 2. 设计原则

1. 选窗认模板位置，不认装饰词。
2. 文件夹匹配仍是 token 全等。禁止 includes。
3. 一个函数、两个 OS。分隔符 ` - ` 与 ` — ` 都切。
4. 失败保持闭。不准「挑第一个 page」。
5. `windowId`（`vscode.env.sessionId`）是身份；标题只是冷启动线索。
6. 先红测后生产。测不红不准改 `cdpPage.ts` / `connectWorkspacePage`。

---

## 3. v1 标题切段

权威模板（VS Code `windowTitle.ts` / Cursor 1.128 同源）：

```text
${dirty}${activeEditorShort} - ${rootName} - [${profileName} -] ${appName} [- ${remoteName}] [- ${activeEditorState}]
```

规则（可测死）：

1. 去掉首段脏标记 `●` / `•`（可带随后空格）。
2. 按两侧有空格的 ` — ` / ` - ` 切段。文件名 `2026-09-20-foo.md` 不会被切开。
3. 从右找产品名序列（先匹配更长的）：
   - `Visual Studio Code`
   - `Code Insiders`（切段后 `Code` + `Insiders`）
   - `Code OSS`
   - `Cursor`
4. 产品名右侧全部丢掉。找不到产品名则退回「末段 == folder」（旧 Mac 无应用名）。
5. `before` = 产品名左侧各段：
   - `before` 最后一段 == folder → 命中（`file - work - Cursor`）
   - `before.length >= 3` 且倒数第二段 == folder → 命中（`file - work - Dev - Cursor`）
6. 禁止用第一段当 folder（避免文件名叫 `work` 的窗口误配工作区 `work`），**除非** `before` 只有一段（`work - Cursor`）。

不把 `Cursor Agents` 当产品名：整段标题无分隔符时是一个 token，不等于 `Cursor`。

### Mac vs Windows

| | macOS | Windows |
|---|---|---|
| 分隔符 | 常 ` — ` | 常 ` - ` |
| 产品名 | `Cursor` | `Cursor` |
| 装饰 | 同样可出现在产品名右侧 | 2026-09-20 真机 `Untracked` / `Modified` |
| 实现 | **同一** `titleMatchesWorkspace` | 同左 |

---

## 4. v2 sessionId 盖章

`/json/list` 没有 DOM 属性，不能只靠标题列表读 stamp。必须 CDP 连上再读/写。

属性：`document.documentElement` 的 `data-armada-window-id`  
值：`vscode.env.sessionId`（Hub 已有的 `windowId`）

`connectWorkspacePage(deps, workspaceRoot)`：

1. GET `/json`；失败 → `CDP_UNREACHABLE`。
2. **若 `deps.windowId` 非空**：对每个 `type===page` 且有 `webSocketDebuggerUrl` 的 target `connect`，`Runtime.evaluate` 读 stamp。
   - 恰好 1 个 page 的 stamp === `windowId` → 留着该 session 返回（标题不再参与）。
   - \>1 → 关掉已连 session，`WINDOW_TARGET_AMBIGUOUS`。
   - 0 → 关掉试连，进入步骤 3。读失败的 page 当未盖章，不据此 AMBIGUOUS。
3. **v1** `pickCdpPage(targets, workspaceRoot)`。失败则原样返回（冷启动标题仍脏且从未盖章过 → 仍 NOT_FOUND，这是预期：v2 不能在没连上过的窗口上凭空盖章）。
4. `connect` 中选页；若 `windowId` 非空则写入 stamp（写失败只打日志，不把已经 title 命中的连接打成失败）。
5. 返回 session。

`windowId` 缺省时行为与改前相同（现有单测 eval 次数不变）。

### 鸡生蛋

Reload 后 DOM 盖章消失。下一次派发靠 v1 冷启动，成功后再盖章。因此 **v1 必须同轮落地**，否则当前 `Modified` 标题永远进不了 v2。

禁止：标题失败后对所有 page 盲写 stamp（会盖到 Cursor Agents 副窗）。

真机已证：workbench 页可写可读自定义属性；探测值已从本机 DOM 清除。

---

## 5. 数据 / 接口

`pickCdpPage(targets, workspaceRoot)` 对外契约不变。

```ts
pickCdpPage → { ok: true, wsUrl } | { ok: false, reason: "WINDOW_TARGET_NOT_FOUND" | "WINDOW_TARGET_AMBIGUOUS" | "NO_WS_URL" }
```

`CdpSubmitterDeps` 增加可选 `windowId?: string`。

`extension.ts` 把 `vscode.env.sessionId` 传给 `createCdpSubmitter` / `createImagePaster` / `createFileMentionPaster` / `createComposerFinisher` / `createAskQuestionDriver`（共用一份 deps）。

贴图 / 文件提及：`autoSubmitImages`（及文件路径）改为透传 `{ ok, reason }`，与 `autoSubmit` 一样。选页失败时 ack 必须是 `WINDOW_TARGET_*` / `NO_WS_URL` / `CDP_*`，不得改写成 `IMAGE_PASTE_FAILED`。真正贴图失败（芯片数不够等）仍用 `IMAGE_PASTE_FAILED` 或现有 `CHIP_COUNT:*`。

错误码不新增。

---

## 6. 运行时链路

```text
Hub 已按 windowId+workspace 路由到本扩展
  → Executor autoSubmit / image paste / ask
  → connectWorkspacePage
       stamp 命中？ → 该页
       否则 pickCdpPage(v1 切段) → 该页并盖章
  → 现有 composer 写入（选择器不动）
```

缓存：无。每次注入现拉 `/json/list`。stamp 扫描页数通常 1（本机 2026-09-20 只有 workbench 一页）。

回滚：只回滚扩展 vsix；Hub 不用配。Windows **先装 vsix 再空闲 Reload**。

---

## 7. 安全

| 威胁 | 缓解 |
|---|---|
| 兄弟目录 includes | token 全等 + 不用第一段当 folder |
| 盖章写到 Agents 副窗 | 只在 v1 命中或 stamp 已匹配的 page 上写 |
| 扫全部 CDP 页 | 仍只连 127.0.0.1；读 stamp 失败当未盖章 |
| stamp 值进日志 | 不要把完整标题原文强制打进 Armada.log（现网已只打 reason） |

---

## 8. 实施

跨仓：只发 **armada-agent 0.4.33**。`REQUIRED_EXTENSION_VERSION` 与 `extension/package.json` / `EXTENSION_VERSION` 对齐。iOS/Android/桌面号不变。

| 阶段 | 内容 | 验收 |
|---|---|---|
| v1 | `cdpPage.ts` + `cdpPage.test.ts` | 下表夹具全绿 |
| v2 | `connectWorkspacePage` 先 stamp 后 title；`windowId` 从 extension 传入 | cdpInject 单测：脏标题+stamp 命中 ok；无 stamp 脏标题走 v1；两 stamp AMBIGUOUS |
| 观测 | executor 透传选页 reason | 带图 `WINDOW_TARGET_NOT_FOUND` 不再变 `IMAGE_PASTE_FAILED` |
| 发版 | 0.4.33 + README/CHANGELOG | `boardState` 的 required === pkg.version |

### v1 单测夹具（先红）

- `…md - work - Cursor - Untracked` + `C:\Users\PC\Desktop\work`
- `SKILL.md - work - Cursor - Modified`
- `… - work - Cursor - 1 problem` / `… - Conflict: Both Added`
- `file — work — Cursor`（Mac）
- `file - work - Dev - Cursor`（Profile）
- 反例：兄弟文件夹、`Cursor Agents`、`work - other - Cursor`（文件名 work）、无匹配、两页 AMBIGUOUS
- 回归：`logo.png - work - Cursor` 仍命中；`hello.txt — armada-test-ws` 仍命中

### v2 单测夹具（先红）

- `windowId` 缺省：现有 createCdpSubmitter 测例 eval 次数/connect 次数不变
- 脏标题 + 某页 stamp === windowId → 连该页，即使 title 匹配会 NOT_FOUND
- 脏标题 + 无 stamp + v1 切段能命中 → connect 后有一次 stamp 写入 eval
- 两个 page 盖了同一 windowId → AMBIGUOUS
- 无 windowId、标题 `Untracked`：在 v1 落地后应 ok（切段），不是 stamp

---

## 9. 风险

| 风险 | 应对 | 状态 |
|---|---|---|
| Cursor 把 state 插到产品名左侧 | v1 冷启动会偏；已盖章的窗口仍走 v2 | 未发生 |
| Reload 清 DOM | 下一次靠 v1 | 已知，故 v1 必做 |
| 只 Reload 没装 vsix | 操作员步骤写死先装 0.4.33 | 已踩过 |
| Profile 名等于别的文件夹 | 单窗仍对；两窗 AMBIGUOUS | 可接受 |

---

## 10. 修订记录

| 日期 | 内容 |
|---|---|
| 2026-09-20 | 初稿。v1 切段 + v2 盖章同轮。Windows 真机 stamp 读写已证。 |
