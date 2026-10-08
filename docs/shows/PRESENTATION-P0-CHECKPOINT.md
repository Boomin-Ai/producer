# Presentation engine: first implementation checkpoint

2026-10-04. **Development rehearsal and isolated native visual proof implemented;
full P0 and live integration remain open.** The architecture review's native, identity, authority,
microphone and recording conditions still apply. This checkpoint supplements the
plans and preserves the original review archive.

## Available now

- One executable `producer.presentation/1` codec supplies the TypeScript package
  type, structural importer and exported JSON schema. The importer also performs
  cross-reference, component-cycle, expanded-node, binding-type and value checks
  that JSON Schema alone cannot enforce.
- After Hours is a standalone set: two simulated slots, reusable nameplates,
  conversation/solo layouts, typed headline/energy feeds and authored controls.
  It has no show, contestants, votes or phases.
- Head to Head composes the same set with a small optional show simulation:
  introduction, voting, reaction heat and winner reveal. Closing voting does not
  reveal or advance. Zero inputs/ties refuse to choose a winner; a live operator
  resolution flow is still required. Restart clears prior private simulation
  state. Stop leaves the current set composition visible; Reset restores defaults.
- Set controls is one panel in the existing four docks. A development top-bar
  Set button opens it; trusted Stop is outside the imported declarations and also
  present in the panel. File import retains the previous package on rejection.
  Renderer/binding errors leave trusted controls available.
- Rehearsal has separate immutable state, a deterministic manually advanced show
  clock and in-memory mock identities/inputs. It imports no transport, IPC,
  recorder or native-output adapter. Show animation sampling follows that clock;
  standalone set decoration uses a local cosmetic CSS clock. There is no state
  promotion from rehearsal into a live run.
- Shared [source appearance](SOURCE-APPEARANCE.md) now covers rectangle/circle,
  radius, inside outlines, grayscale and opacity. The source Filters editor and
  JSON slot bindings use the same bounded properties. Native pixel tests pass;
  separate video-only placement wrappers also pass a shared-source isolation
  proof. Live placement lifecycle/grants/fences remain to be integrated.
  The operator has now confirmed real-camera filter/output adjustments work in
  the signed Mac preview. Rehearsal controls have visible step/vote/heat feedback,
  distinct sample participants and scrolling verified with actual room CSS in
  constrained side/bottom panels on Chrome and WebKit. This UI still uses mock
  source placeholders and does not replace the room's output.
  The operator confirmed the full rehearsal progression. The panel now displays
  a transition-ordered rundown and honest timed/manual duration; its preview is
  opened only on demand using one **Set preview** button and a room-overlay popup.
  The section workflow replaces Run / Set / Test tabs: fixed mode/preview
  header, simultaneous Show run and Test interactions, and Setup/Show/Package.
  The [panel refactor](SET-CONTROLS-AND-PEOPLE-UX.md) groups joining and audience
  delivery in People, keeps standalone polls in Interactions, and supplies
  Add/Edit show and design adjustment through a validated agent JSON handoff.
  Preparation captures configured fields/layouts/feeds. Rehearse creates separate
  practice state; Exit discards it and restores preparation with a fresh sandbox.
  Stop run stays in rehearsal. Runtime tests cover clearing private identities,
  preserving preparation, reset and set-only entry/exit; browser checks cover the
  complete workflow and the essential combined view in a 220px bottom dock.
  Expanded reference content can scroll inside its column without shifting the
  operator controls. Prepared mode still has no native output adapter.

## Native visual proof

The disposable `scripts/presentation-proof` harness now renders the same resolved
JSON visual projection in the installed engine's actual CEF renderer, with native
media between transparent foreground graphics and the background. On Metal/NV12,
Conversation → Solo → Conversation preserves the native slot geometry and actual
output pixels. The proof captures title/nameplates above two synthetic native
sources, then a single-source layout. This is actual native composition, not a
browser screenshot: [Conversation](../previews/presentation-native-conversation.png),
[Solo](../previews/presentation-native-solo.png).

A scoped random loopback capability serves GET-only projections and trusted
renderer assets. There are no command endpoints, IPC/native handles or resource
URLs supplied by packages. Origin/host/method/routes and stale publications are
checked. Actual CEF checks prove an opaque child cannot access its parent or Tauri,
cannot fetch remote resources or acquire camera/microphone, and the outer browser
source has engine control level zero. Revocation clears the graphics; native
teardown exits cleanly. The test graph has no devices, audio, recorder, stream
destinations or public room connection. The running installed app is unchanged.

This Node capability server and Objective-C graph are **test-only proof adapters**,
not production dependencies. A shipping Rust output adapter, actual Tauri isolation,
native execution leases/fences and recovery still need implementation and testing.
Only a root backdrop/native-media/foreground composition is proved; arbitrary
interleaved layers, ancestor masks/transforms and animated media are not supported
by this proof. Tests deliberately wait for stable pixels: native position/bounds
readback is within one design pixel, but chroma edges allow NV12 conversion error.
No atomic two-frame commit, full crop/fit/z readback or performance budget is claimed.

