#!/usr/bin/env bash
# Build extension/dist and package armada-agent-<version>.vsix from
# extension/package.json. Desktop attach / bundle-hub copy this file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT="$ROOT/extension"

if [[ ! -f "$EXT/package.json" ]]; then
  echo "error: missing $EXT/package.json" >&2
  exit 1
fi

VER="$(node -p "require('$EXT/package.json').version")"
if [[ -z "$VER" ]]; then
  echo "error: could not read extension version" >&2
  exit 1
fi

echo "==> extension tsup + vsce (version $VER)"
(
  cd "$EXT"
  if [[ -x node_modules/.bin/tsup ]]; then
    ./node_modules/.bin/tsup
  else
    npx tsup
  fi
  # vsce prompts [y/N] when repository/LICENSE are missing; that blocks
  # stdin and (if run as beforeDevCommand) prevents Vite from binding 1420.
  npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
)

VSIX="$EXT/armada-agent-$VER.vsix"
if [[ ! -f "$VSIX" ]]; then
  echo "error: expected $VSIX after vsce package" >&2
  exit 1
fi
echo "ok $VSIX"
