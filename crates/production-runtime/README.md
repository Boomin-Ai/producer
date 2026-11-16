# Producer production core — isolated Phase 1 laboratory

This workspace starts the Rust production document/runtime rebuild. It is **not linked into Producer**, does not replace Sets, and cannot open a camera, browser, media codec, stream, recording or user profile. The 0.4.93 desktop engine, app bundle, engine lock and backend remain unchanged.

The document stays JSON for agents and interchange. Serde derives typed Rust models; `serde_json` parses the boundary. Frame evaluation reads compiled numeric handles and keys, without JSON traversal, authoring RPC, file IO, locks or heap allocation on the measured evaluation path. Serde was already used in the desktop app; the improvement here comes from ownership, compilation, bounded work and timing semantics, not switching JSON libraries.

## What is implemented

- Separate immutable assets, live sources, explicit file players, reusable pinned components, Sets/layouts, Shows/segments and sequences/tracks/cues. Two players can use one asset with independent playheads; audio routes are explicit per bus.
- Raw byte/UTF-8/depth/value-work/duplicate-key checks, generated structural schemas, native semantic checks, safe integer counters and exact rational time. Canonical hashing uses RFC 8785 number/key rules, tested independently against JavaScript.
- Atomic incremental commands, expected revisions, native-issued opaque tickets, bounded terminal outcomes, revocation fences, undo as a new revision, a single filesystem writer and checksummed journal/checkpoints. An uncertain flush blocks further writes until recovery.
- Pure Rust layout and numeric/vector/step track compilation. Scoped component bindings are evaluated once per instance at compile time. Silent seeks reconstruct values; cue crossings and output timestamps have separate semantics.
- Synthetic prepare/take/presentation states, resource reservations, delayed disposal, generation-fenced readiness, compatible identity preservation, remove/recreate fencing and exact-token reconciliation after a lost presentation response.
- Owned overrides that hold while connected, with a five-second disconnect lease and incarnation/token fencing; bounded command admission with an independent stop intent, redacted chunked observers and a bounded/coalesced analytic renderer-data channel.
- A real stdio CLI, generated tool schema/TypeScript models, a file-free paired-layout fixture and a script that authors it incrementally, retries, saves, restarts and inspects it.

The 3D fixture declares instanced geometry/material references and typed camera/light/material parameters. **No Three.js renderer or GPU acceleration was added here.** A thousand declared instances are synthetic contract proof, not a thousand rendered objects or a measured FPS improvement.

## Run

From the repository root, using the existing Rust and Python installations:

```sh
export CARGO_TARGET_DIR="$PWD/target/production-core"
cargo test --manifest-path crates/production-runtime/Cargo.toml --locked
cargo build --manifest-path crates/production-runtime/Cargo.toml --locked
python3 crates/production-runtime/scripts/generate.py --binary "$CARGO_TARGET_DIR/debug/producer-core" --check
python3 crates/production-runtime/scripts/prove.py --binary "$CARGO_TARGET_DIR/debug/producer-core"
node crates/production-runtime/scripts/canonical-check.mjs "$CARGO_TARGET_DIR/debug/producer-core"
npm ci --ignore-scripts --no-audit --no-fund --prefix crates/production-runtime/scripts
node crates/production-runtime/scripts/node_modules/typescript/bin/tsc -p crates/production-runtime/scripts/tsconfig.json
node crates/production-runtime/scripts/schema-check.mjs "$CARGO_TARGET_DIR/debug/producer-core"
cargo run --manifest-path crates/production-runtime/Cargo.toml --locked --release -p producer-production-core --example profile
```

Windows uses `producer-core.exe`. `generate.py` without `--check` refreshes the checked-in Rust-derived artifacts. It must run after changing a contract. Structural TS/schema checks never substitute for native admission.

Other commands:

```sh
producer-core fixture
producer-core schema
producer-core command-schema
producer-core tool-schema
producer-core validate FILE.json
producer-core compile FILE.json
producer-core evaluate FILE.json opener '{"ticks":"2","rate":1}'
producer-core serve --store /EXPLICIT/EMPTY/EXPERIMENTAL/DIRECTORY --document-id classic-lab
```

