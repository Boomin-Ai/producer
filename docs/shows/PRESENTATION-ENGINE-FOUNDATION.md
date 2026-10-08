# Presentation engine: sets, optional shows and data inputs

Product refinement, 2026-10-04. This supersedes the draft's separate set/program
manifest modes as the product architecture. It is a design handoff, not an engine
implementation. The current typed plan still needs conversion to composition;
its reviewed fencing/isolation/identity/recording conditions remain mandatory.

Implementation update: the [first development rehearsal checkpoint](PRESENTATION-P0-CHECKPOINT.md)
now has an executable bounded composition codec, standalone set, optional show
simulation and Set controls panel. Native/live acceptance gates remain open;
the following sections continue to describe the complete target architecture.
The same checkpoint now includes an isolated native CEF/Metal visual proof and
[shared source appearance primitives](SOURCE-APPEARANCE.md) for the source editor
and authored media slots. Independent video-only placement styling is proved on
a shared native input. Production adapters and placement lifecycle integration
remain gated by the reviewed execution and ownership contracts.

## Names and compositional model

Call the reusable foundation the **presentation engine** internally. A **set** is
an authored presentation: graphics, layout variants, native media slots, reusable
components, data bindings, motion and presentation controls. A **show** is optional
orchestration using a set: timelines, segments, participation/scoring rules and
show controls. A set runs indefinitely without a show, fake segments, contestants
or interactions. One renderer and one room authority serve both.

Use a composition contract rather than mutually exclusive product categories:

```ts
interface PresentationPackage {
  schema: 'producer.presentation/1';
  set: SetDefinition;
  show?: ShowDefinition;
}
interface ShowDefinition {
  id: string;
  version: string;
  setVersion: string; // Pin exact set assets/layout/binding contract for this run.
  // Optional typed modules: timeline, rules, competition, show-specific controls.
}
```

These are illustrative boundaries; freeze exact definitions with the same
schema-generating source in P0. Split visuals from orchestration in Head to Head;
After Hours remains a standalone set. Retain backward compatibility only through
an explicit tested adapter if an older draft ever needs import; never silently
reinterpret packages. Shared run lifecycle owns start/stop, assets/runtime pin,
recording ownership, leases and recovery. Optional modules add their own state.
Do not fill absent modules with fabricated winners/votes/segments.

## Smallest reusable primitives

1. **Source:** a typed input with stable identity. Media handles and data values
   use distinct adapters/lifecycles; a data URL is not a browser/media source.
2. **State:** typed values with scope, ownership, revision and freshness. Separate
   room source truth, shared run/module state, integration feeds and local UI state.
3. **Binding:** bounded pure expression deriving a displayed value/style/visibility
   from authorized projected state; no network, credentials or mutation in render.
4. **Node:** a visual element/component/native source slot with layout/style/order.
5. **Event:** a typed observation with identity/order and declared scope. Events
   can update data; they are not automatically privileged commands.
6. **Action:** a registered mutation with explicit authorization and payload.
   Layout, stage, audio admission and recording actions keep distinct semantics.
7. **Clock:** local cosmetic time or authoritative active run time. Timeline and
   reveal anchors belong only to modules that explicitly provide them.

Native source placement, audio gates, renderer layers and effects retain their
reviewed receipt/fencing boundaries. Hiding a slot by binding/choosing a layout
never implicitly demotes a guest, changes consent/operator mute or closes audio.

## Integrations panel is a core data capability

Extend Settings → Integrations with a distinct **Data sources** group; the room's
existing inspector can show bindings and current health without leaving the run.
Keep existing live/posting channels recognizable. A connector record contains
its owner/scope, configuration version, schema/mapping and credential reference.
Set packages declare logical input contracts; trusted host setup binds them to
configured connector records. Importing JSON does not authorize network calls or
embed API keys. Agents can propose/apply configuration through the same validated
API as the UI; exports omit credentials.

First connector types:

- **Incoming webhook:** copy a scoped receiver URL; configure bearer/HMAC/provider
  verification, replay/deduplication policy and a typed JSON payload mapping.
