#!/usr/bin/env bash
# R1 fallback for Windows (mirrors extract-engine.sh on macOS): stage the
# Producer Live engine from OBS's official signed Windows release zip.
#
# Layout law (Windows edition — OBS's own topology, no invented conventions):
#   <artifact>/                bin DLLs + encoder probe exes → install root (next to Producer.exe)
#   <artifact>/obs-plugins/64bit/*.dll                       → plugin modules
#   <artifact>/data/libobs/, data/obs-plugins/<p>/           → effect shaders + plugin data
#
# Tooling: bash + curl + tar-that-reads-zip (Windows System32 bsdtar, or any
# bsdtar/unzip) + node. No Python dependency.
#
# Usage: extract-engine-windows.sh [path-to-cached-zip]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP="${1:-/tmp/obs-windows-engine.zip}"

LOCK="$REPO_ROOT/engine/obs-windows.lock"
URL="$(grep -o '"url": "[^"]*"' "$LOCK" | head -1 | cut -d'"' -f4)"
WANT_SHA="$(grep -o '"sha256": "[^"]*"' "$LOCK" | head -1 | cut -d'"' -f4)"

if [[ ! -f "$ZIP" ]]; then
  echo "downloading $URL"
  curl -sL -o "$ZIP" "$URL"
fi
echo "$WANT_SHA *$ZIP" | shasum -a 256 -c - >/dev/null || {
  echo "FATAL: zip sha256 mismatch" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [[ -x "/c/Windows/System32/tar.exe" ]]; then
  /c/Windows/System32/tar.exe -xf "$(cygpath -w "$ZIP")" -C "$(cygpath -w "$WORK")"
else
  tar -xf "$ZIP" -C "$WORK" 2>/dev/null || unzip -q "$ZIP" -d "$WORK"
fi

W_REPO="$REPO_ROOT"; W_WORK="$WORK"
command -v cygpath >/dev/null && { W_REPO="$(cygpath -m "$REPO_ROOT")"; W_WORK="$(cygpath -m "$WORK")"; }
node - "$W_REPO" "$W_WORK" <<'EOF'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [repo, work] = process.argv.slice(2);
const lockPath = path.join(repo, "engine", "obs-windows.lock");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const lockHash = crypto.createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex").slice(0, 12);
const name = `producer-libobs-windows-${lock.arch}-${lockHash}`;
const stage = path.join(repo, "engine", "artifacts", name);

fs.rmSync(stage, { recursive: true, force: true });
for (const d of ["obs-plugins/64bit", "data/obs-plugins", "licenses"])
  fs.mkdirSync(path.join(stage, d), { recursive: true });

const die = (m) => { console.error("FATAL: " + m); process.exit(1); };
const cp = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
const cpTree = (src, dst) => { if (!fs.existsSync(src)) return false; fs.cpSync(src, dst, { recursive: true }); return true; };

for (const f of lock.bin) {
  const src = path.join(work, "bin", "64bit", f);
  if (!fs.existsSync(src)) die(`${f} missing from official build`);
  cp(src, path.join(stage, f));
}
for (const p of lock.plugins) {
  const dll = path.join(work, "obs-plugins", "64bit", `${p}.dll`);
  if (!fs.existsSync(dll)) die(`plugin ${p}.dll missing from official build`);
  cp(dll, path.join(stage, "obs-plugins", "64bit", `${p}.dll`));
  cpTree(path.join(work, "data", "obs-plugins", p), path.join(stage, "data", "obs-plugins", p));
}
if (!cpTree(path.join(work, "data", "libobs"), path.join(stage, "data", "libobs")))
  die("data/libobs (effect shaders) missing");
if (fs.existsSync(path.join(work, "COPYING")))
  cp(path.join(work, "COPYING"), path.join(stage, "licenses", "COPYING.obs-studio"));

// A9 gate, Windows edition: nothing Qt/CEF/frontend/scripting may enter.
const forbidden = ["qt6", "libcef", "chrome_elf", "obs-frontend-api", "obs-scripting", "lua51"];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(stage);
const bad = files.filter((f) => forbidden.some((x) => path.basename(f).toLowerCase().startsWith(x)));
if (bad.length) die("forbidden files staged:\n" + bad.slice(0, 5).join("\n"));

const dlls = files.filter((f) => f.endsWith(".dll")).length;
const size = files.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`staged: ${stage}`);
console.log(`dll count: ${dlls}  size: ${(size / 1048576).toFixed(1)} MB`);
EOF
