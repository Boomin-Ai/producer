# Set runtime and 3D hardening plan

Status: execution roadmap, updated 2026-10-28. Producer 0.4.76 is published; signing and publication do not certify failure containment. This records requirements and proposed work; it does not claim that every safeguard, adapter or moderator control described here exists today.

## Goal and release promise

Support a large ecosystem of independently authored JSON sets without allowing a malformed, expensive or disconnected experience to destabilize Producer. Sets remain standalone; Shows optionally orchestrate them. Modules remain independent runtime objects with isolated state and explicit shared-state permissions.

Target promise: **a set may fail or stop rendering; Producer keeps running, and a failed preparation does not replace healthy output.** This is an engineering target, not a guarantee established by the current prototype. The browser renderer, GPU driver and native compositor still cross failure boundaries that require investigation and testing.

Fully delegated moderator operation is a core scaling requirement: an authorized production team must be able to operate the set system without requiring the host to perform every action.

Related contracts:

- [Ownership and lifecycle](OWNERSHIP-AND-LIFECYCLE.md)
- [Implementation status](IMPLEMENTATION-STATUS.md)
- [Showcase and audience plan](SHOWCASE-AND-AUDIENCE-PLAN.md)
- [Managed 3D layers](../shows/scene3d.md)
- [Metal navigation lifetime repair and regression evidence](../sets-v2/NAVIGATION-LIFETIME.md)
- [Shared view and immutable graphics caching](../sets-v2/VIEW-CACHE.md)
- [Versioned layer masks, animated reveals and GPU backdrop blur](../sets-v2/VISUAL-EFFECTS.md)
- [Existing external chat output](../CHAT-OUTPUT.md)

## 1. Current foundation and gaps

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| Composition | Three.js renders managed 3D environments; the native compositor handles live cameras, text and slot motion. | Broader hardware coverage, sustained load tests and enforceable combined budgets. |
| 3D input | Versioned declarative world descriptions, trusted renderer, JavaScript/native validation and bounded resources. | Full conformance suite, admission control and runtime cost enforcement. |
| Presentation | Prepared resources, per-output revisions, browser reports and native surface fences. | Fault injection, lifecycle stress and recovery coverage; no claim of atomic cross-output presentation. |
| Audience | Boomin audience-page voting/interactions work; its room chat feeds eligible submission modules. | External chat-to-module adapters and explicit participation policies. |
| External chat | Twitch, Kick and YouTube readers already normalize messages for Producer's chat display/overlay. | They are not currently wired into set voting, submissions or action execution. |
| Moderator operation | Existing moderation and operator primitives are building blocks. | Verify existing permissions and build complete, delegated remote set operation; ordinary chat moderation is not full set control. |

Native crash reports exposed invalid Metal render-target access in the readiness path. Probes now run on OBS's graphics thread. Cold 3D preparation has a longer first-paint deadline. Initial native and browser checks passed; a longer run remained alive through repeated cues and a manual set switch, but that switch interrupted the 120-cycle soak. This is useful development evidence, not release certification.

## 2. Contract structure and compatibility

Keep three contracts distinct:

1. **Package schema:** portable definitions, assets, modules, controls, composition, views and required capabilities.
2. **Runtime contract:** ownership, grants, lifecycle, command ordering, transactions, effects and resource limits.
3. **Command/event protocol:** authenticated requests, event identities, revisions, receipts and reconnect behavior. Internal callers and future remote transports must share these semantics.

Version these independently. Publish supported versions and capabilities before activation. Reject unsupported required capabilities with actionable errors; optional fallback behavior must be authored explicitly. Never silently reinterpret an unknown action or introduce an unauthored transition.

Define unknown-field handling, defaults, units, numeric precision, identifier/reference rules and migration policy. Separate the immutable package definition from live instance state, connection bindings and saved room configuration. Treat migrated packages as validated new documents; preserve a recoverable prior copy and compatible user values/bindings.

Ship machine-readable schemas, valid/invalid fixtures, an authoring guide and an offline validation command. Validator success means structurally supported, not guaranteed affordable on every device.

## 3. Validation and admission control

Validate before decoding assets, creating sources, opening connections or allocating GPU resources. Revalidate at native/server trust boundaries; frontend validation is not authority.

Required checks include:

- Package bytes, nesting depth, string lengths, bounded arrays/maps, unique IDs, references and dependency cycles where prohibited.
- Finite numeric values, safe dimensions and transforms, valid cameras/clipping ranges, animation durations and bounded geometry subdivision.
- Supported node/action/material types and valid binding/output types.
- Asset media signatures, decoded dimensions, decompressed bytes and permitted formats; archive traversal and expansion limits if archives are supported.
- Capabilities, region ownership, source bindings and lifecycle policies before activation.
- Aggregate costs across retained layouts, modules and simultaneous portrait/landscape outputs, including temporary preparation and transitions.

Imports must produce useful field-path errors without freezing the UI. An invalid new package leaves the current set and room configuration usable. Credentials, filesystem access, provider calls and arbitrary network URLs are not granted by importing JSON.

## 4. Resource budgets and runtime enforcement

Current documented 3D bounds include up to two passes per layout, six retained contexts and 24 Mi logical pixels per output store; world limits include 128 meshes, eight lights, eight slots, twelve views and thirty-two cues. These are existing bounds, not a complete hardware safety model.

Add explicit combined budgets for decoded textures, GPU texture memory estimates, vertices/triangles, material/shader variants, draw calls, shadow maps, render targets, effects, active contexts, asset decoding, queued actions, subscriptions and generated controls/collections. Budget lighting/shadows and model complexity by cost as well as object count.

Admission must include peak overlap: old live output plus preparing output plus transition resources. Failed preparation and cancelled work must release their reservation. Account for renderer scale and resolution changes.

Runtime enforcement needs measured frame-time pressure, bounded work per tick, queue backpressure and bounded recovery attempts. Define predictable quality tiers and an observable overload state. Degradation may reduce optional effects or pause background rendering; it must not silently change authoritative module state, audience results or source bindings.

## 5. Trusted execution and failure containment

Managed 3D packages remain declarative. They do not supply arbitrary JavaScript, unrestricted shaders or executable plugins. Any future code-extension capability requires a separate authorization and isolation design.

Specify and test the actual boundaries between package processing, provider effects, browser/CEF rendering, GPU transport and the native compositor. A browser process boundary alone does not establish protection against GPU-driver or native memory faults. Identify failures that can still terminate the app and reduce those failure paths before public authoring claims.

Keep current output while preparing replacements. Distinguish preparation failure, renderer failure, context loss, stale receipts, resource exhaustion and unavailable dependencies. Recovery must be bounded, cancellable and visible to operators; repeated failures must not create an automatic crash/restart loop.

All graphics operations must obey thread ownership, source/texture lifetime and teardown ordering. Cancel timers, abort effects, release subscriptions and dispose worlds on unload. Repeated cues must reuse resources; repeated set switching must not accumulate sources, GPU contexts or hidden work.

