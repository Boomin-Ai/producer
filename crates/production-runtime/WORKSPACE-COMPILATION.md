# Workspace ownership and incremental compilation

This is the third isolated Rust core slice, after `a1e0f16` and `31347cc`. It does not replace or run inside the 0.4.93 desktop. No camera, decoder, browser, renderer, recording, app profile or backend is opened or changed.

## Control and worker ownership

`Workspace` is the control-lane owner of at most two open **or closing** document runtimes. Two named OS threads perform compilation; no worker publishes output or mutates the authoritative document. Each document has at most one latest pending intent. The pending ceiling is four, but two documents with coalescing currently make the effective maximum two. There are at most two dispatched/unconsumed jobs and a two-result channel. Completed but unpolled jobs retain their slots, preventing an unbounded result backlog.

Submission validates the document, checks native authority, increasing revision/content consistency, deadlines and resource admission before superseding a pending intent. Running older work receives a cancellation flag. Failed admission leaves the preceding pending intent intact. Cancellation is cooperative at compile boundaries; full semantic validation is bounded but is not interrupted mid-check.

The control lane checks document incarnation, stop generation, newest job, revision/content intent, native grant and 30-second deadline again before installing a prepared plan and publishing its cache. Stop is independent of queue capacity. A worker that finished just before stop, revocation or a new revision cannot revive the old plan. Taking output remains a separate operation requiring the exact prepared token and source/transport/context readiness fences.

The durable `Coordinator` and the stdio authoring protocol remain the document authority. This host is a synthetic lifecycle/compile service, **not a second writer**. The production Assistant and desktop do not call it yet. Sessions, observers and journal/checkpoint limits are still independently managed by their existing isolated services; this slice does not claim a complete process-global admission manager for those services.

## What is reused

The compiler retains only the latest accepted authoring snapshot and immutable layout/sequence fragments. Unchanged fragments are shared through `Arc`; tests check allocation identity as well as JSON and numeric parity with a fresh compile. Mutable players, instances, playheads and presentations are never shared between documents.

- A layout depends on its definition and the complete transitive component-definition closure, including defaults and pins.
- A sequence depends on its definition and nested definitions, source bindings, referenced sources/file-asset metadata, and the sorted target manifest used for numeric handles.
- A changed target manifest invalidates sequence handles. Removed fragments leave the cache; active/retiring readers retain their own immutable references.
- Control labels, document metadata and other authoring-only edits can reuse every compiled fragment, but are still validated and included in the canonical document digest.

Typed dependency comparison avoids reserializing every fragment to produce cache keys. Full native validation and whole-document canonical hashing run on every build. A reuse hit therefore does not promise that the entire operation is cheaper than a fresh compile. The measured fixture remains admission/hash dominated; reuse mainly establishes correct allocation/lifetime behavior for future expensive native preparation.

## Accounting and close

One shared ledger accounts for both documents. Each retains its existing componentwise cap: 256 MiB CPU/GPU **synthetic cost units**, 16 players, four captures/browser contexts, 64 surfaces/voices, 152 future retirement slots and 160 reservations. The workspace cap is exactly twice that. Four prepared/uncertain/in-flight candidates per document is an additional ceiling, not a guarantee that four copies of a complex scene fit the resource caps.

Active, incoming, prepared, uncertain, retiring, worker and cached immutable-plan reservations coexist. Cache memory is charged conservatively as an additional CPU reservation; base-cache leases survive while a worker references them, even after close. There is no automatic cross-document decoder/texture sharing or native GPU cache here. The estimates are not a measurement or enforcement of physical RSS/VRAM.

Close cancels pending work, stops the runtime and clears the current cache. The document continues occupying its workspace slot while workers, uncertain swaps or retiring resources remain. Exact-token reconciliation and disposal are required before `finish_close` permits reopening. Sixteen bounded unopened descriptors are retained and exposed in pages; whole closed documents are not cached.

The standalone compiler/runtime APIs remain available for isolated tests. Only the `Workspace` path enforces the shared ledger; desktop adoption must route native allocation through this owner. General owner/borrower graphs, correct native destruction lanes and render-context-specific immutable sharing remain future qualification work.

## Evidence and limits

- `core/tests/incremental.rs`: fresh-compile parity, actual immutable allocation reuse, layout/component/nested sequence/file dependencies, target-handle invalidation, cancellation, invalid candidates and cache pruning.
- `core/tests/workspace.rs`: two real workers, coalescing, completed-but-unpolled stop races, authority/TTL rejection, namespace isolation, preparation pressure, stale frame rejection, uncertain/retiring charges, close/reopen fencing and descriptor bounds.
- `core/examples/profile.rs`: 1,000 expanded nodes, 256 animated tracks, flat and depth-two nested composition, 20,000 numeric samples and 30 compiles per edit mode. Reports first/full/dirty-layout/authoring-only times separately. The dirty edit changes a single layout binding, not an arbitrary maximum-size edit.
- `core/examples/workspace_proof.rs`: 100,000 small field-edit commands through the reducer and bounded two-document scheduler, with compile/release every 100 edits. Tracks requested live heap independently of cost estimates and samples this test process's RSS on macOS/Linux when available. It does not exercise 100,000 durable journal writes, maximum-size documents, native codecs or GPU allocations. Windows RSS remains unmeasured.

Run with the isolated workspace's normal fmt, clippy, tests and CLI/schema proofs, then `cargo run --release -p producer-production-core --example workspace_proof`. Current measurements and source hashes are in `evidence/incremental-profile.json`, `workspace-proof.json` and `incremental-source-manifest.json`. Historic evidence belongs to its own source manifest and is not a controlled before/after comparison.

This slice has a parent-authored code review and regressions, not a new independent adversarial review. Four-platform CI includes the new proof, but has not been run remotely. Broad Phase 1 and native/Desktop adoption remain incomplete; see `READINESS.md`.
