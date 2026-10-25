# Required native decoded-media timing bridge

Status: proposed next implementation; not present in the released Rust SDK or
qualified by the current local render/sample-clock lab.

Verified packet-level asymmetry now fails the G1 recorded-marker target in both
directions: video-only delay/loss produced 134.02 ms absolute p95; audio-only
produced 121.31 ms. Matching stream groups, bounded queues and sample progression
alone therefore do not qualify this SDK-to-OBS adapter. These are short lab runs,
not evidence that the LiveKit SFU itself lacks synchronization capabilities.

## Timing contract

A decoded audio block must retain its source RTP sample origin through NetEq,
including concealment/time stretching. A callback sample counter measures the
application stream, not the original RTP timeline. Callback arrival time must
remain a distinct observation rather than becoming source time. Each block needs:

- Publication/receiver generation and synchronization-group identity.
- Output PCM rate, channels, sample count, and original RTP timestamp/clock rate.
- Validity of that RTP origin for concealment, startup, resampling and reset.
- Sender-report-derived NTP mapping and its validity/age, when available.
- Receiver playout clock/deadline, with explicit units and clock domain.
- Resampling/remix delay and sample-origin mapping, or an explicit unqualified flag.

Video must use the corresponding RTP/sender-report mapping and local render
schedule. The current public video frame supplies local timestamp_us and RTP
metadata; its zero NTP field cannot establish a sender map by itself. Never combine
zero/missing metadata with valid timestamps. Bind camera/mic within one explicit
sync group; screen-share audio/video and self-excluded program return may need
separate groups. Reset maps on new publication generation or clock discontinuity.

## Pinned upstream extension point

In WebRTC 89d790b, `audio/channel_receive.cc` obtains decoded AudioFrame PCM and
`timestamp_` from NetEq. It currently invokes the raw audio sink before computing
the AudioFrame NTP estimate. The later NTP estimator requires RTCP sender reports
to become valid. `pc/remote_audio_source.cc` then deliberately passes no absolute
capture timestamp into AudioTrack sinks. Reusing that optional field to smuggle RTP
or presentation time would violate its contract.

A narrow bridge must preserve decoded timing after origin/NTP calculation and
before the track fan-out discards it. The current raw PCM callback cannot do this
through another five/six-argument wrapper. A supported custom audio mixer offers
an additional extension point: wrapping AudioMixer::Source::GetAudioFrameWithInfo
allows inspection after ChannelReceive returns the populated AudioFrame. The lab
now probes that public factory dependency without rebuilding the native archive.
A receiver hook/rebuilt fork remains an alternative if the mixer path cannot
preserve the required per-publication PCM and clock semantics. Any source hook must preserve upstream
mixing/volume/APM order and remain nonblocking. Ownership must avoid receiver →
callback → receiver strong cycles, with deterministic unregister and destruction
proof across partial initialization, cancellation and repeated rejoin.

Primary sources:

- [Decoded audio and RTP/NTP computation](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/audio/channel_receive.cc)
- [Remote AudioTrack timing boundary](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/pc/remote_audio_source.cc)
- [Native video render scheduling](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/video/video_receive_stream2.cc)

## OBS presentation adapter

Use one explicit map from the validated receiver clock to OBS monotonic time.
Choose a bounded playout budget per synchronized group. Schedule video against
that clock and place PCM into the same group timeline, preserving sample gaps as
counted silence/discontinuities instead of shifting later speech backward. Bound
pending audio samples and video frames; report late/drop/underrun and clock reset
counters across every transport generation. Never solve a lost timestamp by
silently extending an unlimited queue or increasing latency without measurement.

The dedicated audio worker already removes video conversion from PCM drain and
records per-generation drops. It still uses arrival/sample progression, so this
bridge is required before describing its output as synchronized under jitter.
Fixed delays or periodic get_stats snapshots are diagnostics, not per-frame clock
origin proof. Larger common playout delays can be evaluated as explicit experiments,
but must also meet measured interaction latency and recovery requirements.

## Required evidence before integration

Use the existing packet relay baseline and hard-loss controls. Record both video-
and audio-only delay/loss profiles, then combine jitter, burst loss, consumer stalls,
track rejoin and a longer drift run. Preserve packet drop/delay counters, receiver
loss/concealment, raw marker detections, source uncertainty and every generation's
queue/clock totals. RTP impairment must remain independently verified; the prior
CDP acknowledgement did not suffice.

