#!/bin/bash
set -euo pipefail
lab_dir="$(cd "$(dirname "$0")" && pwd)"
cargo build --locked --jobs 2 --manifest-path "$lab_dir/Cargo.toml"
lab_bundle="$lab_dir/runtime/Producer Guest RTC Lab.app"
mkdir -p "$lab_bundle/Contents/MacOS"
cp "$lab_dir/target/debug/producer-guest-rtc-lab" "$lab_bundle/Contents/MacOS/producer-guest-rtc-lab"
cat > "$lab_bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.producer.guest-rtc-lab</string>
<key>CFBundleName</key><string>Producer Guest RTC Lab</string>
<key>CFBundleExecutable</key><string>producer-guest-rtc-lab</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --sign - --options runtime "$lab_bundle"
codesign --verify --strict "$lab_bundle"
printf '%s\n' "$lab_bundle"
