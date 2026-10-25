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

## Weather output flicker correction

The live portrait path previously reused the browser lease's compact media payload when calling the native prepared-scene adapter. Retaining native scenes can clear its upload manifest independently, so this could fail with `Missing media asset portrait`. Native portrait compilation now receives the complete manifest and leaves deduplication to its own preparation bank. Failed compiled plans are discarded before retry.

Atmosphere's shader is nested inside a group. Initial animation clock detection previously inspected only direct root children, causing each projection read to invent a new clock anchor. The portrait poll treated those timestamp changes as new content and repeatedly activated the same scene. Shader detection now walks nested nodes/components, and visual fingerprints exclude module acknowledgement metadata. Real visual/data changes still update the canvas.

The targeted browser test verifies no idle reactivation, no repaint for acknowledgement-only changes, one update for changed weather, and complete assets on both cold and warm native calls. Native dev verification (`weather-native-stability-proof.json`) confirms both layouts ready, no portrait error, and unchanged rendered revisions across a 6.2-second idle sample while frame serials continue advancing. Both outputs were visually inspected with current Atlanta data. This is a focused regression check, not a general frame-drop benchmark. `PRODUCER_SETS_V2_MODULE_PROBE=1` now runs this weather verification in the isolated dev room; ordinary review uses 0.

## Workspace outage and automatic recovery

A later local review exposed a shared service failure: the foreground tool-owned Worker had stopped, leaving otherwise-rendered Sets without authoritative module commands. Show start was correctly gated by module readiness, while Atmosphere remained in its uninitialized data state. The initial connection path did not retry after failure, so recovery required reapplying the Set.

The module hook now retries initial connections with bounded exponential backoff and cancels retries when the Set/room changes. The room displays a visible disconnected/reconnecting status above its control columns. Successful recovery reinstalls or resumes the intended deployment, restores its state and sends the current lifecycle without requiring a Set reapply.

The isolated development server can now run with `npm run dev:sets-v2-workspace`. This loads a login-scoped macOS launchd job, with KeepAlive and durable private credentials/data; no login-startup plist is installed. To stop it explicitly: `launchctl bootout gui/$(id -u)/ai.boomin.producer.sets-v2-local-workspace`. Foreground startup remains available. This dev helper is not a hosted deployment.

The browser recovery regression simulates an unavailable workspace and verifies automatic reconnection, module activation and Show start without reapplying the Set. Native verification exercised Just Facts Start → Next → Stop without an agent query, then applied Atmosphere with its saved weather connection, received actual conditions and confirmed stable landscape/portrait outputs. Sanitized receipt: `module-native-recovery-proof.json`. App TypeScript passed.

## Production cutover — v0.4.74

Released to GitHub and producer.dev on 2026-10-25. Desktop source c228570d8c5b63822b2c89a2287fba46b71d068d, API deployment cc3f5e2b31c75de1c4a54e8266725b684b8171c6 and audience web deployment 8ab656de2934117df1a2cb9e7d650fe729824f5e are verified. The production native adapter is enabled independently of the dev feature and does not open the isolated dev shell. Saved Set files use application-profile storage.

Authenticated production checks passed for actual weather delivery, Show Start/Next/Stop, signed audience inputs, duplicate rejection, private moderation of accepted room chat, explicit featuring and rejection of audience operator escalation. All temporary test rooms were removed. The user's saved Claude connection was transferred in memory into their authenticated hosted brand, encrypted by that backend, and passed a model-access test without a paid query or plaintext file. Atlanta weather is also available there.

The release stayed in draft until all four platform jobs and pinned-key updater checks succeeded. Both Mac installers passed Apple signing/notarization/stapling. Public installer endpoints return 200 and the updater advertises 0.4.74. Full hashes and deployment receipts are in RELEASE-0.4.74-VERIFIED.json. Earlier notes about no hosted deployment describe the pre-release development milestone; the advanced architectural limitations listed above still apply.
