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
PLUGDIR="$STAGE/obs-plugins/64bit"
if [[ -f "$PLUGDIR/obs-browser.dll" ]]; then
  echo "  ok   obs-browser present"
  # CEF IS NOT ONE FILE. libcef.dll alone is not a loadable CEF: init reads
  # icudtl.dat and the locales/ directory, and dies without them. A staging step
  # that copies only *.dll passes a libcef-only check and still ships an engine
  # where every guest tile is black. So these are FAILURES, not warnings - same
  # severity as a missing libcef.dll, because the outcome is identical.
  for cef in libcef.dll icudtl.dat locales; do
    if [[ -e "$PLUGDIR/$cef" ]]; then
      echo "  ok   CEF payload $cef"
    else
      echo "  FAIL CEF payload MISSING: obs-plugins/64bit/$cef - obs-browser cannot initialise" >&2
      found="$(find "$STAGE" -name "$cef" -print -quit 2>/dev/null || true)"
      [[ -n $found ]] && echo "       (it exists at $found - staging put it in the wrong place)" >&2
      fail=1
    fi
  done
  # THE CEF SUBPROCESS EXECUTABLE, and it lives in obs-plugins/64bit next to the
  # plugin DLL rather than in bin/. Same severity as libcef.dll: without it the
  # plugin loads, CefInitialize succeeds, and every browser source is black
  # because no render/GPU/network subprocess can spawn - a failure nothing else
  # here would catch.
  helper_exe="$(lock_get_file engine/producer-presets.json "[c for c in d['configurePresets'] if c['name']=='producer-windows'][0]['cacheVariables']['BROWSER_HELPER_OUTPUT_NAME']['value']").exe"
  if [[ -f "$PLUGDIR/$helper_exe" ]]; then
    echo "  ok   CEF subprocess $helper_exe"
  else
    echo "  FAIL $helper_exe MISSING - browser sources render black" >&2
    fail=1
  fi
  # The .pak set is versioned by CEF build (resources.pak, chrome_100_percent.pak,
  # ...), so glob rather than pinning a list that will rot at the next CEF bump.
  if ! compgen -G "$PLUGDIR/*.pak" >/dev/null; then
    echo "  FAIL no CEF .pak resources beside obs-browser.dll (resources.pak, chrome_*.pak)" >&2
    fail=1
  else
    echo "  ok   CEF .pak resources present"
  fi
  # CEF angle/vulkan sidecars. cp -R scoops these, so this is a WARN rather than
  # a gate failure - but listing what it verified tells a future reader the sweep
  # was real rather than assumed.
  for side in libEGL.dll libGLESv2.dll d3dcompiler_47.dll vk_swiftshader.dll vk_swiftshader_icd.json; do
    if [[ -e "$PLUGDIR/$side" ]]; then echo "  ok   CEF sidecar $side"
    else echo "  warn CEF sidecar absent: $side (GPU fallback may be degraded)"; fi
  done
else
  echo "  FAIL obs-browser MISSING - guests cannot render without it" >&2
  fail=1
fi

# ── 2b. the DirectShow virtual camera filter ─────────────────────────────────
# win-dshow builds it (ENABLE_VIRTUALCAM) into data/obs-plugins/win-dshow as the
# 64- and 32-bit COM modules the installer registers with regsvr32. Without them
# "Install cam" has nothing to install and the virtualcam_output has no reader.
for m in obs-virtualcam-module64.dll obs-virtualcam-module32.dll; do
  if [[ -f "$STAGE/data/obs-plugins/win-dshow/$m" ]]; then
    echo "  ok   virtual camera $m"
  else
    echo "  FAIL virtual camera MISSING: data/obs-plugins/win-dshow/$m" >&2
    fail=1
  fi
done

# The camera's IDLE image: win-dshow's filter loads placeholder.png from beside
# its DLL at runtime and upstream's is the OBS logo. The build stages Producer's
# (engine/assets/vcam-placeholder.png, the same file macOS bakes into its
# extension); the gate proves the staged bytes are ours, not upstream's.
want="$(sha256_of "$REPO_ROOT/engine/assets/vcam-placeholder.png")"
have="$(sha256_of "$STAGE/data/obs-plugins/win-dshow/placeholder.png" 2>/dev/null || echo missing)"
if [[ "$want" == "$have" ]]; then
  echo "  ok   virtual camera placeholder is Producer's"
else
  echo "  FAIL virtual camera placeholder is not Producer's (staged $have)" >&2
  fail=1
fi

# ── 3. zero-Qt scan + import closure ────────────────────────────────────────
# resolve_python (engine-lib.sh) probes candidates by EXECUTING them, because
# Windows ships a python3 App Execution Alias that exists on PATH and fails when
# run - so presence is not proof, and a silent no-op here reads as a clean pass.
python_bin="$(resolve_python)"

