# Hosted Producer guest infrastructure audit — 2026-10-09

## Verified deployment and scope

Read-only audit of Producer's hosted guest path, Boomin web and Boomin API. No live rooms or guest admissions were created and no infrastructure configuration was changed.

- Production web `/version.json`: `75630c1039ccdb87aebdb8845c30e40525d1ebc8`, matching the inspected web checkout.
- Production API Worker: `boomin-api`, active deployment `ae65e98e-7506-4749-b6e6-7a05cd0a7fdd`, deployed 2026-10-05, version `1dc968bd-b1aa-4488-9d03-7a77a6f84abb` at 100%.
- Read the deployed version's bindings and secret names without disclosing values: no `ICE_SERVERS` binding/secret is configured. Repository defaults supply public Cloudflare and Google STUN. No configured TURN relay in the audited Producer guest path.
- API checkout contains unrelated uncommitted content/Manager work, untouched by this audit. No live packet capture, forced-relay connection or WAN recovery experiment was performed.

## Terms

WebRTC is the browser media/data transport stack. ICE selects a usable network path. STUN discovers a public-facing address and does not relay media. TURN relays media when a direct path cannot be established. An SFU receives published media and forwards selected tracks to subscribers. These are complementary layers, not competing names for the same thing.

## Producer guest flow

1. producer.dev serves the guest web shell and room assets through its proxy to Boomin's dedicated room bundle. API calls go to `https://api.boomin.ai/v1/connect`.
2. Guest invitation/admission is represented by API database rows and participant grants. An admitted guest exchanges its invite code for a session; the host's render page uses its render key.
3. Session responses provide `ice_servers` and short-lived signaling tickets. Tickets expire after 120 seconds; established media is independent of the ticket's expiry.
4. Each guest's signaling WebSocket reaches a Cloudflare RealtimeHub Durable Object named `guest:<guestId>`. It forwards SDP, ICE and control messages; it is not an audio/video relay or SFU.
5. Camera/microphone media flows from guest browser to a dedicated host CEF/browser-source page. libobs captures that page's pixels and audio and composites the production. Separate sources provide independent framing and mixer control.
6. Current native Producer creates a separate `program` return peer for guests allowed to receive it. SharedProgramCapture captures the virtual camera/native program and processed audio; MonitorSender attaches those tracks to each guest's return connection. Capturing once does not mean the network transmission is shared: each connection still sends its own media stream.
7. Guest-to-guest conversation is an audio mesh, separate from guest camera/video and program return. A second room-session endpoint and room Durable Object introduce peers. Stage/audibility/mute state gates audio publication and reception.

## STUN / TURN findings

`boomin/api/src/services/live/guests.ts` defaults to:

- `stun:stun.cloudflare.com:3478`
- `stun:stun.l.google.com:19302`

`ICE_SERVERS` can override host/guest session ICE configuration. The active production Worker has no override. There is no per-session TURN credential minting in this audited guest service.

Important propagation gap: `POST /guest/:code/room-session` does not include `ice_servers`. GuestConversation therefore uses its hardcoded STUN fallback for the audio mesh, independently of the main session's configuration. Adding TURN only to the main session would leave guest-to-guest audio without that relay. Existing meshes also lack an ICE configuration refresh when room tickets renew.

A STUN-only direct call can work well on one network and fail on another. Successful tests on the host's Wi-Fi do not establish restrictive-network or mobile-carrier reliability. Which problem caused an individual past guest failure cannot be determined from this configuration alone.

## Two different media architectures exist

Producer's hosted `/connect/guest/...` pages use the custom direct-WebRTC transport above.

Boomin's separate browser studio uses Cloudflare RealtimeKit: LiveRoomHost initializes a meeting from an API auth token; LiveGuestPage uses the RealtimeKit client/provider. Production configuration declares a RealtimeKit app. This SFU-backed browser-studio path is not automatically used by Producer's native guest invite/render path. The Durable Object binding named REALTIME is the signaling hub, not evidence of SFU media routing.

## Recovery and monitoring already implemented

