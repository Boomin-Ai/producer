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

(append results here)
