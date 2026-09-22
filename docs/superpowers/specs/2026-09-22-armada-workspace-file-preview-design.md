# 中台 / 手机查看工作区文件

日期：2026-09-22

## 问题

Agent 回复经常写成 md 并丢下链接（`[spec.md](docs/…)`）或「已编辑 foo.md」。中台详情和手机只能看到链接，点开打不开被控机上的文件，只好再发一句「把正文贴出来」。

## 做法

被控扩展在本机读文件，中台转发，看板和 App 弹预览。不走 CDP，不把工作区镜像到中台。

```text
中台 GET /api/runs/:id/file?path=
  → WS workspace.readFile
  → 扩展读盘（必须在该 run 的工作区内）
  → workspace.file { text }

手机 GET /mobile/runs/:id/file?path=
  → cmd.workspaceFileGet → 同上
```

## 安全

- 路径必须落在该 run 的 `workspace_root` 内（realpath，挡 `..` 和逃逸 symlink）
- 只预览白名单文本：md / txt / json / csv / xml / yaml / html / log / toml
- 上限 512 KiB；含 NUL 当非文本
- 被控机离线或仓没打开 → `MACHINE_OFFLINE` / `WORKSPACE_NOT_OPEN`
- 扩展 < 0.4.44 → `FILE_VIEW_UNSUPPORTED`（不空等超时）

## UI

- 中台：回复里的 md 链接、「已编辑」芯片 → 详情抽屉内预览（md 渲染，其它纯文本）
- iOS / Android：终态正文里的 md 链接 → 新页预览。链接在 HTML 里改写成 `armada-file://preview?p=`

## 不做

- 目录浏览、二进制、图片预览、改文件、缓存到中转
- 不把 `REQUIRED` 以外的扩展强制到看文件；旧扩展明确报错
