# JSON show engine — review and implementation plan

Prepared 2026-10-04 against the current Producer workspace. **Proposal only:** no
show runtime, database migration, deployment or app restart is performed by these
artifacts. The TypeScript file contains proposed contracts, implementation phases,
review questions and the JSON-compatible first show; its names are not claims of
existing APIs.

Implementation status: see the [P0 rehearsal checkpoint](PRESENTATION-P0-CHECKPOINT.md)
for the executable bounded codec, generated schema, standalone fixture and local
simulation now implemented. This plan still describes remaining live/native work;
the original review fixtures and archive are preserved.

Current product refinements are authoritative in the
[Presentation foundation](PRESENTATION-ENGINE-FOUNDATION.md) and
[Participation/private evaluation/linked rooms plan](PARTICIPATION-AND-ROOM-LINKS-PLAN.md).
The original TypeScript set/program manifest examples and original JSON fixture
still await conversion to set plus optional show composition; they are not a
frozen import schema. The [extended typed contracts](PARTICIPATION-CONTRACTS.ts)
are re-exported by the code plan and describe proposed, gated capabilities.

**Rehearsal is required from P0:** the same package/runtime/reducer runs against
isolated mock participants, inputs, feeds and clock. It has separate state and
adapters, visibly marked controls and no effects on the active room or broadcast.
Starting live creates a fresh authorized run; simulated inputs/results never
carry over. See the foundation's Rehearsal section for acceptance criteria.

- [Typed plan and contracts](SHOW-ENGINE-PLAN.ts)
- [Participant controls, private answers, phone sign-in and linked rooms](PARTICIPATION-AND-ROOM-LINKS-PLAN.md)
- [First show JSON](head-to-head.show.json)
- [Original saved concept](../SHOW-FORMATS-CONCEPT.md)
- [Nordcraft source review](../NORDCRAFT-SHOW-ENGINE-REVIEW.md)
- [Vertical Canvas package/source findings](VERTICAL-CANVAS-REVIEW.md)

## Decision and confidence

Build a reusable, interpreted JSON engine on top of the existing room, sources,
controller, audience interactions, local compositor and recorder. Agents author
components, styles, bindings, animations and segment rules. The runtime is built
once with Producer; importing a normal show needs no per-show npm/Vite build.

The user selected two contestants, audience voting, reaction heat and winner
reveal; selected audited Nordcraft modules behind Producer's schema; and custom
Producer workspace/output UI while retaining native iOS audience controls.

The architecture fits the existing system. Integration certainty still requires
three proofs: imported UI isolation in Tauri/OBS CEF, synchronization between
native source placement and browser graphics, and crash-safe controller/native/
recording recovery. P0 proves the renderer boundary before the larger build.
Portrait and simultaneous outputs have separate native engine gates. The current
engine derives width as height × 16/9 and records/captures one global canvas.

## Product contract

A **Room** is a persistent venue. A **Set** is a versioned presentation package
with optional **Show** orchestration. An **Episode** is one show run; a standalone
set needs no fabricated episode segments or competition. **Output** is the feed
viewers and destinations see.
Do not overload Boomin partner programs, external-stream run IDs, or OBS scenes
with the meaning of an episode.

The room top bar opens Set for import/selection, preview, configuration and apply.
The existing output renders it; one dynamic **Set controls panel** lives in any of
the four existing docks, with primary actions available in core chrome. Starting
optional show orchestration changes the relevant controls, not the whole room UI.
Source assignment uses existing Sources/inspector. Producer-owned Stop, recording
status and recovery stay outside imported UI. Stopping show orchestration leaves
the set loaded and finalizes only its owned recording. Manual recording, room
connections and external streams retain independent lifecycles.

The output view is distinct from host and moderator control views. Never use the
existing whole-window Studio capture as the show output: that could broadcast
controls. Agents may design expressive HTML/SVG/CSS compositions, reusable
components, responsive control desks and animations. Unsupported native video
masks, depth interleaving or source animations must fail preflight explicitly.

A show is not a set of scene buttons. Optional modules own progression, rules,
clocks, competition state and interaction lifecycle. Segments, when present,
select layouts/scenes. Scene
changes remain normal acknowledged source operations, shared with the moderator
workflow, rather than a second competing scene controller.

## Guests are participants, not just video inputs

A guest retains audience powers backstage and onstage: chat, votes, reactions and
declared show interactions, subject to normal moderation restrictions. Camera,
microphone, screen, stage placement and moderator controls are separate grants.
An eliminated contestant moves backstage by default; they stay connected and may
watch/interact. Removal/disconnection is an explicit separate operation.

