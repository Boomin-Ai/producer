# LiveKit production release status — October 11, 2026

**Not deployed.** GitHub's current stable Producer release is v0.4.69. The native
app and Boomin guest session routes still use the existing guest transport. The
LiveKit work is an isolated native prototype; publishing its branch does not
change users' rooms. No new Apple signing or notarization submission occurred.

The subsequent [session boundary checkpoint](./LIVEKIT-GUEST-SESSION-CONTRACT-2026-10-11.md)
adds an inactive native manifest consumer and an isolated API signer. Actual
Cloud joins confirm three role policies and rejection of the original revoked
monitor token. The signer has no route callers or coordinated durable resolver;
ordinary links, native ownership and program return remain unintegrated. The
G1 startup/reconnect failures below remain release gates.

## What the latest candidate proves

Opt-in Absolute Capture Time (ACT) negotiation works between the tested Chrome
155 browser publishers, actual LiveKit Cloud, and the pinned native receiver.
It uses transceiver header-extension APIs, not SDP text edits or a patched SFU.
Audio and video metadata are observed in decoded native frames. The native
adapter converts capture-system time to publisher NTP time by subtracting the
signed capture-clock offset and interpolating the exact PCM RTP position.
Remixed CSRC sources, wrong SSRCs, missing metadata and distant RTP positions are
rejected. Audio interpolation expires after 200 ms; binding/generation changes
clear it. A capture-clock jump requires another consistent packet. There is no
arrival-time substitute and no mixing of ACT scheduling with sender-report maps.

The candidate remains opt-in. Existing lab/default and application behavior are
unchanged. Cloud room stream synchronization is explicitly disabled for these
ACT trials; the mode is recorded in each conditions file.

| Trial | Scope | First audio/video scheduling | Recording | Acceptance |
| --- | --- | --- | --- | --- |
| `1791760183325409000` | One guest, 35 s; ACT availability only, old SR scheduling | 9.009 / 9.031 s | 13 pairs, 43.333 ms absolute p95 | Failed readiness; confirms metadata availability, not scheduling |
| `1791760736611968000` | Three guests, 60 s, one forced full reconnect; ACT scheduling, audio initially waited for video | Initial 0.658 / 0.691 s; recovery 2.023 / 2.035 s | 28 pairs, 63.333 ms p95; missing label 10 and unpaired label 33 | Failed readiness and marker coverage |
| `1791761280229261000` | Three guests, 35 s; ACT audio starts independently | 0.015 / 1.203 s | 17 pairs, 43.333 ms p95; no missing markers | Passed unchanged short recording gates |
| `1791761403217547000` | Same latest binary, three guests, 60 s, one forced full reconnect | Initial 0.021 / 0.933 s; recovery 1.036 / 1.234 s | 29 pairs, 63.333 ms p95; missing label 10 | Timing and local marker offset gates passed; overall acceptance still failed coverage |
| `1791765809316667000` | Bounded decoder-ingress trace, three guests, 60 s, one forced full reconnect | Initial 0.020 / 0.766 s; recovery 0.959 / 2.144 s | 28 pairs, 63.333 ms p95; missing label 9, final video label 33 unpaired | Failed video recovery budget and coverage; all six video observer weak references expired |
| `1791776477539938000` | Bounded capture finish, three guests, 60 s, one full reconnect; before shared ingest extraction | Initial 0.042 / 0.742 s; recovery 1.061 / 2.004 s | 27 pairs, 90 ms p95; missing video 10/27 and unpaired mid-run video 26 | Finish completed in 117.703 ms; overall failed recovery and marker coverage |
| `1791777427816921000` | Shared native ingest and hardened finish, three guests, 35 s, no reconnect | Initial 0.027 / 0.963 s | 17 pairs, 40 ms p95; no missing video in observed span or unpaired final video; one unmatched startup audio marker | Finish completed in 171.799 ms; readiness/delivery gates passed, overall failed startup marker coverage |

These tests receive three guests but record **only selected guest-1**, using
generated media. They do not prove three-person composition, live capture lip
sync, phone compatibility, five-hour stability or a complete conference AEC path.
The newest full-reconnect trial misses video label 10 before the installed SDK
sinks; the exact source-to-delivery cause is unresolved. Label 26 reached both
native queues but was dropped late. Label 27 reached the sink and kernel but
was rejected for a 421 ms lead, beyond the unchanged 400 ms bound. These are
separate from shutdown. All failed evidence remains retained; the 1.5-second
prototype recovery budget and marker coverage gates were not relaxed.

The decoder-ingress follow-up measures generated 320×180 marker frames before
the application queue, with 256 receipts per sink, nonblocking diagnostic writes,
and no retained frames. Label 9 was absent at both installed guest-1 sinks, with
zero trace overflow/contention. Counts match the input queue's received counts
(336 retired / 1,301 current), so this narrows that gap to before the queue or a
period without an installed sink. It does **not** distinguish network loss from
decoder replacement or prove source packets were delivered. Label 10 reached
the replacement sink with raw capture metadata zero before video scheduling
became ready. Label 33 reached the playback kernel and native video submission,
but had no corresponding selected audio marker receipt before shutdown. Tail
completion and capture-metadata recovery are separate investigations.
The follow-up does not reproduce the earlier candidate's 1.234 s video recovery;
that successful measurement must not be presented as a consistent bound.

