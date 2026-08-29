# M-L7.1 — Native CEF overlays: build integration spec

Owner split: the **Mac session** authored the obs-browser patch and owns the
host/UI side (already on the branch, dormant until a browser-capable engine
artifact exists). The **CI session** owns everything below — build plumbing.
Context: docs/LIVE-REVIEW.md v1.1.2 note.

## What exists already

- `engine/patches/0001-obs-browser-dispatch-loop.patch` — replaces obs-browser's
  Qt-based CEF main-thread scheduler with a libdispatch pump
  (`ENABLE_BROWSER_DISPATCH_LOOP`), drops the Qt6 dependency in that mode, and
  makes the CEF helper-app name overridable (`BROWSER_HELPER_OUTPUT_NAME`).
  Upstream-additive: with the option OFF nothing changes. Authored against the
  pinned obs-browser submodule (2.26.8, `ea04212`); compile-unvalidated locally
  (no Xcode on the Mac) — first CI build is the compile check.
- CEF 6533 is **already downloaded** by the deps fetch on every engine CI run
  (`dependencies` preset block) — it lands in `.deps/cef_binary_6533_macos_arm64*`.
- The host calls plain `obs_source_create("browser_source", …)`; no host-side
  pump is needed — the patch schedules everything onto the GCD main queue,
  which Tauri's NSApplication run loop drains. Verified: `browser_source`
  creation calls `obs_browser_initialize()` directly (no frontend-event gate).

## Build changes needed (build-engine.sh / producer-presets.json / obs.lock)

1. **Patch application**: implement the `patchset` path in `build-engine.sh`
   (currently FATALs if non-null). Suggested obs.lock schema:
   `"patchset": { "dir": "engine/patches", "sha256": "<sha256 of concatenated patches>" }`
   Apply with `git -C "$SRC_DIR/plugins/obs-browser" apply "$REPO_ROOT/engine/patches/0001-*.patch"`
   (this one targets the obs-browser submodule; name patches so target dir is
   derivable, e.g. keep an explicit map if a second patch ever targets the
   main tree). Verify sha256 against the lock before applying.
2. **Preset** (`producer-macos`): set
   - `ENABLE_BROWSER: true`
   - `ENABLE_BROWSER_PANELS: false` (already)
   - `ENABLE_BROWSER_DISPATCH_LOOP: true` (from the patch)
   - `BROWSER_HELPER_OUTPUT_NAME: "Producer Helper"` (CEF finds helpers by
     `<AppName> Helper.app` convention next to the framework)
   - `CEF_ROOT_DIR` → the `.deps` cef_binary dir (find_package(CEF 95) needs it).
3. **Artifact assembly** additions when obs-browser was built:
   - `PlugIns/obs-browser.plugin`
   - `Frameworks/Chromium Embedded Framework.framework` (from CEF_ROOT_DIR's
     Release dir)
   - `Frameworks/Producer Helper.app`, `Producer Helper (GPU).app`,
     `Producer Helper (Plugin).app`, `Producer Helper (Renderer).app`
     (built by obs-browser's cmake; targets are EXCLUDE_FROM_ALL — build them
     explicitly: `cmake --build … --target browser-helper browser-helper_gpu
     browser-helper_plugin browser-helper_renderer`)
   - `Frameworks/obs-frontend-api.dylib` — obs-browser links it; the no-op shim
     builds even with ENABLE_FRONTEND=OFF (frontend/api is added before the
     frontend gate). All calls degrade gracefully with no frontend registered.
4. **Gates**: `check-no-qt.sh` and `engine-closure.sh` currently forbid
   `Chromium Embedded Framework` and `obs-frontend-api` — the Mac session will
   relax those two entries (its files) once this lands; **Qt stays forbidden**
   and is the real assertion: the patched obs-browser must NOT link Qt
   (`otool -L obs-browser.plugin/Contents/MacOS/obs-browser` in CI as an
   explicit check).
5. **Size**: artifact grows ~600MB. Consider `--exclude` of CEF debug symbols;
   keep the tar.zst.

## Signing/notarization notes (release side)

- CEF framework + all four helper apps need signing; helpers need their CEF
  entitlements (obs-browser ships entitlement plists per helper —
  `cmake/macos/entitlements-helper*.plist`); the GPU/renderer helpers need
  `com.apple.security.cs.allow-jit` etc. Mirror what OBS's own release does.
- `assemble-engine-bundle.sh` (Mac session's file) will gain the helper/CEF
  signing order: CEF framework → helpers → plugins → app.

## Acceptance (M-L7 list from the frozen plan, unchanged)

Remote overlay URL renders with transparency + audio; websocket alerts fire;
refresh/reload works; browser restart works; no frontend-event regressions
(JS `obsStreaming*` events simply never fire — nothing may block or crash);
**zero Qt in the dependency closure**. Hardware verification happens on the
Mac session once a browser-capable artifact is downloadable.

## Risks / first-build watchlist

- The patch is compile-unvalidated: expect one or two trivial fixups (includes,
  const-ness) on the first CI build; iterate in CI as with the Swift ladder.
- `browser-client.cpp` calls `obs_frontend_get_*` when overlay pages use the
  obs-studio JS API — with the shim these return null/empty; eyeball for
  null-derefs if a page crashes the render process.
- CEF cache path: obs-browser derives it from `obs_module_config_path` — the
  host passes NULL module_config_path today; verify a sane cache dir or set
  one (`obs_startup` second arg) before browser sources are created.
