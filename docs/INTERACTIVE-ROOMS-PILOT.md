# Hardware-first interactive rooms: pilot checkpoint

Updated October 2, 2026. This checkpoint supersedes the implementation-status descriptions in the earlier architecture review. It does not claim a 100-person video test or a provisioned media relay.

## What is implemented

- Producer keeps composition, processing, and external-network output on the host machine. Audience access can be opened without starting an external RTMP stream.
- Audience and guest program returns share one virtual-camera capture and one native OBS audio tap. Audience audio receives the full processed mix; guest return excludes incoming guest voices, which arrive separately through the stage audio mesh.
- The existing room Durable Object orders moderator cuts, assigns publisher epochs, expires old commands, and confirms the active scene after a native OBS acknowledgment. Immediate scene changes execute as a native batch. Successful permission renewal keeps the existing publisher socket and media connections.
- Publisher registration and the following audience configuration execute in wire order across asynchronous storage work. Closing sockets no longer count as competing publishers. Producer ignores stale ticket completions and old socket callbacks after reconnecting, and starting an already-open link does not open another publisher socket.
- On reconnect, Producer waits for the initial audience snapshot before restoring the publisher's audience settings. This preserves the server's saved access toggle and video budget rather than sending the newly mounted UI's empty defaults.
- Hosted guest acceptance, admission, auto-join, moderator monitor creation, join-link changes, and stage changes use the existing room coordinator. Self-hosted admission checks capacity in the same SQL statement as the write; stage changes use the room coordinator. Optional stage versions reject stale requests.
- Hosted and self-hosted audience doors provide receive-only playback, room chat, reactions, votes, hand raises, private stage invitations, and moderation. Viewer entry does not request camera or microphone access.
- The iOS brand profile opens a native SwiftUI audience screen when the brand's room has enabled audience access. Playback uses native WebRTC/Metal and a playback-only audio device; room chat, votes, reactions, and hand raises use the existing public room API and WebSocket. Stage invitations enter the existing guest flow separately.
- Producer restores saved votes on room entry and reconnect. The newest collecting vote is the audience's active vote; hosts can select older saved votes to close or cancel them. Version checks preserve newer live updates and cancellation tombstones when an older HTTP snapshot arrives.
- Audience, guest, and moderator link buttons use Producer's native clipboard helper, with browser fallbacks and success feedback only after copying succeeds.
- Existing Cloudflare bindings and TURN configuration are reused. This work adds no new Cloudflare product, automatic relay provisioning, or automatic rental charge. Existing TURN and application traffic can still incur usage.

## Capacity and cost boundaries

Room interaction capacity is 100 connected audience identities. Direct video starts at four viewers and has a hard upper bound of eight. Each video viewer still needs an individual peer connection and upload; shared capture does not imply a shared encoder or scalable relay fanout. Guests and moderator monitors consume additional host resources.

The host explicitly enables audience access and chooses the video limit. Reaching the limit leaves chat and votes available and reports the limit to the host. No paid server starts automatically. A future hosted relay offer should appear only when measured hardware/upload limits justify it. Self-hosted installations must never receive Boomin rental upsells.

## Verification completed

