#!/bin/bash
# build-engine.sh — D5 source path: build the Producer engine from the OBS
# source pinned in engine/obs.lock using the producer-macos preset, and emit
# the same artifact layout extract-engine.sh emits.
#
# Requires full Xcode 16.x (SDK 15.0+) — the engine CI runner, or a dev Mac
# with Xcode installed. On CLT-only machines this fails fast; use
# extract-engine.sh (R1 fallback) locally instead.
#
# Note: obs-ffmpeg is ungated upstream at 32.1.2, so it is *built* here but is
# NOT shipped — artifact assembly copies only the §5.2 allowlist.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"

SRC_DIR="$REPO_ROOT/engine/obs-studio"
OBS_COMMIT="$(lock_get "['obs']['commit']")"
OBS_REPO="$(lock_get "['obs']['repo']")"
OBS_REF="$(lock_get "['obs']['ref']")"

xcode-select -p | grep -Eq "Xcode[^/]*\.app" || {
  echo "FATAL: full Xcode required (found: $(xcode-select -p)). Use extract-engine.sh locally." >&2
  exit 1
}

# pin source exactly to the lock
if [[ ! -d $SRC_DIR/.git ]]; then
  git clone --depth 1 "$OBS_REPO" "$SRC_DIR"
fi
git -C "$SRC_DIR" fetch --depth 1 origin "$OBS_COMMIT"
git -C "$SRC_DIR" checkout -q "$OBS_COMMIT"
git -C "$SRC_DIR" submodule update --init --depth 1 plugins/obs-browser plugins/obs-websocket
for sub in plugins/obs-browser plugins/obs-websocket; do
  want="$(lock_get "['submodules']['$sub']")"
  have="$(git -C "$SRC_DIR/$sub" rev-parse HEAD)"
  [[ $want == "$have" ]] || { echo "FATAL: $sub at $have, lock wants $want" >&2; exit 1; }
done

# patchset (obs.lock 'patchset'; currently null — nothing applied)
patchset="$(lock_get "['patchset']")"
[[ $patchset == "None" ]] || { echo "FATAL: patchset declared but application not implemented" >&2; exit 1; }

# our preset rides alongside upstream's as CMakeUserPresets.json
cp "$REPO_ROOT/engine/producer-presets.json" "$SRC_DIR/CMakeUserPresets.json"
cp "$REPO_ROOT/engine/producer-project-include.cmake" "$SRC_DIR/producer-project-include.cmake"

# Shallow clones have no tags, so git-describe versioning fails ("fb4d98b
# format invalid") — hand OBS its version from the lock instead.
cmake --preset producer-macos -S "$SRC_DIR" -DOBS_VERSION_OVERRIDE="$OBS_REF"
# `cmake --build --preset` has no -S flag; presets resolve from cwd, so run
# the build from inside the source tree.
(cd "$SRC_DIR" && cmake --build --preset producer-macos)

# assemble artifact from the build tree's bundle-style output
BUILD="$SRC_DIR/build_producer"
NAME="$(artifact_name)"
STAGE="$ARTIFACT_DIR/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/Frameworks" "$STAGE/PlugIns" "$STAGE/licenses"

find "$BUILD" -name "libobs.framework" -maxdepth 4 -type d | head -1 | xargs -I{} cp -R {} "$STAGE/Frameworks/"
for lib in libobs-metal.dylib libobs-opengl.dylib; do
  find "$BUILD" -name "$lib" -path "*Release*" | head -1 | xargs -I{} cp {} "$STAGE/Frameworks/"
done
for p in "${ENGINE_PLUGINS[@]}"; do
  bundle="$(find "$BUILD" -name "$p.plugin" -maxdepth 6 -type d | head -1)"
  [[ -n $bundle ]] || { echo "FATAL: $p.plugin not produced by build" >&2; exit 1; }
  cp -R "$bundle" "$STAGE/PlugIns/"
done
# obs-deps runtime dylibs (ffmpeg, x264, freetype, mbedtls, srt, rist) from .deps
DEPS_LIB="$(find "$SRC_DIR/.deps" -maxdepth 2 -type d -name lib | head -1)"
"$REPO_ROOT/scripts/engine-closure.sh" "$STAGE" 2>/dev/null | grep -v '^#' | while read -r dep; do
  [[ -f "$STAGE/Frameworks/$dep" ]] && continue
  src="$(find "$DEPS_LIB" "$BUILD" -name "$dep" 2>/dev/null | head -1)"
  [[ -n $src ]] && cp "$src" "$STAGE/Frameworks/"
done
cp "$SRC_DIR/COPYING" "$STAGE/licenses/COPYING.obs-studio"

"$REPO_ROOT/scripts/engine-closure.sh" "$STAGE" > /dev/null \
  || { echo "FATAL: built artifact failed closure/Qt gate" >&2; exit 1; }

write_manifest "$STAGE" "source-build:$OBS_COMMIT:producer-macos"
pack_artifact "$STAGE"
