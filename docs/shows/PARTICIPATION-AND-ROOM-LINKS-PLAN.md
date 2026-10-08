# Participation, private evaluation and linked Producer rooms

Architecture refinement, 2026-10-04. Proposal only: no runtime changes, deployment
or live-room effects. Read with `PRESENTATION-ENGINE-FOUNDATION.md` and the nine
conditions in `SHOW-ENGINE-ARCHITECTURE-REVIEW.md`. This supersedes earlier wording
that treats participant controls as permanently fixed vote cards or treats all
generic interactions as an unspecified future endpoint. Contracts and capability
negotiation must exist before custom participant actions ship; implementation
remains gated. Illustrative types are in `PARTICIPATION-CONTRACTS.ts`.

## First-build scope and current status

The foundation/control contracts are being refined; the engine is not implemented.
Next is P0: freeze set plus optional show composition and the executable schema,
then prove isolated output and the dynamic Set controls panel with After Hours.
The first interactive rehearsal is Head to Head with phone contestant sign-in.
Existing B1–B9 implementation/release gates still apply. Private answers and
registered player widgets are architectural contracts; additional game fixtures
and linked-room relay follow their separate proofs.

Guest/contestant Instagram linking, social metrics, provider-account eligibility,
OAuth screens and social-data game fixtures are excluded from the first build.
A future adapter can use the ordinary typed data-source boundary without changing
player identity or the renderer. Existing brand integrations are unaffected.

## Product and authority boundaries

One package contains a set and optional show orchestration. Sets can declare
interactions without a timeline or contest. The runtime serves three distinct
surfaces: public output, operator controls and participant controls. The operator
Set controls panel uses the existing four docks. Participant controls accompany
the return/playback view in guest web, audience web, native iOS and Producer's
guest seat. A media-only guest view is insufficient.

Room authority owns membership, moderation and permissions; run authority owns
the current set/show, interaction windows and results; native host execution owns
media effects, composition and recording. Reuse existing room control storage and
effects infrastructure; do not add a second scene controller. One run has one
authoritative reducer, even if its output is distributed through multiple rooms.
Voting, answering, showing a source, admitting its audio, disconnecting a guest
and starting an external stream remain separate operations.

```text
guest / audience / Producer player / native iOS
    -> authenticated typed input
    -> canonical principal + eligibility + window + dedupe
    -> room/run authority: private evaluation and durable outcome
    -> public projection / own-player projection / operator projection
    -> native controls and set graphics

API / webhook / manual data
    -> authorized connector -> normalized versioned data
    -> approved projection or pinned private round snapshot
    -> same bindings / registered rules / results
```

This is an application control/data path. The host still renders, encodes and
records on its hardware; input does not require server-side video rendering or a
new Cloudflare product. Existing infrastructure and TURN can still have costs.

## Code-grounded inventory and actual gaps

Paths below are relative to this workspace; `.codex-work/api-domains` is the
inspected hosted-backend checkout, whose changes must land in its own repository.
Findings describe local source, not a fresh production deployment audit.

| Area | What exists | Extension / condition |
| --- | --- | --- |
| Participant grants | `server/guest/src/participants.ts` separates identity kind, media grants, inputs and room controls | Keep capabilities separate from contestant/team/media state; version new interaction grants |
| Vote schema | `server/src/interactions/schema.ts` supports vote only with exactly two options; hosted `services/live/interactions.ts` ships vote only with two to six options | Shared versioned registry and negotiated capabilities; neither is an arbitrary game engine today |
| Reveal and projections | Self-hosted `interactions/project.ts`; hosted `realtime/interaction-state.ts` | Replace broad spec spreading with explicit allowlisted projections before private answers/data |
| Input response privacy | Hosted `submitInteractionInput` returns `tallyFrom(res.data)` after the DO returns `tallyOf(...)` | Return own accepted receipt only before reveal, including HTTP and error paths |
| Identity | Hosted `routes/connect/room-audience.ts` mints device-derived audience subjects; guest inputs use a guest participant identity | Server-owned account/principal links and authenticated promotion/sign-in handoff |
| Exact dedupe | Self-hosted `interactions/tally.ts` stops retaining identities at 5,000 and counts blindly; hosted keeps voters in its DO record | Exact receipts throughout admitted lifetime, or explicit admission rejection; durable restore must preserve them |
| Native audience | `boomin-ios/Sources/AudienceModels.swift`, `RoomAudienceView.swift`, `AudienceRoomStore.swift` implement fixed vote cards and device tokens | SwiftUI widget adapter and identity/session upgrade; no imported HTML/JavaScript |
| Producer guest | `Home.tsx: enterSeat` opens the player's own room; `GuestSeat.tsx` and `guestSeat.ts` send its virtual camera where available and receive host output/audio | Useful local production seam; add participant controls, selected output identity and explicit audio routing |
| Engine lifetime | `src/lib/roomSession.ts` serializes room view work; global native engine outlives views | Do not instantiate a second independent engine or restore a second global room graph on a guest join |