- **API pull:** URL, GET/auth configuration, poll interval, test response, field
  mappings, timeouts/backoff/rate budget and stale-data behavior.
- **Mock/manual input:** deterministic values/events for offline design and tests.

The panel needs Test, sanitized sample data, field mapping, binding targets,
last-success/received time, stale/error status and pause/disconnect. Version
configuration separately from feed values. Display only mapped fields; arbitrary
provider payloads may contain private fields and must not reach public renderers.

## Data path and reactions

```text
webhook receiver / trusted API executor / manual input
  -> authenticate and validate
  -> normalize, deduplicate and order
  -> versioned feed snapshot or typed event
  -> authorized projection
  -> pure bindings -> local visual updates
  -> optional registered rule -> authorized room action -> acknowledged effect
```

Example: a payload `{ "price": 84.5, "change": 3.2 }` maps to `market.price` and
`market.change`. A price label binds to `market.price`; a color binds to the sign
of `market.change`. This works on a set without any show. An optional declared
rule can switch layouts on a threshold crossing or drive a highlight animation.
Evaluation must not retrigger an irreversible action on every frame/poll/reconnect:
use event/configuration/rule IDs, edge semantics, cooldowns and effect receipts.
Providers do not get permission to admit/mute/kick guests merely by sending data.

Treat snapshots and events differently. Snapshot feeds can coalesce updates to
latest state; meaningful events need bounded durable receipts/outcomes. API polls
that return an unchanged value do not invent a new threshold crossing. Define
ordering per connector (provider sequence when reliable, otherwise acceptance
sequence); duplicates/old revisions cannot overwrite fresh state. Include
received time, version, expiry and live/stale/error status. Display fallback/last
known data explicitly when stale. Scope feeds to room or run deliberately and
never carry a previous episode's effects into a new run.

## Placement and hardware-first constraint

API polling defaults to a trusted native host executor, with credentials held
outside imported renderers. Hosted polling can be a later explicit connector
option. Local/private-network targets require owner-configured scope and a
separate executor policy; arbitrary backend URLs/redirects cannot become an SSRF
route. Bound response sizes, timeouts and fetch concurrency.

An internet webhook needs a reachable receiver: extend the existing backend's
HTTP/control infrastructure, or the user's self-hosted backend. Producer's laptop
uses its existing outgoing connection; no inbound laptop port or tunnel is
required by default. Persist a bounded accepted update/dedupe receipt before
acknowledgement, then deliver normalized state through the existing room path.
Receiver responses report accepted/queued state, never pretend pixels have already
appeared. Rendering/encoding stays on host hardware. This requires no additional
Cloudflare product; it still consumes existing application infrastructure.

The inspected hosted routes are provider-specific ingestion in
`.codex-work/api-domains/src/routes/webhooks.ts` and outgoing endpoint/delivery
services in `routes/platform-v1/webhooks.ts` and `services/webhooks/deliveries.ts`.
Those are reuse seams, not evidence of an implemented generic inbound set-data
API. Reuse credential/tenant/signature/idempotency conventions where appropriate;
do not require a complete Flows migration or duplicate its workflow runtime.

## Revised first proofs

P0 proves a standalone set with two mocked typed feeds, components/assets and
reactive data/style updates, plus renderer/security/Stop gates. P0b remains the
independent canvas/native output experiment. Before live integration, add one
real authenticated webhook and one local GET polling connector: verify mapping,
secret isolation, duplicate/order/freshness behavior, host disconnect/reconnect,
and permission-checked threshold reactions. No competition is necessary for this
proof. Head to Head adds optional show modules after existing review blockers pass.

Acceptance: data updates appear without rebuilding the set; unsupported values
fail with mapped-field diagnostics; duplicate input cannot double-trigger actions;
old data cannot replace fresh data; stale feeds use declared fallback; raw secrets
and private payload fields never enter output; actions use normal authority/fences;
and layout reactions preserve guest/audio identity and rights. Exact ingress,
latency, retention and polling budgets require measurement in P0/connector proof.

