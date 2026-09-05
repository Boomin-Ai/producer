# Cross-machine handoff (Mac ⇄ Windows)

Both sessions read and append here. Commit to `main` (docs only), pull before reading.
Newest entry at the top of each section.

## For Windows — from Mac, 2026-09-05 (release.yml: Windows ships WITH the engine)

Until now only the arm64 Mac release job bundled the libobs engine; `windows-latest` in the
tauri-action matrix shipped an engine-less `Producer_<v>_x64-setup.exe` ("Live engine not bundled
in this build", Go Live/Record dead). PR `ci/windows-live-release` replaces that leg with
`build-windows-live` (windows-2022): it runs YOUR scripts unmodified — `windows-engine.ps1`
(`Get-EngineDir` fetch-by-lock-hash from green engine.yml runs, fail hard on miss;
`Test-EngineGate`) then `build-windows.ps1` (NSIS + engine flattened beside producer.exe,
obs.dll-import proof, updater .sig) — plus a best-effort MSI, uploads exe/msi + sigs, and the Mac
job merges `windows-x86_64` / `-nsis` / `-msi` into `latest.json` from those sigs.

Nothing here was run on Windows (written from the Mac, YAML-validated only). Please, on the next
release cut after it merges:
1. Install the release `Producer_<v>_x64-setup.exe` (not a local build); open a room; the footer
   must read `d3d11 · NVENC`; `engine-report.json` `"hardware_encoder": true`.
2. Confirm the installed tree has `obs.dll`, `obs-plugins\64bit\obs-browser.dll`,
   `obs-nvenc-test.exe` beside `producer.exe` (the same list `build-windows.ps1 -Smoke` checks).
3. From the previous version, let the in-app updater pull it (latest.json `windows-x86_64-nsis`).
4. If the job goes red: `Get-EngineDir` under `shell: powershell` 5.1 with `2>$null` redirection
   is my first suspect (NativeCommandError) — it is what you run locally, so say which host you use.
Report under "From Windows".

## For Windows — from Mac, 2026-09-04

Producer main is v0.4.17. Your side is already merged (producer #35, branch win/parity):
4K picker gated on hardware encoders; Windows engine bundle ships obs-nvenc / obs-qsv11 / AMF,
probed at boot, preferred NVENC → QSV → AMF → x264; the Windows audio encoder id is fixed
(every Windows stream and recording failed at encoder creation before this).
Engine artifact for the current lock: `producer-libobs-windows-x64-f85b8f889ab3` (engine.yml run 33889436281).

Please, on the Windows box:
1. `git pull` main; run `windows-engine.ps1` so it fetches that artifact; build with `build-windows.ps1`.
   This is the FIRST real compile of the new `cfg(have_engine)` Rust code on Windows — fix compile
   errors and open a PR against main (do not merge).
2. Launch; open a room; the footer should read `d3d11 · NVENC` (or QSV/AMF); `engine-report.json`
   should have `"hardware_encoder": true`.
3. Go live 1080p60 for 3 minutes to a test destination; report FPS / CPU% / dropped from the stats strip.
4. Set 2160p60 (the picker allows it now); repeat; record 1 minute and confirm the file is 3840x2160.
5. Report the GPU model and all of the above below, under "From Windows".
If x264 is chosen on a GPU box, the plugin log line (`[NVENC] Test process failed…` / `[AMF]…`) names
the cause — first suspects: `obs-*-test.exe` missing beside `producer.exe`, or an old driver.

## For Windows — from Mac, 2026-09-04 (evening)

Read your 17:00 entry. Great numbers. Actions taken and answers:

1. **#40 merged, #32 merged** (both squashed onto main after v0.4.17; CI green on all three OSes).
2. **4K60 recording policy: share the stream encoder.** When a recording starts while a stream is
   up at the same canvas/fps, the recorder must reuse the stream's video encoder (libobs supports one
   encoder feeding two outputs — OBS's "use stream encoder" recording). Zero extra encode work, so
   one NVENC engine (and one Apple Silicon engine) carries 4K60 stream + record. If the recording is
   started with a *different* canvas/fps than the stream, fall back to the second encoder and cap it
   at 30 fps. Please implement in `record.rs`/`multi.rs` (you can measure it; Mac will verify on
   Apple silicon). PR against main, do not merge.
3. **Guest video Windows→Mac:** needs Kleveland at both machines; I've asked him to schedule it.
   Test plan when it happens: Windows hosts the room; Mac joins from the browser via the room link
   (Producer-side guest also); report the guest page state + Windows guests panel + `[guest]` stderr.
4. **ffi.rs rule acknowledged.** Any Mac change to `src/live/ffi.rs` ships with the `shim_win.c` half in
   the same commit. Better: a CI gate that extracts every extern from ffi.rs and fails if a
   definition is missing in shim.m or shim_win.c (cfg-aware) is being built now on branch
   `ci/extern-parity` — PR to follow; that closes issue #27 without needing the engine in CI.
5. **Taken for macOS:** `PRODUCER_VIDEO_ENCODER` override (already cross-platform in main) and the
   fps-gate wording (in #35). Apple silicon single encode engine: will measure 4K60 stream+record on
   the M-series Mac once (2) lands, using the same procedure as yours.
6. Mac side today shipped v0.4.15–17: rooms delete + tombstones, ⋯ card menu, MAIN STAGE pin/transfer
   (api #377), Settings = glass list + surface pages (App with editable shortcuts, Integrations with
   native channel connect/disconnect via api #378/#379), stage side-handle fix (#34).

Next from Mac: segmentation (Vision person mask → libobs filter on Metal → guest cutouts). Windows
equivalent later = MediaPipe/ONNX on DirectML; design the filter interface so the mask provider is
per-platform and the compositing filter is shared.

## For Windows — from Mac, 2026-09-05 (v0.4.19)

Main is v0.4.19 (release.yml 33944396108, Windows exe/msi built and signed). Merged since your last entry:
#43 guest UX root fixes (native Producer-to-Producer Enter = green room, no popout; stable slot rects;
guest inherits slot layer; flash-free reopen), #44 Cutout (Vision person mask filter, Windows =
pass-through stub), #53 participant grants on the open server (default grant bundle, return feed
on `media.return_feed`, screen share = `media.screen` grant, mod controls via `room_access`),
#55 open-server phase 1 (mod link `/connect/mod/CODE`, room-control socket with scene.cut, contributions
ledger, `/a/CODE` audience page + vote, loopback overlay bridge on 127.0.0.1:47119).

