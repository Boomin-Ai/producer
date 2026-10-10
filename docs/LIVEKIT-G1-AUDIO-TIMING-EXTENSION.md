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
