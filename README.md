# Armada

局域网 Cursor **舰队指挥台**：一台中台机调度多台被控 Cursor 窗口的派发、监控与取消。任务在被控机真实 IDE 对话里跑，用该机自己的 Cursor 登录态。

发送通道默认 **CDP 全自动**（Cursor 须用 `scripts/armada-cursor.sh` 或 Windows 上的 `armada-cursor.ps1` 启动）。未走该启动器时降级为剪贴板预填 + 本机回车。

## 架构

```text
┌─────────────┐   REST/SSE    ┌──────────────────┐
│  hub/web    │◄─────────────►│   armada-hub     │
│  控制台 UI  │               │  (Hono + SQLite) │
└─────────────┘               └────────┬─────────┘
                                       │ WS /ws?token=
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
            │  extension   │   │  extension   │   │  extension   │
            │ Cursor 插件  │   │              │   │              │
            └──────┬───────┘   └──────────────┘   └──────────────┘
                   │ spool JSON
                   ▼
            ┌──────────────┐
            │    hooks     │  ~/.cursor/hooks → .sh (macOS) / .exe (Windows)
            │  Cursor 钩子 │
            └──────────────┘
```

| 组件 | 路径 | 职责 |
| --- | --- | --- |
| **hub** | `hub/` | 鉴权、机器注册、run 状态机、事件 ingest、审计、静态托管控制台 |
| **extension** | `extension/` | Cursor 侧 WS 客户端：注册/心跳、注入 prompt、绑定 conversation、上报事件 |
| **hooks** | `hooks/` | 把 Cursor hook 事件落盘到 spool，供扩展轮询上报 |
| **web** | `hub/web/` | 中台控制台：机器树、五列看板、run 详情、SSE 实时刷新 |

## 中台端 vs 受控端

全网只跑 **一套 hub**。中台机也可以同时当受控（本机 Cursor 窗口会注册上来）。当前范围：**中台建议 macOS**；受控端 **macOS + Windows**。不要在 Windows 上另起一份 hub。

| | **中台端**（调度） | **受控端**（干活） |
| --- | --- | --- |
| 仓库 | 要，用来跑 hub | **可以 clone 本仓**，只用来装 hooks / 扩展 / 启动器 |
| Bun | **要** | 不要（除非你想在受控端自己打 vsix） |
| 启动 hub | **必须**，且加 `--lan` | **禁止**再起一份 |
| 令牌 | 权威在 `~/.armada/token`，只在这里生成 | **抄中台这份**，不要在受控端生成 |
| 入站端口 | 放行 **TCP 7380** | 不需要入站；只要能出站连中台 |
| Cursor | 可选（本机也受控才要） | **必须**已安装并登录（用这台机自己的账号） |
| 扩展 + hooks | 本机当受控时才装 | **必须** |
| 日常操作 | 浏览器打开控制台、派发 / 取消 / 续聊 | 保持目标工作区窗口开着；CDP 失败时回车 |

**中台端不要做：** 把 `hubUrl` 配成受控机 IP；在受控端另起 hub。  
**受控端不要做：** `bun run hub/src/index.ts`；`hubUrl` 填 `127.0.0.1` 或加 `http://`；用图标点开 Cursor 还指望全自动提交。

下面命令里的 `192.168.1.10` 请换成中台机局域网 IP（`ipconfig getifaddr en0`）。

## 中台端要处理的

只做一次（或改完 launchd 后重启一次）。

1. **装依赖并构建控制台**

```bash
cd /path/to/armada
bun install
cd hub/web && bun run build && cd ../..
```

2. **对局域网启动 hub**（绑 `127.0.0.1` 时受控端连不上）

```bash
bun run hub/src/index.ts --lan
# 日志: armada-hub listening on http://0.0.0.0:7380
```

若用 launchd（`~/Library/LaunchAgents/com.armada.hub.plist`），在 `ProgramArguments` 末尾加 `<string>--lan</string>`，然后：

```bash
launchctl kickstart -k gui/$(id -u)/com.armada.hub
lsof -nP -iTCP:7380 -sTCP:LISTEN    # 必须是 *:7380 或 0.0.0.0，不能是 127.0.0.1
```

