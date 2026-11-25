#!/bin/bash
set -euo pipefail
[[ "$(uname -sm)" == "Darwin arm64" ]]
stage="${RUNNER_TEMP:?}/native-stage"
out="$RUNNER_TEMP/native-delivery"
app="$stage/Producer.app"
bin="$app/Contents/MacOS"
desktop=crates/production-runtime/desktop
verify() { printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c -; }
case "${1:?build or sign}" in
build)
  mkdir -p "$stage" "$out"
  # Preserve the production camera and native helpers from the qualified Silicon bundle.
  old=Producer_0.4.93_aarch64.app.tar.gz
  gh release download v0.4.93 --repo Boomin-Ai/producer --pattern "$old" --dir "$RUNNER_TEMP"
  verify b94d251164694c13e7596e8000f98a7914896186fc2638a615e5e1aca610551c "$RUNNER_TEMP/$old"
  tar -xzf "$RUNNER_TEMP/$old" -C "$stage"
  codesign --verify --deep --strict "$app"
  bash scripts/engine-closure.sh "$app/Contents"
  gh release download webrtc-89d790b --repo livekit/rust-sdks --pattern webrtc-mac-arm64-release.zip --dir "$RUNNER_TEMP"
  verify 9f25fea48588deac18d68e120d18b33af7ef10f921f74b7c57f66b642262c348 "$RUNNER_TEMP/webrtc-mac-arm64-release.zip"
  unzip -q "$RUNNER_TEMP/webrtc-mac-arm64-release.zip" -d "$RUNNER_TEMP/sdk"
  export WEBRTC_ARCHIVE_DIR="$RUNNER_TEMP/sdk/mac-arm64-release" CXX=clang++ SDKROOT="$(xcrun --show-sdk-path)"
  bash "$desktop/native/producer-rtc/build-macos.sh" "$bin/producer-rtc"
  npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP" @ffmpeg-installer/darwin-arm64@4.1.5
  tar -xOzf "$RUNNER_TEMP/ffmpeg-installer-darwin-arm64-4.1.5.tgz" package/ffmpeg > "$bin/ffmpeg"
  verify a2ad6f0fc42a3c8f5183ef1d53e906d6bb35478d14a6b67175c30ce6c17e9214 "$bin/ffmpeg"
  gh release download v2.85.0 --repo cli/cli --pattern gh_2.85.0_macOS_arm64.zip --dir "$RUNNER_TEMP"
  verify 3d6999b85fa1e63aadec49b65986280578e8094c394a3776c24c789f0cc73cef "$RUNNER_TEMP/gh_2.85.0_macOS_arm64.zip"
  unzip -p "$RUNNER_TEMP/gh_2.85.0_macOS_arm64.zip" '*/bin/gh' > "$bin/gh"
  chmod 755 "$bin/ffmpeg" "$bin/gh"
  ;;
test)
  # Separate compilation from execution so a stalled UI test yields a macOS thread sample.
  tests_json="$RUNNER_TEMP/shell-test-messages.jsonl"
  cargo test --locked --manifest-path "$desktop/Cargo.toml" --no-run --message-format=json-render-diagnostics > "$tests_json"
  test_binary=$(jq -rs 'map(select(.profile.test == true and .target.name == "producer-native-room" and .executable != null)) | last.executable' "$tests_json")
  [[ -x "$test_binary" ]]
  "$test_binary" --test-threads=2 --nocapture &
  test_pid=$!
  for ((n=0; n<60; n++)); do
    if ! kill -0 "$test_pid" 2>/dev/null; then wait "$test_pid"; exit $?; fi
    sleep 1
  done
  sample "$test_pid" 2 -file "$RUNNER_TEMP/shell-test.sample" || true
  head -400 "$RUNNER_TEMP/shell-test.sample" || true
  kill "$test_pid" || true
  exit 1
  ;;
compile)
  cargo build --locked --manifest-path "$desktop/Cargo.toml" --release
  cp "$desktop/target/release/producer-native-room" "$bin/producer"
  ditto assets/starter-audio "$app/Contents/Resources/starter-audio"
  bash "$desktop/scripts/check-silicon-release.sh" "$bin/producer" "$RUNNER_TEMP"
  for exe in producer producer-rtc gh ffmpeg; do [[ "$(lipo -archs "$bin/$exe")" == arm64 ]]; done
  plutil -replace CFBundleShortVersionString -string "$VERSION" "$app/Contents/Info.plist"
  plutil -replace CFBundleVersion -string "$VERSION" "$app/Contents/Info.plist"
  plutil -replace LSMinimumSystemVersion -string 13.0 "$app/Contents/Info.plist"
  plutil -insert CFBundleURLTypes -json '[{"CFBundleURLName":"Producer guest invitation","CFBundleURLSchemes":["producer-rtc"]}]' "$app/Contents/Info.plist"
  ;;
sign)
  umask 077
  kc="$RUNNER_TEMP/native-signing.keychain-db"
  trap 'security delete-keychain "$kc" >/dev/null 2>&1 || true' EXIT
  security create-keychain -p ci "$kc"
  security unlock-keychain -p ci "$kc"
  security set-keychain-settings -lut 21600 "$kc"
  security list-keychains -d user -s "$kc" "$(security default-keychain -d user | tr -d ' \"')"
  printf '%s' "$CERT_B64" | base64 -D > "$RUNNER_TEMP/cert.p12"
  security import "$RUNNER_TEMP/cert.p12" -k "$kc" -P "$CERT_PW" -T /usr/bin/codesign
  rm "$RUNNER_TEMP/cert.p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k ci "$kc" >/dev/null
  printf '%s' "$PROFILE_B64" | base64 -D > "$app/Contents/embedded.provisionprofile"
  for exe in producer-rtc gh ffmpeg; do
    bash scripts/codesign-with-retry.sh --force --options runtime --timestamp --sign "$SIGN_IDENT" "$bin/$exe"
  done
  bash scripts/codesign-with-retry.sh --force --options runtime --timestamp --entitlements .github/macos/producer.entitlements --sign "$SIGN_IDENT" "$app"
  codesign --verify --deep --strict "$app"
  python3 scripts/check-camera-bundle.py "$app"
  bash scripts/check-no-qt.sh "$app"
  bash scripts/engine-closure.sh "$app/Contents"
  bash scripts/notarize-macos-artifact.sh "$app"
  dmg="$out/Producer_${VERSION}_aarch64.dmg"
  ln -s /Applications "$stage/Applications"
  hdiutil create -fs HFS+ -format UDZO -volname Producer -srcfolder "$stage" "$dmg"
  bash scripts/codesign-with-retry.sh --timestamp --sign "$SIGN_IDENT" "$dmg"
  bash scripts/notarize-macos-artifact.sh "$dmg"
  printf '%s\n' "$GITHUB_SHA" > "$out/source-revision.txt"
  (cd "$out" && shasum -a 256 *.dmg > SHA256SUMS)
  ;;
*) exit 2 ;;
esac
