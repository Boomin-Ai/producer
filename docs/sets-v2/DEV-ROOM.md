# Isolated Sets v2 room

The new engine adapter is opt-in under `sets-v2-dev`, currently on macOS. It uses its own app identifier (`ai.boomin.producer.sets-v2-dev`), database and CEF profile. The app refuses to run that feature with the production identifier. It does not modify the installed Producer bundle or its rooms.

```sh
npm run dev:sets-v2
# In another terminal:
npm run dev:sets-v2-room
```

The helper builds with the installed engine runtime, APFS-clones a separate bundle and ad-hoc-signs it. It does not install camera extensions. Build output is cached under `/private/tmp/producer-sets-v2-app-check` by default. The staged app is:

`src-tauri/target/sets-v2-dev/Producer Sets v2 Dev.app`

The workbench's **Native dev room** controls appear inside Tauri. In a normal browser, the existing side-by-side previews remain simulations.

1. **Add synthetic host**, or enter the ID of a ready video source in this dev room.
2. **Show native preview** to view the actual room output.
3. **Prepare Audience Desk** or **Prepare Spotlight**. The next composition renders off air while the current output remains visible.
4. Choose dissolve, wipe or slide, then **Take**. A 500 ms native-clock transition switches compositions.
5. **Pause clock** holds transition timing; live capture is independently live. **Return to room** removes v2 output and invalidates old requests.

The native controller acknowledges a rendered endpoint, rather than the arrival of a UI command. This is a native source-render receipt, not proof that an encoder, remote viewer or display scanout has received that frame. The diagnostics show prepared/rendered revisions separately.

## Current limits

- The visible native room controls target its landscape program canvas. Portrait graph assembly/controller behavior is pixel-tested separately; integrated simultaneous landscape/portrait room routing and atomic dual-output takes remain unfinished.
- Compiled v2 groups, room-source bindings and ordered text/graphics batches are supported. Assets, gallery recipes and shaders still need the new authorized resource service; this adapter rejects them explicitly.
- A bounded native graphics serializer independently validates incoming plans and recomputes their viewport. Each graphics surface reserves a paint marker in an extra row; native code reads that pixel, then crops the row out of the visible placement. Dimension checks alone cannot mark browser graphics ready.
- The native video tick drives transition progress and exposes presentation time. General animation-clip sampling and per-segment timeline authoring still need integration. No UI timer advances native transition frames.
- Preparations can replace an older off-air candidate. An active transition is bounded: the caller must wait for its endpoint before another take. Rapid interruption/retargeting is still future work.
- Zero-area/hidden nodes are omitted during preparation. Activating them requires recompilation until native patch/motion support lands.
- Native takes currently use immutable data snapshots. Audience/data updates require another prepare/take until native live-binding patches are connected. The browser interaction lab continues to exercise the shared poll/data kernel independently.
- No v1 conversion or permanent fallback engine is introduced. The old runtime stays active outside the isolated feature until the full v2 cutover.

## Evidence

`npm run test:sets-v2-native` compiles the **same Rust adapter module** linked by the app and uses the **same source-type registration entry point**. It exercises actual OBS room scenes, native source authorization, strict plan rejection, graphics first-paint markers, output pixels, transitions, cancellation and cleanup. Both orientations run through this adapter in the probe.

The app-level smoke test is `python3 scripts/sets-v2/dev-room.py --smoke`. It launches the isolated app, creates one synthetic color source, switches between the two v2 poll sets six times through Tauri and the engine queue, checks readiness/rendered receipts, then returns to room and checks that old-generation requests fail. It opens no physical capture devices or streams. Its bounded report is saved to the isolated app-data directory as `sets-v2-ui-proof.json`.