The guest page needs interaction controls beside the return video, not a media-only
screen. Native iOS keeps native controls and gains a semantic widget adapter for
declared supported player controls. If a stage invitation opens
the existing guest media page, that page receives the same verified interaction
identity and controls; returning to native audience must not reset it. Building
an arbitrary HTML show UI or a fully native guest media interface inside iOS is
outside this first prototype.

| State | Audience interactions | Publish media | Control the show |
| --- | --- | --- | --- |
| Audience | Allowed by room policy | No | No |
| Guest backstage | Retained | Only granted capture/transport; excluded from public stage mix | No |
| Guest onstage | Retained | Only granted media; public placement/mix confirmed by authority | No |
| Moderator | Retained when permitted | Explicit media grants, through ordinary sources | Delegated controls only |
| Host | Permitted participation | Existing host source permissions | Full owner controls |

Existing guests already have an `input.vote` route. Current anonymous audience and
guest identities differ; promotion must not create a second vote identity. Use an
authenticated, single-use backend handoff associating the audience principal with
the guest participant. Keep principal, vote-once key, cooldowns and restrictions
stable on promotion/demotion/reload. Do not accept a client-claimed identity or
infer ownership from a public guest URL. Count one participant once, even if they
have both an audience control connection and a guest media leg. Anonymous identity
is per device; this does not prevent one person using unrelated devices.

Default test policy: contestants may vote once, including for themselves. A future
show may expressly disallow contestant voting; enforcement is server-side.

Participant controls are declared separately from show graphics. The first fixture
declares a two-choice vote usable by audience and guests. Define the versioned
widget/action registry now for choices, answers and action buttons, with private
evaluation, explicit reveal, validated payloads and grants. Implement types only
after negotiated backend/client support; no arbitrary-script endpoint is proposed.
Targeted support/oppose votes use frozen choice-to-contestant mapping.
Phone contestants use the existing Boomin email/code sign-in and retain their
identity through guest/native handoff. Guest social OAuth/data is outside the
first build. A player may produce/stream their own room while remaining a guest.
The detailed extension plan specifies independent media buses, relay grants and origin-run
authority rather than assuming these complete workflows already work.

## First show: Head to Head

Use the existing compatible landscape canvas, two assigned ready native sources
and one local recording. Slots can bind to host or guest cameras; they are stable
source/participant IDs, not positions in an array. Starting never enables a guest's
camera or microphone without their existing consent/grants.

1. **Intro:** both contestants visible; host verifies source/audio readiness.
2. **Round:** host starts a 60-second authoritative countdown and an episode-scoped
   two-choice vote. Audience and guests vote/react; accepted reaction counts in a
   rolling 10-second window drive a heat border animation.
3. **Reveal:** controller freezes input at the round deadline, records the result
   and applies winner layout. A unique highest tally wins. A tie or zero votes
   pauses progression for a logged host decision; no random/silent winner.
4. **Outro:** winner view continues; host stops the episode to return to the room.

No reveal/stage-elimination effect applies until the winner is resolved. Commands
outside the valid lifecycle fail, even if an imported button sends them. UI hides
or disables them using the same derived allowed-actions projection. The loser is
removed from public layout/audio after native confirmation, not disconnected.

Heat is bounded, server-validated accepted activity, not arbitrary client-reported
numbers. Cosmetic pulse animation runs locally; the controller does not send
frames. Reconnect reconstructs current state and seeks reveal animations relative
to segment entry, rather than replaying the win as a new event.

The first fixture uses an intro/round/reveal/outro sequence, styled source frames,
countdown and heat/reveal animations. More elaborate scoring, eight-player rounds,
AI fact assistance, sponsorship scheduling and guest rebroadcasting follow after
this foundation. The renderer's design model is general; the test's rules are
intentionally small registered rules, not unrestricted agent-authored code.

## Schema, source composition and isolation

`producer.show/1` describes assets, components, role surfaces, format-specific
layouts, logical source slots, segments, timing and registered rules. Validation
includes JSON Schema plus cross-reference/type/capability checks. Generate agent
schema/docs from the same contract; do not maintain unrelated handwritten schema
and TypeScript definitions indefinitely.

The reference fixture is JSON plus assets; import copies validated assets to
managed local package storage. A compressed package/container can follow. Pin the
manifest/asset hashes and renderer version for each episode. Editing produces a
new version and preview; it never silently replaces an on-air definition.

Adapt selected pinned Nordcraft formula/CSS/reactivity code only after auditing
its dependency closure. Preserve applicable Apache-2.0 notices and modifications.
No dependency has been added yet. The source review proved JSON formulas and
keyframe generation, not a complete safe embedded runtime. Keep upstream globals,
custom JS handlers and `new Function` paths outside the Producer contract.