# host_path: native Windows python cannot open an MSYS /c/... path. Without this
# an absolute stage path walks NOTHING, prints "scanned 0 binaries" and PASSES.
"$python_bin" - "$(host_path "$STAGE")" <<'PY'
import os, re, sys

stage = sys.argv[1]
if not os.path.isdir(stage):
    print(f"  FAIL python cannot see the stage dir: {stage}", file=sys.stderr)
    sys.exit(1)
# Import-table names, not display strings: a binary that LINKS Qt must reference
# the DLL by name. Case-insensitive because import casing is not normalised.
pattern = re.compile(rb"Qt[56][A-Za-z]*\.dll", re.IGNORECASE)

have = set()      # every binary the artifact ships, lowercased
imports = {}      # binary -> the DLL names it imports

def pe_imports(blob):
    """Import-table DLL names, or [] if the file is not a PE we can read."""
    try:
        pe = int.from_bytes(blob[0x3C:0x40], 'little')
        if blob[pe:pe+4] != b'PE\0\0':
            return []
        nsec = int.from_bytes(blob[pe+6:pe+8], 'little')
        optsz = int.from_bytes(blob[pe+20:pe+22], 'little')
        opt = pe + 24
        magic = int.from_bytes(blob[opt:opt+2], 'little')
        dd = opt + (112 if magic == 0x20b else 96)
        imp_rva = int.from_bytes(blob[dd+8:dd+12], 'little')
        if not imp_rva:
            return []
        secs = []
        so = opt + optsz
        for s in range(nsec):
            o = so + s*40
            vsz = int.from_bytes(blob[o+8:o+12], 'little')
            vaddr = int.from_bytes(blob[o+12:o+16], 'little')
            rawptr = int.from_bytes(blob[o+20:o+24], 'little')
            secs.append((vaddr, vsz, rawptr))
        def r2o(rva):
            for va, vs, rp in secs:
                if va <= rva < va + max(vs, 1):
                    return rp + (rva - va)
            return None
        out, o = [], r2o(imp_rva)
        if o is None:
            return []
        while True:
            ent = blob[o:o+20]
            if len(ent) < 20 or ent == b'\0'*20:
                break
            namerva = int.from_bytes(ent[12:16], 'little')
            if not namerva:
                break
            no = r2o(namerva)
            if no is None:
                break
            out.append(blob[no:blob.index(b'\0', no)].decode('ascii', 'replace').lower())
            o += 20
        return out
    except Exception:
        return []

offenders = []
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
        have.add(n.lower())
        imports[n.lower()] = pe_imports(blob)
        hits = sorted({m.group(0).decode("ascii", "replace") for m in pattern.finditer(blob)})
        if hits:
            offenders.append((os.path.relpath(path, stage), hits))

print(f"  scanned {scanned} binaries for Qt imports")
# A scan that examined nothing is not a pass. Any real engine has dozens of
# binaries; zero means the walk went somewhere wrong.
if scanned == 0:
    print("  FAIL scanned 0 binaries - the Qt scan examined nothing", file=sys.stderr)
    sys.exit(1)
if offenders:
    print("  FAIL Qt found in the shipped closure:", file=sys.stderr)
    for rel, hits in offenders:
        print(f"    {rel}: {', '.join(hits)}", file=sys.stderr)
    sys.exit(1)
print("  ok   zero-Qt closure")

# ── IMPORT CLOSURE ───────────────────────────────────────────────────────────
# The macOS gate walks @rpath and asserts every dependency EXISTS in the
# artifact. The Windows gate did not, and that gap shipped: obs.dll imports
# avcodec/avformat/avutil/swscale/swresample/zlib from obs-deps, the no-frontend
# build never copies them into rundir, and nothing noticed --- because a dev box
# happened to have them beside the executable from an unrelated extract.
#
# A DLL is satisfied if it is IN the artifact, or is a real Windows system DLL,
# or is an API set. Testing System32 by existence rather than keeping a hand
# list means the check cannot rot.
sysroot = os.environ.get('SystemRoot', r'C:\Windows')
def satisfied(dep):
    if dep in have:
        return True
    if dep.startswith('api-ms-win-') or dep.startswith('ext-ms-'):
        return True
    return os.path.exists(os.path.join(sysroot, 'System32', dep))

unmet = {}
for owner, deps in imports.items():
    for d in deps:
        if not satisfied(d):
            unmet.setdefault(d, []).append(owner)

if unmet:
    print(f"  FAIL {len(unmet)} unresolved imports --- the artifact is NOT self-contained:", file=sys.stderr)
    for dep in sorted(unmet):
        owners = ', '.join(sorted(unmet[dep])[:3])
        print(f"    {dep}  <- {owners}", file=sys.stderr)
    sys.exit(1)
print(f"  ok   import closure ({len(have)} binaries, every dependency resolved)")
PY

if [[ $fail -ne 0 ]]; then
  echo "RESULT: FAIL — Windows engine closure gate" >&2
  exit 1
fi
echo "RESULT: PASS — Windows engine closure gate"
