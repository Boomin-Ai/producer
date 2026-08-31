#!/bin/bash
# assemble-engine-bundle.sh — inject the Producer engine artifact into a built
# Producer.app per LIVE-REVIEW.md §5.2 (OBS-native topology), then codesign
# inner→outer. Local dev signs ad-hoc ("-"); CI passes a Developer ID via
# CODESIGN_IDENT and notarizes afterwards.
#
# usage: assemble-engine-bundle.sh /path/to/Producer.app [engine_stage_dir]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"

APP="${1:?usage: assemble-engine-bundle.sh /path/to/Producer.app [engine_stage_dir]}"
STAGE="${2:-$ARTIFACT_DIR/$(artifact_name)}"
IDENT="${CODESIGN_IDENT:--}"

[[ -d $APP/Contents ]] || { echo "FATAL: $APP is not an app bundle" >&2; exit 1; }
[[ -d $STAGE/Frameworks ]] || { echo "FATAL: engine stage $STAGE missing (run extract-engine.sh or build-engine.sh)" >&2; exit 1; }

CONTENTS="$APP/Contents"
mkdir -p "$CONTENTS/Frameworks" "$CONTENTS/PlugIns"

# §5.2: Frameworks/ (libobs + backends + dylib closure), PlugIns/ (allowlist,
# each bundle carrying its own Resources data tree).
cp -R "$STAGE/Frameworks/." "$CONTENTS/Frameworks/"
cp -R "$STAGE/PlugIns/." "$CONTENTS/PlugIns/"
# Virtual camera (R13): the CoreMediaIO extension ships INSIDE the app at
# Contents/Library/SystemExtensions and is activated at runtime.
#
# 🔴 macOS requires a system extension's bundle id to be PREFIXED BY THE
# CONTAINING APP'S id. The upstream bundle is com.obsproject.* , which is not
# a child of ai.boomin.producer, so it is rejected outright. Rebrand it in
# place: directory, CFBundleIdentifier, CFBundleExecutable, the executable
# file itself, and the CMIO Mach service name (which must be
# <TeamID>.<bundle id> — it still carries OBS's team prefix otherwise).
VCAM_EXT_ID="ai.boomin.producer.camera-extension"
# Prefer the extension we BUILD (scripts/build-camera-extension.sh): its
# identifiers are set at compile time, so it has our name and our service
# identity rather than a rewritten Info.plist over OBS's compiled one.
BUILT_EXT="$(cd "$(dirname "$0")/.." && pwd)/engine/camera-extension/$VCAM_EXT_ID.systemextension"
if [[ -d $BUILT_EXT ]]; then
  rm -rf "$CONTENTS/Library/SystemExtensions"
  mkdir -p "$CONTENTS/Library/SystemExtensions"
  cp -R "$BUILT_EXT" "$CONTENTS/Library/SystemExtensions/"
elif [[ -d "$STAGE/SystemExtensions" ]]; then
  # Start clean: a previously rebranded bundle would otherwise be moved
  # INTO itself on the next assemble.
  rm -rf "$CONTENTS/Library/SystemExtensions"
  mkdir -p "$CONTENTS/Library/SystemExtensions"
  cp -R "$STAGE/SystemExtensions/." "$CONTENTS/Library/SystemExtensions/"
  for ext in "$CONTENTS/Library/SystemExtensions/"*.systemextension; do
    [[ -d $ext ]] || continue
    old_id="$(basename "$ext" .systemextension)"
    [[ $old_id == "$VCAM_EXT_ID" ]] && continue
    new_ext="$(dirname "$ext")/$VCAM_EXT_ID.systemextension"
    mv "$ext" "$new_ext"
    if [[ -f "$new_ext/Contents/MacOS/$old_id" ]]; then
      mv "$new_ext/Contents/MacOS/$old_id" "$new_ext/Contents/MacOS/$VCAM_EXT_ID"
    fi
    plutil -replace CFBundleIdentifier -string "$VCAM_EXT_ID" "$new_ext/Contents/Info.plist"
    plutil -replace CFBundleExecutable -string "$VCAM_EXT_ID" "$new_ext/Contents/Info.plist"
    plutil -replace CMIOExtension.CMIOExtensionMachServiceName \
      -string "9936A69867.$VCAM_EXT_ID" "$new_ext/Contents/Info.plist"
    # The old signature covers the old names — it must be replaced wholesale.
    rm -rf "$new_ext/Contents/_CodeSignature"
  done
fi

# Provisioning profile: profile-backed entitlements (system extension, app
# groups) are only honoured when the profile ships INSIDE the bundle. Without
# it launchd refuses to spawn the app at all.
# ⚠️ scripts/entitlements-*.plist carry NO XML comments. AMFI's parser is
# stricter than plutil's — a comment there fails signing with
# "AMFIUnserializeXML: syntax error" while `plutil -lint` still says OK.
#
# entitlements-app.plist: camera + mic (hardened runtime gates capture behind
# them) and system-extension.install, which is profile-backed — see below.
# entitlements-camera-extension.plist: sandbox only. The upstream extension
# also claims an app group; no profile of ours authorizes it, and an
# unauthorized entitlement makes the installer report "code signature
# invalid" even though `codesign --verify` calls the bundle valid on disk.
# Fail the build if the plugin-list fork ever comes back (it has, twice).
"$(cd "$(dirname "$0")" && pwd)/check-engine-lists.sh"

