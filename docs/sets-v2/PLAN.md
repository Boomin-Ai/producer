# Sets v2 implementation plan

2026-10-23. Branch refactor/sets-v2, isolated worktree producer-sets-v2. User authorized a breaking refactor and requested audience/data-source inputs, inline source creation, one-selection output and per-set portrait/landscape canvases. HTML-in-canvas is explicitly out of scope and will be a separate build later.

## Architecture decisions

- One ordered, retained scene graph; explicit mixed-content groups, masks and surfaces. No global HTML-foreground special ordering in v2.
- Separate portable definition, room instance, operator draft and immutable on-output revision.
- Every set owns its design canvases. Defaults 1920×1080 landscape and 1080×1920 portrait. Custom dimensions supported. Output dimensions are independent: an explicit viewport transform scales the authored canvas with contain/cover/stretch policy. Do not resize individual design coordinates destructively on output changes.
- Orientation compositions share semantic source roles, data channels, interaction state and animation time. Layout overrides are intentional; portrait is not automatically cropped landscape. One set may support one or both orientations.
- Typed, scoped data snapshots and interaction events enter one runtime boundary. Future webhook/API polling adapters authenticate and normalize upstream; no network connectors or credentials inside set definitions. Audience/public projection excludes private fields and unrevealed results.
- Interaction meaning/rules stay independent from visual skins. Two sets can show the same active poll differently without resetting it.
- Shared source/resource service can create detached sources from the editor. Resource creation does not imply room-scene visibility or audio routing.
- Native frame clock, declarative animation clips/state transitions, bounded retargeting, explicit readiness and presented receipts.
- One presentation controller: select → prepare all requested output targets → take → acknowledge actual presentation. Current output remains visible on failure/stale selection.
- One current package format; offline importer migrates v1 sets. Preserve actual historical layer semantics in conversion; no permanent dual playback engine.

## Milestones and acceptance

1. **Contracts and runtime foundation — initial implementation and tests complete; portable clips/cues/package integration remains**
   Typed data validation, scoped revision ordering, privacy projection, reusable audience poll state, ordered scene compilation, per-canvas viewport transforms, resource lifetime, transactional selection and deterministic animation. Tests must cover differently styled poll sets consuming identical public state; portrait/landscape scaling; stale data/take rejection; private data not reaching render plans.
2. **Native compositor vertical slice — isolated Metal pixel proof built and tested; room adapter pending**
   Implement ordered surfaces/groups in pinned OBS; camera + embedded media + linked gallery + graphics mixed in one masked group. Test real raw output pixels, source reuse, alpha and typography. Native program preview is authoritative; no claim that browser simulation proves composition.
3. **Motion and segment readiness — pending**
   Compiled animation evaluated on native time; interruption/pause/seek rules; selected-layout/gallery prediction; measured Next/Back continuity across media, shaders and multi-camera fixtures.
4. **Editor and source service — pending**
   Add content directly to a region, batch gallery import, per-instance assignments, explicit audio routes, off-air resource preparation, rollback and undo. Sources panel uses same service.
5. **One-selection show — pending**
   Show on selection / open in editor preference. Prepares candidate without returning to room. Missing input opens inline setup while old output remains. Actual presented status, latest-selection-wins cancellation.
6. **Migration and release — pending**
   Convert audited 16-set library, preserve user edits/bindings/assets, native before/after captures and animation checks, portrait/landscape test matrix, repeated switching/resource/performance checks. No production changes before native verification.

## Data-source boundary

Snapshot channels have schemas, authorized producer identity, monotonic generation/revision, freshness and explicit public/operator fields. Duplicate/out-of-order deliveries cannot roll back visuals. Poll aggregates are authoritative state; a client snapshot is not a trusted vote. Audience votes arrive as authenticated interaction commands. Incoming external data can update bindings; host-approved or explicitly declared rule actions control show changes. No eval or executable actions in payloads.

## Baseline and scope honesty

Source baseline de5667c (v0.4.73 release plus release verification docs). Existing set runtime remains active until v2 native cutover. A v2 library/control-plane test is not a shipped compositor. Actual webhook ingress, API poll scheduler, provider auth and hosted audience transport belong to eventual data-source infrastructure and are not claimed by an in-process adapter seam.

## First milestone evidence

2026-10-23: initial contracts, data hub, poll state, rules, graph compiler/pass planner, resource leases, motion sampler and presentation controller implemented. 15 integration checks, browser lab check, project/workbench TypeScript checks and Vite app build pass. See README.md for exact limitations; native renderer and room UX are not yet integrated.

## Native proof progress

2026-10-23: real OBS ordered groups, group opacity/rounded masks, live dissolve/wipe/slide and per-placement geometry/visibility updates implemented. Standalone Apple Silicon/Metal probe reads actual compiled v2 portrait/landscape plans, renders a synthetic moving capture, loads PNG/H.264 through shipped plugins and composites two real CEF graphics surfaces around native video. Captured pixels verify layer order, clipping, typography, scaled canvases, transition endpoints/midpoints, live inputs and reference cleanup. One shared source can move in one placement while staying fixed in another. See [native/README.md](native/README.md), raw captures and source-hashed run evidence.

The graphics serializer emits one bounded, escaped document per ordered graphics batch. No arbitrary HTML authoring or HTML-to-canvas backend was added. Integration suite now has 16 checks.

Native prepared-surface scene ownership is also built and verified: complete-tree structural preflight, requested color-target allocation budgets, detached assembly/rollback, prepared-source reference ownership and actual contain/cover/stretch output transforms. Tests reject duplicate identities, unresolved sources and invalid styles before creating groups; failed new preparations preserve the existing renderable graph. These are trusted native descriptors, not an exposed IPC format. Pixel dimensions alone do not prove browser/media first-paint readiness.

This completes the initial native primitive/owner proof, not the room cutover. Next: strict native IPC/package validation, authorized source/graphics resolution, graphics/media first-paint readiness and actual presented receipts; then native-clock motion/segment preparation and editor/source-service integration. Actual cameras, galleries, shaders, both-output atomic take and performance still need the integrated renderer. No production changes.
