# Producer 0.4.92

Producer adds opt-in local Clips, the Classic studio Set, broader Room assistant
authoring, and shared Set control improvements. Windows x64, Apple Silicon,
Intel Mac and the existing Linux distribution use the same release source.

## Clips

- Add the Clips panel and explicitly enable rolling capture. Choose a recent
  window from 1 to 600 seconds and a bounded encoded-memory budget.
- Save recent landscape, vertical, or paired MP4 clips locally. Both writes
  separate files for each format. Saving uses the existing recording folder;
  an unavailable external drive produces an error instead of silently falling
  back to internal storage. Clips never uploads files automatically.
- Full recordings and streaming remain separate. Hiding or moving the panel
  preserves the buffer; leaving its room stops capture. Reopening a room does
  not silently start it again.
- Capture readiness, saving and errors are visible beside the save action,
  including compact docks. Failed actions have explicit retry controls.
  A missing startup frame cannot leave the panel indefinitely claiming it is
  rolling. Per-output native counters distinguish encoding from buffer delivery.
- Recent saved clips can be previewed and revealed in the operating system.
  The catalog uses confirmed container durations rather than the requested
  buffer window. Memory limits and keyframes can shorten that window.
- Clips requires the native engine on Windows and Mac. Linux retains its
  existing engine-less scope and does not advertise native capture support.

## Classic and shared Set controls

- Classic includes Opening, Solo, Demo, Conversation, Roundtable, Spotlight,
  Break and Closing, each authored for landscape and vertical: 16 canvases.
- Dark and light modes, configurable accent colors, subtle signature lighting,
  native source frames, shared content and per-layout controls are included.
- Name, teaching and CTA cues use deliberate overlay designs. Clearing a cue
  clears the overlay. Layout controls appear first by default while authored
  arrangements can override that order.
- Waiting views can use real DJ audio analysis. Music controls share the native
  DJ player, with explicit play/stop, track selection and a responsive level
  slider. The owned starter sound collection and waiting track are bundled
  for offline use.
- Expanded Set control capacity is shared by validation, MCP and Assistant
  contracts. Source recovery notices consolidate errors and offer meaningful
  repair actions while retaining current output.

## Room assistant and chat

- Assistant tools distinguish Room, Set and Show and can author supported
  scenes, sources, slots, panels, docks and Show rundowns through the shared
  room command surface. Room and draft revisions fence stale actions.
- Screenshots and production assets have explicit roles. Preserved private
  drafts remain separate from room output and existing Set control arrangements.
- The Assistant composer is a full-width footer, progress reflects the actual
  operation, and suggestions use a responsive carousel. Reopening a conversation
  positions its latest message before display.
- Room chat follows new messages and late-loading emotes until the user scrolls
  upward. The new-message button resumes following, including future messages.

## Platform and verification scope

The engine lock and production native guest features are unchanged. Both Mac
packages retain their architecture-specific engines, CEF helpers, recording
muxer and camera provider, with Developer ID signing and notarization gates.
Intel retains its documented graphics qualification and limitations. The
shared updater is published only after all four platform packages pass the
release gates. Existing native Network, recording and guest regressions remain
required; native Windows qualification additionally covers paired Clips startup,
rearming, silent program audio and decoded saved files.
