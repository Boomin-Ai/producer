#!/bin/bash
# CI-only unreleased candidate on a PUBLIC repo. No release/upload/deploy calls.
set -euo pipefail
umask 077

source "$(dirname "${BASH_SOURCE[0]}")/macos-ticket-retry.sh"

# Pure fixture tests source only the function above, never CI signing setup.
if [[ ${1:-} == --stapler-functions-only ]]; then
  return 0 2>/dev/null || exit 0
fi

SOURCE="${1:?application checkout required}"
TOOLS="${2:?reviewed tooling directory required}"
OUTPUT="${3:?new artifact directory required}"
[[ ${GITHUB_ACTIONS:-} == true && $(uname -s) == Darwin ]] || { echo 'Run only in the explicit macOS Actions job' >&2; exit 1; }
[[ ${CANDIDATE_SOURCE_SHA:-} =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ ${INFRASTRUCTURE_SHA:-} =~ ^[0-9a-f]{40}$ ]] || exit 1
for key in SIGN_IDENT CERT_B64 CERT_PW NOTARY_TEAM; do
  [[ -n ${!key:-} ]] || { echo "Required signing secret is unavailable: $key" >&2; exit 1; }
done
if [[ ${NOTARIZE:-1} == 1 ]]; then
  for key in NOTARY_ID NOTARY_PW; do
    [[ -n ${!key:-} ]] || { echo "Required notarization secret is unavailable: $key" >&2; exit 1; }
  done
fi
[[ ! -e $OUTPUT ]] || { echo 'Artifact destination already exists' >&2; exit 1; }
mkdir "$OUTPUT"
PRIVATE="$(mktemp -d "$RUNNER_TEMP/producer-network-mac-dev.XXXXXX")"
KEYCHAIN="$PRIVATE/signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
echo "::add-mask::$KEYCHAIN_PASSWORD"
security list-keychains -d user > "$PRIVATE/search-list.txt"
cleanup() {
  # Restore only the search list changed by this job; never change the default
  # keychain, import credentials into login.keychain, or retain the PKCS#12.
  python3 - "$PRIVATE/search-list.txt" <<'PY' || true
import pathlib,shlex,subprocess,sys
p=pathlib.Path(sys.argv[1])
if p.exists(): subprocess.run(['security','list-keychains','-d','user','-s',*shlex.split(p.read_text())],check=False,stdout=subprocess.DEVNULL)
PY
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "$PRIVATE"
}
trap cleanup EXIT
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
python3 - "$PRIVATE/search-list.txt" "$KEYCHAIN" <<'PY'
import pathlib,shlex,subprocess,sys
subprocess.run(['security','list-keychains','-d','user','-s',sys.argv[2],*shlex.split(pathlib.Path(sys.argv[1]).read_text())],check=True)
PY
printf '%s' "$CERT_B64" | base64 --decode > "$PRIVATE/certificate.p12"
security import "$PRIVATE/certificate.p12" -k "$KEYCHAIN" -P "$CERT_PW" -T /usr/bin/codesign >/dev/null
rm "$PRIVATE/certificate.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security find-identity -v -p codesigning "$KEYCHAIN" | grep -F -- "$SIGN_IDENT" >/dev/null || { echo 'Requested Developer ID is unavailable' >&2; exit 1; }

python3 "$TOOLS/ci-network-mac-dev.py" prepare "$SOURCE" "$RUNNER_TEMP/network-mac-dev-config"
cd "$SOURCE"
LOCK_HASH="$(shasum -a 256 engine/obs.lock | awk '{print $1}')"
[[ $LOCK_HASH == "$PINNED_ENGINE_LOCK_SHA256" ]] || { echo 'Engine pin changed' >&2; exit 1; }
ENGINE_NAME="producer-libobs-macos-arm64-${LOCK_HASH:0:12}"
ENGINE_RUN=''
# Reuse the reviewed Release engine-fetch policy, with no OBS rebuild/fallback.
for run_id in $(gh run list --repo "$GITHUB_REPOSITORY" --workflow engine.yml --status success --limit 10 --json databaseId -q '.[].databaseId'); do
  rm -rf "$PRIVATE/engine-download"
  mkdir "$PRIVATE/engine-download"
  if gh run download "$run_id" --repo "$GITHUB_REPOSITORY" -n producer-libobs-macos-arm64 -D "$PRIVATE/engine-download" >/dev/null 2>&1 && [[ -f "$PRIVATE/engine-download/$ENGINE_NAME.tar.zst" ]]; then
    ENGINE_RUN="$run_id"; break
  fi
