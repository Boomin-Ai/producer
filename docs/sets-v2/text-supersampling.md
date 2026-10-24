# Native 1080p text vs selective supersampling

**Recommendation: retain native density as the default.** At 1080p the extra sampling mainly changes edge smoothing. In the inspected static Arial fixture, it is a subtle aesthetic change rather than a clear readability improvement; native small text retains strong stem contrast. This is a visual assessment, not an objective proof that one antialiasing pattern is universally best. The prior blur/resolution fixes remain in place.

This experiment does not add a production quality setting. It uses the shipped Rust graphics serializer and CEF plugin for identical 12–52 px text on dark and light panels. Only a 1760×800 graphics region is rasterized at 1x, 1.5x or 2x; the native backdrop and 1920×1080 output stay unchanged. A native crop removes the physical first-paint marker and downsamples that region once. The compound graphics source passes through the real RoomProgram's preload/activate/take path. It is injected as a trusted probe source; this is not an end-to-end implementation of an optional package quality field or a claim that the production graphics-batch planner already chooses selective supersampling.

All full images are **1920×1080**. The 840×650 detail images are native pixel crops, verified byte-for-byte against the corresponding full readback. No image enlargement or post-sharpening was applied.

| Density | Requested browser RGBA bytes | Browser pixels vs native | Two trials: median render + readback |
| --- | ---: | ---: | ---: |
| Native 1x | 5.38 MiB | 1x | 4.28, 5.36 ms |
| 1.5x | 12.10 MiB | 2.25x | 6.00, 8.68 ms |
| 2x | 21.50 MiB | 4x | 6.59, 8.33 ms |

Each trial measures 25 synchronous render/allocate/RGBA-readback operations after three warmups. Densities are interleaved 1, 2, 1.5, 1, 1.5, 2. Readback and allocation are included, so these values are **not** GPU-only render time, normal video-frame time, FPS or encoder latency. CEF startup makes first-paint samples order-dependent; no startup-performance conclusion is drawn.

The crop texture reserves another 5.37 MiB at every density, and the native scene reports the same 23.73 MiB reservation. These are requested buffer estimates, excluding CEF's additional buffers, driver overhead and total process/GPU memory. The 2x variant adds about 16.12 MiB of browser RGBA storage for this region alone. Sixteen equally sized resident layouts would add about 258 MiB per output before additional CEF buffering. The existing whole-set banks make that cost material. This is not a measurement of total memory growth in an actual 16-layout set.

The prototype uses the existing native/browser downsampling path; a different reconstruction filter, font, motion or text scale could change the result. No custom sharpening/reconstruction filter was tested.

A future optional high-quality mode could be reasonable for a particular title/font or animation after its own comparison. The present result does not justify a global supersampling multiplier, increasing memory budgets, or changing all existing sets.

Artifacts: [native full output](native/text-quality/text-1080p-1x.png), [1.5x full output](native/text-quality/text-1080p-1.5x.png), [2x full output](native/text-quality/text-1080p-2x.png), [native detail](native/text-quality/text-1080p-1x-detail.png), [2x detail](native/text-quality/text-1080p-2x-detail.png), [measurements](native/text-quality/text-quality.json), [source hashes](native/text-quality/text-quality-run.json).

Reproduce in an isolated native host with the installed Producer runtime read-only:

```sh
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 \
PRODUCER_PROBE_TEXT_QUALITY_ONLY=1 \
PRODUCER_PROBE_OUTPUT=/private/tmp/producer-text-1080-proof \
bash scripts/sets-v2/run-native-probe.sh
```

Only macOS Apple Silicon/Metal and static Arial text were tested. No change to the normal dev or production renderer was made by this experiment.
