# Phase 1 evidence and readiness

Date: 2026-11-15. Baseline: 0.4.93, `667147951452931ebbc7f26db6dec02616aee74d`. Work: local `feat/production-core-phase1`, isolated workspace only. No app/profile/backend/native engine or release migration.

**Decision: the first core slice is implemented and locally tested. Broad Phase 1 is still in progress; desktop/native integration is not ready.** This ledger measures the A01–A25 gates of the adversarially reviewed plan rather than equating a test count with overall readiness.

## Executed checks

- `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`: pass.
- `cargo test --locked`: **42 passed, zero failed** (13 contract/ingress tests, 11 foundation tests, 9 lifecycle tests and 9 review regressions).
- `scripts/generate.py --check`: five generated artifacts match Rust.
- `scripts/prove.py`: **14 incremental durable commits**, exactly one effect per replayed ticket, saved/restarted, paired layouts, independent players and 1,000 declared analytic instances.
- `scripts/canonical-check.mjs`: independent JavaScript/Rust canonical digest parity.
- Isolated TypeScript strict check: pass. `scripts/schema-check.mjs`: five structural/native companion cases pass, including duplicate keys that a parsed JS validator cannot detect.
- Three optimized benchmark process runs: see [profile evidence](evidence/profile.json). These are synthetic **core-only** timings and allocation checks, not GPU/FPS/native latency measurements.

## Acceptance ledger

“Pass (model)” means the bounded headless behavior has an executed regression. It says nothing about physical media, threaded callback latency or GPU delivery. “Partial” names the remaining work.

| ID | Status | Evidence and remaining work |
| --- | --- | --- |
| A01 ingress/structural/semantic parity | Pass (local profile) | `contract/tests/conformance.rs`, `mutations.rs`, generated schemas and JS/native companion. Raw bytes, duplicate decoded keys, scalar byte limits, finite numbers, dangerous keys, UTF-16/JCS number rules. |
| A02 identity and activation diff | Pass (model) | Lifecycle and review regressions: scoped component identity, compatible prop edits, remove/recreate, definition/resource changes and stale incarnation fencing. |
| A03 revisions/permissions/revocation | Pass (model) | Foundation tests order revocation around native commit authorization, reject stale revisions atomically and fence later take. No remote authentication adapter is claimed. |
| A04 durable retry/in-flight dedupe | Partial | Lost-response/restart replay is tested. Stdio/control coordinator serializes submissions; concurrent in-flight transport execution is not implemented or qualified. |
| A05 persistence/crash/bounds | Partial | Single writer, torn tail, corrupt complete record, checksums, full-disk/unknown-flush injection and serialized aggregate limits. Not every filesystem operation has kill/power-loss injection; Windows directory durability remains unqualified. |
| A06 exact time | Pass (local profile) | 24-hour simulation and 10,000 seeded exact round trips, overflow/reduction, half-open ranges, ties-even endpoints. |
| A07 output PTS | Pass (model) | Content seek/pause cannot rewind monotonic output clock; epoch counter tested. Actual encoder PTS requires the native adapter. |
| A08 source/parent time maps | Partial | Independent flat trims/speeds/finite loops, negative preroll and boundary rejection. Nested sequence instance maps/loops are not implemented. |
| A09 exclusive drivers/overrides | Partial | Expanded target conflicts, owner/token/incarnation fencing and five-second disconnect lease. Full run/segment scope cleanup and authority adapter wiring remain open. |
| A10 pause/lifecycle ownership | Partial | Named pauses and synthetic removal/retirement tested. General owner/borrower graphs and segment-occurrence pause cleanup remain open. |
| A11 cues | Partial | Start/crossing dedupe, silent seek, loop policy and catch-up cap tested for flat sequences. Nested occurrence identity/rearm still needs implementation. |
| A12 players/audio routes | Pass (model) | Two independent players of one finite asset; explicit source/bus route duplicate rejection. No decode, audio generation or mix-minus change. |
| A13 hosted ownership | Pass (model) | Local commands cannot mint, modify or delete hosted state; inherited hosted authority remains read-only. Trusted hosted projection installation/transfer is future work. |
| A14 headless layout | Partial | Deterministic fixed/weighted row/column/grid, raster rounding and infeasibility including mixed min/max. Anchors, pivots and explicit aspect constraints remain open. |
| A15 bounded component expansion | Pass (model) | Pinned references, cycles, spatial depth, after-expansion node cap, scoped bindings and aggregate unused-definition work cap. |
| A16 resources/global accounting | Partial | Per-runtime reservation, retirement slots and delayed disposal are bounded. Two-document global coordinator/caches/job admission are not implemented; synthetic costs are not RSS/VRAM proof. |
| A17 uncertain/late frames | Pass (model) | Source/plan/transport/context fence matching, revocation, preparation expiry, unknown swaps and exact-token reconciliation. Stop cannot resurrect an older generation. |
| A18 stop under pressure | Pass (model) | Saturated queue retains independent stop intent. Actual multi-thread/OBS/CEF stop latency is unmeasured. |
| A19 observers | Pass (model) | Redacted revision/digest snapshot chunks, complete-ACK handshake, bounded history and gap resnapshot. No remote delivery/load test. |
| A20 CLI/Assistant schema parity | Pass (local boundary) | Incremental CLI proof, generated commands/tools/types and required native semantic companion. Production Room Assistant is not connected to this new core. |
| A21 four platforms | Not run remotely | Core-only CI matrix prepared for Silicon/Intel Mac, Windows and Linux. Local Apple Silicon passed. A workflow file is not evidence of successful remote runs. |
| A22 benchmark/fuzz/memory | Partial | Release 1,000-node/256-track evaluation benchmark and 10,000 seeded malformed byte inputs passed. Coverage-guided fuzzing, dirty-subgraph compile timing, 100,000-command RSS plateau and platform profiles remain open. |
| A23 typed analytic 3D | Pass (model) | Typed target/property ranges, expanded driver conflicts, source/resource incarnation and camera/material track compilation tested. |
| A24 analytic reconstruction | Partial | Numeric/vector track seeks reconstruct without history; stateful scenes reject. Explicit analytic effect seed/time protocol and renderer equality proof are not implemented. |
| A25 instancing/data channel | Pass (model) | Fake batch accounting, immutable resource references and bounded typed/full-state/coalesced parameter delivery tested. No meshes, shaders or instances actually render. |

## Next work, in dependency order

1. Complete nested temporal composition, occurrence ownership, scope cleanup and deterministic seek/cue tests. Add anchors/aspect constraints with rejecting-stage fixtures.
2. Implement runtime-global two-document caps, compile scheduling/coalescing and dependency-aware incremental compilation; then run the 100,000-command memory plateau and failure/saturation tests.
3. Run the core matrix and coverage-guided fuzz jobs, retain source/toolchain/artifact hashes, and close remaining Phase 1 ledger items. Do not substitute native app tests for these semantic tests or vice versa.
4. Only after contract proof, start the independent MOV decode/seek/preroll/audio ownership spike, followed by the 3D/CEF/Studio fidelity/performance matrix from the plan.

The first native spike does not automatically authorize broad app cutover. Existing recordings, assets, credentials, network ownership, permissions and the production installation remain protected throughout.
