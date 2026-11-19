# Process-owned production services

This is the isolated Rust core, not the running Producer app. `core/src/host.rs::ProductionHost` owns document services and the existing two-worker `Workspace`. The experimental stdio CLI now uses this host. Production profiles, backend authorization, desktop sessions, media and GPUI remain unchanged.

## Ownership and execution

One serialized native control owner opens stores, grants sessions, maintains observers and schedules compilation. Each open document has exactly one `Coordinator` and `Storage` writer. Opening a third document, a duplicate document, or a logically closed document awaiting disposal rejects before invoking its store factory. The factory is a trusted native IO boundary, not an agent-supplied path or callback.

The budgets are shared within this owner, not enforced through process-static mutable state. A native application must construct exactly one production host and route its adapters through it; constructing independent hosts would create independent admission domains. Tests intentionally create isolated domains. Single-host application startup and executor wiring remain native integration gates.

Cloneable `Submitter` handles permit concurrent submissions without sharing mutable document references. They borrow one document service weakly; a live call temporarily retains it. A per-document writer mutex serializes append and publication. Same-session, same-ticket, same-payload concurrent retries share a bounded in-flight result through a condition variable. A different payload or session cannot join that flight. After completion, authorized readers can retrieve the historical receipt through the coordinator's existing retry contract. Exactly-once here means **one local durable append per admitted ticket**, not exactly-once network effects.

Submission, filesystem open/checkpoint and inspection/compilation belong on a bounded control executor. They are not UI, renderer or audio-callback APIs. The core does not create a thread per request. The later isolated `producer-production-service` now supplies a fixed control owner, per-document writer lanes and a bounded inherited-pipe adapter; see [control-service limits](CONTROL-SERVICE.md). The CLI remains sequential, while native Rust clients can enqueue bounded concurrent requests. Production GPUI/app startup, remote sockets/auth and physical disposal are not wired. Native integrations must not bypass this host by constructing separate production coordinators/workspaces. Standalone modules remain available for unit laboratories.

## Shared admission profile

| Retained/admitted work | Process | Per document |
| --- | --- | --- |
| Open or closing documents/writers | 2 | 1 |
| Authenticated sessions | 8 | 4 |
| Observer clients | 8 | 4 |
| Concurrent submission/issue reservations | 16 | At most 8 concurrent service calls |
| Different in-flight tickets | 8 | 4 |
| Duplicate retry waiters | 8 | Within the 8-call document limit |
| Command wire reservations | 32 MiB | Also subject to command/import size admission |
| Held immutable inspections | 4 / 64 MiB encoded allowance | Same process pool |
| Owned writer wire scratch allowance | 192 MiB | 96 MiB (coordinator + FileStore) |

Each admitted document reserves a conservative **272 MiB encoded retained allowance**: bounded checkpoint/document/receipts, undo history (now additionally capped at 32 MiB encoded and 2,097,152 structural units), volatile receipts, the test-memory journal and observer metadata/history. This is a reservation ceiling, not allocated memory. Two documents account for 544 MiB of this allowance; writer scratch, wire and inspection allowances are separate. Each coordinator and FileStore owns one reusable buffer capped at 48 MiB; its reservation returns with document ownership. Startup, command/compile admission, canonical hashing, prospective checkpoint checks and observer hashes reuse these buffers. Receipt size accounting streams without a retained byte vector. It is **not a process-RSS guarantee**: Rust object overhead, caller-owned payloads/results/handle clones, executor ingress, recovery decoding, allocator behavior and native media/GPU pools require their own qualified bounds. The actual native expanded allocation graph remains an open gate. The durable-memory workload separately measures requested heap and self RSS for near-byte-limit and dense-value documents; see [qualification details](DURABLE-MEMORY.md). FileStore disk caps remain separate from resident accounting.

