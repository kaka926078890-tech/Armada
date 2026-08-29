#!/bin/bash
# Armada CDP 启动器:以远程调试端口启动 Cursor,使 armada-agent 扩展可以
# 对本机 composer 做 DOM 注入与自动提交(无焦点依赖、可读回校验)。
#
# 注意:
# - 必须先完全退出 Cursor(Cmd+Q)再用本脚本启动;若已有 Cursor 实例在跑,
#   参数会被单实例机制吞掉,CDP 不会生效。
# - 经 LaunchServices(open)启动,与双击图标同一信任链,不触发 Gatekeeper 拦截。
# - 端口只绑 127.0.0.1,不对局域网开放。
# - 不用本脚本启动时,扩展自动降级为"剪贴板粘贴 + 人工回车"。
#
# 用法: armada-cursor.sh [workspace 路径 ...]

PORT="${ARMADA_CDP_PORT:-9222}"

if ! ls /Applications/Cursor.app/Contents/MacOS/Cursor >/dev/null 2>&1; then
  echo "找不到 Cursor.app" >&2
  exit 1
fi

# 单实例保护:已有 Cursor 在跑时,启动参数会被吞掉(表现为"闪一下就退出")
if pgrep -x Cursor >/dev/null 2>&1; then
  echo "检测到 Cursor 正在运行。请先完全退出(Cmd+Q,确认所有对话框),再运行本脚本。" >&2
  exit 1
fi

exec open -na "Cursor" --args --remote-debugging-port="$PORT" "$@"
