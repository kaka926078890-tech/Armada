#!/usr/bin/env bash
# Pack Armada.app with a stable codesigning identity (not ad-hoc).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY="$(bash "$ROOT/scripts/macos-signing-identity.sh")"
  export APPLE_SIGNING_IDENTITY
fi
echo "==> signingIdentity=$APPLE_SIGNING_IDENTITY"
exec bun x tauri build "$@"