## Identity, eligibility and participant state

Use a server-owned canonical principal with room-scoped opaque public IDs and
separate transport sessions. A person can be an audience member, contestant,
onstage guest and host of their own room simultaneously. Model orthogonal state:
identity assurance, room membership, competition role/status, media admission,
interaction grants and delegation. Do not turn these into one exclusive enum.

For the first hosted contestant game, require a signed-in Boomin account to
enter as a contestant. Spectators can remain anonymous under room policy.
Reuse the existing phone email/code sign-in; no social-account connection is
required. Signing in proves account control, not uniqueness of a human. Anonymous
per-device voting cannot promise one human one vote across devices. Self-hosted
sets retain explicit anonymous/local identity policy and do not silently require
Boomin registration.

Sign-in upgrade and promotion exchanges are server-issued, short-lived, single-use
and bound to the authenticated actor, target room and existing principal. Never
trust a body containing `userId`, email, username, guest ID or principal ID as
proof. Keep restrictions, receipts and identity through browser/native handoff,
promotion, demotion, reconnect and native return. Restrict handoff tokens to the
exact capability family; share domains are aliases, not identity authorities.

If sign-in discovers two existing principals with inputs in the same window,
merge their accepted-input histories atomically and enforce the frozen policy:
retain the earliest accepted input under `once`; under `latest_wins`, retain the
latest accepted choice. Rebuild the aggregate rather than double count. Mark
aliases as merged, preserve replay receipts and bans, and record the reconciliation.
Strict account-required games do not accept anonymous game inputs before sign-in.
Eligibility requirements are checked again when an input is accepted; revocation
cannot be bypassed by reusing an earlier render/session projection.

## Phone contestant sign-in is retained

The native app already has email/code authentication and secure session storage
in `boomin-ios/Sources/SessionStore.swift` (`sendCode`, `verify`, `TokenStore`).
`AudienceRoomStore` currently creates a separate device audience token; being
signed into the app does not yet turn that into an identified contestant. Connect
these through an authenticated backend exchange, not by sending an asserted email.

Preserve the room/run/invitation as pending navigation while the user signs in.
Reuse an existing verified session without prompting again. After authentication,
resolve the canonical account principal, then apply contestant eligibility and
host admission independently. A contestant does not need a new brand, a partner
program or extra media permissions to submit answers. Existing app authentication
currently also handles workspace resolution; explicitly prove account-only play
can complete without forcing brand creation. Do not confuse `signedIn` currently
requiring a resolved workspace with the minimum player account identity.

Carry the same interaction principal into the guest media page and back to native
controls using a short-lived scoped handoff. Do not place the app auth token in a
share URL. Waiting, denied, full, expired-session and closed-run states must return
the user to a usable screen; signing in does not implicitly activate camera/mic.

## Participant UI: dynamic semantics with native rendering

Packages declare typed controls and bindings. Initially standardize choices,
action buttons, text answers and bounded numeric/rating inputs with accessible
labels, stable IDs, validation and busy/disabled/submitted feedback. The renderer
maps that semantic tree into web/Producer components or SwiftUI components.
JSON style tokens are bounded; arbitrary CSS/HTML and arbitrary event code are
not portable native participant controls. Extend through versioned registered
widgets/actions, not unrestricted `eval` or arbitrary endpoint URLs in buttons.

The server projects only the controls and state applicable to this player. A
contestant may get an answer form while spectators get Support / Oppose controls.
Stage changes do not close those forms unless explicit eligibility/window rules
say so. A private draft is device-local; an accepted submission is server state.
Reload restores acceptance and permitted own-answer data without reopening input.

Each input references room, run, interaction and window identity, request ID and
an option/typed payload. The server resolves the actor from credentials. Retries
are idempotent; conflicting reuse of a request ID fails. Validation, moderation,
deadline, roster eligibility and scoring acceptance occur in the authority's
atomic transaction. No whole-room CAS is invalidated by unrelated chat traffic.
Client clocks and disabled buttons are advisory. Inputs at or after the frozen
deadline fail even if an alarm is delayed; pause policy is explicit per interaction.

Capabilities are negotiated before play. A client lacking a required widget can
still watch if allowed, but cannot enter that game until upgraded or using an
explicit compatible client. Never advertise a button that its client cannot
execute, nor silently convert a quiz into a poll on an older backend.

