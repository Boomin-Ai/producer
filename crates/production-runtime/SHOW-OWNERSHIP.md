# Show runs, segment occurrences and logical ownership

This is another isolated Phase 1 slice. It is not linked to Tauri or the production Room Assistant. It does not allocate a native source, play audio, dispatch a cue, decode a file or destroy a GPU object. Desktop 0.4.93, profiles and native dependencies are unchanged.

## Authoring and execution

The saved JSON document still contains typed Shows, segments, Sets, layouts and sequences. A Show has 1–256 uniquely named segments, with at most 64 Shows and 1,024 aggregate segments in a document. Each segment references paired landscape/vertical layouts and optionally a sequence. These bounds are checked natively; per-collection bounds also appear in the generated schema.

`ShowRun` pins one validated document/compiled plan and a local Show definition. Native author authority is required to start or change it; a JSON field cannot grant that authority. Reader, disconnected and revoked grants have separate behavior. Transport adapters must associate the native grant and controller identity with the correct document/session; the JSON `owner` name is not authentication.

Every explicit start creates a fresh run. Every segment entry, including reentering the same segment, creates a fresh occurrence. Seek changes the epoch without creating a new occurrence or replaying skipped cues. Completion admission checks execution identity, run, occurrence, epoch and revocation. Nested timeline cue identities are carried inside that Show envelope; an eventual dispatcher must retain both fences. This slice does not implement external effect delivery, retry or exactly-once guarantees.

The current Show profile is **manual navigation**. A finite sequence can end while its segment/layout stays active. It does not automatically advance the Show. Static segments need no artificial sequence. Pausing or resuming a static/ended sequence does not restart it.

`ExecutionScope` is `set`, `run` or `segment`. Segment-owned overrides and pause reasons leave with that occurrence. Run/Set-scoped operator pauses survive segment changes; a visibility-owned pause cannot resume a different controller's operator pause. All run-associated overrides, including those attached to a longer-lived Set, clear on stop. There are at most 256 overrides and 64 scoped pause reasons. Release reveals the current underlying value, rather than restoring an old snapshot.

A trusted disconnect call establishes the existing five-second override lease and refreshes numeric driver snapshots. Repeating disconnect cannot extend it, and a disconnected controller cannot acquire a new lease. Expiry is exact on monotonic output time. Revocation suppresses frame output immediately; it never waits for lease expiry. A native adapter must call both its authority-disconnect path and the Show's controller-disconnect path at the actual disconnect instant.

## Ownership and cleanup

`ownership.rs` separates five concepts: lifetime owner, logical borrower, exclusive controller, presentation/audio contribution, and in-flight native reads. Relation removal does not transfer lifetime ownership. Removing an owner while a logical user survives rejects atomically; removing those dependencies together succeeds. An in-flight reader may finish after its logical scope leaves, but cannot admit another read.

Handles include a fresh execution nonce and a checked counter. A resource/read/disposal handle from a different execution cannot alias after document close/reopen. Retirement retains resource capacity until an exact disposal acknowledgment names the correct lane and all reads are finished. A lane tag is a model check, not proof that an adapter actually ran destruction on the correct native thread.

Limits are 256 scopes, 1,024 resources including retirement, 4,096 combined user/dependency edges, 1,024 in-flight reads and 4,096 aggregate transitive read holds. Scope hierarchy is Document → Component/Run, Component → Component, and Run → Segment. Collections reject over-capacity requests; counters never wrap. Compiled definitions reserve capacity for the document, run and current segment; a structurally valid document can still exceed this explicit runtime admission profile.

`dependencies.rs` now compiles a bounded resource manifest for every declared asset/source, graphics batch, Set/layout, expanded component instance, font, sequence, resolved player reader and source/bus audio route. Instances and players have separate handles even when they share an immutable asset. Layouts reference the sources/fonts/components they use; sequences reference their players, routes and animated targets. Incremental layout reuse does not reuse stale resolved asset metadata in this manifest. The compiler rebuilds and validates the manifest before publishing its cache.

