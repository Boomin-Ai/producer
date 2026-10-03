# Producer v0.4.53 — Guests available to everyone

Published September 29, 2026 (America/Denver).

- PR: https://github.com/Boomin-Ai/producer/pull/99
- Merge/tag commit: `ab4ab4d8be312a69aab5fc9a5b4aaabbdaad3eaa`, `v0.4.53`.
- PR CI: https://github.com/Boomin-Ai/producer/actions/runs/36656207828 — five jobs passed.
- Merged main CI: https://github.com/Boomin-Ai/producer/actions/runs/36656548513 — five jobs passed.
- Release: https://github.com/Boomin-Ai/producer/actions/runs/36656646613 — four jobs passed.
- Download: https://github.com/Boomin-Ai/producer/releases/tag/v0.4.53

Removed the Guests allowlist and Settings feature-flags row. Guests remains available during account lookup, for missing workspaces, offline lookup failures and older local flag caches. Mods and Network retain their existing account gates. Seven access regressions pass and run in CI; frontend build passes.

Downloaded Apple Silicon app version, deep/strict signature validation, Gatekeeper Notarized Developer ID acceptance, app/DMG stapled tickets, camera provisioning and plugin pairing, engine dependency closure, cryptographic updater signature and matching DMG/updater binaries all passed. Final updater manifest includes all four platforms and matches the verified Apple Silicon signature. producer.dev/download/meta.json reports v0.4.53 and all four installers.

Artifacts: `/private/tmp/producer-0.4.53-verification`. The DMG was mounted read-only and detached. The installed application was not replaced, and dev workspace edits were preserved. Release checkout: `/private/tmp/producer-release-0.4.53`.
