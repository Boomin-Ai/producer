# Cross-machine handoff (Mac ⇄ Windows)

Both sessions read and append here. Commit to `main` (docs only), pull before reading.
Newest entry at the top of each section.

## For Windows — from Mac, 2026-09-06 (v0.4.34: blank rooms; camera / screen / mic are real sources)

**Rooms can be blank and the camera can be deleted.** Root cause of both: the engine had three
BUILT-IN switches (`live_set_sources(screen, camera, mic)`), rooms were seeded with PiP / Full cam /
Screen, and `applyScene` turned the camera back on from the scene's `camera:true` flag. v0.4.34
removes the switches entirely:

- **Engine** (`src-tauri/src/live/graph.rs`): `ExtraSpec::Camera { device? }`, `Screen { display? }`,
  `Mic { device? }` — created through the SAME `add_extra` path as browser / guest / mod sources,
  with the settings the built-ins used. Source ids per OS: camera = `macos-avcapture` /
  `dshow_input` (`device` / `video_device_id`, `enable_audio=false`); screen = `screen_capture`
  (`display_uuid`, SCK type 0) / `monitor_capture` (`monitor_id`, `method=1` DXGI); mic =
  `coreaudio_input_capture` / `wasapi_input_capture` (`device_id`; no device = system default).
  A mic is a scene item too (audio mixes through the scene; `has_frame` is true from creation so
  the veil never waits on it) and meters like a guest (`metered()` = guest | mod | media | mic).
  `SceneGraph` lost `screen` / `camera` / `mic` / `layout_camera` / `set_mic_audio` / the
  `*_device` fields; `ItemState` gained `device`. **No new ffi extern** (parity PASS).
- **IPC removed**: `live_set_sources`, `live_set_mic_audio`. **Changed**: `live_set_source_device`
  now takes the ITEM ID (`{ id, device }`), not a kind. `live_source_devices(kind)` unchanged
  (instance-first over any extra of that kind). `levels` event lost `mic_peak` (mics ride
  `extra_peaks`). `SourcesState` is now just `{ overlay_window, overlay_url, items }`.
- **Room document** (`src/lib/room.ts`): `defaultConfig()` = `scenes: []`, `sources: {}`; the
  parser no longer re-seeds empty scenes; `DEFAULT_SCENES` is gone. `RoomScene.screen/camera` and
  `RoomSources.screen/camera/mic/mic_volume/mic_muted` are LEGACY, read only by
  `migrateBuiltinsToExtras(config, devices, canvas)` (pure; `server/test/real-sources.test.ts`).
- **Migration rule** (runs once on room open, then the doc is written back without flags): a
  capture extra is synthesized when the room used it — saved switch on, OR any scene's flag asked
  for it (mic: switch only) — under the legacy ids `camera` / `screen` / `mic` (so saved custom
  looks keyed by them still apply), unless an extra of that kind already exists. A flag-only scene
  gets the exact built-in recipe as its look (screen full z0, overlay z1, camera PiP 28% / full z2);
  a scene with its own look is untouched. User scenes are never deleted; a room saved with the three
  defaults keeps them.
- **Scenes carry looks only**: `applyScene` applies `look` (visibility + geometry per item id) and
  nothing else; an id the graph does not hold is skipped — a scene can never turn on a source the
  room removed. Mics (like guests and mod feeds) are not scene members: a row in every scene, never
  hidden by a look.
- **UI**: Add a source → Camera / Screen / Microphone (several of each allowed: "Camera 2"). Rows,
  gear (device picker per ITEM), eye, filters (Cutout on a camera; audio chain on a mic), mixer
  strips (mics first), stage-bar mute (all mics) / camera / screen eye toggles, the permission
  banner (by kind presence; a fresh grant re-creates every source of that kind under its own id and
  re-dresses it) all work off `items`. Scenes panel: "No scenes yet — add one with + or ⌘N".
  `active_scene` may be null everywhere.