### Source ownership and dev-test cleanup

Room sources and layout placements are distinct. A new layout or camera pose should normally reuse its bound room source; a geometry variant is not a reason to create another camera capture. Multiple deliberately distinct sources remain valid, so labels alone cannot establish duplicates.

The isolated studio currently contains repeated host-camera and challenger-color room sources left by native acceptance runs. Test setup creates a new source when it cannot reuse an assigned, ready source, while the room persists earlier entries. These are saved sources, not the six layout definitions or Three.js meshes.

Require explicit ownership/provenance for test-created and set-requested sources, stable reuse rules, readiness handling during restore and cleanup of abandoned test resources. Preserve sources referenced by any saved scene, set binding or active guest path. Use source IDs and reference checks for cleanup; never delete all similarly named sources or assume every currently unbound source is disposable.

## 6. Deterministic state and presentation

Maintain the authority hierarchy in the ownership contract: Room owns devices/mixer/output; Set instance owns composition grants/shared state; Module instances own local behavior; Show runs orchestrate; renderers present committed snapshots.

- Serialize conflicting commands through the authoritative commit path. Define transaction boundaries and stale-write behavior.
- Enforce exclusive-region leases or explicit layered contributions; draw priority is not permission.
- Keep execution, visibility and ownership separate. Declare hidden, paused, segment-exit, restart and disposal policies.
- Give asynchronous effects request identities, epochs, timeouts and cancellation; stale completions cannot mutate replacement instances.
- Distinguish Accepted, Committed and Presented. Track per-output presentation separately; invisible changes need no invented frame acknowledgement.
- Keep permissions and validation identical for host, moderator, Show, audience, connector and rule-driven requests.

## 7. External chat adapters

### Intended flow

```text
Connected platform chat reader
  -> normalized authenticated/provenanced event
  -> room participation policy + dedupe/rate limits
  -> set-authored command/submission mapping
  -> authorized module command
  -> authoritative commit
  -> native/3D presentation and operator receipts
```

Reuse existing chat connections and the module runtime. Boomin currently supplies structured participant interactions and a chat-submission path. External adapters translate messages into the same supported module operations; they must not create an independent scoring or voting engine.

The set may declare commands such as `!blue`, `!gold` or `!question ...`, eligible target modules and required review. These are design examples, not an implemented package field or currently enabled cross-platform voting feature.

### Event and adapter requirements

Define a versioned event with platform, connection/channel identity, platform message ID, stable sender identity where available, display name, text, event kind, source timestamp and received timestamp. Credentials remain in the connection service. The existing normalized display message is a starting point; inspect each reader's actual identity guarantees before using it for voting eligibility.

Namespace message and sender identities by platform/channel as appropriate. Display names are not voter identities. Default to platform-scoped identities; do not claim one-person-one-vote across networks without a separate account-linking mechanism.

Declare deterministic parsing, case/whitespace rules, command collisions, poll selection, multiple active modules, edits/deletions, vote changes and late arrivals. Chat text must never select arbitrary action names or gain operator authority.

Enforce room/module epochs, open-intake state, bounded payloads, dedupe retention, per-sender/channel/module limits, bot policy and burst backpressure. Reconnect history must not cast old votes into a new round. Preserve original event identity across retries and define duplicate handling independently from any transport's delivery guarantees.

Connection loss must be visible and must not stall other networks. Audit accepted/rejected commands with useful reasons. Verify platform API permissions and constraints when implementing each adapter.

### Automatic audience setup

Loading or importing a set should validate and prepare its declared audience experience. Going live or explicitly opening intake activates the authorized live interactions; import alone must not publish a poll or execute live effects. Rehearsal uses an isolated simulation domain and must not consume real audience votes or leak simulated ones into live results.

A connected, supported network should not need manual recreation of every poll or command. The operator still selects participating connections, grants capabilities and approves policies. Native buttons on the Boomin page and chat commands on another platform can target one module; connecting a network does not grant the ability to add custom buttons to that network's UI.

## 8. Full moderator operation: a scaling requirement

**Authorized moderators must be able to fully operate the Set and Show system remotely through the same schema-generated controls and authoritative command path as the host.** This is a product requirement, not just permission to delete chat or approve one poll.

Delegable scope must cover:

- Load/import/select a set, prepare privately, rehearse and apply to output.
- Select layouts/views, operate camera-slot framing and bindings within granted room sources, and trigger lighting/3D cues.
- Start/pause/resume/reset modules; edit exposed fields; open/close intake; review submissions; manage scores and reveal results.
- Start, navigate, pause and stop Shows; operate segment-specific controls without resetting unrelated persistent modules.
- Configure audience participation/command mappings and select approved integration bindings.
- Inspect loading/failure state, retry permitted work and restore a known healthy output.

Provide a full-operation grant plus narrower grants by room, set, module and action. The host chooses delegation; do not impose host confirmation on every ordinary action after full operation is granted. Applying a prepared set remotely requires that the host renderer can receive, validate and execute the authorized command even though it owns local device/GPU access.

Set operation does not automatically expose provider API keys, stream keys, account administration or unrelated physical devices. Granting access to an approved connection must not reveal its secret. Existing platform moderator status must not automatically confer Producer set-operator privileges.

Use authenticated sessions, server-enforced grants, revocation/expiry and authority epochs. Revocation rejects queued stale operations and cancels effects according to policy. Host emergency stop/revoke remains available.

Multiple moderators and the host must see consistent state, busy/loading status, revisions, failures and per-output receipts. Define control ownership for conflicting operations, optimistic concurrency for edits, reconnect/resync, and recovery after the host or moderator disconnects. A remote UI click is not proof that the local output changed.

Audit who changed what, on which instance, with command identity, authorization outcome, commit revision and presentation outcome where relevant. Add bounded history and explicit reversible actions where supported; do not promise generic undo of external side effects.

Acceptance must include a host who is only presenting while a remote moderator prepares/applies a set, runs its Show, operates 3D cues, handles audience interactions and recovers a failed preparation. Test grant narrowing, revocation and conflicting operators in that same workflow.

## 9. Validation and release gates

| Gate | Required evidence |
| --- | --- |
| Schema conformance | Version/capability compatibility fixtures, cross-validator agreement and actionable rejection of malformed packages. |
| Fuzz/adversarial input | Nested/oversized documents, extreme numbers, invalid references/assets, action storms and bounded collection expansion without hangs or unbounded allocation. |
| Native lifecycle | Long sessions, repeated prepare/apply/unload, set swaps during motion, source deletion/rebinding, cancellation and app restart. Monitor memory, resources and crash reports. |
| Rendering | Simultaneous portrait/landscape, recording, guest reconnects, resizing, context loss and renderer failure. Validate actual output frames and retained healthy output. |
| Resource pressure | Combined peak budgets, low-memory conditions, slow devices and quality fallback. Measure workload-specific frame time and leaks. |
| Audience adapters | Shared fixtures plus each real platform: duplicate/reordered/late events, reconnect replay, concurrent polls, bots, identity scope and connection failure. |
| Rehearsal/live isolation | Simulated interactions never change live state; real intake remains inactive until authorized activation. |
| Moderators | Full remote operation, scoped grants, revoke mid-operation, reconnect/resync, operator conflict and host emergency override. |
| Deployment | Supported OS/GPU matrix, version migration, capability discovery, packaged assets, signed builds and release rollback. |