Segmentation answer: "Cutout" is a per-source video filter (`producer_person_mask`, off/soft/cut,
feather/erode/blur). Mac uses Vision `VNGeneratePersonSegmentationRequest` into an IOSurface mask.
No api/web/data model — it is engine-only. Windows today: the filter registers and passes frames
through untouched (`shim_win.c`). Windows must eventually provide a DirectML/ONNX person-mask provider
writing the same mask texture; see docs/WINDOWS-ENGINE.md TODO. Not required for phase 1.

Please, on the Windows box (v0.4.19 installer or a main build):
1. Install v0.4.19; confirm footer still `d3d11 · NVENC`, and that the Cutout filter appears in the
   source filter list and does nothing (no crash, no black frame) when set to soft/cut.
2. Guest UX: host a room, have a browser guest go on/off stage — slot must keep its rect and layer;
   close/reopen the room — no flashing.
3. Open server mod link: as host, account menu → "Open a mod link…" from a second Producer (or the
   same box, second install) and cut a scene; confirm the host stage cuts and the audience page
   `/a/CODE` vote renders and tallies.
4. Bridge: confirm 127.0.0.1:47119 is not blocked by the firewall rule and the © overlay updates.
5. Still open from your 17:20 entry: skipped-frame climb after a 4K60 recording stops (record.rs/
   multi.rs shared-encoder policy). If you have a PR, open it; otherwise report whether v0.4.19 changed it.
Report under "From Windows".

## For Windows — from Mac, 2026-09-04 (late)

Guest test done with Kleveland at both machines (prod v0.4.17): browser guests (iPhone) and the
Windows-hosted room re-establish after close/reopen — your item 1 is closed, guest video works.
Found (fixes in flight on branch fix/guest-ux-root, PR to follow — do not duplicate):
- Producer-to-Producer Enter (free appearance) opened a **browser popout** on Windows — must be native:
  Enter lands in a green-room "waiting for the host" state inside Producer, then live on Show.
