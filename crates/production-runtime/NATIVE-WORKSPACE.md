# Native room workspace

The GPUI workspace is an editor document stored with the local room. Workspace
commands validate and persist on the control worker without compiling/adopting
a production plan, incrementing its revision, or restarting capture, playback,
encoders or the audio graph. It is not part of recorded output.

## Shared shell

Normal operation hides management headers and outer outlines. Enter **Edit layout**
to reveal panel titles, move grips, close/collapse controls and the panel registry;
**Done** or Escape returns to the clean room. Four-pixel gutters remain, with
resizing enabled in Edit layout. Shared-dock navigation remains functional when
multiple panels occupy one dock.

Sources, Set Controls, the microphone mixer, current sequence listing and
multilayer Timeline use the same header, movement, sizing, collapse/restore,
closure and single content scroll region. The status footer is outside all
docks. The active panel in each dock is shown; its … menu selects other open
panels there and offers explicit edge destinations. Drag the header grip/title
to an edge. Resize on the canvas-facing edge: preview locally, persist on
release. Escape cancels. Collapsed side docks become rails; horizontal Timeline
retains transport access. Closing preserves destination for reopening.

Timeline accepts top/bottom only. Other registered panels accept all four edges.
Stored sizes are bounded, temporarily fitted to a small window, and not
rewritten by window fitting. The toolbar can restore the initial workspace.
Scenes now supports bounded (32), persisted scene copies and explicit activation through `sceneAdd` / `sceneSelect`. Each scene retains its base source composition and mounted Set; adding does not change program output. The compact Scenes strip has an Add scene button, with scrolling scene chips. Dock edge handles remain the expansion control; the duplicate end chevron is removed. Full scene arrangement editing remains to be built. Native Assistant,
chat and Clips ports remain separate work, not simulated placeholders.

## CLI / agent contract

The UI and native CLI endpoint share typed commands:

```json
{"op":"workspace","command":{"action":"move","panel":"controls","edge":"top"}}
{"op":"workspace","command":{"action":"resize","edge":"top","size":220}}
{"op":"workspace","command":{"action":"collapse","edge":"top","collapsed":true}}
{"op":"workspace","command":{"action":"activate","panel":"controls"}}
{"op":"workspace","command":{"action":"visibility","panel":"controls","visible":false}}
{"op":"workspace","command":{"action":"reset"}}
```

Panel IDs: sources, scenes, mixer, controls, timeline. Edges: left/right/top/bottom.
Side sizes: 160–520 logical pixels; horizontal sizes: 160–440. `state` and
`assistantContext.workspace` expose the layout, registry, operations and Timeline
restrictions. This prepares the command boundary for an Assistant adapter; it
does not port the old ChatGPT integration into the new native app.

Unknown IDs/fields, incomplete registries, invalid active references, duplicate
panel ordering, unsupported Timeline edges and invalid sizes are rejected.
Edits validate a cloned candidate before replacement. Legacy visibility flags
migrate on read; modern serialization has one layout authority. Existing panel
and timelineDock CLI commands use that same authority.

## Qualification

`desktop/scripts/check-workspace.py` only accepts an explicitly marked isolated
public-video QA profile. It exercises all supported panel/edge combinations,
resizing, collapse, activation, close/reopen, invalid edits and restart
persistence while paired outputs record. It asserts unchanged production
content/revision, no added missing movie presentations and no new refused GPU
submissions. `check-take.py` verifies hashes and decodes all saved fragments.

Unit coverage includes migration, roundtrips, atomic rejection, active-panel
recovery, small-window fitting and prepared GPU resource reuse. Physical camera,
mic, ScreenCaptureKit and other platforms require separate qualification.

## Panel insertion and input instances (Native Dev)

Dragging a panel previews the destination order before release. Insertion uses
panel midpoints from the drag-start workspace, so preview changes cannot move
the hit target. `place` accepts `panel`, `edge` and optional `before`; a null
anchor appends. The same command validates all four docks. Timeline retains its
top/bottom restriction. Escape or dropping outside a dock discards the preview.

