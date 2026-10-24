# Whole-set native preparation

Implemented in the room output path. Selecting a set queues all authored layouts, including alternate layouts with no attached show. Each design is prepared in its authored orientation. Native scenes remain resident for cached activation on Next, Previous and direct selection. An unprepared selection takes priority over background preparation. Only the set's authored transition is requested.

The room owns preparation and the shared show clock. Closing the editor or collapsing controls does not stop either. Segment/layout rows stay subtly muted while queued/loading, become fully visible when ready, and expose failed preparation with a retry action. Private editor candidates warm separately from the active room set; Show on output remains explicit.

A scene's identity covers visual structure, values, bindings, source geometry, assets and output target. Changing these prepares a new scene. Activation reuses the native graph, resets its authored geometry, and installs current animation/media transport. Static image sources are shared; independent media players retain independent clocks. A capture pointer replacement invalidates native reuse. Engine generation changes reset readiness and queue preparation again.

Native banks are bounded to 64 scenes and 768 MiB of estimated requested texture/graphics bytes per output. This is not a measurement or limit on total GPU, CEF, decoder or process memory. Old inventory records are released; current/pending native scenes have their own ownership. Uploaded asset manifests are cleared after inventory retention while prepared scenes keep their file leases.

## Verification

The native probe exercises the actual Rust adapter and OBS scene owner, including two retained scenes for each tested layout, repeated cached activation, stale visual-plan rejection, first-paint receipts, pixel assertions and cleanup. See [native run metadata](native/prepared-scenes-native-run.json) and [native assertions](native/prepared-scenes-native-proof.json).

The full isolated dev room test prepared all layouts before measuring 18 Next actions (first visits and repeats). Final click-to-native-render medians on this Mac:

| Set | Before | Prepared scenes |
| --- | ---: | ---: |
| Head to Head — The Arena | 847 ms | 102.5 ms |
| Claude Code — Build, Review, Ship | 445 ms | 100.5 ms |
| Producer — Make Your Show | 758 ms | 413 ms |

Producer includes its authored 320 ms fade. Measurements include UI scheduling, IPC and polling; they do not measure display scanout, encoder delivery or remote playback. The earlier timing baseline remains in `native/segment-timing-proof.json`. Final detailed evidence is [prepared-scenes-room-proof.json](native/prepared-scenes-room-proof.json). Shader Lab and Combo Studio each reached 32/32 ready layouts across landscape and portrait. Their reported maximum estimated per-output bank sizes were about 449 MiB and 537 MiB respectively.

Browser tests verify compile-once reuse, preparation priority, simultaneous output requests, in-flight retention, invalidation, the real room hook with fake IPC, readiness indicators and stable panel geometry. Presentation/runtime integration tests and TypeScript compilation also pass.

## Limits

An additional fitted copy of a portrait design on the landscape output is prepared when selected; every possible cross-orientation/output-size permutation is not eagerly resident. Structural/content changes can require new preparation. Oversized inventories fail visibly rather than silently evicting layouts marked ready. New data that changes compiled visuals still goes through invalidation/preparation; arbitrary audience updates are not a native property-patch service yet. This work uses the existing CEF/native compositor, not the separate future HTML-to-canvas build. Verification is macOS only and no production app was modified.
