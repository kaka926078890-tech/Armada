#!/usr/bin/env bash
# Archive Armada Remote and upload an App Store Connect IPA (TestFlight).
#
# This machine has Apple Development but no local Apple Distribution identity, and
# the team has no registered iPhone for a Development profile. Archive unsigned,
# then exportArchive re-signs with Xcode's Cloud Managed Apple Distribution
# (same path as TestFlight build 1). Never put CODE_SIGNING_ALLOWED=NO in pbxproj.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEAM="${DEVELOPMENT_TEAM:-LW2A4J4KKG}"
OUT="$ROOT/build"
ARCHIVE="$OUT/ArmadaRemote.xcarchive"
EXPORT="$OUT/export"

rm -rf "$ARCHIVE" "$EXPORT"
mkdir -p "$OUT"

archive_with() {
  xcodebuild \
    -project "$ROOT/ArmadaRemote.xcodeproj" \
    -scheme ArmadaRemote \
    -configuration Release \
    -archivePath "$ARCHIVE" \
    DEVELOPMENT_TEAM="$TEAM" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY=- \
    "$@" \
    archive
}

if ! archive_with -destination 'generic/platform=iOS'; then
  echo "generic iOS destination failed; retrying with -sdk iphoneos" >&2
  archive_with -sdk iphoneos
fi

APP="$ARCHIVE/Products/Applications/ArmadaRemote.app"
echo "=== archived Info.plist version ==="
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist"

EXPORT_OPTS="$OUT/ExportOptions.export.plist"
UPLOAD_OPTS="$OUT/ExportOptions.upload.plist"
python3 - <<'PY'
from pathlib import Path
root = Path("/Users/apple/Desktop/desk/armada/mobile/ios")
src = (root / "ExportOptions.plist").read_text()
# local IPA first
export = src.replace("<string>upload</string>", "<string>export</string>")
(root / "build" / "ExportOptions.export.plist").write_text(export)
(root / "build" / "ExportOptions.upload.plist").write_text(src)
print("wrote export/upload option plists")
PY

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$EXPORT_OPTS" \
  -allowProvisioningUpdates

IPA="$EXPORT/ArmadaRemote.ipa"
echo "IPA: $IPA"
echo "=== signed entitlements in IPA ==="
TMP=$(mktemp -d)
unzip -qo "$IPA" -d "$TMP"
codesign -d --entitlements :- "$TMP/Payload/ArmadaRemote.app" 2>/dev/null || true

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$UPLOAD_OPTS" \
  -allowProvisioningUpdates

echo "TestFlight upload requested"
