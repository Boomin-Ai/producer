# Set runtime: ownership and lifecycle

Status: design draft 0.1 for review, 2026-10-24. This is a proposed runtime contract, not an implemented package schema or a claim that the current runtime conforms. The existing compositor remains an implementation building block. Package-format and transport-protocol versions will be independent. HTML-to-canvas is outside this work.

The goal is to author new interactive production experiences as packages within Producer's advertised capabilities, without adding experience-specific Producer code. Standalone sets and concurrently operating modules are fundamental. Shows are optional orchestration.

## 1. Terms and ownership

| Object | Owns | Does not own |
| --- | --- | --- |
| Producer runtime | Validation, capability registry, authenticated execution contexts, scheduling and enforcement | Package-specific creative decisions |
| Room | Physical/device sources, resource service, audio mixer and output destinations | Module-local state |
| Set definition | Portable module definitions, visual components, views, composition regions and required capabilities | Live instances, credentials or device handles |
| Set instance | Shared state, module registry, composition registry, delegated grants and its commit sequence | Unrestricted room/device authority |
| Module definition | Local state declarations, action definitions, controls, rules, timers and optional visual contributions | A dependency on shows or segments |
| Module instance | Independent local state, lifecycle, timers, operation identities and contributions | Another instance's private state or resources |
| Show definition | Segment specifications, module instantiation/reference instructions and orchestration policies | Live module instances |
| Show run | Segment position, orchestration clock and the instances it creates | An automatic right to reset or dispose referenced instances |
| Output renderer | Applying authorized immutable presentation snapshots, frame production and receipts | Mutating authoritative application state |

A segment is a show step that describes which module instances to create, reference, activate and present. Multiple modules can run and contribute visuals simultaneously. A set can instantiate exactly the same modules without a show.

### Final authority

Room-granted authority is the ceiling for a set. A set can delegate a subset to modules and show orchestration; delegation cannot expand authority. Caller identity and grants come from the runtime execution context, never from a command's self-declared role. Grants distinguish operator, audience, connector, module-rule and show-run callers. Module commands remain scoped even when issued by an operator.

The show runner uses declared, granted lifecycle and composition operations. It has no privileged direct state mutation route. The renderer cannot issue arbitrary state changes through frame callbacks. Room stop/unload/revocation operations may preempt normal operation by advancing an authority epoch, rejecting stale work and releasing owned grants through the same controlled teardown path. Such interventions are recorded.

## 2. Identity, ownership and addressing

Every loaded set, module and show run has a runtime identity distinct from its reusable definition ID. The runtime allocates identities; packages use local aliases/references rather than guessing live IDs.

A module records its lifetime owner: the set instance, a show run, or a segment occurrence. A reference is not ownership. Segment reentry can reuse an owned instance only according to an explicit policy. Two segment specifications using the same module definition create separate instances by default.

Commands address a set instance and its epoch, plus a module identity and execution epoch when module-scoped. Workflow continuations, timer events and effect completions retain these identities. Votes also target a voting-round identity. Replacing a set, resetting a module or opening a new round fences old work; a late result cannot mutate a replacement instance or a new round. Reset preserves the module's instance identity but advances its execution epoch. Dispose followed by create produces a new instance identity.

Preview, rehearsal and live are separate execution domains with separate instance identities, state and effect grants. Rehearsal cannot write live state. Access to a shared camera image is a room-granted read lease, not authority over the live module or mixer. Preview inspection alone never keeps a live module running or grants effects.

## 3. State authority and transactions

Set revisions remain monotonic across module resets and show restarts; unloading/recreating a set establishes a new set identity/epoch.

One sequencer/commit coordinator per set instance serializes all authoritative changes: shared values, module-local values, lifecycle, composition ownership and show-run position. Local isolation is enforced by access rules, not by creating competing sources of commit order. The coordinator is a semantic authority; it need not be one monolithic implementation class.

Each committed transaction receives one monotonically increasing set revision. Transactions can also reference room revisions/lease generations, but there is no pretend atomic transaction spanning the room, multiple sets and external services.

1. Authenticate and validate the command, target, input shape and capability bounds.
2. Assign a recorded ingress order. Acceptance acknowledges admission, not success.
3. At execution, recheck epochs, authority, lifecycle, ownership and preconditions against current state.
4. Evaluate pure expressions and bounded synchronous rules; stage permitted state and registry changes.
5. Validate the entire transaction, then commit it once or reject it with no partial state mutation.
6. Publish authorized projections, schedule declared asynchronous effects and invalidate affected output dependencies.

