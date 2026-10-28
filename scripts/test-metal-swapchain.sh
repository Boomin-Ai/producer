#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
repo_dir="$PWD"
lab_dir="$repo_dir/src-tauri/target/cutout-lab"
source_dir="$lab_dir/engine-source"
engine_contents="${PRODUCER_ENGINE_DIR:-/Applications/Producer.app/Contents}"
bash scripts/build-cutout-metal-lab.sh --prepare-only
baseline="$lab_dir/swapchain-baseline"
mkdir -p "$baseline"
cp "$source_dir"/libobs-metal/*.swift "$baseline/"
# Test the original implementation with the exact same harness first.
(cd "$baseline" && git apply --reverse "$repo_dir/engine/patches/metal/0001-synchronize-swapchain-targets.patch")
flags=(-swift-version 6 -Onone -g -sanitize=thread -target "$(uname -m)-apple-macosx12.0"
 -import-objc-header "$source_dir/libobs-metal/libobs-metal-Bridging-Header.h"
 -I "$source_dir/libobs" -I "$lab_dir/simde"
 -I "$engine_contents/Frameworks/libobs.framework/Headers"
 -F "$engine_contents/Frameworks" -framework libobs
 -Xlinker -rpath -Xlinker "$engine_contents/Frameworks")
xcrun swiftc "${flags[@]}" -module-name SwapchainBaseline "$baseline"/*.swift scripts/test-metal-swapchain.swift -o "$lab_dir/swapchain-baseline-test"
set +e
TSAN_OPTIONS=halt_on_error=1:exitcode=66 "$lab_dir/swapchain-baseline-test" > "$lab_dir/swapchain-baseline.log" 2>&1
baseline_rc=$?
set -e
if [[ "$baseline_rc" == 0 ]] || ! rg -q 'SUMMARY: ThreadSanitizer: data race .*OBSSwapChain.renderTarget\.(getter|setter)'  "$lab_dir/swapchain-baseline.log"; then
 echo "FAIL: original backend did not reproduce the expected sanitizer race ($baseline_rc)" >&2
 exit 1
fi
xcrun swiftc "${flags[@]}" -module-name SwapchainFixed "$source_dir"/libobs-metal/*.swift scripts/test-metal-swapchain.swift -o "$lab_dir/swapchain-fixed-test"
TSAN_OPTIONS=halt_on_error=1:exitcode=66 "$lab_dir/swapchain-fixed-test" > "$lab_dir/swapchain-fixed.log" 2>&1
cat "$lab_dir/swapchain-fixed.log"
printf 'PASS: original backend reproduces a data race; fixed backend completes without sanitizer errors.\n'
