# Producer Live — libobs embedding review (2026-08-28)

Grounded in a read of obs-studio @ master (shallow clone), obs-multi-rtmp source,
and our own constraints. This is the map for the Mac spike session.

## Verified facts (from the code, not vibes)

1. **License is compatible.** Source headers: "either version 2 of the License, or
   (at your option) any later version" → GPL-2.0-or-later. Combinable with
   Producer's AGPL-3.0. The combined desktop app effectively distributes under
   GPLv3/AGPLv3 terms — fine for us, we're already copyleft.
2. **libobs is UI-decoupled by design.** Top-level CMake has
   `option(ENABLE_FRONTEND ... ON)` — turn it OFF and you build libobs + plugins
   with **no Qt anywhere**. The Studio UI (frontend/) is just one consumer.
3. **macOS has a brand-new native Metal renderer** (`libobs-metal/`, Swift) next to
   the OpenGL one; the frontend picks `DL_METAL` vs `DL_OPENGL` at runtime
   (OBSApp.cpp:1164). Upstream is investing in Mac *right now*.
4. **The bootstrap a host must replicate is small** (OBSApp.cpp):
   `obs_startup(locale, module_config_path, profiler_store)` →
   `obs_reset_video{graphics_module, base/output res, fps}` → `obs_reset_audio` →
   `obs_load_all_modules2` → build the graph. That's it — no hidden Qt coupling.
5. **Go-live is ~6 calls** (frontend/utility/SimpleOutput.cpp):
   `obs_video_encoder_create` → `obs_audio_encoder_create` →
   `obs_service_create("rtmp_custom"|"rtmp_common", server+key)` →
   `obs_output_create("rtmp_output")` → `obs_output_set_video_encoder/-service` →
   `obs_output_start`. Status/reconnect arrives via output signals.
6. **Fan-out is a proven pattern** (obs-multi-rtmp/push-widget.cpp): create N
   `rtmp_output`s; each either **shares the main encoders**
   (`obs_get_encoder_by_name` — one encode, N pushes) or owns **dedicated
   encoders** (per-destination bitrate). Both modes work; we can offer both.
7. **rtmp-services ships the ingest catalog** (`services.json`): Twitch, Kick,
   YouTube, and dozens more with regional ingest URLs. Stream-key UX = pick
   service + paste key. No per-platform API work for v1 live.
8. **Mac deps are prebuilt.** `cmake/macos/buildspec.cmake` auto-downloads the
   obs-deps toolchain (FFmpeg etc.) into `.deps` — no dependency hell on Mac.
9. **obs-webrtc plugin = WHIP output.** Cloudflare Stream ingests WHIP →
   a straight line from Producer's engine into Boomin Live (CF Realtime/Stream).
   "Stream to Boomin" becomes one more destination row; the laptop-closed relay
   becomes the natural hosted/paid tier. Architecture converges.

## The v1 plugin set (all present, all Mac-native)

| Need | Plugin | Notes |
|---|---|---|
| Screen/window capture | `mac-capture` | ScreenCaptureKit throughout (mac-sck-*.m) — the modern API |
| Webcam | `mac-avcapture` | AVFoundation |
| Mic / desktop audio | `mac-capture` audio + CoreAudio | SCK audio capture included |
| HW encode | `mac-videotoolbox` | H.264/HEVC on Apple Silicon |
| SW encode fallback | `obs-x264` | |
| AAC audio | `coreaudio-encoder` | |
| RTMP/RTMPS out | `obs-outputs` | bundled librtmp, FLV mux, reconnect logic |
| Ingest catalog | `rtmp-services` | services.json |
| Images/text/stills | `image-source`, `text-freetype2` | v1 "overlay-lite" |
| Filters/transitions | `obs-filters`, `obs-transitions` | cheap to include |
| WHIP (Boomin Live) | `obs-webrtc` | phase 2 destination |

## What we deliberately do NOT port

- **Qt frontend** — Producer's UI replaces it. That's the whole thesis.
- **obs-browser (browser source) = CEF** — the ONLY painful omission. See below.
- **Game capture hooks** — a Windows concept (win-capture DLL injection); on Mac,
  games are captured via SCK display/window capture anyway. Nothing lost for Mac v1.