Separate control rendering from authenticated Tauri UI, and output rendering from
controls. A narrow trusted adapter owns commands. Imported nodes do not get
Tauri IPC, tokens, filesystem access, raw HTML, scripts or arbitrary network calls.
Validate node/attribute/CSS/URL/expression types, bounded recursion/repetition and
asset size/hash/MIME. Reject cyclic components and prototype-pollution paths.
Use CSP and scoped local resource capabilities; actual sandbox behavior in Tauri
and OBS CEF is a P0 acceptance test, not an assumption based on JSON syntax.

For MVP, native cameras/guests compose between a background browser source and a
transparent foreground browser source. The two layers share episode state and
clock. Source rectangles use normalized canvas coordinates; a trusted layout
resolver evaluates declared visibility then converts to native coordinates.
Desktop CSS/window coordinates and preview cutouts are not broadcast geometry.
Runtime context exposes `episode`, read-only `derived` values (remaining clock,
heat, winner name, pending decision), and `capabilities.actions`. The trusted
adapter computes them; imported documents cannot set them. Missing optional data
gets a declared fallback. Buttons bind disabled/visibility to this projection;
authority enforces the same rules.
An OBS browser `requestAnimationFrame` acknowledgement alone is not proof its
pixels are on the recorded frame; measure actual composite transition skew.

Native source movements are fixed per segment initially. CSS animations animate
graphics; they do not automatically animate video slots. Arbitrary video masks,
animated transforms, and DOM/native z interleaving need a later proven compositor
adapter. Reject their use rather than quietly crop or misplace video. Keep
capture connections shared; don't open a new camera/guest peer for each graphic.

## Authority and distributed effects

Extend the existing room control channel/controller. The show coordinator uses
the same room source/stage authority; fields copied into episode snapshots are
projections, not a rival participant or scene database. Hosted and self-hosted
controllers share protocol/reducer semantics and pass the same contract tests.

Each mutation has a command ID, expected episode revision, authenticated principal,
server-assigned epoch/sequence/deadline and explicit permission. Controller persists
intent and effect outbox before sending. Native host applies an engine-thread
transaction guarded by current lease/generation/source revisions, then returns
actual source state. Only a valid current receipt commits the target segment.
Scores/pure logical state can commit within the controller; media-dependent stage
changes must expose pending versus applied state.

There is no distributed atomic transaction across controller storage, interaction
service, OBS graph and browser paint. Treat opening/closing/revealing a vote,
recording ownership and native layout as idempotent effects with durable receipts.
Use deterministic interaction/effect IDs or an equivalent stable idempotency key.
Reconcile interrupted operations; never assume an accepted command has executed.
If the existing scene/action queues supersede a show transaction independently,
refactor their arbitration before shipping. One room execution queue owns ordering.

Existing `apply_scene` validates all sources and uses OBS scene atomic update for
video geometry. It needs epoch/generation/deadline checks at the native execution
boundary and verified failures. Video scene locking does not make audio atomic.
Stage elimination needs a fail-closed public-audio gate and confirmation; it must
not reset microphone consent or block backstage interaction rights.

Clock state consists of accumulated elapsed time plus server anchor/running flag.
Client UI interpolates monotonically and resyncs server offset. Controller alarms
own deadlines and automatic progression. Pausing freezes round/vote eligibility
and resumes the same interaction; pause does not reveal/clear tally. Define and
handle input/close ordering at the controller's authority time boundary. No
wall-clock sponsored segment policy in MVP.

On host lease loss, freeze progression/inputs and mark recovering; local recording
may continue. Reconnection validates pinned package, publisher epoch, actual
sources, overlay readiness and recorder ownership before an explicit resume.
Stale moderator actions, duplicate receipts or a new publisher must not replay
old eliminations/reveals. A denied command produces a clear actionable UI error.

Stop remains usable when the imported surface hangs. If authority is unreachable,
the current host can perform an emergency local stop of show-owned output/recording;
persist that receipt locally and reconcile the episode as interrupted when
connected. Do not claim a remote clean end occurred or stop unrelated external
outputs. The trusted Producer chrome owns this recovery, not imported actions.

## Persistence and recording

Propose additive storage for immutable show versions, room attachment, episode
snapshot/action log/outbox, interaction `episode_id`, and recording association.
Do not repurpose the existing external-stream `run_id`: a show can run without
external streaming, and one external stream can contain multiple episodes. Save
decisions/checkpoints and bounded aggregates, not every animation frame.

Auto-record locally by default, with an explicit visible unrecorded override.
Preflight disk, encoder, compatible canvas, bindings and runtime readiness. Prepare
recording before marking the episode running. On recording failure, offer retry
or an explicit logged unrecorded start. Don't present a failed recorder as running.

