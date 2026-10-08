# Sets, people and interactions: development panel refactor

2026-10-05. Panel consolidation and the agent authoring workflow are implemented
in development. This complements the existing engine plan and its acceptance
gates; real set output and show participation are still separate work.

## Current capability

JSON import, package validation, declared controls, editable fields, layouts and
isolated rehearsal work. After Hours is a standalone set; Head to Head adds an
optional competition simulation. The prototype show contract currently supports
the small voting fixture, not every future show format. Native composition has
isolated visual proofs. Real room source assignment, live application/removal,
authority, participant adapters, recording and recovery still need integration.
Prepared means configured for preview/rehearsal, not applied to program output.

## Set controls

One **Set preview ↗** button opens the preview over the room. No embedded preview
or separate expand button. Closing or Escape returns focus to the trigger and
does not reset the configuration or practice run.

Persistent header: set name, preparation/rehearsal/live status, Set
preview, Edit set with agent and the appropriate primary action. The ? beside
agent editing explains that both set design and optional show behavior can be
changed through a validated JSON package. The loaded set also indicates
whether a show is attached. Sections:

- **Setup:** declared editable values, available layouts and source assignments.
  The Source slots section identifies declared slots as sample video; source assignments must use real room sources once the live adapter exists.
- **Show run:** with a show attached, keep its current/next step, controls,
  collapsible Segments list, total duration and elapsed time together. Preparation and
  rehearsal use the same section; rehearsal labels its simulated clock and sample
  inputs. The segment name is the primary heading, with a countdown alongside it;
  run status, segment position and next-up information use smaller text. Keep
  instructions only when they explain a necessary action or unavailable result.
  Start show sits to the right of the current segment and next-up text.
  Show run and the independently scrolling Segments list sit side by side in
  wide docks; narrow side docks stack them. Segments stays visible as a scroll
  view without moving Start, Next, Pause or Stop. The side header groups the set
  name/status, rehearsal and preview actions. Standalone sets have their own Layout section and optional
  Add show action, with fields and source slots below.
  Live execution remains blocked until output integration. With no show attached,
  the set instead explains that it can run continuously and offers Add show.
- **Segment controls:** follows the active declared segment. Introduction has no
  voting, player simulator or reveal buttons. A voting segment shows sample
  participants, voting, reactions and its simulated clock while collection is
  open. Closing voting replaces those inputs with tallies and Reveal winner.
  Closed, unresolved votes can reopen for another declared voting window,
  preserving counts and one receipt per participant. A tied result offers a
  fresh tie-break ballot restricted to tied leaders (previous tallies retained),
  or an explicit Reveal draw that awards no winner and permits progression.
  A tie-break allows participants to vote again once in that new ballot.
  Zero votes can reopen but cannot award a winner or a draw. Resolved results
  cannot reopen. The result segment shows the winner or the declared draw. Reveal belongs here, not in Show run.
  Relevant inputs stay visible but disabled during Pause. This prototype derives
  voting controls from the declared timed collection phase, not segment names;
  broader interaction types still require the reviewed runtime contracts.
  Rehearsal uses the same control placement planned for live operation.
- **Top-bar Set settings:** the Set button opens operating controls; its adjacent
  gear opens an opaque menu to choose or replace a set, edit with an
  agent, import JSON and export configured JSON. File/design actions stay outside
  the operating panel. Help stays within the menu.
- **Rehearsal recovery:** Reset rehearsal sits beside Exit rehearsal. Resetting
  rehearsal is distinct from replacing the set or removing a live set.
- **Activity:** optional collapsed diagnostics below the Set settings menu actions.

