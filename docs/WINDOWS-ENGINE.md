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

### The name identifies the INPUTS, not the build

`lock_hash` is `sha256(engine/obs.lock)`, so the artifact name pins the SOURCE
and the patchset --- not the build scripts. A fix to build-engine-windows.sh
changes what the artifact CONTAINS while leaving its name identical. That is
exactly what happened when obs-deps staging was added: two green runs, two
artifacts both called `producer-libobs-windows-x64-b5a0b76dc157`, one of them
missing eleven DLLs.

`release.yml` survives this because it iterates `gh run list` newest-first and
breaks at the first match, so the most recent build of a given lock wins. Worth
knowing that it is run ORDERING doing that work, not the hash --- if the search
ever became order-insensitive, it could resolve a stale artifact by a name that
looks correct. The closure gate is the real defence: a broken artifact does not
reach a green run at all.

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

### The extern-parity gate

The Windows CI leg is an engine-less `cargo check`, which never compiles
`shim_win.c`; a `producer_*` extern declared in `ffi.rs` but not defined in
`shim_win.c` therefore fails only at the real release link, and v0.4.10–14
shipped without `producer_copy_text` that way (#21, #27). The gate is
`scripts/check-extern-parity.sh`: it walks the `extern "C"` blocks of
`ffi.rs` (skipping the `link(name = "obs")` libobs imports and the
macOS-only system-framework blocks), and requires a column-0 C definition of
every shim function in `shim.m` and `shim_win.c` — unconditional externs need
both, `#[cfg(target_os = "macos")]` needs only `shim.m`, `#[cfg(target_os =
"windows")]` only `shim_win.c`. It needs no engine and no compiler, so it runs
first on the Linux CI leg. When it trips, add the definition (a
`// TODO(win): no-op` stub returning the happy-path default is fine) or gate
the extern.

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

## There is exactly one valid shipped layout

`producer.exe` imports `obs.dll` statically, so the loader resolves it BEFORE
any of our code runs --- and it searches the executable's own directory, not
subdirectories of it. So the bundle must FLATTEN the artifact's `bin/` beside
the exe, with `obs-plugins/` and `data/` as siblings:

    producer.exe
    obs.dll, libobs-d3d11.dll, avcodec-61.dll, ...   (contents of bin/)
    obs-plugins/64bit/...
    data/...

`windows_engine_root()` probes for exactly that and nothing else. An engine at
`<exe_dir>/engine` is not an alternative layout --- obs.dll could never load
from there, so that code would be unreachable.

Verified end to end: that layout boots with NO `PATH` entry and NO
`PRODUCER_ENGINE_DIR` --- `ok=true`, d3d11, 12/12 modules, browser_source
present.

### The dev-box trap this hid

Because the loader prefers the executable's own directory, an OBS extract
copied into `target/debug/` for early dev work meant the app was running on
**that** `obs.dll`, not the artifact's --- with `PATH` pointing at the artifact
and having no effect, since the exe directory wins. A selftest reported
`ok=true` while libobs came from a completely different build.

It hid a real defect: the artifact's `bin/` had obs.dll but NOT its dependency
closure. `rundir/Release/bin/64bit` holds what WE build; ffmpeg, zlib, x264,
curl, rist and srt live in the prebuilt obs-deps bundle, and the no-frontend
build never copies them into rundir. Exactly the same shape as the CEF miss:
the piece a full OBS build gets for free from a step we do not run.

To check what a running process ACTUALLY loaded, rather than what you believe
it loaded:

```powershell
(Get-Process -Id <pid>).Modules | Where-Object { $_.ModuleName -match 'obs' } |
  Select-Object ModuleName, FileName
```

The gate now closes this permanently: it walks every PE in the artifact, reads
its import table, and fails on any dependency that is neither shipped nor a
real Windows system DLL. System-ness is tested by existence in System32 rather
than a hand-kept list, so it cannot rot. This is the Windows analogue of the
macOS gate's @rpath closure walk, which the first version of this gate simply
did not have.

## The standalone-render contract

Rendering a source OUTSIDE the composited scene --- a thumbnail, a preview tile,
any `gs_texrender` pass --- has three requirements, and missing any one of them
produces a BLACK frame with no error anywhere. All three are cross-platform;
they are recorded here because rung 3+ needs them and because two of the three
cost the macOS session a day.

Upstream already has the canonical sequence. From
`frontend/utility/ScreenshotObj.cpp` at the pinned commit, verbatim:

```c
gs_blend_state_push();
gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
if (source) {
        obs_source_inc_showing(source);
        obs_source_video_render(source);
        obs_source_dec_showing(source);
} else {
        obs_render_main_texture();
}
gs_blend_state_pop();
```

Copy it. Do not reinvent it.

1. **Right thread.** Every render-target call goes through
   `obs_queue_task(OBS_TASK_GRAPHICS, ...)`. This is the v0.4.3 hotfix rule and
   it applies to any D3D11 readback the Windows port adds.
2. **Clean blend state.** A standalone render inherits whatever blend function
   the context last used, and a leftover `(ZERO, x)` multiplies every pixel to
   nothing. The push/`GS_BLEND_ONE, GS_BLEND_ZERO`/pop above is why OBS's own
   screenshots work. It presents as "readback is broken" when it is "blend
   state is dirty" --- and it hits EVERY source type, so a camera that renders
   black is this, not a visibility problem.
3. **Showing refs.** libobs derives "showing" from scene/output references, not
   from who calls `obs_source_video_render`. A source that is not showing gets
   `WasHidden(true)` forwarded to CEF and STOPS PRODUCING FRAMES;
   obs-browser's whole render body is `if (texture) { ... }`, so it then draws
   nothing. `obs_source_inc_showing`/`dec_showing` is the contract for
   "I am rendering this outside a scene".

   Two follow-ons: the repaint after `WasHidden(false)` is ASYNC, so the first
   capture after inc_showing still gets the stale or empty texture --- allow a
   frame or two. And `browser_source`'s `shutdown` property
   (shutdown-on-invisible) DESTROYS the browser on hide, so with it set,
   recreation takes far longer than that.

Diagnostic shortcut, learned the expensive way: **render a CAMERA source
through the same path as a control.** Camera green + browser black isolates to
the showing gate. BOTH black is blend state, because a camera has no
visibility-gated frame production to lose.

## The signature failure class

> **When a subset build fails, ask what the FULL build does that we skipped.**

Three of this port's hardest bugs are the same bug wearing different clothes,
and all three are a step a complete OBS build performs that ours does not:

| symptom | what the full build does for free |
|---|---|
| `C1083: Cannot open include file: 'QApplication'` | ships the frontend, so Qt headers are present |
| browser sources would render black (`obs-browser-page.exe` absent) | builds the `EXCLUDE_FROM_ALL` helper as a dependency of a target we do not build |
| artifact missing eleven DLLs (ffmpeg, zlib, x264, curl, rist, srt) | copies the obs-deps runtime into rundir during packaging |

Ask it early. It is faster than reading the failure.

## Debugging: check belief against the process

The FIRST move whenever "it works" arrives before you understand why:

```powershell
(Get-Process -Id <pid>).Modules |
  Where-Object { $_.ModuleName -match 'obs' } |
  Select-Object ModuleName, FileName
```

(macOS: `vmmap <pid>` or `lsof -p <pid>`.)

That one line turned "the engine boots against the CI artifact" into "the
engine boots against an extract someone left in target/debug" --- and the
correction exposed a defect the false belief was hiding. On Windows especially:
**the loader prefers the executable's own directory over PATH**, so a stale DLL
beside the exe silently wins over the one you carefully put on the path.

Second move, for the artifact rather than the process: run the closure gate. It
answers "is this thing self-contained" without needing to run it at all.

## Rung 2: the preview shows the screen

Room opens, the preview HWND composites the live mix on D3D11, screen capture
delivers, the overlay plays --- on an HDR monitor, through libobs's honest
scRGB path. Confirmed on hardware (stage mean RGB 144,148,152).

### The footgun: `sdr_white_level` is frontend-owned

On an HDR monitor libobs-d3d11 creates the preview swapchain in scRGB
(RGBA16F) and `obs_render_main_texture` draws the mix with the `DrawMultiply`
technique scaled by `obs_get_video_sdr_white_level() / 80`. That field is
written ONLY by `obs_set_video_levels`, whose sole caller in the OBS tree is
the Studio frontend. A bare libobs host reads **0**: every pixel of a perfectly
rendered mix multiplied by zero, and a solid-black preview with nothing in any
log. macOS never takes the branch (Metal + SCK report sRGB).

Fix: `obs_set_video_levels(300.0, 1000.0)` right after `obs_reset_video`
succeeds. Both platforms; inert where the branch is not taken.

### How it was found (the method is the point)

Each step measured on screen, not reasoned: HWND topmost and black → `gs_clear`
presents → draw callback fires at 30 fps at size → channel 0 is `main`, main
texture non-null → mix reads back magenta with a colour item (after fixing a
readback that used the wrong format --- check libobs's log for
`device_copy_texture ... formats do not match` before trusting a readback) →
a manual solid draw lands → an sRGB-framebuffer draw lands → the mix drawn by
hand with plain `Draw` shows scene, cursor and video → only libobs's own
scRGB draw is black → read the multiplier in `obs.c`. Sources, scene,
capture, effects, swapchain, z-order and DirectComposition were each excluded
by pixels before the cause was read in the source.

Reusable probes from it: `obs_get_output_source(0)` name, `obs_get_main_texture()`
readback in `gs_texture_get_color_format`, per-source
`enabled/showing/active/size`, `gs_get_color_space()` for the display, a
`color_source_v3` injected via `live_add_source` over CDP, and a
`CopyFromScreen` pixel mean over the preview HWND's rect.

### Also settled on the way

- **Win32 windows belong to the thread that created them, and it must pump.**
  The preview HWND created on the engine thread froze the UI. All preview
  window ops marshal to the main thread; `DestroyWindow` fails from any other.
- Source ids and device keys are per-platform in `graph::ids`; the main
  display and default camera resolve from libobs's own enumeration.
- `monitor_capture` pinned to DXGI duplication (proven); WGC untested here.
- `has-size ≠ has-frames` on Windows: monitor_capture reports the display rect
  before any frame arrives, so readiness must not key on width alone.

### The transparent-hole mode does NOT work on Windows (tried, measured)

`tauri.windows.conf.json` transparent + the room's CSS hole + preview HWND
placed below the webview: the DESKTOP behind the app showed through the whole
window. DWM composes the transparent WebView2 visual over the top-level window;
a sibling child HWND beneath it is not part of what shows through. So the hole
cannot be done with sibling windows. A real one needs WebView2 composition
hosting (the preview as a DirectComposition visual in the same tree), which is
a wry/tauri-level change.

Float mode is therefore the Windows design for now, with two mitigations:
mouse input is forwarded from the preview to the webview's input window (so
item drags start), and the preview is inset by the outline width so an item
filling the stage keeps its selection ring visible. Toasts and controls drawn
over the middle of the stage are still hidden behind the video.

