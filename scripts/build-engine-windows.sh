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
# the patchset adds. cmake/os-windows.cmake defines no Qt loop and calls no
# find_package(Qt6), so CEF pumps its own multi-threaded message loop and Windows
# needs no pump patch at all.
#
# The patch is still REQUIRED here, for a different reason: browser-client.cpp
# and obs-browser-source.cpp include Qt headers UNCONDITIONALLY upstream, which
# is fine for a build that has the frontend and fatal for one that does not. The
# patch guards those includes on ENABLE_BROWSER_QT_LOOP - Qt is present - rather
# than on the pump, so one patchset serves both platforms with one hash.
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
# deps/libdshowcapture/src is a THIRD submodule, and Windows needs it: win-dshow
# is both the camera input and the virtual camera, and its virtualcam-module
# CMakeLists names dshowcapture.hpp as a source regardless of ENABLE_VIRTUALCAM.
# Without it the GENERATE step fails with "Cannot find source file". macOS has no
# win-dshow, which is why build-engine.sh inits only the other two.
#
# It is not in the lock submodules map and does not need to be: the lock pins the
# obs commit, and the obs commit pins this submodule. The two that ARE pinned are
# pinned because we patch obs-browser and therefore care about its exact content.
# This one is transitively pinned and unpatched.
git -C "$SRC_DIR" submodule update --init --depth 1 plugins/obs-browser plugins/obs-websocket
# --recursive for this one only: libdshowcapture carries its OWN submodule,
# external/capture-device-support (Elgato AV device support), and
# virtualcam-module names files from it as sources too. Recursion is scoped here
# rather than applied to all three so obs-websocket does not drag in its own
# dependency tree for a plugin we build with ENABLE_WEBSOCKET FALSE.
git -C "$SRC_DIR" submodule update --init --recursive --depth 1 deps/libdshowcapture/src
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

# VERSIONING. OBS derives its version from `git describe` unless
# OBS_VERSION_OVERRIDE is defined (cmake/common/versionconfig.cmake). A shallow
# clone has no tags, so describe returns "fb4d98b-modified", the canonical-version
# regex does not match it, and configure dies with
#   list index: 1 out of range   /   VERSION "fb4d98b-modified" format invalid
#
# The -D is the macOS fix and is kept, but on the Windows runner it did NOT take
# effect - CI run 33580195037 hit exactly the describe-derived error above - so
# ALSO give the shallow clone the tag the lock names. describe then yields
# "32.1.2-modified", which the regex DOES match, and the version is right
# whichever path versionconfig takes. Belt and braces, deliberately.
git -C "$SRC_DIR" tag -f "$OBS_REF" "$OBS_COMMIT" >/dev/null
echo "obs version: describe=$(git -C "$SRC_DIR" describe --always --tags --dirty=-modified) ref=[$OBS_REF]"

set -x
cmake --preset producer-windows -S "$SRC_DIR" -DOBS_VERSION_OVERRIDE="$OBS_REF"
set +x
# `cmake --build --preset` has no -S; presets resolve from cwd (same quirk the
# macOS script documents).
(cd "$SRC_DIR" && cmake --build --preset producer-windows)

# obs-browser-helper is declared EXCLUDE_FROM_ALL in obs-browser's
# cmake/os-windows.cmake, so the default target does NOT build it. It is the CEF
# subprocess (OUTPUT_NAME obs-browser-page), and browser sources cannot render a
# single frame without it, so build it by name.
if engine_plugins windows | grep -qx obs-browser; then
  (cd "$SRC_DIR" && cmake --build --preset producer-windows --target obs-browser-helper)
fi

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

# WHOLESALE, not *.dll + *.exe. obs.dll's dependency closure in rundir's bin
# includes non-DLL runtime files, and a *.dll glob would silently drop them.
# (The CEF payload is NOT here - it goes beside obs-browser.dll in
# obs-plugins/64bit; see the CEF section below for the three reasons why.)
# obs64.exe rides along; it is inert and useful for debugging.
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

