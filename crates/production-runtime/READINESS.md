# Phase 1 evidence and readiness

Date: 2026-11-15. Baseline: 0.4.93, `667147951452931ebbc7f26db6dec02616aee74d`. Work: local `feat/production-core-phase1`, isolated workspace only. No app/profile/backend/native engine or release migration.

**Decision: the first core slice is implemented and locally tested. Broad Phase 1 is still in progress; desktop/native integration is not ready.** This ledger measures the A01–A25 gates of the adversarially reviewed plan rather than equating a test count with overall readiness.

## Executed checks

- `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`: pass.
- `cargo test --locked`: **80 passed, zero failed** (13 contract/ingress, 11 foundation, 9 lifecycle, 20 nested timeline, 9 review regressions, 6 incremental compile and 12 workspace tests).
- `scripts/generate.py --check`: six generated artifacts match Rust.
- `scripts/prove.py`: **14 incremental durable commits**, exactly one effect per replayed ticket, saved/restarted, paired layouts, independent players and 1,000 declared analytic instances.
- `scripts/prove-nested.py`: **16 incremental durable commits**, two nested instance levels and independent file trims, atomic conflict rejection, 11 transport events, silent seek/rearm, and identical rehearsal after checkpoint/restart except fresh execution identity. Event/work/response guards are separately enforced.
- `scripts/canonical-check.mjs`: independent JavaScript/Rust canonical digest parity.
- Isolated TypeScript strict check: pass. `scripts/schema-check.mjs`: nine structural/native companion cases pass, including duplicate keys that a parsed JS validator cannot detect.
- Historical first-slice benchmark runs: see [profile evidence](evidence/profile.json). Current flat/nested measurements: [nested slice evidence](evidence/nested-profile.json), with a separate source manifest. Across three processes per mode, flat evaluation p99 was **0.073–0.206 ms**, nested depth-two evaluation p99 **0.146–0.500 ms**, each with **zero numeric-evaluation allocations** at 1,000 nodes/256 tracks. First full compile was 40.85–67.36 ms. Repeated full compile p95 was 44.00–66.01 ms across both modes, so the 50 ms reference was **not met in all runs**. Those historical runs predate fragment reuse; they are not a controlled comparison with the current source. No host-load isolation is claimed. Historical source hashes do not certify the new implementation. These are synthetic **core-only** timings and allocation checks, not GPU/FPS/native latency measurements.

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
| A08 source/parent time maps | Partial | Independent nested placements, positive constant speeds, finite/root/ancestor loops, negative source origins, half-open seams and speed cancellation tested. Interval/cue projection requires representable intermediate boundaries; unsupported projections reject explicitly. Variable speed/reverse and physical source adapters remain future work. |
| A09 exclusive drivers/overrides | Partial | Expanded target conflicts, owner/token/incarnation fencing and five-second disconnect lease. Full run/segment scope cleanup and authority adapter wiring remain open. |
| A10 pause/lifecycle ownership | Partial | Named pauses, unwrapped root loop progress, run-owned pause reset and synthetic removal/retirement tested. General owner/borrower graphs and segment-occurrence pause cleanup remain open. |
| A11 cues | Partial | Nested scoped occurrence ancestry, independent discrete cue oracle, silent seek frontier, explicit increasing-run rearm, stop fence and atomic catch-up cap tested. External dispatch/delivery semantics remain unqualified. |
| A12 players/audio routes | Pass (model) | Independent nested players of one finite asset, post-binding playhead conflicts and inherited route membership coalescing tested; explicit source/bus route duplicate rejection remains. No decode, audio generation or mix-minus change. |
| A13 hosted ownership | Pass (model) | Local commands cannot mint, modify or delete hosted state; inherited hosted authority remains read-only. Trusted hosted projection installation/transfer is future work. |
| A14 headless layout | Partial | Deterministic fixed/weighted row/column/grid, raster rounding and infeasibility including mixed min/max. Anchors, pivots and explicit aspect constraints remain open. |
| A15 bounded component expansion | Pass (model) | Pinned references, cycles, spatial depth, after-expansion node cap, scoped bindings and aggregate unused-definition work cap. |
| A16 resources/global accounting | Partial | Two-document lifecycle/compile host now has a shared ledger, active/incoming/uncertain/retiring/cache/worker charges, delayed disposal, bounded descriptors and two real compile workers. Base-cache leases survive closing workers. General owner/borrower graphs, process-global session/observer/storage admission and native allocation/destruction remain open; synthetic costs are not RSS/VRAM enforcement. |
| A17 uncertain/late frames | Pass (model) | Source/plan/transport/context fence matching, revocation, preparation expiry, unknown swaps and exact-token reconciliation. Stop cannot resurrect an older generation. |
| A18 stop under pressure | Pass (model) | Saturated queue retains independent stop intent; stopped, superseded and completed-but-unpolled compile jobs cannot publish. Two real compile workers are exercised. Actual native/OBS/CEF stop latency remains unmeasured. |
| A19 observers | Pass (model) | Redacted revision/digest snapshot chunks, complete-ACK handshake, bounded history and gap resnapshot. No remote delivery/load test. |
| A20 CLI/Assistant schema parity | Pass (local boundary) | Incremental flat/nested CLI authoring and transport rehearsal, generated commands/tools/types and required native semantic companion. Production Room Assistant is not connected to this new core. |
| A21 four platforms | Not run remotely | Core-only CI matrix prepared for Silicon/Intel Mac, Windows and Linux. Local Apple Silicon passed. A workflow file is not evidence of successful remote runs. |
| A22 benchmark/fuzz/memory | Partial | Release 1,000-node/256-track evaluation benchmark and 10,000 seeded malformed byte inputs passed. Dirty-layout compile and the 100,000-small-edit two-document scheduler heap/RSS proof are now measured separately in the workspace evidence. Coverage-guided fuzzing, maximum-document/native/durable-write memory plateaus and remote platform profiles remain open. |
| A23 typed analytic 3D | Pass (model) | Typed target/property ranges, expanded driver conflicts, source/resource incarnation and camera/material track compilation tested. |
| A24 analytic reconstruction | Partial | Numeric/vector track seeks reconstruct without history; stateful scenes reject. Explicit analytic effect seed/time protocol and renderer equality proof are not implemented. |
| A25 instancing/data channel | Pass (model) | Fake batch accounting, immutable resource references and bounded typed/full-state/coalesced parameter delivery tested. No meshes, shaders or instances actually render. |

