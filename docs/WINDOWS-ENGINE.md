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

---

# Verified reality (2026-09-02, rung 1 + first CI runs)

Everything above was written from the macOS side before any Windows build had
run. This section is what the port actually found. Where the two disagree, this
section wins.

## Rung 1 is done

`build.rs` links the engine on Windows and sets `have_engine`, so the ~48
`cfg(have_engine)` sites compile for real. Confirmed in cargo's build record,
with a negative control (`PRODUCER_ENGINE_DIR=/nonexistent` correctly reports
"building without live support").

Two corrections to the plan above:

- **The obs-browser patchset IS needed on Windows, for a different reason than on
  macOS.** `cmake/os-windows.cmake` defines no Qt loop and calls no
  `find_package(Qt6)`, so every `ENABLE_BROWSER_QT_LOOP` region compiles out and
  CEF pumps its own multi-threaded message loop. That much was right. What it
  missed is that TWO files include Qt headers UNCONDITIONALLY:
  browser-client.cpp (`QApplication`/`QThread`/`QToolTip`, plus an unguarded
  `QToolTip` call in `OnTooltip`) and obs-browser-source.cpp (`QApplication`).
  Upstream gets away with it because its Windows build has the frontend, and
  therefore Qt, present. Ours does not:
  `error C1083: Cannot open include file: 'QApplication'`.

  The fix was an ontology correction to the patch, not a special case. It had
  guarded those includes with `#ifndef ENABLE_BROWSER_DISPATCH_LOOP` -- "we are
  not using the libdispatch pump" -- which is a statement about the PUMP, and is
  true on Windows. They are now guarded with `#ifdef ENABLE_BROWSER_QT_LOOP` --
  "Qt is present" -- which is the property actually being tested, is upstream's
  own signal for it, and is false in both our builds. Two lines, one meaning,
  both platforms.

  `producer-windows` still sets `ENABLE_BROWSER_DISPATCH_LOOP` FALSE and
  `producer-macos` TRUE: the pump genuinely differs per platform, the Qt question
  does not. Changing the patch re-keyed both artifacts --- see the pinning note
  below.

- **`CMAKE_COMPILE_WARNING_AS_ERROR` is FALSE on Windows.** OBS defaults it ON
  (`cmake/common/compiler_common.cmake`) and we build a subset configuration
  upstream never tests, so we hit MSVC warnings in UPSTREAM code that upstream CI
  does not --- C4244 double-to-int in obs-browser-source.cpp's
  non-shared-texture frame-rate path. Failing our engine build on a warning we
  will not fix in someone else's source buys no signal.

- **No import library is required to link.** An extracted OBS release ships no
  `obs.lib`, which is why the extract-based spike could not link the normal way.
  The extern blocks in `ffi.rs` carry
  `#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]`,
  which needs no import lib at all. `raw-dylib` is a SOURCE attribute — it is
  not a valid `cargo:rustc-link-lib` kind, and build.rs must not emit one.
  A source build does produce `obs.lib` and it is staged anyway, so linking the
  ordinary way keeps working.

Also fixed on the way: `macos-private-api` was enabled unconditionally in
`Cargo.toml`, so bare `cargo check` on Windows failed on main. Releases worked
because the tauri CLI rewrites Cargo.toml before building. It is now
target-scoped.

## The engine artifact on Windows

    bin/                obs.dll + its dependency closure
    obs-plugins/64bit/  the allowlist, obs-browser-page.exe, AND ALL OF CEF
    data/               libobs + per-plugin data
    licenses/ manifest.json

Build output lives at `build_producer/rundir/Release/{bin/64bit,
obs-plugins/64bit,data}` — the Windows CMake setup writes runtime outputs
straight into rundir, with no post-build copy step.

**Stage `bin/` wholesale.** obs.dll's dependency closure includes non-DLL
runtime files, and a `*.dll` glob silently drops them.

**THE ENTIRE CEF PAYLOAD GOES IN `obs-plugins/64bit`, BESIDE obs-browser.dll ---
not in `bin/`.** Three independent mechanisms all resolve to the module's own
directory, and each was read in the source rather than inferred:

