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
mkdir -p "$CONTENTS/Resources/licenses"
cp -R "$STAGE/licenses/." "$CONTENTS/Resources/licenses/" 2>/dev/null || true

# Inner→outer signing: leaf dylibs, then framework bundles, then plugin
# bundles, then the app itself. --force replaces the signatures the engine
# binaries arrived with (OBS's or a previous run's).
# Secure timestamps are required by notarization on every nested Mach-O.
# (Changed from --timestamp=none per the release-pipeline handoff note.)
sign() { codesign --force --timestamp --options runtime --sign "$IDENT" "$@"; }
if [[ $IDENT == "-" ]]; then
  # ad-hoc signatures cannot carry the hardened runtime flag usefully in dev
  sign() { codesign --force --sign - "$@"; }
fi

# M-L7.1: CEF framework and helper apps sign before everything that loads
# them. Helper entitlements (JIT etc.) come from the artifact's signing/ dir
# and only apply under a real identity (hardened runtime).
if [[ -d "$CONTENTS/Frameworks/Chromium Embedded Framework.framework" ]]; then
  sign "$CONTENTS/Frameworks/Chromium Embedded Framework.framework"
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
    codesign --force --timestamp --options runtime --entitlements "$ent" --sign "$IDENT" "$helper"
  else
    sign "$helper"
  fi
done
find "$CONTENTS/Frameworks" -maxdepth 1 -name "*.dylib" -print0 | while IFS= read -r -d '' f; do sign "$f"; done
sign "$CONTENTS/Frameworks/libobs.framework"
find "$CONTENTS/PlugIns" -maxdepth 1 -name "*.plugin" -print0 | while IFS= read -r -d '' p; do sign "$p"; done
sign "$APP"

codesign --verify --deep --strict "$APP"
echo "assembled + signed: $APP (identity: $IDENT)"
