# Shared view and graphics caching

Weather API response caching and rendered-view caching solve different delays. A forecast tab reads the already fetched data, but its changed text/card composition previously produced a different scene identity and new browser graphics sources.

The shared output path now has two additional reuse mechanisms. No weather-specific cache branch or package schema change is required.

- Immutable native graphics layers are keyed by their exact trusted HTML and raster dimensions, within one output owner. Unchanged headers and graphics share their source and crop surface across prepared scenes. Changed text creates a separate layer; it never edits the on-air raster in place. Existing image, camera and managed 3D resource ownership is preserved.
- The frontend can prewarm up to three alternate, single-step `view` actions per current composition orientation, using current public module fields. It does not dispatch actions, perform IO, change authoritative state, generate combinations of modules or project private pending results. Controller modules already select ordinary layouts and continue using layout preparation.

Graphics CSS serialization is deterministic so equivalent paint maps yield identical raster identities. Placement, dimensions, density, style and text remain part of that identity. Different outputs/owners do not share a mutable global cache. Weak entries disappear after the last scene releases them; ordinary scene budgets remain conservatively charged even when an immutable raster is shared.

When speculative views exist, preparation prioritizes the current composition and its alternate views, capped at five candidates per native output. The presented snapshot is retained separately. This reserves space for an in-flight replacement and avoids warming every composition × module view product. Less-used compositions can remain unprepared until selected. Ordinary layout inventories without speculative views keep their prior behavior. Native scene-count, surface, texture-byte and first-paint limits still apply; failed preparation retains current output.

Changing a city or receiving new data invalidates affected content identities. Unchanged artwork/headers can still reuse their graphics layers, while affected view snapshots prepare against the latest public values. First visits to unprepared views, newly fetched content, layout geometry edits and cold 3D startup can still take time. This does not add arbitrary per-field native text patching or promise instant cold loads.

Verification:

- `node scripts/test-prepared-scenes-browser.mjs`: ready module view takes without compilation, speculation does not mutate module/session state, bounded preparation priorities, existing queue/retry/churn/asset retention regressions.
- `cargo test --manifest-path scripts/sets-v2/rust-probe/Cargo.toml --test contract`: strict validation and deterministic graphics serialization across separately parsed paint maps.
- `node scripts/test-graphics-cache-browser.mjs` then `PRODUCER_PROBE_GRAPHICS_CACHE=1 PRODUCER_PROBE_VISUAL_EFFECTS_ONLY=1 PRODUCER_PROBE_OUTPUT=/private/tmp/producer-graphics-cache-proof bash scripts/sets-v2/run-native-probe.sh`: actual native owner and CEF raster creation. Two initial graphics layers become three when one caption changes; selecting the same content again stays at three. The camera remains live, and pooled group references release on teardown.
- `VITE_VIEW_CACHE_PROOF=1`: explicit dev-only forecast control timing against native presentation receipts and graphics layer counts. Disable for manual use.

This work remains local until user review and a separately authorized release.

Live verification on this machine: eight warm tab selections took 124–256 ms from click to observed native presentation (median 138 ms), with seven graphics layers throughout. See [view-cache-proof.json](view-cache-proof.json). These measurements include receipt polling and do not predict other hardware.


## Graphics continuity across takes

Readiness receipts alone do not guarantee that a browser-backed raster survives a later visibility transition. Cached immutable graphics now own an independent active/showing lease from creation through final cache release. This prevents a cached take from reactivating a hidden CEF paint producer after first paint was already validated. Scene activation still changes composition ownership; it does not reset the graphics producer's visibility. Audio mixers stay disabled, budgets stay in place and the last layer lease balances both showing and active references during teardown.

A user recording provided frame-level evidence: 14 of 406 encoded frames (13.6 seconds at 30 fps) were missing the persistent header, in runs of one to three frames. The scene background and native frame remained visible. The native regression now inspects every output frame during 60 cached takes; the repaired run observed 197 frames with zero missing header frames, stable graphics-layer counts and complete group cleanup. This measures graphics continuity, separately from command/commit/presentation timing.

`xcrun swift scripts/sets-v2/inspect-graphics-flash.swift INPUT.mp4 OUTPUT_DIRECTORY` decodes every frame of a 1920×1080 Atmosphere recording, reports white-header sample counts and saves adjacent frames for dropouts. Its region/threshold is a diagnostic for this authored fixture, not a general classifier for arbitrary sets. `VITE_VIEW_CACHE_PROOF=1 VITE_VIEW_FLASH_PROOF=1` records a bounded real-room control sequence for the same check. These flags remain disabled during manual use. Recordings contain the room's actual output and stay local.

Real-room recording after the lifetime repair: 32 time-block selections, 1,918 decoded frames, zero missing-header frames (white-header samples remained 720–727). Graphics layer count stayed at seven and managed 3D contexts at two. Compare [baseline](graphics-continuity-before.json) with [repaired output](graphics-continuity-after.json). This validates the tested fixture/path; it does not claim every kind of authored transition or external browser source is covered.


Sets may now explicitly author `animation.transition.contentDurationMs` (0–1000 ms) independently of the layout transition. A cached same-layout update can dissolve between ready scenes while a composition continues to use placement morphs. The field is opt-in; older Sets retain their previous transition behavior. Preparation and readiness still finish before the take, and paused outputs do not animate. Atmosphere 2.1 uses 260 ms content dissolves and 760 ms composition morphs.
