#!/usr/bin/env bash
# Print a stable Apple codesigning identity. Ad-hoc (`-`) keys TCC to CDHash,
# so every overlay looks like a new app and re-prompts Desktop/Documents.
set -euo pipefail
ids=$(security find-identity -v -p codesigning | sed -n 's/^[[:space:]]*[0-9]*) [A-F0-9]* "\(.*\)"$/\1/p')
pick=$(printf '%s\n' "$ids" | grep -E '^Developer ID Application:' | head -1 || true)
if [[ -z "$pick" ]]; then
  pick=$(printf '%s\n' "$ids" | grep -E '^Apple Development:' | head -1 || true)
fi
if [[ -z "$pick" || "$pick" == "-" ]]; then
  echo "error: no Apple Development / Developer ID Application identity in the keychain." >&2
  echo "adhoc signingIdentity=- makes TCC re-prompt on every overlay; that dialog cannot be clicked unattended." >&2
  exit 1
fi
printf '%s\n' "$pick"
