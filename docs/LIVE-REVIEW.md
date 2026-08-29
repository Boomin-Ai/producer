# Producer Live — Implementation Plan v1.1 (FROZEN)

Status: **FROZEN — accepted for implementation** after adversarial review
(2026-08-28). v1.0 verdict was REVISE with seven required patches; all seven are
folded in below and were re-verified against the obs-studio tree before freezing.
Changes from v1.0 are marked ★.

Owner: Kleveland. Implementation target: the Mac spike session, starting at §6.

### v1.1.1 deviation note (2026-08-28, recorded during M-L1)

Reality check at M-L1 start: OBS master (and ≥32.2.0) hard-requires Xcode 26.5 /
macOS 26 SDK (`cmake/macos/compilerconfig.cmake`), which cannot run on this
spike Mac (macOS 15.5, CLT-only, no Xcode installed). Owner decision:

- **obs.lock pins release tag `32.1.2`** (commit `fb4d98bf88fae5fc85cb11fc57f7c5e309282194`),
  the newest tag buildable with Xcode 16 / SDK 15.0 — **not master**.
- **All §3.1 facts re-verified at that tag**: F7 (Kick absent from
  services.json), F12 (service policy API), F13 (obs_set_ui_task_handler),
  F9 (libobs-metal present), F10 (WHIP output), F3 (obs_post_load_modules) —
  all hold. F2 is *better* at 32.1.2: frontend-tools lives under the
  ENABLE_FRONTEND-gated frontend tree, so the Qt-free allowlist build needs no
  upstream patch (patchset: empty).
- **A1 is validated in engine CI** (Xcode 16.x runner), not locally.
- **R1's fallback is exercised for the local spike engine**: libobs + the
  allowlisted plugins are extracted from the official signed
  `OBS-Studio-32.1.2-macOS-Apple.dmg` (checksum-pinned per §8), producing the
  same artifact layout `build-engine.sh` produces from source. All other M-L1
  acceptance items (bundle law, Finder launch, relocation, zero-Qt closure,
  post-load ID assertions, inner→outer signing) run against this engine today.

### v1.1.2 deviation note (2026-08-29, recorded at M-L7)

D1's budget rule is invoked: **M-L7 (CEF overlays) slips to the first point
release (tracked as M-L7.1)**, and the sanctioned escape hatch ships in v1.
Verified facts driving the call:

- The official `obs-browser.plugin` binary links QtCore/QtGui/QtWidgets and
  `obs-frontend-api` (otool-verified against the 32.1.2 DMG) — unusable under
  M-L7's own "no Qt dragged in" acceptance, and non-functional anyway: its
  macOS CEF message pump (`ENABLE_BROWSER_QT_LOOP`, hard-wired in
  `cmake/os-macos.cmake`) schedules work via QObjects that require the OBS
  frontend's running QApplication.
- CEF on macOS requires a main-thread pump; obs-browser already uses CEF's
  `external_message_pump` + `OnScheduleMessagePumpWork` — only the scheduling
  half is Qt. **M-L7.1 plan:** build obs-browser in engine CI with the Qt
  scheduler replaced by a host-provided callback (Producer marshals
  `CefDoMessageLoopWork()` onto the AppKit main queue via the existing GCD
  bridge); carried as a patchset in obs.lock per D5; preset gains
  ENABLE_BROWSER=ON + CEF fetch; artifact grows ~600MB (CEF + helpers);
  frontend-api ships as the no-op shim dylib (obs-browser links it; all calls
  degrade gracefully with no frontend registered — verify the
  FINISHED_LOADING dependency at patch time). No local build possible (no
  Xcode on the spike Mac) — the CI session owns the build loop.
- **v1 escape hatch (shipped):** window-capture overlay — SCK window capture
  of a browser window running the overlay page, composited full-frame on top
  of the scene, with an optional green color-key (obs-filters
  `color_key_filter_v2`) so a green-background overlay page blends like a
  true overlay. Limitation vs CEF: no native page alpha, no in-engine
  audio from the overlay, interaction stays in the browser window.

---

## 1. Goal (one sentence)

Ship, inside the existing Producer desktop app (Tauri 2 + Rust + React, AGPL-3.0,
signed & notarized macOS DMG already in production), the ability for a user to
**go live to multiple platforms simultaneously (Twitch, Kick, YouTube, custom
RTMP) with zero external software and zero servers**, by embedding OBS's engine
(libobs + an explicit plugin allowlist) — not by reimplementing any capture,
compositing, encoding, or protocol code ourselves.

