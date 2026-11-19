# Bounded control service

`producer-production-service` is the isolated execution/transport layer around `ProductionHost`. It has no GPUI, Tauri, renderer, media, platform capture or listening socket dependency. The CLI's inherited stdio pipe now uses it. No production app/profile/backend/release is changed.

## Ownership

One control-owner thread constructs the host and opens the explicitly selected experimental stores. It owns sessions, observers, read/validation/rehearsal requests and the existing Workspace. There is one fixed writer lane per document, with at most two lanes; durable `submit` and `checkpoint` go there. The existing Workspace retains its two compile workers. There is no thread per request, per retry or per observer.

Store opening can block startup. A large validation/inspection can occupy the control owner until its bounded operation finishes. Stop is a coalesced atomic intent applied at the next control boundary, not a preemptive hard real-time deadline. UI code must use nonblocking admission and `Task::try_take`; `Task::wait` and `Shutdown::join` belong off the UI/media callbacks. Native media callbacks do not call this service. Neither a worker count nor a byte limit proves desktop responsiveness or physical memory use.

The configured one or two document IDs and author/read-only policy are trusted native startup/connection inputs, absent from the JSON request. Every session belongs to its exact connection and document. Another connection cannot use it even for the same document. A read-only connection cannot issue writes or priority stop. `hello` creates a bounded host session, and rejects extra fields; no JSON field can mint native authority. Access to the inherited CLI pipe grants its configured local author scope. This is not remote authentication or a network daemon.

The current service has fixed document lanes for its lifetime. It supports logical close, then complete service drain; dynamic native store admission/reopen, backend identity, app startup singleton ownership and remote transport policy remain integration work. Core `ProductionHost` can still be used by its dedicated tests, but the future app must not instantiate parallel hosts to evade process quotas.

## Retained limits

| Resource | Bound |
| --- | --- |
| Configured documents | 2 |
| Connection scopes, including disconnected scopes awaiting cleanup | 8 total / 4 per document |
| Accepted requests, including unread completed replies | 16 total / 8 per document / 4 per connection |
| Input envelope | 8 MiB + 64 KiB each |
| Accepted input-byte reservation | 18 MiB total / 9 MiB per document |
| Encoded reply | 8 MiB + 64 KiB each |
| Per-document writer queue | 4 queued jobs plus at most 1 active |
| Priority stop | One coalesced atomic latch per document |

The request count reserves a reply allowance **before** enqueueing. Dequeueing or completing a request does not return capacity: the task/reply consumer must release it. Input-byte reservations likewise remain charged after parsing even though the raw input is dropped. This deliberately conservative accounting prevents an unread-reply client from creating unbounded output. Different documents have separate writer lanes and input/request caps; one blocked append does not occupy the other document's lane.

`Client::try_request` either accepts the owned envelope or returns that same allocation with an error. It does not parse, serialize or copy the input during admission. Queue contention fails with `EXECUTOR_BUSY`; exhausted reservations fail with `EXECUTOR_FULL`. The sequential CLI retries transient lock contention off callback without cloning the frame. A native adapter must retain bounded pending work and apply its own retry/deadline policy; it must not create another unbounded queue around this one.

These are count and **encoded** limits. The parser's expanded values, inspection serialization, authoring command trees, read leases, wire scratch, thread stacks and allocator residency also consume memory. Three concurrent reply encoders are possible (control owner and both writers); consumers can retain at most sixteen bounded reply buffers. This slice does not qualify the complete expanded heap/RSS graph. Earlier durable-writer memory measurements remain historical and do not automatically cover service ingress and held replies.

## Cancellation, revocation and shutdown

`Task::cancel` succeeds only before the relevant owner/writer operation starts. It cannot roll back durable work that has already begun. A queued checkpoint or submit is checked again in its writer lane before execution. An already-authorized append can finish after disconnect; its durable ticket remains recoverable after an authenticated reconnect. This is one local append per admitted ticket, not exactly-once network effects.

Disconnect immediately closes the connection and atomically revokes its session controls, even with storage blocked. The control owner then removes sessions and observers from its registries. The connection is retained strongly until that cleanup and all request/reply holds finish. Otherwise a dropped client could disappear before the owner removes its sessions, leaving stale registrations behind. Completed successful replies not yet delivered during disconnect are suppressed; callers recover committed ticket outcomes from the store after reconnect.

Shutdown stops admission, revokes scopes, cancels queued work and waits for already-started IO through explicit off-UI joining. Admission rechecks closure while holding the queue lock so it cannot enqueue behind the final shutdown drain. Owner/writer panics wake affected requests and do not automatically retry possibly completed writes. Unknown append/flush semantics and store fencing remain owned by the core. A stuck trusted storage adapter can delay joining; there is no unsafe forced thread termination or bounded wall-clock shutdown promise. Native GPU/media disposal still needs its own correct-lane protocol.

## Pipe framing and evidence

The CLI reads at most one envelope limit plus one byte. Oversized input closes the pipe with `RAW_LIMIT`; it never drains an unbounded tail or interprets the remainder as a new request. Ordinary malformed frames return bounded structured errors and can be followed by valid requests. The pipe is sequential; concurrency/cancellation is available through the Rust client API, not a multiplexed wire protocol.

`service/tests/executor.rs` exercises native-granted role/document scopes, raw rejection, saturated unread replies and stop, blocked-IO independence, queued cancellation, disconnect/close, panic-after-append, startup failure and shutdown races. An internal regression repeats connect/hello/drop 128 times and verifies that the exact retained scope is released. `scripts/prove-service.py` imports an 8,384,512-byte document, checks the bounded read reply, checkpoints/restarts and reuses its saved receipt through the real pipe/FileStore. Existing incremental Set/Show/layout and observer/restart proofs now use this same service.

Current source-linked checks and core-only numeric profiles are recorded separately in `evidence/executor-checks.json` and `evidence/executor-core-profile.json`. This is parent-authored qualification, not a new independent review or four-platform native proof. The CI matrix includes the crate/proof; remote execution is not claimed.

## Reusable bounded replies

Full-document inspection streams the admitted immutable view directly into its response; it does not first construct a duplicate `serde_json::Value` tree. Serialization writes through a checked writer into one owned buffer, with no scratch-to-reply copy. The same sixteen-buffer population spans serialization, unread replies and cached capacity. Each buffer is capped at `REPLY_BYTES`; no input, request-count, per-document or per-client limit was raised.

Buffers return before their request permit is released. Consumer-side return uses `try_lock`; contention discards capacity rather than waiting on the UI. Checkouts run on service workers. `ServiceStatus.cachedReplyBytes` reports idle retained capacity separately from active `replyAllowance`; cached bytes remain within the sixteen-buffer ceiling and disappear when the service and retained handles are dropped. Clearing the length before reuse prevents bytes from a previous document appearing in a shorter reply. A reply exceeding the byte limit is replaced by the fixed `REPLY_LIMIT` response, never by partial JSON.

The inspection digest is recomputed through the document writer's existing bounded scratch while its coordinator is held. This eliminates a fresh full-document scratch allocation for every read without caching identity across changes. The [combined pressure proof](PRESSURE-QUALIFICATION.md) includes actual retained capacity and repeated recovery; earlier RSS failures remain part of its evidence. Buffer/ownership tests alone do not clear the physical-memory gate.

This is control-plane allocation reuse, not a zero-allocation JSON API or a native GPU memory claim. The pressure/recovery workload and earlier failed RSS result are documented in [combined qualification](PRESSURE-QUALIFICATION.md).