### Virtual camera

win-dshow's DirectShow filter, `obs-virtualcam-module64/32.dll`, built by the
engine job (`ENABLE_VIRTUALCAM` TRUE on Windows only) into
`data/obs-plugins/win-dshow`, registered as a COM server with `regsvr32 /i /s`
--- exactly OBS's own `virtualcam-install.bat`. The shim probes
`HKCR\CLSID\{VIRTUALCAM_GUID}` for "installed" and runs an elevated regsvr32
(UAC prompt) for "activate", reporting the macOS state codes so the UI has no
platform branch.

Two facts that matter:

- **On a machine with OBS Studio installed the CLSID is already registered by
  OBS**, from Program Files. We report installed/active, "Install cam" hides,
  and our `virtualcam_output` feeds OBS's filter through the shared-memory
  queue. It works, and it is a coupling.
- **The camera's label is `"OBS Virtual Camera"`** --- a compiled string in the
  module --- and the guest render page finds the return-video device BY LABEL.
  `VCAM_DEVICE_NAME` is per platform and travels to the room as
  `vcam_status.device_name`. Renaming to "Producer Virtual Camera" (and
  coexisting with a user's OBS) needs our own `VIRTUALCAM_GUID` plus a small
  win-dshow patch: a second patchset target and a lock re-key, so a deliberate
  step.

### Selection outline: drawn natively, in the display's colour space

In float mode the webview's selection outline is hidden under the video, so the
room mirrors its selected item id to `live_set_selection` and `preview_draw`
draws the item's `obs_sceneitem_get_box_transform` as a 2-px line loop plus
eight handles --- inside the DISPLAY pass only, never the mix (the mix feeds the
encoder, the recording, the virtual camera and the guests). This is how OBS
Studio draws its own selection.

The colour has to be colour-space aware. On an HDR monitor the preview
swapchain is scRGB (FP16): values are linear and SDR white sits at
`sdr_white_level / 80`. A plain #22c55e written there reads dim and
yellow-shifted. And the white level itself should be the DISPLAY's, not OBS's
300-nit default: `producer_sdr_white_nits()` reads
`DISPLAYCONFIG_SDR_WHITE_LEVEL` (240 on the MSI here) so the preview and its
outline match the SDR desktop around them.

### Still open from rung 2

- **Float-mode occlusion.** The preview is an opaque child HWND above the
  webview, so anything the UI paints over the stage (toasts, item handles,
  pills) disappears behind it. macOS avoids this with the transparent-hole
  mode (`producer_preview_prepare_window` → WebKit `drawsBackground = NO`,
  preview placed BELOW the webview). The Windows equivalent is a transparent
  WebView2 default background + `below_webview` placement --- the shim already
  honours the z-order argument; the WebView2 half is unbuilt.

## Rung 3 notes, from the macOS guest work

- The guest page negotiates **VP8 first and H.264 last** on purpose: on macOS
  hardware-decoded H.264 never reached CEF's offscreen readback (black tile
  with `readyState 4`). The Windows decode path differs; keep the preference
  until a tile has been seen with pixels.
