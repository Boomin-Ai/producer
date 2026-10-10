The lab patches the published `libwebrtc` 0.3.51 crate used by LiveKit Rust 0.9.4.

- Upstream commit: `a6f93a16fa71fe811d040de175e070e233d9b1fe`
- Published crate SHA-256: `14f9145a63a8439508a9b5b51dffa4b1c12f812f49fcc4310ebae3d467f639ab`
- Upstream: https://github.com/livekit/rust-sdks/tree/a6f93a16fa71fe811d040de175e070e233d9b1fe/libwebrtc
- License: Apache-2.0 (original notices retained).

Only `src/audio_track.rs`, `src/video_track.rs`, and `src/lib.rs` differ. The patch exposes native handles and the existing owned video buffer conversion so the lab can register its own bounded callback sinks. No codec, networking, jitter-buffer, timestamp, APM, or audio-device behavior is changed.

This is a prototype dependency. An upstream supported callback hook is preferred before product adoption. These callback timestamps measure decoded delivery, not original audio capture or OBS synchronization.
