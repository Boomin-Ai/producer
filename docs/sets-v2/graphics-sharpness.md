# Set graphics sharpness

The shared native compositor now preserves output pixel density when a set design is enlarged. Set packages and authored coordinates do not change.

Browser batches render at `max(1, output/design scale)`, using the fit policy (the larger axis for cover/stretch). CSS zoom rasterizes text and graphics at that density. The first-paint marker lives in a separate physical pixel row; the crop wrapper removes it before composition. Crop wrappers, source framing wrappers and isolated native scene groups use the same density. Rounded-mask antialiasing uses physical pixel units. Output and per-scene/bank budgets include the enlarged textures, browser pixels and intermediate wrappers.

Plain native groups bypass their intermediate texture when opacity is 1, radius is 0, and every visible child stays inside the group with identity placement rotation/scale. This check happens on every render, so animated overflow restores clipping and group opacity still isolates overlapping children. Children retain their native source identity. Fractional translations accumulate before rasterization instead of being repeatedly sampled in each plain parent texture.

There is no global sharpening filter, forced pixel snapping, blanket 2x supersampling or change to fonts, set layouts, native capture or authored transitions. Designs already larger than the output retain their raster density and are fitted down. Groups requiring clipping/masks remain isolated. Arbitrary large animated zooms are not dynamically rerasterized, and enlarging an embedded low-resolution bitmap cannot recover its detail. Existing 8192-dimension, per-surface pixel, scene and bank limits still apply; oversized requests fail rather than silently dropping quality.

## Native comparison

The fixture contains small text and stripes one output pixel wide, nested through separately retained groups, with and without rounded isolation. It exercises the actual Rust RoomProgram, CEF first-paint readiness, native scene preparation, cached activation and take. Landscape and portrait are each tested at 1.5x and 2x. The reference is an equivalent design authored at the full output resolution.

In the sampled text/line region, average absolute channel error against that reference fell from 7.19–12.61/255 on the previous compositor (`ad69274`) to 0.95/255 at 1.5x and 0 at 2x. New stripe samples have no intermediate gray pixels. This measures the synthetic fixture, not every set or final stream delivery.

[Before](native/sharpness-before.png) and [after](native/sharpness-after.png) are unmodified native 640x360 output captures. The previous renderer was built in a temporary copy at `ad69274`; its comparison harness collected measurements without enforcing the new sharpness thresholds. It did not modify the workspace or installed app.

The full native proof also checks mixed source ordering, clipping, group opacity, animation, authored transitions, both output orientations, retained scene reuse, stale-plan rejection and cleanup. The room probe checks segment switching and that Shader Lab and Combo Studio still prepare 32/32 layouts each. No Windows/Linux or encoder/remote-playback sharpness claim is made.

Run the full native suite with `npm run test:sets-v2-native`, or only the density fixtures with `PRODUCER_PROBE_SHARPNESS_ONLY=1 npm run test:sets-v2-native`. The focused run writes `sharpness.json`; a complete run writes `proof.json` and source-hashed `run.json`.

## Room timing and evidence

The foreground confirmation run completed all 18 segment changes: Arena median 59 ms (49–75), Claude Code 55 ms (47–75), and Producer 387 ms (368–397), including its authored 320 ms fade. Both shader inventories again reached 32/32. These are polled click-to-native-completion observations, not display latency. The [final room report](native/sharpness-room-proof.json) retains every sample. The [first pass](native/sharpness-room-first-pass.json) also passed inventory preparation but recorded one 23.8 s outlier: its timing events put 23.4 s before `apply-start` and 393 ms inside the compositor path. A separate earlier attempt timed out waiting for an initial-render event. Their scheduling cause was not established; neither is silently represented as a fast sample.

The [comparison measurements](native/sharpness-comparison.json), [native assertions](native/sharpness-native-proof.json), and [source-hashed run](native/sharpness-native-run.json) cover the rendering changes. The focused 2x captures are synthetic native output, not screenshots of a scaled editor preview.
