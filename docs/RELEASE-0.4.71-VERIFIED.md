# Producer 0.4.71 — release verification

Release source: 22950b03452357a0248630393803bab62f16e7ac, based on stable v0.4.70. Release run: https://github.com/Boomin-Ai/producer/actions/runs/38852801199 . Native authority reuse enabled in release builds; no experimental media changes included.

35 runtime tests and five native command tests passed. Initial local failures were missing frontend assets and disk exhaustion; both were resolved before the passing command tests. Normal library crate types were restored.

Downloaded Apple Silicon installer: deep/strict codesign verification passed, Gatekeeper accepted Notarized Developer ID, app and DMG stapled tickets validated, app version 0.4.71. The updater archive verifies with the configured minisign public key, including its trusted comment, and its app executable matches the DMG executable SHA-256.

The public stable updater endpoint returns 0.4.71 and all ten platform/installer aliases. Its Apple Silicon signature matches the verified sidecar. Intel, Linux and Windows build jobs passed; Apple Silicon artifact/manifest publication completed while final cache cleanup was still running at the time this note was written. producer.dev/download/meta.json reports v0.4.71; its earlier cached response omitted Windows before the Windows asset completed.

Installed Producer 0.4.70 already has Settings → App → Check for updates. The updater checks the stable endpoint, downloads in the background, then installs and relaunches on the restart affordance. It was not installed automatically into the running user app during verification. The read-only verification DMG was detached.

Local artifact checks: /private/tmp/producer-0471-verification . Architecture HTML now shows fixes, release boundaries and measured spans. No consistent 4–5-second stable desktop startup or continuous AV qualification is claimed.