## Next work, in dependency order

1. Extend the nested timeline slice into general Show segment occurrence ownership and borrower/scope cleanup. Add anchors/aspect constraints with rejecting-stage fixtures.
2. Extend the implemented two-document lifecycle/compile host to session/observer/storage admission and general resource borrower graphs. Broaden the 100,000-small-edit memory proof to maximum documents and durable writes, retaining actual RSS evidence. Incremental compilation and bounded worker scheduling are implemented; full semantic admission still runs each time.
3. Run the core matrix and coverage-guided fuzz jobs, retain source/toolchain/artifact hashes, and close remaining Phase 1 ledger items. Do not substitute native app tests for these semantic tests or vice versa.
4. Only after contract proof, start the independent MOV decode/seek/preroll/audio ownership spike, followed by the 3D/CEF/Studio fidelity/performance matrix from the plan.

The first native spike does not automatically authorize broad app cutover. Existing recordings, assets, credentials, network ownership, permissions and the production installation remain protected throughout.

## Workspace/reuse slice

See [WORKSPACE-COMPILATION.md](WORKSPACE-COMPILATION.md) for the exact concurrency, ownership and cache contract, workload limits and current source-linked evidence. Across three processes per flat/nested mode, validated dirty-layout compile p95 was **12.26–13.96 ms**; authoring-only p95 was **11.94–13.82 ms**, with full compile p95 **12.00–12.93 ms**. All measured numeric paths allocated zero times. Reuse is structurally proven, but is not faster than full compilation in this admission/hash-dominated fixture. Three 100,000-small-edit scheduler runs each showed **zero post-warmup requested-heap/RSS span** at 10,000-edit checkpoints and zero final reservations. These small-document runs do not close maximum-document/native/durable-writer memory gates. The production desktop and Room Assistant remain unmodified. No new independent implementation review or remote CI result is claimed.
