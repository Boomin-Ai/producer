# Native guest prototype results — October 9, 2026

Verdict: native LiveKit transport and software APM execute on Apple Silicon; G0/G1 remains incomplete. Keep broader room integration gated. No production deployment or product transport switch was performed. This is a runnable experiment with recorded evidence, not release acceptance.

The isolated Producer worktree is `/Users/klevelandbishop/Documents/producer-livekit-g1`, branch `prototype/livekit-g1-2026-10-09`, based on `5723335221dfe812cac851e57f610227b16d8c35`. The release/recovery source worktrees and installed Producer app were not replaced. The experiment lives in [labs/guest-rtc](../labs/guest-rtc/README.md).

Later checkpoints below supersede the initial implementation details and timing observations.

## Initial measured results

| Proof | Result | Evidence and limit |
|---|---|---|
| Existing guest return/reconnect checks | 11 passed | [Baseline](../labs/guest-rtc/evidence/baseline.json); mocked lifecycle regressions, not WAN/physical call quality |
| Existing real OBS audio buses | Passed guest exclusion, admission silence, mute, native gain | [OBS evidence](../labs/guest-rtc/evidence/legacy-obs-audio.json); existing debug executable and installed plugins, with audible monitoring disabled; not the new RTC adapter |
| One browser guest ↔ native host | Audio/video passed both directions | [Native receive](../labs/guest-rtc/evidence/transport-1-normal.json), [browser return](../labs/guest-rtc/evidence/transport-1-normal-browser.json) |
| Three browser guests with 200 ms consumer stalls | Audio/video continued; queues stayed bounded | [25 s pressure run](../labs/guest-rtc/evidence/transport-3-pressure.json), [120 s run](../labs/guest-rtc/evidence/transport-3-pressure-120s.json); overflow drops are explicit, not lossless playback |
| Guest disconnect/rejoin | Passed with stable identity and changed publication SIDs | [Rejoin evidence](../labs/guest-rtc/evidence/transport-3-republish.json); retired sinks/queues recorded; not ICE restart, server failover or host reclaim |
| Packaged Apple Silicon WSS | Connected and passed bidirectional transport | [WSS evidence](../labs/guest-rtc/evidence/transport-packaged-wss.json), [TLS validation](../labs/guest-rtc/evidence/tls-validation.json); ad hoc hardened CLI bundle, process-local test CA, certificate validation enabled |
| APM disabled/enabled against identical PCM | Enabled AEC reduces far-only synthetic echo by median 55.94 dB, p10 52.23 dB | [Noise fixture](../labs/guest-rtc/evidence/apm/apm-fixture.json), [speech fixture](../labs/guest-rtc/evidence/apm-speech/apm-fixture.json); final physical speaker-reference wiring unproven |
| Prototype correctness checks | 4 Rust tests and Clippy passed | Bad PCM rejection, queue stall recovery, nonblocking callback contention and separated-marker matching |

The 120-second, three-guest pressure run delivered roughly 11,300–11,400 audio blocks per guest, with audio handoff p95 5.39–5.46 ms and video handoff p95 9.75–10.01 ms. Each guest deliberately lost 414 oldest audio blocks during 23 receiver pauses. Queues hold three 10 ms audio blocks and two video frames; stale-age budgets are 30 ms audio and 50 ms video. Those bounds apply to the application's decoded callback handoff, not every encoder, network or jitter buffer inside the SDK.

At this initial checkpoint, callback flash/click absolute p95 offsets were 32–43 ms in that longer run, but 73–87 ms in an earlier shorter pressure run. Both are retained. The browser paints the flash on its next timer interval, adding up to approximately 33 ms source uncertainty. Raw audio does not provide original capture timestamps, video NTP metadata was zero, and no LiveKit ingest was recorded through OBS. These measurements cannot qualify lip-sync, capture-to-playout latency or long-term drift. Missing/dropped markers must also be considered; a percentile over detected pairs is not a loss metric.

The double-talk waveform check does not qualify intelligibility. With synthesized near speech, enabled AEC's aligned projection gain was 0.352 and correlation 0.463; output/reference RMS ratio was 0.759. Projection gain is not perceived volume. The shaped-noise near signal was suppressed much more strongly. This is evidence that the APM executes and changes samples, plus a reason to test speech carefully; it does not establish that a speakerphone user preserves every word or passes the recognition gate. Processing cost in the speech run was p95 145 µs per 10 ms block, measured offline rather than in a device callback.

## Implementation and ownership

LiveKit Rust 0.9.4, JS 2.22.4, SFU 1.13.9 and explicit `rustls-tls-native-roots` are pinned in the lab. [Build manifest](../labs/guest-rtc/evidence/build-manifest.json) records the lockfiles, resolved libwebrtc/webrtc-sys graph and native archive checksum. A small [vendor patch](../labs/guest-rtc/vendor/README.md) exposes existing native track handles and owned video conversion for custom callback sinks; it does not change the codecs or add audio timestamp semantics. Product adoption should use an upstream supported hook.

The native callback stamps local decoded-delivery time before queueing. It counts sample discontinuities and evicts old backlog. Sinks detach through RAII. Native publication uses exact 10 ms frames with its source queue disabled; teardown aborts the publisher and clears that source. A late unsubscribe only retires its matching publication SID, preserving a replacement track. The initial callback allocated an audio Vec; later checkpoints replace it with fixed arrays and separate ingest. Full real-time suitability remains unqualified.

The lab owns synthetic media and a manual APM instance. It deliberately has no hardware capture/playback owner. The proposed production owner remains a single native audio pipeline that captures the microphone, schedules speaker output, supplies the exact final speaker PCM to APM, then routes processed microphone audio. OBS's audience/stage-return bus is not the AEC reference. Enabling PlatformAudio alongside an independent device owner would require a separate ownership design and is not implemented here.

