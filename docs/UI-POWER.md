# UI-POWER — bringing the engine's capability to the interface

Status: **ACTIVE** · owner: Mac session · design iterates with the founder.
The engine already does almost everything OBS does (same libobs 32.1.2, same
plugin binaries). This plan exposes it without becoming OBS: settings are
controls, panels are docks, the stage is direct manipulation.

## Doctrine

1. **The scene is a document; the stage is its editor.** No transform
   dialogs — you grab things on the canvas.
2. **Settings are controls, inline.** No Settings maze. A knob lives where
   its subject lives (video → sheet, source → its row, filter → its source).
3. **Everything visible works.** No dead UI. SOON tags are debt with a date,
   not decoration.
4. **A room owns its whole show** — scenes, items, transforms, layout,
   channels. Switching rooms switches everything.

## Engine model change (UI-P1)

`graph.rs` today: four fixed slots (screen / camera / overlay / mic).
Target: **real obs scenes with real items.**

- `Scene { id, name, items: Vec<Item> }`, `Item { id, kind, source*,
  sceneitem*, transform, visible, locked }`
- `Transform { pos, bounds, rot_deg, crop{l,t,r,b}, z }` — canvas space
  (base_width × base_height).
- Commands: `AddItem`, `RemoveItem`, `SetTransform`, `SetOrder`,
  `SetVisible`, `CutToScene`. Legacy `SetSources` becomes a shim.
- New ffi: `obs_sceneitem_set_rot/scale/crop/order_position` + getters +
  `obs_sceneitem_crop`. All engine-thread only (§5.1).
- Mic stays an output-channel source (not a scene item), as today.

Persistence: full scene/item/transform state serializes into the room
document (`live_rooms.config`), versioned (`"v": 2`), with a migrator from
today's shape.

## Milestones

| # | Ships | Depends on |
|---|-------|-----------|
| UI-P1 | ItemGraph in engine + items in snapshot + transform IPC | nothing |
| UI-P2 | **Interactive stage**: select, drag, scale w/ handles, snap to edges/center, arrow-nudge; Sources panel = real item list (reorder, eye, lock) | P1 |
| UI-P3 | Crop (⌥-drag + numeric), rotation, per-item scale filter; per-scene transforms persist | P2 |
| UI-P4 | **Filters**: chroma/luma key on video sources; noise suppression, gate, compressor on mic. One "Effects" popover per source row | P1 |
| UI-P5 | **Recording + replay buffer** (Record button, replay save, output folder row) | engine artifact rev 2 (obs-ffmpeg — in CI now) |
| UI-P6 | **Stream Deck**: obs-websocket v5 subset as a native Rust host server (cross-platform; Windows inherits) | P1 |
| UI-P7 | **Virtual camera**: CMIO extension rebrand patch + signing + approval UX | its own engine milestone |

Design checkpoints (founder review expected): P2 handle/selection language,
P4 effects popover, P5 record affordance placement.

## Explicitly out (the 10%)

