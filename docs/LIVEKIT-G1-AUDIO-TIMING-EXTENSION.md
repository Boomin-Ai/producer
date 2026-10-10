# Native audio timing investigation

Status: optional capture-timestamp bridge implemented and exercised; browser fixture supplied no capture timestamps. A common presentation-clock adapter remains unimplemented and unqualified. Native OBS ingest must not infer sender A/V synchronization from async task wake time or sample counts.

The pinned LiveKit Rust 0.9.4 graph resolves libwebrtc 0.3.51 and webrtc-sys 0.3.48. Its public `AudioFrame` carries samples, rate, channel count and samples-per-channel. The native sink callback likewise exposes PCM/rate/channels/frame count without RTP, capture or presentation timing. The prototype bypasses the SDK stream's application queue and stamps the native callback; this measures local decoded delivery only.

The downloaded native `webrtc-89d790b` header `api/media_stream_interface.h` exposes a six-argument `AudioTrackSinkInterface::OnData` overload with optional `absolute_capture_timestamp_ms`. The header requires that timestamp's clock to match WebRTC `TimeMillis()`. The current `webrtc-sys/include/livekit/audio_track.h` overrides only the five-argument version; the default six-argument implementation forwards to it and discards the optional timing. The CPP wrapper's remix/resample path also does not attach timing to Rust PCM. This is a concrete extension point, not proof that every remote browser supplies the timestamp.

A minimal upstream investigation should add a backwards-compatible timed sink callback, preserving the old method as a fallback, with:

- Optional absolute capture time, units and explicit WebRTC local-clock domain; absence must stay absent.
- The number of output samples and any remix/resampling delay applied before callback delivery.
- A decode-callback timestamp distinct from capture time, plus an explicit discontinuity/generation identifier.
- When available, RTP timestamp/SSRC and the supported sender-report mapping needed to relate audio and video timelines.
- A supported synchronized presentation-time API, or a validated playout adapter that defines when those decoded samples and frames must reach the common OBS monotonic clock.

Simply exposing the optional capture value is insufficient. Validate whether NetEq delivers it for actual browser tracks, whether it has been estimated from sender reports, whether it advances monotonically after loss/PLC, and what resampling does to its sample origin. The native video sink also exposes `timestamp_us`, RTP timestamp and NTP metadata; its timestamp semantics must be established. Video `ntp_time_ms` was zero in the current canvas fixtures. Do not combine that zero with a local callback timestamp and claim a shared sender timeline.

The adapter needs one explicit clock map per track transport generation. Do not stitch a new SID into the old sample index. On reconnect or a timing discontinuity, retire buffered samples/frames, reset/re-establish the mapping and report the gap. Sample counters can detect an application drop, but cannot infer an unobserved sender packet loss or original capture phase. Buffers must be bounded and their discontinuity/drop counters remain visible.

Required validation uses physical or precisely timestamped flash/click source media recorded through OBS. Report offsets, lost markers, queue age/drop counts and drift under scheduler stalls, asymmetric audio/video network impairment, underrun, overflow, reconnect and an extended run. The current loopback marker offsets remain useful diagnostics but have browser paint uncertainty and are not this proof.

If the six-argument callback is unavailable in the tested stream, or no supported common presentation path exists, compare a narrow native timing bridge or alternate media provider using the same fixture before adopting the SDK. The callback handle patch in this prototype changes no timestamp behavior and must not be presented as a synchronization fix.

## Tested optional timestamp bridge (October 9)

The standalone lab now vendors `webrtc-sys` 0.3.48 and overrides both native audio
sink overloads. The six-argument callback preserves timestamp presence/value and
marks rate or channel conversion. Existing Rust sinks retain their old `on_data`
behavior through a default timed callback. Missing timestamps remain `None`,
including when the numeric bridge placeholder is zero. The lab records capture
availability, timestamp regressions and step size separately from callback arrival.
Track replacement resets the previous capture-time observation.

Both the one-guest normal run and three-guest disconnect/rejoin run passed return
media checks. No consumed audio block in either run carried capture timing; video
NTP metadata was also absent. This does not establish absence for all cameras,
clients, servers or SDK versions. It establishes that the tested browser/SFU/native
path cannot rely on this optional field for the common OBS clock. The fixtures use
AudioWorklet audio and canvas video, with the previously documented paint uncertainty.
Every consumed audio block reported rate or channel conversion; that includes
stereo-to-mono remix and must not be interpreted as measured resampler delay.

Five Rust tests and Clippy with warnings denied passed. Source comparison confirmed
only the three documented bridge files differ from the published crate, plus the
included upstream LICENSE. This instrumentation changes no jitter or codec behavior.

Evidence: [timing manifest](../labs/guest-rtc/evidence/audio-timing-investigation.json),
[one guest](../labs/guest-rtc/evidence/transport-timed-sink.json),
[three guests and rejoin](../labs/guest-rtc/evidence/transport-timed-republish.json).

