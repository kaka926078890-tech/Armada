#!/usr/bin/env bash
# Local debug: hub API on :7380 + Vite HMR board on :5173.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup() {
  if [[ -n "${HUB_PID:-}" ]]; then
    kill "$HUB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> hub  http://127.0.0.1:7380  (API / 已构建的 dist)"
bun run hub/src/index.ts --lan &
HUB_PID=$!

echo "==> web  http://127.0.0.1:5173  (Vite，改看板热更新；API 代理到 7380)"
echo "    粘贴 ~/.armada/token 即可进看板。创建/加入舰队请另开：bun run dev:desktop"
bun run --cwd hub/web dev -- --host 127.0.0.1 --port 5173
