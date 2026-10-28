# Set runtime and 3D hardening plan

Status: planning document, 2026-10-25. This records requirements and proposed work; it does not claim that every safeguard, adapter or moderator control described here exists today.

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

The actual backend, compiled with Thread Sanitizer, completed all seven native changes without a sanitizer report (`ignore_noninstrumented_modules=1` avoids an Apple Security interceptor deadlock). This is diagnostic evidence, not a root-cause fix or production stability signoff. Keep this crash open until it has a reproducer and a validated correction. Restore the ordinary tested backend after diagnostics; sanitizer libraries must never ship. The UI/Set review remains local and unpublished.