3. **防火墙**允许本机 **入站 TCP 7380**（系统设置 → 网络 → 防火墙 → 允许 bun / 终端）。

4. **记下 IP 与令牌**（发给受控端配置用；令牌不要换行、不要在受控端重造）

```bash
ipconfig getifaddr en0
cat ~/.armada/token
```

5. **扩展包**（二选一）  
   - 受控端 clone 本仓后自己 `npx tsup && npx vsce package`；或  
   - 中台打一次，把 `extension/armada-agent-*.vsix` 拷过去（Windows 受控请用 ≥ 0.4.3，绑定依赖 native spooler；**不必**为这个绑定问题升级中台 hub）：

```bash
cd extension
npx tsup
npx vsce package --no-dependencies    # 没有 vsce：npm i -g @vscode/vsce
```

6. **日常：打开控制台派发**（任意电脑浏览器均可，同一令牌）

- 打开 `http://<中台IP>:7380`，粘贴中台令牌。
- 左侧应出现受控端主机名（绿点）和已开工作区。
- **+ 派发任务** → 选机器 + 工作区 + prompt。CDP 正常时无需人在受控端回车。
- 详情里看思考 / 工具 / 回复；「续聊同一对话」走同一 `conversation_id`。
- 取消：中台点取消；受控端 Cursor 若仍要确认，在那台点一下。
- 同一机器可多条 `running`（默认每机 8、每工作区 4）。**整机同时只有 1 条处于派发/绑定**（CDP 注入串行）。超出限额 → `429 RUN_LIMIT`。同工作区相同 prompt → `409 PROMPT_COLLISION`。关着的工作区不能派（`400 WORKSPACE_NOT_OPEN`）。扩展需 ≥ 0.4.0 才能同一窗口并行第二条。

## 受控端要处理的

可以 **clone 本仓**，不必拷零散文件。Clone 之后 **不要启动 hub**。

```bash
git clone https://github.com/kaka926078890-tech/Armada.git
cd Armada
```

### macOS

1. **先探活中台**（失败先修网络，再装扩展）

```bash
curl -sS http://192.168.1.10:7380/api/health
# 期望: {"ok":true,"name":"armada-hub"}
```

2. **Cursor 已登录**（这台电脑自己的账号；中台不代登）。

3. **安装 hooks**（merge 进 `~/.cursor/hooks.json`，不覆盖别人的条目）

```bash
sh hooks/install.sh
```

4. **安装扩展** `armada-agent` ≥ 0.4.8（macOS 用 ≥ 0.4.0 即可；Windows 绑定必须 ≥ 0.4.8）  
   Cursor → 扩展 → **Install from VSIX** → `extension/armada-agent-*.vsix`  
   （没有现成 vsix 且这台有 Node 时：`cd extension && npx tsup && npx vsce package --no-dependencies`）

5. **指向中台**（`Cmd+Shift+P` → **Armada: Configure Hub Connection**）

| 项 | 填 | 不要填 |
| --- | --- | --- |
| hub | `192.168.1.10:7380` | `http://`、`https://`、`127.0.0.1` |
| token | **中台端** `~/.armada/token` 原文 | 在受控端跑 hub 新生成的 |

保存后必须 **Reload Window**。输出面板选 **Armada**，应看到 `config loaded, hub=192.168.1.10:7380`。

6. **用启动器打开要派发的工作区**（否则任务停在「待本机回车」）

```bash
# 先 Cmd+Q 完全退出 Cursor（所有窗口、对话框）
chmod +x scripts/armada-cursor.sh
./scripts/armada-cursor.sh /绝对路径/你的工作区
```

约束：中台只能派到 **已经打开且扩展已上报** 的窗口；路径用绝对路径（不要 `~/proj`）；推理走 Cursor 云，受控端要能上网。

### Windows（第一次安装 + 每天怎么开）

中台仍跑在 Mac（或已有 hub 那台机）。这台 Windows **只当受控**：不要 `bun run hub`，不要在本机生成新 token，不要从开始菜单/桌面图标打开 Cursor 做派发。

**先拿到这三样，再往下敲命令：**

