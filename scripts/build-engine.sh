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

# patchset (obs.lock 'patchset'): sha256-verified patches applied to the
# declared target tree. Idempotent — a tree that already carries the patch
# (e.g. the Mac session's local submodule worktree) is detected and skipped.
patchset="$(lock_get "['patchset']")"
if [[ $patchset != "None" ]]; then
  patch_dir="$REPO_ROOT/$(lock_get "['patchset']['dir']")"
  patch_target="$SRC_DIR/$(lock_get "['patchset']['target']")"
  want_sha="$(lock_get "['patchset']['sha256']")"
  have_sha="$(cat $(ls "$patch_dir"/*.patch | sort) | shasum -a 256 | cut -d' ' -f1)"
  [[ $want_sha == "$have_sha" ]] || { echo "FATAL: patchset sha256 mismatch (lock $want_sha, files $have_sha)" >&2; exit 1; }
  for patch in $(ls "$patch_dir"/*.patch | sort); do
    if git -C "$patch_target" apply --check "$patch" 2>/dev/null; then
      git -C "$patch_target" apply "$patch"
      echo "patch applied: $(basename "$patch")"
    elif git -C "$patch_target" apply --reverse --check "$patch" 2>/dev/null; then
      echo "patch already present: $(basename "$patch")"
    else
      echo "FATAL: patch neither applies nor is present: $(basename "$patch")" >&2
      exit 1
    fi
  done
fi

# our preset rides alongside upstream's as CMakeUserPresets.json
cp "$REPO_ROOT/engine/producer-presets.json" "$SRC_DIR/CMakeUserPresets.json"
cp "$REPO_ROOT/engine/producer-project-include.cmake" "$SRC_DIR/producer-project-include.cmake"

# Shallow clones have no tags, so git-describe versioning fails ("fb4d98b
# format invalid") — hand OBS its version from the lock instead.
cmake --preset producer-macos -S "$SRC_DIR" -DOBS_VERSION_OVERRIDE="$OBS_REF"
# `cmake --build --preset` has no -S flag; presets resolve from cwd, so run
# the build from inside the source tree.
(cd "$SRC_DIR" && cmake --build --preset producer-macos)
# CEF helper apps are EXCLUDE_FROM_ALL; build them explicitly (M-L7.1)
(cd "$SRC_DIR" && cmake --build --preset producer-macos \
  --target browser-helper browser-helper_gpu browser-helper_plugin browser-helper_renderer)

# assemble artifact from the build tree's bundle-style output
BUILD="$SRC_DIR/build_producer"
NAME="$(artifact_name)"
STAGE="$ARTIFACT_DIR/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/Frameworks" "$STAGE/PlugIns" "$STAGE/licenses"

# Xcode trees contain partial/stub framework dirs; take the one that actually
# carries the binary, not the first name match.
FW=""
while IFS= read -r cand; do
  if [[ -f "$cand/Versions/A/libobs" || -f "$cand/libobs" ]]; then FW="$cand"; break; fi
done < <(find "$BUILD" -name "libobs.framework" -type d)
if [[ -z $FW ]]; then
  echo "FATAL: no complete libobs.framework in build tree; candidates were:" >&2
  find "$BUILD" -name "libobs.framework" -type d >&2
  exit 1
fi
cp -R "$FW" "$STAGE/Frameworks/"
for lib in libobs-metal.dylib libobs-opengl.dylib; do
  find "$BUILD" -name "$lib" -path "*Release*" -not -path "*.dSYM/*" | head -1 | xargs -I{} cp {} "$STAGE/Frameworks/"
done
for p in "${ENGINE_PLUGINS[@]}"; do
  bundle="$(find "$BUILD" -name "$p.plugin" -maxdepth 6 -type d | head -1)"
  [[ -n $bundle ]] || { echo "FATAL: $p.plugin not produced by build" >&2; exit 1; }
  cp -R "$bundle" "$STAGE/PlugIns/"
done
# obs-deps runtime dylibs (ffmpeg, x264, freetype, mbedtls, srt, rist) from .deps
[[ -d "$SRC_DIR/.deps" ]] || { echo "FATAL: $SRC_DIR/.deps missing after build" >&2; exit 1; }
# Closure copy runs to a FIXED POINT: the walk can only recurse into dylibs
# already present, so each pass may reveal deeper deps (e.g. librist/libsrt
# behind libavformat). Listing passes tolerate nonzero exits; the enforcing
# gate below still gates hard. No silent skips — unresolvable deps are FATAL
# (2026-08-29: a silent skip shipped an artifact with no runtime dylibs).
for pass in 1 2 3 4 5 6; do
  ("$REPO_ROOT/scripts/engine-closure.sh" "$STAGE" 2>/dev/null || true) | { grep -v '^#' || true; } > "$STAGE/.closure-list"
  copied=0
  while read -r dep; do
    [[ -z $dep ]] && continue
    [[ -e "$STAGE/Frameworks/$dep" ]] && continue
    src="$(find "$SRC_DIR/.deps" "$BUILD" -name "$dep" -not -path "*qt6*" -not -path "*.dSYM/*" 2>/dev/null | head -1)"
    if [[ -n $src ]]; then
      cp "$src" "$STAGE/Frameworks/"
      echo "dep copied (pass $pass): $dep (from $src)"
      copied=1
    else
      echo "FATAL: closure dep $dep not found under .deps or build tree; .deps layout:" >&2
      find "$SRC_DIR/.deps" -maxdepth 2 >&2 || true
      exit 1
    fi
  done < "$STAGE/.closure-list"
  [[ $copied -eq 0 ]] && break
done
rm -f "$STAGE/.closure-list"
cp "$SRC_DIR/COPYING" "$STAGE/licenses/COPYING.obs-studio"

# M-L7.1 browser assets: obs-browser plugin, CEF framework, Producer Helper
# apps, and the frontend-api shim dylib obs-browser links.
BROWSER_BUNDLE="$(find "$BUILD" -name "obs-browser.plugin" -maxdepth 6 -type d | head -1)"
if [[ -n $BROWSER_BUNDLE ]]; then
  cp -R "$BROWSER_BUNDLE" "$STAGE/PlugIns/"
  CEF_FW="$(find "$SRC_DIR/.deps" -maxdepth 3 -type d -name "Chromium Embedded Framework.framework" -path "*Release*" | head -1)"
  [[ -n $CEF_FW ]] || CEF_FW="$(find "$SRC_DIR/.deps" -maxdepth 3 -type d -name "Chromium Embedded Framework.framework" | head -1)"
  [[ -n $CEF_FW ]] || { echo "FATAL: obs-browser built but CEF framework not found in .deps" >&2; exit 1; }
  cp -R "$CEF_FW" "$STAGE/Frameworks/"
  for helper in "Producer Helper.app" "Producer Helper (GPU).app" "Producer Helper (Plugin).app" "Producer Helper (Renderer).app"; do
    happ="$(find "$BUILD" -name "$helper" -maxdepth 6 -type d | head -1)"
    [[ -n $happ ]] || { echo "FATAL: $helper not produced by build" >&2; exit 1; }
    cp -R "$happ" "$STAGE/Frameworks/"
  done
  FRONTEND_API="$(find "$BUILD" -name "obs-frontend-api.dylib" -path "*Release*" -not -path "*.dSYM/*" -type f | head -1)"
  [[ -n $FRONTEND_API ]] || FRONTEND_API="$(find "$BUILD" -name "libobs-frontend-api*.dylib" -not -path "*.dSYM/*" -type f | head -1)"
  [[ -n $FRONTEND_API ]] || { echo "FATAL: obs-browser built but frontend-api dylib not found" >&2; exit 1; }
  cp "$FRONTEND_API" "$STAGE/Frameworks/"
  # helper entitlement plists ride in the artifact — the release workflow
  # signs from the artifact alone, without the OBS source tree
  mkdir -p "$STAGE/signing"
  cp "$SRC_DIR"/plugins/obs-browser/cmake/macos/entitlements-helper*.plist "$STAGE/signing/" 2>/dev/null || true
  echo "browser assets staged (obs-browser + CEF + 4 helpers + frontend-api)"
else
  echo "NOTE: obs-browser not in build output; artifact ships without CEF overlays"
fi

"$REPO_ROOT/scripts/engine-closure.sh" "$STAGE" > /dev/null \
  || { echo "FATAL: built artifact failed closure/Qt gate" >&2; exit 1; }

write_manifest "$STAGE" "source-build:$OBS_COMMIT:producer-macos"
pack_artifact "$STAGE"