The current marker criterion is absolute A/V p95 ≤80 ms, with unmatched markers
reported separately; it does not cover intelligibility, end-to-end interaction
latency, physical speakerphone AEC or all-device compatibility. The next bridge
must prove these timing results before G1 or production migration can pass. If the
native hook cannot be supported/packaged within the project constraints, compare
another supported native media path using exactly this recording/impairment fixture.

## Public mixer extension investigation

The pinned PeerConnectionFactoryDependencies exposes `audio_mixer`. A wrapper can
delegate AddSource/RemoveSource/Mix to AudioMixerImpl and inspect each source's
GetAudioFrameWithInfo result. This runs after ChannelReceive computes frame RTP,
elapsed-time and estimated NTP metadata; it avoids changing the AudioTrack optional
absolute-capture-time contract. The lab's optional `LIVEKIT_LAB_TIMED_MIXER=1` probe
records bounded per-generation observations and leaves the underlying PCM/mix path
unchanged. It is diagnostic only: no PCM from this path feeds OBS yet, and pull
observation time is not claimed to be a speaker presentation deadline.

The existing native library is sufficient to compile and link this extension.
A standalone native workload runs 100 initialize/use/remove/drop cycles, rejects
null/duplicate source registration, excludes failed audio frames and checks
concurrent pull/removal plus destruction without explicit removal. It observes
200 wrapper destructions, zero remaining wrappers and expiration of weak state.
These are mixer-wrapper ownership proofs; they do not qualify the SDK's entire
factory/device lifecycle. The existing original source remains borrowed under
WebRTC's AudioMixer AddSource/RemoveSource lifetime contract.

Strong-reference graph: factory → mixer → wrapper → observation state; mixer →
delegate → borrowed wrapper; wrapper → borrowed original source. The polling
registry holds only a weak reference to observation state. RemoveSource unlinks
the delegate before deleting the wrapper. Mixer destruction performs the same
unlink for remaining sources. No observer registration, native thread or file
descriptor is added by the probe. Mixing and registration are serialized; frame
observations use try-lock and count contention rather than block on polling.
The observer retains at most 64 generation records and reports capacity exhaustion.
Its single weak polling registry is a lab-only single-factory facility.

Remaining work: validate the live source-to-publication SSRC association; preserve
PCM plus metadata in a bounded per-generation handoff; derive a validated common
audio/video presentation map; handle concealment/resampling/reset semantics; and
rerun recorded jitter/speech/latency qualification. A positive NTP field alone does
not prove its age, clock-map stability or synchronization with the video path.

Sources: [factory mixer dependency](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/api/peer_connection_interface.h),
[AudioMixer source contract](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/api/audio/audio_mixer.h).

### Live observations

A three-guest / three-rejoin run observed six source generations, all inactive and
destroyed after room close. A 90-second single-guest run observed 8,682 decoded
frames at 48 kHz, 480 samples per channel, stereo, with RTP/elapsed timing and
4,340 frames carrying packet information. Neither run observed a positive frame
NTP estimate: the final value remained -1. Callback PCM in the existing track sink
remains mono after its own remix/resample; a future mixer PCM bridge must preserve
that conversion and account for its timing rather than assume identical buffers.
No observation contention or record capacity exhaustion occurred in these runs.

The pinned ChannelReceive updates its remote NTP estimator only after LastRtt and
a sender report are both available. The missing estimate is consistent with an
unmet prerequisite, but the current probe does not identify which prerequisite
is absent. Even a nonzero estimated playout timestamp in get_stats does not prove
the AudioFrame NTP estimator is valid; these are distinct timing paths. Preserve
optional field presence before interpreting default-zero RTT/report diagnostics.
Next qualification needs an explicit, validated common mapping and its age/validity
for both media streams; using per-source elapsed time alone cannot align streams
that started independently.

Evidence: [native lifecycle checks](../labs/guest-rtc/evidence/timed-mixer-lifecycle.json),
[live rejoin observations](../labs/guest-rtc/evidence/transport-timed-mixer-churn.json),
[90-second observations](../labs/guest-rtc/evidence/transport-timed-mixer-90s.json).
Estimator prerequisites: [pinned ChannelReceive](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/audio/channel_receive.cc).

