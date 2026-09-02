#!/bin/bash
# engine-closure-windows.sh — the Windows zero-Qt gate.
#
# engine-closure.sh is macOS to its bones: otool -L, @rpath resolution,
# .framework layout, PlugIns/<p>.plugin/Contents/MacOS. None of that exists here,
# so this is a sibling rather than a port — same PURPOSE, different mechanism.
#
# What it asserts:
#   1. NO Qt in the shipped closure. Producer has no QApplication; a Qt-linked
#      binary in the artifact means the build picked up the frontend path and
#      will fail at load time, not at build time.
#   2. Every allowlisted plugin is present. A silently-missing plugin is how you
#      discover at showtime that there is no camera input.
#   3. obs-browser AND its CEF payload are present — guests are browser sources,
#      so an engine without them cannot do the thing this port exists for.
#
# Mechanism: PE import tables name their dependencies as literal strings in the
# binary, so a plain byte-scan for "Qt6*.dll" finds any Qt import WITHOUT needing
# dumpbin (MSVC-only) or a third-party PE parser. It over-approximates — a
# mention in any string would trip it — which is the correct direction for a
# gate: false alarm beats false pass.
#
# NOTE from the macOS side: a Windows red here means a BROKEN BUILD, not a
# broken gate. Qt never enters the Windows dependency closure naturally
# (obs-browser's cmake/os-windows.cmake has no find_package(Qt6) at all), so if
# this trips, something pulled in the frontend.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"

STAGE="${1:?usage: engine-closure-windows.sh <stage_dir>}"
[[ -d $STAGE ]] || { echo "FATAL: no such stage dir: $STAGE" >&2; exit 1; }

fail=0

# ── 1. plugin allowlist present ──────────────────────────────────────────────
while read -r p; do
  if [[ -f "$STAGE/obs-plugins/64bit/$p.dll" ]]; then
    echo "  ok   plugin $p"
  else
    echo "  FAIL plugin MISSING: $p" >&2
    fail=1
  fi
done < <(engine_plugins windows)

# ── 2. obs-browser + CEF, called out separately ──────────────────────────────
if [[ -f "$STAGE/obs-plugins/64bit/obs-browser.dll" ]]; then
  echo "  ok   obs-browser present"
else
  echo "  FAIL obs-browser MISSING — guests cannot render without it" >&2
  fail=1
fi
if compgen -G "$STAGE/bin/libcef.dll" >/dev/null || compgen -G "$STAGE/**/libcef.dll" >/dev/null; then
  echo "  ok   CEF payload present"
else
  echo "  FAIL libcef.dll MISSING — obs-browser cannot load" >&2
  fail=1
fi

# ── 3. zero-Qt scan ──────────────────────────────────────────────────────────
# Windows ships a "python3" App Execution Alias that EXISTS on PATH and fails
# when run, so presence is not proof. Probe each candidate by actually executing
# it — otherwise the scan silently no-ops and the gate reports a false pass.
python_bin=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "pass" >/dev/null 2>&1; then
    python_bin="$cand"; break
  fi
done
[[ -n $python_bin ]] || { echo "FATAL: a working python is required for the Qt scan" >&2; exit 1; }

"$python_bin" - "$STAGE" <<'PY' || fail=1
import os, re, sys

stage = sys.argv[1]
# Import-table names, not display strings: a binary that LINKS Qt must reference
# the DLL by name. Case-insensitive because import casing is not normalised.
pattern = re.compile(rb"Qt[56][A-Za-z]*\.dll", re.IGNORECASE)

offenders = []
scanned = 0
for root, _, names in os.walk(stage):
    for n in names:
        if not n.lower().endswith((".dll", ".exe")):
            continue
        path = os.path.join(root, n)
        scanned += 1
        try:
            with open(path, "rb") as fh:
                blob = fh.read()
        except OSError as exc:
            print(f"  WARN unreadable: {path} ({exc})")
            continue
        hits = sorted({m.group(0).decode("ascii", "replace") for m in pattern.finditer(blob)})
        if hits:
            offenders.append((os.path.relpath(path, stage), hits))

print(f"  scanned {scanned} binaries for Qt imports")
if offenders:
    print("  FAIL Qt found in the shipped closure:", file=sys.stderr)
    for rel, hits in offenders:
        print(f"    {rel}: {', '.join(hits)}", file=sys.stderr)
    sys.exit(1)
print("  ok   zero-Qt closure")
PY

if [[ $fail -ne 0 ]]; then
  echo "RESULT: FAIL — Windows engine closure gate" >&2
  exit 1
fi
echo "RESULT: PASS — Windows engine closure gate"