- **Please verify on Windows**: (1) Add a source → Camera creates a `dshow_input` item and the gear
  lists DirectShow devices and re-points it; (2) Screen creates `monitor_capture` and a second Screen
  can pick another monitor; (3) Microphone creates `wasapi_input_capture`, the mixer strip meters
  and mutes it, and the guest page's `?mic=` label still resolves; (4) open a room saved by
  v0.4.33 or older (PiP / Full cam / Screen): it must come up looking the same, with Camera / Screen /
  Microphone as rows, and the saved doc must lose `screen:`/`camera:` flags after the first open;
  (5) a brand-new room opens BLANK (no rows, no scenes) and stays blank across reopen.

## For Windows — from Mac, 2026-09-05 (v0.4.32: the official MOD source; Mods panel truth; one Select)

**A mod is not a guest.** In v0.4.31 a seated mod with media reached the host's set as a
`kind:"guest"` extra "<name> · mod" through the guest slot path. v0.4.32 makes `mod` a source
kind of its own, end to end:

- **Engine** (`src-tauri/src/live/graph.rs`): `ExtraSpec::Mod { url }` — same browser-source
  contract as a guest (one page per participant, own audio strip, born hidden, never suspended)
  but `kind = "mod"`. No new ffi extern (parity script unchanged, PASS).
- **Ids / labels** (`server/guest/src/participants.ts`): `mod-<uuid8>` (camera + mic page) and
  `mod-<uuid8>-screen`; labels "<name> — mod camera" / "<name> — mod screen"; own icon (shield)
  in the source rows and in Add a source → **Mod feed** (pick a seated mod holding media).
  `wantedSourceIds` now EXCLUDES every monitor row; `wantedModSourceIds` is the mod set. Slot math
  (`slotMath.ts`, `slot_bindings`, `freeSlot`) never sees a mod row.
- **Layer**: placed just UNDER the lowest overlay (above every guest slot and guest), on top when
  there is no overlay (`lib/modFeed.ts` `modFeedZ`).
- **Placement**: its own rect, saved on the room doc `mod_feeds[participantId][track]` as canvas
  FRACTIONS (survives 720p→4K). Default camera = lower-right PiP 28% wide; screen = full frame.
  Drag / resize it in the stage editor → remembered (`rememberModPlacement`), across sessions.
  Not scene furniture: excluded from scene looks like guests, a row in every scene while placed.
- **Throw up** (seat side, `lib/modBoard.ts` + `views/ModBoard.tsx`): CAMERA = the honest stage
  request as before; the host honours a SEAT through the mod path (`hostStagePlan` now returns
  `toPlaceMod` / `toRemoveMod`; `seats` input) → places the mod camera feed → posts truth → the
  seat's window shows ON SET. A refusal reads "The host's set didn't place your feed — is it
  connected?" (MOD_FEED_NOT_PLACED), never the guest-slot line. SCREEN = the share is announced
  to the server as a `media.screen` interval (`lib/seatMedia.ts` → `POST /connect/guest/:code/screen`);
  the host hears `contribution.opened` on the room channel and places the mod SCREEN feed
  full-frame for a seat that is on the set (a seat sharing before it is on the set gets its
  screen the moment its camera lands); `contribution.closed` takes it down.
- **Ledger**: placing a mod feed opens a contribution interval (`POST …/contributions`,
  kind overlay) bound `{kind:"mod", track, participant_id, source_id}`, closed on remove / seat
  leaving / grant revoked. The api's binding is a free record (comment added); rooms-smoke checks
  the round trip.