No two transactions execute concurrently within a set's state authority. Independent IO/rendering may proceed concurrently. Ingress order resolves genuinely concurrent commands; replay uses that recorded order rather than promising identical results for different arrival orders. A deadline is a runtime-authenticated clock event in this same order. A vote processed after the close event is rejected even if its client claims an earlier timestamp.

An increment action computes against state at execution. Read/modify/write clients cannot overwrite newer state accidentally: absolute edits that depend on a previous read supply an expected revision/version or explicit precondition and receive a conflict if it changed. There is no hidden last-writer-wins exception for score fields.

All module writes are local by default. Shared state is changed only through exported set actions with typed inputs, declared read/write authority and preconditions. Modules can consume explicitly exported read-only projections of other modules or invoke their granted public actions; they cannot reach into another module's private state. Shared operations can atomically update several authorized scopes in one synchronous transaction. Authority is not inferred from a path string.

Computed values are pure, dependency tracked, cycle checked and bounded. No ambient network, arbitrary code, time or randomness is available in expressions. Runtime time and random results, when supported, enter as recorded inputs. Public/render projections exclude private ballots, identities and unrevealed results. Access to an action does not imply access to its private inputs or state.

## 4. Composition and resource conflicts

A set declares named regions and explicit composition rules. Region metadata includes accepted contribution types, placement bounds, composition mode, authorized controllers and a fallback. Definitions refer to semantic source roles, not hardcoded physical devices.

### Region modes

- **Exclusive:** one ownership lease controls the region. The initial policy is reject-on-conflict. Transfer requires an explicit authorized handoff naming the current lease/version and the next owner. There is no implicit takeover based on drawing order, segment order or the latest request.
- **Layered:** several authorized contributions coexist. A region declares allowed sublayers/order, contribution limits and deterministic tie-breaking. Visual ordering grants no extra mutation or input authority.

A handoff prepares the incoming visual contribution while the outgoing contribution stays on output. After preparation, one checked transaction transfers the region lease and commits the new desired composition. If the old lease changed, preparation failed or authority was revoked, the handoff fails and the existing visual remains. Old resources are retired only after the renderer's ownership fence confirms they are no longer referenced. Authored transitions can temporarily retain both visuals without giving both controllers ownership of the region.

If an exclusive owner is disposed, the region follows its declared fallback: a prepared fallback contribution, or intentional emptiness. Critical regions must declare a viable fallback. Unexpected resource loss emits an explicit degraded/failure state; it does not silently grant control to another module.

### Resource authority is separate from placement

| Operation | Contract |
| --- | --- |
| Render the same camera in two placements | Shared read leases are allowed |
| Change a camera/device configuration | Explicit room capability and a valid controlling lease |
| Select which source fills a region | Region authority plus permission to bind that source role |
| Seek/play a media player | One transport controller per player; independent playback needs separate player instances |
| Create a source | Room resource-service capability; new source starts detached from room scene and audio routes |
| Route or change audio | Room mixer authority; visual placement never implies routing |
| Start/stop an output device or destination | Explicit room authority; not ordinary module composition authority |

Modules request operations through the capability service; they do not manipulate physical handles. Packages cannot acquire capabilities merely by declaring them. A source created for a module has explicit cleanup ownership. Disposing a module releases its leases; it never deletes a user-owned room source. Resource effects spanning the room and set complete through checked asynchronous results rather than pretending a room operation is part of an atomic set-state commit.

Control-surface input addresses explicit instance/control IDs. Audience/data inputs use granted routes. A focused region or high visual z-order does not confer input authority. Interactive visual hit testing, if supported, maps only to declared actions and input routes.

## 5. Lifecycle and suspension

There are three independent dimensions:

- **Execution:** created, running, paused, stopped, disposing, disposed. Fault/degraded details accompany state; faults do not secretly reset it.
- **Presentation:** mounted, preparing, transitioning or unmounted, independently for each output/region.
- **Input admission:** which input classes are open, buffering, coalescing or rejecting.

A module can run while unmounted. A paused module can remain visible. A controller can pause an invisible module. "Active" is not a substitute for these dimensions.

### Operations

