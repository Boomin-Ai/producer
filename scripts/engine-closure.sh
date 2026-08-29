#!/bin/bash
# engine-closure.sh — compute the @rpath dependency closure of the allowlisted
# OBS engine set inside an OBS.app bundle, and fail on any Qt/CEF/frontend leak.
# Used by extract-engine.sh and by the M-L1 zero-Qt acceptance gate.
set -euo pipefail

CONTENTS="${1:?usage: engine-closure.sh /path/to/OBS.app/Contents}"

PLUGINS=(mac-capture mac-avcapture mac-videotoolbox coreaudio-encoder obs-x264
  obs-outputs rtmp-services image-source text-freetype2 obs-filters
  obs-transitions)

seeds=("$CONTENTS/Frameworks/libobs.framework/Versions/A/libobs"
  "$CONTENTS/Frameworks/libobs-metal.dylib"
  "$CONTENTS/Frameworks/libobs-opengl.dylib")
for p in "${PLUGINS[@]}"; do
  seeds+=("$CONTENTS/PlugIns/$p.plugin/Contents/MacOS/$p")
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
    *Qt*|*Chromium*|*obs-frontend-api*|*obs-scripting*|*Sparkle*)
      echo "VIOLATION: $d" >&2; violations=1;;
  esac
done
exit $violations
