#!/bin/bash
# Build/test only the pinned Metal backend; used by the lab and local engine extraction.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
lab_dir="$repo_dir/src-tauri/target/cutout-lab"
engine_contents="${PRODUCER_ENGINE_DIR:-/Applications/Producer.app/Contents}"
obs_commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["obs"]["commit"])' "$repo_dir/engine/obs.lock")"
source_dir="$lab_dir/engine-source"
mkdir -p "$lab_dir"
if [[ ! -f "$source_dir/.producer-obs-commit" ]] || [[ "$(cat "$source_dir/.producer-obs-commit")" != "$obs_commit" ]]; then
  if [[ -d "$source_dir" ]]; then
    printf 'Source cache has no matching commit marker: %s\n' "$source_dir" >&2
    exit 1
  fi
  curl -fsSL "https://codeload.github.com/obsproject/obs-studio/tar.gz/$obs_commit" -o "$lab_dir/obs-source.tgz"
  mkdir -p "$source_dir"
  tar -xzf "$lab_dir/obs-source.tgz" --strip-components=1 -C "$source_dir"
  printf '%s\n' "$obs_commit" > "$source_dir/.producer-obs-commit"
fi
if [[ ! -f "$lab_dir/simde/simde/x86/sse2.h" ]]; then
  curl -fsSL https://codeload.github.com/simd-everywhere/simde/tar.gz/refs/tags/v0.8.2 -o "$lab_dir/simde.tgz"
  mkdir -p "$lab_dir/simde"
  tar -xzf "$lab_dir/simde.tgz" --strip-components=1 -C "$lab_dir/simde"
fi
# Header-only standalone build against the existing, pinned libobs framework.
python3 - "$source_dir/libobs/obsconfig.h" <<'PY_HEADER'
import pathlib,sys
p=pathlib.Path(sys.argv[1])
header="""
#pragma once
#define OBS_DATA_PATH "data/obs-studio"
#define OBS_PLUGIN_PATH "obs-plugins"
#define OBS_PLUGIN_DESTINATION "obs-plugins"
#define OBS_INSTALL_PREFIX ""
#define OBS_RELEASE_CANDIDATE 0
#define OBS_BETA 0
"""
if not p.exists() or p.read_text()!=header:p.write_text(header)
PY_HEADER
# The standalone backend must use the same locked Metal fixes as engine CI.
python3 - "$repo_dir" "$source_dir" <<'PY_PATCH'
import hashlib,json,pathlib,subprocess,sys
root,src=map(pathlib.Path,sys.argv[1:])
for entry in json.loads((root/'engine/obs.lock').read_text())['patchsets']:
    if entry['target']!='libobs-metal':continue
    patches=sorted((root/entry['dir']).glob('*.patch'))
    assert hashlib.sha256(b''.join(p.read_bytes() for p in patches)).hexdigest()==entry['sha256'],'Metal patch hash mismatch'
    for patch in patches:
        args=['git','-C',str(src/entry['target']),'apply']
        if subprocess.run(args+['--check',str(patch)],capture_output=True).returncode==0:
            subprocess.run(args+[str(patch)],check=True)
        else:
            subprocess.run(args+['--reverse','--check',str(patch)],check=True)
PY_PATCH
if [[ "${1:-}" == "--prepare-only" ]]; then exit 0; fi
architecture="$(uname -m)"
swift_flags=(-swift-version 6 -O -target "$architecture-apple-macosx12.0"
  -import-objc-header "$source_dir/libobs-metal/libobs-metal-Bridging-Header.h"
  -I "$source_dir/libobs" -I "$lab_dir/simde"
  -I "$engine_contents/Frameworks/libobs.framework/Headers"
  -F "$engine_contents/Frameworks" -framework libobs)
swift_sources=("$source_dir"/libobs-metal/*.swift "$repo_dir/engine/metal-current-frame.swift")
xcrun swiftc "${swift_flags[@]}" -emit-library -module-name libobs_metal \
  -Xlinker -install_name -Xlinker @rpath/libobs-metal.dylib \
  "${swift_sources[@]}" -o "$lab_dir/libobs-metal-current-frame.dylib"
xcrun swiftc "${swift_flags[@]}" -module-name CutoutMetalTest \
  -Xlinker -rpath -Xlinker "$engine_contents/Frameworks" \
  "${swift_sources[@]}" "$repo_dir/scripts/test-cutout-metal.swift" -o "$lab_dir/test-cutout-metal"
"$lab_dir/test-cutout-metal"
clang -fobjc-arc -fmodules -I "$source_dir/libobs" -I "$lab_dir/simde" \
  -I "$engine_contents/Frameworks/libobs.framework/Headers" -F "$engine_contents/Frameworks" \
  -framework libobs -framework Foundation -framework Metal \
  -Wl,-rpath,"$engine_contents/Frameworks" "$repo_dir/scripts/test-cutout-refinement.m" \
  -o "$lab_dir/test-cutout-refinement"
"$lab_dir/test-cutout-refinement" "$lab_dir/libobs-metal-current-frame.dylib"
python3 - "$repo_dir" "$lab_dir" <<'PY_MANIFEST'
import hashlib,json,pathlib,sys
root,lab=map(pathlib.Path,sys.argv[1:]);lock=json.loads((root/'engine/obs.lock').read_text())
meta={'obs_commit':lock['obs']['commit'],'artifact_rev':lock['artifact_rev'],'metal_patch_sha256':[p['sha256'] for p in lock['patchsets'] if p['target']=='libobs-metal'],'copy_api_sha256':hashlib.sha256((root/'engine/metal-current-frame.swift').read_bytes()).hexdigest(),'binary_sha256':hashlib.sha256((lab/'libobs-metal-current-frame.dylib').read_bytes()).hexdigest()}
(lab/'metal-tested.json').write_text(json.dumps(meta,indent=2)+'\n')
PY_MANIFEST
printf 'Built and tested: %s\n' "$lab_dir/libobs-metal-current-frame.dylib"