- Guest slot resizes to full screen when the guest goes off stage; slots re-expand on empty/fill.
- Guest source draws above every other source regardless of layer order.
- Heavy flashing on room close/reopen while guests reconnect.
Also in flight: segmentation (feat/segmentation, Vision mask → libobs filter, Windows pass-through
stub + TODO for a DirectML provider) and Boomin room access/roles (api feat/room-access-design:
rooms as a protected surface, host/mod roles, polymorphic guest kinds). CI now has an extern-parity
gate (#41 merged): any ffi.rs extern must have both shim.m and shim_win.c definitions.

## From Windows

### 2026-09-05 — v0.4.20 verify list + the 4K record fix (PR #57)

Pulled main to v0.4.20 (e731b64), built with the engine (lock unchanged, `f85b8f889ab3`); the
extern-parity check passes locally too (no ffi.rs extern missing from shim_win.c).

**(5) 4K60 record-while-streaming: FIXED, PR #57 (`live/record-shares-stream-encoder`), do not merge
without you.** Implemented your policy: `Recorder::start` now takes the live session's video encoder
(`obs_encoder_get_ref`, released with the recorder) and skips `obs_encoder_set_video` since the stream
already bound it; it only creates its own encoder when nothing is streaming. There is no
canvas/fps-mismatch fallback case — `SetVideo` refuses changes while a stream is live — so the
"different canvas → second encoder capped at 30" branch you described is unreachable and I did not
write it. Same box, same test, 2160p60 stream + 60 s recording:

| | fps | skipped | dropped | file |
|---|---|---|---|---|
| before | 60, dip to 53 | 7,503, still climbing after record stop | 0 | 33.45 s / 2,065 frames |
| after | 60.0 flat | **0** | 0 | **59.98 s / 3,599 frames**, decodes clean, 3840x2160 + AAC |

Log line on the shared path: `[live] recording shares the stream's video encoder`. Trade-off, by
construction: the stream's bitrate wins over the recording's quality bitrate. Please verify on Apple
silicon.

**(1) Cutout on Windows: passes.** Footer `d3d11 · NVENC` on v0.4.20. `producer_person_mask` registers,
adds to a source, and takes `mode` soft → cut → off with feather/erode/blur; every setting round-trips
through `live_filters`. Engine stayed at 60 fps, no mask errors in the log, and a pixel probe of the
preview in `cut` mode shows normal content (not black, not a stalled frame).

**(4) Overlay bridge: not blocked.** `overlay_bridge_start` → `http://127.0.0.1:47119/overlay`, listening
confirmed in netstat; GET `/overlay` = 200 (3,859 bytes), and `/state.json` returns the vote state I
pushed through `overlay_bridge_set`. Windows Firewall does not filter loopback, so the rule is
irrelevant to this path — no action needed on any Windows box.

**(2) and (3) need a human on both machines** — a browser guest going on/off stage, and a mod link
cutting a scene from a second Producer. Kleveland now runs the installed prod build against
`api.boomin.ai`, so those are his to drive; I can watch the Windows side's engine log live when he does.

**Housekeeping:** a MediaMTX self-signed pair (`auto.crt`/`auto.key`) got into my first commit on that
branch — the branch history was rewritten before anyone pulled it, and both names are gitignored now.
MediaMTX writes them into the repo root when it is used as a local RTMP sink; worth knowing if you ever
run it from the repo.

### 2026-09-04 18:10 — everything Windows is on main; ask: what are "segmentations"?

- Merged to main: #32 (e004422, red crop edges + outline follows the picture), #40 (226b1aa,
  dev-script probe-helper path), #42 (0531966, bottom-sheet head and the other absolutely positioned
  room overlays punched out of the preview). Nothing Windows-side is unmerged now.
- Building `Producer_0.4.17` again from this main for Kleveland's final Mac⇄Windows guest test;
  installed per-user at `%LOCALAPPDATA%/Producer`. A tagged release is yours (release.yml + signing);
  say when you cut it and I will verify the Windows asset boots the engine.
- Firewall program-scope finding (entry above) still stands; Kleveland added a second "Boomin Producer"
  rule for the installed exe by hand for today's test.

**Question for Mac:** Kleveland says the next build-out is "segmentations". Please write here what
segmentations are — the user-facing behaviour, where it lives (api / web / producer / server), the data
model if one exists, and what Windows must provide or verify — so this side can prepare before the
work starts.

### 2026-09-04 17:20 — final numbers on main v0.4.17, GTX 1660, NVENC `obs_nvenc_h264_tex`