| 要带上 Windows 的 | 从哪来 | 说明 |
| --- | --- | --- |
| 本仓库 | `git clone` 本仓，或把整个 `Armada` 文件夹拷过去 | 用来跑 `hooks\install.ps1` 和启动器 |
| `armada-agent-0.4.8.vsix` | 中台 `extension\armada-agent-0.4.8.vsix`，或 Windows 自己 `npm install && npx tsup && npx --yes @vscode/vsce package --no-dependencies`（必须 ≥ 0.4.8） | 0.4.7 能扫 transcript 绑定，但完成仍等 `stop` hook，Windows 上会一直「运行中」。0.4.8 用 `turn_ended` 合成 stop。**升级中台 hub 解决不了这个问题** |
| 中台 IP + token | 中台 `ipconfig getifaddr en0` 和 `~/.armada/token` | token 不要换行；不要在 Windows 上新生成 |

下面把 `192.168.1.10` 换成你的中台局域网 IP。所有命令都在 **PowerShell** 里执行，先 `cd` 到仓库根目录（里面能看到 `hooks` 和 `scripts` 文件夹）。

#### 第一次安装（做完一次即可）

**1. 探活中台**（失败先修网络，再装东西）

```powershell
curl.exe -sS http://192.168.1.10:7380/api/health
# 期望打印: {"ok":true,"name":"armada-hub"}
```

不通：中台是否 `--lan`、Mac 防火墙是否放行 7380、是否同一 Wi-Fi。Windows **不需要**入站端口。

**2. 确认 Cursor 已安装并已登录**（用这台 Windows 自己的账号；中台不代登）。

**3. 卸掉旧 Armada hooks**（写入 `%USERPROFILE%\.cursor\hooks.json`，只删 `armada-spool*`，不覆盖别人的条目）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File hooks\install.ps1
# 期望打印: stripped N Armada hook command(s)...
# 0.4.7 起 Windows 绑定不再走 hook（Cursor 每次新拉 PowerShell，5s 内完不成）
```

**4. 安装扩展**

1. 先用图标正常打开一次 Cursor（这次还不用启动器）。
2. 左侧扩展 → `...` → **Install from VSIX** → 选中 `armada-agent-0.4.8.vsix`。
3. 装完先不要关。

**5. 指向中台**（`Ctrl+Shift+P` → 输入 `Armada: Configure Hub Connection`）

| 项 | 填这个 | 不要填 |
| --- | --- | --- |
| hub | `192.168.1.10:7380` | `http://`、`https://`、`127.0.0.1`、本机 IP |
| token | 中台 `~/.armada/token` **原文** | 在 Windows 上跑 hub 新生成的 |

保存后：**Developer: Reload Window**。  
`View` → **Output** → 下拉选 **Armada**，应看到 `config loaded, hub=192.168.1.10:7380`。没有这行 = 没配上，不要继续。

#### 每天派发前：必须用启动器开 Cursor

图标/开始菜单打开的 Cursor **没有**调试端口，中台派发会停在「待本机回车」。

1. **完全退出** Cursor：右下角托盘（^ 里）找到 Cursor 图标 → 右键 **Exit / 退出**。任务栏和托盘都不要还留着。
2. 用启动器打开**要派发的工作区**（路径必须是 Windows 绝对路径，例如 `C:\Users\me\proj`，不要 `~\proj`）：

```powershell
cd <你的 Armada 仓库根目录>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\armada-cursor.ps1 C:\绝对路径\你的工作区
```

成功时会打印 Cursor 路径、CDP 端口、工作区。若提示「正在运行」，按上面第 1 步再退一次。

3. 等扩展连上（约 15 秒）。中台控制台左侧应出现这台 Windows 主机名（绿点）和刚才那个工作区路径。之后即可派发。

**不要做：** 启动器开起来之后，再双击图标开第二个 Cursor（单实例会把 CDP 参数吞掉）。换工作区 = 再退干净，再用启动器带新路径启动。

## 两端一起验收

- [ ] 受控端 `curl` health 成功
- [ ] 中台控制台看到该机在线 + 目标工作区
- [ ] 派发后 30s 内进入运行中或已完成，详情不是别的窗口的对话
- [ ] 受控端 IDE 里出现对应新对话，文件按 prompt 改了

## 接入故障

