# Producer Live — Implementation Plan v1.0 (for adversarial review)

Status: DECIDED pending external review. Review instructions are at the bottom.
Owner: Kleveland. Drafted 2026-08-28 after a source-level read of obs-studio
(master, shallow clone), obs-multi-rtmp, and Producer's existing architecture.

---

## 1. Goal (one sentence)

Ship, inside the existing Producer desktop app (Tauri 2 + Rust + React, AGPL-3.0,
signed & notarized macOS DMG already in production), the ability for a user to
**go live to multiple platforms simultaneously (Twitch, Kick, YouTube, custom
RTMP) with zero external software and zero servers**, by embedding OBS's engine
(libobs + its plugins) — not by reimplementing any capture, compositing,
encoding, or protocol code ourselves.

### 1.1 Product thesis being served

Producer's differentiation vs Postiz-class competitors is substrate: native
desktop + $0 serverless, agent-operable. Live multistreaming extends that thesis
where onboarding friction is lowest (stream keys are copy-paste; no developer
apps) and where the paid incumbent (Restream, $16–40/mo) charges for bandwidth
a local machine can push. OBS itself is not a competitor we attack; OBS is an
upstream we embed. We compete with *Restream's subscription*, not OBS.

### 1.2 The prime directive

**We rip, we do not reinvent.** Every component with engineering gravity —
capture, compositing, encoding, RTMP, reconnect, browser overlay rendering —
is OBS's code, unmodified. The only code we author: (a) the Rust host that
drives libobs's C API, (b) Producer's UI, (c) build/signing plumbing.
Any reviewer finding where this plan quietly reimplements something OBS
already ships should flag it as a defect.

---

## 2. Scope

### 2.1 v1 ships (macOS first)

- Sources: display capture, window capture, webcam, microphone, desktop audio,
  image/GIF, text. (All via existing OBS plugins: mac-capture, mac-avcapture,
  image-source, text-freetype2.)
- Browser-source overlays (obs-browser + CEF) — **in v1 scope, sequenced last**
  (Decision D1). Streamlabs/StreamElements overlay URLs render identically to
  OBS because it is the same plugin.
- Destinations: N simultaneous RTMP/RTMPS pushes — Twitch / Kick / YouTube
  presets from OBS's rtmp-services catalog + custom RTMP URL. Stream keys
  stored ONLY in the OS keychain (Producer secrets law).
- Encoding: hardware (VideoToolbox) with x264 fallback; **one shared encode
  fanned to all destinations by default**, per-destination encoder as an
  exposed power-user option (Decision D2).
- In-app live preview (after first light — Decision D3).
- Per-destination status: connecting / live / reconnecting, bitrate, dropped
  frames (from obs_output signals).
- One-button Go Live / Stop.

### 2.2 v1 explicitly does NOT ship (non-goals — challenge them, but they are deliberate)

- Scenes/collections UI, filters UI, transitions UI, audio mixer UI (engine
  supports them; our UI intentionally exposes a single implicit scene).
- Windows/Linux live (engine lands mac-first; the app already ships all-OS for
  posting; live follows).
- Recording-to-disk, replay buffer, virtual camera (all exist in engine; UI later).
- obs-websocket, scripting, VST, Decklink/AJA/NDI, Syphon, game-capture hook
  injection (Windows-only concept anyway), Twitch multitrack/enhanced broadcast.
- Any Producer-authored streaming protocol code.

### 2.3 Phase 2 (committed direction, not in v1 acceptance)

