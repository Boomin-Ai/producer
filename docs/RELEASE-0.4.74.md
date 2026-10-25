# Producer v0.4.74 — interactive sets

Published: [v0.4.74](https://github.com/Boomin-Ai/producer/releases/tag/v0.4.74). Release workflow [40180638764](https://github.com/Boomin-Ai/producer/actions/runs/40180638764) passed on all four platforms. Apple Silicon and Intel macOS installers passed signing/notarization/stapling. All four primary updater payloads were verified against the pinned key before publication. producer.dev/download/meta.json and all four installer endpoints report the new version.

Adds the module-based set runtime, fresh layered Grand Arena, Decision Room, Open Floor, Atmosphere and Just Facts, native prepared-scene compositing on Apple Silicon, authored landscape/portrait layouts, isolated rehearsal, and configurable operator/audience surfaces. Saved weather, Anthropic and OpenAI connections live in Integrations, with credentials retained server-side. Fixes portrait media manifest ownership, shader clock polling flicker and initial module reconnection after workspace outages.

Production enables the native adapter independently of the isolated development shell. Existing camera signing/extension migration and the native guest capability must be retained. Hosted API and audience changes must be deployed before the desktop is made latest; the dev loopback workspace is not a production dependency and no private development credentials are bundled.

This intentionally replaces the active legacy Set catalog and accepts presentation/2 packages; presentation/1 custom packages require reauthoring. Existing physical sources, mixer and unrelated account data remain owned by the room. Windows retains its existing Live engine; Intel macOS and Linux retain their existing engine-less scope. The new native prepared compositor is macOS-only.

Validation: production frontend build, 18 module checks, 28 presentation checks, cross-platform Rust CI, all 1,157 hosted API tests, deployed weather/Show lifecycle, signed audience voting/moderation and hosted Claude model access. Temporary production verification rooms were removed; no paid agent query was made in those deployment checks. The broad module specification is not advertised as fully implemented: dynamic region arbitration, general collections, generic effect outboxes and webhook connectors remain outside this release.

See RELEASE-0.4.74-VERIFIED.json and docs/set-runtime/hosted-*-proof.json for sanitized receipts. Your hosted workspace retains its own encrypted connections; no dev server, endpoint token or provider credential is bundled.