Sources lists individual inputs, with one Add source menu and device settings
per camera/microphone. `addInput` and `configureInput` take an enumerated device
ID; `configureInput` also takes its source ID. `project.inputs` stores identity
and native slot separately from source type. Additional microphones start muted
and get independent program routes, gains and bounded PCM queues. The native
profile currently admits one primary plus four additional cameras and the same
number of microphones, within the 32-lane document budget. Capture endpoints
share the existing compositor; they do not allocate another renderer. Recording
must be idle before adding or rebinding devices. Reopening does not automatically
activate saved capture devices. This is macOS development functionality; it is
not new Windows/Linux capture qualification.

Mixer strips use one combined level rail/fader in both orientations. The meter
uses post-gain level, logarithmic headroom and fixed green/amber/red zones. Mute
shows silence. Drag feedback is local immediately; native gain commands are
coalesced to 50 ms and flushed on release. Gain changes bypass production-plan
compilation, visual preparation and capture reconfiguration. They persist on the
control worker and leave the production visual revision unchanged.

`evidence/native-inputs-reorder-mixer-proof.json` records 43 tests, real mouse
reordering in all four docks, vertical/horizontal fader drags and paired 1080
recordings with full video/audio decoding. The second camera is Elgato's virtual
placeholder, not a second physical webcam. Only one microphone was available;
concurrent physical multi-mic qualification remains open. CPU submission timings
are not end-to-end A/V latency. Production remained unchanged.

## Program and editorial monitor separation (Native Dev)

The canvas controller selects **Live** or **Preview**. This is a monitor choice,
not an output routing command. Timeline Play/Pause/Seek, trims, document edits
and committed-take placement target an independent preview transport and decoder
lane. The camera/screen IOSurfaces are shared; Preview opens no capture devices,
runs no audio mixer, and cannot start recording. Its GPU work stops when hidden.
The media worker budget is six: two program readers, two preview readers, and two
bounded replacements during adoption. Preview currently monitors video only.

**Send to output** prepares a complete snapshot (plan, text resources, immutable
media bindings) before one acknowledged program adoption, at the preview playhead
and play state. Further private edits or seeks do not mutate that snapshot.
Recording always reads program surfaces/audio and program asset metadata.
Program revisions advance independently of editorial revisions.

Set Controls lists the native document's Sets and provides **Show room scene** /
mounting. A mounted Set has a separate continuous live transport; native Set
animation tracks remain available while editorial placement cuts are excluded.
Unmounting keeps the library Set and renders a bare room-source composition.
The production HTML/JS Set library is not imported or migrated by these commands.
Original-recording selection and committed-take tools live behind Timeline's
settings button, rather than in Set Controls.

CLI: `monitor { preview: bool }`, `sendToOutput`, `setMount { id: string | null }`.
`play`, `pause`, and `seek` select Preview automatically. Snapshot includes
`previewing`, `position`, `playing`, `programPosition`, `programPlaying`,
`programKind`, `programRevision`, `previewOutputFrames`, and `previewCpuP99Ms`.
Hardware reconfiguration while a timeline owns program requires returning to a
live Set first; this is refused before changing capture devices. Production
applications and profiles are unaffected.

## Scene/source removal qualification

Scene `⋯` menus and every source settings menu expose Remove. The final scene
cannot be removed. Removing an active scene selects a remaining one. Source
removal is idle-only, removes room lanes and placements/routes, and releases
capture endpoints off the rendering lane. Source definitions, Set templates and
media files remain reusable. Removed device slots can be reused; primary inputs
can be added again through the normal device picker.

The native transport samples the monotonic host clock on an explicit 48 kHz
grid. This prevents re-anchoring a sample-based playhead against nanosecond
intervals from exceeding the exact rational time profile. Default core
transports retain their previous exact nanosecond behavior. Proof:
`evidence/native-scene-removal-proof.json` includes active camera/mic, removal of
all five source types, camera re-add/new frames/removal, both outputs advancing,
persisted room changes and clean shutdown. These are local Mac checks only.
