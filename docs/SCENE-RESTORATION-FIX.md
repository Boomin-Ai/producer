# Scene restoration fix — October 5, 2026

## Failure and cause

Opening a room could show Scene 2's video while Scene 1 was selected. The saved document inspected during diagnosis correctly assigned the media source exclusively to Scene 2.

`live_add_source` acknowledges enqueueing, not creation. Room startup queued every scene's sources, created ordinary sources visible, then built the opening scene from React's incomplete source list. A one-shot reapply consumed whichever source event arrived first. A 250 ms fallback and a pending-scene render could declare the room settled before the complete scene was applied.

## Implemented contract

- `live_restore_room` runs restoration on the engine owner thread and replies with the committed graph. No per-source event can declare restoration complete.
- Existing sources are hidden and muted before restoration. New items are added hidden under the native scene lock, preventing even a single default-visible render frame.
- The complete opening scene is applied atomically. Native restoration also hides/mutes every source not covered by the plan. A failed creation stays absent and produces a warning; another scene's source cannot substitute for it.
- Room readiness, active-scene selection, scene-look capture and output-consuming roster tasks wait for acknowledgment. Record/Go Live/source editing stay blocked during initial restoration.
- Missing or deleted active-scene IDs select the first saved scene. Empty or uninitialized looks open empty.
- Ordinary cuts build a complete plan from an acknowledged native graph, including queued additions. Bound guests follow their slots; unbound guests retain the existing room behavior.
- `live_replace_source` recreates devices, windows and vote pages hidden, preserving current geometry, visibility, mute, volume and audio sync. Permission retries no longer spawn other scenes' cameras visible or rely on a fixed settling delay.

## Verification

`npm run build`, `npm run test:scene-restoration`, `node scripts/test-room-session.mjs`, `node scripts/test-room-control.mjs`, native build, and the Rust library suite passed (39 tests; the hardware test is separately invoked).

The isolated native compositor test first reproduces the old incomplete-plan leak. It then samples real program frames through 20 alternating cold/warm restorations, delayed hidden creation, five off-scene replacements, failed device creation, an empty scene, and room replacement. No forbidden Scene 2 frames occurred after restoration testing began. Repeated runs passed. The reproduction's buffered frames are drained before checking the fixed path.

```sh
PRODUCER_ENGINE_DIR=/Applications/Producer.app/Contents \
PRODUCER_ENGINE_PLUGINS=/Applications/Producer.app/Contents/PlugIns \
DYLD_LIBRARY_PATH=/Applications/Producer.app/Contents/Frameworks \
DYLD_FRAMEWORK_PATH=/Applications/Producer.app/Contents/Frameworks \
cargo test --manifest-path src-tauri/Cargo.toml \
  native_scene_restore_never_renders_another_scenes_source \
  -- --ignored --test-threads=1 --nocapture
```

This test uses an isolated native graph with color sources; it does not open a room, capture a device, record, stream or alter room configuration.

## Local preview and remaining verification

Signed preview: `src-tauri/target/scene-restoration-preview/Producer.app`.

Open the affected room with Scene 1 saved active. Its camera/chat should appear immediately when loading finishes; Scene 2's video must remain absent. Switch to Scene 2 and back, leave and reopen, and repeat. Repeat with Scene 2 saved active to verify selection restoration in both directions. Check a fresh app launch as well as a room reopen.

The user confirmed the affected room opens correctly into Scene 1 in the updated preview, in response to the leave/reopen verification request. Local visual inspection also showed Scene 1's camera and chat, with Scene 2's media absent.

The shared desktop implementation covers development and release builds on both operating systems. Production installers have **not** been published by this task. A Windows live room check and a production release remain separate verification/deployment steps.