Show runs install this manifest with fresh execution-specific handles. The current segment contributes both paired layouts to presentation and contributes sequence audio independently of visual presence. Segment exit removes these uses without destroying document-owned sources or compiled layouts. Stop preserves those resources; document close retires them. Explicit duplicate source/bus routes still reject during semantic validation, while inherited equal routes coalesce.

A read on an admitted layout/sequence/route retains its transitive inputs. It can finish after navigation or logical close. New reads require an active, unrevoked segment and an appropriate direct use. Cycles and removal of a surviving dependency's owner reject atomically. `disposal_ready` reports eligible resources and their lanes; it never acknowledges destruction. Dependents must be acknowledged before their inputs, and held reads block both. This is an expanded logical graph, **not actual decoder/GPU allocation, a native callback read fence or verified correct-thread destruction**. Graph traversal, read admission and cleanup allocate on the control lane.

`Workspace` admits one Show execution per document from an exact, unexpired preparation. It reserves a conservative 64 MiB CPU cost before cloning control state, in addition to existing prepare/cache costs; this is model accounting, not measured RSS. The Show also pins its preparation's original resource reservation, without charging a second copy. Cancelling or expiring that preparation cannot uncharge resources the Show still borrows. Slot disposal rejects while the Show pins it. Logical close plus every dependency/read disposal releases the pin; the separate Show CPU reservation remains until workspace close completes.

Stop invalidates workers/preparations and halts the Show. Close retains the document slot until workers, Show resources and output retirement finish. `SHOW_PLAN_PINNED` rejects taking a different preparation while an immutable Show execution still owns the old one; explicitly close and dispose it first. Compatible live Show plan handoff is not implemented in this profile. Two documents have distinct execution/resource identities; they do not share disposal handles. Process-wide session/storage/observer admission remains a separate gate.

## Control and frame lanes

`apply` is an allocating, transactional **control-lane** operation. It validates authority and monotonic time, applies to a clone, and publishes only after success. It is not the per-frame callback. Independent `halt` does not require cue capacity, compile completion, a writable grant or a successful counter increment.

`evaluate_into` takes caller-owned scratch sized by `scratch_len()`: maximum tracks in a segment plus 256 possible overrides. Track/override slot mappings are prepared on the control lane. Frame sampling uses numeric indices, precompiled values and atomic revocation/lease checks, without string-path searches, JSON, file IO, locks or allocations. Explicit overrides also drive static targets and properties outside active track intervals. Stop/revoke clears the whole output scratch rather than leaving old samples.

## CLI proof and evidence

```sh
python3 crates/production-runtime/scripts/prove-show.py --binary target/production-core/debug/producer-core
producer-core simulate-show FILE.json pilot '[{"kind":"start","at":"0"},{"kind":"next","at":"1000000000"}]'
```

The authenticated `simulateShow` stdio request uses the same event model. Rehearsal is limited to 128 events, 256 KiB ingress, 65,536 aggregate control-work units and an 8 MiB response. Work includes compiled dependency scopes/resources/edges as well as tracks, players and cues. It performs no durable run-state mutation or external effects. This is not a daemon or a production room-control endpoint.

The proof incrementally authors and saves a Set, components, nested sequences and a three-segment Show through real tickets; retries each commit; rehearses segment cleanup/operator pause/static navigation/stop/close; checkpoints and restarts; and verifies identical semantic output with fresh execution/resource identities. Wrong sessions, unknown fields and oversized event lists reject.

Regression tests cover same-definition reentry, silent seek, stale completion/release fences, native permission distinctions, finite sequence endings, static property overrides, exact lease expiry, 1,000 repeated segment entries, all ownership collection caps, pending reads, two-document isolation and charged close/disposal. Local results and source hashes are in `evidence/show-profile.json` and `show-source-manifest.json`. The four-platform core CI workflow includes the proof; no remote run is claimed.

The compiled dependency slice adds eight graph regressions and three workspace reservation/handoff regressions. Its source-linked check record is [compiled-dependencies-checks.json](evidence/compiled-dependencies-checks.json). Older measurements above retain their historical source manifests.

Still required before desktop use: native allocation expansion behind the compiled graph, actual callback read fences and correct-thread destruction, compatible live Show plan handoff, native cue dispatch, global service admission, physical media/GPU qualification and a fresh independent implementation review.