Next required proof: expose or use a supported shared audio/video playout clock from
native WebRTC (including its synchronization groups and RTP/RTCP mapping), then
record flash/click offsets through the actual OBS ingest path under asymmetric
impairment and reconnects. The pinned headers contain `SetSyncGroup` and receive
synchronization interfaces, but those are internal engine interfaces, not proof of
an application-accessible clock. SDK callback delivery alone cannot qualify this.
An arrival-clock OBS adapter could measure output behavior, but must remain labeled
an experiment until these impairment tests prove a bounded offset and drift.
Production adoption and physical AEC qualification remain gated.

## Shared stream groups and actual OBS recordings

The pinned upstream WebRTC `pc/remote_audio_source.cc` explicitly supplies `nullopt`
when remote audio is fanned out to AudioTrack sinks. The previous optional-field
probe therefore encountered an intentional upstream boundary. `audio/channel_receive.cc`
retains RTP timestamps internally, but the public track sink does not expose them.

WebRTC chooses its receive synchronization group from the first media stream ID
in both audio and video configuration. The original loopback SFU negotiated separate
track-specific stream IDs. The lab now supports an opt-in local room created with
`syncStreams: true`, paired guest publications `camera-av`, and paired native program
publications `program-av`. SDP evidence confirms corresponding audio/video stream IDs
match. One guest and three guests with disconnect/rejoin passed return transport.
This setting disables transceiver reuse upstream and is not yet qualified for rapid
stage changes. Its documentation emphasizes larger playout delays; no such production
latency tradeoff was silently introduced here.

Receiver stats report nonzero estimated playout timestamps for both tracks. However,
those are snapshots, not per-frame scheduling instructions. The Rust stats struct
also defaults absent fields to zero, so these diagnostics do not preserve presence
and must not be used as a qualified clock mapping. No additional SDK fork was needed
for the supported track stats API.

The macOS-only `obs-proof` feature records decoded guest-1 I420/PCM through the
installed OBS 32.1.2 Metal engine, x264/AAC and FFmpeg muxer. It uses one local OBS
monotonic anchor plus callback Instant elapsed, not an original sender clock. The
main thread pumps AppKit while the engine runs on another thread. Only the required
encoder/muxer plugins are loaded; no physical camera, microphone or speaker is used.
A standalone symlink supplies the existing muxer helper beside the lab executable.
Both MP4s finalized with stop code zero and were decoded using native AVFoundation.

| Experiment | Recorded absolute offset p95 | Video minus audio median | Paired detections | Unmatched audio / video |
| --- | ---: | ---: | ---: | ---: |
| OBS default async buffering | 177.35 ms | +82.69 ms | 11 | 0 / 0 |
| OBS async video unbuffered | 88.69 ms | +32.02 ms | 11 | 3 / 0 |

Both fail the proposed 80 ms marker criterion. The second run is encouraging but
not a controlled performance comparison: callback load differed, and the first run
had 24 oldest-audio drops plus 3 stale drops versus 2 oldest drops in the second.
The analysis pairs each detection at most once. Three unmatched audio detections
may reflect split threshold crossings or missing video markers; they are not proven
source packet losses. Browser paint uncertainty remains approximately 33 ms, with
up to 10 ms audio detector windows. No asymmetric network impairment was injected.
Early/late median changes were +24 ms and -48 ms respectively over short runs,
which is insufficient to qualify drift.

During setup, Metal initialized successfully on some launches but failed once with
an unspecified MetalDevice constructor error; an earlier attempt needed a main-thread
run loop. The muxer helper absence was independently identified and corrected. A
resource-layout cause for the intermittent Metal failure was not established. Neither
issue changed the installed Producer app. Standalone packaging remains a lab limit.

Evidence: [stream negotiation](../labs/guest-rtc/evidence/sync-stream-negotiation.json),
[recording manifest](../labs/guest-rtc/evidence/obs-timing-manifest.json),
[default buffering analysis](../labs/guest-rtc/evidence/obs-sync-recorded-markers.json),
[unbuffered analysis](../labs/guest-rtc/evidence/obs-unbuffered-recorded-markers.json).

Next implementation should separate real-time audio handoff from video conversion
and analysis, retain receiver stream grouping, and define video presentation deadlines
against WebRTC's local render clock mapped to OBS. Audio NetEq playout cadence and
sample-origin discontinuities must be preserved without callback-arrival jitter
rewriting the timeline. Validate every change through recorded markers under
asymmetric network impairment, consumer stalls, rejoin and a longer drift run.
G1 and production adoption remain unqualified.

Primary source references (pinned versions):

