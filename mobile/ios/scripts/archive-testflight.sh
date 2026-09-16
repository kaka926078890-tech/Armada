#!/usr/bin/env bash
# Archive Armada Remote and export an App Store Connect IPA (TestFlight).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEAM="${DEVELOPMENT_TEAM:-LW2A4J4KKG}"
OUT="$ROOT/build"
ARCHIVE="$OUT/ArmadaRemote.xcarchive"
EXPORT="$OUT/export"

mkdir -p "$OUT"

archive_with() {
  xcodebuild \
    -project "$ROOT/ArmadaRemote.xcodeproj" \
    -scheme ArmadaRemote \
    -configuration Release \
    -archivePath "$ARCHIVE" \
    DEVELOPMENT_TEAM="$TEAM" \
    CODE_SIGN_STYLE=Automatic \
    -allowProvisioningUpdates \
    "$@" \
    archive
}

if ! archive_with -destination 'generic/platform=iOS'; then
  echo "generic iOS destination failed; retrying with -sdk iphoneos" >&2
  archive_with -sdk iphoneos
fi

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$ROOT/ExportOptions.plist" \
  -allowProvisioningUpdates

echo "IPA: $EXPORT/ArmadaRemote.ipa"
