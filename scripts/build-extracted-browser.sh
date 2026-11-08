#!/bin/bash
# Build the locked, Qt-free browser plugin against an extracted engine (CLT only).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"
STAGE="${1:?usage: build-extracted-browser.sh engine-stage}"
SOURCE="$REPO_ROOT/src-tauri/target/cutout-lab/engine-source"
WORK="$REPO_ROOT/src-tauri/target/extracted-browser"
ARCH="$(uname -m)"
mkdir -p "$WORK/include/nlohmann" "$WORK/objects"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$WORK/module-cache}"

PIN="$(lock_get "['submodules']['plugins/obs-browser']")"
if [[ ! -f "$WORK/browser/.producer-commit" ]]; then
  curl -fsSL "https://codeload.github.com/obsproject/obs-browser/tar.gz/$PIN" -o "$WORK/browser.tgz"
  mkdir -p "$WORK/browser"
  tar -xzf "$WORK/browser.tgz" --strip-components=1 -C "$WORK/browser"
  printf '%s\n' "$PIN" > "$WORK/browser/.producer-commit"
fi
[[ $(cat "$WORK/browser/.producer-commit") == "$PIN" ]] || exit 1
python3 - "$REPO_ROOT" "$WORK/browser" <<'PY'
import hashlib,json,os,pathlib,subprocess,sys
root,source=map(pathlib.Path,sys.argv[1:])
entry=next(p for p in json.loads((root/'engine/obs.lock').read_text())['patchsets'] if p['target']=='plugins/obs-browser')
patches=sorted((root/entry['dir']).glob('*.patch'))
assert hashlib.sha256(b''.join(p.read_bytes() for p in patches)).hexdigest()==entry['sha256']
env={**os.environ,'GIT_CEILING_DIRECTORIES':str(source.parent)}
for patch in patches:
    args=['git','-C',str(source),'apply']
    if subprocess.run(args+['--check',str(patch)],env=env,capture_output=True).returncode==0:
        subprocess.run(args+[str(patch)],env=env,check=True)
    else:
        subprocess.run(args+['--reverse','--check',str(patch)],env=env,check=True)
PY

# OBS's own pinned buildspec supplies the matching CEF archive and digest.
read -r VERSION REVISION DIGEST < <(python3 - "$SOURCE/CMakePresets.json" "$ARCH" <<'PY'
import json,sys
data=json.load(open(sys.argv[1])); arch='macos-'+sys.argv[2]
deps=next(p for p in data['configurePresets'] if p['name']=='dependencies')['vendor']['obsproject.com/obs-studio']['dependencies']['cef']
print(deps['version'],deps['revision'][arch],deps['hashes'][arch])
PY
)
ARCHIVE="$CACHE_DIR/cef_binary_${VERSION}_macos_${ARCH}_v${REVISION}.tar.xz"
CEF="$CACHE_DIR/cef_binary_${VERSION}_macos_${ARCH}"
if [[ ! -f "$ARCHIVE" ]]; then
  curl -fL --retry 2 "https://cdn-fastly.obsproject.com/downloads/$(basename "$ARCHIVE")" -o "$ARCHIVE"
fi
echo "$DIGEST  $ARCHIVE" | shasum -a 256 -c -
if [[ ! -f "$CEF/include/cef_version.h" ]]; then
  mkdir -p "$CEF"
  tar -xJf "$ARCHIVE" -C "$CEF"
