# Portrait virtual camera candidate

Isolated source: `fix/portrait-virtual-camera`. This is a dev candidate, not a published Producer update.

The old macOS camera advertises 1920×1080, and its feeder was always attached to the landscape room mix. Selecting Portrait changed streaming/recording/guest output but not the external camera.

The candidate adds a separate `Producer Portrait Camera` device with its own CMIO extension and UUIDs, advertising 1080×1920. The feeder attaches directly to the native portrait canvas, verifies 9:16 input, and converts to the device's advertised BGRA format/dimensions. The existing landscape device keeps its identity and dimensions. This is video only; it does not add a virtual audio device.

Stop Virtual cam → Output settings → Portrait → arrange the portrait canvas → start Portrait cam → select Producer Portrait Camera in TikTok. TikTok's Rotate to fill must be disabled. Whether TikTok preserves a true portrait input needs a real client check.

Canvas switching and global video reset are refused while the portrait camera owns the video output. Normal camera stop precedes canvas teardown; Studio toggles do not restart the camera.

The dev signing harness on `dev/portrait-camera-signed-2026-10-17` (commit `3e8b0b0`) in `.github/workflows/release.yml` is intentionally dispatch-only and uploads an Actions artifact. It contains no release/upload-to-public/updater publication step and uses its own concurrency group. The feature branch restores the normal release workflow; do not merge the signing-harness branch into the release pipeline. The existing provisioning profile authorizes Producer's original bundle ID; the `portrait-camera-dev` feature gives the candidate its own native database/engine configuration directory, and the workflow assigns a separate WKWebView data-store UUID and disables the public updater.

Verified locally so far: Swift extension and Objective-C++ plugin compile; native desktop build against installed OBS succeeds; TypeScript and frontend production build pass. Actual installed-camera capture and TikTok framing remain pending until the signed dev artifact is installed and macOS activates its extension.


Chromium acceptance passed for landscape/portrait/both switching, aspect ratios, native-display ownership, and independent portrait gestures. The existing harness needed its missing `liveSelectOutput` IPC mock. WebKit could not run because its Playwright binary is not installed; no WebKit pass is claimed.

`PRODUCER_PORTRAIT_CAMERA_PROBE=/private/tmp/portrait-camera-probe.json` opts the dev-only native build into a synthetic 60-second feed and an active-camera canvas-switch guard check. It creates temporary colored room sources in the isolated engine and removes them afterwards. `scripts/portrait-camera-proof/observe.mjs` opens only the exact `Producer Portrait Camera` device with audio disabled, captures a frame, checks 1080×1920, orientation markers, and advancing video time. No hardware camera or microphone is requested.

The camera-input exclusion regression test passed: both Producer output cameras are excluded, normal camera/capture-card choices remain available, and audio-device choices are unaffected. The default-camera fallback also excludes both output cameras.


Signed candidate: https://github.com/Boomin-Ai/producer/actions/runs/39060954397 — success, commit `3e8b0b0e5aeb22b51c068f59f58dfc8f832830fe`. Installed alongside the main app at `/Applications/Producer Portrait Dev.app`. Local deep/strict codesign, stapler validation, Gatekeeper (Notarized Developer ID), and both camera bundle/signing checks passed. macOS has registered the new portrait extension and reports `activated waiting for user`; actual camera capture and TikTok checks remain pending that approval. The first probe hit a cold Metal bootstrap timeout; a warm restart completed engine startup and reached the extension-approval gate.
