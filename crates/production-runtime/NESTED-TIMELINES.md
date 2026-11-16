# Nested timeline milestone

This is an isolated Rust contract/compiler/transport milestone on `feat/production-core-phase1`. It is not the desktop Timeline, an OBS integration, a decoder, or an external cue dispatcher. The production app, its Sets and recordings are untouched.

## One definition, multiple placements

A `Sequence` defines a duration, tracks, source placements, cues, routes and optional child `instances`. A `SequenceInstance` references a definition by document-local ID. It owns a parent-time range, child `sourceIn`, positive constant speed, loop policy and explicit bindings. Nesting does not copy source assets or mutate the referenced definition.

```json
{
  "id": "right",
  "sequence": "motif",
  "range": {
    "start": {"ticks": "0", "rate": 1},
    "duration": {"ticks": "8", "rate": 1}
  },
  "sourceIn": {"ticks": "1", "rate": 1},
  "speed": {"numerator": 1, "denominator": 1},
  "looping": true,
  "targetBindings": [{
    "from": {"path": "sets/classic/layouts/wide/root/first-badge/badge/label", "property": "opacity"},
    "to": {"path": "sets/classic/layouts/wide/root/second-badge/badge/label", "property": "opacity"}
  }],
  "sourceBindings": [{"from": "player-a", "to": "player-b"}]
}
```

The generated [nested fixture](generated/nested-timeline.json) composes `timeline → motif → pulse`. Two placements animate different scoped component instances and independently trim two file players sharing one immutable asset. A nested binding addresses an exact exported target after inner bindings, not an ambiguous string-prefix replacement. Property changes, unused/duplicate bindings, incompatible source kinds and hosted targets reject. Asset metadata for the resolved file player is checked again after rebinding.

All saved definitions are valid standalone; temporary dangling references require one atomic transaction. An agent can create children first, then parents. Definitions and placements have separate identities. A source is not an asset: a file player owns a playhead; several players can reference one asset. A live source remains live and a temporal placement gates its use without manufacturing a seekable file playhead.

## Exact sampling and ownership

Parent ranges and leaf active ranges are half-open. Local time is `sourceIn + (parentTime - range.start) * speed`, with looping modulo the child duration. File modulo uses elapsed offset from its available source range, allowing negative preroll origins. No speed ramp or reverse media is supported in this profile.

Compiled tracks retain a bounded chain of numeric time maps. Loops never expand keys, tracks or a 24-hour sequence into per-frame/per-loop objects. Numeric evaluation uses checked i128 rational intermediates; it does not narrow between a slow parent and a compensating fast child. The final time must fit the exact serialized Time profile. Arithmetic overflow or an unsupported final rate rejects explicitly; it never silently snaps to milliseconds or floating point.

After expanding and rebinding, competing replace tracks on one property are projected to root-time intervals and rejected on overlap. Two nested placements may borrow one file player only if overlapping root-time intervals request the same source playhead. Otherwise they must bind separate players. Matching inherited source-to-bus route memberships coalesce. Route membership is not native audio mixing or proof of decoder/voice sharing; the native adapter still has to qualify those behaviors.

Collision proof is bounded control-lane work. Pathological loop comparisons may return `TEMPORAL_WORK_LIMIT`. Interval and cue projection currently require each projected boundary/query time to fit the wire Time profile; a composition whose intermediate projection is unrepresentable rejects, even when numeric forward sampling could cancel rates later. This is an explicit limitation, not permission to round a cue time or admit an unproved collision.

## Transport and effects are different

`Timeline` rehearses one compiled root sequence. It has a native execution UUID, increasing run ID, transport epoch, monotonic output nanoseconds, unwrapped content progress, wrapped display position and named pause owners. Root looping preserves its occurrence identity across pause/resume. One owner cannot resume another owner's pause. A new run or stop clears run-owned pauses; general Show segment scope/borrower cleanup is a later coordinator milestone.

