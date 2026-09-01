# Armada desktop (Tauri 2)

两种入口，同一份看板：

| 怎么开 | 命令 | 用途 |
| --- | --- | --- |
| **Web 联调** | 仓库根目录 `bun run dev:web` | 起 hub（`:7380`）+ Vite（`:5173`）。浏览器打开 http://127.0.0.1:5173 粘贴 `~/.armada/token`。改 `hub/web` 可热更新。 |
| **桌面应用** | `bun run dev:desktop` 或打开打包好的 Armada.app | 创建/加入舰队、代装扩展、CDP 开工作区。成功后全屏进看板。 |

Web 不创建舰队、不起第二份 hub。本机已有 hub 时也可以只跑 `bun run --cwd hub/web dev`（Vite 把 `/api` 和 `/ws` 代理到 `127.0.0.1:7380`）。

看板右上角 **退出中台**：浏览器回到令牌页；桌面回到创建/加入页（只停本 App spawn 的 hub，附着别人的 7380 不杀）。
