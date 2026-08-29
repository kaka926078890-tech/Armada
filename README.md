# Armada

局域网 Cursor **舰队指挥台**：一台中台机调度多台被控 Cursor 窗口的派发、监控与取消。

MVP 是**半自动**的——中台把 prompt 预填到被控机剪贴板 / Composer，操作员在本机回车确认；取消与续聊同样需要本机一次确认。

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

## 快速开始

### 1. 安装依赖

```bash
cd armada
bun install
```

### 2. 启动 hub（中台机）

```bash
bun run dev:hub          # 仅本机 127.0.0.1:7380
bun run hub/src/index.ts --lan   # 监听 0.0.0.0，暴露局域网
```

启动后令牌写在 `~/.armada/token`（可用环境变量 `ARMADA_HUB_HOME` 改数据目录）。控制台：`http://<hub>:7380`，浏览器里粘贴同一令牌。

首次打开控制台前请构建 UI：

```bash
cd hub/web && bun run build && cd ../..
```

### 3. 被控机：安装 hooks

```bash
sh hooks/install.sh
```

会把 `armada-spool.sh` 拷到 `~/.cursor/hooks/`，并 **merge** 进 `~/.cursor/hooks.json`（不覆盖既有条目）。

### 4. 被控机：安装扩展

```bash
cd extension
npx tsup
npx vsce package --no-dependencies
# 若无 vsce：npm i -g @vscode/vsce
```

Cursor → 扩展面板 → **Install from VSIX** → 选生成的 `.vsix`。  
命令面板执行 **`Armada: Configure Hub Connection`**，填入 hub 地址（如 `192.168.1.10:7380`）与令牌，然后 **Reload Window**。

### 5. 打开控制台

浏览器访问 `http://<hub-host>:7380`，输入令牌。机器上线后即可派发任务。

## 半自动铁律

| 动作 | 中台做什么 | 本机还要做什么 |
| --- | --- | --- |
| 新任务 | 扩展预填 Composer / 剪贴板 | **回车**真正开跑 |
| 取消 | hub 下发 `run.cancel`，扩展侧尝试中止 | 若 Cursor UI 仍需确认则人工确认 |
| 续聊 | hub `POST .../followup` → `run.followup` 预填 | **回车**发送跟进 |

没有「无人值守全自动」通道（desktopBridge 属 v1.5+）。

## 配置项

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `ARMADA_HUB_HOME` | 环境变量 | hub 数据目录；默认 `~/.armada`（含 `token`、SQLite） |
| 端口 | hub 启动参数 | 默认 `7380`；E2E/测试可用 `port: 0` |
| `--lan` | CLI | 监听 `0.0.0.0`，否则 `127.0.0.1` |
| 令牌文件 | `$ARMADA_HUB_HOME/token` | 首次启动自动生成 64 位 hex；`chmod 600` |
| `armada.hubUrl` | Cursor 设置 / 配置命令 | 形如 `192.168.1.10:7380`（无协议前缀） |
| `armada.token` | Cursor 设置 / 配置命令 | 与 hub 令牌一致 |
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