1. `os_dlopen` (libobs/util/platform-windows.c) calls
   `SetDllDirectoryW(<the module's own directory>)` before `LoadLibraryW`, so
   obs-browser.dll's import of libcef.dll resolves from `obs-plugins/64bit`.
2. obs-browser sets `locales_dir_path` to `<module dir>/locales` explicitly.
3. obs-browser does NOT set `resources_dir_path`, and CEF's documented default
   for it is the directory containing libcef.dll --- so `icudtl.dat` and the
   `.pak` set must sit beside libcef.dll too.

This is also exactly how a real OBS Windows install is laid out. It is staged
from `CEF_ROOT` (`.deps/cef_binary_*_windows_x64/{Release,Resources}`) rather
than from rundir: deterministic, and it cannot accidentally scoop
non-allowlisted plugins out of the build tree. `*.lib` is excluded --- link-time
input, not runtime, and `cef_sandbox.lib` alone is hundreds of megabytes.

**`obs-browser-page.exe` is the CEF subprocess, and it ships in
`obs-plugins/64bit/`, not `bin/`.** Without it the plugin loads, CefInitialize
succeeds, and every browser source is black because no render/GPU/network
subprocess can spawn. Guests ARE browser sources. The closure gate treats it at
the same severity as `libcef.dll`.

## The Windows plugin allowlist is not the macOS one renamed

`win-dshow` is BOTH camera input and virtual camera, replacing `mac-avcapture`
and `mac-virtualcam` at once. `win-wasapi` takes `coreaudio-encoder`'s capture
role. And the trap the shared/per-os split exists to catch: **the freetype text
source is `text-freetype2` on macOS and `obs-text` on Windows.** It is not
shared. `check_plugin_lists()` asserts the per-os lists stay disjoint from the
shared one.

## What obs.lock pins, and what it deliberately does not

**The lock pins what we MODIFY. The obs commit pins everything else,
transitively. Adding a pin re-keys both platforms' artifacts.**

That is why `submodules` names `plugins/obs-browser` and
`plugins/obs-websocket` and not `deps/libdshowcapture/src`, and the asymmetry is
deliberate rather than an oversight. We patch obs-browser, so its exact content
is ours to assert. libdshowcapture we take as-is: `submodule update --init`
checks out the gitlink SHA recorded in the pinned obs commit, with no branch
tracking involved, so it is already determined byte-for-byte by
`obs.commit`. Restating a determined fact in the lock would re-key every
artifact on both platforms and buy nothing.

Do not "fix" this in either direction without that argument changing.

libdshowcapture also carries its own submodule
(`external/capture-device-support`), so it is initialised `--recursive` —
scoped to that one path, so obs-websocket does not drag in a dependency tree for
a plugin built with `ENABLE_WEBSOCKET` FALSE.

## Windows-runner facts that cost real CI runs

- **Line endings are load-bearing.** Git for Windows ships `core.autocrlf=true`
  in its system config and `actions/checkout` does not override it. A CRLF
  checkout changes `sha256(obs.lock)` — which IS the artifact identity — so the
  two platforms would name their artifacts off different hashes from the same
  lock. It also breaks the patchset sha256, and Git Bash treats a trailing CR as
  part of a token. `.gitattributes` pins the hash-critical and Bash-executed
  files to LF. (LF: `a023c6871ea8`. CRLF: `a6b79a815958`.)
- **`python3` on Windows may be an App Execution Alias** that exists on PATH and
  fails when run. Probe interpreters by EXECUTING them; presence is not proof.
  `resolve_python()` in engine-lib.sh does this.
- **The pythons on Windows are native builds** and cannot open the MSYS
  `/d/a/...` paths Git Bash hands them. `host_path()` converts with `cygpath -m`
  (forward slashes, so no re-escaping inside a python string literal) and is a
  no-op on macOS. Before this, the Qt scan given an absolute path walked NOTHING
  and reported a clean pass.
