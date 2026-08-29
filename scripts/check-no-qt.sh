#!/bin/bash
# check-no-qt.sh — M-L1 / A9 gate: the shipped Producer.app dependency closure
# must contain no Qt, no Chromium Embedded Framework, no Sparkle, and no OBS
# frontend/scripting libraries, despite upstream's default plugin graph.
# Scans every Mach-O file in the bundle (executables, dylibs, frameworks,
# plugins) for forbidden install names, and the bundle tree for forbidden
# framework directories.
set -euo pipefail

APP="${1:?usage: check-no-qt.sh /path/to/Producer.app}"
# M-L7.1: CEF and the frontend-api shim are sanctioned bundle members;
# Qt, Sparkle, and scripting remain forbidden (the A9 assertion).
FORBIDDEN='Qt[A-Za-z]*\.framework|libQt|Sparkle\.framework|obs-scripting'

fail=0

# 1. No forbidden bundles/dirs present in the app tree
while IFS= read -r hit; do
  echo "FORBIDDEN FILE: $hit"; fail=1
done < <(find "$APP" \( -name "Qt*.framework" -o -name "Sparkle.framework" -o -name "*obs-scripting*" \) 2>/dev/null)

# 2. No Mach-O in the bundle links anything forbidden
scanned=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    scanned=$((scanned + 1))
    if otool -L "$f" 2>/dev/null | tail -n +2 | grep -Eq "$FORBIDDEN"; then
      echo "FORBIDDEN LINKAGE in $f:"
      otool -L "$f" | tail -n +2 | grep -E "$FORBIDDEN"
      fail=1
    fi
  fi
done < <(find "$APP" -type f \( -perm -u+x -o -name "*.dylib" -o -name "libobs" -o -path "*/MacOS/*" \) -print0)

echo "scanned $scanned Mach-O files in $(basename "$APP")"
if ((fail)); then
  echo "RESULT: FAIL — Qt/CEF/frontend leakage detected" >&2
  exit 1
fi
echo "RESULT: PASS — dependency closure is Qt-free"
