# Producer v0.4.60 — verified production release

Published October 3, 2026.

- PR: https://github.com/Boomin-Ai/producer/pull/101
- Production merge/tag commit: `099e8ec7bba11e7ecd8875dccefe6efd61126fa8`, `v0.4.60`.
- PR CI: https://github.com/Boomin-Ai/producer/actions/runs/37142520275 — all five jobs passed.
- Main CI: https://github.com/Boomin-Ai/producer/actions/runs/37143056125 — all five jobs passed.
- Release: https://github.com/Boomin-Ai/producer/actions/runs/37143099826 — all four jobs passed.
- Published latest release: https://github.com/Boomin-Ai/producer/releases/tag/v0.4.60

Hardware-first interactive audience rooms, compact dock-aware audience controls, social share actions, native processed audio capture, monitored guest audio, isolated guest return, phone playback recovery, publisher renewal/reconnect fixes, saved vote reconciliation and room-coordinated moderator cuts are included. Existing v0.4.54 destinations are preserved. Hosted API/web fixes were previously deployed; self-hosted backend/client changes ship with this source release.

Local validation: 307 server tests, 36 engine-backed Rust tests, desktop/guest frontend builds and typechecks, lifecycle/readiness/renewal/vote/grant regressions, native FFI parity. Physical rehearsal confirmed guest audio on the Mac and Producer output on the iPhone.

Downloaded Apple Silicon DMG and updater: strict/deep code signature, Gatekeeper Notarized Developer ID, app and DMG stapled tickets, camera provisioning/plugin pairing, native engine dependency closure and identical DMG/updater binaries passed. Updater artifact and trusted-comment cryptographic signatures verified for Apple Silicon, Intel Mac, Linux and Windows against the published final manifest and the application's pinned key. Public producer.dev/download/meta.json confirms v0.4.60 and all four installers. The read-only verification image was detached.

Boomin iOS is independently checked in at https://github.com/Boomin-Ai/boomin-ios (private), commit `f51337c`. All 32 contract tests and GitHub CI passed: https://github.com/Boomin-Ai/boomin-ios/actions/runs/37142354353. This source push does not publish an App Store build.

Artifact proof: `/private/tmp/producer-0.4.60-verification`. Release checkout: `/private/tmp/producer-release-interactive`. Original development workspace and running app were preserved.
