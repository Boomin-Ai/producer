# Combined graph, service and recovery qualification

This is an isolated Rust control-service laboratory. It does not start Producer, GPUI, a native media decoder, a graphics device, an audio callback, or a production store. All documents, stores and content are synthetic. Temporary stores have unique names, require 192 MiB free before use, are bounded below 192 MiB aggregate, and are removed on exit. No physical drive is filled.

## Combined shapes

Both cases use two documents near the unchanged 8 MiB encoded limit, paired landscape/vertical layouts, 4,096 expanded spatial nodes, 128 pinned component placements and 32,768 authored numeric keys per document.

- **Flat:** 512 tracks with 64 keys each; 768 procedural effect placements in the root sequence.
- **Nested:** 128 authored tracks with 256 keys each, expanded through a two-level reusable sequence hierarchy. All definitions together reach the 512 expanded-track limit; the root has 256 track slots and 256 effect slots. Its two four-second occurrences do not overlap. All definitions together have 512 effect slots.

These are combined admitted shapes, not a claim that every independent maximum can be attained simultaneously. A 4,096-effect variant passes document/temporal validation but correctly fails compiled ownership admission. A separate earlier attempted shape with 2,046 component placements exhausted ownership scopes. The 256-scope, 1,024-resource and 4,096-relation budgets remain unchanged and reserve navigation capacity. No real graphics instances are rendered by this test.

`core/tests/pressure.rs` also checks one-over-limit nodes, expanded tracks and keys without introducing a second driver conflict, repeated torn-tail repair, retained old-ticket outcomes, repeated full 4,096-unique-receipt checkpoint loads, exact analytic inputs after recovery, and fail-closed complete-record/checkpoint corruption. The full receipt case seeds a legal boundary snapshot directly; it does not simulate 4,096 real requests or fsyncs. Existing uncertain-write and blocked-writer tests remain separate.

## Threaded pressure workload

`service/examples/pressure_proof.rs` runs the actual `Executor` and `ProductionHost<FileStore>` with eight native-scoped clients, four per document. Each process performs 24 durable edits over twelve rounds. Six ordinary checkpoints are followed by three shutdown/reopens; unread replies remain held across the last shutdown.

Every round fills sixteen completed full-document replies: eight per document and four per issuing client. The seventeenth request must fail fast and return the original request allocation. Replies remain charged until both the consumer and the control owner have released them. Tests wait for that asynchronous ownership handoff with a deadline rather than assuming reply publication implies immediate owner-drop ordering.

The executor retains at most sixteen reply buffers across serialization, unread replies and its free pool; this uses the existing response allowance rather than a second cache allowance. Inspection serializes the admitted document view directly, avoiding a second full JSON tree. After each of the three recoveries, one additional sixteen-reply burst repopulates the new executor's empty pool before steady memory is sampled. The report records these recovery warmup bursts explicitly. Pool capacity is included in live requested heap; this is not a claim that retained capacity is free.

Inspection still recomputes the current canonical digest. It uses the document owner's existing bounded wire scratch under the same serialized control ownership as edits. It does not cache a digest across revisions or reuse another document's scratch. Retained old reads remain immutable across edit, undo, close and recovery.

After each recovery, three nonmonotonic times are sampled in both documents and compared to that document's own pre-restart input packet. Document IDs intentionally participate in effect seeds: alpha and beta must not share a reference seed. An old saved ticket is retried and must return its original receipt without appending bytes. Timing samples cover the two ordinary reopens; the held-reply reopen is separately verified without a recovery latency sample.

Four thousand frames per document measure numeric-track plus effect-clock evaluation on preallocated arrays. Allocation counts are **calling-thread** counts; the process-global counter includes unrelated control-owner polling. These timings omit serialization, procedural noise kernels, media sampling and rendering.

## Gates and limitations

After four warmup rounds, requested-heap span must remain below 1 MiB, self-process RSS span below 64 MiB where supported, and released requested heap within 1 MiB of baseline. Frame arithmetic retains the existing 1 ms p99 laboratory gate. No allocator purge, tuning, sleep-based reclamation or increased cap is used. Bounded polling sleeps are only for task completion and ownership handoff.

Windows self-RSS sampling is currently unavailable and recorded as null, not as a passed Windows RSS qualification. Four-platform CI is configured to retain the proof output even on failure; no remote run is implied. An unchanged plateau is not proof of a 24-hour leak-free run or physical GPU/media memory limits.

The profile script hashes source before running and verifies it is unchanged afterward. Earlier instrumentation/harness failures remain in separate records and are not used to claim a runtime regression or performance clearance. Results and the remaining adoption gate are recorded in the readiness ledger.

## Preserved failures

The first correctly instrumented flat run failed the unchanged RSS-span gate at 291,323,904 bytes while requested-heap span and final ownership release passed. Reply-buffer reuse alone did not resolve it: a later flat run varied by 127,008,768 bytes and a nested run by 524,189,696 bytes. Their source-linked records remain in `evidence/pressure-profile-before-reuse.json` and `evidence/pressure-profile-reuse-first.json`; neither is a successful qualification or controlled timing comparison.

Those latter runs still made 144 large allocation/reallocation requests totaling 720 MiB per ordinary sixteen-read round. `ProductionHost::inspect` was creating fresh canonical wire scratch for every full-document digest. Reusing the already-owned document scratch addresses that allocation source without bypassing digest computation. Final qualification must use fresh measured evidence, not the diagnosis alone. No allocator purge, tuning or raised acceptance threshold is part of this change.
