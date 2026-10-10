The lab patches the published `libwebrtc` 0.3.51 crate used by LiveKit Rust 0.9.4.

- Upstream commit: `a6f93a16fa71fe811d040de175e070e233d9b1fe`
- Published crate SHA-256: `14f9145a63a8439508a9b5b51dffa4b1c12f812f49fcc4310ebae3d467f639ab`
- Upstream: https://github.com/livekit/rust-sdks/tree/a6f93a16fa71fe811d040de175e070e233d9b1fe/libwebrtc
- License: Apache-2.0 (original notices retained).
- The repository LICENSE is included from the same upstream commit.

Only `src/audio_track.rs`, `src/video_track.rs`, and `src/lib.rs` differ. The patch exposes native handles and the existing owned video buffer conversion so the lab can register its own bounded callback sinks. No codec, networking, jitter-buffer, timestamp, APM, or audio-device behavior is changed.

This is a prototype dependency. An upstream supported callback hook is preferred before product adoption. These callback timestamps measure decoded delivery, not original audio capture or OBS synchronization.

## Audio timing diagnostic bridge

The lab also patches published `webrtc-sys` 0.3.48 from the same upstream commit.
Its published crate SHA-256 is `9d87fa13acfe63505a0e8c1311b5dc60323a429196c4a7ba18b63de34e5cba67`.
Original Apache-2.0 notices and upstream LICENSE are retained.

Only `src/audio_track.rs`, `src/audio_track.cpp`, and `include/livekit/audio_track.h`
change. The six-argument native audio sink callback now preserves optional capture
timing and flags remix/resampling before dispatching to Rust. The five-argument
callback explicitly reports absence; the Rust trait's default timed method forwards
to the existing `on_data` method for compatibility. A presence flag distinguishes
missing metadata from a valid zero timestamp. The timestamp's declared clock is
WebRTC TimeMillis; no mapping to Rust Instant, sender wall time, or OBS is assumed.
Remix/resampling delay remains unmeasured. Codec, jitter, and APM behavior stay upstream.

This is diagnostic instrumentation, not an OBS playout adapter or synchronization fix.

The same audio bridge now exports `diagnostic_webrtc_time_us()` using upstream
`webrtc::TimeMicros()` solely to anchor received video render timestamps to a local
Instant clock. It does not expose sender capture time or alter jitter/codec behavior.