- [Remote audio timing boundary](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/pc/remote_audio_source.cc)
- [Audio NetEq/raw-sink timing](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/audio/channel_receive.cc)
- [Video receive/render scheduling](https://raw.githubusercontent.com/webrtc-sdk/webrtc/89d790b/video/video_receive_stream2.cc)
- [LiveKit sync-stream support](https://raw.githubusercontent.com/livekit/livekit/v1.13.9/pkg/rtc/participant.go)
- [Room sync-stream configuration](https://github.com/livekit/protocol/blob/main/protobufs/livekit_room.proto)

## Local render-clock refinement and independent audio ingest

The diagnostic bridge exports WebRTC TimeMicros for one local clock anchor. Received
video timestamp_us is mapped to Instant and accepted only within -100/+250 ms of
callback arrival; missing/implausible deadlines fall back to arrival and are counted.
Accepted deadlines in these runs were approximately 10 ms ahead of arrival at p95.
Audio follows decoded 48 kHz sample progression with a 30 ms drift bound; regression
or excessive arrival deviation reanchors and counts a reset. This still does not
supply original sender capture time. The mapped video stamp is fed into OBS's async
source; an explicit deadline-aware bounded compositor is not yet implemented.

OBS PCM ingest now has a separate three-block/30 ms handoff and worker, independent
of video conversion and diagnostic consumer stalls. Callback PCM uses fixed
480-sample arrays, eliminating that callback's per-block Vec allocation. The mutex
handoff remains nonblocking for producers and can count/drop contention. Each audio
publication owns fresh worker/clock state. Removing its sink and joining the worker
happens before OBS output stop and source release. This is a lab implementation;
real-time thread priority, hardware routing and native application integration remain
unqualified.

A clock-only 25-second recording still failed at 105.35 ms p95. Adding the independent
audio worker yielded 50.02 ms p95 in a short run and 60.02 ms over two minutes with
repeated 200 ms diagnostic/video-consumer stalls. These are sequential runs with
varying machine load, not a controlled estimate of each change's isolated effect.

The v2 detector preserves raw threshold crossings and merges crossings within 150 ms
for the known 120 ms pulse envelope. The dedicated short run had an extra crossing
100.7 ms after the preceding crossing inside the same pulse; the original v1 evidence
remains available. The two-minute run paired 58 markers with no unmatched detections
after grouping, video-minus-audio median 17.35 ms, and late-minus-early median change
37.33 ms. It passes this local recorded-marker criterion, not G1. Its dedicated audio
queue still dropped 20 oldest blocks and 10 callback-contention blocks, with two clock
resets. Some blocks can be lost between markers; successful pairing is not proof of
lossless media or acceptable speech quality. The bounded handoff protects latency
without hiding these drops.

Evidence: [clock-only recording](../labs/guest-rtc/evidence/obs-playout-recorded-markers.json),
[dedicated worker v2 analysis](../labs/guest-rtc/evidence/obs-dedicated-markers-v2.json),
[two-minute stall analysis](../labs/guest-rtc/evidence/obs-dedicated-120s-markers.json),
[two-minute transport/drop counters](../labs/guest-rtc/evidence/transport-obs-dedicated-120s.json).

### Network impairment control did not take effect

The disposable Chrome harness now supports `Network.emulateNetworkConditionsByRule`
with a global rule, packet loss/reordering and bounded packet queue. Chrome accepted
the rule, but the 100% loss control continued to receive 199 audio packets in four
seconds; native audio/video receiver stats showed zero packet loss. The requested
60 ms latency and 2% loss run is therefore not accepted as proof of WAN impairment,
regardless of its 42.69 ms recorded p95. CDP acceptance alone is insufficient.
A verified packet-level impairment harness is still required. No system firewall,
physical network or production environment was modified.

Evidence: [hard-loss browser control](../labs/guest-rtc/evidence/transport-network-hard-loss-browser.json),
[hard-loss native receiver counters](../labs/guest-rtc/evidence/transport-network-hard-loss.json).
Primary API definition: [Chrome DevTools Network conditions](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json).

Seven Rust tests (including deadline rejection, sample-gap preservation and clock
reanchor), Clippy for both default and OBS features, and Node syntax checks passed.
Next gates remain verified asymmetric network impairment, extended drift/speech
quality, physical speakerphone/double-talk AEC and Windows/native packaging.

The three-guest disconnect/rejoin run with dedicated ingest recorded 79.35 ms
absolute offset p95 and paired 10 markers. Its observed-marker result is
`false`; this is close to the 80 ms limit and remains a short loopback
experiment. The native source closed its old audio worker, retired both old guest-1
track queues, and resumed media after republish. The final-generation ingest reported
one callback-contention drop, zero oldest/stale drops and zero clock resets. Ingest
worker counters for retired generations are not yet aggregated, so those numbers
are not full-session totals. Transport teardown and G2 privacy flush remain separate
qualification work.

Evidence: [rejoin recording](../labs/guest-rtc/evidence/obs-dedicated-rejoin-markers.json),
[rejoin transport](../labs/guest-rtc/evidence/transport-obs-dedicated-rejoin.json),
[refinement manifest](../labs/guest-rtc/evidence/playout-refinement-manifest.json).