## Core room UI, not a collection of new panels

Product clarification: brackets in earlier toolbar sketches represented clickable
controls, not panels. Sets are a first-class production capability alongside
recording and live output. Register one **Set controls panel** in the existing
docking system; it can live in any of the four existing docks or be hidden.
There is no new dock. Its content is authored by the loaded package and responds
to current run state; without a set, it offers Import/Choose set.

- **Permanent top bar:** one Set selector with Import, Preview, Apply, Change,
  Configure and Remove actions. Import/preview does not replace live output.
  Existing Record and Go Live retain their independent meanings.
- **Contextual controls beside the output:** active layout selection and a bounded
  group of declared primary controls. A package providing show orchestration adds
  current segment/time and authorized Start, Pause/Resume, Next and Stop controls
  as appropriate to its modules. Producer owns Stop and recovery; imported UI
  cannot hide or replace them. Starting a show does not silently start an external
  stream. Recording starts only under the explicitly configured recording policy.
- **Existing output area:** renders the composed set through the native output
  graph. Operator controls and room chrome are excluded from this output.
- **Existing Sources and inspector:** bind logical set slots to room sources and
  configure selected elements. Set layouts and manual scenes keep distinct state
  and explicit arbitration even if their selectors share existing UI space.
- **Existing Settings → Integrations:** configure credentials and connectors;
  contextual inspector status exposes live feed health and binding diagnostics.
- **Set controls panel:** richer authored forms and controls that do not
  fit the compact action strip. It uses existing docking machinery. No separate
  mandatory Show controls panel, Set desk mode or full-window workspace takeover.

Changing the visible docks does not stop a set or show. Stopping optional show
orchestration leaves the set loaded and preserves the current composition until
the operator changes it; recording ownership and room/media lifecycle remain
separate. Remove/revert the set is an explicit selector action.

The existing Studio button currently selects whole-window output capture
(`live_set_studio`), not an operator workspace. Do not repurpose it as a Set desk
switch or accidentally broadcast imported controls. Any future custom operator
workspace is an explicit separate view with Producer-owned escape/recovery.

Implementation seams: existing room top bar and selected-source inspector in
`src/views/Live.tsx`, panel registration/docking in `src/lib/layout.ts`, and the
native composition/output boundary. Runtime, package validation, data adapters,
room authority and optional show modules are independent of panel count. This
section is an implementation design, not a claim that the runtime exists.

## Dynamic operator controls

A package declares distinct output and operator surfaces using the same bounded
node, binding and component foundations. They have separate render roots and
authorized data projections. Operator controls never become output pixels or
receive raw integration credentials. No per-set compilation or arbitrary
package-provided JavaScript is required.

Producer supplies the permanent panel shell: set identity, connection/run status,
applicable lifecycle controls, command pending/error feedback and recovery. Stop
remains reachable in core chrome even when this panel is hidden or its imported
content fails. The package supplies a responsive control tree, stable node IDs,
typed inputs, declared primary actions and visibility/enabled bindings. Preserve
input drafts/focus/scroll by stable node identity across live feed updates; an
explicit phase change can intentionally replace a group without carrying obsolete
draft values into the new phase. Support narrow side docks and wide top/bottom
docks through declared layout rules, not hard-coded show-specific JSX.

The same panel remains mounted when optional show orchestration starts. Always
available set controls can remain visible; active module/phase adds its applicable
controls. A competition fixture could move from contestant slot assignment to
Open voting, then Close voting/results, then Reveal winner. A set without these
modules never receives those controls. Segment-specific groups are optional and
must not manufacture segments for a set or a non-segmented show.

Bindings decide presentation, not permission. Each interaction submits a typed,
registered action with its run/phase identity and required revision/fence. The
room authority checks actor capabilities, current lifecycle/input window and
action preconditions, then acknowledges or rejects it. UI visibility alone cannot
authorize commands. Role projections give hosts and delegated moderators the
controls/data appropriate to them. Preserve rejection reasons and pending state;
do not display a completed scene change or winner reveal before acknowledgement.
Time-sensitive actions use explicit phase/input-window checks rather than a
whole-room revision invalidated by unrelated chat or reactions.