If manual recording already exists, reuse it without taking ownership and save
episode start/end offsets; the file may include time outside the episode. Stop show
does not stop that recorder. For owned recording, stop/finalize and verify the file
and catalogue state. Native timeout, crash or incomplete file yields interrupted/
failed status, not a successful file claim. Record metadata may sync using existing
infrastructure; no automatic media upload is part of this design.

Snapshot baseline room composition and record show ownership. Restore only
show-owned geometry/sources with revision checks; retain host manual overrides.
Starting/stopping a show must preserve running streams, guest sessions, monitoring
and processed mix-minus conversational return.

## Implementation order and native format gates

The code plan lists exact proposed modules and current integration seams for P0–P5.

| Phase | Deliverable | Release gate |
| --- | --- | --- |
| P0 | Schema, fixture, isolated JSON rendering in actual OBS | Alpha/layering, security and render performance proved on Mac/Windows |
| P0b | Early independent vertical-canvas spike | Shared sources, distinct recordings, clean stop, no doubled audio or main-canvas reset |
| P1 | Episode/controller/identity contracts and persistence | Idempotency, permissions, timer, outbox and guest principal continuity |
| P2 | Native source/recording adapter | Actual source/output state matches receipts; audio and recording failure paths |
| P3 | Dynamic Set controls panel, guest/native widgets and phone contestant sign-in | Account-only email/code play and identity handoff; trusted Stop/recovery; no social OAuth |
| P4 | After Hours then Head to Head rehearsal | Signed-in phone contestants, host/mod/browser, recording and ordinary room regressions |
| P4b | Additional private-answer/target fixtures and linked-room proof | No result leaks; own-room stream/appearance isolation; no media feedback |
| P5 | Portrait first, then concurrent outputs | Independent canvases/output IDs and routing proven with real encoders |

First shipment supports one landscape output. Portrait needs explicit dimensions
through config, compositor, geometry, preview, program capture, recordings and
destination routing. Both needs independent native output/composition graphs and
encoders sharing captures. Multiple current RTMP destinations are not proof of
multiple aspect canvases. Never reset the global canvas while another live output
uses it. Expose capability-based preflight; unsupported formats remain disabled.

No additional Cloudflare product is required for these steps. Interactive capacity
and direct-video capacity remain separate. The supplied Aitum package gives a
concrete native direction: private canvas, canvas-specific dimensions/video and
encoder routing, with shared source references. Producer's OBS 32.1.2 headers and
Mac dev engine export the required canvas APIs. P0b tests a Qt-free adapter early;
P5 integrates the full output pipeline. Do not load the Qt/OBS-frontend plugin into
Producer; see the linked source review for evidence and remaining questions.

A show does not turn today's four/eight
hardware-fed video slots into guaranteed 100-viewer video delivery, nor make TURN
or host upload free. Retain existing audience capacities and explicit hardware
limits; do not introduce a required server-rental prompt for the MVP. Self-hosted
users keep their existing endpoints/domain behavior.

## Validation and review handoff

Automate reducer/protocol tests for duplicate commands, revision/epoch mismatch,
lease expiry, ties/zero votes, pause/resume and invalid transitions; identity tests
for stage promotions and retained restrictions; semantic/package isolation tests;
and geometry/recording ownership tests. Use shared contract vectors against both
backend implementations. Don't merely snapshot implementation output.

On Mac and Windows, run an actual OBS test recording with native source test
patterns and inspect composition regions/crop/alpha and graphics-versus-source
transition skew. Verify guest return/video/audio, public mute on elimination and
no echo regression, not just DOM preview screenshots. Baseline the same canvas/
source load without a show and compare sustained frame rate, dropped frames,
CPU/GPU and memory with the show enabled. Measure/tune node/animation budgets;
revised performance targets must be reviewed before enabling the feature.

Rehearse host, delegated mod, web audience, native iOS audience and guest web:
interact before/on/after stage; try vote twice after promotion; stop with manual
recording/external stream active; disconnect host; expire a command; fail recording
start/finalization; ensure recovery and Producer-owned Stop work. Existing branded
`producer.dev`/`boomin.ai` links must still enter the same room.

Before release, agree numerical frame/transition budgets from the P0 hardware
baseline and require the fixture to pass them. Complete the outstanding moderator
source rehearsal independently; do not merge unrehearsed moderator behavior just
to ship Show. Keep this behind a proposed `show_engine_v1` flag until gates pass.

Reviewer: assess the typed contracts, fixture and questions in the code plan.
Identify blockers in renderer isolation, native timing/audio gating, command queue
arbitration, identity handoff and output graph feasibility first. Requested output:
approve architecture with conditions or list concrete contract changes, then give
P0 implementation scope. Review does not imply the runtime is already built.
