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
before the track fan-out discards it. This requires a supported upstream timed
observer or a rebuilt native WebRTC fork, not merely another five/six-argument
wrapper around the current raw PCM callback. Any source hook must preserve upstream
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
