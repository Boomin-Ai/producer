# Set output performance — October 7, 2026

Set preparation now warms the selected layout off air. Sending it to output reuses the warmed native composition. Active graphics and playback updates use the existing browser surfaces; changes requiring new placement geometry or media use an off-air composition before switching output.

## Changes

- Cache immutable embedded media within each canvas lease. Subsequent requests send asset changes and an ID manifest, rather than the entire package. Prune removed assets and clear caches when ownership changes.
- Stream projection updates through the scoped native bridge to persistent renderers. Track render serials separately from authored revisions, including predicted next-segment revisions.
- Preload the next segment's matching landscape or portrait layout. Reuse camera placement proxies and their framing/appearance filters.
- Schedule edits immediately and coalesce pending state. Keep active output controls available while an update is preparing.
- Wait for decoded media, browser geometry and a marker painted by the graphics document before committing prepared output. Ignore stale receipts and cancel pending work when returning to the room.
- Warm portrait independently, while preserving its native room canvas and independent source positioning.

## Evidence and limits

The actual Claude Code media walkthrough's cached projection packet shrank from 9,955,813 bytes to 4,069 bytes. Mocked real-hook browser tests include the preload and manifest: subsequent packets were about 8.3 KB in Chromium and WebKit.

Native isolated probes verified rendered pixel changes, unchanged original sources, and cancellation on Return to room. Two runs measured warm landscape Send at 37–58 ms and active graphics changes at 83–177 ms until matching pixels appeared in raw output frames. IPC acknowledgements generally arrived earlier; these are distinct measurements.

Media-heavy cuts remain variable: landscape cuts measured 277–1,593 ms and portrait cuts 684–825 ms. Portrait warm Send measured 43 ms in one run and 3,471 ms in another. Initial background preparation was roughly 0.7 seconds. This work substantially reduces repeated transport and rebuilding, but does not establish instant or bounded latency for every media transition. Browser decode and off-air rendering remain performance work.

Landscape and portrait consume the same show state and playback clock, but prepare and commit independently. They are not a frame-locked dual-output transaction.

## Validation

- `node scripts/test-set-update-speed.mjs`: real package transport and cache checks; writes isolated native probe fixtures.
- `node scripts/test-set-speed-browser.mjs`: real output hook, background warming and compact updates in Chromium and WebKit.
- `node scripts/test-presentation.mjs`: presentation contracts.
- `node scripts/test-presentation-output.mjs`: native renderer document, scoped bridge and revocation.
- `node scripts/test-media-playback.mjs`: browser playback lifecycle.
- `cargo test --manifest-path src-tauri/Cargo.toml presentation::tests --lib`: native geometry, caching, serials, resource limits and private bridge tests.
- Native probe fixtures/results: `/private/tmp/producer-set-speed`, using the prepared dev bundle with `PRODUCER_SET_OUTPUT_PROBE` set to that directory. Run in isolation, then quit it before opening the normal dev room.

Production was not replaced. The development bundle is `src-tauri/target/dev-room/Producer.app`.

## Scene-change loading regression

Scene changes can discard native prepared compositions while the frontend still remembers sent media. The frontend now invalidates its asset cache on native generation changes, checks status before applying, and retries a missing-media rejection once with complete assets. Failed preparation clears the frontend cache for subsequent attempts. Portrait preparation also invalidates its cache on generation changes and failures.

Saved local-camera bindings now follow a unique ready camera on the current scene when the previously assigned camera is hidden or unavailable. Multiple ready cameras retain the explicit assignment; guest and other media bindings are preserved.

The real-hook browser regression covers hidden previous-scene cameras, generation changes and cache loss without a generation change. Chromium and WebKit passed, with normal cached requests still around 8.3 KB.

## Media-heavy segment optimization

Matching next-segment compositions now retain their decoded media and camera filters. Next adopts their existing preparation instead of resetting the render serial and repainting the same layout. If preparation is still running, its original receipts remain valid for the adopted request. Changed graphics, source assignments/dimensions, media bytes or entry positions take the normal preparation path.

Next-segment projections predict phase-dependent content and playback entry rules, include configured camera framing, and decode while paused. Playback starts when the prepared composition commits. A transport-only update preserves the decoder and DOM. Preparing the following segment runs after the current commit returns; edits refresh that preparation only when its content actually changes.

The bounded asset cache receives package assets during initial preparation, so a cut does not need to transfer and validate the following segment's large video. Browser documents still receive only assets used by their layout. The playback driver also lets each initial decode and seek complete before issuing another clock-driven seek, avoiding decoder starvation during preparation.

Latest isolated native run with the actual Claude media package:

| Operation | Native acknowledgement | First matching recorded pixels |
| --- | ---: | ---: |
| Warm landscape Send | 3 ms | Not separately sampled |
| First prepared landscape cut | 8 ms | 90 ms |
| Second prepared landscape cut | 1 ms | 68 ms |
| Warm portrait Send | 3 ms | Not separately sampled |
| Prepared portrait cut | 1 ms | Not separately sampled |

This probe allows 1.8 seconds of host presentation time between cuts for background decoding. Initial background preparation measured 763 ms for landscape and 961 ms for portrait. Rapidly skipping ahead before decoding finishes can still wait; matching in-progress preparation is retained. Resume/continue positions that have advanced beyond the prepared frame require a fresh seek. These measurements are a local acceptance run, not a guaranteed latency bound.

Recorded-pixel checks verified the landscape host camera moved to each segment's assigned box, original room source state stayed unchanged, and Return cancelled queued output work. `scripts/test-prepared-media.mjs` passed in Chromium and WebKit for paused preparation, decoder-preserving promotion and shared-clock play/pause. The prediction check in `scripts/test-set-update-speed.mjs` covers all six Claude segments; native promotion, revision and design/seek guards have unit coverage.

Landscape and portrait remain independently committed outputs sharing show state and playback clocks; this change does not make them frame-locked.