- **macOS ships bash 3.2**, so nothing in `scripts/` may use `mapfile`,
  `readarray`, `declare -A`, `${x,,}` or `[[ -v ]]`.
- **A shallow clone has no tags**, so OBS's `git describe` versioning yields
  `fb4d98b-modified` and configure dies with `list index: 1 out of range` /
  `VERSION ... format invalid`. `-DOBS_VERSION_OVERRIDE` is the documented fix
  and did NOT take effect, because `architecture.cmake` spawns a NESTED cmake for
  the 32-bit sub-build and that child does not inherit command-line cache
  entries. The build tags the clone with the lock's ref instead. This is not
  redundancy — it is the only fix with the right SCOPE: an argument lives in the
  process you passed it to, a tag lives in the repo where every nested tool
  finds it.
- `tar --cd` is bsdtar-only; `-C` works on both bsdtar and GNU tar.

## Gate philosophy

`engine-closure-windows.sh` is a sibling of the macOS gate, not a port — the
macOS one is otool/@rpath/.framework to its bones. It over-approximates on
purpose: a false alarm is cheap, a false pass ships a broken engine. Two rules
learned the hard way:

1. **A gate that examines nothing is not a clean closure.** It fails if python
   cannot see the stage dir, and fails if the Qt scan examined zero binaries.
2. **Check the whole payload, not its most famous file.** libcef.dll present is
   not CEF present.
3. **Over-approximate: assert things whose failure mechanism you do not know
   yet.** `obs-browser-page.exe` was made a fatal check on the macOS session's
   advice, purely on consequence --- browser sources go black and nothing else
   would catch it. Only later did the build reveal WHY it would go missing:
   obs-browser's `cmake/os-windows.cmake` declares
   `add_executable(obs-browser-helper WIN32 EXCLUDE_FROM_ALL)`, so the default
   target never builds it. The check found the thing it was written to find, for
   a reason nobody had guessed. A gate justified by consequence outlives the
   mechanisms you happen to know about.

## Two kinds of fact, checked separately

The one lesson worth carrying out of this port:

> **Build-system facts and source facts are different facts. Checking one is
> not evidence about the other.**

`cmake/os-windows.cmake` defines no Qt loop and calls no `find_package(Qt6)`.
Verified, and true. From it I concluded obs-browser was Qt-free on Windows and
said so twice. The sources include Qt unconditionally anyway, and the build died
on `C1083: Cannot open include file: 'QApplication'`.

The repo now carries one example of each biting from the opposite direction:
this one, and the `-DOBS_VERSION_OVERRIDE` case, where the source-level logic in
versionconfig.cmake was exactly what the docs said and the build system still
defeated it by spawning a NESTED cmake the argument never reached.

The concrete rule that falls out, for obs-browser specifically:

> **obs-browser sources assume Qt unconditionally unless already guarded.
> Before adding ANY source file to the build, grep it for `Q[A-Z]` first.**

