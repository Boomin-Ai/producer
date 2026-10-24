#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
app="${PRODUCER_PROBE_APP:-/Applications/Producer.app}"
proof_dir="${PRODUCER_PROBE_OUTPUT:-$PWD/docs/sets-v2/native}"
build_dir="$(mktemp -d /private/tmp/producer-sets-v2-native.XXXXXX)"
cleanup_probe() {
  python3 - "$build_dir" <<'PY_CLEANUP'
import pathlib, shutil, sys
folder = pathlib.Path(sys.argv[1])
if folder.parent == pathlib.Path('/private/tmp') and folder.name.startswith('producer-sets-v2-native.') and not folder.is_symlink():
    shutil.rmtree(folder)
PY_CLEANUP
}
trap cleanup_probe EXIT
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
frameworks="$app/Contents/Frameworks"
probe_app="$build_dir/Producer.app"
mkdir -p "$proof_dir"
# A failed rerun must never leave an older successful report looking current.
python3 - "$proof_dir" <<'PY_REPORT'
import pathlib, sys
for name in ['proof.json', 'run.json', 'text-quality.json', 'text-quality-run.json', 'showcase-proof.json', 'showcase-run.json']:
    (pathlib.Path(sys.argv[1]) / name).unlink(missing_ok=True)
PY_REPORT
mkdir -p "$probe_app/Contents/MacOS"
# CEF helper launch fails through a symlinked Frameworks directory in this host.
# APFS clones give it an actual isolated bundle without duplicating asset blocks.
cp -cR "$frameworks" "$probe_app/Contents/Frameworks"
cat > "$probe_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.boomin.producer.sets-v2-probe</string><key>CFBundleName</key><string>producer</string><key>CFBundleExecutable</key><string>producer</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>
PLIST
CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="${PRODUCER_SETS_V2_RUST_TARGET:-/private/tmp/producer-sets-v2-rust-target}" cargo build --offline --manifest-path scripts/sets-v2/rust-probe/Cargo.toml
rust_lib="${PRODUCER_SETS_V2_RUST_TARGET:-/private/tmp/producer-sets-v2-rust-target}/debug/libproducer_sets_v2_native_adapter_probe.a"
clang -std=gnu11 -fobjc-arc -Werror=implicit-function-declaration -Isrc-tauri/src/live \
  scripts/sets-v2/native-probe.m src-tauri/src/live/sets_v2/group.c src-tauri/src/live/sets_v2/transition.c src-tauri/src/live/sets_v2/scene.c src-tauri/src/live/sets_v2/program.c src-tauri/src/live/sets_v2/readiness.c src-tauri/src/live/source_appearance.c "$rust_lib" \
  -F"$frameworks" -framework libobs -framework AppKit -framework Metal -framework Security -framework SystemConfiguration -liconv \
  -Wl,-rpath,"$frameworks" -o "$probe_app/Contents/MacOS/producer"
codesign --force --sign - "$probe_app"
if [[ -n "${PRODUCER_PROBE_TEXT_QUALITY_ONLY:-}" ]]; then
  node scripts/sets-v2/make-text-quality-plans.mjs "$proof_dir"
elif [[ -n "${PRODUCER_PROBE_SHOWCASE_ONLY:-}" ]]; then
  : # Showcase plans are compiled by test-grand-arena-browser.mjs.
else
node scripts/sets-v2/make-native-plans.mjs "$proof_dir"
node scripts/sets-v2/make-room-fixtures.mjs
xcrun swift scripts/sets-v2/make-media-fixture.swift "$proof_dir/media"
fi
PRODUCER_PROBE_CONFIG="$build_dir/cef-profile" "$probe_app/Contents/MacOS/producer" "$app" "$proof_dir"
if [[ -n "${PRODUCER_PROBE_SHOWCASE_ONLY:-}" && -z "${PRODUCER_PROBE_SHOWCASE_FOCUS:-}" ]]; then
  node scripts/sets-v2/record-grand-arena-proof.mjs "$proof_dir" "$PRODUCER_ROOM_FIXTURES"
fi
if [[ -n "${PRODUCER_PROBE_TEXT_QUALITY_ONLY:-}" ]]; then
  node scripts/sets-v2/record-text-quality-proof.mjs "$proof_dir" "$app"
fi
if [[ -z "${PRODUCER_PROBE_SHARPNESS_ONLY:-}" && -z "${PRODUCER_PROBE_TEXT_QUALITY_ONLY:-}" && -z "${PRODUCER_PROBE_SHOWCASE_ONLY:-}" ]]; then
  node scripts/sets-v2/record-native-proof.mjs "$proof_dir" "$app" "$started_at"
fi
