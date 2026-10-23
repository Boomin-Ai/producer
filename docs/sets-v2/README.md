# Sets v2 implementation

Worktree: `/Users/klevelandbishop/Documents/producer-sets-v2`
Branch: `refactor/sets-v2`
Baseline: `de5667c` (verified v0.4.73 source + release docs).

Read [PLAN.md](PLAN.md) for the complete refactor sequence. HTML-in-canvas is deliberately excluded.

## Implemented in this milestone

- `scene.ts`: strict `producer.set/2` initial graph contract, mixed ordered groups, masks, source roles, public data bindings, independent set instances and per-set design canvases. Default design sizes are 1920×1080 and 1080×1920; custom dimensions are supported. Output viewport scales the design without rewriting node geometry.
- `planner.ts`: ordered graphics/native operation sequence. Graphics batches never jump across native sources. Mixed masked groups and group opacity request offscreen passes. Design-resolution memory estimation is not actual native allocation enforcement.
- `graphics.ts`: bounded graphics-batch documents with escaped text, validated paints/styles, no scripts or external resources. Native owner places each resulting browser texture in its original group order. Unsupported placement transforms fail explicitly instead of being clipped silently.
- `data.ts`: transport-neutral, room/producer-scoped data snapshots, schema validation, monotonic revision/generation, payload budgets, freshness, public/operator field projection. Provider generation resets are host-controlled.
- `interactions.ts`: one reusable poll session independent of visual skins; private voter identities/ballots, explicit close/reveal/reset, sequence/round handling, bounded voter capacity. Results are absent from renderable data until reveal.
- `rules.ts`: public-data rising-edge conditions with explicit automatic/host-approved cue proposals. Actions are creator-authored, not payload instructions. Host decisions are single-use and tied to current source revision. Actual cue dispatch is intentionally delegated to the eventual authorized show controller.
- `motion.ts`: caller-supplied presentation clock, bounded deterministic keyframe tracks, pause/seek and sampled interruption retargeting. Not yet connected to a native v2 animator.
- `resources.ts`: shared asynchronous acquisitions and reference-counted ownership, never implicit stage visibility. Native source creation is an adapter to implement next.
- `presentation.ts`: latest-selection-wins off-air preparation; all output targets compile before staging; serialized guarded take; actual-presented receipt contract. Last confirmed program ownership is held across failed preparations. Failed post-swap confirmation retains uncertain resource ownership and exposes an error instead of freeing potentially on-air content.
- `fixtures.ts`: two different poll skins, each with independently composed landscape and portrait canvases, bound to the same interaction data contract.
- `labs/sets-v2`: interactive diagnostic workbench. Poll, change styles side by side, switch orientation/output size and inspect public data. It renders the plan in DOM with simulated sources; it does not touch the room or implement HTML-to-canvas.

## Run

```sh
npm run test:sets-v2
npm run test:sets-v2-native # macOS; installed Producer runtime required
npm run dev:sets-v2
```

Workbench: http://127.0.0.1:1436/labs/sets-v2/

Browser check uses an installed Chrome and playwright-core. Override `PRODUCER_PLAYWRIGHT_MODULE` with its module path if required:

```sh
PRODUCER_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/test-sets-v2-browser.mjs
```

## Verification

- 16 integration checks pass: poll privacy/reset/deduplication, scoped snapshots, two skins, portrait/landscape/custom canvas scaling, ordered mixed groups, stale data, rule approvals, animation, resource ownership, failed/stale takes, dual-target compilation, serialized presentation receipts and graphics-document validation/escaping.
- Chrome workbench check passes: votes remain hidden until reveal, same poll survives orientation/output changes, no participant identities in public data, both skins respond, no page errors.
- Project TypeScript check passes. Workbench standalone TypeScript check passes.
- Existing Vite app production build passes, with its existing large-chunk advisory. The lab is a development entry, not wired into the production room UI.
- Real native Metal pixel proof: compiled portrait/landscape plans, ordered masked groups, opacity, synthetic live capture, actual PNG/decoded H.264, actual CEF text around native video, dissolve/wipe/slide and per-placement geometry/visibility. The native scene owner assembles prepared surfaces, applies design-to-output contain/cover/stretch and checks the whole graph's requested color-target budget before creating groups. Invalid/failed preparations leave an existing composition renderable. See [native evidence](native/README.md). Native code is compiled by the isolated probe and is not yet registered in the app.

## Not yet implemented

The completed pieces are the control-plane/compiler foundation, native primitive proof and native prepared-surface scene owner. The full refactor is still underway. Browser surface pooling, native IPC/package validation, first-paint readiness, room-editor source creation, persistent instance store, direct-show room picker, set migration and a production release remain. Hosted poll transport, incoming webhooks and API polling remain future data-source infrastructure. Animation clips/cue state/rule definitions are separate runtime contracts, not yet the complete portable authoring package. Native all-target atomic take and frame receipts are still an adapter contract tested with mocks. Windows/Linux native behavior and integrated frame performance are unverified.

## Next milestone

Connect the native scene owner to authorized source/graphics resolution, strict IPC validation and first-paint readiness. Establish native presentation receipts before connecting the room picker. Connect the motion clock and prepare incoming segments while retaining outgoing live media. Then integrate source recipes/editor/instance persistence and migrate the full audited library.