- Guest slots are plain `browser_source` items born hidden and muted
  (graph.rs, `add_extra` for Guest), promoted by `setStage`. The room's stage
  list is the host's truth and is published on every change; the join page
  listens on the unconfirmed list and only speaks once host-confirmed.
- `has-frame` semantics are per platform: on Windows a browser/monitor source
  has size before it has frames, so readiness must observe something that only
  moves with frames (the thumb ring, or a raw-frame counter).

## Still open

- `obs.lock` carries no Windows dependency pins. OBS 32.1.2 has no
  `buildspec.json` at the repo root, so the obs-deps/CEF hashes cannot be read
  from the source tree — add them after CI reports what it actually fetched,
  which is a truer pin than a guessed one.
- Rungs 2-5: room opens -> preview HWND composites -> browser-source guest
  renders -> RTMP out -> win-dshow virtual camera.
- The local R1-fallback extract has 13 plugins and NO obs-browser, so guests
  cannot work against it. Rung 4 needs a CI-built engine.

## Virtual camera identity (verified 2026-09-03)

Nothing user-visible may say OBS. On Windows the whole camera surface is two
compiled literals in `plugins/win-dshow/virtualcam-module/virtualcam-module.cpp`
(the COM server description and the DirectShow FriendlyName) — patched to
"Producer Virtual Camera" by `engine/patches/win-dshow/`, the second entry in
`obs.lock`'s `patchsets` list (apply target `.`, the obs-studio root; the
obs-browser entry applies inside the submodule). The filter's own CLSID is
Producer's (`VIRTUALCAM_GUID` in the producer-windows preset, mirrored in
`shim_win.c`; `check-engine-lists.sh` asserts they agree), so a machine with
OBS Studio installed no longer serves our camera from OBS's DLL — "Install cam"
registers ours (elevated `regsvr32 /i /s`). Label is the same constant as macOS
(`graph::VCAM_DEVICE_NAME`), which the guest page matches on.

