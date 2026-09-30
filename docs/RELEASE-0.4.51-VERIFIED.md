# Producer v0.4.51 — published and verified

Released September 29, 2026.

- PR: https://github.com/Boomin-Ai/producer/pull/96
- Merge commit and tag target: `c83f343926e2da897a4bdeca1612a92ee3766cc0`
- CI (five jobs passed): https://github.com/Boomin-Ai/producer/actions/runs/36597601345
- CI on merged main (five jobs passed): https://github.com/Boomin-Ai/producer/actions/runs/36598490044
- Release workflow (four jobs passed): https://github.com/Boomin-Ai/producer/actions/runs/36598495889
- Published release: https://github.com/Boomin-Ai/producer/releases/tag/v0.4.51

The release workflow assembled the current engine, checked that the Apple
Silicon binary was not a stub, signed its nested code with Developer ID,
validated camera provisioning and dependency closure, and obtained Apple
notarization and stapled tickets for both app and DMG.

The published Apple Silicon DMG was downloaded and mounted read-only. Local
verification passed:

- App version is 0.4.51, and Gatekeeper accepts it as Notarized Developer ID.
- Deep, strict code signature verification and app/DMG stapler validation pass.
- Camera extension, signing identity, provisioning and plugin pairing pass.
- Engine dependency closure passes, with no Qt dependency.
- Downloaded updater archive verifies against the app's embedded public key.
- Updater archive and DMG have the same application binary.
- Final latest.json contains Apple Silicon, Intel Mac, Windows and Linux and
  its Apple Silicon signature equals the verified archive signature.
- producer.dev/download/meta.json reports v0.4.51 and all four installers.

Evidence is in `/tmp/producer-0.4.51-verification`, including
`mac-verification.log` and `latest.json`. The DMG was detached after the
read-only check. The installed application was not replaced. The shared
workspace's original edits were preserved; the release was committed from
`/tmp/producer-release-0.4.51`.
