#!/usr/bin/env bash
# Pack-time sidecar for the Armada desktop shell (Tauri $RESOURCE/).
#
# Copies hub *sources* (not a compiled hub binary) plus a Bun runtime so
# create_fleet can spawn:
#   $RESOURCE/bun src/index.ts --lan
# with cwd = $RESOURCE/hub, so hub/src/index.ts still resolves ../web/dist.
#
# GA / release builds MUST pin an official Bun binary for the *target* arch
# (https://github.com/oven-sh/bun/releases). Copying $(which bun) is only
# acceptable for local host-arch verification — do not assume system bun
# exists on the user's machine, and do not git-add the copied binary.
#
# Dev spawn still honors ARMADA_DESKTOP_HUB_ROOT (worktree hub/) so
# `tauri dev` works before this script has been run.
#
# Usage: desktop/scripts/bundle-hub.sh [dest-dir]
# Default dest: <repo>/desktop/src-tauri/resources
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEST="${1:-"$ROOT/desktop/src-tauri/resources"}"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found on PATH (needed to build hub/web and install hono)" >&2
  exit 1
fi

mkdir -p "$DEST"

echo "==> build hub/web (ROOT=$ROOT)"
bun run --cwd "$ROOT/hub/web" build

echo "==> copy hub sources (src + package.json + web/dist)"
rm -rf "$DEST/hub"
mkdir -p "$DEST/hub/src" "$DEST/hub/web/dist"
cp -R "$ROOT/hub/src/." "$DEST/hub/src/"
cp "$ROOT/hub/package.json" "$DEST/hub/package.json"
if [[ ! -d "$ROOT/hub/web/dist" ]]; then
  echo "error: hub/web/dist missing after build" >&2
  exit 1
fi
cp -R "$ROOT/hub/web/dist/." "$DEST/hub/web/dist/"

echo "==> bun install --production (hono)"
(
  cd "$DEST/hub"
  bun install --production
)
if [[ ! -d "$DEST/hub/node_modules/hono" ]]; then
  echo "error: hono did not install into $DEST/hub/node_modules" >&2
  exit 1
fi

echo "==> copy Bun runtime (host arch; GA should pin official target-arch bun)"
BUN_SRC="$(command -v bun)"
if [[ ! -f "$BUN_SRC" ]]; then
  echo "error: bun binary not a file: $BUN_SRC" >&2
  exit 1
fi
cp "$BUN_SRC" "$DEST/bun"
chmod +x "$DEST/bun"

echo "==> copy armada-cursor + hooks"
mkdir -p "$DEST/scripts" "$DEST/hooks"
cp "$ROOT/scripts/armada-cursor.sh" "$DEST/scripts/"
cp "$ROOT/scripts/armada-cursor.ps1" "$DEST/scripts/"
chmod +x "$DEST/scripts/armada-cursor.sh"
cp "$ROOT/hooks/install.sh" "$DEST/hooks/"
cp "$ROOT/hooks/install.ps1" "$DEST/hooks/"
cp "$ROOT/hooks/armada-spool.sh" "$DEST/hooks/"
cp "$ROOT/hooks/armada-spool.ps1" "$DEST/hooks/"
if [[ -f "$ROOT/hooks/hooks.template.json" ]]; then
  cp "$ROOT/hooks/hooks.template.json" "$DEST/hooks/"
fi
chmod +x "$DEST/hooks/install.sh" "$DEST/hooks/armada-spool.sh"

echo "==> vsix (current extension/package.json version)"
bash "$ROOT/scripts/pack-extension.sh"
VER="$(node -p "require('$ROOT/extension/package.json').version")"
VSIX="$ROOT/extension/armada-agent-$VER.vsix"
if [[ ! -f "$VSIX" ]]; then
  echo "error: pack-extension did not produce $VSIX" >&2
  exit 1
fi
rm -f "$DEST"/*.vsix
cp "$VSIX" "$DEST/$(basename "$VSIX")"
echo "    copied $(basename "$VSIX")"

echo "ok hub=$DEST/hub bun=$DEST/bun"
echo "layout: $DEST/hub/src/index.ts -> ../web/dist"