| 现象 | 先查哪一端 |
| --- | --- |
| health 都 curl 不通 | **中台**：是否 `--lan`、防火墙、是否同网段 |
| 控制台没有这台机器 | **受控**：是否 Reload；`hubUrl` 是否写成 `127.0.0.1`；输出面板 Armada |
| `WORKSPACE_NOT_OPEN` | **受控**：启动器打开该路径；等心跳约 15s |
| `RUN_LIMIT` | **中台**：该机或该工作区已达并行上限，等一条结束或取消排队 |
| `PROMPT_COLLISION` | **中台**：同工作区已有相同 prompt 在跑或排队，改文案后再派 |
| `CONVERSATION_BUSY` | **中台**：该对话仍在运行，结束后才能续聊 |
| `INJECT_SLOT_BUSY` | **中台**：正在向该机注入另一条任务，稍后再续聊 |
| `WINDOW_BUSY` | **受控**：扩展 < 0.4.0 或关闭了同窗并行 |
| 一直「待本机回车」但黄字是「绑定中」 | **受控**：Windows 须装 **armada-agent ≥ 0.4.8** 并 Reload。绑定扫 `agent-transcripts`，结束行 `turn_ended` 会合成 `stop`。Reload 后 `hooks.json` 里不应再有 `armada-spool`。日志：`run.bound ... via=transcript`，对话结束后 `stop synthesized`。**不要为此升级中台 hub** |
| 一直「待本机回车」且蓝字是「已预填,待本机回车」 | **受控**：Cursor 不是启动器拉起的（Windows：托盘未退干净就又点了图标） |
| 详情串了别的对话 | **受控**：扩展 ≥ 0.4.3，不要用旧 vsix |
| Windows 启动器报「正在运行」 | **受控**：托盘 `^` 里 Cursor 右键退出，不是只关窗口 |

## 发送通道

| 动作 | 中台端 | 受控端 |
| --- | --- | --- |
| 新任务 | `run.start` → 新对话 + CDP 注入并模拟 Enter | 用 `armada-cursor.sh` / `.ps1` 开着目标工作区。CDP 失败则变剪贴板，需 **回车** |
| 取消 | `run.cancel`，扩展尝试 `cancelChat` | 若 UI 仍要确认则点一下 |
| 续聊 | `POST /api/runs/:id/followup` 注入同一对话 | CDP 失败时同样要回车 |

没有 desktopBridge；不能远程打开未开的工作区（v1.5 候选）。

## 配置项

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `ARMADA_HUB_HOME` | 环境变量 | hub 数据目录；默认 `~/.armada`（含 `token`、SQLite） |
| 端口 | hub 启动参数 | 默认 `7380`；E2E/测试可用 `port: 0` |
| `--lan` | CLI | 监听 `0.0.0.0`，否则 `127.0.0.1` |
| 令牌文件 | `$ARMADA_HUB_HOME/token` | 首次启动自动生成 64 位 hex；`chmod 600` |
| `armada.hubUrl` | Cursor 设置 / 配置命令 | 形如 `192.168.1.10:7380`（无协议前缀） |
| `armada.token` | Cursor 设置 / 配置命令 | 与 hub 令牌一致 |
| `armada.cdpPort` | Cursor 设置 | 默认 `9222`，须与 `armada-cursor.sh` / `.ps1` 一致 |
| `armada.autoSubmit` | Cursor 设置 | 默认 `true`；`false` 则只预填、等人回车 |
| `ARMADA_HUB_URL` / `ARMADA_HUB_TOKEN` | 环境变量（扩展） | 仅当对应 Cursor 设置项（`armada.hubUrl` / `armada.token`）为空时回退；设置项非空优先（见 `extension/src/config.ts`） |
| `ARMADA_MAX_RUNS_PER_MACHINE` | 环境变量 | 每机占用中任务上限，默认 8（含 queued） |
| `ARMADA_MAX_RUNS_PER_WORKSPACE` | 环境变量 | 每工作区上限，默认 4 |
| `ARMADA_MULTI_RUN_PER_WINDOW` | 环境变量 | `0` 关闭同窗并行（U1 探针失败时用） |

## 协议摘要

### WebSocket（`/ws?token=...`）

Token **仅** query 鉴权；消息体不再带 token。连上后 10s 内必须 `register`。

