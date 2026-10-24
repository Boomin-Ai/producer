# Isolated Sets v2 room

Updated 2026-10-24. The isolated `Producer Sets v2 Dev.app` opens the normal Producer room, set picker, controls and Set edit dialog. The engineering lab remains an internal diagnostic page.

Run `npm run dev:sets-v2` for the local frontend, then `npm run dev:sets-v2-room` to build and open the app. `python3 scripts/sets-v2/dev-room.py --prepare` builds without opening; `--smoke` exercises the normal room controls automatically.

The app uses identifier `ai.boomin.producer.sets-v2-dev`, isolated storage, a copied set library and copied local media-picker grants. It does not copy account credentials or modify original set packages. The staged bundle is `src-tauri/target/sets-v2-dev/Producer Sets v2 Dev.app`.

## Available for review

- Choose a set through the existing picker. “Show configured sets when selected” controls automatic output.
- In Set edit, assign an existing room source or use **Add source here** to create and assign a camera, screen, image, video or color source. New sources start hidden in the ordinary room scene; a set placement can render them independently.
- Sources, embedded images/video, trusted shader presets and ordered browser graphics pass through the native compositor. Preparation waits for resource readiness and graphics paint markers before taking output.
- Layout changes use a native dissolve. Native source rendering drives transitions, shader time, media playback and bounded declarative motion tracks.
- Output settings supports an independent portrait composition through the same renderer.
- Show room scene returns to the original scene and invalidates pending main-output work.

## Verified

The native Metal harness rendered all ten authored layouts: three Head to Head, three Signal Desk and four Atlanta Culture portrait layouts. Output captures are in `native/`. It also checks mixed-content ordering, masks, live source movement, transitions, native ownership and cleanup, source authorization and strict transport validation.

The normal-room app smoke passed inline color-source creation and assignment, hidden room visibility, automatic takes across the three sets, and portrait rendering. Evidence: `native/normal-room-ui-proof.json`. This uses synthetic color sources, without physical cameras, microphones or streaming destinations.

The existing 16 runtime integration checks and browser poll checks cover shared audience state, independent skins, privacy, orientation continuity, data validation and deterministic animation. They do not prove hosted audience integration in the normal room.

## Remaining refactor work


- Integrate shared audience/data channels into the normal room presentation path; current snapshots still require preparation for visual changes.
- Retain/cache graphics and media across content changes, predict upcoming segments and measure frame times. No speed improvement is claimed yet.
- Coordinate landscape and portrait takes atomically; current native controllers are independent.
- Complete portable package migration. Existing editor projections are lowered into the new native graph; the full breaking authoring-format cutover is unfinished.
- Finish Lottie support, overflow/blur bounds and native blend semantics across the complete library; audit root-geometry animation and interruption handling.
- Test physical sources and Windows/Linux support before broader rollout. Current native evidence is Apple Silicon/Metal only.

No production deployment has occurred. HTML-to-canvas remains out of scope.


## Source previews inside Set edit — 2026-10-24

The editor now subscribes to the actual assigned room sources, including sources hidden from the ordinary scene. Existing thumbnail capture produces bounded 256×144 previews at a minimum requested cadence of 8 fps while an editor subscription exists. The sandboxed preview restores the source aspect ratio and applies per-slot framing, masks, opacity and grayscale. These are configuration previews; final output keeps its native resolution.

Reassignment clears the old source picture. Empty slots and sources awaiting frames show explicit states. Closing the editor unsubscribes its lease; preview activation does not add a source to the room scene or change mixer settings. Multiple preview leases coexist with guest and program-thumbnail demand.

Verification: `npm run test:set-source-preview-browser` checks decoded source images, restored portrait proportions, reassignment and subscription cleanup. The 19 presentation runtime checks and TypeScript checks pass. The rebuilt app smoke confirms a hidden source produces native preview frames; see `native/source-preview-ui-proof.json`. Smoke tests now use their own local room so the normal dev room's source assignments are preserved.


## Segment navigation and editor structure — 2026-10-24

Set edit has a segment selector and Previous/Next controls in the details pane. Every declared segment is reachable without closing the dialog, including before a show starts. A separate layout selector supports sets with several compositions. Selecting a segment retains authored field edits and source bindings; an active rehearsal pauses at the selected segment, with media and animation clocks held until resume. Voting segments begin with fresh rehearsal ballots. Output updates remain explicit in the dialog header; paused native layout changes use a cut so they do not wait for a frozen transition clock.

The editor uses the existing UI surfaces and controls: preview left, navigation/fields right, source cards below, stacked at smaller widths. Source creation sits next to the assignment picker. Slot numbers retain muted native text styling. Tests: 20 presentation runtime checks, TypeScript, `npm run test:set-editor-navigation-browser`, and the source-preview browser check.
