#!/bin/bash
# build-camera-extension.sh — build Producer's CoreMediaIO camera extension
# from the pinned OBS sources, with OUR identifiers set at BUILD time.
#
# Why from source: rebranding a prebuilt extension only rewrites Info.plist.
# The compiled binary keeps its original service identity, and the installer
# gets as far as "extension category returned error" (UI-POWER.md R13). The
# Swift itself has no hardcoded ids — only the device NAME — so a source
# build is small and gives us correct branding for free.
#
# No Xcode needed: the extension is a standalone Swift bundle whose only
# dependency is CoreMediaIO. CLT's swiftc is enough.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/engine/obs-studio/plugins/mac-virtualcam/src/camera-extension"
OUT_DIR="$REPO_ROOT/engine/camera-extension"

EXT_ID="ai.boomin.producer.camera-extension"
TEAM_ID="${PRODUCER_TEAM_ID:-9936A69867}"
DEVICE_NAME="${PRODUCER_VCAM_NAME:-Producer Virtual Camera}"

# 🔑 These UUIDs are the rendezvous with the obs-plugin half: mac-virtualcam
# reads OBSCameraDeviceUUID from ITS OWN Info.plist and looks for a device
# publishing the same one. Change them and the plugin can never find us.
DEVICE_UUID="${VCAM_DEVICE_UUID:-7626645E-4425-469E-9D8B-97E0FA59AC75}"
SOURCE_UUID="${VCAM_SOURCE_UUID:-A8D7B8AA-65AD-4D21-9C42-66480DBFA8E1}"
SINK_UUID="${VCAM_SINK_UUID:-A3F16177-7044-4DD8-B900-72E2419F7A9A}"

[[ -d $SRC ]] || { echo "FATAL: extension sources missing at $SRC" >&2; exit 1; }

BUNDLE="$OUT_DIR/$EXT_ID.systemextension"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

# Compile from a copy so the pinned tree is never edited in place; the only
# change is the user-visible device name.
WORK="$(mktemp -d)"
cp "$SRC"/*.swift "$WORK/"
/usr/bin/sed -i '' "s/OBS Virtual Camera/$DEVICE_NAME/g" "$WORK"/*.swift
/usr/bin/sed -i '' "s/OBS Camera Extension Stream/Producer Camera Stream/g" "$WORK"/*.swift

swiftc -O -swift-version 5 \
  -target "arm64-apple-macos13.0" \
  -framework CoreMediaIO -framework CoreMedia -framework Foundation \
  -o "$BUNDLE/Contents/MacOS/$EXT_ID" \
  "$WORK"/*.swift

# 🔴 The extension fatalErrors at startup if this image is missing —
# "Unable to find placeholder image in bundle resources" — and because a
# system extension crashes before it logs, the only symptom is a camera that
# never appears. This was previously copied with `|| true`, so a wrong path
# failed silently and shipped a bundle that could never run. Never optional.
# Producer's own idle image, not upstream's OBS logo (which is what
# $SRC/../common/data/placeholder.png is). Same file the Windows build stages
# beside win-dshow's filter, so the idle camera looks identical on both.
PLACEHOLDER="$REPO_ROOT/engine/assets/vcam-placeholder.png"
[[ -f $PLACEHOLDER ]] || { echo "FATAL: placeholder.png not found at $PLACEHOLDER" >&2; exit 1; }
cp "$PLACEHOLDER" "$BUNDLE/Contents/Resources/placeholder.png"

# NOTE: no XML comments in plists that AMFI reads — its parser is stricter
# than plutil's and fails signing with "AMFIUnserializeXML: syntax error".
cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>$DEVICE_NAME</string>
	<key>CFBundleExecutable</key>
	<string>$EXT_ID</string>
	<key>CFBundleIdentifier</key>
	<string>$EXT_ID</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$EXT_ID</string>
	<key>CFBundlePackageType</key>
	<string>SYSX</string>
	<key>CFBundleShortVersionString</key>
	<string>1.2</string>
	<!-- 🔴 BUMP THIS whenever the extension changes. macOS will NOT replace an
	     installed system extension that carries the same version, so a fixed
	     build silently keeps running the broken copy already registered. -->
	<key>CFBundleVersion</key>
	<string>3</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSSystemExtensionUsageDescription</key>
	<string>Producer uses a camera extension so other apps can use your production as a webcam.</string>
	<key>CMIOExtension</key>
	<dict>
		<key>CMIOExtensionMachServiceName</key>
		<string>$TEAM_ID.$EXT_ID</string>
	</dict>
	<key>OBSCameraDeviceUUID</key>
	<string>$DEVICE_UUID</string>
	<key>OBSCameraSourceUUID</key>
	<string>$SOURCE_UUID</string>
	<key>OBSCameraSinkUUID</key>
	<string>$SINK_UUID</string>
</dict>
</plist>
PLIST

rm -rf "$WORK"
echo "built: $BUNDLE"