| 方向 | `type` | 说明 |
| --- | --- | --- |
| Ext → Hub | `register` | 机器/窗口/工作区 |
| Hub → Ext | `registered` | 注册成功 |
| Ext → Hub | `heartbeat` | 刷新 `last_seen` / 工作区 |
| Hub → Ext | `run.start` / `run.followup` | 派发 / 续聊 |
| Ext → Hub | `run.ack` | accepted / rejected |
| Ext → Hub | `run.bound` | conversationId + promptMatch |
| Ext → Hub | `run.event` | hook / transcript 事件（带 `seq`） |
| Hub → Ext | `event.ack` | `{ machineId, lastSeq }` |
| Hub → Ext | `run.cancel` | 取消请求 |
| Ext → Hub | `run.note` / `hooks.status` | 备注 / hooks 健康 |

### REST（均需 `Authorization: Bearer <token>` 或 `?token=`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（无需令牌） |
| GET | `/api/machines` | 机器列表 |
| POST | `/api/runs` | 派发新 run |
| GET | `/api/runs` | 列表（`status` / `machineId` 过滤） |
| GET | `/api/runs/:id` | 详情 |
| POST | `/api/runs/:id/cancel` | 请求取消 |
| POST | `/api/runs/:id/followup` | 续聊 |
| POST | `/api/runs/:id/close` | 关闭 `error`/`unknown` → `cancelled` |
| GET | `/api/runs/:id/events` | 事件（`afterSeq` / `limit`） |
| GET | `/api/runs/:id/stream` | 单 run SSE |
| GET | `/api/events` | 全局 SSE |
| GET | `/api/audit/export` | 审计 JSONL |

常见错误码：`MACHINE_OFFLINE`、`WORKSPACE_NOT_OPEN`、`RUN_LIMIT`、`PROMPT_COLLISION`、`CONVERSATION_BUSY`、`INJECT_SLOT_BUSY`、`WINDOW_BUSY`、`NOT_FOUND`、`INVALID_STATE`、`NO_CONVERSATION`。

## 开发指南

```bash
# 单元 / 组件逻辑测试（全仓）
bun test

# E2E：假扩展 WS 全生命周期（不依赖真实 Cursor）
bun run scripts/e2e.mjs

# 构建扩展
cd extension && npx tsup

# 构建控制台
cd hub/web && bun run build
```

工作区：`hub`、`extension`、`hub/web`（见根 `package.json`）。  
hub 静态托管路径相对 `hub/src`，**请从仓库根**执行 `bun run dev:hub`。

## 后续待办（已记录，未开工）

细节与验收见规格 **§13**（v1.8）。此处只列结论，避免 README 和规格分叉。

| 项 | 结论 |
| --- | --- |
| 中台选模型 | Cursor **没有**官方 API 列出/读取/切换 Composer Agent 模型。派发沿用该窗口当前选择。hooks 的 `model` 字段可事后展示（尚未做）。 |
| 发图片 | 方案定为：**系统剪贴板 PNG → 聚焦 Composer → paste**（与人手一致）。`vscode.env.clipboard` 只有文本，不能贴图。dashi-taskboard 的 CDP 是把看板嵌进 Codex，**不是**往对话框贴图，不能照搬。 |
| 并发 | **执行并行、注入串行**：每机默认最多 8 条占用中任务、每工作区 4 条；整机同时 1 条 CDP 注入。详见 [并行规格](../docs/superpowers/specs/2026-08-31-armada-parallel-runs-design.md)。 |
| 接入变简单 | 方案：中台提供 `join.sh`+vsix；再用包装 `Armada Cursor.app` 固定 CDP 端口。**先记账后做**。 |

## 设计文档

- 规格与验收：[`../docs/superpowers/specs/2026-08-28-lan-cursor-workbench-design.md`](../docs/superpowers/specs/2026-08-28-lan-cursor-workbench-design.md)
- 单机并行：[`../docs/superpowers/specs/2026-08-31-armada-parallel-runs-design.md`](../docs/superpowers/specs/2026-08-31-armada-parallel-runs-design.md)
- 对话归属：[`../docs/superpowers/specs/2026-08-30-conversation-ownership-design.md`](../docs/superpowers/specs/2026-08-30-conversation-ownership-design.md)
- 中台端 / 受控端分别做什么：见上文 **「中台端 vs 受控端」**