Automated browser tests are necessary but cannot certify native/GPU stability. Short compositor measurements do not establish GPU-only cost or broad hardware support. Publish reproducible workloads, measured limits, known failures and completed versus interrupted results.

## 10. Implementation phases

1. **Baseline and observability:** inventory existing enforcement/permissions, reproduce failures, establish resource counters, sustained native tests and safe source/world cleanup.
2. **Contract and enforcement:** finalize versions, validation, capabilities, budgets, thread/lifetime invariants, failure retention and the conformance toolchain.
3. **Moderator authority and control:** implement shared authorization/command semantics and full remote operating surfaces early, so later capabilities inherit delegation.
4. **Chat adapters:** define the common ingress contract and set mappings; implement platform adapters incrementally with rehearsal/live isolation and real connector tests.
5. **Controlled visual expansion:** reusable materials, generated textures, imported models and selective effects only behind validated capabilities and budgets. Use Grand Arena as the polished end-to-end reference.
6. **Public authoring readiness:** satisfy release gates, publish authoring/conformance tools and clearly state supported capabilities and operating limits.

These phases build on the current runtime. They do not replace the module model or move native camera composition into Three.js.

## Decisions to resolve before implementation

- Initial device/quality tiers and exact peak CPU/GPU/memory budgets.
- Native/browser isolation gaps and the practical scope of crash containment.
- Moderator authentication, full-operation grant UX and conflict policy.
- External chat stable-identity guarantees, round/replay policy and command ambiguity rules.
- Asset/model formats, packaging, provenance and validation strategy.
- Public schema stability, migration support window and compatibility test distribution.


### Open native crash observed during Atmosphere 2.1 review (2026-10-27)

The redesigned Set passed the browser/native-lowering checks and a complete native diagnostic recording of three composition changes plus four forecast changes. The normal dev app also crashed once during development, before the motion proof began. Report: `producer-2026-10-27-070127.ips`; graphics thread: Swift release in `device_begin_frame + 88`. The loaded backend UUID was `4098F9BA-761B-39AF-8961-AAF258698940`, matching the backend containing the swapchain synchronization patch. Therefore the earlier swapchain test is evidence for that specific race fix, not proof that every render-target lifetime issue is closed.

The actual backend, compiled with Thread Sanitizer, completed all seven native changes without a sanitizer report (`ignore_noninstrumented_modules=1` avoids an Apple Security interceptor deadlock). This is diagnostic evidence, not a root-cause fix or production stability signoff. Keep this crash open until it has a reproducer and a validated correction. Restore the ordinary tested backend after diagnostics; sanitizer libraries must never ship. At the time of that review the UI/Set work was local and unpublished. It subsequently shipped in 0.4.76; that publication does not close this crash.

## Prompt-to-Set execution roadmap — agreed 2026-10-28

The order is reliability, common authoring validation, structured controls with moderator authority, then bounded generation. Atmosphere and Attention Is Currency are the first reference packages. Existing user values, room sources, integration bindings and saved packages must survive this work. Each milestone is accepted by recorded evidence, not by the existence of a UI.

### Milestone 1: reliable loading and safe replacement

Status: **started, not accepted**. The known `device_begin_frame` crash remains open. A newer Rust abort must be triaged separately; a common application name does not establish a common cause.

- Inventory crashes with app/backend hashes, failure signature, triggering operation and environmental limits. Diagnostics must exclude credentials, private media and provider responses.
- Map thread ownership, native texture/source lifetimes, callbacks and teardown. Reproduce the known signature or a demonstrably causal defect against the actual pinned backend. Use a negative control where practical. A speculative lock or suppressed error is not a verified repair.
- Establish the replacement transaction: validate, reserve peak resources, prepare privately, establish readiness, take on the intended output, acknowledge presentation, safely retire old resources. Failed preparation retains healthy output; cancelled or superseded candidates cannot take over later.
- Record bounded counters and receipts: candidate/active identities and revisions, lifecycle phase, output-specific readiness/presentation, failure reason, preparation time and retained sources/contexts. Distinguish measured memory from estimated GPU allocation.
- Test cold/warm switches, interrupted transitions, resizing, source unbind/rebind, shutdown/reopen, provider loss and renderer failure. Include portrait/landscape simultaneously and recording. Use owned synthetic sources; preserve the user's live devices and saved rooms.

Acceptance: at least 500 replacements and a 60-minute sustained run on the initial supported Apple Silicon configuration, with no crash, stalled recovery or unbounded post-warmup resource trend. Injected failures must leave identifiable healthy frames visible; cancelled candidates must never become active. Save hardware, resolutions, exact code/backend hashes, workload, frame evidence and resource maxima. Interrupted runs are incomplete. A clean soak cannot by itself establish the cause of a crash: closure requires causal evidence, a corrective change and regression coverage. Expand hardware coverage before making wider claims.

### Milestone 2: one bounded authoring validation pipeline

Status: **partial foundation, full gate pending**. Inventory the existing package parser, native validators and server checks before adding another parser.

Every import, generated candidate and agent edit must use the same validation/admission stages. Supply an offline validator with machine-readable error codes and field paths, supported capability versions and useful human explanations. Structural checks precede decoding and native allocation. Validate asset signatures, decoded dimensions, decompressed bytes and permitted formats rather than trusting file extensions or metadata. Aggregate admission includes old output, candidate, retained variants, both orientations and transition overlap.

Publish a feature manifest derived from implementation, valid/invalid fixtures and authoring examples. Verify JavaScript/native/server agreement at their overlapping boundaries. Unknown required features fail explicitly; fallbacks are authored. Keep immutable definitions separate from live state, room preferences, connections and secrets. Persist candidates atomically with a recoverable prior version.

Acceptance: adversarial documents/assets fail within bounded time and memory with useful errors. Imported and generated packages follow the same rules. An invalid update leaves the installed package and current output usable. Validator success establishes supported structure and admitted resources, not universal stability.

### Milestone 3: structured controls and saved arrangements

Status: **implemented locally; host browser acceptance passed, native release acceptance pending**. Optional `set.controlArrangement` declares expanded sections and explicit minimized references. Control action/state identity is independent from placement. Both surfaces reference the same stable control IDs and authoritative actions. Preferences are personal to this device, endpoint, room and Set ID; they are not shared moderator preferences or package mutations.