### 1.1 Product thesis

Producer's differentiation is substrate: native desktop + $0 serverless,
agent-operable. Live extends it where onboarding friction is lowest (stream keys
are copy-paste) and the paid incumbent (Restream, $16–40/mo) charges for
bandwidth the local machine can push. We compete with Restream's subscription,
not with OBS. **Producer is a new product shell around OBS's proven media
runtime** (reviewer's formulation — adopted).

### 1.2 Prime directive

**We rip, we do not reinvent.** Capture, compositing, encoding, RTMP/WHIP,
reconnect, service policy, browser overlay rendering — all OBS code, unmodified.
We author only: (a) the Rust host driving libobs's C API, (b) Producer's UI,
(c) build/signing plumbing. ★ Review confirmed this cuts both ways: where v1.0
under-used OBS (service policy, §4-D2), the fix was *more* OBS, not less.

---

## 2. Scope

### 2.1 v1 ships (macOS first)

- Sources: display capture, window capture, webcam, mic, desktop audio,
  image/GIF, text — via mac-capture, mac-avcapture, image-source,
  text-freetype2. No Producer-authored capture code.
- Browser-source overlays (obs-browser + CEF): **in v1 scope, sequenced last**
  (D1); never blocks first light; slips to next point release if it exceeds
  ~2 days of fight.
- Destinations: N simultaneous RTMP/RTMPS pushes. UI presets: **Twitch · Kick ·
  YouTube · Custom RTMP**. ★ Twitch/YouTube come from OBS's rtmp-services
  catalog; **Kick is NOT in upstream services.json** (verified: 0 matches) and
  is implemented as a named Producer destination template over `rtmp_custom`
  (Kick's own docs instruct OBS users to use Custom). ~20 lines of product
  config, not a platform integration.
- Encoding: VideoToolbox preferred, x264 fallback (★ Kick's current policy —
  H.264 CBR ≤8Mbps ≤1080p60, with Mac users pointed at x264 for CBR — makes the
  fallback a first-class path, not an afterthought). AAC via coreaudio-encoder.
- ★ **Shared encode by default, computed via OBS service policy** (see D2) —
  never a hardcoded common bitrate. Per-destination dedicated encoders exposed
  as a power-user option in v1.
- In-app live preview (after first light — D3).
- Per-destination status: connecting / live / reconnecting, bitrate, dropped
  frames, from obs_output signals.
- One-button Go Live / Stop.

### 2.2 v1 non-goals (deliberate)

Scenes/filters/transitions/mixer UI (engine supports; UI exposes one implicit
scene) · Windows/Linux live (follows Mac) · recording, replay buffer, virtual
camera · obs-websocket (our IPC/MCP is the control surface) · scripting · VST ·
Decklink/AJA/NDI · Syphon · game-capture hook injection (Windows concept) ·
Twitch multitrack · any Producer-authored streaming protocol code.

### 2.3 Phase 2 (committed direction)

- "Stream to Boomin" as a built-in **WHIP destination** (D4): obs-webrtc's WHIP
  output → Cloudflare Stream WHIP ingest (Boomin Live's substrate; note CF
  labels WebRTC ingest beta). Same destination abstraction as RTMP rows — no
  Boomin-specific capture/engine code, ever. Local Producer owns production;
  Boomin relay owns persistence/distribution when the laptop closes.
- Windows/Linux engines, recording, virtual camera, scene presets.

---

## 3. Verified facts vs assumptions

### 3.1 VERIFIED (against obs-studio master, 2026-08-28; ★ = corrected in v1.1)

| # | Claim | Evidence |
|---|---|---|
| F1 | GPL-2.0-**or-later** → combinable with AGPL-3.0 | COPYING + per-file headers (libobs/obs.c) |
| F2 ★ | **libobs itself has no Qt dependency and the Studio UI disables via ENABLE_FRONTEND=OFF — but that flag alone does NOT yield a Qt-free build**: plugins/frontend-tools does `find_package(Qt6 REQUIRED Widgets)`, and the upstream `macos` preset sets `ENABLE_BROWSER: true`. Producer therefore maintains its **own CMake preset (`producer-macos`)** with an explicit plugin allowlist; a build gate asserts no Qt frameworks in the artifact | CMakeLists.txt:18; plugins/frontend-tools/CMakeLists.txt:3,64; CMakePresets.json:108 |
| F3 ★ | Host bootstrap: obs_startup → module paths → obs_reset_video → obs_reset_audio → obs_load_all_modules2 → **validate required IDs → obs_post_load_modules** → graph → encoders → services/outputs → start | frontend/OBSApp.cpp:1178,2044; libobs/obs.h:590 |
| F4 | Go-live call chain is conceptually small (create encoders → service → rtmp_output → attach → start). ★ Explanatory prose, NOT an invariant — encoders must also bind the video/audio contexts before output attach | frontend/utility/SimpleOutput.cpp:656–757 |
| F5 | Fan-out with shared OR dedicated encoders is proven upstream | obs-multi-rtmp/push-widget.cpp:117–352 |
| F6 | macOS capture is ScreenCaptureKit | plugins/mac-capture/mac-sck-*.m |
| F7 ★ | rtmp-services ships Twitch, YouTube, and dozens of services **but NOT Kick** (0 matches); Kick = Producer preset over rtmp_custom | plugins/rtmp-services/data/services.json |
| F8 | macOS deps are prebuilt & auto-fetched (SHA-pinned obs-deps) | cmake/macos/buildspec.cmake |
| F9 ★ | Metal renderer exists in-tree but is **self-described "alpha quality," Apple-Silicon-only**, with preview-stutter caveats; VideoToolbox streaming is stated to work on it | libobs-metal/README.md:4,47 |
| F10 | WHIP output plugin exists | plugins/obs-webrtc/whip-output.cpp |
| F11 | Browser overlays are CEF (obs-browser submodule) — the one heavy optional | .gitmodules |
| F12 ★ | **libobs exposes service policy**: obs_service_apply_encoder_settings, get_supported_resolutions, get_max_fps, get_max_bitrate, get_supported_video_codecs | libobs/obs.h:2538–2551 |
| F13 ★ | libobs has task domains (OBS_TASK_UI/GRAPHICS/AUDIO/DESTROY) and obs_set_ui_task_handler — the engine has its own internal threads; hosts marshal UI tasks | libobs/obs.h |

### 3.2 ASSUMED (validated by milestone; ★ renumbered to v1.1 order)

| # | Assumption | Validated by |
|---|---|---|
| A1 | Engine + allowlist builds standalone on macOS arm64 under our `producer-macos` preset without patching upstream | M-L1 |
| A2 | Bundle topology (§5.2) survives inner→outer signing with plugin discovery intact, launched from Finder | M-L1 |
| A3 | TCC (Screen Recording/mic) flows work under Producer's bundle + signing identity | M-L2 |
| A4 | Rust FFI + LiveEngine owner model is stable (no cross-thread handle escapes) | M-L5 |
| A5 | Metal backend suffices for our path; else DL_OPENGL fallback (which is also the Intel-Mac backend by definition) | M-L2/M-L3 |
| A6 | obs_display binds to an NSView from Tauri's window (Streamlabs precedent) | M-L6 |
| A7 ★ | VideoToolbox can produce a Kick-compatible CBR stream (UNPROVEN — x264 is the documented-safe path) | M-L4 |
| A8 ★ | Sustained AV sync/perf under SCK + desktop audio + VideoToolbox is acceptable (NOT "lowest risk" until a soak run passes) | M-L4 soak |

---

## 4. Decisions (CLOSED; ★ = strengthened per review)

| ID | Decision |
|---|---|
| D1 | CEF/obs-browser in v1 scope, sequenced last, never blocks first light; bundle layout is CEF-shaped from M-L1 (§5.2) so its arrival is additive, no migration. ★ Compatibility claim softened: "browser-source compatibility is the v2 target" — obs-browser touches frontend APIs, so CEF acceptance tests (§6 M-L7) include transparency, audio, websocket alerts, refresh, restart, frontend-event behavior, and a no-Qt assertion. Window-capture of a browser is the sanctioned v1 escape hatch |
| D2 ★ | **Shared encode default, computed by OBS service policy — never hardcoded.** Per enabled destination: instantiate obs_service → apply obs_service_apply_encoder_settings → read codec/resolution/fps/bitrate caps (F12) → compute the **intersection profile** across all shared destinations → configure the shared encoder ONCE, before start (no service mutates a live shared encoder another destination bound to). If the intersection is empty/unacceptable, the UI proposes dedicated encoding for the offending destination ("Kick requires a different encoder configuration. Use dedicated encoding for Kick?") — not a mysterious post-Go-Live failure. Dedicated per-destination encoders are the v1 power-user option |
| D3 | First light headless (verify on platform dashboards); preview lands right after; no user release ships without preview. ★ Headless means "no preview," NOT "unbundled CLI forever" — Producer.app bundle integration is pulled forward to M-L2 |
| D4 | Phase-2 "Stream to Boomin" via WHIP as one destination row among equals (CF WHIP ingest noted beta). No special Boomin engine |
| D5 ★ | **Build-on-engine-change, consume-by-hash.** An `obs.lock` (OBS commit SHA, submodule SHAs, buildspec revision, arch, patchset SHA if ever, config hash) drives a dedicated engine CI producing immutable `producer-libobs-macos-<arch>-<lockhash>.tar.zst` + SHA256 + manifest + licenses + SBOM. Producer CI consumes by hash; app release does final nested signing/notarization. `scripts/build-engine.sh` reproduces locally (GPL/AGPL compliance: pinned source + script in repo). CEF later = another lock change |

---

## 5. Architecture

### 5.1 Host & threading (★ release-gate invariant, verbatim)

> **Producer has one LiveEngine owner for lifecycle and graph mutations. libobs
> retains its own internal graphics/audio threads. Cocoa/AppKit operations and
> OBS UI tasks (obs_set_ui_task_handler) are marshalled onto the macOS main
> thread. Callbacks/signals never mutate Tauri or engine state directly; they
> publish immutable events back through the engine channel.**

```
Tauri / UI ──commands──▶ LiveEngine owner ──▶ libobs lifecycle/graph/outputs
                              │ signals → event channel → UI
                              └ UI task bridge → macOS main thread (NSView/AppKit/TCC)
```

Module layout: `src-tauri/src/live/{engine.rs, ffi/, graph.rs, policy.rs, status.rs}`.
`policy.rs` implements D2's intersection over F12 — it calls OBS's policy API;
it does not encode platform knowledge beyond the Kick rtmp_custom template.

### 5.2 Bundle law (★ = M-L1 acceptance, OBS-native topology, CEF-shaped now)

```
Producer.app/Contents/
  Frameworks/ libobs.framework, graphics backends, (later: Chromium Embedded Framework.framework + helpers)
  PlugIns/    mac-capture.plugin, mac-avcapture.plugin, mac-videotoolbox.plugin,
              coreaudio-encoder.plugin, obs-x264.plugin, obs-outputs.plugin,
              rtmp-services.plugin, image-source.plugin, text-freetype2.plugin,
              obs-filters.plugin, obs-transitions.plugin, (later: obs-webrtc, obs-browser)
  Resources/  obs data trees per plugin (services.json et al.)
```
No Producer-specific filesystem convention; the layout OBS's mac loader already
expects. **Explicit allowlist above = the only plugins built and shipped.**
Excluded by name: frontend-tools (Qt), obs-websocket, scripting, decklink/aja,
vst, syphon, virtualcam, win-*/linux-*.

### 5.3 Build & release (per D5)

`engine.yml` (runs on obs.lock change) → immutable artifact → app CI fetch by
SHA256 → tauri bundle → existing sign+notarize pass extended to nested code.

### 5.4 UI (v1)

LIVE sidebar section, one view: preview area (placeholder pre-M-L6) + source
toggles (Screen/Window/Camera/Mic, add image/text) · destination rows {preset
dropdown, key field (masked, keychain-backed), enable} + per-destination
advanced (dedicated encoder, D2) · GO LIVE · truthful status lights · STOP ·
first-run TCC coach (explains Screen Recording toggle + relaunch) · encoder-
compat prompt (D2). Nothing else.

### 5.5 Non-designs

No daemon (closing Producer ends the stream; laptop-closed = Boomin relay, D4).
No inbound listeners in v1 (any-encoder RTMP *ingest* is a separate future
feature). Live and Publishing share vault + shell only; a Live regression cannot
break posting.

---

## 6. Milestones (★ resequenced per review: bundling attacked first)

| ID | Milestone | Acceptance (all must pass) |
|---|---|---|
| M-L1 | **Engine artifact + bundle law** | `producer-macos` preset + allowlist builds engine from pinned OBS source (obs.lock v1); artifacts assembled into Producer.app per §5.2; app launched **from Finder** (not build dir, not OBS checkout cwd); moving the .app changes nothing; all allowlisted plugins discovered; required source/encoder/service/output IDs asserted post-load; **zero Qt frameworks in dependency closure**; inner→outer codesign sequence passes verification with plugin discovery intact |
| M-L2 | **Headless capture inside Producer.app** | Bootstrap per F3 (incl. obs_post_load_modules) under the invariant §5.1; SCK display source + mic live in the graph; real Screen Recording + mic TCC exercised under Producer's signing identity; graphics backend = Metal-preferred → OpenGL fallback, actual backend recorded |
| M-L3 | **First light** | VideoToolbox (or x264) + AAC → one RTMP destination (Twitch or private YouTube) confirmed LIVE in its dashboard, key pasted into Producer, key sourced from keychain |
| M-L4 | **Multistream** | Twitch + Kick (rtmp_custom template) + YouTube simultaneously live from ONE shared encoder configured via the D2 policy intersection **before start**; A7 answered (VideoToolbox-CBR vs x264 for Kick, documented); kill one destination's network path / invalidate one key → that row fails/reconnects, the other two stay live; ≥30-min soak with AV sync spot-checks (A8) |
| M-L5 | **Host contract** | LiveEngine owner + state machine + FFI wrapper hardened; signals → IPC events; credential-ID flow (§8) enforced end-to-end; reconnect/error surfaces truthful in UI |
| M-L6 | **Preview + camera + UX** | obs_display in Tauri NSView (A6) or documented render-to-texture fallback; camera source; source-selection UX; TCC coach tested from clean permission state |
| M-L7 | **Overlays (D1, last)** | obs-browser + CEF bundled & notarized; acceptance: remote overlay URL renders with transparency + audio; websocket alerts fire; refresh/reload; browser restart; no frontend-event regressions; no Qt dragged in |

v1 release gate = M-L1..M-L6. M-L7 joins per D1's budget rule.

## 7. Risk register (★ reranked per review)

| # | Risk | Level | Mitigation / fallback |
|---|---|---|---|
| R1 | Bundle/plugin/sign/notarize topology | **HIGH** | Attacked first (M-L1 = bundle law); fallback: extract engine from OBS's official signed release for the spike |
| R2 | Host threading + macOS main-thread/TCC integration | **HIGH** | §5.1 invariant is a release gate; UI task handler wired from day one |
| R3 | Service/encoder compat under shared encoding | **HIGH until M-L4** | D2 policy intersection + pre-start configuration; dedicated-encoder escape hatch; x264 path for Kick |
| R4 | Permissions UX (TCC) | MED-HIGH | First-run coach; detect-missing-grant + relaunch guidance |
| R5 | Metal backend maturity (alpha, AS-only) | MED | Metal-preferred, OpenGL fallback (also the Intel backend); backend recorded per run |
| R6 | Preview/Tauri native view | MED (non-blocking) | D3 sequencing; render-to-texture fallback |
| R7 | AV sync / performance | MED-LOW **only after M-L4 soak** | Soak run is the earner |
| R8 | FFI surface size | LOW | ~30 of 676 exports; bindgen |
| R9 | Upstream drift | LOW | obs.lock pinning; deliberate bump PRs |
| R10 | GPL/AGPL compliance | LOW | F1; D5 reproducibility; NOTICE file; legal pass before store distribution |

## 8. Security & credential invariants (★ corrected wording)

> **Stream credentials are never persisted outside the OS keychain and are never
> exposed to the webview, SQLite, analytics, crash metadata, or application
> logs. Rust/native code resolves an opaque credential ID at output creation
> time and supplies the secret directly to libobs in memory.**

Enforcement: UI and the Destination model store `credential_id` only · IPC
responses never contain plaintext keys · service/output errors redacted (may
embed URLs w/ keys) · the obs_data_t holding a key is never serialized ·
memory zeroization best-effort, not a promise · WHIP bearer/publish credentials
inherit the same law. No new inbound network surface in v1; engine downloads
checksum-pinned; capture consent = TCC + visible in-app LIVE state.

## 9. Adversarial acceptance targets (★ now eleven)

A1–A8 as v1.0 (reimplementation smell; assumption timing; CEF-shaped bundle;
shared-encoder platform quirks; licensing of vendored binaries; non-goal adoption
risk; shutdown/sleep/display-reconfig lifecycle; acceptance vagueness), plus:

- **A9 Qt leakage** — prove the shipped artifact's dependency closure contains no
  Qt despite upstream's default plugin graph (M-L1 gate automates this).
- **A10 Host-thread semantics** — no selected plugin/libobs path issues
  OBS_TASK_UI or assumes AppKit main thread in a way our marshalling misses.
- **A11 Credential lifetime** — a stream key must not appear outside keychain +
  transient native memory under: debug logging, output failure, crash report,
  reconnect, serialization.

---

*Review history: v1.0 drafted 2026-08-28 → external adversarial review (verdict:
REVISE, 2 factual blockers + 5 architectural patches, then ACCEPT) → all seven
patches verified against source and folded → v1.1 FROZEN.*