This has now bitten both platforms independently --- macOS in engine.yml run
33243835356 ("CEF patch fixup 1: guard the remaining unconditional Qt
references") and Windows here. Two data points on two platforms is a pattern,
not an anecdote.

## How a release consumes the engine, and what a lock edit costs

`release.yml`'s arm64 job computes
`producer-libobs-macos-<arch>-<sha256(obs.lock)[0:12]>` from the CHECKED-OUT
lock, then searches the last **10 green `engine.yml` runs** for a run artifact
containing that name, verifies its sha256, and fails hard if it finds none. The
search is NOT branch-filtered, so a green run on a feature branch counts.

Two consequences that are easy to get wrong:

1. **A lock edit re-keys BOTH platforms**, because the hash covers the whole
   file. After any lock change reaches main, one green `engine.yml` run must
   happen before any tag.
2. **`--status success` filters on the RUN, not the job.** A red Windows job
   makes the whole run red, and the macOS artifact inside it becomes invisible
   to `release.yml` even though the macOS job succeeded and uploaded it. So
   while the Windows job is a work in progress, merging a lock edit to main
   would leave macOS releases with no findable engine. Either land the lock edit
   only once Windows is green, or mark the Windows job `continue-on-error` so
   runs conclude green while it is still WIP. Do not merge a lock edit and hope.

## The engine boots (rung 1.5)

`PRODUCER_LIVE_SELFTEST=1` exits 0 on Windows against the CI-built engine:
`ok=true`, `graphics_backend=d3d11` (no OpenGL fallback), zero failed modules,
zero missing ids, 57 sources including `browser_source` with CEF
127.0.6533.120. Five defects sat between a green `cargo check` and that line,
and none of them were visible to the compiler --- see the commit for the full
list. The two most transferable:

- **`raw-dylib` is a statement about WHERE a symbol lives.** It was applied to
  extern blocks declaring macOS SYSTEM symbols (CoreFoundation, GCD, CFRunLoop),
  so rustc synthesised imports for `CFRelease` and friends FROM obs.dll and the
  process died at load with `STATUS_ENTRYPOINT_NOT_FOUND`. System frameworks
  must be `cfg`-gated to their OS, not linked differently on another one. The
  fastest way to find it: parse obs.dll's export table and diff it against the
  FFI declarations.
- **libobs data paths REQUIRE a trailing slash.** `check_path()` does
  `dstr_copy(out, path); dstr_cat(out, file)` with no separator inserted, so
  `.../data/libobs` yields `.../data/libobsformat_conversion.effect` and every
  effect lookup fails. It surfaces as `obs_reset_video failed: d3d11 rc=-1,
  opengl rc=-1` --- a graphics error with a filesystem cause. OBS's own defaults
  all carry the slash.

Also worth knowing: with a null `module_config_dir`, `obs_module_config_path`
falls back to the process CWD and win-capture writes `win-capture/*.json`
there. Dev-selftest-only today (the app always passes a real dir), but a guard
belongs on the full-engine path.

## Windows device vocabulary, enumerated from a real machine

`--live-props` dumps the property names libobs actually exposes, which is the
only trustworthy source for picker code. The id list is per-platform for the
same reason everything else here is. Names only --- run it yourself for values:

| source | properties that matter |
|---|---|
| `dshow_input` (camera) | `video_device_id`, `audio_device_id`, `res_type`, `resolution`, `frame_interval`, `video_format`, `buffering`, `hw_decode`, `deactivate_when_not_showing`, `audio_output_mode` |
| `wasapi_input_capture` (mic) | `device_id`, `use_device_timing` |
| `wasapi_output_capture` (desktop audio) | `device_id`, `use_device_timing` |
| `monitor_capture` (display) | `method`, `monitor_id`, `capture_cursor`, `force_sdr` |
| `window_capture` | `window`, `method`, `priority`, `client_area`, `cursor` |
| `browser_source` (guests) | `url`, `width`, `height`, `fps_custom`, `fps`, `css`, `reroute_audio`, `shutdown` |

Three notes for picker work:

- Audio devices are identified by GUID strings (`{0.0.1.00000000}.{...}`) with
  `default` as a valid id --- not by index.
- `window_capture`'s ids are `title:windowclass:executable`, with `:` in the
  title escaped as `#3A`. Parse accordingly.
- `browser_source`'s `shutdown` is shutdown-on-invisible. It DESTROYS the
  browser when the source stops showing, which matters for anything that
  renders a guest outside the composited scene.

## Still open

- `obs.lock` carries no Windows dependency pins. OBS 32.1.2 has no
  `buildspec.json` at the repo root, so the obs-deps/CEF hashes cannot be read
  from the source tree — add them after CI reports what it actually fetched,
  which is a truer pin than a guessed one.
- Rungs 2-5: room opens -> preview HWND composites -> browser-source guest
  renders -> RTMP out -> win-dshow virtual camera.
- The local R1-fallback extract has 13 plugins and NO obs-browser, so guests
  cannot work against it. Rung 4 needs a CI-built engine.