- `Start` explicitly creates a new run and enables opted-in start cues.
- `Advance` returns crossed cue intents once, in root-time/path/occurrence order.
- `Seek` reconstructs picture and player positions silently. Forward seeks consume skipped history. Backward seeks retain the effect frontier, so old sounds do not replay when traversed again. Explicit `Start` is required to rearm that history.
- `Pause` drains crossings up to the pause instant, then freezes content while output time continues. `Resume` removes only the named owner.
- `Stop` cancels further cue intents and releases sampled timeline values/player requests. It does not stop an unrelated live capture or call a native device.
- Finite root completion releases sampled drivers. Repeated root and ancestor loops preserve separate counters in the cue identity.

A cue intent contains execution context from its Timeline sample, plus `run`, scoped `path`, `cue`, root `occurrence`, ancestor `ancestry`, and exact root `at`. `eachLoop` controls repeats at every ancestor. Zero-time cues need `atStart` for initial activation; repeat loops follow `eachLoop`. Cues clipped outside a placement never fire. Repeated observations of the same crossing emit nothing again.

Catch-up is capped at 64 intents/4,096 projection steps per cursor operation. An overflow leaves the cursor/transport unchanged; the caller must explicitly seek silently or start a new run. Timeline operations are staged on a candidate and publish only on success. Delayed completions must match execution, run and transport epoch; seek, stop or a new run fences older completions. These are intent-generation semantics, not an exactly-once promise for an external sound service.

## Agent/CLI boundary

The Rust-derived document, command and tool schemas and TypeScript types include nested instances and Timeline events. The existing session/revision/ticket boundary remains authoritative for saves.

- `nested-fixture`: emit the dependency-complete example document.
- `evaluate`: read-only numeric sample of the saved document; no cues fire.
- `simulateTimeline`: authenticated, read-only stdio rehearsal of up to 128 events, with at most 65,536 aggregate track/player/cue visits and an 8 MiB response budget. It never opens a device or dispatches a sound.

```json
{"method":"simulateTimeline","session":"<hello session>","sequence":"timeline","looping":true,"events":[{"kind":"start","at":"0"},{"kind":"advance","at":"500000000"},{"kind":"seek","at":"1000000000","to":{"ticks":"0","rate":1}},{"kind":"stop","at":"1500000000"}]}
```

`at` is monotonic **output nanoseconds**, represented as an exact decimal counter string; `to` is content Time. They are separate clock domains. Every rehearsal has a fresh execution UUID. Durable documents/commands reproduce numeric results and cue timing across restart, not the ephemeral execution UUID.

Run `scripts/prove-nested.py` against the actual CLI. It authors 16 incremental revisions, checks independent targets/file trims, atomically rejects a conflicting multi-operation edit, exercises 11 transport events, checkpoints/restarts and verifies identical results except for the fresh execution identity. It also checks authentication and event caps, then bulk-imports a separate large guard fixture to reject oversized work/response requests without changing saved state. This is agent-shaped CLI proof; the production Room Assistant is not connected to this core yet.

## Limits and remaining gates

Temporal depth: 16 instance edges (a file map may add one numeric map). Aggregate expanded sequence occurrences across all roots: 4,096; aggregate expanded tracks: 512. Each expanded root also caps players/cues/routes at 4,096. One temporal preflight/compile expansion pass has 16,384 charged work units; binding lookup uses bounded exported address sets. The contract's existing byte/key/node/command limits still apply.

Tests cover nested trims/speeds, negative file origin, property/player conflicts, loop seams, exact speed cancellation, cycle/depth/fuel rejection, hosted ownership, independent discrete cue oracle, start/seek/rearm/stop, pause owners, stale completion fences and failed-operation atomicity. The release benchmark has flat and nested 1,000-node/256-track modes and asserts zero numeric-evaluation allocations. Cue collection, CLI rehearsal and compilation are control-lane operations and may allocate.

Broad Phase 1 remains incomplete: runtime-global multi-document scheduling/accounting, incremental compilation, general Show occurrence ownership/cleanup, full native media and GPU adapters, allocation/error policy at callback handoff, renderer fidelity and physical cross-platform qualification are still required. This milestone does not establish an end-to-end NLE or a measured Three.js FPS gain.
