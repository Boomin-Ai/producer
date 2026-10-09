# Apple Vision cutout comparison

Development work based on v0.4.67; not published as an update.

Cutout now offers Auto, Fast, Balanced, and Accurate (slower). Auto keeps the existing selection: Balanced normally, Fast for source heights above 1080. Analysis keeps the existing 768-pixel maximum edge. Existing Feather/Erode defaults remain 0.35/0.25. Accurate is an explicit experiment, not an automatic upgrade.

## Reproduce on recorded camera footage

```sh
swift scripts/benchmark-cutout.swift /path/to/camera.mp4 /tmp/cutout-comparison 90
```

Outputs: frame timing CSV, summary JSON, raw masks, and matched purple-background cutout snapshots every 15 frames. Same decoded frames, orientation, input dimensions and request revision for each quality. First inference is reported separately. PNG generation happens outside the inference timing. These are inference-only timings, not streaming FPS. Use camera footage rather than an already composed show. No ground-truth matte is available, so edge quality requires inspecting the images.

## Live timing

Launch the development executable with `PRODUCER_CUTOUT_DIAGNOSTICS=1`. Every five seconds an active filter logs `[cutout_metrics]` with latest inference duration, mask dimensions, completed mask rate, busy skips and mask input age. Input age starts when the analysis texture was drawn: it includes analysis/readback ring delay, queueing, inference and reuse of the completed mask. It excludes camera capture latency. Busy skips count analysis attempts while inference is running, not dropped output frames. Quality codes: 0 Auto, 1 Fast, 2 Balanced, 3 Accurate.

The scheduling revision uses `video_tick` to permit one analysis draw per video frame. Metal submits the newest analysis texture from the previous tick rather than counting two render calls; preview/program may render more than once per tick. The provider leases the selected ring slot through completion of its blit, and rendering skips that slot. Vision works on its separate input buffer after the lease ends. No GPU wait is added to the graphics thread. OpenGL keeps its staged readback on the next tick.

Additional diagnostic fields: `input_wait_ms` is the elapsed time from analysis draw to provider copy start (including worker scheduling); `copy_ms` covers input preparation and copy completion; `mask_reuse_ms` is the age of the completed mask since publication. These sampled fields are not an end-to-end camera latency measurement. With a 30 Hz output, a previous-frame boundary plus inference can still make the displayed mask about two frames old; the scheduling revision does not promise to remove that floor. A reduction must be measured after restart.

## Acceptance procedure

1. Same camera recording: hair, spread fingers, fast head movement, low contrast clothing/background. Compare masks and edges on contrasting backgrounds.
2. Native room with one camera and active recording: Balanced then Accurate, 30 seconds each, Feather 0.35 / Erode 0.25. Compare mask age and completed mask rate.
3. Repeat with four cameras and recording. Check output frame drops separately from mask busy skips.
4. Do not change the default or add frame synchronization delay without measuring the quality/latency tradeoff. An older mask on newer video can trail motion; synchronizing them can add visible video latency.

No RVM integration or camera recording is performed automatically by this change.

## Initial local observation

Apple M1, 90 matched frames from an existing camera recording, with other compilation jobs active: Balanced mean 143 ms / p95 287 ms; Accurate mean 375 ms / p95 649 ms. These numbers include system contention and are not a clean hardware benchmark. Matched snapshots show sharper silhouette boundaries with Accurate, but both retain some background near moving people. No live one/four-camera recording acceptance run has been completed. Comparison artifacts: `/tmp/producer-cutout-camera-comparison/index.html`.

## Native live preview observation — October 8, 2026

User enabled Camera 2 Cut mode in the native lab, Feather 0.35 / Erode 0.25, and moved their head/hands. Auto selected Balanced for this camera; user then selected Accurate, confirmed by both the native quality=3 logs and UI. Eight five-second samples per mode, excluding Accurate startup/old-mask transition:

| Metric | Auto / Balanced | Accurate |
| --- | --- | --- |
| Mask dimensions | 512×384 | 2016×1512 |
| Completed mask rate, median | 28.51 Hz | 7.57 Hz |
| Latest inference duration, median of samples | 18.45 ms | 118.37 ms |
| Mask input age, median | 66.80 ms | 249.37 ms |

Both modes visibly removed the background. This validates live native mode switching and preview operation, not recording/streaming frame-drop acceptance or a controlled matte-quality comparison. Accurate's larger mask costs substantial motion responsiveness on this M1. Keep Balanced as the default pending further motion work. Raw log and sampled summary are in `src-tauri/target/cutout-lab/cutout.log` and `live-comparison.json`; screenshots are under `/tmp/producer-cutout-*`.

### Scheduling revision, same-day native preview check

Rebuilt and ad-hoc signed the native lab; Objective-C syntax, full Rust native build and bundle signature checks passed. User reopened the room, explicitly selected Balanced / Cut and moved their head/hands. Six consecutive explicit-Balanced samples completed essentially 30 masks/sec with zero busy skips. Mask input age remained around 65–67 ms. Input wait was about 32–35 ms, copy below 1 ms and inference about 14–16 ms, with another 17–20 ms of completed-mask reuse before the sampled render. Preview showed the cutout active and room output at 30 fps.

