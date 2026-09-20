#!/usr/bin/env bash
# Archive Armada Remote and upload an App Store Connect IPA (TestFlight).
#
# This machine has Apple Development but no local Apple Distribution identity, and
# the team has no registered iPhone for a Development profile. Archive unsigned,
# ad-hoc sign with production APNs entitlements, then exportArchive re-signs
# with Xcode Cloud Managed Apple Distribution. Never put CODE_SIGNING_ALLOWED=NO
# in pbxproj. An unsigned archive with empty signature entitlements makes Apple
# reuse a baseline Store profile that lacks aps-environment (builds 1–3).
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
ENT="$ROOT/ArmadaRemote/ArmadaRemote.entitlements"
echo "=== archived Info.plist version ==="
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist"

# Cloud export copies signature entitlements into the Store profile request.
# Without this, the IPA is push-dead even when the App ID has Push enabled.
codesign --force --sign - --entitlements "$ENT" "$APP"
echo "=== ad-hoc archive entitlements ==="
codesign -d --entitlements :- "$APP"

EXPORT_OPTS="$OUT/ExportOptions.export.plist"
UPLOAD_OPTS="$OUT/ExportOptions.upload.plist"
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
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
ENT_XML="$(codesign -d --entitlements :- "$TMP/Payload/ArmadaRemote.app" 2>/dev/null || true)"
printf '%s\n' "$ENT_XML"
if ! printf '%s\n' "$ENT_XML" | grep -q '<key>aps-environment</key>' || \
   ! printf '%s\n' "$ENT_XML" | grep -q '<string>production</string>'; then
  echo "IPA missing aps-environment=production; refusing TestFlight upload" >&2
  exit 1
fi

echo "=== IPA leak scan (PII / credentials) ==="
python3 - "$TMP" <<'PY'
import re, subprocess, sys
from pathlib import Path
root = Path(sys.argv[1])
prov = root / "Payload/ArmadaRemote.app/embedded.mobileprovision"
if prov.exists():
    decoded = subprocess.check_output(["security", "cms", "-D", "-i", str(prov)])
    # TeamName is Apple's Store profile field (not a secret). Print, do not fail.
    m = re.search(rb"<key>TeamName</key>\s*<string>([^<]+)</string>", decoded)
    if m:
        print("Apple profile TeamName (not packed from disk):", m.group(1).decode())
blocked = [
    re.compile(rb"/Users/"),
    re.compile(rb"/home/"),
    re.compile(rb"BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"),
    re.compile(rb"AuthKey_[A-Z0-9]+\.p8"),
    re.compile(rb"relay\.json"),
    re.compile(rb"operator-token="),
]
hits = []
skip_suffix = {".png", ".car"}
for p in root.rglob("*"):
    if not p.is_file():
        continue
    if p.suffix.lower() in skip_suffix:
        continue
    rel = str(p.relative_to(root))
    if p.name == "embedded.mobileprovision":
        data = p.read_bytes()
        if re.search(rb"BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY", data):
            hits.append(f"{rel}: private key in provisioning profile")
        continue
    if p.name == "ArmadaRemote" or p.suffix in {".symbols", ".plist"} or "CodeResources" in rel:
        data = p.read_bytes()
        for rx in blocked:
            if rx.search(data):
                hits.append(f"{rel}: {rx.pattern.decode('utf-8', 'replace')}")
if (root / "Symbols").exists():
    hits.append("IPA contains Symbols/ (home paths / DWARF); refuse upload")
if hits:
    print("LEAKS:")
    for h in hits:
        print(" ", h)
    sys.exit(1)
print("IPA leak scan clean (no home paths, no private keys, no Symbols)")
PY

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$UPLOAD_OPTS" \
  -allowProvisioningUpdates

echo "TestFlight upload requested"
