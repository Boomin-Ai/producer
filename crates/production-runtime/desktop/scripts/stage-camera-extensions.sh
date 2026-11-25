#!/bin/bash
# Stage the signed providers before the outer application is signed.
set -euo pipefail
source_app=${1:?Expected the signed arm64 Producer provider bundle}
target_app=${2:?Expected the staged native application}
[[ "$source_app" != "$target_app" ]]
dst="$target_app/Contents/Library/SystemExtensions"
for id in ai.boomin.producer.camera-extension ai.boomin.producer.portrait-camera-extension; do
  ext="$source_app/Contents/Library/SystemExtensions/$id.systemextension"
  codesign --verify --strict "$ext"
  metadata=$(codesign -dv --verbose=4 "$ext" 2>&1)
  [[ "$metadata" == *"TeamIdentifier=9936A69867"* ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$ext/Contents/Info.plist")" == "$id" ]]
  exe=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$ext/Contents/Info.plist")
  [[ "$(file -b "$ext/Contents/MacOS/$exe")" == *arm64* ]]
  mkdir -p "$dst"
  ditto "$ext" "$dst/$id.systemextension"
  codesign --verify --strict "$dst/$id.systemextension"
done