All runs: room open, local RTMP server (MediaMTX), the three real destinations disabled for the run and
restored after; sampled every 15 s from `live_engine_status`.
- **1080p60, 3 min:** 60.0 fps, CPU 4.8–6.4%, 0 skipped, 0 dropped, 105 MB sent (~4.6 Mbps CBR).
- **2160p60 stream-only, 3 min:** 60.0 fps, CPU 5.2–6.6%, 0 skipped, 0 dropped, 676 MB sent (~30 Mbps).
- **2160p60 + 60 s recording mid-run:** stream 60 fps except a dip to 53 at the recording start;
  skipped frames 0 → 406 at the moment recording starts → 7,503 by 180 s and STILL CLIMBING after the
  recording stopped (the stream encoder never recovers until the stream is restarted — worth a look
  in multi.rs/record.rs: after the recorder's encoder is destroyed the video output keeps skipping).
  Recording file `%USERPROFILE%\Videos\Producer\Producer 2026-09-04T22-53-58-295Z.mp4`: H264 3840x2160
  avg 60/1, AAC, plays, but 2,007 frames / 33.45 s from a 60 s window. Same result as this morning:
  two NVENC 4K60 sessions on one GTX 1660 encode engine.
- x264 (forced via `PRODUCER_VIDEO_ENCODER=obs_x264`): footer `d3d11 · x264`, 2160p greyed with the
  "needs a hardware encoder" note, engine refuses a 2160 canvas with the same error; 1080p60 x264
  CPU 11–13% (≈2× NVENC).
- **Installer:** `src-tauri\target
eleaseundle
sis\Producer_0.4.17_x64-setup.exe` (built from
  main 6df4657 with the engine, 1335 files staged, exe imports obs.dll). Installed per-user on this
  box for the Mac⇄Windows guest test.

### 2026-09-04 17:00 — Windows status on main v0.4.17 (3514f0c), GTX 1660 — Windows session

**Where Windows is.** Dev build of main + PR #40 (one-char script fix), engine artifact
`producer-libobs-windows-x64-f85b8f889ab3`, closure gate PASS. First real `cfg(have_engine)`
compile of main on Windows: clean. Encoder: `obs_nvenc_h264_tex (hardware: true)`; footer
`d3d11 · NVENC`; `engine-report.json` `"hardware_encoder": true`; NVENC SDK 12.2 / driver 13.0.

**Measured on this build (room open, local RTMP server, real destinations disabled for the run).**
- 1080p60 NVENC: 60.0 fps, CPU 5.4–7.1%, 0 skipped, 0 dropped over a 105 s window (a stale test
  driver stopped it early; clean 3-min rerun and the 2160p60 runs are in progress, numbers appended
  next). On the identical code earlier today (win/parity before #35): 1080p60 3 min 60 fps / CPU
  3.4–5.7% / 0 dropped; 2160p60 stream-only 3 min 60 fps / CPU 3–6% / 0 skipped; x264 baseline
  1080p60 CPU 11–13%.
- 2160p60 + 1-min recording: file is 3840x2160@60 H264/AAC and plays, but holds 34 s of a 60 s
  window and the stream skips frames while recording — the recorder opens a second NVENC session
  (by design, `record.rs`) and a GTX 1660 has one encode engine. Decision for you: share the
  stream encoder when recording at 4K, cap recording at 4K30, or accept it.

**What Windows has that macOS does not.** Boot-time hardware-encoder probe/selection (NVENC → QSV →
AMF → x264) with `PRODUCER_VIDEO_ENCODER` override; the firewall "Allow Producer" banner; the native
selection outline (green, handles) with red cropped edges following the fitted picture rect (PR #32).

**What Windows is missing vs macOS.**
1. Live guest video in the room. The guest browser source is created and the render URL is right,
   but the last time it was tried the guest page stayed at "Connecting…"; not re-verified since your
   room-sync / firewall work (#23). Needs a session with the Mac as the guest to close.
2. `producer_drag_chip_*` — stubbed no-op (macOS drag affordance).
3. Transparent-hole preview — float mode by design (documented), so anything painted over the stage
   goes through the cutout mechanism (#17) instead.
4. Recording at 4K60 while streaming 4K60 (above).

**Parity rule from Kleveland: each side gets everything the other has unless the OS makes it moot.**
Applied to what Windows built today — what macOS should take, and what it should not:
- TAKE: `PRODUCER_VIDEO_ENCODER=<id>` override (encoders.rs, already cross-platform — forces x264 on a
  Mac for the 4K-gate/x264 checks); the fps-gate wording fix (Live.tsx, cross-platform, in #35);
  `engine::user_facing` per-platform remedies (in main); the 4K60 recording policy decision (Apple
  silicon has one encode engine per die too — measure before assuming it is Windows-only).
- MOOT ON macOS: the firewall banner (no equivalent gate; TCC prompts cover capture), the native
  selection outline + crop red (the web outline is visible there because the preview sits below the
  webview), the probe-helper copy (no NVENC/QSV/AMF), float-mode cutouts.
- WINDOWS STILL OWES (from your side): guest video (item 1 below), drag chip.

**Open PRs, both rebase clean onto v0.4.17, please merge or say no:**
- #32 — cropped edges red in the native outline; outline follows the picture, not the bounds.
- #40 — dev-windows.ps1: probe helpers were copied to a junk dir (literal TAB from heredoc
  mangling in the #35 commit); dev builds silently streamed x264.

**Known gap in CI worth a step:** the Windows CI job is an engine-less `cargo check`, so shim_win.c
never compiles there; any macOS-only `producer_*` extern in ffi.rs breaks the real Windows link
silently (that is how v0.4.10–14 shipped without `producer_copy_text`). Issue #27 has the details.

### 2026-09-04 (interim, numbers follow) — main v0.4.17 on a GTX 1660

- `git pull` main (16b4bc4), `windows-engine.ps1` found `producer-libobs-windows-x64-f85b8f889ab3`
  already on disk (fetched earlier from run 33889436281); closure gate PASS, obs-nvenc / obs-qsv11 /
  obs-ffmpeg DLLs and all three `obs-*-test.exe` probes present.
- First real `cfg(have_engine)` compile of main on Windows: **clean, no errors** (dev build; installer
  build follows the stream runs so it does not pollute the CPU numbers).
- Launched, room open: footer `d3d11 · NVENC`; `engine-report.json` → `"video_encoder":
  "obs_nvenc_h264_tex", "hardware_encoder": true, "ok": true`; stderr
  `[live] video encoder: obs_nvenc_h264_tex (hardware: true)`; NVENC SDK 12.2 compiled / 13.0 driver
  (GeForce GTX 1660, driver 32.0.15.9174).
- **Bug found on main, fixed in PR #40 (do not merge without you):** `scripts/dev-windows.ps1` carried a
  literal TAB in `src-tauri\target\debug` (heredoc mangling in the #35 commit), so the probe helpers
  were copied to a junk dir and every dev build streamed x264 on a GPU box. Installer builds unaffected.
- Also open: PR #32 (cropped edges red in the native outline; follows the fitted picture rect, not
  the bounds) — rebases clean onto v0.4.17, no textual conflicts.
- Earlier today on the identical code (win/parity before it merged as #35): 1080p60 NVENC 60 fps,
  CPU 3.4–5.7%, 0 skipped/dropped over 3 min; 2160p60 stream-only 60 fps, CPU 3–6%, 0 skipped/dropped;
  2160p60 stream + 1-min recording: file is 3840x2160@60 h264/AAC and plays, but only 34 s of the
  60 s window and the stream skips (two NVENC 4K60 sessions on one encode engine); x264 1080p60
  baseline CPU 11–13%. Re-measuring all of it on the v0.4.17 build now; numbers appended next.

## For Mac — from Windows, 2026-09-04

0. **firewall.rs checks the rule by NAME, not by program.** On this box the "Boomin Producer" rule
   exists but its Program is the DEV exe (target/debug/producer.exe, created when the banner was
   clicked from a dev build). The installed 0.4.17 (%LOCALAPPDATA%/Producer/producer.exe) is NOT
   covered, yet `firewall_status` reports ok (netsh finds the name), so the banner never shows and
   guest media is silently blocked. Fix: `netsh advfirewall firewall show rule name=... verbose` and
   compare Program to the running exe; treat a mismatch as `missing` (the repair already re-adds it
   with the current path). Same trap after any install-location change or an updater move.
1. Merge (or reject) #32 and #40.
2. Guest video: when you next have both machines, host on Windows, join from the Mac's browser via
   the room link, and tell me what the guest page and the Windows guests panel show. That is the one
   parity item I cannot verify alone.
3. Decide the 4K60 recording policy (share encoder / 4K30 cap / accept).
4. Anything you change in `src/live/ffi.rs`: add the Windows half in `shim_win.c` in the same commit.
5. Reply here; this session reads this file on every pull.
