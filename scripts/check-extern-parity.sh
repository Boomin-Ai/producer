#!/bin/bash
# ffi.rs ↔ shim parity, enforced without an engine or a compiler.
#
# ffi.rs declares one set of `producer_*` symbols for every platform; shim.m
# (macOS) and shim_win.c (Windows) must each define every one their platform
# links. The Windows CI job is an engine-less `cargo check`, so shim_win.c is
# never compiled there, and a symbol declared in ffi.rs but missing from
# shim_win.c fails only at the real Windows link -- silently, on a release
# build. That is how v0.4.10-14 shipped without `producer_copy_text` (#21).
#
# This walks the `extern "C"` blocks of ffi.rs and checks, per platform, that
# every shim-owned function has a C definition (a function whose name opens a
# definition at column 0 -- not a comment, prototype, or #define).
#
# Scope rules, derived from how ffi.rs is actually laid out:
#   * blocks carrying `link(name = "obs", ...)` are libobs imports -> skipped.
#   * a block or item under `#[cfg(target_os = "macos")]` / `#[cfg(not(windows))]`
#     needs shim.m only; under `#[cfg(target_os = "windows")]` / `#[cfg(windows)]`
#     needs shim_win.c only; unconditional needs BOTH.
#   * in an OS-gated block, names that are not `producer_*` are system symbols
#     (CoreGraphics, GCD, ...) and are listed but not checked.
#   * `static` items are not functions and are skipped.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
import re, sys

FFI = "src-tauri/src/live/ffi.rs"
SHIMS = {"macos": "src-tauri/src/live/shim.m", "windows": "src-tauri/src/live/shim_win.c"}

def cfg_platform(attr):
    """Map a #[cfg(...)] / #[cfg_attr(...)] attribute to a platform, or None."""
    m = re.match(r'#\[cfg\((.*)\)\]$', attr.strip())
    if not m:
        return None            # cfg_attr and other attributes are not gates
    body = m.group(1).replace(" ", "")
    neg = body.startswith("not(")
    if "target_os=\"macos\"" in body:
        return "windows" if neg else "macos"
    if "target_os=\"windows\"" in body or body in ("windows", "not(windows)"):
        return "macos" if neg else "windows"
    return None

# ---- 1. parse ffi.rs -----------------------------------------------------
src = open(FFI, encoding="utf-8").read()
lines = src.splitlines()

declared = []   # (name, platforms, line)
system = []     # (name, platform) -- OS symbols we do not check
i = 0
while i < len(lines):
    line = lines[i]
    if re.match(r'^\s*(pub\s+)?extern\s+"C"\s*\{', line):
        # attributes are the contiguous #[...] lines directly above the block
        attrs, j = [], i - 1
        while j >= 0 and lines[j].strip().startswith("#["):
            attrs.append(lines[j].strip()); j -= 1
        is_obs = any('link(name = "obs"' in a or 'link(name="obs"' in a for a in attrs)
        block_plat = next((p for p in (cfg_platform(a) for a in attrs) if p), None)
        # walk the block body, tracking per-item cfg attributes
        depth, item_plat, k = 0, None, i
        buf = ""
        while k < len(lines):
            l = lines[k]
            depth += l.count("{") - l.count("}")
            s = l.strip()
            if s.startswith("#[") and k != i:
                item_plat = cfg_platform(s) or item_plat
            elif re.match(r'^(pub\s+)?static\b', s):
                item_plat = None
            elif re.match(r'^(pub\s+)?fn\s+', s):
                m = re.match(r'^(?:pub\s+)?fn\s+([A-Za-z_]\w*)', s)
                name = m.group(1)
                if not is_obs:
                    plat = item_plat or block_plat
                    if plat and not name.startswith("producer_"):
                        system.append((name, plat))
                    else:
                        declared.append((name, [plat] if plat else ["macos", "windows"], k + 1))
                item_plat = None
            if depth <= 0 and k > i:
                break
            k += 1
        i = k
    i += 1

if not declared:
    print(f"FAIL: parsed no shim externs from {FFI}; the layout changed and this gate is blind.", file=sys.stderr)
    sys.exit(2)

# ---- 2. collect C definitions ------------------------------------------
def c_definitions(path):
    text = open(path, encoding="utf-8").read()
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)         # block comments
    text = re.sub(r'//[^\n]*', '', text)                         # line comments
    text = re.sub(r'^[ \t]*#[^\n]*$', '', text, flags=re.M)      # preprocessor
    defs = set()
    for m in re.finditer(r'^[A-Za-z_][\w\s\*]*?\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{', text, flags=re.M):
        if m.group(1) not in ("if", "while", "for", "switch", "return", "sizeof"):
            defs.add(m.group(1))
    return defs

defs = {p: c_definitions(f) for p, f in SHIMS.items()}

# ---- 3. diff --------------------------------------------------------------
missing = {p: [] for p in SHIMS}
for name, plats, bl in declared:
    for p in plats:
        if name not in defs[p]:
            missing[p].append((name, bl))

width = max(len(n) for n, _, _ in declared)
print(f"extern parity: {len(declared)} shim function(s) declared in {FFI}"
      f" ({len(system)} OS symbol(s) skipped)")
print(f"  {'symbol'.ljust(width)}  macOS  windows")
for name, plats, _ in declared:
    cells = []
    for p in ("macos", "windows"):
        if p not in plats:
            cells.append("  -  ")
        else:
            cells.append(" ok  " if name in defs[p] else "MISSING")
    print(f"  {name.ljust(width)}  {cells[0]}  {cells[1]}")

gaps = sum(len(v) for v in missing.values())
if gaps:
    print()
    print(f"FAIL: {gaps} extern(s) declared in {FFI} have no definition in their shim:", file=sys.stderr)
    for p, f in SHIMS.items():
        for name, bl in missing[p]:
            print(f"  {p:<8} {f}: missing `{name}` (declared {FFI}:{bl})", file=sys.stderr)
    print("  Add the definition (a `// TODO(win): no-op` stub that returns the"
          " happy-path default is fine) or gate the extern with #[cfg].", file=sys.stderr)
    sys.exit(1)

print(f"RESULT: PASS — every ffi.rs extern is defined in its shim")
PY
