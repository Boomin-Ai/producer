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


## Set routing follow-up

Head to Head contains only landscape layouts (`conversation`, `host-focus`, `solo`). Previously Follow set silently selected room-camera sources instead, while the main controls still reported the set on output. The follow-up fits the full landscape set into the native portrait canvas; matching portrait layouts remain preferred. Explicit Room canvas remains available. Output settings explains when a set has no matching portrait design. Paired layouts now support both `foo-landscape` / `foo-portrait` and `foo` / `foo-portrait`; switching packages resets pinned layout selection. Portrait bindings use the same stale-camera-ID resolution as the main output. Landscape-only sets do not start an extra portrait compositor until the portrait/both view is needed.

Chromium regression passes Head to Head fitted output, explicit Room canvas, returning to Follow set, and paired segment transitions. TypeScript, production frontend build, and native desktop compilation pass. Actual user-room camera capture now advances at 1080×1920; no synthetic marker-orientation claim is made for that capture. The set-routing follow-up still needs installation and native visual verification.


Signed set-routing candidate: https://github.com/Boomin-Ai/producer/actions/runs/39084513741 — success, signing-only branch `dev/portrait-set-routing-2026-10-17`, commit `3764d9d`. Downloaded candidate passes local deep/strict codesign, stapler validation, Gatekeeper (Notarized Developer ID), and the landscape/portrait camera bundle checks. It is staged at `/private/tmp/producer-portrait-set-artifact/Producer.app`; replacing the running dev app awaits permission to interrupt its active camera feed. This is not a production release. A future production release must build a fresh engine artifact containing the new camera pair before using the normal release workflow.


## Whole-picture virtual camera mirror

The output gear now has a macOS **Mirror virtual camera** toggle. It flips the complete outgoing camera image horizontally, including set graphics and text. It applies to both Producer camera devices and is stored in the engine's data directory as `virtual-camera-mirror.json`. The engine updates the running output's atomic mirror flag, so toggling does not restart the camera or change scene transforms. The output uses a consistent BGRA frame format matching the advertised CMIO formats; Accelerate reflects directly from the OBS frame into the camera pixel buffer without an extra image allocation. Show audio is untouched.

Local pixel tests cover horizontal direction, row padding, channel/alpha preservation, and restoration after two reflections. Chromium verifies the gear toggle updates without rebuilding the set. The opt-in native camera probe now waits for engine readiness and exposes normal/mirrored/restored phases. `scripts/portrait-camera-proof/observe-mirror.mjs` can verify those actual camera frames on one uninterrupted receiver track. Real native mirror capture remains pending installation of the new dev candidate; no completed native mirror capture is claimed yet.
