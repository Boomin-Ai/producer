# Prepare the selected set, then take ready segments

Audit date: 2026-10-24. This is a code investigation and proposed refactor, not an implemented preload pool. It follows the native timing pass in `native/segment-timing-proof.json`.

## Finding

Prepare the whole selected set's finite authored layouts ahead of use. Next, Previous and direct segment/layout selection should request a ready scene, apply current runtime inputs and authored entry motion, and switch it on the render thread. They should not construct browser graphics pages, recreate media sources, wait for initial paint or run full layout compilation in the normal ready path.

The existing work is useful, but it contains two different paths. Extend/converge the actual native room path instead of adding another independent preloader.

## What exists and where it is used

| Code | What it actually does | Decision |
| --- | --- | --- |
| `src/features/presentation/useSetOutput.ts:nextSetProjection` | Predicts only the declared next show phase, including its default ballot state and paused media. Looks for an orientation-matched next layout. | Replace next-only preparation discovery with all authored layout discovery. Keep/reuse entry-state rules, with one shared implementation in the show runtime. |
| Legacy `useLegacySetOutput`, `OutputSettings`, `live/presentation.rs`, `live/graph.rs:prewarm_presentation` | Carries a `preload` projection; prepares a spare composition and can promote a compatible spare. Includes real reuse/patch checks for capture identity, geometry, media and animation. | Preserve lessons and useful semantics; do not keep a second long-term production loader alongside the new native system. Remove obsolete path when migration is complete. |
| `src/features/sets-v2/useRoomOutput.ts` | Actual native room adapter. On a visual change, waits 40 ms, compiles that layout, submits prepare, polls readiness, takes and waits for native render confirmation. Does not use `nextSetProjection`. | Replace on-demand rebuild with explicit load/readiness/take operations. Keep room ownership, errors, cancellation and native receipts. |
| `src-tauri/src/live/sets_v2/mod.rs:RoomProgram` | Owns one `building`, one `draft`, one `current`. Preparing can replace the previous draft; finishing a take replaces the previous current owner. | Introduce a room-owned bank of independently prepared scene records. Scene residency must not depend on being current or next. |
| `src-tauri/src/live/sets_v2/program.c` | One current source, one pending source, one retiring source and an optional authored transition. Motion/media bindings are copied from pending to current on take. Retired bindings/sources are collected. | Keep the small rendering/swap core. Separate it from ownership of all prepared scenes; a take borrows/retains a scene record rather than consuming the only candidate. |
| Native `resources::Store` | Reuses authorized asset bytes/files. `open(plan)` still creates fresh image/video/shader OBS sources for each preparation. `Arena::graphics` creates fresh browser sources for graphics batches. | Add actual shared resource leases/retained graphics. A cached file is not a ready decoded image, video player or painted graphics surface. |
| TS `ResourceRegistry` / `PresentationController` | Useful ownership/transaction abstractions with integration tests. Searches show no application imports of these classes in the current room path. | Wire useful contracts into the real implementation; do not describe these tests as proof of actual native pooling. Avoid a third coordinator. |
| Existing native readiness | Media first-frame checks, graphics paint marker checks, render-thread warming and render receipts. | Keep these; readiness must mean usable native resources, not merely parsed JSON or compiled plans. |

## Whole set means layouts, not only the phase list

The saved library includes:

- Atlanta Culture: one show phase, four authored layouts.
- AI Stack: one show phase, ten authored layouts.
- Head to Head Arena: seven phases, fourteen layouts.
- Producer: six phases, twelve layouts.
- Shader Lab and Combo Studio: sixteen phases and thirty-two layouts each.

A queue generated only from `phase.next` or the rundown misses controls that switch layouts inside one phase. Discover every authored layout, including alternate modes and both design orientations. Use an explicit mapping from segment/layout to prepared output candidates; do not rely solely on suffix guessing for future package structure.

Prepare layouts for the active output target first. In Both mode, report readiness for both required targets. An unused portrait target should not prevent a landscape segment from becoming ready. Output resolution, source framing and target scaling are part of readiness identity.

## Ownership and preparation lifecycle