The video-jitter probe also matched its mixer source SSRC to guest-1's audio
publication in native inbound stats. It observed 2,166 decoded frames and seven
audio sender reports in the receiver's remote-outbound stats, yet no valid frame
NTP. RTT fields defaulted to zero with zero measurements; optional presence is
not preserved by the current stats wrapper, so these zeros are not proof of a
valid zero RTT. This narrows the investigation to receiver clock/RTT prerequisites
rather than assuming sender reports never arrive.

An explicit `LIVEKIT_LAB_RRTR=1` experiment augments audio feedback in the native
local and remote SDP copies to activate receiver-reference-time reporting. The
pinned SFU responds to RRTR with DLRR. This is a controlled local interoperability
experiment, not a production capability-negotiation implementation: the SDK's
signaling payload is not rewritten, and other SFUs/endpoints are unqualified.
Video SDP stays unchanged; the rewrite is idempotent. No extra observer, callback
ownership or thread is added. Its result must be measured before relying on the
estimator or designing the final negotiation path.

Source: [pinned LiveKit SFU XR handling](https://raw.githubusercontent.com/livekit/livekit/v1.13.9/pkg/sfu/downtrack.go).

The 40-second RRTR experiment with three guests and three rejoins observed 8,913
decoded frames across six generations, all destroyed after close, but zero valid
frame NTP estimates and zero reported RTT measurements. The request flag confirms
the experiment was selected; it does not independently prove XR emission/reception
or effective codec-feedback negotiation. This experiment is not a successful
clock-mapping fix and does not rule out a properly negotiated RRTR path. Verify
actual XR exchange and preserve stats optional-field presence before changing
receiver mapping semantics.

[Live probe verification](../labs/guest-rtc/evidence/timed-mixer-verification.json)
retains every run's frame counts, lifetime result and the observed source-to-track
association. Production and the OBS presentation adapter remain unchanged.

## Authenticated RTCP exchange proof

The opt-in `LIVEKIT_LAB_RTCP_PROBE=1` factory event-log wrapper now observes
authenticated/decrypted incoming RTCP and outgoing pre-SRTCP RTCP at the native
engine boundary. It forwards every event to the original logger, retains no raw
packet or media payload, and stores bounded clock/SSRC observations. The existing
`peers` JSON field actually identifies event-log instances: one factory log can
cover multiple PeerConnections. It is not evidence of independent peer clocks.

The baseline observed zero outgoing RRTR requests. Enabling the native RRTR SDP
experiment produced six outgoing requests in 30 seconds, yet zero incoming DLRR
replies. A 40-second three-guest/three-rejoin run produced 19 outgoing requests and
zero replies. Incoming SFU RRTR requests and outgoing native DLRR replies were
visible in both directions, so the observer can recognize each block type. The
relay forwarded control traffic without configured delay/loss, queue overflow or
send errors. Native outgoing events prove engine emission; the observer does not
independently prove delivery inside the SFU's authenticated packet handler.

The source-supported routing hypothesis is precise: outgoing RRTR uses a native
reporter SSRC, distinct from all current downtrack media SSRCs. Pion RTCP v1.2.19
ExtendedReport.DestinationSSRC includes its SenderSSRC; an RRTR block itself adds
no target SSRC. Pion SRTCP v3.0.13 demultiplexes individual RTCP packets using that
destination list. LiveKit v1.13.9 binds each downtrack's RTCP callback to its media
SSRC. Thus an RRTR addressed only by the native reporter SSRC can miss the
downtrack callback containing the DLRR response logic, even when it accompanies
a ReceiverReport addressed to media SSRCs. This matches the observed absence of
replies, but a patched SFU was not executed and the exact deployed handler path
is not instrumented. Treat it as a strong interoperability lead, not a completed
provider fix. The current machine has no Go toolchain and limited SSD headroom;
no full SFU dependency build was started.

The factory log remains alive after room close because the native factory/
Environment outlives individual rooms. All six mixer sources retired in the live
rejoin test. The standalone ownership workload destroys 200 log observers and
200 source wrappers over 100 cycles, expires both weak registries, and returns
thread/FD counts to their initial 1/4 values. These are explicit owner-lifetime
proofs; they do not establish SDK-wide shutdown or a production device lifecycle.

### Sender-report mapping path

The probe also records authenticated incoming SenderReport NTP/RTP pairs without
copying packet payloads. The three-guest run retained at least two reports for
each of six current audio/video publications. Inferred audio clocks were
47,949.52–48,047.14 Hz and video clocks 89,992.23–90,000.43 Hz, near the fixture's
48 kHz Opus / 90 kHz video rates. These are short report-pair observations; their
small variation and report age must remain visible rather than be treated as an
exact or stable map. The native frame NTP estimator remained invalid.

This provides another public extension route: map decoded frame RTP origins via
authenticated sender reports, then choose one bounded common OBS presentation
clock per validated synchronization group. Relative audio/video alignment does
not require claiming an absolute one-way network delay or an RTT-derived local
wall-clock offset. It still requires per-frame PCM timing, valid SSRC/generation
association, report age/slope bounds, concealment/resampling semantics, startup
policy before two reports, clock resets and recorded latency/drift tests. Sender
report availability alone cannot pass G1. No sender-report map feeds OBS yet.

Evidence: [RTCP exchange and report-map verification](../labs/guest-rtc/evidence/rtcp-exchange-verification.json),
[native observer lifecycle](../labs/guest-rtc/evidence/rtcp-probe-lifecycle.json).

Pinned primary routing sources:

- [Pion XR destinations](https://raw.githubusercontent.com/pion/rtcp/v1.2.19/extended_report.go)
- [Pion SRTCP per-packet routing](https://raw.githubusercontent.com/pion/srtp/v3.0.13/session_srtcp.go)
- [LiveKit downtrack callback binding and XR responder](https://raw.githubusercontent.com/livekit/livekit/v1.13.9/pkg/sfu/downtrack.go)
- [LiveKit RTCP buffer callback](https://raw.githubusercontent.com/livekit/livekit/v1.13.9/pkg/sfu/buffer/rtcpreader.go)

### Guarded sender-origin mapper implemented

The lab now includes a Rust diagnostic mapper using the retained authenticated
report pairs. It operates in the remote sender-report NTP domain and establishes
no local clock offset. It fits two report pairs, validates their RTP slope within
a provisional 1% of the fixture's declared clock rate, rejects zero NTP seconds/
wrong SSRCs, and requires fresh reports within 10 seconds. Backward or implausible
clock changes discard the fitted pair and require a fresh pair. Duplicate reports
do not refresh age. RTP wrap uses signed modular distance with a 10-second
extrapolation bound; report intervals over 60 seconds invalidate the pair. These
are explicit diagnostic budgets, not final production tolerances.

Tests cover RTP wrap and frames preceding the latest report, stale/future reports,
duplicate freshness, excessive extrapolation, source mismatch and discontinuity
recovery. A new mapper instance cannot reuse a previous publication's map.

In a 45-second three-guest/three-rejoin session without the RRTR experiment, all
six current publications had a two-report map and all three current decoded audio
sources produced reconstructed sender-NTP origins. All six source wrappers were
destroyed. The original AudioFrame NTP estimator remained invalid, demonstrating
that this diagnostic reconstruction does not depend on that estimator becoming
valid. It is evaluated after the run using retained observations; no per-frame
PCM, video scheduling or common local presentation clock was added. An origin
for a concealed/stretched decoded frame is not a claim of original capture time.
The next bridge must preserve those semantics and qualify actual recorded output.

Evidence: [live sender-clock verification](../labs/guest-rtc/evidence/sender-clock-live-verification.json).
Eleven Rust tests, native mixer/log lifecycle checks and Clippy passed.

### Paired decoded PCM handoff

The next isolated lab step introduces `diagnostic_take_decoded_audio`: a typed
native-to-Rust handoff of each decoded 10 ms PCM block with its source generation,
sequence, SSRC, RTP timestamp, local pull observation, elapsed time, speech type,
muted flag and channel count. The optional mixer retains three blocks per source
in fixed arrays. Its existing pull callback copies samples without allocating or
waiting for a consumer lock. A busy consumer causes an explicit contention drop;
an overfull ring discards the oldest block. Polling discards blocks older than
30 ms and source removal clears pending PCM before wrapper destruction.

The first live attempt exposed an important adapter mismatch: browser Opus audio
arrives from the native mixer in stereo even though the synthetic signal is mono.
The initial mono-only handoff rejected almost all blocks, producing no valid
online origin maps. This failed-format evidence is retained as
`transport-decoded-pcm-rejoin.json`. The revised handoff preserves 480 samples per
channel for either mono or stereo in a fixed 960-sample array. Other layouts remain
explicitly rejected. Unused mono capacity is zeroed; no implicit downmix occurs.

`DecodedOrigins` consumes the paired handoff and fits sender-report clocks during
the run, rather than reconstructing a final-frame timestamp after disconnect.
Each native source generation gets a fresh mapper. Reports observed before that
generation's first delivered pull are excluded, and previously seen retained
reports cannot refresh clock age or reset a valid map. Source state is bounded to
64 generations, matching the existing lab probe capacity. All PCM and sender
reports are processed off the native pull callback; only bounded origin metadata
and aggregate nonzero-PCM counts are written to evidence, not recorded PCM.

The ownership graph is unchanged: factory owns mixer; mixer owns delegate and
source wrappers; wrappers borrow their registered WebRTC sources and own shared
probe state; registry holds only a weak state reference. Delegate registration is
unlinked before wrapper destruction. The new ring stores values and introduces
no threads, file descriptors, retained callbacks or ownership back-references.
The 100-cycle native test exercises PCM pairing, mono/stereo preservation,
overflow, stale blocks, lock contention, unsupported format, retirement flush,
accounting and partial teardown, with observable destruction and thread/FD counts.

This handoff remains an observation path. OBS continues using the previous audio
sink and has not switched to this PCM stream. A source RTP timestamp is not a
qualification of original capture time: NetEq concealment, inserted/removed
samples and time stretching still need treatment before assigning presentation
slots. Publication/session binding and a shared local presentation timeline for
audio and video are the next implementation steps. No recorded lip-sync result
or speakerphone AEC result is implied by online origin mapping.

#### Live paired-PCM results and presentation constraint

The corrected 45-second, three-guest rejoin run delivered 10,289 paired native
PCM blocks, with 6,563 origins mapped online. All six generations had nonzero PCM
and zero format rejections; all three current publications had usable maps. Two
brief retired generations closed before two fresh sender reports arrived and
correctly stayed unmapped. Nine native pull observations were skipped by the
nonblocking contention guard; that is explicitly recorded rather than counted as
successful handoff. Pending PCM was flushed at retirement and quiescent accounting
held for every recorded source.

The 35-second audio-jitter run delivered 9,293 paired blocks with 7,147 mapped
origins across all three guests, zero mapper resets and zero native pull contention.
A separate 25-second run measured consecutive mapped-origin steps while the relay
applied verified 20–79 ms packet delay and about 2% audio packet loss on each leg.
All control and video packets remained unimpaired. The paired blocks still each
contain 480 samples per channel (10 ms), but adjacent mapped origins ranged from
0 to 27,500 microseconds. The maximum discrepancy against a continuous 10 ms PCM
step was 17,500 microseconds. Receiver audio counters recorded concealment and
inserted/removed samples, consistent with nonuniform decoded-origin progression;
clock-fit refresh can also contribute to these observations, so this is not a
proof that every discrepancy is caused by NetEq time stretching.

This rules out simply stamping every block with its independently mapped RTP
origin. Such timestamps would describe overlaps or holes in a fixed-size PCM
stream. The next presentation implementation needs a continuous audio sample
clock, with generation/discontinuity guards, plus a measured relation between
sender origin and that decoded sample timeline. Video deadlines must derive from
that same relation, rather than use an independent arrival anchor. Any correction
must preserve PCM order and bounded queues; it must not fabricate capture time or
silently replay old generations. Recorded baseline, video-jitter, audio-jitter and
rejoin marker acceptance still remain mandatory after OBS is connected.

In the origin-step run, first usable maps occurred at decoded sequences 618, 684
and 805 (roughly 6–8 seconds of decoded output). This is a material startup-policy
constraint for the two-report mapper, not acceptable hidden latency. G1 must expose
unqualified startup or provide a separately measured bounded startup strategy;
these diagnostic runs do not establish immediate synchronized guest admission.

Evidence: `decoded-pcm-lifecycle.json`, `decoded-pcm-verification.json`,
`transport-decoded-pcm-stereo-rejoin.json`, `transport-decoded-pcm-audio-jitter.json`
and `transport-decoded-pcm-step-jitter.json`, with their browser and packet-relay
companions. The verifier checks actual current audio SSRCs, generation retirement,
PCM accounting, nonzero samples, positive mapped origins and measured packet
impairment. Twelve Rust tests and default/OBS lint checks pass. The macOS lab
build can set `LIVEKIT_LAB_LINK_EXTERNAL_ARCHIVE=1` to reference the unchanged
pinned native archive at final link and avoid another ~700 MiB archive copy; this
is an opt-in lab build change and does not modify the production application.
