# Producer v0.4.54 — streaming destinations

Published September 30, 2026.

- PR: https://github.com/Boomin-Ai/producer/pull/100
- Production merge/tag commit: `933361abaff2d7ff132691d62f2f1a7e44038537`, `v0.4.54`.
- PR CI: https://github.com/Boomin-Ai/producer/actions/runs/36726500668 — all five jobs passed.
- Main CI: https://github.com/Boomin-Ai/producer/actions/runs/36727818282 — all five jobs passed.
- Release: https://github.com/Boomin-Ai/producer/actions/runs/36728161681 — all four jobs passed.
- Published release: https://github.com/Boomin-Ai/producer/releases/tag/v0.4.54

Includes Facebook Live, Instagram Live, Rumble, and TikTok LIVE destinations through the native RTMP/RTMPS multistream engine. Setup guidance, platform links, inline server/key editing, preserved enabled state, and atomic destination database migration are included. Stream keys remain in the OS keychain.

Downloaded Apple Silicon version, deep/strict codesign, Gatekeeper Notarized Developer ID, app and DMG stapled tickets, camera provisioning/plugin pairing, engine dependency closure, updater archive/trusted-comment cryptographic signatures, and matching DMG/updater binaries all passed. Final updater manifest includes all four platforms and matches the verified Apple Silicon signature. Public producer.dev/download/meta.json confirmed v0.4.54 and all four installers.

Artifacts: `/private/tmp/producer-0.4.54-verification`. DMG was mounted read-only and detached. Installed application and dirty dev workspace were preserved. Release checkout: `/private/tmp/producer-release-0.4.54`.
