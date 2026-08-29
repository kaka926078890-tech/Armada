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

## 角色怎么分

| 角色 | 装什么 | 需要 Bun？ |
| --- | --- | --- |
| **中台机** | `armada-hub` + 控制台静态页 | 要（跑 hub） |
| **被控机** | Cursor + `armada-agent` 扩展 + hooks；建议用 `armada-cursor.sh` 启动 | **不要** |

中台机自己也可以当被控（本机窗口会注册上来）。另一台电脑只要能访问中台的 `7380` 端口（出站 WebSocket），不必给被控机开入站端口。

当前范围：**macOS + Cursor**。Windows 未测，不要按本文装。

## 快速开始（只控本机）

```bash
cd armada
bun install
cd hub/web && bun run build && cd ../..
bun run hub/src/index.ts --lan          # 只本机调试可去掉 --lan
sh hooks/install.sh
```

扩展打包见下一节。启动后令牌在 `~/.armada/token`。浏览器打开 `http://127.0.0.1:7380`，粘贴令牌。

## 另一台电脑接入

下面假设中台机局域网 IP 是 `192.168.1.10`（请换成你的）。被控机与中台须在同一局域网。

### 1. 中台机：对局域网监听

已在跑、且绑的是 `127.0.0.1` 时，**别的电脑连不上**。停掉后用 `--lan` 重启：

```bash
cd /path/to/armada
bun run hub/src/index.ts --lan
```

日志应类似：`armada-hub listening on http://0.0.0.0:7380`。

本机查 IP 与令牌：

```bash
ipconfig getifaddr en0          # Wi-Fi；有线可能是 en1
cat ~/.armada/token             # 64 位 hex，不要换行、不要重新生成
```

中台机防火墙需允许 **入站 TCP 7380**（系统设置 → 网络 → 防火墙 → 允许 `bun` / 终端传入）。被控机不需要入站规则。

在**被控机**上先探活（失败就先修网络，再装扩展）：

```bash
curl -sS http://192.168.1.10:7380/api/health
# 期望: {"ok":true,"name":"armada-hub"}
```

### 2. 中台机：打一次 vsix（被控机不用编）

```bash
cd /path/to/armada/extension
npx tsup
npx vsce package --no-dependencies    # 没有 vsce：npm i -g @vscode/vsce
```

得到 `armada-agent-0.3.6.vsix`（版本随 `extension/package.json`）。用隔空投送 / U 盘 / 共享目录拷到被控机。同时拷这三样（或整仓）：

- `extension/armada-agent-*.vsix`
- `hooks/`（整个目录）
- `scripts/armada-cursor.sh`

### 3. 被控机：hooks + 扩展

被控机需要：**已安装并登录 Cursor**（用这台电脑自己的账号；中台不代登）。

```bash
cd /path/to/armada          # 或你解压 hooks 的目录
sh hooks/install.sh
```

会把 `armada-spool.sh` 拷到 `~/.cursor/hooks/`，并 **merge** 进 `~/.cursor/hooks.json`（不覆盖别人的条目）。

Cursor → 扩展 → **Install from VSIX** → 选刚拷来的 `.vsix`。

命令面板（`Cmd+Shift+P`）→ **`Armada: Configure Hub Connection`**：

| 项 | 填法 | 不要填 |
| --- | --- | --- |
| hub | `192.168.1.10:7380` | `http://`、`https://`、`127.0.0.1`（那是中台本机） |
| token | 中台机 `~/.armada/token` 原文 | 被控机自己再生成一份 |

保存后必须 **Reload Window**。输出面板选 **Armada**，应看到 `config loaded, hub=192.168.1.10:7380`。连不上时看是否防火墙 / IP / 令牌。

### 4. 被控机：用 CDP 启动器打开目标工作区

全自动提交要求 Cursor **带着** `--remote-debugging-port=9222` 启动。已经用图标点开的 Cursor **没有** 这端口，扩展会降级成剪贴板，任务卡会停在「待本机回车」。

```bash
# 先 Cmd+Q 完全退出 Cursor（所有窗口、所有对话框）
chmod +x /path/to/armada/scripts/armada-cursor.sh
/path/to/armada/scripts/armada-cursor.sh /绝对路径/你的工作区
```

约束：

- 中台只能派到 **已经打开、且扩展已上报** 的工作区；关窗或从未打开 → `400 WORKSPACE_NOT_OPEN`。不能远程替你开文件夹。
- 路径必须与窗口标题/工作区根一致（用绝对路径；不要一个是 `/Users/foo/proj`、派发写成 `~/proj`）。
- 每机同一时刻 **只能跑 1 个任务**（已有 running 会 `409 RUN_BUSY`）。
- 推理走 Cursor 云，被控机要能上网。

### 5. 中台控制台派发

任意电脑浏览器打开 `http://192.168.1.10:7380`，粘贴**同一份**令牌。

1. 左侧机器树出现被控机主机名，绿点在线；下面列出已开工作区。
2. **+ 派发任务** → 选机器 → 选工作区 → 写 prompt → 发送。
3. 看板应很快从「待本机回车」进入「运行中」（CDP 成功时无需人在被控机回车）。
4. 详情里看思考 / 工具 / 回复；「续聊同一对话」走同一 `conversation_id`。
5. 取消：中台点取消；若 Cursor 仍弹出确认，在被控机点一下。

验收（建议第一条任务写文件，便于对照）：

- [ ] 被控机 `curl` health 成功
- [ ] 控制台看到该机在线 + 目标工作区
- [ ] 派发后 30s 内进入运行中或已完成，且详情里的对话不是别的窗口的内容
- [ ] 被控机 IDE 里出现对应新对话，工作区文件按 prompt 改了

### 接入故障

| 现象 | 先查 |
| --- | --- |
| 控制台没有这台机器 | 扩展是否 Reload；hub 是否 `--lan`；`hubUrl` 是否写成了 `127.0.0.1`；输出面板 Armada 有无 WS 报错 |
| health 都 curl 不通 | 中台防火墙、两机是否同网段、hub 是否真在 `0.0.0.0:7380` |
| `WORKSPACE_NOT_OPEN` | 被控机用启动器打开该路径；等心跳（约 15s）后再派 |
| `RUN_BUSY` | 等当前任务结束，或在中台取消/关闭异常卡 |
| 一直「待本机回车」 | Cursor 不是 `armada-cursor.sh` 拉起的；先 Cmd+Q 再用脚本开 |
| 详情串了别的对话 | 扩展需 ≥ 0.3.6；同一工作区多对话时归属按 prompt/`conversation_id`，不要用旧 vsix |

## 发送通道

| 动作 | 中台做什么 | 被控机还要做什么 |
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
- 另一台电脑怎么装：见上文 **「另一台电脑接入」**
