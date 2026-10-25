# Producer v0.4.74 — interactive sets

Release candidate; publication and Apple verification are pending.

Adds the module-based set runtime, fresh layered Grand Arena, Decision Room, Open Floor, Atmosphere and Just Facts, native prepared-scene compositing on Apple Silicon, authored landscape/portrait layouts, isolated rehearsal, and configurable operator/audience surfaces. Saved weather, Anthropic and OpenAI connections live in Integrations, with credentials retained server-side. Fixes portrait media manifest ownership, shader clock polling flicker and initial module reconnection after workspace outages.

Production enables the native adapter independently of the isolated development shell. Existing camera signing/extension migration and the native guest capability must be retained. Hosted API and audience changes must be deployed before the desktop is made latest; the dev loopback workspace is not a production dependency and no private development credentials are bundled.

This intentionally replaces the active legacy Set catalog and accepts presentation/2 packages; presentation/1 custom packages require reauthoring. Existing physical sources, mixer and unrelated account data remain owned by the room. Windows retains its existing Live engine; Intel macOS and Linux retain their existing engine-less scope. The new native prepared compositor is macOS-only.

Validation so far: desktop production frontend build, 18 module checks and 28 presentation checks passed. Hosted integration/runtime storage and tenant boundaries are being verified separately. The broad module specification is not advertised as fully implemented: dynamic region arbitration, general collections, generic effect outboxes and webhook connectors remain outside this release.
