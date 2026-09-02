# Windows engine port — the complete briefing

For the session doing this work: everything below was verified against this
repo on 2026-09-02, right after v0.4.2 shipped. Read this first; ask the
macOS session (cross-session message) when reality disagrees.

## What "the engine artifact" is

The Mac build carries `engine/artifacts/producer-libobs-macos-arm64-<hash12>/`:

    Frameworks/   libobs.framework, graphics backends, dylib closure,
                  Chromium Embedded Framework.framework, Producer Helper*.app
    PlugIns/      the ALLOWLIST, each .plugin with its own Resources:
                  coreaudio-encoder image-source mac-avcapture mac-capture
                  mac-videotoolbox mac-virtualcam obs-browser obs-ffmpeg
                  obs-filters obs-outputs obs-transitions obs-x264
                  rtmp-services text-freetype2
    bin/ licenses/ manifest.json signing/

`<hash12>` = first 12 of sha256(engine/obs.lock). Everything is pinned by
`engine/obs.lock` (OBS 32.1.2 + obs-browser/obs-websocket submodule commits +
an obs-browser patchset under engine/patches — the patches are REQUIRED,
they add the offscreen capture Producer depends on and rename CEF helpers).

## The seam that makes the port tractable

`src-tauri/build.rs::link_live_engine()` returns immediately when
`CARGO_CFG_TARGET_OS != macos`. That single early-return is why Windows
builds today: `have_engine` is never set, all ~50 `cfg(have_engine)` sites
in `src/live/` compile to stubs ("live engine not bundled in this build"),
and shim.m is never handed to cc.

The port = make that function do for Windows what it does for macOS:
find a `producer-libobs-windows-x64-<hash12>` artifact, emit link flags,
set `have_engine`. Then fix what fails to compile — which is a KNOWN,
bounded list (below), because everything else in src/live is plain libobs C
API and cross-platform already.

## Workstream, in dependency order

1. **Engine artifact build** — extend `.github/workflows/engine.yml` with a
   `windows-2022` job (current job is macos-15 only). obs-studio 32.x builds
   on Windows with its own obs-deps prebuilt bundle; the plugin allowlist
   maps to: obs-browser (CEF windows_x86_64 + the SAME patchset — verify it
   applies, it touches obs-browser CMake + OSR code), win-capture,
   win-dshow (camera in AND the virtual camera out — DirectShow, replaces
   BOTH mac-avcapture and mac-virtualcam), win-wasapi (replaces
   coreaudio-encoder's capture role; keep ffmpeg aac for encode),
   obs-ffmpeg obs-filters obs-outputs obs-transitions obs-x264
   rtmp-services text-freetype2 image-source, obs-qsv11/nvenc later.
   Layout: bin/ (obs.dll, obs-frontend-api…), obs-plugins/64bit/,
   data/, cef/. Update `scripts/engine-lib.sh::artifact_name` to be
   os-aware. Zero-Qt gate applies on Windows too (`check-no-qt.sh`).

2. **build.rs** — windows branch: `cargo:rustc-link-search` the artifact's
   bin/, link `obs` (import lib), set `have_engine`. Do NOT compile shim.m;
   instead add `shim_win.c` (see 3) via the same cc::Build.

3. **The shim** — `src/live/shim.m` is the ONLY Objective-C. Port surface,
   function by function (ffi.rs declares them; give Windows the same symbols
   from a `shim_win.c`):
   - `producer_preview_attach/set_frame/detach/set_hidden` → a child HWND
     (WS_CHILD) over/under the WebView2 hwnd; gs_init_data.window takes the
     hwnd on Windows. Start with the ABOVE-webview float mode only — the
     transparent-hole mode and `producer_preview_prepare_window` can return
     0/no-op (the room UI already fully supports float mode).
   - `producer_apply_window_vibrancy` → no-op returning 0 (glass is
     macOS-only by design; tauri.macos.conf.json holds the transparent
     window so base config is already solid on Windows).
   - TCC/permission functions (`producer_av_request_access`, screen-recording
     checks) → no-op "granted"; Windows prompts per-app at capture time.
   - System-extension / camera-extension calls → no-op; the virtual camera
     on Windows is win-dshow's DirectShow filter, registered at install time
     (regsvr32 in the NSIS/MSI hooks), not activated at runtime.
   - `run_on_main` semantics: libobs on Windows does not require the
     macOS main-thread marshalling (that was a Metal/Swift dispatch_assert,
     see the A10 note in engine.rs). Keep the calls, make them direct.

4. **engine.rs specifics** — `reset_video("libobs-metal.dylib", …)`:
   Windows module is `libobs-d3d11.dll` (fallback `libobs-opengl.dll`).
   The graphics_backend report strings feed the UI; add "d3d11".
   CEF cmdline args (`--use-fake-ui-for-media-stream`,
   debug `--remote-debugging-port=9223`) carry over unchanged.

5. **Bundling** — `assemble-engine-bundle.sh` is bash+codesign, macOS-only.
   Windows equivalent: copy the artifact next to the exe in the tauri
   bundle resources (`tauri.windows.conf.json` bundle.resources), no
   signing order needed (sign the final installer only). obs finds plugins
   via `obs_add_module_path` — the same PRODUCER_ENGINE_PLUGINS-style
   explicit registration engine.rs already has is the easy path; bundle
   layout can mirror the artifact 1:1.

## Landmines already hit on macOS — check them on Windows day one

- **Hardware H.264 vs CEF offscreen readback**: on macOS, hw-decoded H264
  never reaches the OSR surface (guest tiles black while the page reports
  healthy). The web side now prefers VP8 (Boomin web PR #506) so Windows
  inherits the mitigation — but verify the D3D11 OSR path independently
  before trusting any green.
- CEF refuses odd process contexts; on Windows OSR inside the tauri exe is
  the normal obs-browser arrangement, but keep the CDP port (9223, debug
  builds) — probing the render pages beats guessing, every time.
- The engine boots at the STORED video mode via `<live-dir>/video.json`
  (engine.rs stored_video/persist_video) — path logic is already
  cross-platform.
- Guest thumbnails + per-source meters (v0.4.2) are plain libobs
  (gs_texrender/gs_stagesurface + audio capture callbacks) — they should
  work unmodified once the engine links.

## What NOT to port

- window-vibrancy/glass (macOS identity), camera system extension,
  TCC machinery, notarize.sh/entitlements, Producer Helper app renames
  (CEF Windows uses a subprocess exe CMake handles).

## Definition of done

`cargo check` with have_engine on windows-2022 CI; app opens a room;
preview HWND shows the composite; a browser-source guest renders (CDP
9223 verifies); go-live to one RTMP destination; THEN win-dshow virtual
camera. In that order — each step is independently shippable.