Remaining OBS-visible surfaces on Windows (Mac session's inventory, to sweep):
`obs-browser-page.exe` (CEF helper, Task Manager) and any runtime text not
routed through `engine::user_facing`.

### CEF helper name (verified 2026-09-03)

The pinned helper carries no version resource, so Task Manager shows its bare
exe name. It is `Producer Helper.exe` (preset `BROWSER_HELPER_OUTPUT_NAME`,
mirroring "Producer Helper.app" on macOS): the obs-browser patch's Windows
hunks route `OUTPUT_NAME` and the spawn path in `obs-browser-plugin.cpp`
through that one variable, and both Windows scripts read the name from the
preset. Engine DLLs still carry OBS in their file-Properties version info
(19 of them); that is not a surface a user is shown and is left alone.

**Install without restart (verified 2026-09-03).** Upstream win-dshow registers
`virtualcam_output` only if the filter CLSID is in the 32-bit registry view
when the module loads (`dshow-plugin.cpp` `vcam_installed(false)`), so an
"Install cam" performed while Producer runs left the process with no output:
libobs logged "Output ID 'virtualcam_output' not found", still created a
shell output, and start failed with no error text. Patch 0002 registers the
output unconditionally and checks the filter in `virtualcam_start` (last error
"the virtual camera is not installed"). Both filter DLLs register in one
elevated cmd chain, so the user sees one UAC prompt, not two. Meet lists
"Producer Virtual Camera" and renders the program; OBS Studio's own camera
stays listed on machines that have OBS installed — it is not ours to remove.

## Float-mode cutouts (verified 2026-09-03)

The preview HWND sits above the webview, so a popover, menu, or banner that
opens over the stage was hidden by the video (the Channels popover, error
banners). `src/lib/stageCutouts.ts` watches the DOM for `.rm-pop`,
`.rm-banner`/`.rm-float`, `[role=menu|dialog|listbox]` and `[data-over-stage]`,
and reports their rects (CSS px, window coords) through `live_preview_cutouts`;
the shim punches them out of the preview's window region (`SetWindowRgn`,
recomputed on every frame move) so the webview shows through — and receives
the mouse — exactly there. Verified by pixel probe: a test popover over the
stage reads 97% webview green through the hole; removing it restores the full
region. macOS: the command is a no-op (the preview already sits below the
webview).