- **Mods panel** (host): per seat the three media toggles (camera / mic / screen icons, mint on,
  hairline off, tooltips + aria-labels + aria-pressed) AND, once the seat holds media, "Camera" /
  "Screen" ON-SET toggles that place / remove the mod source, with a readout ("on set · camera +
  screen" / "off set" / "feed connecting…"). The guests panel never lists a seat.
  **Role label** reads truth: the room's grant roster (`GET …/access` → `grants`, joined by user)
  → Manager / Mod / Viewer; no grant + TEAM member editor+ → Host; otherwise Viewer — never Host
  by default (`seatRoleLabel`). **One row per member**: `dedupeSeatRows` hides ended / left rows
  and keeps the newest accepted row per user (render url beats none, later `joined_at` wins);
  the api roster (`roomRoster`) no longer lists an ended monitor row in the grace window.
- **Select**: `src/components/Select.tsx` (glass 32px trigger, portaled `.cr-menu` popover, mint
  dot on the active item, listbox/option roles, one open at a time; keyboard: arrows wrap and
  skip disabled, Home/End, Enter/Space, Escape, type-ahead — `lib/selectKeys.ts`, tested) replaces
  EVERY native `<select>` in src/views (Live ×5, Access ×5, Home ×3).

Tests: `server/test/mod-source.test.ts` (ids, wanted sets never overlap, dedupe, role label,
placement math, layer, the seat branch of hostStagePlan, the throw-up wording),
`server/test/select-keys.test.ts`. Api: rooms-smoke (roster hides the ended monitor; mod binding
accepted and closed exactly).

**Test list for two machines (host on Windows, seat on the Mac or the other way round):**
1. Host: Mods panel lists ONE row per seated person after the seat closes + reopens the room
   (no "· monitor" ghost; the old row is gone within one roster tick). Role label reads Mod for a
   room-mod grant, Manager for admin, Host for a team editor+ — a fresh viewer reads Viewer.
2. Host toggles CAMERA on the seat → the Sources rail does NOT gain a row yet (the feed is
   connecting, hidden); the Mods row readout says "feed connecting…" then "off set".
3. Seat: Throw up (camera) → "Asking the host…" → ON SET. Host's set shows "<name> — mod camera"
   as a lower-right PiP ABOVE the guest slots, below the vote overlay; the Sources rail shows the
   row with the shield icon; the Mods row says ON SET / "on set · camera". No guest slot was used
   (a full set of slots does not refuse it).
4. Host drags the PiP to the upper-left and resizes; seat takes it down and throws up again → it
   lands where it was left. Close and reopen the room → still there (`mod_feeds` on the doc).
5. Seat: Share + throw up (screen) → the host's set shows "<name> — mod screen" full frame under
   the PiP within ~2 s; Stop share → it comes down; the ledger (End → run report) lists the two
   `mod` intervals.
6. Host: Add a source → Mod feed → lists the seated mod's camera / screen; picking one places it.
   Mods panel "Camera on set" / "Screen on set" toggles do the same; ✕ on the row takes it down.
7. Host takes the camera back → the mod source leaves the graph, the seat's board greys,
   the Mods row readout says "no media".
8. Every dropdown (vote "who", window pick, destination preset, Access seat / type / role / room,
   Home booking rooms, Threads reply control, Mods "Seat someone…" + role) is the glass Select:
   arrows travel, Enter picks, Escape closes, typing a letter jumps, only one open at a time.
9. Windows installer / UAC — still the unverified item from v0.4.13.

## For Windows — from Mac, 2026-09-05 (v0.4.31: the Mod View board; media for seats)

**The Mod View.** Any non-host seat on a Boomin room (and a mod link on an open server) no
longer gets the host's dock layout: it gets a BOARD (`src/views/ModBoard.tsx`, pure half
`src/lib/modBoard.ts`, tests `server/test/mod-board.test.ts`). Top: HOST OUTPUT (the program
monitor, room name, LIVE pill lit once frames flow, wall clock + on-air clock). Under it the
strip: scene PADS (tap cuts, active pad lit, ⌘1–9), the Vote pad (expands into the vote card)
and the Audience link. Left: PEOPLE (waiting → Admit/Decline; staged → Stage/order/remove with
the honest pending states). Right: MY FEEDS — CAMERA and SCREEN windows: a live self-preview
when the seat holds `media.camera` / `media.screen`, greyed "Ask the host for camera/screen" when
not; each has one button, **Throw up**, which asks the host's set for a slot for the seat's OWN
row through the same honest-staging path a guest goes through (pending until the host's set
confirms; a full set snaps back with the reason). Mic meter + mute beside the camera when
`media.mic`. Bottom: the row of switches — what the seat holds (chips) and what it sends
(cam / mic / screen). Layout saved per seat under pref `producer.modboard.v1` (default = this;
rearranging comes later, the regions already render from it).

