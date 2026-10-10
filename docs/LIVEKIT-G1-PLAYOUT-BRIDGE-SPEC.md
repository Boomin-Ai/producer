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