- Expanded controls have named sections, authored order and contextual visibility.
- The minimized bar shows only explicitly placed controls. No placement signal means absent; do not infer placement from labels. Its order is independent of the expanded panel.
- Users can toggle minimized inclusion and reorder it, and separately reorder/collapse expanded sections. Save these as room/Set-instance preferences rather than modifying package defaults.
- Reconcile preferences by stable ID after upgrades. New controls follow authored defaults; removed controls leave no dangling entries; incompatible control-type changes need migration. Provide reset to authored layout.
- Visibility depends on declared view/segment/state and permissions. Hiding a control does not destroy its state; showing it grants no authority. Explain disabled actions, bound counts/labels/overflow, and support keyboard/accessibility.
- Distinguish accepted, committed and presented status. Reconnect must resynchronize authoritative state; optimistic feedback cannot claim an output change.

Acceptance: Atmosphere works from both panels; reordering one leaves the other intact; preferences survive reopen and compatible updates; undeclared controls never appear minimized. Context changes/reconnect preserve unrelated state. Exercise narrow windows, long labels and keyboard use.

### Milestone 4: complete moderator delegation

Status: **partial — module push accepted as a partial checkpoint; DO control foundation in progress**. Implement alongside milestone 3, before claiming scalable operation. Audit existing grants and use the shared authoritative path for host and moderators. Specify whether arrangement preferences are personal or shared; never silently conflate them. The user approved continuing beyond the module-push checkpoint on 2026-10-28; this does not waive the remaining acceptance gates in milestones 1–3.

Acceptance: while the host only presents, a remote moderator can prepare/apply a Set, select compositions, bind/frame permitted sources, edit fields, run modules/Shows, inspect failures and restore output. Test narrower grants, conflicting edits, reconnect and revocation during pending work. Queued stale operations must not apply after revocation. Never expose provider/account secrets. Follow section 8 for the full operation matrix and output receipts.

### Milestone 5: bounded prompt-to-Set generation

Status: **not implemented**. Begin with supported declarative nodes/modules and validated examples, not unrestricted generated renderer code.

Flow: **prompt → constrained draft → asset jobs → validation/admission → private preview/rehearsal → prepared candidate → explicit take → presentation receipt**. Prompt submission alone cannot replace broadcast output. Future automatic takes require an explicit standing grant and the same runtime checks.

Use a provider-neutral authoring service. Send the public schema/capability manifest, relevant examples, brief and permitted asset references to a configured provider. Credentials stay in Integrations. Connecting ChatGPT and configuring an API model provider are distinct paths; select the intended connection protocol explicitly rather than implying one provisions the other.

Generated text, images and models are untrusted candidates. Keep decorative assets separate from editable text, native camera slots, data bindings and controls. Track asset identity/hash, provenance, formats, decoded limits and declared usage rights. Generated URLs confer no arbitrary network/filesystem permission. Start with supported images; add model formats only with bounded decoding/rendering.

Each job needs identity, owner, base package revision, capability requirements, time/token/asset limits, cost ceiling, cancellation and durable status. Bound automatic repair attempts and return precise validator errors to the model. Stop with useful feedback when budgets are exhausted; never silently switch to a more expensive provider. Fence late completions after cancellation, replacement or grant revocation. Paid retries require explicit policy and durable deduplication.

Edits produce a reviewable new revision, preserve compatible IDs/values/bindings, and disclose unsupported requests or dropped features. Never flatten a functional Set into a generated poster. Failure leaves the current Set available.

Acceptance: a fixed prompt corpus produces validated portrait/landscape Sets with editable text and working host/reference slots. Inject invalid model output, failed assets, provider limits, disconnects and cancellation. Record first-pass validity, bounded-repair success, latency/cost, preparation success and actual presentation results. Set measured rollout targets before calling the generator ready; a few demos do not establish a success guarantee.

### Milestone 6: controlled rollout and continuing conformance

Status: **pending milestones 1–5**. Use a limited cohort and published capability/hardware matrix. Pin schema/package/provider revisions, retain previous healthy packages and support Set/application rollback. Maintain adversarial fixtures and sustained native workloads as release gates. Implement chat adapters separately against the same authority path; they are not required for the first useful solo-host generated Set.

Track completed, failed and unverified acceptance items separately. Public authoring requires the applicable section 9 gates. Native/GPU crash containment remains an explicit limitation until demonstrated.

### Extensible data adapters — required foundation for milestones 2 and 5

Status: design requirement, not a claim that a universal adapter runtime exists.
Inventory existing integrations and evolve their contract rather than introducing
a competing connection store. Set packages reference logical data objects and
typed outputs; room bindings select authorized connection instances. Credentials,
provider-specific authentication and network execution remain outside packages
and render callbacks. Adding a conforming adapter must not require per-provider
changes to the renderer or to every Set consuming its compatible output.

- A versioned registry manifest declares adapter identity, supported contract
  versions, configuration/input/output schemas, units and timestamp semantics,
  authentication requirements, operations, transport and freshness capabilities.
  Discover supported bindings from this manifest; never invent provider fields.
- Support extensible transport implementations: HTTP polling (including REST and
  GraphQL), inbound webhooks, and subscription streams such as SSE/WebSocket.
  A generic HTTP connector handles bounded declarative mappings; provider-specific
  authentication, pagination or semantics may require reviewed adapter code.
  “Extensible” does not mean every API works without implementation or permission.
- Separate raw provider payload validation from typed projection. Expose explicit
  snapshot versus event semantics, stable identities, observed/fetched timestamps,
  units/timezones, freshness, unavailable/null values and recoverable errors.
  Never present missing values as zero or mislabel polling as real-time streaming.
- A shared scheduler handles bounded concurrency, pagination, request timeouts,
  retry/backoff with jitter, rate limits and cancellation. Bound payload size,
  queue depth, retained history, transformation cost and update frequency.
  Coalesce snapshots where appropriate; event loss/overflow must be explicit.
- Cache keys include tenant/connection authorization scope, adapter/schema
  version and canonical effective inputs. Define TTL, stale fallback, refresh
  and invalidation policy per operation. Fence late results after input changes
  or revocation; do not let a prior city's response overwrite the current city.
- Webhook ingress verifies signatures/authentication as supported by the provider,
  enforces bounded bodies and replay policy, and routes by authorized connection.
  Define deduplication, ordering, delivery acknowledgement and durable processing
  guarantees explicitly. Outbound side effects are separate authorized actions;
  a data binding cannot implicitly send messages or execute transactions.
- Enforce tenant isolation, secret redaction and network destination policy at
  execution, including redirects. Imported/generated URLs are not permissions.
  Support connection revocation, version migration and adapter disablement
  without destroying the last healthy Set or blocking unrelated integrations.

Acceptance: run a common adapter conformance suite with deterministic fake
providers, then credentialed sandbox tests for each real connector. Cover 429s,
timeouts, expired auth, malformed/oversized payloads, pagination, duplicates,
out-of-order events, bursts, disconnect/resume, schema evolution and cross-tenant
isolation. Prove one polling adapter and one webhook adapter can supply typed
data to multiple Sets without renderer changes. Add a new test adapter using only
registry/adapter code and bindings. Chat command adapters additionally obey the
authority rules in section 7; data updates do not automatically become commands.

