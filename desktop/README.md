# Armada desktop (Tauri 2)

两种入口，同一份看板：

| 怎么开 | 命令 | 用途 |
| --- | --- | --- |
| **Web 联调** | 仓库根目录 `bun run dev:web` | 看板和 API 都在 **http://127.0.0.1:7380**（与原先一致）。改 `hub/web` 会重建 `dist`，刷新页面即可。 |
| **桌面应用** | `bun run dev:desktop` 或打开打包好的 Armada.app | 启动前会按 `extension/package.json` 打出当前 vsix，并在创建/加入时 `--force` 装进 Cursor。创建/加入舰队、代装扩展、CDP 开工作区。成功后全屏进看板。 |

Web 不创建舰队、不起第二份 hub。7380 已被占用时只重建看板、复用现有 hub。

看板右上角 **退出中台**：浏览器回到令牌页；桌面回到创建/加入页（只停本 App spawn 的 hub，附着别人的 7380 不杀）。
