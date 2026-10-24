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


## Stable set control surface — 2026-10-24

Prepared and rehearsal modes now share the same three-column structure: current segment plus scrollable rundown in one card, segment controls, and assigned sources. Start/Exit, mode badge and output status reserve consistent widths. Layout choices use a selector rather than a growing button wall. Segment list entries can select a segment through the same pause-for-editing command used by the editor.

The minimized bottom bar keeps fixed playback and edit controls, bounded segment/layout selectors and an Actions popover. Narrow panels prioritize playback and segment selection; layout editing stays available through Set edit. Extra layouts/actions no longer add unbounded buttons to the bar.

Set edit now sizes the preview against the actual remaining viewport after the header and source tray, preserving the complete landscape/portrait canvas when the source tray expands. Editor panes explicitly reset inherited full-height minimums that previously caused clipping.

Browser checks cover unchanged section/playback rectangles across Start/Exit, 20 extra layout choices at widths down to 450px, and expanded/collapsed source trays for landscape/portrait at three desktop heights. Commands: `npm run test:set-panel-layout-browser` and `npm run test:set-editor-navigation-browser`.


## Show-run card and minimized scrolling — 2026-10-24

The combined rundown matches the requested structure: Show run and mode header, running indicator, title/countdown row, next-segment/position row, section count, and numbered segment rows with a highlighted current entry. Native surfaces, typography and mint accents are retained. The minimized bottom bar clips overflow, hides expanded content and centers its toolbar; it is not a scroll container. Browser checks explicitly attempt horizontal and vertical programmatic scrolling at 56px row height and confirm offsets remain zero, while playback/edit controls remain accessible across tested widths.


The rundown now prioritizes segment visibility over its summary: tighter row/header spacing and a compact title. In short cards (300px content height or less), the duplicate title/up-next summary is hidden; the current segment remains highlighted in the list. Browser regression checks use seven segments and verify that the list consumes over 55% of card height, shows at least four complete rows in tested short docks, and all seven at dock heights of 460px and above. Narrow panels receive a bounded rundown height rather than collapsing under size containment.


The three control cards now use Producer's shared surface, line, text and accent tokens. Segment controls and Sources have consistent card padding; heading, layout selector and actions have explicit spacing. Nested source-card paint is removed, and playback/status controls use existing primary/red/amber tokens. Browser checks assert matching card colors/borders, no gradients, internal padding and spacing between the selector and actions, while retaining the geometry/overflow checks.


## Unified set editor toolbar — 2026-10-24

The room header no longer contains the set dropdown. A single **Set** button in the set control panel (the former Set edit position) opens the existing full editor. A dedicated full-width toolbar above the preview and segment fields contains Choose set, Import set, Export set, Media assets, Show set/Show room scene and Set options. Segment navigation/fields remain in the right pane; source assignments remain below.

Set options preserves automatic showing, reload saved set, agent authoring, add-show authoring where applicable, test data and activity. Built-in/library/imported set selection updates the same open editor. Closing export or media dialogs preserves the editor beneath them; keyboard/cancel handlers distinguish nested dialogs. Existing set playback/room authority is unchanged by this UI relocation.

`npm run test:set-configuration-browser` checks toolbar placement, builtin/saved selection, preference changes, export/media dismissal, invalid/valid imports and removal of the room-header selector. Editor canvas fitting, source previews, compact panel layout and TypeScript checks also pass.