This confirms once-per-tick scheduling without claiming a meaningful reduction in mask age for this preview/program configuration. The previous-frame boundary dominates the avoidable delay; reducing it requires an explicitly synchronized GPU handoff rather than shortening the texture ring blindly. The old session log is preserved as `baseline-cutout.log`; new samples are in `scheduled-live-comparison.json`. Recording, Intel/OpenGL and four-camera acceptance remain unverified.

## Current-frame Metal handoff experiment

`engine/metal-current-frame.swift` is compiled with the pinned OBS Metal backend by `bash scripts/build-cutout-metal-lab.sh`. This lab-only builder uses the existing libobs framework, pinned OBS source and SIMDe v0.8.2 headers; it does not rebuild or replace the installed production engine. It emits the backend and runs `scripts/test-cutout-metal.swift`. The source cache records its OBS commit and refuses to reuse a mismatched cache.

The optional C ABI `producer_metal_copy_texture_async_v1` commits pending render commands and enqueues the input copy on the **same Metal command queue**. Its completion callback dispatches Vision to the provider queue. The engine retains both textures through completion; the provider and pixel buffer remain owned through inference. Rejection promises no callback; acceptance promises one callback reporting GPU completion status. There is no graphics-thread `waitUntilCompleted`.

Enable only in the lab with `PRODUCER_CUTOUT_CURRENT_FRAME=1`; the provider discovers the optional API in the already-loaded backend. Missing API or absent environment flag keeps the previous-frame path. The installed production app and engine artifact lock remain unchanged. Production source-build/extraction integration is still required before shipping this engine extension.

The real-GPU test passed 60 draws/copies, including a deliberately gated draw: the copy call returned without waiting, the callback did not run before the draw dependency, and the copied pixels remained correct when the ring texture was overwritten immediately afterward. Mismatched destination size rejected without a callback. Full native Rust/Objective-C build and ad-hoc bundle signature checks passed.

User enabled Balanced / Cut in the restarted native room with Feather 0.35 / Erode 0.25 and moved their head/hands. Native logs confirmed `input handoff: current-frame async`. Settled samples completed 30 masks/sec with zero busy skips, input wait approximately zero, GPU copy around 1–2 ms, inference around 15 ms and mask input age around **33–36 ms**, compared with **65–67 ms** immediately before this handoff. This removes roughly one 30 Hz frame of mask delay in this local preview test. It does not change Vision's segmentation model, establish matte accuracy or validate recording/four-camera load. Artifacts: `current-frame-live-comparison.json`, `scheduled-baseline-cutout.log`, `cutout.log`, and `/tmp/producer-cutout-current-frame-live.png`.

## Edge refinement experiment

`edge_refine` adds an image-guided mask upsampling pass, bounded to a 1280-pixel longest edge. Nine neighboring mask samples are weighted by spatial proximity and similarity to the current camera pixel's linear RGB. The resulting mask stays in linear confidence space. The compositor smoothly changes erosion from the native coarse-mask grid toward the finer output grid as refinement strength increases. This reduces indiscriminate removal of thin features; it is not a replacement matting model or a color-spill remover.

The pass runs once per video tick and is reused for repeated preview/program renders. Zero refinement skips the pass and keeps the existing edge processing. Masks already finer than the bounded target (including the observed Accurate output) retain their native detail. The UI slider and native whitelist both expose the value. Default is zero; the isolated lab opts into 0.65 via `PRODUCER_CUTOUT_EDGE_REFINEMENT=1`. Hair or fingers absent from Vision's mask cannot reliably be reconstructed this way.

`scripts/test-cutout-refinement.m` tests the actual effect on the actual Metal renderer. A constant 0.5 confidence stays 0.5 through rendering/readback, a synthetic color boundary moves confidence down on the background side (124→99) and up on the foreground side (132→157), and a high-contrast thin feature survives the same Erode setting (alpha 0→255). The test caught and fixed a texture-binding-order issue: the Refine shader must reference `image` before `mask`, since libobs' sprite draw binds its image at texture unit zero. These are controlled GPU checks, not evidence of real-world hair quality.

The frontend build, full native build, shader checks and ad-hoc bundle signature verification passed. User enabled refinement 0.65 with Feather 0.35 / Erode 0.25 and tested head/hand movement; the UI was verified in Cut / Auto (Balanced for this camera). The last eight matching samples are saved in `refinement-live-comparison.json`. Their medians are 29.99 mask updates/sec, 33.95 ms mask input age, and 29.91 encoded refinement passes/sec. Mask age excludes camera capture and completed GPU refinement/display latency; refinement pass rate is not a GPU execution-time measurement. The user confirmed the earlier responsiveness improvement; real-world refinement quality still needs visual comparison. The lab builder also builds and runs the shader test. Recording and four-camera acceptance remain pending.

## Production promotion — v0.4.68

After the user confirmed generally good appearance and authorized production deployment, the tested current-frame Metal path became the default when the engine exposes its copy API. Setting `PRODUCER_CUTOUT_CURRENT_FRAME=0` forces the previous-frame fallback. Edge refinement defaults to 0.65 when no explicit setting exists; saved explicit values remain unchanged. Diagnostics remain opt-in. Earlier sections describe the historical lab-only configuration.

The source engine builder compiles `engine/metal-current-frame.swift` into the pinned upstream Metal target and refuses to publish an artifact without the exported API. Engine artifact revision 9 distinguishes it from previous engine archives. Local extraction rebuilds/tests the same pinned renderer instead of silently retaining the old official renderer. Release publication follows the existing signed/notarized Apple build and updater workflow.