PROFILE_SRC="$(cd "$(dirname "$0")" && pwd)/embedded.provisionprofile"
if [[ -f $PROFILE_SRC ]]; then
  cp "$PROFILE_SRC" "$CONTENTS/embedded.provisionprofile"
fi

mkdir -p "$CONTENTS/Resources/licenses"
cp -R "$STAGE/licenses/." "$CONTENTS/Resources/licenses/" 2>/dev/null || true

# Recording/replay: obs-ffmpeg-mux sits beside the Producer executable
# (libobs resolves it relative to the running binary).
if [[ -f "$STAGE/bin/obs-ffmpeg-mux" ]]; then
  cp "$STAGE/bin/obs-ffmpeg-mux" "$CONTENTS/MacOS/"
fi

# Inner→outer signing: leaf dylibs, then framework bundles, then plugin
# bundles, then the app itself. --force replaces the signatures the engine
# binaries arrived with (OBS's or a previous run's).
# Secure timestamps are required by notarization on every nested Mach-O.
# (Changed from --timestamp=none per the release-pipeline handoff note.)
# Local dev iteration: CODESIGN_TIMESTAMP=none skips the per-file network
# roundtrip to Apple's timestamp server (NEVER set it for release builds).
TS_FLAG="--timestamp${CODESIGN_TIMESTAMP:+=$CODESIGN_TIMESTAMP}"
sign() { codesign --force "$TS_FLAG" --options runtime --sign "$IDENT" "$@"; }
if [[ $IDENT == "-" ]]; then
  # ad-hoc signatures cannot carry the hardened runtime flag usefully in dev
  sign() { codesign --force --sign - "$@"; }
fi

# M-L7.1: CEF framework and helper apps sign before everything that loads
# them. Helper entitlements (JIT etc.) come from the artifact's signing/ dir
# and only apply under a real identity (hardened runtime).
if [[ -d "$CONTENTS/Frameworks/Chromium Embedded Framework.framework" ]]; then
  # Notarization requires EVERY nested Mach-O signed (v0.2.1 lesson: Apple
  # returns Invalid for CEF's inner Libraries/*.dylib) — sign leaves first,
  # then the framework bundle itself.
  find "$CONTENTS/Frameworks/Chromium Embedded Framework.framework" -name "*.dylib" -type f -print0 \
    | while IFS= read -r -d '' f; do sign "$f"; done
  sign "$CONTENTS/Frameworks/Chromium Embedded Framework.framework"
fi
if [[ -f "$CONTENTS/MacOS/obs-ffmpeg-mux" ]]; then
  sign "$CONTENTS/MacOS/obs-ffmpeg-mux"
fi
for helper in "$CONTENTS/Frameworks/"*" Helper"*.app; do
  [[ -d $helper ]] || continue
  ent=""
  case "$helper" in
    *"(GPU)"*) ent="$STAGE/signing/entitlements-helper.gpu.plist" ;;
    *"(Plugin)"*) ent="$STAGE/signing/entitlements-helper.plugin.plist" ;;
    *"(Renderer)"*) ent="$STAGE/signing/entitlements-helper.renderer.plist" ;;
    *) ent="$STAGE/signing/entitlements-helper.plist" ;;
  esac
  if [[ $IDENT != "-" && -f $ent ]]; then
    codesign --force "$TS_FLAG" --options runtime --entitlements "$ent" --sign "$IDENT" "$helper"
  else
    sign "$helper"
  fi
done
find "$CONTENTS/Frameworks" -maxdepth 1 -name "*.dylib" -print0 | while IFS= read -r -d '' f; do sign "$f"; done
sign "$CONTENTS/Frameworks/libobs.framework"
find "$CONTENTS/PlugIns" -maxdepth 1 -name "*.plugin" -print0 | while IFS= read -r -d '' p; do sign "$p"; done

# The system extension carries its OWN entitlements (its app group must match
# the host's). Re-signing with our identity re-points $(TeamIdentifierPrefix)
# at our team on both sides, which is what lets them find each other.
for ext in "$CONTENTS/Library/SystemExtensions/"*.systemextension; do
  [[ -d $ext ]] || continue
  ext_ent="$(cd "$(dirname "$0")" && pwd)/entitlements-camera-extension.plist"
  if [[ $IDENT != "-" && -f $ext_ent ]]; then
    # The inner executable carries its OWN Mach-O entitlements from the
    # upstream build (including an app group no profile of ours authorizes).
    # Signing only the bundle leaves those in place and the installer reads
    # the result as "code signature invalid" — sign the executable first.
    for exe in "$ext/Contents/MacOS/"*; do
      [[ -f $exe ]] || continue
      codesign --force "$TS_FLAG" --options runtime --entitlements "$ext_ent" --sign "$IDENT" "$exe"
    done
    codesign --force "$TS_FLAG" --options runtime --entitlements "$ext_ent" --sign "$IDENT" "$ext"
  else
    sign "$ext"
  fi
done
# The app itself needs the device-capture entitlements under hardened
# runtime — a real-identity build without them can hold a TCC grant it is
# not allowed to use.
APP_ENT="$(cd "$(dirname "$0")" && pwd)/entitlements-app.plist"
if [[ $IDENT != "-" && -f $APP_ENT ]]; then
  codesign --force "$TS_FLAG" --options runtime --entitlements "$APP_ENT" --sign "$IDENT" "$APP"
else
  sign "$APP"
fi

codesign --verify --deep --strict "$APP"
echo "assembled + signed: $APP (identity: $IDENT)"