# THE CEF SUBPROCESS EXECUTABLE. On Windows obs-browser spawns its render, GPU
# and network processes as a separate exe, and it ships in obs-plugins/64bit
# NEXT TO the plugin DLL - not in bin/. The loop above copies $p.dll only, so
# without this it is silently dropped, and that failure is the worst shape there
# is: the plugin loads, CefInitialize succeeds, and every browser source is black
# because no subprocess can spawn. Its absence means the CEF build half-failed,
# so this is fatal rather than a warning.
if engine_plugins windows | grep -qx obs-browser; then
  # rundir first: set_target_properties_obs stages it there via a post-build copy.
  # The build-tree fallback covers a helper that built but was not copied, which
  # is a different failure from one that never built at all.
  page="$PLUGIN_SRC/obs-browser-page.exe"
  [[ -f $page ]] || page="$(find "$BUILD" -name obs-browser-page.exe -print -quit 2>/dev/null || true)"
  if [[ -n $page && -f $page ]]; then
    cp "$page" "$STAGE/obs-plugins/64bit/"
    echo "staged CEF subprocess: obs-browser-page.exe ($page)"
  else
    echo "FATAL: obs-browser-page.exe not built - browser sources cannot render" >&2
    exit 1
  fi
fi

# Plugin data (locale, effects, and obs-browser's CEF payload).
DATA_SRC="$BUILD/rundir/Release/data"
[[ -d "$DATA_SRC" ]] && cp -R "$DATA_SRC/." "$STAGE/data/"

# obs-browser is the whole reason rung 4 exists — fail loudly rather than
# shipping an engine that silently cannot render a guest.
[[ -f "$STAGE/obs-plugins/64bit/obs-browser.dll" ]] \
  || { echo "FATAL: obs-browser.dll not staged — guests cannot work without it" >&2; exit 1; }
# CEF PAYLOAD - goes in obs-plugins/64bit, NEXT TO obs-browser.dll. Not bin/.
# Three independent mechanisms point at the module's own directory, and each was
# READ rather than inferred:
#
#   1. libobs os_dlopen (libobs/util/platform-windows.c) calls
#      SetDllDirectoryW(<the module's own directory>) before LoadLibraryW, so
#      obs-browser.dll's import of libcef.dll resolves from obs-plugins/64bit.
#   2. obs-browser sets locales_dir_path to <module dir>/locales explicitly.
#   3. obs-browser does NOT set resources_dir_path, and CEF's documented default
#      for it is the directory containing libcef.dll - so icudtl.dat and the .pak
#      set must sit beside libcef.dll too.
#
# This is also exactly how a real OBS Windows install is laid out. Staging from
# CEF_ROOT rather than from rundir keeps it deterministic and avoids scooping
# non-allowlisted plugins out of the build tree.
if engine_plugins windows | grep -qx obs-browser; then
  CEF_ROOT=""
  for cand in "$SRC_DIR"/.deps/cef_binary_*_windows_x64; do
    [[ -f "$cand/Release/libcef.dll" ]] && { CEF_ROOT="$cand"; break; }
  done
  [[ -n $CEF_ROOT ]] || { echo "FATAL: no CEF distribution under $SRC_DIR/.deps" >&2; exit 1; }
  echo "CEF: $CEF_ROOT"
  # *.lib is a link-time input, not a runtime file, and cef_sandbox.lib alone is
  # hundreds of megabytes - shipping it would bloat every artifact for nothing.
  find "$CEF_ROOT/Release" -maxdepth 1 -type f ! -name "*.lib" -exec cp {} "$STAGE/obs-plugins/64bit/" \;
  cp -R "$CEF_ROOT/Resources/." "$STAGE/obs-plugins/64bit/"

  # Fatal, not a warning: after an explicit copy from the CEF distribution, a
  # missing piece means the distribution itself is wrong.
  for cef in libcef.dll icudtl.dat locales; do
    [[ -e "$STAGE/obs-plugins/64bit/$cef" ]] || { echo "FATAL: CEF payload missing $cef after staging from $CEF_ROOT" >&2; exit 1; }
  done
  echo "staged CEF payload beside obs-browser.dll"
fi

cp "$SRC_DIR/COPYING" "$STAGE/licenses/" 2>/dev/null || true

write_manifest "$STAGE" "source-build:$OBS_COMMIT:producer-windows"
pack_artifact "$STAGE"
echo "engine staged: $STAGE"
