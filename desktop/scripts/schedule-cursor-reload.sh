#!/bin/sh
# Detached from Cursor: ignore SIGHUP so Reload Window cannot kill this job.
trap '' HUP
set -eu

ACTION="${1:-when-idle}"
ARMADA_HOME="${ARMADA_HUB_HOME:-$HOME/.armada}"
TOKEN=""
if [ -f "$ARMADA_HOME/token" ]; then
  TOKEN="$(tr -d '[:space:]' < "$ARMADA_HOME/token")"
fi

if [ -n "$TOKEN" ] && curl -sf -o /dev/null "http://127.0.0.1:7380/api/health"; then
  curl -sf -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    -d "{\"action\":\"$ACTION\"}" \
    "http://127.0.0.1:7380/api/cursor-reload" >/dev/null || true
else
  mkdir -p "$ARMADA_HOME"
  ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
  python3 - "$ARMADA_HOME/pending-reload.json" "$ACTION" "$ROOT/extension/package.json" <<'PY'
import json, sys, time
path, action, pkg = sys.argv[1], sys.argv[2], sys.argv[3]
if action == "skip":
    try:
        import os
        os.remove(path)
    except FileNotFoundError:
        pass
    raise SystemExit(0)
vsix = json.load(open(pkg)).get("version") or "0.4.27"
now = int(time.time() * 1000)
open(path, "w").write(json.dumps({
    "action": action if action in ("now", "when-idle") else "when-idle",
    "vsix": vsix,
    "setAt": now,
    "notBefore": now,
}))
PY
fi

osascript -e 'display notification "扩展将在空闲窗口 Reload；有任务的窗口会等。" with title "Armada"'
