#!/bin/bash
# dev.sh — run Producer in dev with a REAL app bundle, because CEF (guest
# tiles, overlays) refuses to initialize outside one: it CHECK-crashes in
# cef_initialize when the main process isn't bundled. `tauri dev`'s bare
# binary therefore can never render guests; this builds the same topology
# prod ships (tauri bundle + assemble-engine-bundle.sh, ad-hoc signed) and
# launches it. Slower than HMR — use `npm run tauri dev` with
# PRODUCER_ENGINE_PLUGINS=<artifact>/PlugIns for engine-less UI iteration,
# and this script when the test needs cameras, guests, or going live.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/engine-lib.sh
export PRODUCER_ENGINE_DIR="${PRODUCER_ENGINE_DIR:-$ARTIFACT_DIR/$(artifact_name)}"
export PRODUCER_REQUIRE_ENGINE=1
[[ -f "$PRODUCER_ENGINE_DIR/Frameworks/libobs.framework/Versions/A/libobs" ]] \
  || { echo "FATAL: live dev requires an engine; run bash scripts/extract-engine.sh first" >&2; exit 1; }
lipo "$PRODUCER_ENGINE_DIR/Frameworks/libobs.framework/Versions/A/libobs" -verify_arch "$(uname -m)"
bash scripts/check-macos-engine.sh "$PRODUCER_ENGINE_DIR" "$(uname -m)"
# Keep compiler caches inside the checkout, including in sandboxed dev environments.
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$REPO_ROOT/src-tauri/target/clang-modules}"
mkdir -p "$CLANG_MODULE_CACHE_PATH"
export CFLAGS="${CFLAGS:-} -fmodules-cache-path=$CLANG_MODULE_CACHE_PATH"
export CXXFLAGS="${CXXFLAGS:-} -fmodules-cache-path=$CLANG_MODULE_CACHE_PATH"

# app bundle only: skip dmg and, critically, the updater artifact — that one
# needs the signing key and has no business in a dev loop.
npx tauri build --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'

# A running instance keeps plugins mapped and codesign gets "Operation not
# permitted" rewriting them — close it before touching the bundle.
pkill -f "bundle/macos/Producer.app" 2>/dev/null && sleep 1

APP="src-tauri/target/debug/bundle/macos/Producer.app"
[[ -d $APP ]] || { echo "FATAL: $APP missing after build" >&2; exit 1; }
otool -L "$APP/Contents/MacOS/Producer" | grep -q libobs \
  || { echo "FATAL: app was built without the live engine" >&2; exit 1; }

# Sign with the real Developer ID when the keychain holds one — a STABLE
# identity means TCC grants (screen recording, camera) survive rebuilds.
# Ad-hoc fallback keeps the script working on machines without the cert.
IDENT="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')"
CODESIGN_IDENT="${CODESIGN_IDENT:-${IDENT:--}}" ./scripts/assemble-engine-bundle.sh "$APP" "$PRODUCER_ENGINE_DIR"

open "$APP"
