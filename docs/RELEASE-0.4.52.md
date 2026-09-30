# Producer v0.4.52

## Changes

- Guest slots preserve scene visibility, geometry and occupancy when switching scenes.
- Guest drag and resize releases save the slot geometry directly in the room JSON, and recreated slots restore their authored rectangle.
- Stage publications use binding state and recognize host broadcasts arriving before their HTTP response, preventing delayed guest removal after a scene switch.
- Microphone and guest audio controls fit compact docks; expanded docks retain vertical faders and mini docks use horizontal controls.
- Empty channel panels direct users to Integrations.
- DJ decks and controls adapt to short expanded docks; slider and panel sizing refinements retain the existing design.
- Guest program capture/recovery repair is included. Hosted web and managed TURN were deployed separately before this desktop release.

## Verification

Frontend build, 21 slot/stage regressions, seven return capture/recovery regressions, room teardown, preview lifecycle and manager cache checks passed locally. Release CI additionally checks frontend, server and Rust on macOS, Windows and Linux.

Apple Silicon release uses the existing Developer ID signing, camera provisioning, Apple notarization, stapling and updater signing pipeline. Published artifact verification is recorded separately after release completion.

The user confirmed actual program return picture in Windows Chrome. Audio confirmation and the eight-feed M1 recording/streaming soak remain pending; this release does not claim measured eight-feed capacity or implement the optional SFU mode.
