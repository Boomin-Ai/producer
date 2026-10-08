# Portrait dev checkpoint — October 6, 2026

## Room workspace

Host quick controls → Output settings → Landscape / Portrait / Both.

Portrait is a native 720×1280 room canvas sharing the room’s existing sources. No set, JSON layout, source slot, or generated design is required. Its own scene items have independent position, dimensions, rotation, crop, stacking, and visibility. Initial placement fits the existing landscape arrangement into portrait without stretching; arrange sources directly using the normal stage editor. Output settings also has a collapsed portrait source visibility list. Framing survives switching workspace views during the room session; durable room-document persistence is still future work.

Both displays use native OBS displays under the webview. Portrait draws the canvas through `obs_canvas_render`; the former JPEG polling monitor has been removed from the workspace. The optional JPEG API remains only for diagnostic acceptance captures and does no encoding unless requested. Both displays maintain their own bounds and lifetime. Shared transparency bookkeeping prevents hiding one display when the other detaches. Video configuration resets detach the portrait display/canvas safely, then the workspace reconnects.

Authored portrait set layouts are optional compositions when a set is on output. Without an active set, portrait always uses the room scene. Streaming, recording and guest feeds currently remain on landscape; selecting a workspace view does not change destination routing. This capability remains Mac debug only.

## Verification

Native integration probe passed: room sources without a set; independent portrait move/resize/crop/visibility; live source addition/removal; framing retained when returning to the portrait room; unchanged landscape source state and pixels; authored portrait set rendering; duplicate revision rejection; clean display and canvas teardown. Native display cadence measured **60 draws in two seconds** with the room set to 30 fps. This is synthetic acceptance evidence, not a long-session performance guarantee.

Chromium and WebKit tests cover landscape/portrait/both views, native display attachment/detachment, no JPEG polling, no set requirement, independent drag and source visibility controls, and preserved aspect ratios at wide and reduced window sizes. Frontend and native debug builds passed.

Earlier isolated native proof recorded 1280×720 and 720×1280 simultaneously for 15 seconds with separate hardware H.264 encoders. Both recordings had matching test-tone audio RMS (~0.0863). Landscape continued after portrait stopped; 100 canvas lifecycle cycles passed with clean shutdown.

## Remaining work

Durable per-output room/scene documents, named output and segment layout contracts, destination and guest routing, sustained dual-output recording and memory measurements, Windows validation, and production release validation.

Native evidence: `/private/tmp/producer-portrait-dev-probe/result.json`, `portrait.jpg`. Recording proof: `producer-native-set-proof-SX3tsI` in the macOS temporary folder, including `recording-evidence.json`.

## Independent editing and dual recording follow-up

Fixed StageEditor’s unconditional landscape IPC calls for portrait gestures. Portrait passes `nativeTransforms=false` and dispatches transforms only through its portrait handler. Chromium and WebKit acceptance explicitly assert zero landscape transform calls during a portrait drag.

Record now passes a dual flag when the room view is Both. The engine starts a separate portrait encoder/muxer bound to portrait canvas video, alongside the existing landscape recorder. Both AAC encoders use the main room audio mix. Both files are registered and finalized in the recording library. Portrait canvas teardown and video-settings changes are prevented while dual recording is active. Ordinary landscape recording remains unchanged.

The integrated native probe produced two playable files: 1280×720 landscape and 720×1280 portrait, with matching test-tone RMS (~0.0863). Evidence: `/private/tmp/producer-dual-recording-check/recording-evidence.json`. Startup and finalization are sequential, so the files can differ by a fraction of a second; exact synchronized start/stop is not yet implemented. Dual recording remains Mac dev only. Portrait framing persists during a room session, not across app restarts yet.

## Complete transform isolation

Portrait previously copied main-room transforms again on every source snapshot, except individual properties already overridden by a portrait gesture. That made landscape edits move untouched portrait properties. Portrait now seeds a complete transform exactly once when each source first joins, including position, dimensions, crop, rotation, stacking and visibility. Subsequent snapshots refresh media metadata only; all geometry comes from portrait-owned state. Removing a source removes its portrait state. The portrait editor no longer writes main selection state.

Native regression explicitly changes landscape position, size, rotation, layer, crop and visibility before any portrait edit, then verifies the entire portrait item snapshot is unchanged. The reverse-direction source snapshot check also passes, along with the dual recorder and room-source lifecycle checks. Browser tests assert portrait gestures never call main transform IPC.

## Paired set compositions

Portrait composition now defaults to Follow set / segment. When a set is on output, a selected `foo-landscape` layout maps to `foo-portrait` if present; a set with only one portrait layout uses it as the fallback. Applying the set and changing segments/layouts automatically project the matching portrait composition, even while the portrait workspace monitor is hidden. Manual Room canvas and specific portrait layout selections remain available. This is a naming convention, not a new JSON output mapping contract. Unmatched layouts fall back to the room canvas.

Chromium/WebKit regression checks apply a paired set and advance from opening-landscape to next-landscape, verifying opening-portrait and next-portrait projections are emitted without manually selecting portrait.