### Prompt-to-Set evaluation protocol

Maintain a versioned prompt corpus with explicit expected behavior, not one exact
expected JSON document. Include Atmosphere-style weather, a magazine host cover,
a host/reference discussion, a scored question show, live growth charts, animated
masks, blur and supported 3D combinations. Include edits to existing Sets and
unsupported/ambiguous requests. Keep held-out paraphrases and novel combinations
to detect overfitting. Treat prompt/provider data as untrusted input.

For each prompt:
1. Generate using a pinned model/configuration, capability manifest and allowed
   adapter catalog. Record generation parameters, package/asset hashes, budgets,
   attempts and timing; preserve a replayable artifact without secrets. Repeat
   samples because fixed settings do not guarantee deterministic model output.
2. Run the common package, capability, asset and resource admission checks.
   Measure first-pass success separately from bounded repair. Never silently
   delete requested features merely to obtain a passing package.
3. Mount with synthetic camera/reference sources and deterministic adapter
   fixtures. Assert slots, fields, controls, module actions and data types match
   the prompt rubric. Missing credentials must show a truthful unbound state.
4. Drive controls, field edits, city/input changes, composition switches and
   data updates; verify authoritative state and actual output receipts. Exercise
   cancellation, stale responses, reconnect, invalid updates and rollback.
5. Capture portrait/landscape frames and transition video in the real native
   renderer. Check readable text, clipping, masks, camera visibility, chart data,
   animation continuity and authored safe areas. Use structural/image metrics
   and human visual review; neither JSON validation nor a model's self-rating
   certifies visual quality. Keep deterministic rendering replays separate from
   repeated generation measurements.
6. Record resource peaks, settled usage, frame timing, latency/cost and failure
   stage. Run representative heavy combinations through milestone 1's sustained
   workloads. A browser preview does not certify Metal/native behavior.

Report generation validity, semantic correctness, binding correctness, visual
quality and runtime reliability separately with denominators and failure cases.
Do not hide retries in the success rate. Establish measured release thresholds
before rollout; integrity checks (authorization, invalid-package rejection and
retention of healthy output on failed replacement) must pass every applicable
case. Keep real paid-provider canaries bounded and separate from deterministic
CI fixtures. Provider/API availability remains an explicit dependency.

### Milestone 1 work receipt — 2026-10-28

The separate report `producer-2026-10-27-131453.ips` ends in Rust
`panic_cannot_unwind → producer_lib::live::engine::preview_draw → render_display`.
The callback contained `eprintln!`, which can panic on failed stderr writes.
Preview diagnostics now use best-effort `Write::write_fmt` and deliberately ignore
I/O errors rather than logging recursively. This changes diagnostics only; it does
not suppress renderer exceptions or catch native memory faults.

`scripts/test-callback-diagnostics.py` compiles the production helper in a small
C-ABI callback and supplies a pipe with no reader. The old pattern terminates with
SIGABRT (exit -6); the corrected callback exits 0. Both helper unit tests also pass
(error-returning writers and successful message formatting). This establishes and
repairs a reproducible abort path, **not a confirmed diagnosis of the historical
abort**: its original panic message/output-sink condition was not recovered.

No full application rebuild or native soak was completed for this change. Available
disk space fluctuated below 1 GB during the investigation; do not count this as
application-level validation. The running production application was left alone.
The Metal `device_begin_frame` failure remains independently open. Its frame reset
releases the current render target and swapchain; locating that release is not
proof of which earlier operation corrupted ownership.

### Milestone 2 first implementation receipt — 2026-10-28

The shared text admission entry point in `src/features/presentation/validation.ts` wraps the existing package codec. It applies the existing 40 MiB UTF-8 budget before parsing, bounds JSON nesting and returns stable issue codes with field paths. It performs no I/O, installation or output mutation. Unexpected validator defects propagate separately from invalid-package feedback.

File import, saved-library selection and the agent-edit dialog now use this entry point before loading preparation. Object-based callers still use `parsePackage`; this is not yet a universal native/server admission gate.

Run `npm run validate:set -- docs/shows/atmosphere.json docs/shows/attention-is-currency.json` for offline checks. The CLI emits one JSON report per file, exits 1 for rejected packages and 2 for invocation/I/O/internal errors, and marks native readiness untested. Reads are bounded even if a file grows during reading.

`npm run test:package-validation` passed: Atmosphere, Attention Is Currency and Just Facts; malformed/fenced input; UTF-8 byte limits; nesting/escaping; schema and binding rejection; CLI exit codes and multi-file errors. TypeScript checks and the existing 29-check presentation suite also passed.

Milestone 2 remains incomplete: decoded-asset verification, peak resource reservation, native/server agreement and atomic installation are pending. Adapter registration/transports and prompt generation are not implemented in this slice. Next: extract versioned adapter metadata and typed binding compatibility from existing integrations while retaining connection/credential storage, then add polling/webhook conformance fixtures before live routing changes.

### Adapter foundation receipt — 2026-10-28

Rechecked sections 2–5 and the extensible-adapter requirements before implementation.
The shared `producer.data-adapter/1` metadata contract and bounded registry now
support versioned operation discovery and exact input/output/delivery compatibility.
The existing authenticated integration-list route advertises only the three
implemented providers; the legacy capability list is derived from the registry.
Provider execution, credentials, storage, caching and permission checks are unchanged.

Tests cover snapshot compatibility across polling/webhook descriptors, version and
operation mismatches, event-versus-snapshot mismatches, caller mutation isolation,
size/identity limits, unknown fields including secrets, and push-refresh rejection.
The route test verifies discovery without provider calls. These tests do not prove
webhook delivery, schema validation of provider data or generic binding execution.
See `server/src/dataIntegrations/README.md` for contract references and pending work.

Verification: server TypeScript check passed; the full self-hosted server suite passed 352 tests across 34 files, including registry and discovery-route cases. No hosted API deployment or native rendering proof was performed for this change.

### Executable ingestion receipt and Claude priority — 2026-10-28

User steering: Claude is the next adapter after weather, ahead of the webhook
prototype. LLM integration must be provider-independent at the Set boundary:
provider response → normalized typed data → validation → authorized runtime state
→ Set bindings. Provider-specific response blocks, credentials and request details
stay inside adapters. A generic ingestion path does not mean arbitrary JSON is
renderable or that LLM text may invoke commands.

Implemented `shared/set-runtime/dataOperation.ts`: a one-shot executor verifies
operation/contract compatibility, bounds JSON-like values, parses input before any
provider call and parses normalized output before returning it. Failures do not
echo payloads and never cause automatic retries. Connection authorization,
transport deadlines, cache scoping and revision fences remain server-owned.
`providerContracts.ts` supplies executable weather-query/observation and
agent-question/answer parsers. Forecast semantics reuse the existing shared
weather parser. These are executable contracts; public JSON Schema export and
schema/parser conformance for these new data contracts remain pending.

