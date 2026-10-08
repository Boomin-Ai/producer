#!/bin/bash
# Run the current debug executable in the installed engine's app topology.
# Keep Vite running on :1420 for frontend HMR. Rerun after native changes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENGINE_APP="${PRODUCER_DEV_ENGINE_APP:-/Applications/Producer.app}"
DEV_APP="$PWD/src-tauri/target/dev-room/Producer.app"
[[ -d "$ENGINE_APP/Contents/Frameworks/libobs.framework" ]] || {
  echo "Install Producer first, or set PRODUCER_DEV_ENGINE_APP to its app bundle." >&2
  exit 1
}
if pgrep -f "$DEV_APP/Contents/MacOS/producer" >/dev/null; then
  echo "Close the bundled dev room before rebuilding it." >&2
  exit 1
fi
curl -fsS http://localhost:1420/ >/dev/null || {
  echo "Start npm run dev before launching the dev room." >&2
  exit 1
}
PRODUCER_ENGINE_DIR="$ENGINE_APP/Contents" cargo build --manifest-path src-tauri/Cargo.toml
mkdir -p "$(dirname "$DEV_APP")"
ditto "$ENGINE_APP" "$DEV_APP"
cp src-tauri/target/debug/producer "$DEV_APP/Contents/MacOS/producer"
if [[ -f engine/virtualcam-plugin/mac-virtualcam.plugin/Contents/MacOS/mac-virtualcam ]]; then
  ditto engine/virtualcam-plugin/mac-virtualcam.plugin "$DEV_APP/Contents/PlugIns/mac-virtualcam.plugin"
  codesign --force --sign - "$DEV_APP/Contents/PlugIns/mac-virtualcam.plugin"
fi

# Keep the existing capture permission identity when available.
DEV_IDENT="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')"
if [[ -n "$DEV_IDENT" ]]; then
  codesign --force --timestamp=none --options runtime --sign "$DEV_IDENT" \
    --entitlements scripts/entitlements-app.plist "$DEV_APP"
else
  codesign --force --sign - "$DEV_APP"
fi
codesign --verify --deep --strict "$DEV_APP"
if [[ "${1:-}" != "--prepare" ]]; then
  open -n --env "PRODUCER_DEV_MODULE_CONFIG_DIR=$PWD/src-tauri/target/dev-room/module-config" "$DEV_APP"
else
  echo "Prepared signed preview: $DEV_APP"
fi