done
[[ -n $ENGINE_RUN ]] || { echo 'No green engine artifact matches the pinned lock; no fallback or source rebuild was attempted' >&2; exit 1; }
(cd "$PRIVATE/engine-download" && shasum -a 256 -c "$ENGINE_NAME.tar.zst.sha256")
ENGINE_ARCHIVE_SHA256="$(shasum -a 256 "$PRIVATE/engine-download/$ENGINE_NAME.tar.zst" | awk '{print $1}')"
mkdir -p engine/artifacts
tar --zstd -xf "$PRIVATE/engine-download/$ENGINE_NAME.tar.zst" -C engine/artifacts \
  || tar --use-compress-program=unzstd -xf "$PRIVATE/engine-download/$ENGINE_NAME.tar.zst" -C engine/artifacts
ENGINE="$SOURCE/engine/artifacts/$ENGINE_NAME"
python3 "$TOOLS/ci-network-mac-dev.py" verify-engine "$SOURCE" "$ENGINE"
export PRODUCER_ENGINE_DIR="$ENGINE"
export PRODUCER_SOURCE_SHA="$CANDIDATE_SOURCE_SHA"
CONFIG="$RUNNER_TEMP/network-mac-dev-config/candidate.json"
# Explicitly skip intermediate signing and updater archives. Sign only after
# engine assembly. This source checkout is exact; Cargo may not update its lock.
bun run tauri build --ci --no-sign --target aarch64-apple-darwin --features sets-v2-dev,guest-rtc-production --config "$CONFIG" --bundles app -- --locked
APP="$SOURCE/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Producer DJ Test.app"
[[ -d $APP/Contents ]] || { echo 'Expected isolated app was not generated' >&2; exit 1; }
CONTENTS="$APP/Contents"
mkdir -p "$CONTENTS/Frameworks" "$CONTENTS/PlugIns" "$CONTENTS/Resources/licenses"
cp -R "$ENGINE/Frameworks/." "$CONTENTS/Frameworks/"
cp -R "$ENGINE/PlugIns/." "$CONTENTS/PlugIns/"
[[ ! -d $ENGINE/licenses ]] || cp -R "$ENGINE/licenses/." "$CONTENTS/Resources/licenses/"
if [[ -f $ENGINE/bin/obs-ffmpeg-mux ]]; then cp "$ENGINE/bin/obs-ffmpeg-mux" "$CONTENTS/MacOS/"; fi
# Do NOT copy production provisioning profiles or SystemExtensions into a dev
# identity. The mac-virtualcam runtime plugin remains in PlugIns and can use
# an already installed production provider; this app does not install it.
[[ ! -e $CONTENTS/embedded.provisionprofile && ! -d $CONTENTS/Library/SystemExtensions ]] || { echo 'Unexpected system-extension installer in isolated app' >&2; exit 1; }
ENTITLEMENTS="$RUNNER_TEMP/network-mac-dev-config/dev-entitlements.plist"
sign() { bash "$TOOLS/codesign-with-retry.sh" --force --timestamp --options runtime --keychain "$KEYCHAIN" --sign "$SIGN_IDENT" "$@"; }
# Same leaf/framework/CEF-helper/plugin/outer ordering as the Release assembly.
find "$CONTENTS/Frameworks" -name '*.dylib' -type f -print0 | while IFS= read -r -d '' leaf; do sign "$leaf"; done
CEF="$CONTENTS/Frameworks/Chromium Embedded Framework.framework"
if [[ -d $CEF ]]; then sign "$CEF"; fi
for helper in "$CONTENTS/Frameworks/"*" Helper"*.app; do
  [[ -d $helper ]] || continue
  case "$helper" in
    *'(GPU)'*) ent="$ENGINE/signing/entitlements-helper.gpu.plist" ;;
    *'(Plugin)'*) ent="$ENGINE/signing/entitlements-helper.plugin.plist" ;;
    *'(Renderer)'*) ent="$ENGINE/signing/entitlements-helper.renderer.plist" ;;
    *) ent="$ENGINE/signing/entitlements-helper.plist" ;;
  esac
  [[ -f $ent ]] || { echo 'CEF helper entitlements missing from engine artifact' >&2; exit 1; }
  sign --entitlements "$ent" "$helper"