1. **Selection:** Create or retain an editor candidate set instance when a set is chosen. Start loading its complete layout inventory. This is off-air and must not change the running show or discard the active set's resources.
2. **Room-level service:** Keep the preparation bank, ready/error records, show clock and work queue in the room runtime. Editor/panel components only subscribe and issue actions. Closing the editor or collapsing the bottom panel must not stop preparation or the show clock. The current `SetControlsPanelView` interval and component-owned draft are not the right permanent ownership boundary for that requirement.
3. **Priority:** Current/selected layout first, likely next second, remaining layouts after that. Next becomes a queue priority hint, not a special second renderer or a separate prediction pipeline. Load the full set rather than ending after the next layout.
4. **Bounded work:** Limit simultaneous graphics/media builds so background loading does not stall current output. Build and warm each scene, then stop off-air animation/render work once its resources are ready. Keeping every prepared shader and video running would defeat the goal.
5. **Resources:** Reuse compatible camera captures, immutable assets, graphics batches and shader programs. Preserve separate playback/animation state when instances need different clocks or video positions; identical asset bytes alone are insufficient grounds to share a mutable player.
6. **Ready receipt:** Mark the exact candidate revision ready only after its native media/graphics readiness and render warm-up checks pass. Report queue/build/waiting-for-input/error separately from ready.
7. **Take:** Take an exact ready handle/revision. Apply current field/data values and entry state, reset segment-local media/animation clocks, and run only the set-authored transition. Dynamic changes must be reconciled before declaring ready; the bank is not a set of frozen screenshots. Preserve live camera video and correctly ordered mixed content.
8. **Retain:** Keep ready scenes after visits, including Previous and arbitrary jumps. Do not free the previous scene simply because an authored transition completed. Release transition references separately from scene residency.
9. **Invalidate precisely:** Text edits, framing/source reassignment, media changes, design changes and output-size changes invalidate only dependent records/resources. Reuse unchanged resources and patch retained content where supported. A geometry-changing edit can rebuild the affected scene in the background; do not label its old revision ready for the new configuration.
10. **Dispose safely:** Abandoning a candidate cancels its queued work and releases only its leases. The running program and its old-generation native references stay alive until their own output ownership ends. This preserves the private-rehearsal boundary just added.

## Readiness UI

The segment list in the room subscribes to native readiness even with Set edit closed.

- **Queued/loading:** slightly muted label/number or row treatment; do not fade it so far that the text becomes difficult to read. No permanent spinner in every row.
- **Ready:** normal existing Producer brightness, with the current segment's existing selected styling preserved.
- **Waiting for assigned input:** distinguish a missing/unavailable assigned source from a scene still being prepared. Intentionally empty slots remain a valid design.
- **Failed:** a small explicit error/retry affordance. Avoid leaving failures indefinitely gray.

A click on an unready row prioritizes it but keeps the current output. Use one replaceable pending take intent, so rapid clicks cannot cause a series of delayed unexpected takes. If that exact intent is still current when readiness arrives, it can take. Next follows the same path. Never switch to a stale revision or a blank frame. A selected/loading row is not the same as the on-output/current row.

Aggregate a segment's row readiness from its relevant layout and active output requirements, not from every alternate layout in the package. Show alternate-layout readiness in its own control as well. A set-level `Loading 5 of 7` summary can help, but individual readiness remains the source of truth.

## Dynamic audience data and morphs

Preparing every segment cannot predict future votes, headlines, reactions or a morph's starting geometry. Prepare reusable scene structure/resources ahead of time; apply the latest public inputs and supported retained property/layout patches at entry. Structural changes require a new candidate revision. Poll/result state remains in the shared data/show runtime, never baked into independent prepared scene state.

The current morph tracks are calculated from the scene being left to the scene being entered. Keep that calculation at navigation time; do not force every possible source/destination pair to be pre-rendered. Crossfades keep their authored duration; missing/cut transitions add none.

## Budgets and acceptance

The current native budgets are per composition (including graphics surface and scene texture bounds), not an aggregate loaded-show budget. The 32-layout shader sets demonstrate why extending the current ownership model by holding every independent browser/video/shader allocation is insufficient. Add an aggregate resource budget with deduplication. If an unusually large set cannot remain resident, report that honestly; do not silently present an evicted scene as ready.

Acceptance should exercise the real native room path:

- Every library layout is discovered, including alternate layouts within one phase and both orientations.
- Readiness continues and remains visible while the editor is closed; collapsing panels does not suspend the show clock or loading.
- Ready Next/Previous/direct jump performs no full compile/prepare or first-paint wait.
- Repeat visits retain scenes; source bindings, fields and data stay current.
- Off-air videos, audio, shaders and polls do not start early.
- Ready scene takes aim for the next render opportunity, with native click-to-frame timing measured again. At 30 fps one frame is about 33 ms, but exact latency must be verified rather than promised.
- Authored morphs and crossfades retain their semantics; no implicit global transition.
- A dirty scene cannot take its stale ready record. Failed/cancelled preparation retains current output.
- Large libraries, rapid selections and portrait/Both changes stay within aggregate budgets and release old leases correctly.

No runtime changes were made for this audit. The recommended next implementation is a unified room-owned prepared-scene bank and readiness model, replacing native on-demand candidate construction and the older next-only preparation policy.