fi
if [[ ! -f "$WORK/include/nlohmann/json.hpp" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp -o "$WORK/include/nlohmann/json.hpp"
fi
echo "9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6  $WORK/include/nlohmann/json.hpp" | shasum -a 256 -c -
WEB_PIN="$(lock_get "['submodules']['plugins/obs-websocket']")"
curl -fsSL "https://raw.githubusercontent.com/obsproject/obs-websocket/$WEB_PIN/lib/obs-websocket-api.h" -o "$WORK/include/obs-websocket-api.h"

FLAGS=(-std=c++17 -O2 -fPIC -mmacosx-version-min=13.0
  -I "$SOURCE/libobs" -I "$SOURCE/frontend/api" -I "$WORK/include"
  -I "$REPO_ROOT/src-tauri/target/cutout-lab/simde" -I "$CEF"
  -I "$WORK/browser" -I "$WORK/browser/deps" -F "$STAGE/Frameworks")
clang++ "${FLAGS[@]}" -dynamiclib "$SOURCE/frontend/api/obs-frontend-api.cpp" \
  -framework libobs -Wl,-install_name,@rpath/obs-frontend-api.dylib \
  -o "$STAGE/Frameworks/obs-frontend-api.dylib"
OBJECTS=()
for file in browser-app.cpp browser-client.cpp browser-scheme.cpp obs-browser-plugin.cpp obs-browser-source.cpp \
  deps/base64/base64.cpp deps/signal-restore.cpp deps/wide-string.cpp deps/ip-string-posix.cpp; do
  object="$WORK/objects/$(basename "$file").o"
  clang++ "${FLAGS[@]}" -DENABLE_BROWSER_SHARED_TEXTURE -DENABLE_BROWSER_DISPATCH_LOOP \
    -c "$WORK/browser/$file" -o "$object"
  OBJECTS+=("$object")
done
PLUGIN="$STAGE/PlugIns/obs-browser.plugin"
mkdir -p "$PLUGIN/Contents/MacOS" "$PLUGIN/Contents/Resources"
cp -R "$WORK/browser/data/." "$PLUGIN/Contents/Resources/"
clang++ -bundle "${OBJECTS[@]}" "$CEF/build/libcef_dll_wrapper/Release/libcef_dll_wrapper.a" \
  -F "$STAGE/Frameworks" -framework libobs -framework AppKit -framework CoreFoundation -framework IOSurface \
  "$STAGE/Frameworks/obs-frontend-api.dylib" -o "$PLUGIN/Contents/MacOS/obs-browser"
cat > "$PLUGIN/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.boomin.producer.obs-browser</string><key>CFBundleExecutable</key><string>obs-browser</string><key>CFBundlePackageType</key><string>BNDL</string></dict></plist>
PLIST
cp -R "$CEF/Release/Chromium Embedded Framework.framework" "$STAGE/Frameworks/"
mkdir -p "$STAGE/signing"
cp "$WORK/browser"/cmake/macos/entitlements-helper*.plist "$STAGE/signing/"
clang++ "${FLAGS[@]}" -DENABLE_BROWSER_SHARED_TEXTURE \
  "$WORK/browser/browser-app.cpp" "$WORK/browser/obs-browser-page/obs-browser-page-main.cpp" \
  "$CEF/build/libcef_dll_wrapper/Release/libcef_dll_wrapper.a" -framework AppKit \
  -o "$WORK/Producer Helper"
for suffix in '' ' (GPU)' ' (Plugin)' ' (Renderer)'; do
  HELPER="$STAGE/Frameworks/Producer Helper${suffix}.app"
  mkdir -p "$HELPER/Contents/MacOS"
  cp "$WORK/Producer Helper" "$HELPER/Contents/MacOS/Producer Helper${suffix}"
  python3 - "$HELPER/Contents/Info.plist" "$suffix" <<'PY'
import plistlib,sys
suffix=sys.argv[2]
with open(sys.argv[1],'wb') as f:
    plistlib.dump({'CFBundleExecutable':'Producer Helper'+suffix,
                  'CFBundleIdentifier':'ai.boomin.producer.helper'+''.join(c for c in suffix if c.isalpha()),
                  'CFBundlePackageType':'APPL'},f)
PY
done
"$REPO_ROOT/scripts/engine-closure.sh" "$STAGE"
echo "Built Qt-free browser plugin and helpers for $ARCH"
