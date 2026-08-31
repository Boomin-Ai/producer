#!/bin/bash
# engine-closure.sh — compute the @rpath dependency closure of the allowlisted
# OBS engine set inside an OBS.app bundle, and fail on any Qt/CEF/frontend leak.
# Used by extract-engine.sh and by the M-L1 zero-Qt acceptance gate.
set -euo pipefail

CONTENTS="${1:?usage: engine-closure.sh /path/to/OBS.app/Contents}"

# 🔴 ONE plugin list, always. A private copy here once drifted from
# engine-lib.sh and shipped obs-ffmpeg without libavdevice/libavfilter while
# this gate stayed green — the exact failure class the gate exists to catch.
# It regressed a second time on 2026-08-31 via `git checkout` of this file,
# breaking obs-ffmpeg AND mac-virtualcam at dyld load. Never fork the list.
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"
PLUGINS=("${ENGINE_PLUGINS[@]}")

seeds=("$CONTENTS/Frameworks/libobs.framework/Versions/A/libobs"
  "$CONTENTS/Frameworks/libobs-metal.dylib"
  "$CONTENTS/Frameworks/libobs-opengl.dylib")
for p in "${PLUGINS[@]}"; do
  seeds+=("$CONTENTS/PlugIns/$p.plugin/Contents/MacOS/$p")
done
# M-L7.1: obs-browser joins the walk when the artifact carries it.
#
# 🔴 Only when we are walking something we SHIP. Pointed at OBS.app (the
# extract path's dependency discovery), this used to seed OBS's own
# obs-browser — which links Qt directly, unlike the patched Qt-free build we
# actually ship. That dragged QtCore/QtGui/QtWidgets into every extraction
# and tripped this gate on an artifact that was never going to contain them.
# CLOSURE_SEED_EXTRAS=0 says "seed only the allowlisted plugin set".
if [[ ${CLOSURE_SEED_EXTRAS:-1} == 1 &&
      -f "$CONTENTS/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser" ]]; then
  seeds+=("$CONTENTS/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser")
fi

declare -a seen=()
queue=("${seeds[@]}")
while ((${#queue[@]})); do
  next=()
  for b in "${queue[@]}"; do
    [[ -f $b ]] || { echo "MISSING BINARY: $b" >&2; exit 1; }
    while IFS= read -r dep; do
      found=0
      for s in "${seen[@]:-}"; do [[ $s == "$dep" ]] && found=1 && break; done
      ((found)) && continue
      seen+=("$dep")
      f="$CONTENTS/Frameworks/$dep"
      [[ -f $f ]] && next+=("$f")
    done < <(otool -L "$b" | awk '/@rpath\//{print $1}' | sed 's|@rpath/||' \
             | grep -v '^libobs.framework')
  done
  queue=("${next[@]:-}")
  [[ ${#queue[@]} -eq 1 && -z ${queue[0]} ]] && queue=()
done

violations=0
echo "# @rpath closure beyond libobs:"
for d in $(printf '%s\n' "${seen[@]:-}" | sort -u); do
  echo "$d"
  case $d in
    # M-L7.1: CEF + the frontend-api shim are sanctioned; Qt/Sparkle/scripting stay forbidden
    *Qt*|*obs-scripting*|*Sparkle*)
      echo "VIOLATION: $d" >&2; violations=1;;
  esac
  # A dep that is linked but absent from the artifact fails at dyld load —
  # enforce existence, don't just list. (Gap found 2026-08-29: CI shipped an
  # artifact without the obs-deps dylibs and this gate stayed green.)
  if [[ ! -e "$CONTENTS/Frameworks/$d" ]]; then
    echo "MISSING DEP: $d not present in Frameworks" >&2
    violations=1
  fi
done
exit $violations
