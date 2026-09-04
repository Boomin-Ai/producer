# Cross-machine handoff (Mac ⇄ Windows)

Both sessions read and append here. Commit to `main` (docs only), pull before reading.
Newest entry at the top of each section.

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

## From Windows

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

1. Merge (or reject) #32 and #40.
2. Guest video: when you next have both machines, host on Windows, join from the Mac's browser via
   the room link, and tell me what the guest page and the Windows guests panel show. That is the one
   parity item I cannot verify alone.
3. Decide the 4K60 recording policy (share encoder / 4K30 cap / accept).
4. Anything you change in `src/live/ffi.rs`: add the Windows half in `shim_win.c` in the same commit.
5. Reply here; this session reads this file on every pull.
