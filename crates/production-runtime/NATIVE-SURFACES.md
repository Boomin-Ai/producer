# Native 2D surface slice

This is an Apple Silicon Native Dev renderer slice, not a public beta release or the completed eight-layout Classic. Production remains unchanged. The public train fixture establishes real video behind a translucent foreground with independent text; it is not a claim of backdrop blur, refraction, SVG or image-layer support.

## Authoring contract

A spatial Node optionally carries `style: SurfaceStyle`. Missing style preserves existing JSON and hashes. The Rust schema/TypeScript artifacts expose:

- solid or two-stop linear sRGB paint with explicit alpha;
- a pixel corner radius and inner border;
- bounded, static fine luminance grain;
- system-font text size, weight, ink and left/center/right alignment.

`document.transaction` → `setSurface` changes one node by Set/layout/path without replacing its children, source binding, Show, controls or editorial timing. Invalid candidates retain the prior document/output. These are normal typed component nodes, not a hardcoded graphics page or browser overlay. Native Dev's Assistant context advertises the supported fields and budgets. The actual ChatGPT/MCP adapter is still pending.

Example operation:

```json
{
  "op": "setSurface",
  "set": "studio",
  "layout": "landscape",
  "path": ["root", "glass"],
  "style": {
    "fill": {
      "kind": "linear",
      "from": {"color": "#0C171E", "opacity": 0.2},
      "to": {"color": "#0C171E", "opacity": 0.94},
      "angle": 90
    },
    "radius": 30,
    "grain": 0.025
  }
}
```

The first native text profile uses the explicit system-font asset with digest `0000000000000000000000000000000000000000000000000000000000000000`. Unsupported fonts, visual sources and animation targets are refused rather than silently substituted. Current native leaf animations admit opacity, X/Y translation and visibility. Composed parent transforms/clips and rotation/scale are not yet qualified by this adapter. Paint colors are literal inks; automatic theme-token resolution remains to be connected.

## Execution and resource ownership

The compiler carries typed styles into immutable node plans. The control worker prepares a bounded scene/text cache, including CoreText rasterization and Metal upload. A scene fingerprint includes its active compiled nodes and animation target contracts. Editorial cuts and dock changes reuse the cache. In-flight GPU encoders retain the immutable textures they reference; adopting a new scene does not mutate those textures.

Render/audio consumes prepared numeric draw records, retained video buffers and cached text. There is no text rasterization, JSON parsing or texture upload on each output frame. Rectangles use a pixel-space signed-distance mask, giving equal-radius corners on wide and tall surfaces. A single Metal fragment pass handles gradient alpha, border and optional grain. Text coverage is separately tinted to avoid multiplying premultiplied glyph edges twice. Preview and recorder continue receiving the same native GPU output buffers.

The native adapter admits at most 128 text elements, 8,388,608 cached text pixels (32 MiB BGRA texture data) and 1,024 draws across each output's scene. Cache preparation is transactional. These are explicit bounds, not a claim that the entire app uses 32 MiB. Frame building reuses preallocated draw vectors.

## Repeatable fixture check

`producer-native-room --visual-fixture dark` or `light` prints the public compositor specimen at 1920×1080 and 1080×1920. Write it to an isolated profile's `room.json`, add a `visual-fixture.json` marker containing `{"kind":"native-visual-qa"}`, and open Native Dev with `PRODUCER_NATIVE_ROOM_HOME` pointing at that profile. Then run:

```sh
python3 crates/production-runtime/desktop/scripts/check-visuals.py \
  --binary target/native-room/debug/producer-native-room \
  --profile /absolute/path/to/isolated/visual-qa \
  --movie /absolute/path/to/public-train.mp4 \
  --evidence /absolute/path/to/local-check.json
```

The check runs both themes, edits one surface and moves/closes/reopens docks while paired recording continues. It never enables camera, microphone or screen capture. Decode the resulting committed takes with `desktop/scripts/check-take.py`.