## Right/wrong now, reveal later

Split a definition into public prompt/options/controls and a private evaluator
reference. Answer keys, scoring rules that expose answers and private evaluation
data never enter the downloaded participant tree, public set projection,
participant HTTP response, broadcast frames or diagnostics. Merely hiding HTML
does not conceal an answer. A public source package cannot conceal a key either:
competitive runs load keys from a separately authorized runtime data source,
not a publicly distributed package asset. If a format's evaluator is public,
label it as a non-secret game and do not claim hidden-answer protection.

Use a small versioned deterministic evaluator registry (e.g. option equality,
normalized text against accepted answers, numeric range, named pinned metric)
with strictly validated configuration. Arbitrary host-supplied server code is not
part of this API. Creative client animations can react to projections; they do
not decide correctness or grant points. Decide whether host/mod can see answers
early through explicit projections; a competing host must not receive those
privileges. A self-hosted operator controls its infrastructure, so this is not a
claim of protection against a malicious server operator.

At open, pin prompt/evaluator version, target roster, eligible policy, scoring
policy, data snapshot and collection/reveal rules. Persist each accepted answer
privately with canonical principal, server acceptance sequence/time and evaluator
version. Return `accepted` with a receipt, not correctness, totals or winner.
Pending, closed-awaiting-reveal and revealed are distinct states. Closing input
does not automatically reveal. Reveal is an idempotent authoritative event that
publishes only the permitted result, keyed by reveal ID and server time; renderer
reconnect seeks that event rather than re-awarding or replaying it as a new result.

For timed buzzers the rule is server acceptance order with declared ties; it is
not guaranteed to identify the fastest physical tap across unequal networks.
Scoring consumes accepted/revealed facts with unique effect IDs. Award/retract
operations keep an audit trail and never treat a client's `correct: true` as proof.

## Audience votes toward or away from a contestant

At interaction open, resolve choices to a frozen roster of stable contestant IDs,
not names, array positions or dynamically reused camera slots. A display label
can change without transferring old votes. The creator chooses an explicit mode:
support, elimination ballot, or support/oppose with declared weights. Keep raw
nonnegative counts and compute net scores through pinned rules. Do not represent
opposition by decrementing a tally below zero or giving the audience score-write
permission. Eligibility, self-voting, budget, once/latest-wins, ties, zero input
and departed/eliminated target behavior must be declared before collection.

An accepted vote selects a server-issued choice ID. Its mapping to target/effect
is immutable for that window; arbitrary `targetId`/weight in a forged payload is
refused. Transferring a latest-wins vote removes its prior contribution once and
adds its new contribution once. One vote budget applies across all transports
and linked rooms. Stage/layout changes do not automatically remove eligibility.
Scores, reveal and media elimination are separate acknowledged effects; losing
usually changes public layout/audio and competition eligibility, not room access.

## Guest produces and streams from their own room

Keep the player's room and upstream appearance as separate sessions in the same
Producer instance. Being a guest of room H does not remove host rights over own
room G. G's Record/Go Live/Stop affect G's destinations and recorder only. Ending
an upstream appearance does not stop G's stream; stopping G's stream does not
end the appearance or host H's show. No new engine instance should be created
just to display H's player controls or return feed.

Existing virtual-camera guest capture is an integration seam, not proof of the
complete routing model. Upgrade it to explicit output selection and capture
identity where needed; negotiate aspect, availability and local hardware budget.
Source capture and processed audio are reused, not opened once per output viewer.
Guest microphones need the correct processed contribution bus, not an unchecked
system mix or host return. The guest's private host monitor remains a monitor.

```text
G local sources -> contribution feed -> H guest source -> H composed output
G local sources -------------------------------> G own audience/destinations
H output -------> G monitor (not automatically in G contribution)
H output -------> authorized G source -> G own destinations (optional relay)
```

Support two explicit choices: stream G's own production while appearing in H,
or add H's authorized show output as a normal source to G's production. Relay
requires an upstream grant for the named room/run/output and live consent for
media distribution; being able to watch does not itself grant rebroadcast. No
provider stream keys or owner-control tokens cross the room link. Separate
invitation, relay grant, participant capability and local destination permissions.

Maintain source/output lineage in the media routing graph. Monitor return can
come back to G, but must not be captured into the contribution sent back to H.
An H feed containing G cannot become G's upstream contribution to H. Reject
cyclic re-ingestion, indirect loops and whole-window Studio capture including
the return monitor; select a clean contribution bus/output or refuse the route.
Audio monitoring, upstream contribution, G public program and H public program
are explicitly named buses. Mix-minus and per-source lineage avoid own voice
return and duplicate guest mesh/host audio. Every new route needs tone/video tests.

