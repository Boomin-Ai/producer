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

# app bundle only: skip dmg and, critically, the updater artifact — that one
# needs the signing key and has no business in a dev loop.
npx tauri build --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'

APP="src-tauri/target/debug/bundle/macos/Producer.app"
[[ -d $APP ]] || { echo "FATAL: $APP missing after build" >&2; exit 1; }

# Sign with the real Developer ID when the keychain holds one — a STABLE
# identity means TCC grants (screen recording, camera) survive rebuilds.
# Ad-hoc fallback keeps the script working on machines without the cert.
IDENT="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')"
CODESIGN_IDENT="${IDENT:--}" ./scripts/assemble-engine-bundle.sh "$APP"

open "$APP"