Existing weather and agent requests now use this shared executor, including Claude
and the existing OpenAI branch. Cached weather is also validated before returning
it to a Set. Invalid cached results fail rather than masquerading as fresh usable
data. Provider URLs, authentication, model selection and paid retry policy have
not changed. Fixed a Claude normalization defect: text blocks now use the same
separators assumed by citation offsets, preserving citation ranges across blocks.

The first LLM output shape is `agent.answer@1` (answer, citations, research flag,
model). Future topic lists, metrics, chart series and generated Set definitions
require explicit versioned contracts through the same ingestion path. Do not
force those into answer strings, bind provider-specific fields in a Set, or treat
an answer as an authorized command. Streaming/delta assembly and structured-output
requests are not implemented by this slice. A generated package must still pass
package admission and preparation before an authorized take.

Tests cover invalid inputs before fetch, malformed normalized results, finite
numbers, graph/byte limits, incompatible registrations, no automatic retries,
provider-independent renderer payloads, citation URLs/ranges, multi-block Claude
citations, corrupt cached weather and late weather/Claude completion after a
connection revision change. The second weather adapter is synthetic test code,
not a real second connector or webhook delivery proof. Native/hosted rendering,
real-account Claude requests and deployment are not part of this verification.

Disk exhaustion interrupted one test attempt and writes. Cleared npm download
cache and removed the unused staged `target/sets-v2-dev/Producer Sets v2 Dev.app`
(after confirming it was not running). Sources, saved dev configuration and the
installed production app were preserved. That dev bundle must be rebuilt before
its next launch. Only subsequent completed test runs count as evidence.

Completed verification for executable ingestion: all 363 server tests across 35 files passed; server and frontend TypeScript checks passed; git diff whitespace checks passed. No production deployment was performed.

### Hosted moderator testing strategy — 2026-10-28

The user's previous Cloudflare sandbox belongs to Atlantium. Do not reuse its
resources or credentials for Producer. A new Producer-only environment is needed;
none has been provisioned by this work. Existing `server/wrangler.test.toml` is a
Worker/D1/R2/Durable Object test deployment, not a configured Sandbox/Browser Run
service. Do not deploy into it blindly or reuse its data for destructive tests.

Three separate evidence levels are required:

1. **Headless authority regression:** `npm --prefix server run test:moderator`
   runs real hub/command implementations using synthetic sockets/storage and
   synthetic host acknowledgements. It needs no desktop, camera, secrets or
   external provider calls. The manual `moderator-sandbox.yml` workflow provides
   an isolated Linux CI runner and test-result artifact; it is not a CF deployment
   and has not been remotely executed for these unpushed changes.
2. **Hosted UI and transport:** a dedicated Producer Worker/DO test namespace plus
   Browser Run or a Linux sandbox can exercise real HTTP/WebSocket routing and
   separate browser sessions for host/operator. Use synthetic media, short-lived
   test grants, isolated data, bounded lifetimes and cleanup. A simulated host must
   label its receipts as simulated. Cloudflare configuration/version/access and
   provisioning remain pending, followed by actual remote test evidence.
3. **Native presentation:** verify application and output receipts with a real
   supported Producer renderer and synthetic media. A Linux container or headless
   Chrome is not a macOS/Metal environment. Full Linux Producer broadcasting in CF
   is a separate feasibility experiment (display/media/encoding/device support,
   sustained resources and output transport); do not promise it from browser tests.

Cloudflare's documentation describes Sandbox containers as Linux environments:
https://developers.cloudflare.com/sandbox/concepts/
Browser Run supplies remotely controlled headless Chrome:
https://developers.cloudflare.com/browser-run/
These support the proposed control-plane test architecture; they do not certify
Producer's native engine on that infrastructure.

The new headless scenarios verify accepted versus acknowledged state, failed-cut
retention, new command rejection after signed grant narrowing and a disconnected
publisher. The last case reproduced a bug: `scene.cut` selected a closed publisher
socket and accepted undeliverable work. The selection now requires an open socket,
matching the source-action path. The regression failed before and passes after
that change. Network closure after acceptance still needs timeout/recovery; this
fix is not a delivery guarantee.

Full Set operation remains incomplete. In particular, grant refresh blocks new
commands but does not prove cancellation of already accepted work. Immediate grant
revocation, in-flight cancellation, per-output native receipts and the full Set
operation matrix remain explicit gates. No host-side or native acceptance may be
inferred from this headless suite. This supports milestones 1/4 without marking
milestones 2/3 complete or skipping their remaining admission/control work.

### Boomin Teams authority audit and corrected implementation focus — 2026-10-28

The self-hosted control-plane suite is not proof of Boomin Teams delegation.
Audited the owned API checkout at base `3ca4b2f` (not a claim of deployed-head
verification), including `docs/ROOM_ACCESS.md`, `docs/CONTRIBUTIONS.md`, member
invite/grant routes, `services/live/room-access.ts`, participant grants,
`routes/app/live-access.ts`, `routes/app/live-channel.ts`, realtime renewal,
`routes/set-modules.ts` and `sets/service.ts`. Also inspected Producer's
`boominRoom.ts`, `Live.tsx`, `ModBoard.tsx` and `useSetModules.ts`.

Existing authority is Boomin's member/grant system: `brand_members` and
`brand_member_grants`, with room scope for moderator/manager seats. Collaborator
standing comes from grants, not the collaborator row's role. Participants/media
admission are distinct from member authority. Do not add a parallel role or
membership store. The resolver's explicit room-grant precedence for collaborators
is covered by tests; some older explanatory comments describe precedence less
precisely than the current implementation/tests.

The room channel mints 120-second tickets containing room, brand, user, role and
computed capabilities. Renewal validates that identity/scope and updates allowed
subscriptions. Hosted Set routes already use `requireRoomControl`; integration
administration separately requires brand-editor standing. Extend these boundaries,
not the self-hosted token model, for full Teams operation.

Confirmed gaps:
- Hosted Set commands used the shared principal ID `room-operator`. On isolated
  API branch `feat/set-operator-authority`, direct commands and agent-start commands
  now receive the authenticated user ID from the same authorized room context.
  Clients cannot inject a principal. Add tests for distinct operators reusing a
  command ID; keep per-user attribution without inventing another grant model.
- The actual moderator render branch passes scene/people/vote/chat/feed controls
  to ModBoard, but not the full Set controls/preparation workflow.
- Set module checkpoints already commit in the room DO. `useSetModules.ts` still
  polls at 1000 ms for other-client state and forwards host-originated Show
  lifecycle. This is not complete DO-owned Show/layout operation or push sync.
- Current route tests mock the room guard. The separate Teams resolver tests
  validate role/scoping behavior, but their combined end-to-end route/database/
  WebSocket path remains a required sandbox test.