| Operation | Semantics |
| --- | --- |
| Create | Allocate a fresh instance, validate configuration, initialize state and owned handles; no implicit execution or presentation |
| Start/resume | Request running execution under valid grants; resume frozen local clocks without counting paused time |
| Pause | Add a named pause reason; preserve state and freeze owned logical clocks |
| Stop | Stop execution, close ordinary event admission and cancel/fence pending module work; preserve local values until reset/disposal |
| Reset | Quiesce/fence old execution, advance execution epoch, reset declared local state/timers/media policy, then enter an explicitly requested execution state |
| Dispose | Advance execution epoch, reject new work, cancel subscriptions/effects, remove/replace contributions and release owned resources after rendering fences |

Lifecycle authority is explicit: the set lifecycle controller manages set-owned children; a show-run controller manages only the instances it owns or has specific grants to control; segment orchestration is limited to its declared instances/grants; a module may manage itself or create/manage children only through a granted capability. Operator requests still pass the applicable controller and grant checks. Ownership establishes cleanup responsibility, not unrestricted access to every resource used by the child.

Pause reasons are referenceable reasons owned by controllers (operator, hidden policy, orchestration, resource failure). Removing a visibility pause does not remove an operator pause. Resume cannot override revoked grants. Reset is not create, pause is not reset, and show restart is not a universal reset.

### Background policies

The definition declares behavior on becoming unpresented, on owning-segment exit, on show-run end, and on owner disposal. Choices are bounded lifecycle operations such as continue, pause, stop or dispose. Omission never means "infer behavior from visibility."

Unpresented means no committed mount on any designated live output; preview/editor subscriptions are excluded. Handoff teardown waits for the outgoing contribution's retirement fence before releasing its presentation lease. Policy effects are submitted once on the relevant edge, not every frame. Segment exit and show end are explicit orchestration events, independent of whether a module remains visible.

Default proposal: hiding does not change execution; segment-owned instances stop on segment exit and can resume on reentry; run-owned instances stop on run end; owner disposal disposes owned children. Persistent services use set ownership and explicit continue policies. Packages may choose stricter policies. A segment cannot dispose a borrowed set-owned ticker. Retaining a run-owned module after run disposal requires an explicit authorized ownership transfer; lingering references cannot retain it accidentally.

Reentry declares resume-existing, reset-existing or create-new. Restarting a show creates a new show-run identity and fresh segment-owned instances by default. Set-owned referenced modules survive unless an authorized restart action explicitly changes them.

### Pausing different resources

| Resource | Pause behavior |
| --- | --- |
| Module timers/animations | Freeze module logical clock; resume from the frozen position |
| Wall-clock deadlines | Continue against runtime clock only when explicitly declared; cannot be disguised as frozen module timers |
| Media | Apply declared pause/continue policy within the module's transport authority; never pause a shared camera or another owner's player |
| Data subscriptions | Declare bounded buffer, latest-value coalescing, disconnect/reconnect with snapshot, or continue delivery through specifically allowed actions |
| Audience input | Declare admission/rejection behavior; voting normally rejects while paused rather than replaying an unbounded backlog |
| Commands not yet committed | Recheck lifecycle at execution; ordinary commands are rejected while paused unless declared pause-safe; lifecycle commands remain available to authorized controllers |
| In-flight asynchronous effects | Continue/cancel according to supported capability policy; completion remains epoch checked; cancellation cannot undo an external action already performed |

No unbounded queues. Timers fire as recorded runtime inputs, with explicit missed-tick/coalescing behavior. Overdue wall-clock events on resume are processed once under their declared policy. Rules cannot create infinite same-transaction cascades: dependency validation and transaction budgets reject the complete transaction on overflow. Event scheduling has bounded rate/depth budgets and produces inspectable failures.

## 6. Effects, commands and acknowledgements

All entry points use the same internal typed command/event model. Network transports are adapters to this model later. Public wire-field names are not fixed in this draft.

A command carries an ID, explicit target/epochs, declared action, validated inputs, optional concurrency precondition and causal correlation. Caller grants are attached by the runtime. Idempotent retry keys are scoped to the authenticated caller and target epoch, with a documented bounded retention window; retrying outside it cannot claim guaranteed deduplication. Commands and effects return structured errors.

- **Accepted:** admitted to processing. It can still fail at execution.
- **Committed:** one authoritative state transaction completed at set revision R, or an explicit no-op result with the unchanged revision.
- **Effect completed/failed/cancelled:** an asynchronous capability operation reported a result. This is not implied by Committed.
- **Presented:** a named output rendered a snapshot containing the relevant committed visual state, as defined below.
- **Animation completed:** the specified animation instance reached its endpoint; separate from first presentation.

