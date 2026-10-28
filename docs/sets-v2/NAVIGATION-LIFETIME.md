# Metal navigation lifetime repair

The dev crash captured on 2026-10-26 at 21:19:36 faults on the libobs graphics thread in `device_begin_frame`, while releasing the previous render-target reference. The same stack occurs in an earlier report. That stack identifies the failing release, not the original writer of the invalid reference.

A concrete race was found in the pinned Metal backend: `CVDisplayLink` reads `OBSSwapChain.renderTarget` while the graphics thread can replace it during resize. Swift strong-reference property reads/writes do not provide synchronization. The display link also iterated the mutable swapchain array outside the queue used to update it.

The versioned Metal patch protects retained target snapshots and the discard flag with a lock, and copies the active swapchain array inside its writer queue. No graphics lock is acquired by the display-link callback, and the target lock is released before drawable acquisition or GPU work. This avoids introducing a display-link shutdown/graphics-lock dependency. Engine artifact revision 10 carries the patch, verified by `engine/obs.lock`.

A separate compositor leak was fixed: group destruction now destroys both backdrop accumulation surfaces and the blur surface. That leak is not established as the cause of the older crashes.

## Evidence

- `bash scripts/test-metal-swapchain.sh`: compiles the actual pinned Swift backend. The original implementation produces a Thread Sanitizer report in `OBSSwapChain.renderTarget` getter/setter. The patched version completes 100,000 concurrent reference publications/reads without sanitizer errors. macOS may abort on the intentional negative control; the script requires the specific sanitizer report rather than a generic failure.
- `bash scripts/build-cutout-metal-lab.sh`: the optimized patched backend passes the existing real GPU copy-ordering and cutout shader tests. A tested manifest binds the binary to the source lock, patch digest and copy API digest.
- `PRODUCER_PROBE_ASAN=1 ASAN_OPTIONS=detect_leaks=0 PRODUCER_PROBE_VISUAL_EFFECTS_ONLY=1 bash scripts/sets-v2/run-native-probe.sh`: Address Sanitizer instrumentation on Producer's native compositor; 240 live backdrop-scene replacements, actual pixels and cleanup. This does not instrument the entire third-party engine or replace a GPU allocation leak detector.
- Opt-in `VITE_NAVIGATION_LIFETIME_PROOF=1`: 24 actual Atmosphere room layout changes with native preview resizing. All presented successfully, the process survived, 3D contexts stayed at two, and the cached resource estimate stayed constant. Compact evidence: [navigation-lifetime-proof.json](navigation-lifetime-proof.json). The opt-in is disabled for manual use.

`dev-room.py` now checks the tested backend manifest before building and stages that binary into the isolated dev app. It refuses a missing/stale local backend instead of silently copying an older production renderer. The normal engine build applies the same patch through the existing pinned patch pipeline.

These checks establish the repaired race and successful tested navigation paths. They do not establish that every possible native crash is eliminated. Longer sessions, camera/guest teardown, output changes and additional hardware remain useful release checks. No production release is included in this work.
