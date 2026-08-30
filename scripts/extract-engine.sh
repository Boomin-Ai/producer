#!/bin/bash
# extract-engine.sh — R1 fallback path (LIVE-REVIEW.md §7 R1, v1.1.1 note):
# produce the Producer engine artifact by extracting libobs + the §5.2 plugin
# allowlist from the official signed OBS release DMG pinned in engine/obs.lock.
# Emits the exact same artifact layout as build-engine.sh (source/CI path).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"

DMG_URL="$(lock_get "['fallback']['url']")"
DMG_SHA="$(lock_get "['fallback']['sha256']")"
DMG_NAME="$(lock_get "['fallback']['asset']")"
DMG_PATH="$CACHE_DIR/$DMG_NAME"

mkdir -p "$CACHE_DIR"
if [[ ! -f $DMG_PATH ]]; then
  echo "downloading $DMG_URL"
  curl -sL -o "$DMG_PATH" "$DMG_URL"
fi
echo "$DMG_SHA  $DMG_PATH" | shasum -a 256 -c - || {
  echo "FATAL: DMG checksum mismatch against obs.lock pin" >&2; exit 1; }

MOUNT="$(mktemp -d)/obsdmg"
mkdir -p "$MOUNT"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MOUNT" "$DMG_PATH"
trap 'hdiutil detach -quiet "$MOUNT" || true' EXIT
SRC="$MOUNT/OBS.app/Contents"

NAME="$(artifact_name)"
STAGE="$ARTIFACT_DIR/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/Frameworks" "$STAGE/PlugIns" "$STAGE/licenses"

# libobs framework + graphics backends
cp -R "$SRC/Frameworks/libobs.framework" "$STAGE/Frameworks/"
cp "$SRC/Frameworks/libobs-metal.dylib" "$SRC/Frameworks/libobs-opengl.dylib" "$STAGE/Frameworks/"

# allowlisted plugins (bundles carry their own Resources data trees)
# Recording helper (artifact rev 2): lives beside OBS's own executable.
if [[ -f "$OBS_APP/Contents/MacOS/obs-ffmpeg-mux" ]]; then
  mkdir -p "$STAGE/bin"
  cp "$OBS_APP/Contents/MacOS/obs-ffmpeg-mux" "$STAGE/bin/"
else
  echo "WARN: official bundle has no obs-ffmpeg-mux at Contents/MacOS — recording unavailable in fallback engine" >&2
fi

for p in "${ENGINE_PLUGINS[@]}"; do
  cp -R "$SRC/PlugIns/$p.plugin" "$STAGE/PlugIns/"
done

# dependency closure: copy every @rpath dylib the shipped set links, transitively
"$REPO_ROOT/scripts/engine-closure.sh" "$SRC" | grep -v '^#' | while read -r dep; do
  [[ -f "$SRC/Frameworks/$dep" && ! -f "$STAGE/Frameworks/$dep" ]] \
    && cp "$SRC/Frameworks/$dep" "$STAGE/Frameworks/"
done

# licenses (GPL compliance: binaries ship with license texts; pinned source +
# this script reproduce the artifact)
cp -R "$SRC/Resources/license/." "$STAGE/licenses/" 2>/dev/null || true
[[ -f "$REPO_ROOT/engine/obs-studio/COPYING" ]] && cp "$REPO_ROOT/engine/obs-studio/COPYING" "$STAGE/licenses/COPYING.obs-studio"

# closure re-check against the staged artifact itself (zero-Qt gate, A9)
"$REPO_ROOT/scripts/engine-closure.sh" "$STAGE" > /dev/null \
  || { echo "FATAL: staged artifact failed closure/Qt gate" >&2; exit 1; }

write_manifest "$STAGE" "official-release-extract:$DMG_NAME"
pack_artifact "$STAGE"
echo "engine artifact staged at $STAGE"