A committed transaction can enqueue effects in an outbox as part of its journal record. Effects execute after commit. Their completions become new commands, rechecking identities/grants/expected versions. Multi-step workflows cannot hold a state transaction open across network/media waits. Each continuation has explicit preconditions and cancellation behavior.

External effects are not universally atomic or exactly-once. Capabilities declare their idempotency/retry/compensation support. Compensation, when available, is an explicit new operation, not rollback fiction. Playback retries must not replay a stinger unless its declared semantics permit it. A stale completion releases acquired resources even when its state mutation is rejected.

Replay of recorded inputs and observed effect results must reproduce state transitions without reissuing external effects. Logical time inputs, rules and versioned capability semantics are part of the replay record. Durable crash recovery and persistent journals require an advertised capability; an in-memory journal must not be described as crash-safe.

## 7. State-to-output consistency

Each transaction produces an immutable authoritative snapshot and a dependency change set. Each output derives an authorized visual projection from a coherent snapshot plus its selected view variant and a defined animation-clock sample. Never combine the score from one revision with the vote reveal flag from another.

Continuous visual sampling is not a state transaction per frame. Committed animation/clock anchors and declarative tracks let renderers sample motion on their frame clocks. Start, pause, seek, interruption and completion events have explicit identities and state semantics; pixel samples do not flood the commit journal.

Outputs have independent identities, epochs, dimensions and configuration revisions. Views contain authored design canvases/variants; output viewport scaling does not rewrite state or destroy design coordinates. Orientation changes preserve module identity, values, source roles, voting rounds and logical clock. Missing variants follow a declared fallback or block that presentation change with an actionable error.

A commit invalidates only outputs whose mounted composition depends on the changed state/registry. Module-private changes and hidden modules' changes can commit without requesting a frame. Their commit result has no presentation obligation. Mounting them later uses a coherent current snapshot. A global state revision is an ordering mechanism, not a mandate to redraw every output.

For a visual change, track a presentation ticket with set revision, output identity/epoch, configuration revision and immutable projection identity. A receipt identifies the actual projection and frame serial rendered. Presentation means native frame production, not encoder delivery, network delivery or a viewer's display.

Outputs may coalesce intermediate desired projections. A later frame number or greater set revision does not prove a particular intermediate visual appeared. Tickets resolve as presented, superseded, failed or cancelled. If a later projection still contains the requested visual result, dependency/projection coverage may satisfy the ticket; otherwise explicitly report superseded. Never report an unseen state as presented simply because an unrelated commit advanced the global revision.

Landscape and portrait resolve independently. An optional coordinated take requires an advertised prepare/barrier capability, readiness of all requested projections, explicit failure policy and per-output receipts. A barrier does not claim physical displays or encoders present simultaneously. One unavailable portrait output must not falsely mark both successful. Failed preparation retains last confirmed output; uncertain post-swap ownership is retained until reconciled rather than freed speculatively.

## 8. Capability preflight and continuing enforcement

Packages declare required and optional capabilities with semantic versions, budgets and fallback policies. Capabilities include composition, dynamic layout/collections, source acquisition/binding, media transport, mixer changes, audience round operations, external data ingress and animation. Supporting a view does not imply supporting all its behavior.

Before activation, validate package structure, references, state/action types, permissions, required resources, variant/fallback coverage, ownership conflicts and resource/compute budgets. Return an actionable compatibility report. Optional features use declared fallbacks; missing required capabilities block activation while existing output stays intact. Discovery of support is separate from permission to use it.

Preflight cannot guarantee a camera or connector remains available. Revocation/disconnection advances the relevant lease/version, rejects unauthorized future work and enters a declared degraded policy. Credentials, webhook authentication and polling transport stay in Producer-managed services. Connector data is typed input, not executable commands or authority from a payload.

Collections declare stable item IDs, max counts, reuse/removal policy and deterministic layout/overflow behavior. Removing an item fences its callbacks and retires visuals before releasing resources. Adding a fifth guest to a four-person set must follow an explicit reject/queue/page/alternate-layout policy. It cannot silently steal an existing placement or audio route.

## 9. Required conformance traces

These are specification acceptance scenarios, not tests claimed to pass today. Each implementation will need deterministic state/event assertions and output-specific integration evidence where indicated.

### AI Stack: standalone operation