If G's audience participates in H's game, bind the player surface to H's run and
issue scoped participant capabilities through the trusted backend. H remains the
vote/score authority. G cannot send aggregate totals or mint additional votes for
its guests. H's normal sign-in/moderation policy still applies. Canonical
account identity deduplicates cross-room votes, while anonymous limitations are
explicit. Cross-backend federation needs issuer trust/capability negotiation;
same-network links are the first implementation, not an open federation promise.

Rebroadcast audiences may have different playback delays. Use the origin run's
deadline; late replies are refused consistently. Formats requiring close timing
must declare latency eligibility/readiness or use paced non-speed rounds. Do not
claim synchronized video arrivals or fair millisecond races across relays.

## Implementation order and measurable acceptance

Preserve P0/P0b isolation/composition/output proofs and all B1–B9 conditions.
Define the extensions now so we do not hard-code phase 1 into the architecture;
do not release unimplemented capabilities merely because a manifest declares them.

1. **P0 contracts/control proof:** generate executable schema from one source;
   separate output/operator/player projections, widget/action registry and
   capability negotiation. Mock a standalone set and player choices; prove native
   widget semantics and responsive input preservation without live game effects.
2. **P1 identity/authority:** canonical principal and account upgrade, exact
   durable receipts, private answer storage/evaluator, frozen choice targets,
   collection/close/reveal separation and checked per-action moderation.
   Explicitly repair private tally/spec leakage in both backends before a quiz.
3. **P2/P3 media/UI:** retain native execution/recording gates; dynamic Set controls
   panel, guest web and Producer player controls, native iOS widgets and safe
   handoff. No private rules/answers in the output renderer or unsupported UI.
4. **P4 first-build rehearsal:** standalone After Hours set, then Head to Head
   vote/reveal with contestants signed in on their phones. Include native/web
   handoff, vote-once, reconnect, retained guest controls and owned recording.
   Locked Answer and Support/Oppose remain subsequent fixture proofs against the
   same registered-input/private-reveal contracts; they do not block the first
   two-fixture rehearsal.
5. **Linked-room proof before relay release:** own-room stream plus upstream guest
   connection, explicit contribution routing and optional authorized H source.
   Add G-audience participation into H only after scoped-session/identity tests.
   Portrait/Both retain the independent P0b/P5 gates.

Required checks:

- Inspect every public/player REST body, submission acknowledgement, websocket
  frame, package asset, error and reconnect snapshot before reveal: no answer
  key, correctness, private snapshot, private tally or credentials. Own-answer
  access is limited to the authenticated player and the declared reveal policy.
- HTTP and websocket run the same identity/window/permission checks. Vote once
  survives device-to-account link, audience-to-guest handoff, native/browser
  switch, reconnect, alias merge and both H/G entry points. Check 4,999–5,002
  identities and reject capacity rather than count blindly.
- Test deadline -1/exact/+1 ms, delayed alarm, pause, duplicate/reordered requests,
  crash restore, reveal retries and host/mod races. Score/reveal commits occur
  once; closing never reveals a private result accidentally.
- Frozen target tests cover rename, stage move, elimination, disconnect, slot
  reuse, self-vote exclusion and latest-wins transfer. Unknown choices and client
  score/weight/correctness claims are rejected.
- Same player widget semantics on web, Producer and native iOS; unsupported
  capabilities fail preflight for required play while permitted watching works.
  Scroll, focus and accepted-answer state survive updates and native handoff.
- Phone contestant flow: open link, sign in or register via existing email/code
  flow, return to the same room/run, enter under eligibility/admission policy and
  receive the same canonical participant identity after native/browser handoff.
  No program enrollment, social OAuth or forced new brand is required just to
  play. Session expiry/sign-out blocks new protected inputs; accepted receipts
  persist. Switching workspace brand does not change the contestant person.
- G streams/records while guest in H on Mac/Windows. Stop/leave each session
  independently, reconnect H, revoke relay grant and exhaust resources. Source
  captures are not duplicated. Host return never re-enters its origin contribution;
  injected tones expose no own-voice loop, duplicated audio or hidden public mic.
- Stop/recovery remain responsive, broadcaster controls absent from public feed,
  permissions remain scoped to owner/room/run, and legacy ordinary rooms work.

Open decisions for later fixture implementation: exact support/oppose weights,
vote budgets and contestant eligibility, and which upstream feeds permit relay. These are explicit policies, not blockers to
building the foundational schema/runtime and not reasons to invent defaults that
silently change a running competition.