- Authorization at request entry does not by itself fence revocation while an
  asynchronous request or native preparation is pending. Grant epoch propagation,
  in-flight cancellation and presented receipts need explicit end-to-end proof.

Next implementation seam: one room-DO command/state path for Set selection,
layouts, fields, source placements, Show start/pause/next/previous/stop, module
controls and cues. Use authenticated Teams principals and action scope; preserve
ordered revisions, idempotency and durable recovery. Publish authorized state
updates over the existing room channel; keep snapshot resync for reconnect rather
than using a one-second poll as the normal propagation path. Persist committed
state before claiming commit, then receive output-specific native presentation
receipts. Provider requests and asset preparation must not block the DO command
queue. Define bounded subscriptions/fanout and measure command-to-commit and
commit-to-present latency separately; DO placement alone does not guarantee speed.

Hosted sandbox acceptance must create synthetic Teams members/grants in a separate
Producer test tenant and run host/mod/manager/viewer sessions against the real
Boomin routes. Cover member removal, room-grant narrowing, wrong brand/room,
competing operators, disconnect/reconnect and revocation during pending work.
Simulated renderers may exercise the control protocol, but cannot certify Metal.

Completed audit baseline: 41 existing Boomin role/access/renewal/action tests
passed with fixtures, without production data or desktop windows. The Producer
self-hosted suite separately passed 366 tests, including 20 targeted moderator
checks. These counts are different products/layers, not one full delegation proof.

Teams operator attribution verification: 39 targeted hosted route/service/access tests and API TypeScript checks passed after the change. API changes remain local on the isolated branch; no hosted deployment or sandbox provisioning occurred.

### Committed module state push — 2026-10-28

Implemented the first transport slice of the DO ownership plan in the isolated
API branch and Producer worktree. `SetRuntimeService` invokes a best-effort
notification only after saving its durable checkpoint. The room hub publishes
private `set.runtime` updates on `set:operator` to open, unexpired room-ticket
connections with the existing Teams `can.control` capability. This does not add a
membership model or expose operator snapshots to audience subscriptions. Signed
grant narrowing removes this subscription and signals unavailability. It does not
yet prove immediate membership revocation or cancellation of pending commands.

Producer bridges its existing room socket into endpoint/room-scoped module
subscriptions. Explicit `set.runtime.ready` protocol negotiation enables push;
generic subscription acknowledgements from older servers cannot enable it.
Snapshots apply through the existing epoch/revision fence. Push-capable sessions
use a 30-second snapshot health check; older/disconnected sessions retain the
one-second compatibility poll. Weather/provider refresh cadence remains separate.
No additional socket is opened. This is removal of polling delay for ordinary
module updates, not a measured end-to-end native presentation latency claim.

Frames exceeding 64 KiB carry an epoch/revision invalidation; the client fetches
the authorized snapshot route. Concurrent invalidations coalesce and request one
follow-up fetch after an in-flight request, preventing an older response from
losing the newest update. A replaced deployment fences subsequent old HTTP and
socket results, disables its transport, and requests configuration reload. Old
socket cleanup cannot disable a newer connection for the same room. A broken
subscriber cannot roll back committed state or block another subscriber's send.

Verification: the full API suite passed 1,165 tests and the self-hosted Producer
suite passed 366 tests before the additional edge-case coverage. The final targeted
API push suite passes seven tests, including failed storage, expired permission,
signed narrowing, large-frame invalidation and failed fanout. The actual
`useSetModules` hook runs with mocked transport/effects in `test:module-push` and
passes immediate snapshot application, fallback, resync, invalidation coalescing,
replacement during pending GET, and timer cleanup. This test is included in frontend
CI alongside shared package validation. Fixtures are not deployed CF or native
renderer evidence.

Still required: authoritative Set package/configuration ownership, layout/field/
placement commands, durable Show navigation and playback, operator UI using that
authority, grant revocation fences, and output-specific presentation receipts.
The existing host-originated lifecycle is still in use; do not treat module push
as full Show delegation. Implement these through the shared command/state path
above before exposing host-local controls as remote moderator controls.

Disk pressure interrupted local test/write attempts. Removed only regenerable
cutout-lab extracted dependency/backend sources (`target/cutout-lab/simde` and
`engine-source`) and local cache data; installed Producer, project sources and
user configuration were preserved. Native rebuilds must prepare those sources
again. No native soak, remote sandbox run, deployment or production push is claimed
for this slice.

### Next checkpoint: DO-owned layout and manual Show control — 2026-10-28

Added the opt-in `producer.control/1` control catalog and pure reducer to the
shared runtime, mirrored into the hosted API runtime. This catalog contains known
layout IDs and an optional bounded linear Show path. It is a control-plane
contract, not a new visual package format or proof that assets have been admitted.
Existing packages and legacy clients remain unchanged until explicitly migrated.
Unknown fields, cyclic/unreachable phase paths, missing layout references and
segment modules without matching phases are rejected. Voting `collectMs`, timed
advancement and branching are unsupported here and must not be silently dropped
by a future package-to-control adapter.

The room service accepts an optional control catalog at install and includes it
in deployment-identity checks and durable checkpoints. Guarded Boomin routes expose
`GET .../set-runtime/configuration` and `POST .../set-runtime/control`; callers can
send only a command, with operator identity derived from existing Teams room
authority. Commands cover layout selection, visibility, and Show start/pause/
resume/next/previous/stop. They require the current Set epoch and expected global
revision. Per-operator command IDs support bounded durable deduplication. A stale
absolute command conflicts rather than silently overwriting another operator.

`SetRuntime.control` stages the Show/layout update and declared module lifecycle
effects together, then commits one global revision. Set-owned modules keep their
existing independent lifecycle policies. Server time anchors Show elapsed time;
pause/resume preserves elapsed time across eviction. Stop retains the last layout;
restart begins at the initial phase with a new run counter. There is no timer
alarm or automatic advancement in this checkpoint. The legacy `/orchestrate` path
rejects changes when a control catalog is installed, preventing a host-local Show
from competing with DO authority.

The same durable save and private push path publishes these control snapshots.
Failed storage leaves the prior committed state intact and publishes no update.
Retrying an already committed control command returns its receipt without another
save or push, with the current snapshot available for reconciliation. Committed
is not presented: this checkpoint contains no native output acknowledgement.

Tests cover a single revision for combined Show/module transitions, pause-clock
recovery, durable retry, changed command-ID reuse, competing operators, narrower
action grants, stale epochs, legacy lifecycle rejection, standalone layouts,
invalid catalogs, storage failure, and route-derived operator identity. The shared
Producer implementation has an executable `test:set-control` check in frontend
CI. Hosted route tests still mock the Teams guard; real membership/database/socket
revocation acceptance remains pending.

Next integration steps, in order:
1. Derive this catalog from admitted packages, rejecting unsupported legacy Show
   behavior explicitly; carry the full versioned package/configuration identity.
2. Make live host and moderator controls submit the same commands and consume
   pushed snapshots. Keep rehearsal isolated. Do not auto-install a local Set from
   a moderator session or infer authority from control visibility.
