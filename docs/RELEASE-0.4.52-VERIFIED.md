# Producer v0.4.52 — published and verified

Released September 29, 2026 (America/Denver).

- PR: https://github.com/Boomin-Ai/producer/pull/98
- Merge commit and tag: `c7c88ad2f6585f543c54356a68e30bcc6927e0f8`, `v0.4.52`.
- PR CI: https://github.com/Boomin-Ai/producer/actions/runs/36653328213 — all five jobs passed.
- Merged main CI: https://github.com/Boomin-Ai/producer/actions/runs/36654258231 — all five jobs passed.
- Release: https://github.com/Boomin-Ai/producer/actions/runs/36654118914 — all four jobs passed.
- Download: https://github.com/Boomin-Ai/producer/releases/tag/v0.4.52

Includes guest scene binding and stage echo fixes, immediate JSON persistence of guest slot edits, compact microphone/guest audio controls, responsive DJ deck/slider adjustments and channel integration guidance. Previously deployed hosted guest return and managed TURN remain live.

The published Apple Silicon DMG and updater were downloaded. Verification passed:

- Actual app version is 0.4.52.
- Deep, strict code signature validation.
- Gatekeeper accepts the app as Notarized Developer ID.
- App and DMG stapled Apple tickets validate.
- Camera extension packaging, signing identity, provisioning and plugin pairing.
- Engine dependency closure, with no Qt dependency.
- Cryptographic updater archive signature and trusted comment verification using the application's configured public key.
- DMG and updater contain matching application binaries.
- Final `latest.json` includes Apple Silicon, Intel Mac, Windows and Linux. Its Apple Silicon signature matches the verified archive's sidecar.

Artifacts and final manifest: `/private/tmp/producer-0.4.52-verification`.
Verification scripts: `/private/tmp/verify-producer-updater.mjs` and `/private/tmp/verify-producer-0.4.52.sh`.
The DMG was mounted read-only and detached after verification. The installed application was not replaced; current dev workspace edits were preserved. The release was committed from `/private/tmp/producer-release-0.4.52`.

Local checks passed: full frontend build, 21 slot/stage regressions, seven guest-return regressions, room teardown, preview lifecycle and manager cache checks. The user confirmed actual return picture in Windows Chrome. Host audio confirmation and the eight-feed M1 recording/streaming soak remain pending; this is not an eight-feed capacity certification or an SFU release.