Slots are released after physical cleanup, not merely after a UI disconnect. A session disconnected during a blocked append has its grant revoked immediately, but its reservation stays charged until the coordinator can remove it. Stale external submit handles cannot keep the writer or session slot alive after exact close. Read leases deliberately remain charged until their immutable document copies are dropped, even if the original document closes.

## Failure and close behavior

- A document with a blocked writer returns `DOCUMENT_BUSY` for reads/control operations rather than waiting on that mutex. Its second document, service status, stop and logical disconnect/close remain independent. This is structural concurrency proof, not a measured desktop latency guarantee.
- The coordinator's existing atomic commit authorization remains the ordering point. A disconnect after that point cannot undo a write already in progress. It still revokes later authoring/runtime capability and prevents later queued submissions.
- A known-not-written append returns one bounded terminal rejection. Its retry does not append. Unexpectedly large adapter diagnostics are UTF-8-safely capped before entering the volatile receipt cache.
- An uncertain flush disables writes and author grants until recovery. A panic during submission wakes every in-flight waiter with an unknown-outcome error and disables further service work. The core never retries a potentially completed write automatically. Recovery reads the durable journal/receipt.
- Close first shuts admission, revokes sessions, cancels compilation and retires runtime work. `finish_close` waits for admitted calls and the workspace's exact disposal requirements before dropping the writer and returning capacity. Poisoned writer locks are recoverable for disposal after calls finish.
- Dropping the host revokes sessions immediately. An already admitted submission keeps its writer alive until the call ends. Native app shutdown still needs an explicit executor drain and physical disposal protocol; host Drop is not a hard real-time shutdown promise.

## Observer and agent boundary

Observer IDs are scoped to one authenticated session and document incarnation. Another session cannot poll, acknowledge or disconnect them. Snapshots whitelist document ID, revision/digest, Set/Show IDs and source count; they do not expose document metadata, source properties, credentials or media. Chunks require a complete matching acknowledgment; a concurrent revision or lost history requires resnapshot. Durable commit outcome is retained even if its observer projection fails.

The generated CLI tool schema now includes `services`, `observe`, `observerPoll`, `observerSnapshot`, `observerComplete` and `unobserve`. These are authenticated read/cleanup operations. `issue`/`submit` still use typed incremental commands and native admission. No remote auth or production Room Assistant connection is claimed.

## Executed evidence and remaining work

`core/tests/host.rs` exercises actual concurrent duplicates, both-document saturation, observer ownership/redaction, blocked IO, revocation, host Drop, writer panic/recovery, read leases, rejected payload accounting, uncertain IO and real FileStore writer-lock release. `scripts/prove-host.py` exercises the actual CLI/file-store path, capacity reuse, observer acknowledgment/deltas and checkpoint/restart receipt replay. Historical evidence files retain their own source identities; current checks and boundary profiling are recorded separately.

This closes the local process-owner/in-flight model gap. The later [control service](CONTROL-SERVICE.md) provides isolated executor scheduling and ingress; production startup ownership, remote transport/auth, media readiness/disposal adapters, compatible live Show handoff, a complete maximum-document/native allocation matrix and GPUI presentation remain unqualified. Those remain explicit qualification work. Numeric animation execution is unchanged; no desktop speedup is claimed.

Historical host-slice result: **150 tests and 16 check commands pass**, including five CLI proofs and 18 schema/native companion cases. The source-linked records are [checks](evidence/host-checks.json) and [core profile](evidence/host-profile.json). Six benchmark processes passed numeric/compile gates with zero numeric-evaluation allocations; standalone overlapping boundary timings point to admission/canonical work, not a qualified app-wide performance comparison.

Later document sharing and bounded wire-admission results are tracked in [the memory qualification](DURABLE-MEMORY.md). The tested large-document shapes now pass the unchanged local RSS plateau gate with owned buffer reuse. Earlier failures remain recorded. This qualified scope does not establish an absolute RSS cap, exhaustive maximum documents, native pools or long-duration leak behavior.
