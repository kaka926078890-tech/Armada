#!/usr/bin/env bash
# Copy repo hub/ + record $(which bun) for packaging (Task 13).
# Dev spawn prefers ARMADA_DESKTOP_HUB_ROOT (this worktree's hub/) so bun hub/src/index.ts --lan
# works before the bundle exists.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-"$ROOT/desktop/src-tauri/resources"}"
mkdir -p "$DEST"
rm -rf "$DEST/hub"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude node_modules --exclude web/node_modules --exclude web/dist "$ROOT/hub/" "$DEST/hub/"
else
  mkdir -p "$DEST/hub"
  cp -R "$ROOT/hub/." "$DEST/hub/"
  rm -rf "$DEST/hub/node_modules" "$DEST/hub/web/node_modules" "$DEST/hub/web/dist"
fi
which bun > "$DEST/bun.path"
echo "hub -> $DEST/hub"
echo "bun $(cat "$DEST/bun.path")"
