# Producer v0.4.50 — published and verified

Release completed on September 28, 2026 (America/Denver).

- PR: https://github.com/Boomin-Ai/producer/pull/95
- Release commit: `3e468e27ed6e43a2ee612b5f13f99af4e904e053`
- Tag: `v0.4.50`
- CI: https://github.com/Boomin-Ai/producer/actions/runs/36521427897
- Release workflow: https://github.com/Boomin-Ai/producer/actions/runs/36522022711
- Release: https://github.com/Boomin-Ai/producer/releases/tag/v0.4.50

All five CI jobs and all four release jobs passed. The release used the existing
v0.4.49 pipeline, including engine assembly, signing, camera provisioning,
Apple notarization and stapling.

The published Apple Silicon DMG was downloaded and mounted read-only. Verified:

- App version is 0.4.50.
- Deep, strict code-signature validation passes.
- Gatekeeper accepts the app as Notarized Developer ID.
- App and DMG stapled Apple tickets validate.
- Camera bundle, signing identity, provisioning and plugin pairing pass.
- Engine dependency closure passes.
- The downloaded updater archive cryptographically verifies against the public
  key embedded in Producer's configuration.
- Final latest.json contains Mac, Windows and Linux entries for v0.4.50; its
  Apple Silicon signature exactly matches the verified archive signature.
- producer.dev/download/meta.json reports v0.4.50 and all four installers.

Verification files are in `/tmp/producer-0.4.50-verification`.
The DMG was detached after verification. The installed application was not
replaced. The shared workspace's existing changes were preserved; release work
was committed from `/tmp/producer-release-0.4.50`.

The user confirmed successful Instagram publishing and working room fixes
before release. No extra social post or bulk ingestion was triggered by the
release process.