Decklink/AJA, Syphon, VST hosting, VLC sources, scripting, NVENC/QSV
(Windows encoders — Windows session's lane), fractional FPS, non-16:9
canvases, HDR pipelines. Revisit only on real user pull.

## Won't regress

Multistream with per-platform auto-negotiated limits stays zero-config.
The D2 intersection remains the bitrate authority — encoder UI (when it
comes) constrains within it, never overrides it.

## UI-P2.5 — Platform connections (chat)

Added ahead of P3 because chat is the panel a streamer lives in, and a room
that can only show fake chat is not launchable. The ALERTS panel was cut for
the same reason inverted: nothing could ever fill it.

**Read-only, zero-auth, host-side.** Both readers live in `src-tauri/src/chat`
and emit on `chat://event`. No credential crosses into the webview, and no
account is needed to read — which means chat works on first launch with
nothing to sign into.

| Platform | Transport | Auth | Verified |
| --- | --- | --- | --- |
| Twitch | IRC over WebSocket, `justinfan` anonymous | none | 268 msgs/20s live |
| Kick | public Pusher stream, `chatrooms.<id>.v2` | none | live, ids unique |

Notes that will matter later:

- **Twitch anonymous IRC is undocumented**, not deprecated — Twitch's own docs
  only describe the token path. It has worked for years and works today, but
  the insurance policy is EventSub `channel.chat.message`, which needs OAuth.
  Keep the reader behind the same shape so the transport can swap.
- **Kick has no official chat read at all** (the public API can send, and can
  webhook events to a public HTTPS endpoint — useless for a desktop app). The
  Pusher stream is the only path, so nothing about it is a compile-time
  constant: app key, client version and host are env-overridable and both
  known event spellings are matched, with unknown events logged.
- **The one fragile call** is slug → chatroom id (`kick.com/api/v2/channels/`),
  which sits behind Cloudflare. It succeeds from here, and the answer is cached
  per slug forever because it never changes — so the fragile step runs about
  once per channel per machine. If Cloudflare ever wins, the fallback is a
  pasted id, not a broken feature.

**Not done, deliberately:** sending. That needs a real account on each
platform and belongs with Connect. The UI says so rather than implying it.

## UI-P2.9 — Sources become real (device pickers)

The Sources panel is now the layer stack AND the place sources are edited:
rows reorder by grip (commits z-order to the engine), the eye cuts a source
in and out of the stage, ✕ removes it, and the panel's + (revealed on hover)
adds back whatever is missing. "Alerts & overlays" is now just **Overlay** —
we host someone else's alerts, we don't generate them, and the name should
not imply otherwise.

**Microphone is a source, not just a fader.** It sits in the list like OBS
models audio; the mixer keeps the level. Its picker is what makes an external
mic — USB, interface, capture card — a one-click choice.

**Device pickers come from libobs itself** (`obs_get_source_properties` on the
source TYPE, list-valued property), so any hardware the OS exposes appears
with no per-device code: cameras and capture cards, every CoreAudio input,
each display. Switching applies with `obs_source_update`, so the source keeps
its position, size and place in the stack — the picture changes, the layout
does not. The chosen device is remembered per picker so toggling a source off
and on does not silently fall back to the built-in one.

🔴 **Enumeration can block the engine thread.** AVFoundation does not return a
device list until the camera TCC prompt is answered, and that call runs on the
engine-owner thread — an ungranted camera froze the preview, not just the
menu (it is also what hung the `--live-props` probe). The command now checks
permission FIRST and never asks libobs for a class the OS has not granted;
the picker shows an Allow affordance instead. Same shape as the M-L2 lesson
about CoreAudio blocking inside `obs_source_create`. The engine's 5s reply
timeout is the backstop, not the fix.

### Source types still missing (ranked by how often streamers reach for them)

1. **Media / video file** — stingers, pre-roll, BRB loops. The engine can do
   this today (obs-ffmpeg ships as of rev 3); it needs a source type and a
   file picker.
2. **Image** — logos, frames, PNG overlays. `image-source` is already loaded.
3. **Text** — labels, now-playing, countdowns. `text-freetype2` is loaded.
4. **Window capture as a first-class source** — currently only reachable
   inside the Overlay editor; it deserves its own row.
5. **Colour / background** — cheap, and unblocks non-fullscreen layouts.

All five are engine-ready; what they need is the item model to stop being
three fixed slots (screen/camera/overlay) and become a real list. That is the
next structural step, and it should land before P3's crop/rotation so the
transform pipeline is written once against the general shape.


---

# ROADMAP — everything outstanding (2026-08-31)

Ordered by what a launch actually needs, not by what's fun. Each item states
where it stands so nothing is discovered mid-build.

## Tier 1 — broken promises (the UI already claims these)

**R1. Scene keyboard shortcuts.** Rows render ⌘1/⌘2/⌘3 and nothing listens.
Add a window keydown handler in the room: ⌘1–⌘9 → applyScene(scenes[n-1]),
ignored while a text field has focus. *Engine: none. Small.*

**R2. Chat send.** The input accepts text and drops it. Needs per-platform
OAuth, which belongs with Connect — until then the input stays disabled with
its honest label. *Deferred by design, not by neglect.*

## Tier 2 — engine is ready, only UI is missing

**R3. Recording + replay buffer.** obs-ffmpeg ships since engine rev 3 and
its outputs are registered; there is still no record button. Add an
`ffmpeg_muxer` output reusing the streaming encoders, a record button beside
Go Live, elapsed/size in Stream health, and a replay-buffer output with a
Save Replay action. Recording must survive independently of streaming —
either, both, or neither. *Biggest launch hole.*

**R4. Crop.** `crop_left/top/right/bottom` are already plumbed engine→IPC.
Stage editor grows ⌥-drag on an edge handle to crop, plus numeric fields in
the source settings strip. *Half the work is done.*

**R5. Rotation.** `rot` is already plumbed. Add a rotation handle above the
selection box, snapping to 15° with ⇧. *Same pipeline as R4.*

## Tier 3 — needs engine work

**R6. Fade transition.** Needs per-item opacity, which our look model has no
channel for today. Add opacity to ItemState/TransformPatch, then a crossfade
becomes another tween like `move`.

**R7. Desktop audio.** macOS has no system-audio capture without a virtual
device. Options: ship a driver (heavy), or document a third-party device.
Decide before promising it in the mixer.

**R8. Per-item devices.** `set_device` is keyed by KIND, so two cameras
can't point at two devices. Move device identity onto the item once the
item-list model owns capture sources.

**R9. Stinger cut point.** Hardcoded at 50%. Expose it as a chip once
someone actually wants it moved.

**R10. Per-source audio strips.** Media/overlay audio joins the mix with no
fader. Enumerate audio-bearing items into the mixer.

## Tier 4 — whole milestones

**R11. Filters.** ~20 ship in obs-filters with zero UI: chroma/luma key,
colour correction, sharpen (video); noise suppression, gate, compressor,
limiter (audio). Filters attach per source, so this needs a filter list in
the source settings strip plus per-filter property forms.

**R12. Stream Deck.** A native obs-websocket v5 subset server in the Rust
host — no Qt, cross-platform, Windows inherits it. Scope to what Stream Deck
actually calls: scene list, scene switch, source visibility, stream/record
state, replay save.

**R13. Virtual camera.** Producer as a webcam in Zoom/Meet/Discord — the
feature people choose a producer app for. macOS = a CMIO system extension:
patch OBS's to our identifiers and app group, embed, sign with the
system-extension entitlement, NOTARIZE (system extensions will not install
otherwise — ad-hoc dev builds cannot test it), then an approval flow with a
relaunch. Developer-ID signing landed 2026-08-30, so identity is solved;
notarization is the new infrastructure. Windows is an unrelated DirectShow
implementation and belongs to that track.

## Execution order

R1 → R3 → R4 → R5 → R11 → R13 → R12, with R6–R10 folded in where they
unblock the item above them. R2 waits on Connect.

---

## R13 virtual camera — investigation result (2026-08-31)

Attempted; **stopped deliberately** short of shipping, with findings that
change the plan. Nothing about the engine was left destabilised — the
extraction path and the zero-Qt gate are back to their committed state.

**What's true now:**

* Both halves ship inside the official DMG we already pin: the
  `mac-virtualcam` plugin (which registers `virtualcam_output`) and
  `com.obsproject.obs-studio.mac-camera-extension.systemextension`.
* The plugin's only blocker is a **dead CMake edge**: it links
  `OBS::frontend-api` and calls nothing from it — `nm -u` shows zero
  `obs_frontend_*` imports. That single unused link is what drags Qt in.
  `engine/patches/0001-mac-virtualcam-drop-frontend-api.patch` removes it
  for the source build.
* 🔴 **The local extract path cannot carry it.** `engine-closure.sh` walks
  the SOURCE bundle, where `obs-browser` links Qt directly (our shipped
  obs-browser is a separately built Qt-free one, so the artifact is clean
  but the *source walk* is not). Adding any plugin that re-triggers that
  walk trips the gate. The gate is right; the extract path is the wrong
  vehicle.
* The extension in the DMG is signed by OBS with their team prefix and
  their app group, and identifies itself as "OBS Virtual Camera".
  Re-signing it as ours works only if the host carries a matching app-group
  entitlement, and it would still carry OBS's name in every app's camera
  list.

**What R13 actually requires, in order:**

1. **CI source build of the engine** with the patch applied and
   `mac-virtualcam` in `ENGINE_PLUGINS` — the only path that yields a
   Qt-free virtualcam plugin.
2. **Rebrand the extension**: bundle id → `ai.boomin.producer.camera-extension`,
   app group → `$(TeamIdentifierPrefix)ai.boomin.producer`, device name →
   "Producer Virtual Camera". Identifiers live in
   `plugins/mac-virtualcam/src/camera-extension/CMakeLists.txt`,
   `cmake/macos/entitlements.plist`, and `plugin-main.mm:128`.
3. **Notarization.** System extensions will not install without it, so this
   is the one genuinely new piece of release infrastructure. Developer-ID
   signing (landed 2026-08-30) is the prerequisite and is done.
4. Host activation via `OSSystemExtensionRequest`, an approval flow with a
   relaunch, then start/stop of `virtualcam_output`.

**Honest sizing:** this is a release-infrastructure milestone, not a UI
feature. Steps 1–3 are prerequisites before a single pixel reaches Zoom.

**Bug fixed along the way:** `extract-engine.sh` referenced an undefined
`$OBS_APP` when copying `obs-ffmpeg-mux` — under `set -u` that aborts the
whole extraction. It now uses `$SRC`.

---

## Notarization (2026-08-31) — R13's prerequisite

`scripts/notarize.sh` submits a signed Producer.app to Apple, waits, staples
the ticket, and verifies the result. `--preflight` runs every readiness check
and submits nothing, so it is safe to run at any time.

**Why it matters beyond Gatekeeper:** macOS refuses to install a system
extension from an un-notarized app, so the virtual camera (R13) cannot ship
until this pipeline works end to end.

What the preflight enforces, and why each one exists:

* **Developer ID identity** — ad-hoc signatures are rejected outright.
* **Hardened runtime** — required since 10.14.
* **Secure timestamp** — our dev loop sets `CODESIGN_TIMESTAMP=none` to skip
  a network round-trip per Mach-O. That shortcut is fatal here and Apple
  reports it per-binary, which reads as noise; catching it up front is
  cheaper than decoding the rejection.
* **No `get-task-allow`** — a debug entitlement that fails notarization.
* **Deep `--strict` verify** — every nested Mach-O signed and intact.
* **Credentials present** — a keychain profile, never a file in this repo.

**The one step only the account holder can do**, once:

    xcrun notarytool store-credentials "producer-notary" \
      --apple-id "<apple-id-email>" --team-id "9936A69867" \
      --password "<app-specific-password>"

The app-specific password comes from appleid.apple.com → Sign-In and
Security → App-Specific Passwords. It lands in the login keychain; nothing
secret enters the repo or the build.

**Release signing differs from dev signing in exactly one way:** omit
`CODESIGN_TIMESTAMP=none`. Everything else — identity, entitlements, order —
is already what the assemble script does.

⚠️ `set -o pipefail` turns `codesign … | grep -q` into a false negative
whenever codesign exits non-zero, which it does for some query forms. The
preflight captures codesign's report once into a variable and greps that.

### R13 status after the 2026-08-31 build

Everything except one Apple-portal step is done and notarized.

**Working and shipped in artifact rev 4:** `mac-virtualcam` plugin (the Qt
scare was a misdiagnosis — see below), the camera system extension embedded
at `Contents/Library/SystemExtensions` and re-signed with our identity,
`OSSystemExtensionRequest` activation with a delegate-driven state machine,
a device check via `AVCaptureDeviceDiscoverySession`, the `virtualcam_output`
wired into the engine independently of streaming and recording, and a
Stream-health control that walks install → approve → ON/OFF. The whole thing
notarized (submission 17926183…, Accepted).

🔴 **BLOCKED on a provisioning profile, and it fails in the worst way.**
`com.apple.developer.system-extension.install` and
`com.apple.security.application-groups` are *profile-backed* entitlements on
macOS: a Developer ID signature alone does not authorize them. An app that
claims them without an embedded provisioning profile is refused by launchd at
spawn — `Launchd job spawn failed`, POSIX 153 — so **the app does not open at
all**. There is no warning and no degraded mode; notarization passes happily
and then the build is simply dead. Those two entitlements are currently
commented out in `scripts/entitlements-app.plist` so the app runs.

**To finish, in the Apple Developer portal:**
1. App ID for `ai.boomin.producer` with the **System Extension** capability.
2. An **App Group** shared by the host and the extension.
3. A **Developer ID provisioning profile** for that App ID, saved as
   `scripts/embedded.provisionprofile`; the assemble step copies it to
   `Contents/embedded.provisionprofile`.
4. Uncomment the two entitlements, rebuild, re-notarize.

**Misdiagnosis worth remembering:** the earlier "virtualcam drags Qt in"
conclusion was wrong. `obs-frontend-api` is Qt-free, so that path never
existed. The real fault was `engine-closure.sh` seeding OBS's *own*
obs-browser (which does link Qt) while walking their bundle for dependency
discovery — a pre-existing bug that had been failing every extraction.
Fixed with `CLOSURE_SEED_EXTRAS=0` on the discovery call.

### R13 — where it stops, and why (2026-08-31)

Every Apple-side gate is now satisfied. The error progression is worth keeping
because each step was a real, separate blocker:

1. **launchd refused to spawn the app** — profile-backed entitlements with no
   embedded provisioning profile. Fixed: profile from the portal, copied to
   `Contents/embedded.provisionprofile`.
2. **"code signature invalid"** — three causes in sequence: the extension's
   bundle id was not a child of the app's; it claimed an app group no profile
   authorizes; and its inner executable kept upstream entitlements because
   only the bundle was being re-signed.
3. **The containing app must be notarized** before macOS will install an
   extension.
4. **"extension category returned error"** — signature and notarization
   checks now PASS and control reaches the CoreMediaIO extension itself,
   which fails to come up. `systemextensionsctl list` shows 0 extensions.

Step 4 is the wall: rebranding a *prebuilt* extension only rewrites
`Info.plist`. OBS's compiled Swift still refers to its original mach service
and app group internally, and those cannot be patched from outside.

**The remaining work is a source build of the extension** —
`engine/obs-studio/plugins/mac-virtualcam/src/camera-extension` (Swift; the
Command Line Tools ship `swiftc`), with the identifiers set at build time
rather than rewritten afterwards. That same build is what renames the device
to "Producer Virtual Camera", so it settles the cosmetic gap at the same time.

Everything else is done and notarized: the plugin ships, the extension is
embedded and signed under our team, activation and status plumbing work, the
output is wired independently of streaming and recording, and the UI walks
install → approve → on/off.

