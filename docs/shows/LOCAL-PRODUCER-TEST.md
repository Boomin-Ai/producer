# Local Producer preview: source styling and set rehearsal

2026-10-04. Prepared a full native development build at
`src-tauri/target/presentation-preview/Producer.app`, using the current executable
and the installed engine bundle. The installed `/Applications/Producer.app` was
left unchanged during preparation. The operator approved switching the running
Mac app to this preview. The installed instance quit gracefully and the preview
launched successfully. The operator reached the host room, with camera output
and the After Hours rehearsal panel visible.

The first room test reported `stale_publisher`. A frontend regression test
reproduced source publication before scene registration when a socket becomes
OPEN before its open callback. Source catalogs now wait for scene publication
on each connection, coalesce to the latest complete snapshot, and are discarded
when the session stops. Reconnect/renewal tests, TypeScript checking, and the
hosted backend's publisher authority tests pass. The preview receives this via
Vite. The ordering fix alone did not resolve the operator's room.

The subsequent native UI trace showed `publisher_busy` on registration followed
by `stale_publisher` on source updates, and later `host_unavailable` after the
previous owner disappeared. Hosted ownership had only checked the transport's
OPEN state, allowing an expired room authorization to block a new publisher.
The hosted hub now requires a valid room authorization when selecting the
publisher, delivering scene/source commands, and projecting audience presence.
Authorization refresh and publisher mutations share the same queue. A direct
`scene.published` acknowledgement lets Producer clear ownership errors only
after the server accepts its connection. The frontend retries registration at
most once per five seconds when the former host becomes unavailable; it does
not retry an active `publisher_busy` conflict.

All 29 hosted realtime tests, frontend reconnect/renewal/recovery checks and both
TypeScript checks pass. The Worker-only fix was deployed as version
`1dc968bd-b1aa-4488-9d03-7a77a6f84abb` (previous version for rollback:
`d6386899-c13a-4604-800d-0b855343ae12`). Existing containers were not rolled out.
After deployment, the Mac reconnected automatically, registered at epoch 45,
and published source catalogs repeatedly without another ownership rejection.
This verifies host recovery; it does not establish which device owned the prior
connection or verify a new audience video call.

The operator subsequently confirmed that all real-camera filter/output
adjustments work in the Mac preview. The rehearsal feedback exposed a controls
layout problem: show actions were below all setup fields, with little visible
feedback above the fold. Rehearsal now places authored show actions and current
step/vote/heat status before the preview, groups sample participant inputs beneath
it, and collapses show setup fields into Set details. New participant provides a
distinct mock voter without editing an ID manually. The panel content no longer
flex-shrinks inside its scrolling body. Chrome and WebKit checks now use the real
room CSS and constrained side/bottom panel heights, verifying start visibility,
scrolling, duplicate refusal, distinct participant voting and winner reveal.
This remains simulation-only; real camera/guest binding is not implemented here.
The running Mac preview picked up the change without restarting; its panel
displayed Introduction, an enabled Next action and the new guidance. The operator
then confirmed the full rehearsal progression works. Their subsequent feedback
requested less preview space, future steps and show timing. The panel now has a
transition-ordered rundown, a highlighted current step and an Up next label.
Timing reports only declared voting windows plus manual phases: Head to Head has
one minute of voting and manually advanced introduction/reveal steps, not a fixed
one-minute total. Cyclic shows are identified as repeating, with no fixed total.
The preview is collapsed initially, can open as a small thumbnail or expand into
an HTML dialog over the room. Escape/Close restore focus and preserve the
run; only one sandbox frame is mounted while expanded. The final workflow uses
named sections rather than Run / Set / Test tabs. Preparation opens Setup, with
authored fields/layouts and sample feeds. Rehearse captures prepared configuration
and creates fresh practice state. Run and Participation then share the view;
Setup, Rundown and More form the reference column. More contains import, reset
and activity. Preview and Exit rehearsal remain in the fixed header even when
the section body scrolls. Wide docks use three columns; narrower docks stack
sections. The essential combined view fits a 220px bottom dock. Expanded or long
reference content scrolls within its own column without pushing run controls away.

Stop run keeps rehearsal open and labels the run as stopped; its next-step label
returns to the initial progression rather than mixing Ready with Final step.
Exit rehearsal restores the captured layout/fields/feeds, clears mock votes,
reaction heat, elapsed time, results and private voter identities, and rotates
the preview sandbox. Reset rehearsal returns to captured preparation; edits made
only in practice are never committed. The preparation state is still a local
mock preview: it does not bind sources, publish, record or activate a live set.
Standalone sets enter and exit rehearsal without a show or dummy participants.