- **obs-websocket** — our IPC/contract *is* the control surface (and later the MCP).
- **Scripting (Lua/Python), VST filters, Decklink/AJA pro I/O, Syphon** — pro-niche, later or never.
- **mac-virtualcam** — needs a system extension + user approval flow; defer.
- **Multitrack video (Twitch enhanced broadcast)** — later.

## Overlays — the honest answer

Modern overlays (Streamlabs/StreamElements alerts) are **browser sources**: a URL
rendered by CEF composited into the scene. Without CEF there is no drop-in
compatibility. Options:

- **v1 (ship now):** no browser source. Offer image/GIF + text sources
  ("overlay-lite"), plus the pragmatic escape hatch: window-capture a browser
  showing the alert page. The "streamers who don't mind no overlays" cohort is
  the v1 audience — correct call.
- **v2 (the real answer): bundle obs-browser + CEF, like OBS does.** Known build
  recipe (it's a submodule with CI), costs ~150MB and notarization care for the
  CEF helper processes. Payoff: every existing StreamElements/Streamlabs overlay
  works day one. This is compatibility we cannot self-build around.
- **Rejected:** offscreen WKWebView→texture as a CEF substitute. System webviews
  can't render offscreen at streaming framerates reliably — CEF exists because
  of exactly this. Don't burn the spike on it.
- **Differentiator later:** Hyperframes-authored overlays (HTML) rendered via the
  same CEF path — our own overlay ecosystem on top of standard tech.

## Risk register (ranked)

1. **Build & bundle** — compile libobs+plugins standalone (ENABLE_FRONTEND=OFF,
   macos preset), vendor dylibs + plugin bundles + data trees into Producer.app,
   set module/data paths at runtime, sign every dylib in our notarization pass.
   First-time CI cost ~a day; then solved forever. Biggest single risk.
2. **Permissions UX** — Screen Recording TCC (Settings toggle + app restart
   quirk), mic, camera; Info.plist usage strings. Must be designed into
   onboarding, not discovered by users.
3. **Rust↔C binding + threading** — obs.h is ~676 exports, we need ~30. bindgen
   or the existing libobs-sys crates; all engine calls on one dedicated thread
   behind a command channel (mirrors how the frontend serializes).
4. **Preview rendering** — `obs_display` wants an NSView; Tauri can hand us the
   window handle (Streamlabs proves the pattern). Not required for first light:
   go-live works headless before preview exists.
5. **AV sync / perf** — VideoToolbox + Apple Silicon; lowest risk.

## v1 UX (the part we must nail)

Sidebar gains **LIVE**. One view:
- Sources: big preview (or placeholder day 1) + toggles: Screen / Window / Camera / Mic.
- Destinations: rows of {service picker, stream key (→ OS keychain), on/off}.
  Twitch / Kick / YouTube / Custom RTMP. Add row. Keys never leave the keychain.
- One button: **Go Live**. Per-destination status lights: connecting / live /
  reconnecting, bitrate, dropped frames (from output signals). Stop.
Nothing else in v1. No scenes UI, no filters UI, no transitions UI.

## Mac spike plan (session 1)

1. `cmake --preset macos -DENABLE_FRONTEND=OFF` → build libobs + v1 plugin set
   (deps auto-fetch). Artifact: dylibs + plugins + data.
2. Minimal host (Rust or C first): startup → reset video (Metal) → reset audio →
   load modules → SCK display source + mic + VideoToolbox + AAC → rtmp_custom
   with a real Twitch key → `obs_output_start` → confirm live in Twitch dashboard.
3. Add Kick + YouTube outputs sharing the same encoders → three dashboards live.
4. Fold into src-tauri as the `live` engine module + Destinations UI.
Milestone 1 = "Producer.app streamed my screen to three platforms at once."
Preview, camera, polish come after first light.

## Open decisions (need Kleveland's call)

- D1: v1 ships without browser-source overlays — confirmed?
- D2: default encoder mode: shared (one encode, gentle on the machine) with
  per-destination override later — confirmed?
- D3: first light before preview (headless go-live), preview second — confirmed?
- D4: "Boomin Live" as a built-in destination (WHIP) in phase 2 — confirmed?
- D5: engine binaries: build once in CI, vendor as release artifacts our app
  build consumes (vs building in every CI run) — preference?
