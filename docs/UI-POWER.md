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