Agents author visual design and show rules as validated JSON. Producer exposes
the package's declared runtime adjustments directly; it needs no visual builder.
Add show, Edit set with agent and Export package open a trusted
dialog. Copy package JSON exports configured field/feed defaults and selected
initial layout; Copy agent brief includes the package, schema and the creator's
request. Rehearsal edits, results and participant identities are excluded.
Updated JSON can be pasted and validated in the dialog or imported from a file.
An Add show update must actually contain a show module. Successful loading
replaces preparation and exits rehearsal; it does not publish live output.
Rehearse the update before future live application. A
rejected import retains the current package. No integrated agent service or
automatic arbitrary competition generation is assumed.

A show is optional behavior attached to a set. Starting it starts a fresh run;
stopping it keeps the set loaded. Removing the set restores ordinary room output
through the reviewed native lifecycle. The room's docks, streaming, manual
recording and recovery remain Producer-owned.

## Consolidated people controls

Audience access and joining controls live beside guest management in **People**.
The collapsed Join links section keeps guest management and stage requests
accessible in small panels; slim row docks open join/request popovers. Present two clearly described join links:

- **Guest invite:** joins backstage with camera/microphone controls; host admission
  and source placement determine when media is included in output.
- **Audience link:** watches output, chats, interacts and requests the stage;
  watching does not activate a camera or microphone.

Show audience access, online count, guest/backstage roster and raised hands in
this panel. Keep delivery settings collapsed. The existing `direct_limit`
controls audience recipients of program video, not incoming guest feeds. It is labeled
**Video viewer limit**, with guest capacity separately identified and the
existing separate interaction capacity preserved. Combining panels must not combine
these limits, invitation permissions or identities.

## Interactions and chat

The existing Audience/vote dock is **Interactions**, initially with polls
and votes. Future registered participant actions can include answers, reactions
and other game inputs. Guests retain audience interaction powers; being a guest
does not remove the ability to vote or play.

An interaction owned by a show must identify its owner and link to the current
show step. It uses the same authoritative interaction and receipts rather than
creating a second independently editable poll. Independent polls still work
without any set or show.

Chat stays in the shared Chat panel with Boomin and external platform filters.
Neither People nor Set controls duplicates the chat feed.

## Consolidation implementation constraints

Saved four-dock layouts and panel placement are preserved. The internal `vote` panel
ID currently names the Audience dock, and remains unchanged; its metadata now names Interactions. The `guests` ID
now names People. No duplicate panels or resizing migration is introduced. Reconcile host and moderator surfaces,
permission gates, compact strip/column layouts, standalone poll behavior and
guest admission when moving audience controls. Keep the live-output build gates
from the architecture review; a cleaner control panel does not satisfy them.

## Verification

TypeScript/Vite build, 18 runtime checks and Chrome/WebKit browser workflows
pass. People browser checks cover saved-layout normalization, guest admission,
show/mute controls, audience configuration, stage requests, social sharing,
standalone poll setup/reveal/close, permission revocation, scoped moderator
grants, compact popovers, 360px side and wide bottom docks, and shared moderator
tabs. Set browser checks cover Add/Edit show, configured JSON export, clipboard
brief/package copy, rejected imports, rehearsal preservation and 220px docks.
Unified chat regression checks also pass on both browsers.

People now uses short join descriptions with full guest/output behavior behind
each help button. Copy link and the icon-only Share button stay alongside each other when the card is narrow; audience counts,
video delivery and waiting-guest actions wrap without overlapping. Chrome and
WebKit checks cover actual 200px, 201px, 240px and 320px dock widths for host and
moderator views, including expanded help, sharing and delivery controls.

The running signed local preview receives these frontend changes through the
dev server. No native rebuild, desktop release or server deployment is part of
this panel refactor.

Studio capture and recording remain available with Set controls and rehearsal
visible. Whole-window capture includes the visible workspace by the creator’s
choice; it is independent of applying a set to composed program output. Only
room loading blocks Set controls. No native recording path was changed.

The top-bar Set action becomes Exit rehearsal while rehearsing, retaining its
attached settings gear. There is no additional Exit rehearsal chip. The running
show action uses the same position for Stop; live show execution remains gated.
