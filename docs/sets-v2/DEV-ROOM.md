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

### Producer set picker and show-mode audit (2026-10-24)

The editor toolbar now uses a Producer-styled searchable picker instead of the macOS select menu. Built-in, saved and current sets are grouped; selected entries have a checkmark. Arrow keys and Enter select, Escape closes the picker while preserving the editor. Import, export and configuration remain in the toolbar. Updated the normal-room smoke driver for this picker.

Validation: TypeScript and configuration browser checks pass (saved/built-in selection, search and Enter, Escape, nested dialogs, import and preferences). Frontend changes are available through dev HMR; no production deployment.

The current show runner only supports prepare and rehearsal. Start enters rehearsal. Rendering still targets actual room output, so rehearsal is not an off-air guarantee. Audience/feed test controls are simulated; leaving rehearsal restores prepared configuration. Live broadcasting remains a separate room action. A production show mode needs explicit live input routing and durable runtime state, with rehearsal isolated to preview; changing the label alone would not supply this behavior.

### Set picker thumbnails

Each visible picker row now shows a miniature opening layout, resolved through the existing package parser and output projection. The miniature preserves canvas proportions, authored text/styles, embedded images and slot placement. It has no camera leases, video playback or animation timers. Shader nodes use a static gradient from their authored colors; video and locally referenced media do not have poster extraction yet. This is a lightweight design preview rather than a native compositor capture. Rows load on visibility and release their projection on leaving view; closing the picker unmounts thumbnails. Loading failures retain a placeholder and do not block selection.

Validation: TypeScript passes; configuration browser test confirms all four visible fixture thumbnails finish rendering, alongside selection/search/keyboard/import checks. Visually inspected the rendered picker screenshot.

### Private editor rehearsal and room show runner (2026-10-24)

The set panel now owns a room session and a separate prepared editor draft. Content, segment/layout selection, source assignments and framing in the editor affect its preview until the operator chooses Show on output. The explicit handoff exports prepared configuration, commits source bindings/framing, selects the previewed segment/layout on the room session and applies room output. Configured drafts survive closing/reopening the editor during the mounted room; they are not a new disk-backed draft store. Taking output retains the existing native compositor/transition path. A failed native preparation still uses the existing output error/retry behavior.

Rehearse/Exit rehearsal and simulated audience controls live inside the editor. Rehearsal owns its own session and clock, requires no room output, and cannot be taken while active. Exiting or closing rehearsal restores prepared content and clears practice results. Source assignments remain part of the editor draft. Inline source creation can create a hidden room source without binding it into the room's active set. The existing automatic-selection checkbox is hidden in this private editor because set selection here is explicitly a preview operation.

The room Start show/play/pause/next/back/stop/restart controls now operate a live workspace session rather than entering rehearsal. Both sessions use the same segment reducer and independent monotonic clocks. Room segment selection continues playback; editor segment selection pauses practice for editing. Live workspace rejects simulation vote/reaction/feed injection, and the room UI omits simulated participant controls. Real audience/data adapter wiring remains pending; this change does not claim those transports are connected.

Validation: TypeScript passes; presentation runtime 21 checks, sets-v2 integration 16 checks, browser isolation, configuration, editor navigation/canvas fitting, and panel layout checks pass. The isolation browser check exercises rehearsal with output initially inactive, verifies room state and binding callbacks stay untouched, verifies practice reset/draft retention, explicit handoff and independent room playback. Visually inspected the private rehearsal UI. Normal-room native smoke driver updated for explicit Show on output and Close editor; not rerun as part of this frontend change. No native binary or production release built.

### Measured Next latency and authored transitions (2026-10-24)

Measured 18 real room Next clicks against the native renderer, using the isolated dev app, a hidden color source assigned to slots, and three saved sets. Each set ran its first three advances twice. The probe waits for output to settle before clicking, matches the completion receipt to the destination phase, and requires a compile-start event for each measured segment. Evidence: [segment-timing-proof.json](native/segment-timing-proof.json). These are native render-status receipts sampled through IPC, not physical monitor scan-out or encoder/stream latency.

| Set | Click to native completion (median; range) | Authored effect |
| --- | --- | --- |
| Head to Head — The Arena | 847 ms; 821–1014 ms | 650 ms morph tracks; no compositor dissolve. Receipt confirms new frame, not completion of those tracks. |
| Producer — Make Your Show | 758 ms; 733–869 ms | 320 ms crossfade; first transition observed 373–526 ms after click. |
| Claude Code — Build, Review, Ship | 445 ms; 385–605 ms | No transition; straight cut after readiness. |