- Self-hosted backend: 305 tests across 26 files passed, including concurrent final-slot admission, native command ordering, capacity bounds, duplicate connections, moderation persistence, recipient-only stage invitations, permission renewal, and disconnect recovery.
- Hosted API: 938 tests across 94 files and typechecking passed. [API PR 426](https://github.com/Boomin-Ai/api/pull/426) deployed; [API PR 427](https://github.com/Boomin-Ai/api/pull/427) passed CI and merged. Eight isolated real-database rehearsal checks passed, including concurrent final-slot admission and stale-stage rejection; these used an in-process room coordinator rather than deployed Durable Object concurrency.
- [Web PR 533](https://github.com/Boomin-Ai/web/pull/533) merged and its complete production deployment passed. The complete local web and Producer builds passed.
- Real WebKit media rehearsal: two viewers decoded video and audio from one capture; removing one preserved the other's stream, and removing the last released capture. A two-peer mesh rehearsal verified that stage suspension preserves the microphone sent to the host and that confirmation restores the mesh.
- Real native OBS audio rehearsal: full and guest-return bus routing, volume, and mute passed. This is an audio-engine test, not a complete live guest/headphone test.
- iOS contracts: 32 tests passed, including saved-vote ordering and stale snapshot regressions. The signed native audience build passed and installed on the connected iPhone. A physical-device crash report identified WebRTC's default microphone initialization as the cause of the Watch crash. The replacement audio device creates output nodes only and does not request microphone access. The user confirmed the crash is fixed and that a hand-raise invitation opens the guest page. During the next rehearsal, the user explicitly confirmed native phone audio and hand raising both work. Interruptions and background recovery still need device verification.
- Live production room rehearsal: a real WebKit browser joined the open Producer Demo audience room and decoded 320×180 video. Both video and audio tracks were live, host presence was confirmed, and no page errors occurred. Audible output, phone playback, and full moderation interactions were not verified by this check. Closing the test browser released its viewer connection.
- Publisher startup regressions: reproduced the false `publisher_busy` error on both backends, then verified back-to-back publication/configuration and recovery after closing the previous publisher. A second open publisher is still rejected. The latest suites pass 941 API tests and 307 self-hosted tests. `node scripts/test-room-control.mjs` verifies that delayed ticket completion, repeated start, and stale socket callbacks cannot create or disrupt a publisher connection.
- After the publisher fix deployed, the host reopened Producer Demo and confirmed that `publisher_busy` was gone.
- The user confirmed clear video and audible computer output in the earlier embedded phone audience view. This confirms the publisher's audio route, not the new native audio device's audible output.
- Web PRs [534](https://github.com/Boomin-Ai/web/pull/534) and [535](https://github.com/Boomin-Ai/web/pull/535) merged and deployed successfully. Mobile WebKit checks verify independent viewport scrolling, touch targets, sound toggling, voting, hand raises, and chat. The live public page exposes enabled, correctly hit-tested buttons and the newest saved vote without page errors; unsent/failed actions now have visible feedback.
- A read-only connection to the deployed room accepted two authorization renewals at roughly 105-second intervals without changing publisher ownership. The Producer regression test now verifies three consecutive renewals preserve the same socket and cancel acknowledged renewal timeouts.
- A live playback check decoded 640×360 video continuously until the Mac entered clamshell sleep at 17:46:55 on October 2. Sleep/wake events coincide with the frozen media and subsequent host reconnects. That check was interrupted by system sleep and is not a passing four-minute soak; it does not prove the cause of earlier user-reported disconnects.
- Repeating the live WebKit check with idle sleep temporarily prevented passed: 24 samples over 243 seconds, advancing playback through 239 decoded seconds at 640×360, live audio/video tracks, and no media closures, audience errors, or page errors. The temporary viewer and idle-sleep assertion were released when the check ended. This verifies one awake-host web viewer across the normal renewal interval, not large-room capacity or audible native phone output.
- That reopen exposed a separate client bug: automatic configuration used an empty initial UI state and switched audience access off. The preview now restores settings from the first server snapshot. The corrected desktop build passes; preservation of the toggle through another live reopen remains to be confirmed by the host.
- The invited guest page now routes Producer's `peer:program` return feed to a separate receive-only peer rather than renegotiating the guest's camera/microphone uplink. A Chromium regression uses two real peer connections with generated video/audio and verifies both connections remain connected and program video advances. The web production build passed; [PR 536](https://github.com/Boomin-Ai/web/pull/536) deployed and production commit verification passed in [run 37097108038](https://github.com/Boomin-Ai/web/actions/runs/37097108038). Physical guest return audio and on-air stage behavior remain to be confirmed. The external stream is live, so host disconnect and scene-cut checks are deferred until the host chooses a safe point.

## First live rehearsal

1. Open the updated Producer preview with the hosted backend selected and a named room.
2. In the audience panel, enable audience access. Leave the direct video limit at four.
3. Copy the audience link. Open it on a second device or open the brand profile's audience entry in the updated iOS app.
4. Start watching, then enable sound. Confirm the composed output, host mute, media/music, chat, reactions, and a vote.
5. Raise a hand. Have the host or an authorized moderator send a stage invitation. Only that viewer should receive the private guest link.
6. Exercise an immediate moderator cut. Confirm the dashboard changes its active scene after Producer applies the command.
7. Disconnect and reconnect a viewer, then disconnect the host. Verify media slots recover and an absent host does not leave stale video permissions.

Do not interrupt an existing stream to start this rehearsal without its host's approval.

## Remaining work

- Extend room authority to remaining permission, room-end, and background cleanup mutations. Admission and stage paths are now coordinated or atomic; this does not make every room mutation authoritative or fully fence stale media publishers.
- Move animated transitions onto a native scheduler. Immediate cuts are native; fade/move/stinger scheduling still uses the existing UI paths.
- Add measured upload, encoding pressure, first-frame time, loss, jitter, and relay-use diagnostics before automatically recommending a different media topology.
- Implement and validate an optional media relay adapter, with a bring-your-own endpoint for self-hosted users and an explicitly purchased hosted option. No relay rental is implemented in this pilot.
- Validate phone audio interruptions, app backgrounding, guest headphones/speakers, music, and long sessions with real devices. Raise video limits only after hardware and network soak tests.
- Measure 20/50/100 connected participants before claiming capacity at those loads. Two local decoded video viewers are the currently verified media rehearsal.

## Release tracking

API changes ship through the repository's manual main-branch deploy workflow; web changes ship through its main-branch Pages workflow. The initial API deploy reached production but its final route smoke check mistook closed-room responses for missing audience routes. PR 427 corrects that probe and deployed in [run 37057296006](https://github.com/Boomin-Ai/api/actions/runs/37057296006). The workflow remains red because fixture seeding collided with the existing globally unique demo referral code `pending-entity`; its final checks were consequently skipped. Both route-mount and deployed-API smoke checks were run directly afterward and passed, including all 32 pinned Producer routes. The seed collision remains unresolved; do not describe the release workflow as green.

The running local Producer preview is under `src-tauri/target/interactive-preview/Producer.app`, separate from the installed app. It is ad hoc signed for local development and uses Vite; it is not a distribution release. Confirm deployment and device rehearsal results before treating this as a released desktop build.

[API PR 428](https://github.com/Boomin-Ai/api/pull/428) passed CI, merged, and deployed the publisher startup fix in [run 37059683183](https://github.com/Boomin-Ai/api/actions/runs/37059683183). Worker deployment succeeded; the same demo-fixture collision kept the overall workflow red. Direct post-deployment route and API smoke checks both passed.
