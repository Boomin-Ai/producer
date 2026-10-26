# Producer v0.4.75 — 3D Sets and Just Facts

Published: [v0.4.75](https://github.com/Boomin-Ai/producer/releases/tag/v0.4.75).
[Release workflow 40319734003](https://github.com/Boomin-Ai/producer/actions/runs/40319734003)
passed all platform builds. Both macOS installers passed Apple signing,
notarization and stapling. Four updater payloads passed cryptographic verification
against the pinned public key before publication. producer.dev metadata, all four
installer endpoints and the public updater manifest report 0.4.75.

The hosted API and audience deployments passed before desktop publication.
See [exact hashes and deployment receipts](RELEASE-0.4.75-VERIFIED.json).

- Managed, bounded JSON-authored Three.js layers render on the GPU behind and
  above crisp native camera sources. Grand Arena — 3D Studio joins the picker.
- Module cues coordinate studio framing, lighting and native camera placements.
  Transitions occur only when authored by the Set.
- Built-in Sets remain available alongside saved copies, so the new Just Facts
  design can be selected without replacing a saved/customized older package.
- Just Facts becomes a host-led Show with ten questions and an optional
  tie-breaker, isolated per-question research, TRUE/FALSE guest answers,
  correctable point awards, persistent scores and host-declared champions.
- Fact-checking keeps the smaller question visible. Edited questions can publish
  before asking an agent; responses stay private until explicitly revealed.
- Reusable segment-specific controls, authored initial questions and declared
  research views are shared by desktop, hosted API and audience renderer.
- Native readiness runs on the graphics thread. Old live snapshots are evicted
  while loaded artwork stays retained; repeated recording labels are unique.

The hosted contract must deploy before the desktop becomes latest. Credentials
remain workspace-owned in Integrations. No loopback service or private token is
bundled. Guest inputs and agent-awarded points are not part of this release.
External chat adapters and the broader moderator/hardening plan remain planned.

The new native/3D output capability is Apple Silicon/macOS-only. Windows retains
its existing Live engine; Intel macOS and Linux retain their engine-less scope.
Release jobs preserve camera signing and migration, explicitly include the native
guest capability on Apple Silicon tag builds, notarize/staple both macOS installers,
and verify all four updater payloads against the pinned public key before promotion.

Validation already recorded: native all-eleven-question replay, both browser
orientations, managed 3D native/recording receipts and bounded live-cache regression.
See `docs/shows/JUST-FACTS.md`, `docs/shows/scene3d.md` and the runtime hardening plan.
Deployment and signed installer receipts are recorded in RELEASE-0.4.75-VERIFIED.json.