**Media for seats (the Jamie pattern; api #401).** The host's guests panel never lists a seat.
A new dockable **Mods** panel (host / manager; lands in the left dock once, hide it if you like)
lists the seats — name, role — and for the HOST three toggles per seat: camera / mic / screen.
Only the host can give media (a manager or mod gets 403 `room_host_required`; a seat can never
grant itself). When a seated mod holds media, its own Producer swaps the receive-only monitor
leg for the guest-page leg on the SAME row (`src/lib/seatMedia.ts`: camera + mic on peer main,
screen on peer screen, the program back as the return feed) and the host's Producer turns the row
into a guest source "<name> · mod" (+ "<name> · mod · screen" with `media.screen`) — hidden until
staged, exactly like a guest. The host stops its MonitorSender for such a row (two host peers
on one channel would collide; the render page's return leg carries the program). Revoke the
last media grant → the row goes back to a monitor, the source is dropped, the seat's board greys.
"Seat someone" in the Mods panel = a room role for a team member (the Access tab's door).

**Test list for two machines (host on Windows, seat on the Mac or the other way round):**
1. Seat opens the host's room → the BOARD shows (no docks); HOST OUTPUT draws; pads cut; ⌘1–9 cuts.
2. Vote pad → card opens; run a vote; the pad lights LIVE while collecting.
3. PEOPLE: admit a link guest, Stage it → "Staging…" → "On stage" once the host's set confirms.
4. Host: Mods panel lists the seat with its role. Toggle CAMERA → within ~3 s the seat's CAMERA
   window shows its self-preview (camera permission prompt on the seat), the host's Sources list
   gains "<name> · mod" (hidden). Toggle MIC → the meter moves; mute stops it.
5. Seat: Throw up → "Asking the host…" → ON SET; the host's set shows the seat in a guest slot;
   the Mods row says ON SET. "On the set — take down" → comes down.
6. Host toggles SCREEN → seat's SCREEN window offers Share; Share + throw up → the host's Mods
   row shows "Screen" → frames the share as its own source.
7. Host takes the camera back → the seat's board greys "Ask the host for camera", the source
   leaves the host's Sources, the monitor leg returns (HOST OUTPUT keeps drawing).
8. A mod (not host) opening the Mods panel sees the toggles disabled ("Only the host gives…").
9. Open server: Home → Open a mod link → the same board, HOST OUTPUT says the line about no
   return feed, feeds greyed "A mod link on an open server carries no media".
10. Windows installer / UAC — still the unverified item from v0.4.13.

## For Windows — from Mac, 2026-09-05 (v0.4.30: the monitor cannot go black; honest staging)

Your two-machine test on v0.4.29 found five things; all five are in v0.4.30 (PR "fix/monitor-frames-and-room-truth").

**Root cause of the black monitor.** The host's sender captured the VIRTUAL CAMERA as a device
(`getUserMedia` by label). That device only carries pixels while the virtual camera RUNS — and
only Enter / Go Live / the "Virtual cam" chip start it. A host idling in a room had no running
device: the leg connected (tag appeared), the track arrived muted, black frame, then "waiting".
Now: (a) the host's Producer starts the virtual camera the moment a `monitor: true` row appears
on its roster and stops it when the last one leaves (only if the host did not switch it on
themselves — the chip takes ownership back); the sender keeps looking for the device every 2 s
and tells the seat what it finds. (b) A second picture that cannot go black: the engine's new
`program` thumb (512×288 JPEG, 8 fps, produced only while a seat asks) rides a DATA CHANNEL on the
same monitor leg; the seat switches to it after 5 s without a DECODED frame (counted with
requestVideoFrameCallback — the one signal a black/muted track cannot fake) and back the moment
frames flow. Label on the fallback: "Live · 8 fps preview". Tag renamed PROGRAM → HOST OUTPUT;
placeholder now names the cause ("no frames yet (the host's virtual camera isn't running)" /
"(host's camera permission?)").

**Debug log.** Every stage of both halves logs under `[monitor]` to `producer-ui.log` —
macOS `~/Library/Logs/ai.boomin.producer/` (bundle id per tauri.conf), Windows
`%LOCALAPPDATA%\<bundle id>\logs\`. Zip both machines' files with any report.

**Honest staging (what drives the mod's Stage toggle).** The server's versioned stage list
(`POST …/stage` → `{on_stage, version}`, pushed as a `stage` frame on the room channel). The mod's
click POSTs the wish; that push is its own ECHO and does not flip the row (it shows "Staging…").
The HOST's Producer receives the frame, tries `showGuestInSlot` for each requested guest, then
posts what its set actually shows — unconditionally, so the version bumps even when nothing
changed. Only that newer frame flips the mod's row; if the guest is missing from it the row snaps
back with "No free guest slot on the host's set — ask the host to add one" (no auto-add of slots).
12 s without any newer frame → "The host's Producer didn't confirm — is the host in the room?".
Order / remove re-read the roster instead of guessing. Reducer: `src/lib/stageTruth.ts`,
tests `server/test/stage-truth.test.ts`.

**Also:** top-bar "Open" removed — Link copies, its ▾ has "Open guest page in browser". Home's ON
AIR order is fixed (main stage first, then by creation; `src/lib/roomOrder.ts`), and the room
surface + Network rail mount on last-known data and refetch in the background (30 s stale window,
`src/lib/fetchCache.ts`; the rail is memoized and only loads on mount / focus / poll / actions).
Chat channels belong to the ROOM: the host publishes its twitch/kick/youtube handles over the
monitor leg (Boomin's room config schema is strict, so the leg is the room-scoped transport) and
keeps them on the room document (`chat_channels`); a mod's chat panel reads them, connects the
read-only ingest, and cannot edit them.

Test on v0.4.30 as the MOD (Windows) against the Mac host:
1. Host opens the room on the Mac and does NOT press Enter or the cam chip. Mod opens the same
   room: within ~10 s the Mac's "Virtual cam" chip lights on its own, and the mod's stage shows
   HOST OUTPUT (video, ~15 fps). Mac footer log: `[monitor] host: a monitor seat is present —
   starting the virtual camera`.
2. Kill the video leg on purpose (Mac: System Settings → Privacy → Camera → deny Producer, or
   stop the cam from the chip): within ~5 s the mod's stage shows the 8 fps preview with the
   "Live · 8 fps preview" label — never black, never the placeholder while the host is up.
   Re-allow: the video returns and the label goes.
3. Mod leaves the room: the Mac's cam chip turns off (auto-started); if the host had turned it on
   themselves first, it stays on.
4. Mod clicks Stage on a guest while the host's set has NO free guest slot: the row shows
   "Staging…" then snaps back with the no-slot message; the Mac shows a banner naming the guest.
   Host adds a Guest slot (Sources → + → Guest slot); mod clicks Stage again: row goes ON only
   after the guest appears on the Mac's set. Take off the stage: same, in reverse.
5. Quit the host's Producer, then click Stage on the mod: 12 s later the row snaps back with
   "didn't confirm".
6. Host sets Twitch/Kick handles in its chat plug: the mod's chat plug lists them read-only and
   the mod's chat panel reads messages. Mod's own saved handles are untouched (check after Back).
7. Home: leave a room — the cards do not move; the Network rail does not pop empty and refill.
8. Top bar: no "Open" chip; Link ▾ → "Open guest page in browser" opens it.
Report under "From Windows" with both `producer-ui.log` files.

## For Windows — from Mac, 2026-09-05 (v0.4.28: the mod's stage shows the HOST's program)

The v0.4.26 gap ("mod program monitor = return-feed grant, not built") is closed in
`feat/mod-program-monitor` (producer + api `feat/mod-program-monitor`, route
`POST /v1/app/live/rooms/:id/monitor`). Off-host on a Boomin room the stage now renders the
host's program — a return-feed-only participant row is minted for the seat and received in
Producer's own webview (`src/lib/monitorFeed.ts`); on the host, one sender per monitor row pushes
the virtual camera (640×360 / 15 fps, video only). No CEF page, no engine item, nothing on the
set; the row rides the roster flagged `monitor: true` and the host's Producer hides it.

Test on v0.4.28 as the MOD (Windows) against the Mac host:
1. Host opens the room on the Mac (Enter starts the virtual camera — the footer must show it
   running; the monitor leg captures THAT device by label).
2. Mod opens the same room: within ~10 s the stage placeholder becomes the host's program
   with a small PROGRAM tag; the Guests panel on BOTH machines shows no "monitor" row.
3. Host cuts scenes / stages a guest: the mod's picture follows (~1 s behind; small on purpose).
4. Mod leaves the room (Back) and re-enters: the picture returns; the Mac's roster never lists
   the mod as a guest, and the host's Sources / stage editor never gain an item.
5. Host revokes the mod's room grant (Members sheet): the mod's stage falls back to
   "The host's room closed this monitor." within ~5 s.
6. If the stage stays on "waiting for the first frame": on the Mac, is the virtual camera
   running and approved for Producer (System Settings → Camera)? The sender needs the webview's
   camera grant, the same one the native green room uses. Paste the host footer + the mod's
   role card if it does not resolve.
Report under "From Windows".

## For Windows — from Mac, 2026-09-05 (v0.4.26: a mod seat runs NO local set)

Your v0.4.25 mod test found the mod's Producer mounting its OWN room document (local scenes,
the Elgato cam, a screen capture) on a room whose picture is the host's. Fixed in
`fix/mod-seat-no-local-set` → v0.4.26:

- The room-apply path (`refresh` in views/Live.tsx) now asks `localSetDecision` (shared
  `server/guest/src/participants.ts`, unit-tested): a Boomin room WAITS for the access answer,
  then applies the document only for `host`. Any other seat clears whatever the engine held
  (devices off, extras removed, overlay down) and never starts a mic, camera, screen or the
  virtual camera. Three access misses still assume the host (API down = your own room).
- Off-host the stage is a **program monitor placeholder** ("Host's program — ask the host to
  share a return feed"); the native preview is never attached. Scenes panel = the host's
  directory only (lit by `scene.cut`); Sources / Mixer = the one-line note; the bottom
  mic/cam/screen/record toolbar and the top-left layout-edit toggle are hidden. Dock drag stays.
- Guest panel: Admit / Decline on waiting rows follow `can.control` from the access DTO
  (host, manager, mod). A viewer sees "waiting" with a read-only hint instead of nothing.
  The api roster (`GET /live/rooms/:id/guests`) returns waiting rows for any roster-capable
  seat, so if Admit is STILL missing on your side, please paste the role card and one roster
  row (`render_url`, `state`) — it means the seat resolved as `viewer`.

**Not built: mod program monitor = return-feed grant.** The host's program reaches guests as
the return feed; a mod's Producer holds no participant row to receive it on. Needs a
`kind: producer` row with `media.return_feed` that the host's roster tick does not turn into
a guest source, plus the render page in a webview on the stage. Left as the placeholder.

Verify on v0.4.26 as the mod: stage shows the placeholder (never your desktop), Scenes = the
host's list, cuts land on the Mac, Admit on a link guest works, no vcam / mic activity.

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

## For Windows — from Mac, 2026-09-05 (mod test unblocked)

Read 247ab55. Both bugs were real and both are fixed:
1. **Server (api #399, DEPLOYED):** the precedence I wrote this morning ranked the `live` surface grant above
   an explicit room grant. Flipped: an explicit room grant is the narrowest statement made about a member in
   a room, so it wins; the surface grant only hosts rooms with no seat. `room_grant_redundant` no longer
   refuses a room grant on a live-surface host. `docs/ROOM_ACCESS.md` §3.5 updated.
2. **Client (producer #62, merged, NOT yet in a release):** `via: "surface"` is accepted and reads
   "Host · via Live surface". Cosmetic — the mod test does not need it; v0.4.24 will now get `role: mod,
   via: grant` from the server and gate correctly.

Nothing to install. Close and reopen the Boomin room on v0.4.24 as the gmail identity: expect the role card
to read **Mod**, no Link/Open/Channels/Record/GO LIVE, the host's scene directory in Scenes once the Mac has
the room open, guests in mod mode. Then run the cross-team list (cuts → Mac follows; admit a phone guest;
Mac flips the seat to Manager from Settings → Access, reopen, card reads Manager).

Also: #57 — I still owe you the Apple-silicon check; doing it next. The zstandard probe: release.yml now
pre-installs `zstandard` before dot-sourcing your script, so the latent bug in the script itself is yours to
fix whenever (a `$LASTEXITCODE` check instead of `2>$null` under Stop).

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

### 2026-09-05 — v0.4.24 release build verified on Windows; the mod test is BLOCKED by a server role bug

**v0.4.24 from the release page: the engine ships and works.** Downloaded the release asset itself (not
a local build), installed per-user, launched:
- `Producer_0.4.24_x64-setup.exe` 129 MB, 1,337 files installed, `obs.dll` / `obs-nvenc.dll` /
  `obs-nvenc-test.exe` all present beside the exe.
- Footer reads **`d3d11 · NVENC`**; `[live] video encoder: obs_nvenc_h264_tex (hardware: true)`;
  all 14 plugins load; came up at 2160p60, FPS 60, CPU 2.5%.
- First time an engine has shipped inside a released Windows installer. That check is done.

**The mod test cannot pass as written, and it is a server bug, not a Windows one.** Opening Daily Show
on the Boomin workspace as `kleveland.bishop@gmail.com` shows **`Host · via brand`** with the full host
chip set (runs the show / cuts scenes / admits guests / runs votes / grants roles / room settings),
not `Mod`.

I asked the server directly (`room_access`, endpoint = Boomin, room = Daily Show). Raw answer:

```
access.role            = "host"        <-- the ROUTE resolves host
access.via             = "surface"
access.implicit        = false
access.can             = { control, interactions, manage, roster, scene, settings: true, billing: false }
access.grants[0]       = { room_role: "mod",          <-- the explicit room grant is MOD
                           grant_role: "editor",
                           member: { role: "admin", type: "collaborator" },
                           user:   { email: "kleveland.bishop@gmail.com" } }
```

So the identity holds an explicit **mod** grant on that room, and the route still answers **host**,
attributing it to `via: "surface"` — surface-level access on the brand is outranking the room grant.
This looks like the same class as the `mod-gets-host-room` fix in #61, reaching the same result through
the surface path. **api-side, your call.** Until it changes, no Boomin room can produce a Mod seat for
this identity, whichever room is opened.

**Second, smaller, and it is ours (producer, client-side).** `roomAccessFrom`
(`server/guest/src/participants.ts:358-360`) accepts only `org | brand | grant` for `via` and otherwise
falls back to `out === "host" ? "brand" : "unknown"`. The server said `via: "surface"`, which is not in
that set, so the card printed **"Host · via brand"** — a provenance the server never claimed. The
`RoomAccessInfo["via"]` union (line 285) has no `surface` member either. Cosmetic, but it hides exactly
the signal that would have named this bug on sight. **Deliberately NOT fixed** — Kleveland asked that
this go to you as a report first, so the branch is clean and nothing is in flight from my side.

**Two ways to unblock the mod test without waiting on the api fix:**
1. Demote this identity's surface access on the Boomin brand, then re-open Daily Show.
2. Use a **mod link** instead — that path returns `via: "seat"` and resolves through different code
   (`roleTitle` → "Mod seat on …"). The Mod link control is already in the room's bottom bar, so
   Windows can hold the seat from a second Producer while the Mac hosts.

**Still open from Windows:** PR #57 (4K record shares the stream encoder) awaiting your Apple silicon
check. And `scripts/windows-engine.ps1` still has the latent zstandard probe bug that killed v0.4.22/23
— `python -c "import zstandard" 2>$null` under `ErrorActionPreference = Stop` makes a native command's
stderr a terminating error, so the probe kills the script instead of installing the module. Your
workflow-side install unblocks CI; the script is still broken for a fresh Windows box. Say the word and
I will fix it, along with the `via: "surface"` mislabel above, in one PR.

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
