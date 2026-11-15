#!/bin/bash
# Exercise actual libobs draw routing on macOS without a capture permission,
# room, network connection, audio device or changes to the installed app.
set -euo pipefail
cd "$(dirname "$0")/../.."
app="${1:-/Applications/Producer.app}"
backend="${2:-metal}"
[[ $backend == metal || $backend == opengl ]] || exit 64
frameworks="$app/Contents/Frameworks"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/producer-studio-room-gate.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
mkdir "$scratch/profile"
clang -fobjc-arc -std=gnu11 -Werror=implicit-function-declaration \
    -Isrc-tauri/src/live scripts/sets-v2/studio-room-gate-probe.m \
    src-tauri/src/live/studio_room_gate.c -F"$frameworks" \
    -framework libobs -framework AppKit -Wl,-rpath,"$frameworks" \
    -o "$scratch/probe"
"$scratch/probe" "$app" "$backend" "$scratch/profile"
