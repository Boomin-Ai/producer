#!/bin/bash
# engine-closure.sh — compute the @rpath dependency closure of the allowlisted
# OBS engine set inside an OBS.app bundle, and fail on any Qt/CEF/frontend leak.
# Used by extract-engine.sh and by the M-L1 zero-Qt acceptance gate.
set -euo pipefail

CONTENTS="${1:?usage: engine-closure.sh /path/to/OBS.app/Contents}"

# ONE plugin list. A private copy here once drifted from engine-lib.sh and
# let obs-ffmpeg ship without libavdevice — the exact failure class this
# gate exists to catch. Never fork this list again.
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"
PLUGINS=("${ENGINE_PLUGINS[@]}")

seeds=("$CONTENTS/Frameworks/libobs.framework/Versions/A/libobs"
  "$CONTENTS/Frameworks/libobs-metal.dylib"
  "$CONTENTS/Frameworks/libobs-opengl.dylib")
for p in "${PLUGINS[@]}"; do
  seeds+=("$CONTENTS/PlugIns/$p.plugin/Contents/MacOS/$p")
done
# M-L7.1: obs-browser joins the walk when the artifact carries it
if [[ -f "$CONTENTS/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser" ]]; then
  seeds+=("$CONTENTS/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser")
fi
# obs-ffmpeg-mux: bin/ in the artifact stage, MacOS/ in the assembled app.
for mux in "$CONTENTS/bin/obs-ffmpeg-mux" "$CONTENTS/MacOS/obs-ffmpeg-mux"; do
  [[ -f $mux ]] && seeds+=("$mux")
done

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
