#!/bin/bash
# build-engine-windows.sh — the Windows sibling of build-engine.sh.
#
# Same lock, same patchset verification, same manifest writer; different build
# body and a different artifact layout. build-engine.sh is macOS-shaped top to
# bottom (Xcode selection, universal deps, .framework staging) and is
# deliberately NOT bent to serve both — a sibling that shares engine-lib.sh's
# lock helpers is the honest structure.
#
# Runs on a windows-latest GitHub runner (Git Bash) or a dev box with VS 2022 +
# CMake. Produces engine/artifacts/producer-libobs-windows-x64-<hash12>/.
#
# ── Why there is no ENABLE_BROWSER_DISPATCH_LOOP here ───────────────────────
# The producer-macos preset sets it TRUE because obs-browser's
# cmake/os-macos.cmake hard-requires Qt6 and defines ENABLE_BROWSER_QT_LOOP —
# Producer has no QApplication, so the macOS build needs the libdispatch pump
# the patchset adds. cmake/os-windows.cmake never defines a Qt loop at all: CEF
# runs its own multi-threaded message loop there. So Windows needs the property
# the patch creates, and already has it.
#
# The patch is still APPLIED and still verified against the same sha256, because
# every code hunk is guarded by that define and is therefore inert here. One
# lock, one patchset hash, no per-platform divergence to drift.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"

check_plugin_lists

SRC_DIR="$REPO_ROOT/engine/obs-studio"
OBS_COMMIT="$(lock_get "['obs']['commit']")"
OBS_REPO="$(lock_get "['obs']['repo']")"
OBS_REF="$(lock_get "['obs']['ref']")"
NAME="$(artifact_name windows x64)"
STAGE="$ARTIFACT_DIR/$NAME"

command -v cmake >/dev/null || { echo "FATAL: cmake not found" >&2; exit 1; }

# ── pin source exactly to the lock ───────────────────────────────────────────
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

# ── patchset: same verification as macOS, idempotent ─────────────────────────
patchset="$(lock_get "['patchset']")"
if [[ $patchset != "None" ]]; then
  patch_dir="$REPO_ROOT/$(lock_get "['patchset']['dir']")"
  patch_target="$SRC_DIR/$(lock_get "['patchset']['target']")"
  want_sha="$(lock_get "['patchset']['sha256']")"
  have_sha="$(cat $(ls "$patch_dir"/*.patch | sort) > /tmp/patchcat && sha256_of /tmp/patchcat)"
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

# ── configure + build ────────────────────────────────────────────────────────
cp "$REPO_ROOT/engine/producer-presets.json" "$SRC_DIR/CMakeUserPresets.json"
cp "$REPO_ROOT/engine/producer-project-include.cmake" "$SRC_DIR/producer-project-include.cmake"

cmake --preset producer-windows -S "$SRC_DIR" -DOBS_VERSION_OVERRIDE="$OBS_REF"
# `cmake --build --preset` has no -S; presets resolve from cwd (same quirk the
# macOS script documents).
(cd "$SRC_DIR" && cmake --build --preset producer-windows)

BUILD="$SRC_DIR/build_producer"
# Multi-config generator: Release lives in a subdir. rundir is what OBS's own
# install step assembles.
OUT=""
for cand in "$BUILD/rundir/Release/bin/64bit" "$BUILD/Release" "$BUILD/rundir/Release"; do
  [[ -f "$cand/obs.dll" ]] && { OUT="$cand"; break; }
done
[[ -n $OUT ]] || { echo "FATAL: obs.dll not found under $BUILD" >&2; exit 1; }
echo "build output: $OUT"

# ── stage ────────────────────────────────────────────────────────────────────
# Layout mirrors an OBS Windows install so build.rs's bin/ probe finds it, and
# so bundling can copy it 1:1 beside the exe. There is no framework concept and
# no rpath on Windows — DLLs resolve from the executable's directory.
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/obs-plugins/64bit" "$STAGE/data" "$STAGE/licenses"

# WHOLESALE, not *.dll + *.exe. CEF's Windows runtime payload sits in this same
# directory and is mostly NOT a DLL: icudtl.dat (CefInitialize hard-fails without
# it), resources.pak / chrome_*.pak, v8_context_snapshot.bin, and locales/ - a
# SUBDIRECTORY no *.dll glob can ever match. Miss any of them and obs-browser
# loads, then dies at init, and the failure reads as "guests are broken" three
# rungs later instead of "staging is incomplete" right here. obs64.exe rides
# along; it is inert and useful for debugging.
cp -R "$OUT"/. "$STAGE/bin/"
# THE IMPORT LIBRARY. A source build produces obs.lib; an extracted release does
# not. Staging it means Windows devs can link the normal way — raw-dylib in
# ffi.rs is what makes the extract ALSO work, not a replacement for this.
find "$BUILD" -name "obs.lib" -exec cp {} "$STAGE/bin/" \; 2>/dev/null || true

PLUGIN_SRC=""
for cand in "$BUILD/rundir/Release/obs-plugins/64bit" "$OUT/../../obs-plugins/64bit"; do
  [[ -d "$cand" ]] && { PLUGIN_SRC="$cand"; break; }
done
[[ -n $PLUGIN_SRC ]] || { echo "FATAL: plugin output dir not found" >&2; exit 1; }

missing=0
while read -r p; do
  if [[ -f "$PLUGIN_SRC/$p.dll" ]]; then
    cp "$PLUGIN_SRC/$p.dll" "$STAGE/obs-plugins/64bit/"
    echo "staged plugin: $p"
  else
    echo "MISSING plugin: $p" >&2
    missing=1
  fi
done < <(engine_plugins windows)
[[ $missing -eq 0 ]] || { echo "FATAL: allowlisted plugins missing from the build" >&2; exit 1; }

# Plugin data (locale, effects, and obs-browser's CEF payload).
DATA_SRC="$BUILD/rundir/Release/data"
[[ -d "$DATA_SRC" ]] && cp -R "$DATA_SRC/." "$STAGE/data/"

# obs-browser is the whole reason rung 4 exists — fail loudly rather than
# shipping an engine that silently cannot render a guest.
[[ -f "$STAGE/obs-plugins/64bit/obs-browser.dll" ]] \
  || { echo "FATAL: obs-browser.dll not staged — guests cannot work without it" >&2; exit 1; }
# CEF is not one file. Check the load-bearing pieces here, where the message can
# name the cause; engine-closure-windows.sh asserts the same set again as a gate.
for cef in libcef.dll icudtl.dat locales; do
  [[ -e "$STAGE/bin/$cef" ]] || echo "WARNING: CEF payload missing $cef in bin/ - obs-browser will fail at init" >&2
done

cp "$SRC_DIR/COPYING" "$STAGE/licenses/" 2>/dev/null || true

write_manifest "$STAGE" "source-build:$OBS_COMMIT:producer-windows"
pack_artifact "$STAGE"
echo "engine staged: $STAGE"