Toolbar primary actions and panel buttons invoke the same action registry and
share pending/acknowledged state. They are two views of the same operation, not
independent behavior. The public audience/guest interaction contract remains
separate and native iOS retains native controls. Custom operator widgets must have
declared validation and a failure fallback; package errors disable affected
controls while trusted Stop/recovery continue to work.

Minimum control proof: After Hours changes layout/text from its dynamic panel
without any show module; Head to Head changes control groups through optional
show phases; role restrictions survive forged clicks; stale/duplicate commands
cannot double-advance or reveal; repeated feed updates preserve input focus;
both side and horizontal docks remain usable; a failed control subtree does not
break trusted Stop or silently stop recording/streaming.

## Participant surfaces, private answers and linked rooms

The same set can declare participant controls separately from operator controls
and broadcast graphics. Guest web, audience web and Producer guest seats render
their authorized player surface; native iOS maps the semantic widget schema into
SwiftUI. Registered actions support choices, answers and targeted participation
without arbitrary downloaded JavaScript. Sets do not require show orchestration
to offer an interaction.

Canonical identity, private evaluation/explicit reveal, frozen contestant targets,
phone contestant sign-in and guest own-room streaming are defined in
[Participation and room links](PARTICIPATION-AND-ROOM-LINKS-PLAN.md) with
[illustrative typed contracts](PARTICIPATION-CONTRACTS.ts). Those conditions are
part of the foundation, not a promise that fixed vote cards or current anonymous
tokens already support them. Producer guest contribution and origin return/relay
use distinct routes; game authority stays with the origin room/run.

First-build scope correction: retain existing Boomin email/code sign-in for phone
contestants and canonical native/guest identity handoff. Guest social OAuth,
provider-account eligibility and social-data game fixtures are deferred. Ordinary
set API/webhook/manual data sources remain in the architecture. Existing brand
integrations are unaffected.

## Rehearsal is a first-class execution mode

Producer offers Rehearse from the Set selector and labels the panel/preview
**Rehearsal** throughout. It executes the same validated package, bindings,
registered actions and reducer semantics against isolated simulation adapters:
mock sources/participants, votes/answers/reactions, manual/sample feeds and a
controllable clock. The mode belongs to a trusted execution session, not a
package-declared flag that can authorize itself. Use a separate sandbox ID,
storage namespace, command/receipt ledger and adapter instance.

Provide pause/resume, advance simulated time, inject inputs, disconnect/reconnect
simulation, reset and inspect action/rejection traces. The traces contain safe
diagnostics rather than credentials or private live answers. Rehearsal does not
automatically fetch real APIs, deliver webhooks, invite/remove real guests, award
live scores, switch the active composition, stream or start/stop live recording.
These prohibitions are enforced at the adapter boundary, not only by disabled
buttons. An imported action cannot select a live adapter or escape its sandbox.

By default rehearsal renders in a separate preview without touching the active
native output graph. Native output proofs require an explicitly isolated test
graph/output, or an idle dedicated test session when isolation is unavailable;
do not reset a global canvas while a real broadcast uses it. Any later rehearsal
recording is explicitly selected, locally owned and scoped to that test output.

Starting live creates a fresh authorized run after preflight; only the selected
validated package/configuration carries forward. Simulated identities, submissions,
results, timers and receipts never migrate into a real run. A real-device/private
room rehearsal is a separate integration test with legitimate scoped sessions,
not permission to inject simulated actors into a production game.

P0 acceptance: After Hours and Head to Head can be exercised with deterministic
sample inputs; reset reproduces the sequence. Run malformed/forged actions and
confirm no live transport/native adapter is called. Rehearsing beside an active
room leaves its composition, participants, interaction ledger, recorder and
destinations unchanged. Trusted Stop closes only the rehearsal session; live
Stop/recovery remain independently reachable.
