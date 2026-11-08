#!/bin/bash
# Fail before Rust compilation if a live Mac build would omit a required piece.
set -euo pipefail
STAGE="${1:?usage: check-macos-engine.sh engine-stage [arm64|x86_64]}"
ARCH="${2:-$(uname -m)}"
[[ $ARCH == arm64 || $ARCH == x86_64 ]] || exit 64
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"
check_arch() { [[ -f "$1" ]] || { echo "FATAL: missing native component: $1" >&2; exit 1; }; lipo "$1" -verify_arch "$ARCH"; }
check_arch "$STAGE/Frameworks/libobs.framework/Versions/A/libobs"
check_arch "$STAGE/Frameworks/libobs-opengl.dylib"
check_arch "$STAGE/Frameworks/libobs-metal.dylib"
check_arch "$STAGE/Frameworks/obs-frontend-api.dylib"
check_arch "$STAGE/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework"
for p in "${ENGINE_PLUGINS[@]}" obs-browser; do
  check_arch "$STAGE/PlugIns/$p.plugin/Contents/MacOS/$p"
done
for suffix in '' ' (GPU)' ' (Plugin)' ' (Renderer)'; do
  check_arch "$STAGE/Frameworks/Producer Helper${suffix}.app/Contents/MacOS/Producer Helper${suffix}"
done
check_arch "$STAGE/bin/obs-ffmpeg-mux"
check_arch "$STAGE/SystemExtensions/ai.boomin.producer.camera-extension.systemextension/Contents/MacOS/ai.boomin.producer.camera-extension"
bash "$REPO_ROOT/scripts/engine-closure.sh" "$STAGE" >/dev/null
echo "PASS: complete $ARCH Mac live engine, browser/helpers, recording muxer and camera provider"
