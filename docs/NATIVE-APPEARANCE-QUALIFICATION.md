# Native outgoing appearance candidate

This is an opt-in development candidate. The default program appearance still
uses the existing virtual-camera/canvas bridge. A compile, unit, or browser
pass does not qualify an actual Mac/Windows media session or a latency gain.

Enable `PRODUCER_NATIVE_APPEARANCE=1` in the **native process environment** of a
matching `guest-rtc-production` build. A Vite variable alone cannot enable it.
Use the established isolated development bundle, profile and frontend together;
do not launch another application against that profile or replace a running
show. Follow `MACOS-BUILDS.md` for the complete engine and signing requirements.
No updater/release channel is changed by this candidate.

## Ownership and media

The outgoing guest uses an independent, server-issued guest connection. It
does not borrow the local room's Producer identity, host lease or credentials.
Guest admission, current grants, stage state, provider, run, authorization
generation, connection tickets and narrow subscription permissions still gate
publication. Same-revision recipient expiry changes the subscription body.

The engine validates the local room ID established by successful restoration.
Joining from a running room attaches to that same controller; it does not
restore a room, swap the scene, or stop the local host roster/heartbeat. A
different room or an unknown/unready retained controller is rejected.

Host absence expires the old publication, not the appearance owner. Recovery
joins the old workers before requesting a session bound to the newly authorized
host run/epoch. Old credentials are never replayed into that new run. Genuine
retirement failures keep the owner quarantined; a repeated Stop cannot turn a
failed cleanup into a successful empty-slot receipt.

The room cards retain explicit Return/Leave controls for a collapsed appearance.
Pending or failed retirement continues to block another appearance. A successful
exact-owner stop clears that guard; terminal media errors alone do not. Initial
room readiness remains required, while later Set readiness changes keep the same
native owner. Live-room, deal and manual entry actions check this ownership
before issuing a new knock, which can replace the current guest credential.

Entry rejections preserve their machine-readable server code in bounded local
diagnostics. Lost/uncertain responses replay the same request ID. A definitively
invalid receipt is retired for a later manual action; there is no automatic
reknock and no change to server admission, revocation or native host-lease checks.

Native video follows the selected room-only landscape or portrait output to a
bounded raw-frame tap and the native LiveKit publisher. A single unmirrored
room-only view is shared by appearances, independent of Studio and Virtual
Camera ownership. The Set package and executable scene stay on the sender.
There are still frame copies, color conversion and a separate RTC encoder.
This is not zero-copy or reuse of the stream's compressed encoder output.

The UI candidate selects 720p30 (1280x720 or 720x1280). The native profile also
validates 1080p30; it is not exposed as a qualified user setting. Source cadence,
hardware and network conditions can reduce delivered quality. Queue age,
timestamp regression, late frames and expiry fail closed. The inherited native
publication scheduler's 400 ms lead is still present; an end-to-end latency
improvement is unproven and must be measured rather than inferred from the
removed browser round trip.

Outgoing audio is the processed local mix-minus bus. Received local guests are
excluded. Multi-room guest relaying therefore needs a separate routing design;
this candidate does not forward everyone else's microphones automatically.

Incoming host return and eligible staged-peer audio use private monitor-only
sources, excluded from the outgoing buses and room scene. Monitoring starts
disabled and requires an explicit action. The UI confirms control
acknowledgement plus recent decoded audio, not physical speaker audibility.
Return video currently has a labelled, bounded JPEG preview, offered at up to
5 fps natively and polled at up to 2 fps by the UI. That is a local preview
limit, separate from the outgoing 720p30 contribution. A full-frame-rate native
return display remains required before promoting this as a complete replacement.

Each capture target has an engine-owned, generation-specific lease. Delayed
release or rejected duplicate requests cannot retire a newer owner. The actual
OBS output destroy callback retains frame userdata and the mix lease even if
an external OBS reference delays destruction. Shutdown waits for outstanding
leases. Appearance leave/mute/stop affects only its own publisher and monitors.
Video format/orientation or full-room restoration is refused while that target
is leased; ordinary scene and Set content edits remain available.

The shared PCM receiver broker is explicitly selected only by this opt-in
candidate. Default `Receiver::new` retains exclusive ownership and fresh
receive-epoch behavior. Shared mode has one SDK PCM drain, bounded owners and
global SSRC uniqueness/retirement quarantine. Unsupported or ambiguous bindings
are not delivered. Reconnection with retained/reused SSRCs is a qualification
case, not an assumed recovery pass.

## Automated checks

- `make setup` and `make check`: complete pinned engine, production guest
  feature, frontend build and native compilation.
- `bun run test:native-appearances`: actual outgoing adapter and GuestSeat
  admission, initial mute, controls, failure, cancellation and cleanup.
- `bun run test:appearance-room-browser`: actual Home lifecycle with a
  media-controller stub; verifies no remount on live join, settings, collapse,
  preview retirement or appearance leave.
- `node scripts/test-return-audio-browser.mjs`: actual React legacy and native
  monitoring controls with simulated media/IPC. No hardware audibility proof.
- Rust authority, profile, capture queue/lifetime, receiver isolation and lease
  policy tests. Native test compilation is distinct from executing those tests.
- Recovery policy and supervised-retirement tests cover expected lease expiry,
  sticky cleanup failure, canceled waiters, stale Stop IDs and new host epochs.
  Browser cases also cover collapsed exit, pending/failed stop, fresh retry,
  readiness changes and rejected entry actions producing no network knock.

## Paired acceptance before default enablement

Record native/frontend SHA, executable and engine identity, native features,
optimization profile, OS/architecture and the same workload on both devices.
Do not compare a stopped room against an active scene or call host downtime
network latency. Use the normal connection/admission UI with output explicitly
idle before bounded test tones. Use a disposable local stream sink for live
attachment testing unless the user deliberately authorizes a public broadcast.

1. Cold and warm Mac-to-Windows contribution, both orientations: moving camera,
   fine text, Set animation and a known sound. Verify actual receiver dimensions,
   decoded/presented frame cadence and recorded detail.
2. Repeat Windows-to-Mac. Intel is a separate real-device qualification.
3. Start recording, streaming, and both, then join using the **same** running
   room. Local files/stream must continue with the same graph, clock and audio.
   Wrong-room attachment must fail without changing any existing output.
4. Leave/rejoin, collapse/reopen, settings shortcuts, host room restart and
   network interruption. Verify fresh pixels/audio and no manual source rebind.
5. Initial waiting-room mute/camera-off, rapid controls, revoke and peer expiry:
   muted audio absent from the receiver recording, camera-off black rather
   than a retained old frame, and no stale controls affecting a replacement.
6. Host and staged-peer return monitoring: explicit enable, physical audibility,
   no feedback into outgoing program, no backstage/private participant audio,
   and no contribution to local recording/stream mixes.
7. Matched direct LiveKit, compatibility bridge and native appearance baselines:
   source-to-presented-frame/speaker timing with a shared clock or bounded clock
   alignment, plus CPU, memory, render/encode/decode load, drops and queue age.
8. Long session and repeated recovery/teardown: no receiver/capture/source leak,
   no SDK drain competition and no impact on local guests. Keep the older path
   available until this matrix passes and the return display is complete.