Layout compilation took 3–9 ms in these samples. Head to Head native prepare submission took 194–383 ms and readiness/warm waiting another 392–499 ms. The adapter did not have the destination scene resident before Next. Repeating the same sequence still rebuilt/prepared scenes. This supports the existing retained-resource/refactor work remaining on the plan; loading a package/asset manifest does not mean all segment graphs and graphics pages are ready to take.

Removed the unconditional room 300 ms dissolve and portrait 250 ms dissolve. Both native output adapters now add a crossfade only when the destination set layout explicitly authors one, with its authored duration. Cut/missing transition adds zero; morph stays on its authored motion tracks. Content updates within the same canvas do not restart a dissolve. Portrait takes receive the selected portrait layout identity for this decision.

Added development-only stage timing events and an optional `roomSmoke(true)` measurement path. `roomTiming=1` selects it when the native UI probe is enabled. Standard smoke now opens the collapsed dock and waits for the selected set to finish loading; dev room selection prefers configured duplicates, and smoke layout changes are confined to its separate room. Restored the normal dev room after measuring.

Validation: TypeScript and 22 presentation runtime checks pass, including explicit transition-duration cases. The timed native pass passed all 18 phase-matched samples. Scene preloading/retention has been identified and measured, not implemented in this change.

### Set operation versus show sequencing (2026-10-24)

A standalone set now has Layouts, Controls and Sources cards in the room. Every authored layout is directly selectable; editable content and host media controls follow the selected layout. Start show, segment lists, segment controls, show transport and show rehearsal are absent when no show is attached. The editor calls this Set details and Layout navigation; media entry settings say layout entry. Standalone layout animation clocks run without inventing a running show.

Standalone Controls also hosts `SetRoomVoting`, a view of Producer's existing room vote service. It uses the same vote snapshot/history, permissions, open/reveal/close callbacks and existing overlay delivery as the dockable Vote panel. It does not create an independent vote store or start a show. The question editor has local UI state, remains open on failed creation, and awaits a successful room-service response. No live voting controls are inserted into private set editing/rehearsal. This does not add a custom vote graphic inside authored set layouts or connect the pending generalized data-channel renderer; those remain separate work. Existing backend/overlay behavior is unchanged.

Shows remain optional sequences of segments referencing layouts. `show.choices` is now optional on authored input and normalizes to an empty array. A sequence without voting no longer needs dummy contestants/options. Voting phases still require at least two valid choices; invalid voting actions remain rejected. The agent authoring brief describes the distinction.

Validation: TypeScript, presentation runtime (24 checks), sets-v2 integration (16 checks), and browser standalone set/vote callback, show panel layout, rehearsal isolation and configuration flows pass. Standalone browser coverage includes manual layout/content edits without a running show, room vote open/reveal/close callback delivery, set-only editor labels/absence of show controls, responsive cards and transition to an attached show. Browser voting uses an injected service stub; no audience votes were sent to a real backend during verification. Visually inspected the standalone panel. Changes are frontend/runtime updates available in dev; no native rebuild or production release. The prepared-scene bank and native per-layout loading indicators from the audit are not implemented in this change.

### Prominent editor output action (2026-10-24)

Moved Rehearse/Exit rehearsal and Show on output into the editor configuration toolbar. Show on output uses Producer's primary mint styling. Added explicit Changed/Applying/On output/Error feedback; the unapplied state considers design, content, feeds, selected phase/layout, source assignments and framing. Successful apply disables the unchanged action; editing again makes it available. Rehearsal stays private and disables apply. Large package design comparison is memoized separately from frequently changing runtime values.

Import/export/media moved into a Files popover to keep the header on one line. Export returns focus to its visible Files trigger. Compact editor widths retain both actions and reduce status text to a colored indicator with its full title/accessible text. Show transport remains below the toolbar during private practice.

Validation: TypeScript and browser configuration, private rehearsal/apply isolation, and editor navigation/canvas fitting checks pass. The isolation test verifies both actions are inside the top toolbar, initial unapplied feedback, and confirmed on-output feedback/disabled unchanged action. Visually inspected the toolbar screenshot. No native changes or production deployment.
