# Armada

局域网 Cursor **舰队指挥台**：一台中台机调度多台被控 Cursor 窗口的派发、监控与取消。任务在被控机真实 IDE 对话里跑，用该机自己的 Cursor 登录态。

发送通道默认 **CDP 全自动**（Cursor 须用 `scripts/armada-cursor.sh` 启动）。未走该启动器时降级为剪贴板预填 + 本机回车。

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
            │    hooks     │  ~/.cursor/hooks → armada-spool.sh
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

全网只跑 **一套 hub**。中台机也可以同时当受控（本机 Cursor 窗口会注册上来）。当前范围：**macOS + Cursor**；Windows 未测。

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
   - 中台打一次，把 `extension/armada-agent-*.vsix` 拷过去（请用 ≥ 0.3.6）：

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
- 每机同时只能 1 个任务（`409 RUN_BUSY`）；关着的工作区不能派（`400 WORKSPACE_NOT_OPEN`）。

## 受控端要处理的

可以 **clone 本仓**，不必拷零散文件。Clone 之后 **不要启动 hub**。

```bash
git clone https://github.com/kaka926078890-tech/Armada.git
cd Armada
```

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

4. **安装扩展** `armada-agent` ≥ 0.3.6  
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
| `RUN_BUSY` | **中台**：等当前任务结束，或取消/关闭异常卡 |
| 一直「待本机回车」 | **受控**：Cursor 不是 `armada-cursor.sh` 拉起的 |
| 详情串了别的对话 | **受控**：扩展 ≥ 0.3.6，不要用旧 vsix |

## 发送通道

| 动作 | 中台端 | 受控端 |
| --- | --- | --- |
| 新任务 | `run.start` → 新对话 + CDP 注入并模拟 Enter | 用 `armada-cursor.sh` 开着目标工作区。CDP 失败则变剪贴板，需 **回车** |
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
| `armada.cdpPort` | Cursor 设置 | 默认 `9222`，须与 `armada-cursor.sh` 一致 |
| `armada.autoSubmit` | Cursor 设置 | 默认 `true`；`false` 则只预填、等人回车 |
| `ARMADA_HUB_URL` / `ARMADA_HUB_TOKEN` | 环境变量（扩展） | 仅当对应 Cursor 设置项（`armada.hubUrl` / `armada.token`）为空时回退；设置项非空优先（见 `extension/src/config.ts`） |

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

常见错误码：`MACHINE_OFFLINE`、`WORKSPACE_NOT_OPEN`、`RUN_BUSY`、`NOT_FOUND`、`INVALID_STATE`、`NO_CONVERSATION`。

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

## 设计文档

- 规格与验收：[`../docs/superpowers/specs/2026-08-28-lan-cursor-workbench-design.md`](../docs/superpowers/specs/2026-08-28-lan-cursor-workbench-design.md)
- 对话归属：[`../docs/superpowers/specs/2026-08-30-conversation-ownership-design.md`](../docs/superpowers/specs/2026-08-30-conversation-ownership-design.md)
- 中台端 / 受控端分别做什么：见上文 **「中台端 vs 受控端」**