TypeScript, 14 runtime checks and Chrome/WebKit workflow/overlay tests pass.
The production frontend build also passes; the engine remains development-only.

## Verified before opening the UI

- Current native binary built successfully with the installed engine artifact.
- Apple Development signing and strict/deep signature verification pass, using
  the existing certificate/team. The local preview retains camera/microphone
  entitlements and omits system-extension installation, which needs a separate
  provisioning profile with this certificate. It does not install virtual cameras.
- Packaged engine self-test exits successfully: Metal, hardware VideoToolbox,
  no missing engine IDs/errors, and both `producer_source_appearance` and
  `producer_source_placement` registered.
- Vite remains at `http://localhost:1420` for this debug build's frontend.

This is a local development build, not a notarized release or updater artifact.
The copied release bundle's version label does not establish a new release.
The new application UI and real-camera behavior require the checks below.

## Launch and manual check

Close the other Producer on this Mac before opening the preview: the builds share
the local database/recording recovery state and engine browser profile. Closing
it disconnects its room and stops any stream/recording on this Mac. It does not
stop a separate Windows host. Obtain the operator's go-ahead before switching
an active instance.

1. Open a room as a host with a camera source. In Sources, select the camera's
   **Filters** control, add **Source appearance**, then open its settings.
2. Select Circle. Check the real camera output has a centered circular mask,
   retains its aspect, and keeps the existing source placement. Try rectangle
   with rounded corners, outline width/color, black-and-white and opacity.
3. Bypass and re-enable the filter, then remove it. Original video should return;
   camera/device selection, microphone mute and guest admission must not change.
4. Select **Set: After Hours** in the development top bar. In Setup, edit names/topic,
   switch Solo/Conversation and change sample headline/energy. These are isolated
   simulated sources; room output remains the normal source composition.
5. Select Head to Head, prepare fields and click Rehearse. In Run, Start then
   Next. Beside it, use Participation to vote with distinct simulated player IDs,
   react and close voting; reveal from Segment controls. Closing must not reveal, and duplicate
   voters must fail. Stop run must leave rehearsal open with clear stopped status.
6. Close voting, then Reopen voting: counts stay and the same participant cannot
   vote twice. With tied counts, try Start tie-break (new ballot, previous tally
   preserved) and Reveal draw (no winner, Next available). A zero-vote round can
   reopen. Results already revealed cannot reopen.
7. Exit rehearsal during voting or after reveal. Check Prepared returns, practice
   votes/results/timing disappear and the prepared fields return. Rehearse again:
   the same sample player can vote without inheriting the earlier run. Reset
   rehearsal must also restore prepared fields without leaving rehearsal.
8. Check Set controls docked at the side and bottom. Ordinary room controls and
   source editing must remain usable. Enable Studio with Set controls visible,
   then record the workspace if desired. Set controls and rehearsal remain
   usable; capturing operator UI is the creator’s choice.

Do not interpret this rehearsal as a live show or guest/audience interaction
test. Live set source binding, placement lifecycle/fences, real show authority,
phone participation and recording integration remain separate acceptance gates
in [the implementation checkpoint](PRESENTATION-P0-CHECKPOINT.md).

## Boomin chat on the output (2026-10-05)

Room chat now lives in the existing Chat panel, with Boomin alongside Twitch,
Kick, and YouTube. The moderator workspace has the same reader and room-message
controls in its Chat tab. Audience retains access, sharing, video settings,
raised hands, and voting.

The host projects the selected chat channels and authoritative room history into
the native overlay bridge. Boomin snapshots replace room history, so deletion,
room switching, and leaving also remove old messages from output. Native
platform readers retain their separate history and emote feeds. The transparent
Chat browser source uses this combined, filtered snapshot and labels room
messages Boomin. Room text remains literal text.

The rebuilt preview is `src-tauri/target/chat-overlay-preview/Producer.app`.
It uses the existing Apple Development identity and the minimal entitlements in
`scripts/entitlements-preview.plist`; the system-extension installation entitlement
requires a provisioning profile and is intentionally absent from this preview.
Strict/deep signature verification and launch passed. The dev server and preview
were restored after a Mac restart. Manual verification of the actual room canvas
is pending the operator reopening Producer Demo.

Validation: four Rust bridge tests cover native history, filtering, duplicate
room IDs, deletion, room switching and leaving. Chromium/WebKit checks cover the
Chat panel, grant removal, failed-send draft retention, scrolling, compact
composition, transparent output, safe text, Boomin labels, snapshot ordering and
deletions. TypeScript, the frontend production build, and the native build pass.