1. Load the set without creating a show or segment. Create/start a stack-explorer module and mount its view.
2. Up/Down commands update only its local focus and select the corresponding logical view. Boundary buttons have an explicit disabled reason. Authored controls remain visible; action type does not replace them with a generic selector.
3. Change landscape to portrait. Focus, source binding and clock persist; the output variant changes.
4. Instantiate a second explorer. Navigating it does not change the first unless a shared action was explicitly configured.
5. Attach a show that creates or references an explorer under an explicit policy. Removing the show cannot destroy a borrowed standalone instance.

### Arena: concurrent modules and isolated segments

1. The set creates set-owned ticker and voting modules. Both run without a show; voting is not implicitly opened by starting a show.
2. A new show run creates a segment-owned Host's Case debate instance. Challenger's Case uses the same definition with a fresh identity and independent topic/receipts state.
3. Open voting in round Q while debate and ticker continue. A vote after close, a duplicate vote, or a late Q vote after round Q+1 cannot update the current round incorrectly.
4. Move to interview. Apply the debate's explicit exit policy; the set-owned ticker/voting continue. Transfer an exclusive main-region lease only after interview readiness. A conflicting guest module receives a conflict; visual z-order cannot take ownership.
5. Reveal results through a granted action: atomically commit authorized result/score/view changes, then issue an animation effect. First presented frame and animation endpoint are separate acknowledgements. Private ballots never enter either output.
6. Stop/restart the show. Old segment callbacks are fenced; fresh debate instances are independent. Ticker/voting survive according to set ownership. Shared score reset requires an explicit action, not a side effect of show restart.

### Guest Grid: bounded dynamic composition and room authority

1. A granted participant event adds a stable guest ID. Create a detached source through the room service; represent the acquisition as pending local state.
2. On valid completion, commit the binding and create its visual/control entries through declared collection templates/layout rules. Requested audio routing is a separate granted room operation with visible pending/failure state.
3. Two guests join concurrently. Recorded command ordering and deterministic layout rules choose placements; stable IDs preserve existing assignments.
4. Capacity overflow follows policy. Disconnect/remove fences the item's callbacks, retires its contribution and releases only owned leases. An acquisition completing after removal is released and cannot resurrect the item.
5. Two modules display the same camera successfully with read leases. Competing device configuration or media-transport writes fail without controlling authority.

### Persistent Ticker: off-screen data and independent receipts

1. A set-owned ticker consumes a typed Producer-managed feed and runs beside debate/voting/timer modules.
2. Hiding the ticker does not stop its subscription when continue is declared. Latest-value coalescing bounds background updates. No frame ticket is expected while no output depends on it.
3. Remount using current data. Landscape can acknowledge presentation while portrait reports pending/failed; no all-output success is inferred.
4. Pause with an operator reason and a visibility reason. Becoming visible removes only the visibility reason. Resume applies the declared freshness and clock policy.
5. Disconnect/revoke the feed. Reject stale-generation updates; show the authored stale/fallback state without accepting instructions from upstream data.

### Adversarial/common cases

- Two modules request the same exclusive region: one checked lease grant, one explicit conflict; a failed handoff retains the old contribution.
- Two score increments serialize and both apply; stale absolute edits reject under their precondition.
- Reset during a pending effect fences its state result and releases acquired resources. Dispose never frees a texture still referenced by an output.
- A privileged room shutdown rejects queued stale actions regardless of module rules.
- A rule cycle or oversized collection rejects before partial commit; a slow dependency never leaves an unbounded queue.
- An invisible local commit produces no false presentation timeout. A superseded visible state produces no false presented acknowledgement.
- A paused auction with a module-clock deadline stays frozen; an explicitly wall-clock auction handles expiration once according to its declared admission policy.
- Rehearsal events, audience private data and connector credentials cannot reach live mutation or unauthorized output projections.

## 10. Specification boundaries and next artifacts

This draft locks proposed semantics, not final JSON field names, default numeric budgets, storage architecture or a network API. Capability profiles must advertise concrete limits and compatible behavior before packages claim portability across desktop, cloud or other renderers. The previously illustrated `producer.presentation/2` JSON is conceptual, not the selected format/version; existing experimental `producer.set/2` names do not decide this contract.

Review these rules first. Then author the definition/schema reference, typed internal command/event contract, reference packages for the four traces, a migration map for existing sets and executable conformance tests. Implement a vertical slice against those tests; do not claim conformance merely because a package parses or a simulated control panel works.