- "Stream to Boomin" as a built-in destination via OBS's obs-webrtc WHIP output
  → Cloudflare Stream ingest (Boomin Live's existing substrate) (Decision D4).
  This is the on-ramp to the paid laptop-closed relay tier. It is opt-in, one
  destination row among equals, and the only Boomin-branded surface in Live.
- Windows/Linux engine builds; recording; virtual camera; scene presets.

---

## 3. Verified facts vs assumptions

Facts below were verified by reading the obs-studio tree on 2026-08-28.
Assumptions are labeled and each carries a validation step in the milestones.

### 3.1 VERIFIED (with evidence paths)

| # | Claim | Evidence |
|---|---|---|
| F1 | OBS license is GPL-2.0-**or-later**, hence combinable with AGPL-3.0 | COPYING + per-file headers ("either version 2 ... or any later version"), e.g. libobs/obs.c |
| F2 | Engine builds without Qt/UI | Top-level CMakeLists.txt: `option(ENABLE_FRONTEND "Enable building with UI (requires Qt)" ON)` |
| F3 | Host bootstrap is small: obs_startup → obs_reset_video → obs_reset_audio → obs_load_all_modules2 → build graph | frontend/OBSApp.cpp:1178, 2044 |
| F4 | Go-live is ~6 calls: create encoders → obs_service_create → obs_output_create("rtmp_output") → set encoder/service → obs_output_start | frontend/utility/SimpleOutput.cpp:656–757 |
| F5 | Multi-destination fan-out with shared OR dedicated encoders is a proven upstream pattern | obs-multi-rtmp/src/push-widget.cpp:117–352 (obs_get_encoder_by_name sharing) |
| F6 | macOS capture is ScreenCaptureKit-based | plugins/mac-capture/mac-sck-*.m |
| F7 | macOS has a native Metal renderer in-tree (in addition to OpenGL); frontend selects DL_METAL at runtime | libobs-metal/ (Swift), frontend/OBSApp.cpp:1164 |
| F8 | Platform ingest catalog (Twitch/Kick/YouTube/dozens more) ships as data | plugins/rtmp-services/data/services.json |
| F9 | macOS dependencies are prebuilt and auto-fetched by the build | cmake/macos/buildspec.cmake (downloads obs-deps into .deps) |
| F10 | WHIP output exists as a plugin (Cloudflare Stream ingests WHIP) | plugins/obs-webrtc/whip-output.cpp |
| F11 | Browser overlays are CEF (separate submodule), the only heavy optional dep | .gitmodules → plugins/obs-browser |

### 3.2 ASSUMED (must be validated by milestone; reviewer should stress these)

| # | Assumption | Risk if false | Validated by |
|---|---|---|---|
| A1 | libobs + chosen plugins build standalone on macOS arm64 with ENABLE_FRONTEND=OFF without patching | Build fights; timeline slips | M-L1 |
| A2 | Rust FFI over obs.h (bindgen or existing -sys crate) is workable; engine calls serialized on one thread suffice | Crashes/races | M-L2 |
| A3 | The notarization pipeline (already live for Producer) extends to bundled dylibs/plugins/data and later CEF helpers with config only, no new Apple ceremonies | Release pipeline stalls | M-L4, M-L6 |
| A4 | obs_display can bind to an NSView obtained from Tauri's window for preview (Streamlabs precedent) | Preview needs alternate path (offscreen texture → app) | M-L5 |
| A5 | Metal renderer is stable enough for our use; else fall back to DL_OPENGL exactly as OBS does | None fatal — documented fallback | M-L2 |
| A6 | ScreenCaptureKit permission flow (TCC) can be made first-run-smooth (prompt + relaunch guidance) | Bad first-run UX | M-L5 |

---

## 4. Decisions (closed 2026-08-28 with Kleveland; reviewer may challenge with cause)

| ID | Decision | Rationale | Revisit trigger |
|---|---|---|---|
| D1 | obs-browser/CEF is IN v1 scope, sequenced last; must never block first light; ships in next point release if it exceeds ~2 days of fight | It's a rip not a build; overlays matter; but CEF is the heaviest bundle+signing item | CEF signing/bundle exceeds budget |
| D2 | Shared encode default (one encode, N pushes); per-destination encoder exposed as power-user option in v1 | Laptop-friendly; both modes proven upstream (F5) | — |
| D3 | First light is headless (verify on platform dashboards); in-app preview lands immediately after, before any user-facing release | De-risks the riskiest glue (A4) off the critical path; no shipped version lacks preview | — |
| D4 | Phase 2 adds "Stream to Boomin" as built-in WHIP destination | F10 + Boomin Live already on CF Stream; honest opt-in upsell | OSS-community optics review at implementation |
| D5 | Engine binaries built in a dedicated CI workflow at pinned OBS versions, vendored as versioned release artifacts; app builds download them; `scripts/build-engine.sh` reproduces from source for purists (license compliance: pinned commit + script in repo) | Keeps app releases ~15 min; reproducible; AGPL/GPL-clean | — |

---

## 5. Architecture

### 5.1 Engine host (new Rust module: `src-tauri/src/live/`)

- `engine.rs` — owns the libobs lifecycle on ONE dedicated OS thread
  ("engine thread"). All libobs calls cross a command channel
  (mpsc: StartStream{dests}, StopStream, AddSource, SetOption, Shutdown).
  Mirrors how OBS's own frontend serializes engine access. No libobs handle
  ever leaves this thread.
- `ffi/` — bindgen-generated bindings over obs.h (~30 of 676 exports used).
  Evaluate existing libobs-sys crates first; own the bindings if they're stale.
- `graph.rs` — builds the implicit scene: sources per §2.1, one video +
  one audio encoder (D2 default), N services + N rtmp outputs (F4/F5 pattern).
- `status.rs` — subscribes to output signals (connect, reconnect, stop, dropped
  frames), forwards to UI over existing Tauri event channel.
- Stream keys: stored/retrieved via the existing `vault` (OS keychain) module.
  Keys never touch config files, logs, or the React layer in plaintext at rest.

### 5.2 Bundling (macOS)

Producer.app/Contents/
- Frameworks/libobs.*.dylib (+ Metal/OpenGL graphics modules)
- PlugIns/obs/ *.plugin (the §2.1 set; obs-browser + CEF helpers added last per D1)
- Resources/obs-data/ (effects/shaders + per-plugin data incl. services.json)
At startup the host calls obs_add_module_path / data path APIs pointing into
the bundle before obs_load_all_modules2 (F3).

### 5.3 Build & release (D5)

- New workflow `engine.yml`: checkout obs-studio at pinned tag → macos preset,
  ENABLE_FRONTEND=OFF, plugin allowlist → artifact `producer-engine-macos-{arm64,x64}-vOBS.tar.zst`
  attached to an `engine-vX` GitHub release.
- App workflow gains a fetch step (checksum-pinned). release.yml signing pass
  extended to cover bundled dylibs/plugins (A3); CEF helpers get their
  Chromium-required entitlements (JIT etc.) when D1 lands.
- `scripts/build-engine.sh` = the same steps, runnable locally.

### 5.4 UI (v1)

Sidebar gains LIVE → single "Go Live" view:
- Preview area (placeholder until M-L5), source toggles: Screen / Window /
  Camera / Mic (+ image/text add).
- Destinations: rows {service dropdown (from services.json), stream key field
  (keychain-backed, masked), enable toggle}; add/remove rows; per-destination
  advanced: dedicated encoder settings (D2 option).
- GO LIVE button; per-destination status lights + bitrate/dropped counters; STOP.
- First-run permissions coach: explain Screen Recording TCC toggle + relaunch
  (A6) before first capture attempt.
Nothing else. No scenes UI in v1 (§2.2).

### 5.5 Explicit non-designs

- No daemon: closing Producer ends the stream (local-first truth; the
  laptop-closed story is the Boomin relay in phase 2 — D4).
- No stream keys server-side, ever. Live is fully offline except the RTMP
  egress itself.
- Posting/scheduling (existing contract) and Live share the vault and UI shell
  but no other coupling; a Live regression cannot break publishing.

---

## 6. Milestones & acceptance criteria

| ID | Milestone | Acceptance (all must pass) |
|---|---|---|
| M-L1 | Engine artifact | CI (or local Mac) produces the standalone engine bundle from pinned OBS source with our plugin allowlist; A1 validated |
| M-L2 | First light (headless) | A Rust host inside Producer starts libobs (Metal or documented OpenGL fallback), captures display+mic, encodes via VideoToolbox+AAC, and is confirmed LIVE in the Twitch dashboard using a key pasted into Producer; A2/A5 validated |
| M-L3 | Fan-out | Same stream simultaneously LIVE on Twitch + Kick + YouTube dashboards, shared encoders (D2); per-destination status lights truthful (pull a cable → that row reconnects, others stay live) |
| M-L4 | Notarized build | The DMG from CI containing the engine passes notarization; fresh Mac: download → open → go live, no Terminal; A3 validated |
| M-L5 | Preview + permissions | In-app live preview via obs_display-in-Tauri (A4) or documented fallback; first-run TCC coach flow tested from a clean permissions state (A6) |
| M-L6 | Overlays (D1, last) | obs-browser + CEF bundled & notarized; a StreamElements overlay URL renders in the stream identically to OBS |

v1 release gate = M-L1..M-L5. M-L6 joins if within budget (D1), else next release.

## 7. Risk register (ranked, with mitigation + fallback)

| # | Risk | Mitigation | Fallback |
|---|---|---|---|
| R1 | Engine build/bundle friction (A1, A3) | Use OBS's own presets + prebuilt deps (F9); pin versions; do it first (M-L1) | Extract libobs + plugins from OBS's official signed release bundle for the spike; build our own later |
| R2 | CEF bundling + signing (D1) | Sequenced last; copy obs-browser's own CI recipe; entitlements documented | Ship v1 without; point release |
| R3 | Preview embedding (A4) | Streamlabs precedent; isolated from critical path (D3) | Render-to-texture → periodic frame to UI (degraded preview) while native path matures |
| R4 | TCC permission UX (A6) | Dedicated first-run coach; detect missing grant and instruct relaunch | — (unavoidable macOS reality; UX quality is the mitigation) |
| R5 | FFI threading bugs (A2) | Single engine thread + command channel; no handles cross threads | — |
| R6 | Upstream drift (OBS updates) | D5 pinning; engine bumps are deliberate PRs with changelogs | Stay on last-good pin |
| R7 | GPL/AGPL compliance questions | F1; vendored-binary reproducibility via pinned commit + build script (D5); NOTICE file lists OBS components | Legal review before Windows cert/store distribution |

## 8. Security & privacy invariants (inherit Producer's laws)

- Stream keys: OS keychain only; masked in UI; never in logs/config/telemetry.
- No new network surface: Live adds outbound RTMP/RTMPS (and WHIP in phase 2)
  only; no listeners, no inbound ports in v1 (any-encoder RTMP *ingest* is a
  separate future feature and out of scope here).
- Engine binaries: checksum-pinned downloads; reproducible from pinned source.
- Capture consent: OS-level (TCC) + in-app indication while live (red dot state).

## 9. What the review agent should attack

1. Any place this plan reimplements what OBS ships (violates §1.2).
2. A1–A6: is any assumption load-bearing without a milestone validating it early enough?
3. The D1 sequencing: is "CEF last, never blocks first light" enforceable, or
   will bundling decisions made in M-L1 need rework when CEF arrives? (Specify
   bundle layout now to be CEF-shaped — §5.2 attempts this.)
4. The shared-encoder default (D2): platform-specific constraints (e.g., YouTube
   variable resolutions, Kick bitrate caps) that break "one encode everywhere"?
5. Licensing: is the vendored-binary + pinned-source scheme (D5) airtight for
   GPLv2+/AGPLv3 co-distribution? NOTICE/attribution requirements?
6. The non-goals (§2.2): does any omission fatally wound v1 adoption for the
   target cohort (streamers tolerant of missing overlays until M-L6)?
7. Thread/lifecycle model (§5.1): shutdown ordering, mid-stream source mutation,
   sleep/wake and display-reconfiguration behavior on macOS.
8. Anything in §6 acceptance criteria that is vague enough to be gamed.

Review verdicts should be labeled: BLOCKER / REVISE / ACCEPT, per section.
