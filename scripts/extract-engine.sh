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
if [[ $(uname -m) == x86_64 ]]; then
  INTEL_PIN="engine/macos-intel-fallback.json"
  [[ $(lock_get_file "$INTEL_PIN" "d['obs_version']") == $(lock_get "['obs']['ref']") ]] \
    || { echo "FATAL: Intel runtime pin does not match obs.lock" >&2; exit 1; }
  DMG_URL="$(lock_get_file "$INTEL_PIN" "d['url']")"
  DMG_SHA="$(lock_get_file "$INTEL_PIN" "d['sha256']")"
  DMG_NAME="$(lock_get_file "$INTEL_PIN" "d['asset']")"
fi
DMG_PATH="$CACHE_DIR/$DMG_NAME"

mkdir -p "$CACHE_DIR"
if [[ ! -f $DMG_PATH ]]; then
  echo "downloading $DMG_URL"
  curl -fL --retry 2 -o "$DMG_PATH" "$DMG_URL"
fi
echo "$DMG_SHA  $DMG_PATH" | shasum -a 256 -c - || {
  echo "FATAL: DMG checksum mismatch against obs.lock pin" >&2; exit 1; }

# Finder can mount the verified image when a sandbox cannot access disk devices.
if [[ -n ${PRODUCER_OBS_CONTENTS:-} ]]; then
  SRC="$PRODUCER_OBS_CONTENTS"
else
  MOUNT="$(mktemp -d)/obsdmg"
  mkdir -p "$MOUNT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG_PATH"
  trap 'hdiutil detach -quiet "$MOUNT" || true' EXIT
  SRC="$MOUNT/OBS.app/Contents"
fi
lipo "$SRC/Frameworks/libobs.framework/Versions/A/libobs" -verify_arch "$(uname -m)"

NAME="$(artifact_name)"
STAGE="$ARTIFACT_DIR/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/Frameworks" "$STAGE/PlugIns" "$STAGE/licenses"

# libobs framework + graphics backends
cp -R "$SRC/Frameworks/libobs.framework" "$STAGE/Frameworks/"
cp "$SRC/Frameworks/libobs-metal.dylib" "$SRC/Frameworks/libobs-opengl.dylib" "$STAGE/Frameworks/"

# allowlisted plugins (bundles carry their own Resources data trees)
# Recording helper (artifact rev 2): obs-ffmpeg spawns obs-ffmpeg-mux as a
# separate process and finds it NEXT TO the host executable, so it travels
# with the artifact and the assemble step drops it into Contents/MacOS.
if [[ -f "$SRC/MacOS/obs-ffmpeg-mux" ]]; then
  mkdir -p "$STAGE/bin"
  cp "$SRC/MacOS/obs-ffmpeg-mux" "$STAGE/bin/"
else
  echo "WARN: official bundle has no obs-ffmpeg-mux — recording unavailable" >&2
fi

for p in "${ENGINE_PLUGINS[@]}"; do
  cp -R "$SRC/PlugIns/$p.plugin" "$STAGE/PlugIns/"
done

# The virtual camera is TWO pieces: the plugin above, which registers the
# `virtualcam_output`, and a CoreMediaIO system extension that other apps see
# as a camera. The extension is a separate bundle the host embeds and
# activates (UI-POWER.md R13) — carry it beside the plugins.
if [[ -d "$SRC/Library/SystemExtensions" ]]; then
  mkdir -p "$STAGE/SystemExtensions"
  cp -R "$SRC/Library/SystemExtensions/." "$STAGE/SystemExtensions/"
else
  echo "WARN: official bundle has no camera system extension — virtual camera unavailable" >&2
fi

# dependency closure: copy every @rpath dylib the shipped set links, transitively
# Discovery walks the SOURCE bundle for deps of the plugins we are about to
# copy — and only those. OBS's own obs-browser lives there too but we never
# ship it (ours is a separately built, Qt-free one), so seeding it here would
# pull its Qt closure into an artifact that has no use for it.
CLOSURE_SEED_EXTRAS=0 "$REPO_ROOT/scripts/engine-closure.sh" "$SRC" | grep -v '^#' | while read -r dep; do
  [[ -f "$SRC/Frameworks/$dep" && ! -f "$STAGE/Frameworks/$dep" ]] \
    && cp "$SRC/Frameworks/$dep" "$STAGE/Frameworks/"
done

# licenses (GPL compliance: binaries ship with license texts; pinned source +
# this script reproduce the artifact)
cp -R "$SRC/Resources/license/." "$STAGE/licenses/" 2>/dev/null || true
if [[ -f "$REPO_ROOT/engine/obs-studio/COPYING" ]]; then
  cp "$REPO_ROOT/engine/obs-studio/COPYING" "$STAGE/licenses/COPYING.obs-studio"
fi

# The official renderer lacks Producer's current-frame handoff. Rebuild only
# that renderer from the same OBS pin and run its real-GPU checks locally.
PRODUCER_ENGINE_DIR="$STAGE" "$REPO_ROOT/scripts/build-cutout-metal-lab.sh"
cp "$REPO_ROOT/src-tauri/target/cutout-lab/libobs-metal-current-frame.dylib" "$STAGE/Frameworks/libobs-metal.dylib"

# The extracted OBS camera pair uses OBS's identifiers. Build Producer's pair
# from the same pinned source downloaded by the standalone Metal builder.
export PRODUCER_OBS_SOURCE="$REPO_ROOT/src-tauri/target/cutout-lab/engine-source"
export PRODUCER_SIMDE_INCLUDE="$REPO_ROOT/src-tauri/target/cutout-lab/simde"
"$REPO_ROOT/scripts/build-virtualcam-plugin.sh" --stage "$STAGE"
"$REPO_ROOT/scripts/build-camera-extension.sh"
"$REPO_ROOT/scripts/build-retired-camera-extension.sh"
rm -rf "$STAGE/SystemExtensions"
mkdir -p "$STAGE/SystemExtensions"
cp -R "$REPO_ROOT/engine/camera-extension/." "$STAGE/SystemExtensions/"
cp "$PRODUCER_OBS_SOURCE/COPYING" "$STAGE/licenses/COPYING.obs-studio"
bash "$REPO_ROOT/scripts/build-extracted-browser.sh" "$STAGE"

# closure re-check against the staged artifact itself (zero-Qt gate, A9)
"$REPO_ROOT/scripts/engine-closure.sh" "$STAGE" > /dev/null \
  || { echo "FATAL: staged artifact failed closure/Qt gate" >&2; exit 1; }

write_manifest "$STAGE" "official-release-extract:$DMG_NAME"
if [[ ${PRODUCER_ENGINE_PACK:-1} == 1 ]]; then
  pack_artifact "$STAGE"
fi
echo "engine artifact staged at $STAGE"