done
for framework in "$CONTENTS/Frameworks/"*.framework; do
  [[ -d $framework && $framework != "$CEF" ]] || continue
  sign "$framework"
done
for plugin in "$CONTENTS/PlugIns/"*.plugin; do [[ ! -d $plugin ]] || sign "$plugin"; done
if [[ -f $CONTENTS/MacOS/obs-ffmpeg-mux ]]; then sign "$CONTENTS/MacOS/obs-ffmpeg-mux"; fi
sign --entitlements "$ENTITLEMENTS" "$APP"
bash scripts/engine-closure.sh "$CONTENTS"
bash scripts/check-no-qt.sh "$APP"
codesign --verify --deep --strict "$APP"
EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$CONTENTS/Info.plist")"
otool -L "$CONTENTS/MacOS/$EXECUTABLE" | grep -q libobs || { echo 'Refusing native stub build' >&2; exit 1; }
NOTARY_SUBMISSION_ID=''
if [[ ${NOTARIZE:-1} == 1 ]]; then
  ditto -c -k --keepParent "$APP" "$PRIVATE/notary.zip"
  xcrun notarytool submit "$PRIVATE/notary.zip" --apple-id "$NOTARY_ID" --password "$NOTARY_PW" --team-id "$NOTARY_TEAM" --wait --output-format json > "$PRIVATE/notary.json"
  NOTARY_SUBMISSION_ID="$(python3 - "$PRIVATE/notary.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]));assert v.get('status')=='Accepted','Apple did not accept this unreleased candidate';print(v['id'])
PY
)"
  staple_with_retry "$APP" "$PRIVATE"
  validate_ticket_with_retry "$APP" "$PRIVATE"
  spctl -a -t exec "$APP"
fi
node "$TOOLS/ci-network-mac-dev-origin-smoke.mjs" "$APP" "$OUTPUT/native-origin-smoke.json"
mkdir "$OUTPUT/symbols"
SYMBOLS="$SOURCE/src-tauri/target/aarch64-apple-darwin/release/producer.dSYM"
[[ -d $SYMBOLS ]] || { echo 'Missing matching native symbols' >&2; exit 1; }
ditto "$SYMBOLS" "$OUTPUT/symbols/producer.dSYM"
xcrun dwarfdump --uuid "$CONTENTS/MacOS/$EXECUTABLE" > "$OUTPUT/symbols/binary-uuid.txt"
xcrun dwarfdump --uuid "$OUTPUT/symbols/producer.dSYM" > "$OUTPUT/symbols/symbol-uuid.txt"
cp "$ENGINE/manifest.json" "$OUTPUT/engine-manifest.json"
ditto -c -k --keepParent "$APP" "$OUTPUT/Producer-DJ-Test-mac-arm64.zip"
export ENGINE_RUN ENGINE_ARCHIVE_SHA256 NOTARY_SUBMISSION_ID
python3 "$TOOLS/ci-network-mac-dev.py" receipt "$SOURCE" "$APP" "$OUTPUT" "$TOOLS"
echo 'Verified unreleased dev candidate and native core/custom IPC smoke; no release/deployment or device/RTC qualification.'
