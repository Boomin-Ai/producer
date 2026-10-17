# Portrait virtual camera candidate

Isolated source: `fix/portrait-virtual-camera`. This is a dev candidate, not a published Producer update.

The old macOS camera advertises 1920×1080, and its feeder was always attached to the landscape room mix. Selecting Portrait changed streaming/recording/guest output but not the external camera.

The candidate adds a separate `Producer Portrait Camera` device with its own CMIO extension and UUIDs, advertising 1080×1920. The feeder attaches directly to the native portrait canvas, verifies 9:16 input, and converts to the device's advertised BGRA format/dimensions. The existing landscape device keeps its identity and dimensions. This is video only; it does not add a virtual audio device.

Stop Virtual cam → Output settings → Portrait → arrange the portrait canvas → start Portrait cam → select Producer Portrait Camera in TikTok. TikTok's Rotate to fill must be disabled. Whether TikTok preserves a true portrait input needs a real client check.

Canvas switching and global video reset are refused while the portrait camera owns the video output. Normal camera stop precedes canvas teardown; Studio toggles do not restart the camera.

The dev signing harness in `.github/workflows/release.yml` is intentionally dispatch-only and uploads an Actions artifact. It contains no release/upload-to-public/updater publication step and uses its own concurrency group. Do not merge this temporary workflow replacement into the release pipeline. The existing provisioning profile authorizes Producer's original bundle ID; the `portrait-camera-dev` feature gives the candidate its own native database/engine configuration directory, and the workflow assigns a separate WKWebView data-store UUID and disables the public updater.

Verified locally so far: Swift extension and Objective-C++ plugin compile; native desktop build against installed OBS succeeds; TypeScript and frontend production build pass. Actual installed-camera capture and TikTok framing remain pending until the signed dev artifact is installed and macOS activates its extension.