3. Wire output preparation and per-output presented/failed receipts, preserving the
   previous healthy output when a committed desired layout cannot be prepared.
4. Extend typed shared fields, source placement, cues, Show timers and scoring;
   finish saved minimized/expanded arrangements and revocation fences.
5. Exercise actual Teams sessions in the dedicated Producer hosted sandbox, then
   run native presentation acceptance separately.

No live client currently opts into this control catalog. The moderator UI is not
yet wired, no deployment has occurred, and full moderator delegation remains
partial. Disk pressure required clearing the regenerable Cargo registry source
cache; a later Rust build may need to download those dependencies again.

Verification receipt: full hosted API suite **1,181 passed**, self-hosted Producer
server suite **366 passed**, both TypeScript checks passed, and shared
`test:set-control`, `test:module-push` and the 18 existing module-runtime checks
passed. These are local fixture/shared-runtime results, not native or deployed
Teams acceptance.

### Live controls and output receipts — subsequent checkpoint, 2026-10-28

Hosts now negotiate `controlProtocol:1` and install supported control catalogs,
including zero-module Sets. The digest includes the full package and bindings.
Module-driven layouts and voting/timed Shows retain their existing path rather
than silently losing semantics. This supersedes the prior no-client-adoption note.
Live layout/Show controls wait for committed snapshots; rehearsal remains local.
Moderator sessions cannot run the host installation effect.

The Boomin moderator board now has a Set tab gated by existing room-control
permission. It reads installed configuration, reuses schema-generated module
controls and exposes supported layouts/Show transport. It never installs a local
package. Reconnect, replacement, conflicting commands and late replies are fenced.

Native rendered-revision callbacks now include room identity. A coalescing relay
sends program/portrait receipts through the existing room socket and replays after
publisher registration. Only the registered, unexpired host publisher can report.
The DO checks epochs, committed revisions and renderer counters, durably stores
receipts separately from runtime revisions, then pushes them privately. The UI
separates committed state from last confirmed output. These are renderer reports,
not independent hardware attestation or a guarantee of continued output.

Verification: 1,185 API tests, 366 server tests, 29 presentation runtime checks,
both TypeScript checks, and focused host-hook, controller, relay and room-control
tests passed. The focused frontend tests are in CI. No deployment, hosted Teams
acceptance, browser visual review or native end-to-end acceptance occurred.

Remaining gates include failure receipts, in-flight revocation, moderator package
preparation, shared fields/source placement, module-driven layout catalogs,
advanced Shows and saved control arrangements. Disk pressure required clearing
regenerable Chrome Code Cache; browser profiles and history were preserved.


### Host control arrangements checkpoint — 2026-10-28

Implemented milestone 3 for solo hosting. `Arrange` is available from expanded
and minimized controls. Users can pin/unpin controls, independently reorder the
minimized bar, reorder expanded sections and their controls, collapse sections,
and reset to authored defaults. Legacy packages do not receive inferred minimized
placements. Atmosphere explicitly authors forecast, composition and city shortcuts;
its generator retains those defaults. Room output and Show playback remain shell
controls rather than authored placement entries.

The strict package codec and generated JSON schema accept bounded
`set.controlArrangement` sections and stable references (`set:`, `module:` and
`builtin:layout`). Unknown, duplicate and non-operator references are rejected.
The catalog includes module lifecycle, city/refresh and agent/intake tools without
changing their action handlers or authority. Context-hidden controls and empty
sections do not appear. Compact tools open a popover above the bar.

Preferences are stored locally per endpoint + room + Set ID, independently of
package data. Stable compatible IDs retain overrides across reopen/upgrades;
removed or incompatible controls lose overrides, new controls use authored
defaults. Save failures report that changes last only for the current session.
These preferences do not synchronize between devices/operators.

Validation completed: TypeScript; pure arrangement/schema/upgrade tests; shared
module rendering/context/authority tests; browser tests for explicit inclusion,
independent ordering, collapse persistence, room isolation, expanded and minimized
Atmosphere actions through the same runtime, City popover and narrow-window
arrangement access. Existing 29 presentation checks, Atmosphere, package admission,
room control and module push suites passed. Browser tests use real React panels
and a rehearsal runtime with mocked output; they do not claim native camera,
live-provider or deployed-server acceptance. Nothing deployed.

Next: retain milestone 4's remaining hosted Teams, revocation and native receipt
acceptance gates, then proceed to prompt-to-Set generation. This checkpoint does
not close those separate gaps.


### Scope checkpoint: start prompt-to-Set — 2026-10-28

User approved marking milestone 4 partial and starting useful draft generation
now. API recovery is committed as bcb29db in the durable
Documents/boomin-api-set-hardening checkout. Full API regression suite passed
1,194 tests; final receipt-ordering regression and TypeScript passed. Producer
now includes shared field draft/Apply controls, room-scoped city search and
output failures distinct from last-good receipts. Native event domain parsing
and publisher replacement counter ordering were corrected.

Milestone 4 remains partial: remote source binding/framing, immutable visual
package preparation/activation, hosted/native acceptance and complete authority
epoch coordination remain. Rechecking DB authority before writes/fanout improves
revocation handling but does not provide atomic DB-grant/DO-storage transactions
or measured low-latency performance. Do not claim full moderator operation.

Next deliverable is one bounded saved-Claude authoring request, strict shared
package validation, private preview and explicit load into existing preparation.
No automatic take, provider retries, generated executable code or asset-job
pipeline is implied. The manual prompt acceptance corpus lives at
tests/set-authoring/prompts.json; fixture tests do not establish live model
success rates. Production-hosted authoring requires the matching API route; a
local workspace-server route alone must not be advertised as hosted support.


### Initial authoring implementation checkpoint — 2026-10-28

The Set settings Files menu now exposes Generate Set draft. A saved Claude
connection makes one bounded request through the primary workspace server
`data-integrations/:id/author-set` route. Validated output is shown in a private
layout preview and requires explicit Load preparation. The host's normal output
workflow still performs the take. Cancel, changed prompts and closed dialogs
fence late replies. Provider work may still finish after local cancellation.

Initial generation profile supports asset-free box/text/slot layouts and editable
controls. Full import validation remains available separately. Generated Shows,
data-bound modules, 3D, shaders, charts and asset jobs are not implemented by this
first profile; unsupported requests fail explicitly instead of silently dropping
features. Credentials remain in saved connections. Connection revisions, request
size, response bytes, timeout and saved output tokens are bounded. No automatic
repair or paid retry is performed.

Verification: mocked provider/route tests cover valid drafts, malformed/truncated
output, refusal, scope and size limits, cancellation, credentials and connection
revision changes; existing integration tests and both TypeScript checks pass.
Client draft tests cover invalid results, late replies and explicit loading.
No paid live generation, native acceptance, deployment or hosted Boomin authoring
route is claimed. Milestone 5 remains an initial implementation, not complete.
