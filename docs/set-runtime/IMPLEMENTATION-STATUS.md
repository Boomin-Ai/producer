# Sets v2 implementation status

Updated 2026-10-25. This supersedes the earlier foundation-only execution log.

## Working development system

The `refactor/sets-v2` worktree now uses `producer.presentation/2` packages with embedded `producer.modules/1` definitions. The parser rejects presentation/1. The active catalog contains only Grand Arena, Decision Room, Open Floor, Atmosphere and Just Facts. Archived engineering fixtures and generators remain outside the active catalog; their root versions were converted explicitly. The installed production app and primary worktree were not modified.

A Set can operate without a Show. Its modules have independent state, commands, controls and execution policies. Optional Show segments orchestrate set-owned and segment-owned instances. Rapid Show changes are forwarded individually rather than relying on React to preserve intermediate renders. Hidden execution, operator suspension, segment exit/reentry, private rehearsal and stale result fencing are implemented. The current composition contract has one explicitly declared full-canvas view controller; orientation variants select the corresponding native layout.

The editor supports source creation/binding/framing, saved integration bindings, module creation/configuration, and shared authored operator controls. Draft configuration remains private until applied. Rehearsal uses the same participant component as the audience client, with isolated identities/results and simulated weather conditions. Export excludes connection secrets and runtime state.

The managed room service serializes commands and persists authoritative module checkpoints before acknowledging commits. Epochs, command identity, trusted principals and revision checks fence stale or unauthorized inputs. Public projections exclude unrevealed totals, pending moderation text and unshown research responses. Accepted room chat can feed explicitly authorized submission modules; moderation is still required before text reaches the canvas. Show activation can publish/open eligible audience modules and close them on pause/exit according to declared policy. Standalone modules can also be operated manually.

Native output receipts now associate a module commit with a confirmed program or portrait rendering revision. An invisible state update does not require a new frame. These receipts cover the module contribution, not a universal revision for all physical room state or Show state.

## Fresh authored sets

All five use generated layered artwork and real source slots, with landscape and portrait variants:

- **Grand Arena:** retained generated arena artwork, set-scoped scoring and voting, independent host/challenger argument modules and optional segment sequencing.
- **Decision Room:** voting, explicit results reveal and a distinct results composition.
- **Open Floor:** submissions and room-chat capture, private moderation queue and featured-question composition.
- **Atmosphere:** saved Open-Meteo connection, actual normalized weather and native rain/snow/cloud effects behind sources and graphics.
- **Just Facts:** host/moderator plus two guests, question/research controls, manual response embedding, cited operator preview, explicit Show/Clear, paginated answer and question/evidence/conversation compositions.

The weather work also fixed native shader rendering that could hide a following graphics batch: procedural sources now own their display effect instead of mutating OBS's shared effect.

## Real connection and audience verification

The authorized Anthropic key was saved encrypted in the isolated managed workspace. The temporary plaintext entry file was deleted. No provider key is in a package, frontend configuration, proof receipt or repository. Connections are configured through Settings → Integrations and referenced by role from a Set. OpenAI is implemented and adapter-tested; no real OpenAI request was made because no OpenAI key was supplied.

A real Claude request completed from the native room's Just Facts controls using the saved connection. It returned four citations, remained withheld until Show response, selected the authored evidence view and appeared on the native canvas. A subsequent check reused that answer without another provider request and confirmed the exact committed module revision on the native program output.

Sanitized receipts:

- `claude-provider-proof.json`: initial authorized adapter/runtime request.
- `claude-managed-proof.json`: actual HTTP managed connection, encrypted storage and provider delivery.
- `just-facts-native-ui-proof.json`: actual room controls → Claude → explicit Show. Its early native status sample alone does not establish the final presentation revision.
- `just-facts-native-presentation-proof.json`: later exact commit → native presentation receipt, reusing the completed provider response.
- `weather-managed-proof.json`: actual saved weather connection through the module service.
- `audience-managed-proof.json`: signed participant vote, duplicate prevention, rejected authority escalation and results withheld until reveal.
- `showcase-native-proof.json`: hashes for 36 real native layout/state captures, with synthetic cameras and no remaining probe groups/sources. This is visual coverage, not a latency or load benchmark.

## Validation

- App, server and audience TypeScript checks passed; audience production assets rebuilt.
- 50 server tests passed across module service, integrations, audience room, existing interactions and core behavior.
- 18 portable module-runtime checks passed.
- 28 presentation checks passed, including rapid live lifecycle delivery and rejection of private output bindings/old package versions.
- Browser coverage passed for all four fresh package previews, authored controls, voting, moderation, explicit answer display and weather bindings. Editor/navigation responsive checks also passed during this implementation.
- 36 native authored layouts/dynamic states rendered successfully across the five packages. Landscape and portrait evidence compositions were inspected.

## Isolated review environment

Worktree: `/Users/klevelandbishop/Documents/producer-sets-v2`.

Frontend: `npm run dev:sets-v2` on loopback1436. Managed workspace: `node scripts/sets-v2/local-workspace.mjs` on loopback8795. Durable encrypted credentials and module storage reside outside the repository under the Sets v2 dev application-support profile. The helper requires that private workspace to have been initialized; it does not provision a fresh user's account or copy credentials into the repository. The native dev launcher uses this workspace only with an explicit development flag.

`install-module-showcase.py` refreshes the isolated library atomically and backs up configured rooms before Grand Arena conversion. Source assignments, framing and room media are preserved. The current library copies were refreshed after the final authored layout changes.

## Remaining architectural and release work

This is a working local end-to-end implementation, not a completed universal production protocol or hosted rollout. The backend/participant changes must be deployed and migrated in a real managed workspace before users of that workspace receive these new interactions. Live audience load, reconnect behavior across longer provider failures, cross-output latency and multi-operator contention need broader acceptance testing.

The specification's broader capabilities remain deliberately unimplemented: general region leases/layer arbitration between competing modules, arbitrary dynamic collections and layout constraints, cross-module exported/shared transactions, general timers/media suspension, webhook connectors and a durable generic asynchronous effect outbox. Current room-chat delivery into modules is best effort after chat persistence. Provider requests have persisted duplicate claims but no automatic paid continuation/retry. Runtime checkpoint persistence is bounded but rewrites state per accepted input; large-audience throughput has not been established. Legacy room-level voting remains as a fallback outside the active Set module path, not a presentation/1 compatibility parser.

Continue acceptance testing against these explicit limits; do not advertise the full ownership-and-lifecycle specification as implemented merely because these five authored experiences work.
