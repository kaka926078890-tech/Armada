#!/usr/bin/env bash
# Local debug: board and API share the original hub origin :7380.
# Vite HMR on :5173 is not used — that was a second URL and broke bookmarks / tokens.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

port_busy() {
  lsof -nP -iTCP:7380 -sTCP:LISTEN >/dev/null 2>&1
}

cleanup() {
  if [[ -n "${HUB_PID:-}" ]]; then
    kill "$HUB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if port_busy; then
  echo "==> hub already on http://127.0.0.1:7380 (reuse, no second process)"
else
  echo "==> hub  http://127.0.0.1:7380"
  bun run hub/src/index.ts --lan &
  HUB_PID=$!
fi

echo "==> board http://127.0.0.1:7380  (hub 托管 dist；改 hub/web 会重建，浏览器刷新即可)"
echo "    粘贴 ~/.armada/token。创建/加入舰队请另开：bun run dev:desktop"
bun run --cwd hub/web build -- --watch