The replacement sink in the new full-reconnect trace receives its first decoded
frame 175.245 ms after the final binding; its first capture metadata arrives
980.385 ms later, then video scheduling follows about 1.4 ms after that. The
preceding reconnect/reset time still counts toward the 2.004 s readiness result.
These measurements use the same native clock. They separate decoding from
metadata acquisition; they do not establish a consistent recovery bound.

Capture finish closes new video input first and admits actual decoded audio only
through the last accepted video's presentation horizon, with a 450 ms budget.
Completion now requires a successful audio output enqueue whose 10 ms block
covers that horizon; rejected queues or future blocks cannot claim completion.
No new synthetic PCM is added by this finish step. Existing continuity silence
concealment is separately counted and is not recovered source audio. Output
queues are sealed and drained before worker join and OBS release. The two
numeric runs show successful finish windows and no unpaired final video, but
startup loss and unrelated late/rejected media still prevent full qualification.

The OBS input source now lives in `src-tauri/src/live/guest_ingest.c`; the lab
links that same C implementation, rather than its own source/frame bridge. It
validates plane sizes, odd-dimension chroma, stride limits, PCM channels/counts
and timestamps before calling OBS. The app's opt-in `guest-rtc-pilot` feature
compiles this boundary when an engine is present. **It does not register a source
in ordinary rooms, connect to LiveKit, enable a cohort or change guest links.**
There are no new SDK dependencies in the app, and no integrated Tauri build or
Windows runtime qualification is claimed by the lab linkage tests.

Real OBS checks complete three recording/finish cycles, one active-output
cancellation and one failed initialization. All five guest-source destruction
messages were observed, all five callback probe owners were destroyed, and
threads/file descriptors stay at the warmed baseline (12/14). This proves the
shared boundary's tested Apple Silicon linkage and cleanup, not a production
room's lifetime or conference audio routing. Buffer rejection checks, 83 Rust
tests, Clippy with warnings denied, 17 recording-gate tests and 11 loss-analysis
tests pass. The checkpoint is
`labs/guest-rtc/evidence/native-ingest-shutdown-checkpoint.json`.

Next product deliverable: an authenticated native-room pilot with stable guest
source IDs, normal guest links, program return and the conference speaker
reference. The G1 recovery/startup failures remain explicit gates on activation.
Production migration and Apple release follow the remaining device, control,
soak and rollback gates below.

All owned Cloud trial rooms were deleted successfully. No physical devices or
audible playback were used. Server credentials stayed server-side; retained
numeric evidence was checked for the actual API credentials. The evidence index
`labs/guest-rtc/evidence/native-capture-clock-checkpoint.json` pins numeric inputs,
binary hashes, source hashes and each trial's scope.

## What still prevents a production migration

1. **G1 qualification:** resolve/measure recording loss through recovery;
   qualify all guest outputs, actual speaker-reference routing in the conference,
   supported guest browsers/devices, WAN impairment and packaged native builds.
   Chrome's experimental public header negotiation is not a Safari/Firefox proof.
2. **G2 admission/control:** implement the versioned transport manifest, backend
   token issuance, producer fencing and coordinated admission/grant/stage changes;
   prove revoke/replay/concurrency and private-cue isolation. The API has no
   LiveKit session integration or deployment bindings yet.
3. **G3 native room integration:** replace the runtime transport attached to
   stable guest source IDs; connect program return and owned audio processing;
   retain sets, filters, transforms, faders and recording behavior across exits,
   scene changes and republish. The app has no LiveKit adapter yet.
4. **G4–G6 rollout:** complete supported device/network/load/soak coverage, then
   deploy a fenced pilot cohort with legacy compatibility and rollback; build,
   sign/notarize and publish the actual integrated native release.

The reviewed [implementation plan](./LIVEKIT-GUEST-REFACTOR-PLAN.md) and
[review](./LIVEKIT-GUEST-REFACTOR-REVIEW-2026-10-09.md) remain the release contract.
The short ACT pass does not mark those gates complete.

Validation at this checkpoint: 77 native Rust tests and Clippy with warnings
denied (`obs-proof,physical-aec`), 16 recording-gate tests, nine loss-analysis
tests, two credential-profile tests, and 100 native lifecycle cycles. All 201
mixer source wrappers and 200 event logs were destroyed; threads stayed 1→1 and
file descriptors 4→4. Capture metadata adds no retained media owners, threads or
observers; transceiver references are temporary and mixer state keeps its weak
registry backlink.

Decoder-ingress follow-up: 79 native tests, Clippy with warnings denied, and 11
loss-analysis tests pass. The three-guest reconnect workload created and retired
six video sinks; all six observer weak references expired after room shutdown.
The new trace owns numeric receipts only; the strong ownership remains
track → registered sink → observer, with explicit sink removal at retirement.
Its evidence and source hashes are in
`labs/guest-rtc/evidence/native-decoder-ingress-checkpoint.json`. The earlier
capture-clock checkpoint describes its pinned parent commit, not these new
diagnostic sources. The Cloud room was deleted successfully; no production room
or physical device was used.