The output iframe receives a resolved visual tree and bounded CSS through a
MessagePort. It does not receive the operator tree or raw state. Winner/total
fields are redacted before reveal. Text uses DOM `textContent`; packages cannot
provide HTML/JavaScript, URLs, event handlers or network commands. The frame has
an opaque origin, scripts-only sandbox and restrictive inline CSP. Only the
actual child window can establish its port. Render keys preserve unambiguous
ancestry. React StrictMode and iframe load/reconnect use a probe handshake.

Bounded subset: 128 KB file imports, 24 codec levels, 600 expanded nodes across
the package, 16 layouts/components/phases, 8 slots, 40 controls, 2–6 show choices,
typed bounded scalar feeds/fields, `get`/`eq`/`if`/`concat` bindings, allowlisted
styles, opacity/transform motion and registered simulation actions. Unknown
versions/fields/actions fail closed. This is not a legacy `producer.show/1`
adapter or the complete future live package contract.

Nordcraft contribution is a small modified keyframe-emission adapter. Its pinned
source attribution and Apache license live beside it. The builder and arbitrary
workflow evaluator are not incorporated.

## How to use and verify

In a development Producer room, choose **Set: After Hours** in the top bar (or
Set controls in the panel menu). Choose the fixture or import its JSON, edit
fields, select layouts and change Sample data. For Head to Head: Start show,
Next, vote with distinct simulated player IDs, React, advance/close voting,
Reveal winner, Next or Stop. This does not publish real votes or source changes.

Whole-window Studio capture and recording are allowed while Set controls and
rehearsal are visible. The creator chooses whether to capture the workspace;
this does not apply the set to the composed program output or bypass native
execution/lease fences. The production panel gate remains closed even for a
saved layout containing it.
An updated [signed local Producer preview](LOCAL-PRODUCER-TEST.md) is now prepared;
its packaged engine self-test passes with the new appearance/placement source
types, Metal and hardware VideoToolbox. The operator approved switching the Mac
to this preview; it is now open at Home, awaiting macOS Keychain authorization.
UI/real-camera testing is the next acceptance check.

Independent browser preview, with the normal Vite dev server running:

`http://127.0.0.1:1420/scripts/presentation-browser.html`

Append `?dock=bottom` to examine the row layout. A harness is not an OBS output.

```sh
npm run test:presentation
npm run export:presentation
npm run build
npm run test:presentation-browser
npm run test:presentation-output
npm run test:presentation-native-sources
npm run test:presentation-native-output
```

The optional browser check uses an existing Playwright installation. Set
`PRODUCER_PLAYWRIGHT_MODULE` to its module path outside this machine;
`PRODUCER_PREVIEW_ORIGIN` changes the dev-server origin. No production dependency
was added. Runtime tests run in frontend CI.

Validated: 12 runtime scenarios plus production/development panel gating;
seven existing feature-access tests; Chrome and WebKit end-to-end fixture edits,
layout switching, invalid import recovery, duplicate-vote refusal, reveal/reset,
StrictMode startup, opaque-origin parent/IPC isolation, blocked network requests,
and 360px/side/bottom layouts. Full TypeScript/Vite production build passed.
Screenshots were visually checked. The additional actual CEF/native checks above
pass on macOS; actual Tauri and Windows behavior remain open. Cargo check passes
with the native appearance filter; no installed-app rebuild or release was made.

## Remaining build order

1. **Finish P0 in the actual native environments.** Extend the proved CEF/native
   path to the shipping adapter. Prove Tauri frame/IPC, trusted Stop/recovery,
   generation/lease fences, frame/performance budgets and complete native receipt
   semantics. The room preview does not yet bind live sources or replace program
   output. Run these tests on an isolated graph
   or an idle dedicated test instance, not a live external stream.
2. **P0b independent canvas spike.** Measure portrait/Both support, shared input
   lifecycles, recording separation and no doubled audio. Browser preview aspect
   ratio support does not make native portrait output ready.
3. **Room/run authority and participation.** Resolve reviewed deduplication,
   durable deadlines, receipt/fencing and guest/audience identity continuity.
   Retain account-only phone email/code sign-in and guest audience powers;
   Instagram authentication stays out of the first build.
4. **Native effects, recording and real data.** Reconcile source placement and
   per-source audio grants; implement generation-checked execution and reliable
   recording finalization. Add authenticated webhook and trusted GET polling
   connectors with mapping, dedupe, freshness and credential isolation.
5. **Participant adapters and complete rehearsal.** Dynamic registered guest
   actions and native iOS widgets; After Hours followed by Head to Head with real
   host/mod/phone players, consent, recording and ordinary-room regressions.
   Additional games and linked-room broadcasting follow their own gates.

There is no deployment, release/version change, server migration or iOS change in
this checkpoint. None of the nine reviewed blockers is declared resolved merely
because the isolated browser simulation passes.