**Idle placeholder (2026-09-03).** win-dshow's filter loads `placeholder.png`
from beside its DLL at runtime; upstream's is the OBS logo, which a camera
picker shows whenever Producer sends no frames. `engine/assets/vcam-placeholder.png`
(1920x1080, the Producer chair on the app's dark ground) is staged over it by
`build-engine-windows.sh` and the closure gate asserts the staged sha; the lock's
`artifact_rev` bumped so the artifact identity changed. macOS should bake the
same file into its extension (build-camera-extension.sh).

## Building on Windows (2026-09-03)

Two scripts, both PowerShell, both self-sufficient about the engine (they
fetch the artifact for the current `obs.lock` from the newest green
engine.yml run if it is not on disk, run the closure gate, and refuse to
continue on a miss):

- `scripts\dev-windows.ps1` — `tauri dev` with the engine: Vite HMR, the
  debug exe resolving obs.dll from PATH, `PRODUCER_ENGINE_DIR` pointing at the
  artifact. `-Build` only builds the debug exe. Unlike macOS, no bundle is
  needed for CEF on Windows, so browser sources render in dev.
- `scripts\build-windows.ps1` — the production NSIS installer WITH the engine.
  `engine/windows-bundle/` is staged flat (obs.dll beside producer.exe,
  obs-plugins/ and data/ as siblings — the only layout the loader can use) and
  mapped into the install root by a build-only Tauri config the script writes
  (not tauri.windows.conf.json: tauri-build validates resource paths at cargo
  build time and CI's engine-less check has no staging dir). A directory
  source keeps its structure; a glob source is flattened to file names.
  Updater artifacts only when `TAURI_SIGNING_PRIVATE_KEY` is set. `-Smoke`
  silent-installs to `%TEMP%\ProducerSmoke`, checks the installed tree, and
  boots the engine once. The installer is unsigned (no Windows code-signing
  certificate is wired); release.yml's Windows job is still the engine-less
  path and does not use these yet.

## Parity with v0.4.14 (verified 2026-09-03)

Main 8871091 = v0.4.14 + PR #21 (Win32 clipboard shim, `THIS_DEVICE` wording)
+ PR #19 (build scripts). The Windows engine build links again; v0.4.10–14 had
shipped with `producer_copy_text` macOS-only, which CI cannot see (its Windows
job is an engine-less `cargo check`, so `shim_win.c` never compiles there —
diff `ffi.rs` externs against `shim_win.c` after every macOS-side change).

`Producer_0.4.14_x64-setup.exe` (129 MB) built here from main: silent
per-user install → 1335 files, engine boots with every plugin → uninstall
clean. **The NSIS firewall hook (`src-tauri/windows/hooks.nsh`, "Boomin
Producer") does nothing under the default `installMode: currentUser`:** the
installer is unelevated, `netsh advfirewall firewall add rule` needs admin,
`nsExec` swallows the failure, and `netsh … show rule` reports no rule after
install. The in-app banner (`firewall_status` → "missing" → "Allow Producer",
elevated via `Start-Process -Verb RunAs`) is therefore the path every
per-user install takes; it shows and works on this box. A per-machine
installer would make the hook real.

## Hardware encoders (artifact rev 6, 2026-09-04)

The Windows allowlist now carries the GPU encoders; before rev 6 every Windows
session ran `obs_x264`, and 1080p60 / 4K were CPU-bound by construction.

### What ships, and where the third one hides

| vendor | plugin            | H.264 ids at 32.1.2                                | probe helper (bin/)   |
|--------|-------------------|----------------------------------------------------|-----------------------|
| NVIDIA | `obs-nvenc`       | `obs_nvenc_h264_tex`, `obs_nvenc_h264_soft`        | `obs-nvenc-test.exe`  |
| Intel  | `obs-qsv11`       | `obs_qsv11_v2`, `obs_qsv11_soft_v2`, `obs_qsv11`†  | `obs-qsv-test.exe`    |
| AMD    | **`obs-ffmpeg`**  | `h264_texture_amf`, `h264_fallback_amf`            | `obs-amf-test.exe`    |

† deprecated upstream, kept as the last QSV resort.

AMF is not a plugin: `plugins/obs-ffmpeg/texture-amf.cpp` is compiled into
obs-ffmpeg on x64 Windows (its CMakeLists, `if(OS_WINDOWS)` /
`CMAKE_VS_PLATFORM_NAME STREQUAL x64`), so the shared allowlist already
carried it — unregistered, because of the helpers below. `engine-lib.sh` has
only `obs-nvenc obs-qsv11` to add. Both are ON by default in the pinned tree
(`ENABLE_NVENC`, `ENABLE_QSV11`); NVENC needs `FFnvcodec` headers and QSV
`VPL 2.9`, both in the obs-deps bundle the build already stages.

**Every one of the three decides whether to register anything by spawning a
helper exe and parsing its stdout** (`nvenc-helpers.c nvenc_check`,
`obs-qsv11-plugin-main.c`, `texture-amf.cpp amf_load`). The helper path is
`os_get_executable_path_ptr("obs-…-test.exe")` — relative to the RUNNING
EXECUTABLE, i.e. beside `producer.exe`, which is where the artifact's `bin/`
is flattened. `set_target_properties_obs` installs every executable except
`obs-browser-helper` to `OBS_EXECUTABLE_DESTINATION` (= `bin/64bit`), so the
wholesale `bin/` copy carries them; `build-engine-windows.sh` and
`engine-closure-windows.sh` assert all three anyway, because the failure
shape is the signature one again: the plugin loads, logs one warning, and
Producer streams x264 on a box with a perfectly good GPU.

The vendor runtimes — `nvEncodeAPI64.dll` / `nvcuda.dll`, Intel's
`libmfx-gen`/VPL dispatch, `amfrt64.dll` — come from the GPU DRIVER and are
`LoadLibrary`'d, never imported, so the import-closure gate does not (and
must not) demand them, and a box without that vendor's GPU simply
enumerates no such encoder. This is also why none of them can be in
`REQUIRED_ENCODERS_OS`.

### Selection: enumerate, then prefer

`engine.rs::bootstrap_inner`, after `obs_post_load_modules`: the registered
ids go through `encoders::choose_video` — the first hit in
`HW_H264_PREFERENCE` (NVENC → QSV → AMF; the `_tex`/`_v2`/`texture_` ids
first, libobs reroutes them to the `_soft`/`fallback` sibling itself when the
D3D11 zero-copy path is unavailable), else `obs_x264`. macOS takes the same
path and lands on the fixed VideoToolbox id. The choice is published
(`encoders::set_chosen`) and consumed by `multi.rs` (the shared stream
encoder), `record.rs` and `stream.rs`; each still falls back to x264 if the
GPU refuses at `obs_video_encoder_create` (driver gone, session limit).

Surfaced as `EngineReport.video_encoder` / `hardware_encoder`, the
`Snapshot` (`live_status`) fields `video_encoder` / `hw_encoder`, the
`engine_ready` event, and the room footer next to the graphics backend.
`hw_encoder` is what the 2160p canvas option gates on.

Settings per family (CBR at the session bitrate, `keyint_sec` 2, everything
else pinned to OBS's own 32.1.2 defaults so a Producer stream looks like an
OBS stream on the same GPU): NVENC `preset` p5 / `tune` hq / `multipass`
qres / `profile` high / 2 B-frames / no lookahead / AQ on; QSV
`target_usage` balanced (TU4) / `profile` high; AMF `preset` quality /
`profile` high. x264 and VideoToolbox are untouched — the A7 Kick-CBR finding
was made against their defaults.

Also fixed on the way: every session created its AAC encoder as
`CoreAudio_AAC`, which does not exist on Windows, so streaming AND recording
failed at encoder creation on every Windows box (`encoders::audio_id` →
`ffmpeg_aac`, which `REQUIRED_ENCODERS_OS` already asserted). Recordings now
land in `%USERPROFILE%\Videos\Producer` rather than `\tmp\Movies`.

### What needs a real GPU box

CI proves the artifact carries the plugins and their probes (closure gate);
it cannot prove an encoder registers, because the runners have no encode
hardware. On the founder's box, per GPU present:

1. Boot a room; the footer should read `d3d11 · NVENC` (or QSV / AMF), and
   `engine-report.json` next to the module config should show
   `"video_encoder": "obs_nvenc_h264_tex"` (or the vendor's id) with
   `"hardware_encoder": true`. The stderr line `[live] video encoder: …`
   says the same thing.
2. Go live at 1080p60 and record at the same time; Task Manager should show
   the encode on the GPU's Video Encode engine and CPU well under the x264
   figure. Check the platform dashboard for CBR at the intersection bitrate.
3. If the footer says `x264` on a box with a GPU: the plugin's own log line
   (`[NVENC] Test process failed`, `[obs-qsv11]`, `[AMF]`) names the reason;
   the first suspects are a missing `obs-*-test.exe` beside `producer.exe`
   (closure gate would have caught it) and a driver too old for the NVENC
   SDK the pinned tree compiles against (12.x).