`serve` reads one strict JSON request per line and returns one JSON result/error per line. It has no socket. Access to the inherited local stdio pipe is the transport authority; `hello` obtains a session. `issue` binds an exact command and expected revision to an opaque ticket; `submit` returns its durable outcome. Unknown/expired/prior-boot tickets never execute. Historical receipts can be queried by an authenticated reader. Replaying a known outcome does not execute the command again.

The store requires an experimental marker, rejects nonempty unrelated folders and symlink members, and takes an exclusive writer lock. Never point it at the current Producer app-data directory. It has **no production-folder default**. Filesystem tests cover normal flush/reopen, torn-tail recovery, corruption rejection and locking on the local test filesystem; they are not physical power-loss proof on every filesystem.

## First profile and limitations

Document ingress: 8 MiB, depth 32, 64 KiB UTF-8 strings, 1,048,576 JSON values. The value-work cap is an additional denial-of-service guard introduced during implementation; byte size alone permits large allocations from tiny values. Expanded nodes: 4,096, spatial depth 32; aggregate unused-definition validation work: 16,384 expansions. Tracks: 512; keys per track: 256. Atomic command: 256 KiB/64 operations; bulk import is separate.

Store limits: 8 sessions, 256 issued tickets with a 120-second monotonic admission lifetime; 4,096/16 MiB receipts retained at most seven days by the host wall clock; 64 MiB journal and two 48 MiB aggregate checkpoints. Ticket TTL/output time never use that retention wall clock. An OS clock adjustment may expire history early; unknown history still cannot replay. The current local CLI serializes requests; it is not an asynchronous multi-client daemon.

Synthetic adapter limits: 256 MiB CPU and GPU cost units each, 16 players, 4 captures, 4 browser contexts, 64 surfaces and voices, 152 reserved retirement slots, 160 reservation handles, 4 preparations, 30-second preparation TTL. Unknown swaps stay charged until reconciled. These estimates are conservative accounting fixtures, **not measurements or enforcement of native RSS/VRAM**. Native resource sharing/caches and correct-thread destruction need adapter qualification. This CLI opens one document per process; the planned two-document runtime-global coordinator is not implemented yet.

The synthetic runtime replaces all active outputs together. Changing the active output configuration requires an explicit stop; partial-output takes reject before swapping. Each runtime is bound to one document ID. This restriction prevents the model from retiring resources that an unreplaced output still owns; a future per-output ownership implementation must qualify that behavior separately.

Analytic 3D only: 256 typed parameters per source, 8 batches, 4,096 aggregate declared instances; the renderer channel carries at most 256 parameter values, 256 KiB packets, two pending packets and 8 MiB/s. Stateful particles, scripts, arbitrary shader/mesh imports and full-matrix streaming are unsupported. A context/generation mismatch requires new state. Two orientations can share analytic evaluation but still require two actual renders later.

There is no DOM measurement or text auto-layout. Fixed boxes and top-down row/column/grid allocation are available. The first profile does not yet expose anchors/aspect constraints, nested sequence instances, speed ramps, reverse media, native font metrics or editorial handles. Current positive constant-speed source range mapping is exact; actual MOV decode/preroll/audio is a later native gate.

Compilation currently rebuilds the full plan. Dirty-subgraph compilation and the 100,000-command RSS plateau qualification remain open. The release benchmark labels repeated **full** compile timings honestly. The synthetic lifecycle/queue/observer tests are models, not proof of a threaded renderer's stop latency or actual CEF delivery.

## Next qualification gates

The broad Phase 1 plan is **not complete** merely because these tests pass. See [readiness](READINESS.md) for A01–A25 evidence and open items. Before desktop adoption: finish nested temporal composition, global coordination and incremental compile/work scheduling; qualify real file media first; then prove GPU/CEF/Studio sampling fidelity, capture/audio, retirement threads and performance on physical platforms. Only then migrate Classic and other product capabilities and consider a release.

The four-platform CI workflow is core-only (Apple Silicon, Intel Mac, Windows, Linux). A workflow file is not a successful remote run. This local branch has not published a release or replaced any native build.

See the [current capability/authority inventory](INVENTORY.md) and [implementation review ledger](REVIEW.md) before extending this laboratory or connecting a desktop adapter.