- HostLink reconnects lost signaling sockets with fresh sessions and bounded backoff, preserves media tracks, refreshes ICE configuration, and avoids replaying stale SDP answers.
- GuestConversation reconnects the room signaling socket and renews tickets at 90 seconds while retaining the mesh.
- ICE restarts exist on failed browser peer connections. Host render and native return senders also rebuild connections on failed/closed peers or lost signaling.
- GuestRoomPage reacquires ended camera/mic tracks when returning to the foreground and refreshes host senders and mesh microphones.
- Host render quality polling runs every five seconds. It reports packet-loss deltas, jitter, FPS and decoded-frame progress, and marks a stalled guest video as failing.
- ProgramRequest checks returned-video decoding while requesting startup. Native return sender logs initial outbound frame/byte stats.
- Stage confirmation, receiver-side audio enforcement, microphone mute propagation and self-echo avoidance are substantive existing features.

Correction to the earlier discussion: incoming guest freeze detection already exists. The gaps are sustained return-feed monitoring, uniform recovery and operational measurements, not an absence of all media-health checks. The current mesh is audio, not a full video mesh.

## Concrete remaining weaknesses

1. No configured TURN relay for Producer guest media in production.
2. ICE configuration omitted from room-session responses; meshes cannot pick up a future TURN override or refreshed credentials.
3. Browser guest peers mostly call restartIce on failure without a bounded escalation to peer reconstruction. Recovery differs among browser join pages, host render pages, native seats and program senders.
4. ProgramRequest stops polling after successful decoding. Subsequent return-video freezes do not trigger that startup watchdog.
5. GuestRoomPage has foreground track reacquisition; GuestJoinPage lacks equivalent visibility recovery. Both entry paths should share a lifecycle policy.
6. RealtimeHub can answer ping, but HostLink and GuestConversation do not use an application heartbeat/deadline. A socket that never promptly closes can leave recovery waiting.
7. Session-renewal fetches lack an explicit abort deadline in these browser transports.
8. GuestMesh retains previously created peer connections until the whole mesh closes. Demotion changes transceiver direction; long rooms with participant churn need explicit departed-peer lifecycle tests/cleanup.
9. Existing host quality reports are useful, but are not fleet-wide join/recovery SLOs or a complete view of selected ICE path, RTT, return-feed health and incident causes.
10. Last release's real-browser recovery proof used real media peers with simulated signaling. It was not a WAN/TURN/mobile-network soak test.

## Scaling implication

For N guests who are all on stage, the microphone mesh creates N(N−1)/2 pairwise audio connections, plus roughly N guest-to-host media links and N separate host-to-guest program links in the current native design. Additional monitors, screen sharing and retained inactive peers add more.

- Four guests: six audio-mesh pairs plus roughly eight host links.
- Eight guests: twenty-eight audio-mesh pairs plus roughly sixteen host links; each guest may hold two host connections and seven guest-audio connections.

These are topology counts, not measured capacity limits. Host upload, per-guest return encoding, CEF decoding/compositing, mobile resources and network quality determine the actual usable room size. Shared program capture reduces capture duplication but does not eliminate per-recipient transmission.

## Recommended order

1. Add a managed TURN fallback with short-lived credentials and route it consistently to host, guest, program and audio-mesh peers. Validate forced relay, blocked UDP and TLS/443 paths.
2. Share bounded connection/track recovery across guest entry points; distinguish media failure from signaling failure and permission/capture interruption.
3. Extend sustained program-return health checks and collect selected candidate/path, join time, first media, freezes and recovery timing without logging credentials.
4. Run a real-device/network matrix: Safari/iPhone, Android/Chrome, desktop, Wi-Fi/cellular switching, locks/backgrounding, restrictive networks and long sessions with guest churn.
5. Compare the measured four/eight-guest native path against an SFU prototype. Existing RealtimeKit is a potential reuse opportunity, not proof the native path can switch without host-ingest and stage-control integration work.

## Source map

- Producer: `site/_worker.js`, `src/views/Live.tsx`, `src/lib/programCapture.ts`, `src/lib/monitorFeed.ts`, `src/lib/guestSeat.ts`, `src-tauri/src/live/graph.rs`.
- Boomin web: `src/lib/hostLink.ts`, `src/lib/guestConversation.ts`, `src/lib/guestMesh.ts`, `src/lib/guestReturnFeed.ts`, `src/lib/programReceiver.ts`, `src/pages/connect/GuestJoinPage.tsx`, `src/pages/connect/GuestRoomPage.tsx`, `src/pages/connect/GuestRenderPage.tsx`, `src/components/live/LiveRoomHost.tsx`, `src/pages/live/LiveGuestPage.tsx`.
- Boomin API: `src/services/live/guests.ts`, `src/routes/app/live-guests.ts`, `src/realtime/hub.ts`, `src/services/live/realtimekit.ts`, `wrangler.toml`.