The fixture's browsers subscribe only to the native host, with return-video muted and return-audio decoded at zero output volume. This does not freeze the final guest subscription mode. Direct conversation audio/video with an optional composed program monitor remains a product candidate requiring latency and synchronization measurements. Self-exclusion, private cue, authoritative admission/grants and host reclaim are not implemented by this lab.

## Baseline source drift

Read-only remote-head checks found Producer and web main match their pinned local source heads. API main is `0961234ef1df03ba3420171027d677ff03511379`, while the existing dirty local API worktree remains at `07991fea`. Its source was not checked out/reset. Later API main already includes:

- Cloudflare TURN credential minting/fallback in `src/services/live/guest-ice.ts`.
- `RoomMutations` serialization of link/stage/admit/accept/revoke/join/monitor operations, landed in `848d928`.
- Atomic nested grant-key updates using `jsonb_set` in `participant-grants.ts`.

These improve the older review baseline. They do not by themselves prove the reviewed full admission/grant/token/expiry/reclaim policy revision and durable outbox contract. G2 should audit the current authority rather than recreate the older implementation.

Cloudflare deployment metadata was read without deploying: API version `803dcc2e-aeb9-4fbb-9b13-2c04192a904a` at 100%, created October 2 at 12:36 UTC. There is no source commit annotation, so this report does not equate remote main with deployed code. TURN binding-name presence is recorded in [baseline evidence](../labs/guest-rtc/evidence/baseline.json); relay behavior was not functionally tested. G0 needs the source-to-deployment mapping and one/three-guest physical legacy baselines before it can close.

## Required next proofs

1. Establish a supported common audio/video presentation timeline through OBS, with original timing semantics, transport-generation resets and marker recordings under asymmetric jitter, scheduler pressure, packet loss/reconnect and extended drift. See [the narrow timing extension investigation](LIVEKIT-G1-AUDIO-TIMING-EXTENSION.md).
2. Wire one actual capture/playback owner and feed APM final speaker PCM. Record enabled/disabled far-only and human double-talk runs; measure word preservation, actual device latency and reference underflow. The offline fixtures cannot pass the physical gate.
3. Execute the same SDK/APM/WSS and restart-cleanup checks in packaged Windows and the actual Tauri/OBS integration. The signed macOS CLI bundle is only a packaging foothold; it has no Developer ID/notarization or release qualification.
4. Freeze guest viewing/subscriptions using measured conversation and composed-preview synchronization. Finish G0 deployment mapping and physical legacy baselines. Only then expand into G2 admission/authorization/private-cue integration.

For the next review, inspect the native callback/queue lifetime, SID replacement behavior, TLS fixture, APM measurement definitions and baseline drift. Treat the recorded pass results narrowly and leave G0/G1 incomplete until the physical/timing requirements are demonstrated. The [original review](LIVEKIT-GUEST-REFACTOR-REVIEW-2026-10-09.md) remains unchanged.

## Packet impairment checkpoint

A verified UDP relay and all-RTP hard-loss control now exercise actual media
impairment. Recorded A/V offset fails the 80 ms gate: 134.02 ms p95 with video-only
jitter and 121.31 ms with audio-only jitter. Repeated rejoin results also vary beyond
the target. Complete per-generation application audio accounting and worker retirement
pass; they do not qualify timing, physical AEC or SDK-wide cleanup. See the
[latest timing evidence](LIVEKIT-G1-AUDIO-TIMING-EXTENSION.md#verified-packet-impairment-and-complete-ingest-accounting)
and [required per-frame playout bridge](LIVEKIT-G1-PLAYOUT-BRIDGE-SPEC.md).
Production remains unchanged, and G0/G1 are incomplete.

## Decoded mixer timing checkpoint

A public custom AudioMixer dependency now exposes decoded RTP/elapsed metadata
without rebuilding the pinned WebRTC archive. Native ownership tests passed
100 cycles; real three-guest rejoin tests destroyed every wrapper. A 90-second
probe and an explicit RRTR feedback experiment both retained invalid frame NTP
estimates. A video-jitter run matched the source SSRC to its guest publication
and confirmed sender reports arrive. The common clock remains unqualified, and
no timing from this probe feeds OBS yet. See the
[updated timing investigation](LIVEKIT-G1-PLAYOUT-BRIDGE-SPEC.md#public-mixer-extension-investigation).

## RTCP exchange checkpoint

Native authenticated RTCP observation confirms the RRTR experiment actually emits
requests: six in the one-guest run and 19 with repeated three-guest rejoin. Neither
run received a DLRR reply. Pinned SFU/Pion sources expose an SSRC routing mismatch
consistent with that observation; a patched server has not been tested. Incoming
sender reports provide RTP/NTP pairs for all six current guest media publications,
offering a public mapping path to test independently of the missing frame estimator.
No map feeds OBS yet and G1 remains incomplete. The
[exchange proof and next mapping requirements](LIVEKIT-G1-PLAYOUT-BRIDGE-SPEC.md#authenticated-rtcp-exchange-proof)
include bounded histories and owner-lifetime limits.

A guarded Rust sender-origin mapper now reconstructs timing from those reports.
A 45-second three-guest/rejoin diagnostic, without RRTR enabled, produced maps for
all six current media publications and origins for all three decoded audio sources.
The original frame NTP estimator stayed invalid. This is end-of-run metadata
reconstruction; per-frame PCM handoff and common OBS scheduling remain unimplemented.
The [live verification](../labs/guest-rtc/evidence/sender-clock-live-verification.json)
and mapper tests preserve that distinction.