The local fixture is [Chanaka Herath's forest train video](https://www.pexels.com/video/train-4k-20198201/) under the [Pexels license](https://www.pexels.com/license/). The downloaded file probes as 2560×1440 H.264 at 60000/1001 fps, lasting 6.441667 seconds. The download filename's 4K label is not its decoded resolution. Original media stays local and is not committed or bundled.

## Observed result, 2026-11-18

220 pure-workspace tests and 20 desktop tests passed. GPU cache tests require access to Metal; the filesystem sandbox alone could not create a device. All 16 recorded fragments across the two themed paired takes were hash-checked and fully decoded. Four program tracks produced 181–184 frames over about six seconds, approximately 29.79–29.96 fps, at native 1080 landscape/vertical dimensions. No new GPU submission refusals or committed media gaps occurred during these short runs. Maximum sampled CPU evaluation/build/submission p99 was 1.81 ms; this excludes GPU execution and end-to-end latency. Recorded frames were visually inspected in both orientations and themes.

See `evidence/native-surfaces-proof.json` for exact executable/source hashes and measured counts. Camera/mic/screen requalification, long-session memory/latency tests, full Classic/controls, richer graphics and cross-platform hardware qualification remain separate work. The earlier media evidence remains attached to its original executable/source hashes.

## Loop visibility and textured transparency follow-up, 2026-11-18

The six-second acceptance above did **not** cross the public video's first loop. The user subsequently reported heavy flicker. A 20-second pixel scan of the original candidate found 192 absent-video frames out of 590 landscape frames. Successful decoding and GPU submissions alone had missed the visibility failure.

The principal cause was the decoder time boundary. A loop duration of `3833/600` seconds subtracted from a nanosecond transport can require a denominator above serialized `Time`'s 1 GHz profile. The exact mapper correctly refused that narrowing; the desktop incorrectly swallowed its error as an absent source. `PlayerPlan::media_seconds` now completes exact wide-rational mapping and visibility decisions before converting once to the external decoder's seconds interface. Serialized time, exact `sample()`, edits and animation contracts are unchanged. Genuine mapping failure is reported rather than interpreted as disconnection. Regression coverage samples thousands of positions across a minute of loops, preserving strict exact-time rejection and depth limits.

The native video reader also retains one lookahead, presenting the last sample at/before the requested timestamp rather than assuming adjacent sample durations cover every instant. A render-owned presentation cache bridges brief asynchronous handoff misses for at most 250 ms; seek/source generations and inactive placements clear it. A matching paused frame remains valid. No decode or waiting is introduced on the render lane. `state.moviePlayback` exposes requested/decoded time, decode age, misses, frame readiness and missing presentations.

`Paint::Veil` adds three authored inks (`from`, `to`, `glow`), bounded halftone `cell` (2–24 output pixels) and `motion` (0–1). Spatial alpha/color variation and a fine halftone are evaluated by the existing Metal surface pass. Motion uses continuous production time, not a GPUI timer or a looping file playhead. This is real translucent compositing, **not** backdrop blur, refraction or an illustrated cloud texture. Both light and dark fixtures use it; no new raster upload or offscreen blur pass runs per frame. Draw ABI is now 160 bytes in both Rust and native code.

The strengthened `check-visuals.py` defaults to 35 seconds per theme. It waits for the actual post-seek frame, crosses five source loops plus the 30-second room wrap, edits a surface and roundtrips docks while recording. Its companion `check-video-presence.swift` decodes both outputs and samples exposed background pixels outside the authored foreground. A blank frame or a prolonged identical sample run fails acceptance. This detector is specific to the known bright forest fixture; it is not a general classifier for arbitrary dark footage. Test captures stay local.

Exact candidate measurements and limits are recorded separately in `evidence/native-surface-loop-proof.json`; the earlier six-second evidence remains attached to its original source/executable. Production desktop and user profiles remain unchanged.
