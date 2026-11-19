# Analytic reconstruction inputs — version 1

This is a **headless Rust input protocol**, not a rendered effect, GPU ABI or
proof of visual equality on Metal/D3D/Vulkan. No desktop/native adapter uses it
yet. Stateful simulation remains unsupported. A renderer must qualify its own
integer upload, numeric precision, kernel, colour and pixel output separately.

## Authoring

A graphics scene may explicitly opt in:

```json
"reconstruction": {
  "version": "producer.analytic/1",
  "seed": "18446744073709551615",
  "scope": "placement",
  "period": { "ticks": "3", "rate": 2 }
}
```

All four fields are required; unknown fields/versions reject. The seed is an
exact decimal u64 string, including values beyond JavaScript's safe integer.
The positive period is between 1 ms and 24 h. It controls an effect's cycle, not
the production transport, movie availability, duration, speed or loop ownership.
Legacy scenes omit this object and retain their canonical bytes/identity; no
default seed, implicit wall clock or reconstruction promise is invented.

Agents use the generated document/command/tool schemas. The targeted atomic
`setAnalyticReconstruction { source, value }` operation changes only these
inputs on a graphics source; it preserves its parameters, batches, Set controls,
Show definition and timeline. It shares existing validation, author authority,
revision/ticket, undo, durable receipt and checkpoint/recovery handling.
The generated `analytic-effects.json` demonstrates nested placements and both
seed scopes. This does not connect the production Room Assistant to the new core.

## Compile, bind, sample

`Plan.analytic_sources` holds opted-in source definitions. Static Set adapters
bind a stable expanded node path once, off callback, and supply explicit content
time from their runtime-owned Set clock. Static-segment clock selection and
native execution are not implemented by this slice; frame/output wall time must
not be substituted silently.

Compiled sequence effects contain a source ID, expanded placement path, bound
clock and bounded ancestor maps. Ancestor trim/speed/loop maps compose exactly;
an effect's local time is **mapped sequence time minus placement start**. Its
half-open placement hides it before entry and at the endpoint. Graphics do not
acquire file-player trims/speeds/loops; those belong to the enclosing sequence.
Existing source-kind binding checks continue to reject file-to-graphics rebinding.

`SequencePlan`, `Timeline` and `ShowRun` expose `evaluate_effects_into` with
caller-allocated slots. Timeline seeks reconstruct silently; pause freezes content
time; stop/static-segment entry/revocation clears scheduled effect slots. A new
execution/run does not reshuffle the same authored identity. A failed evaluation
returns a Copy error; the adapter must discard the whole candidate frame. It
must not publish a partially filled scratch array.

Each `EffectInputs` packet carries exact rational `time`, u64 `cycle` and
`phaseQ32 = floor(fract(time / period) * 2^32)`, plus version and four seed words.
This avoids feeding ever-growing f32 seconds to a shader. All calculations use
checked/bounded integer arithmetic. Negative content time and an unrepresentable
cycle reject. The Rust struct is **not** a raw GPU uniform layout: adapters must
pack explicitly. Fraction-to-float conversion and GPU pixel tolerances remain
renderer gates.

## Identity and deterministic noise

Source scope hashes document ID, source ID and authored seed. It ignores the
bound path, so paired orientations can share random attributes at equal content
time. Placement scope also hashes the stable expanded node/placement path, so
instances can differ. Layout edits which change that identity intentionally change
the placement seed; unrelated copy, theme, wall time, run UUID, output PTS and
sampling order do not. Source scope shares **random identity**, not a global
mutable clock or the timeline's property-driver authority.

Version 1 hashes these bytes with SHA-256, then takes the first 16 bytes as four
big-endian u32 words:

1. ASCII `producer.analytic/1`, then NUL.
2. Document ID and source ID, each framed as big-endian u64 UTF-8 byte length
   followed by those bytes.
3. Authored seed as big-endian u64.
4. Scope byte 0 for source, or byte 1 followed by a length-framed placement path.

Off-frame `substream(id)` hashes ASCII `producer.analytic/1/substream`, NUL,
the four big-endian seed words and a length-framed stable batch/material ID.
Batch reordering need not reshuffle attributes. Domain hashes are not permission
tokens and are not per-frame work.

`random_word(stream, instance, channel)` fixes an ordered, wrapping u32 noise
function. Let `mix(x)` be `x ^= x >> 16; x *= 0x85ebca6b; x ^= x >> 13;
x *= 0xc2b2ae35; x ^= x >> 16`, all multiplies modulo 2^32. Evaluate
`a=mix(seed[0]^stream)`, `b=mix(a^seed[1]^instance)`,
`c=mix(b^seed[2]^channel)`, return `mix(c^seed[3])`.
Counter roles are ordered, not an interchangeable XOR reduction. Time does not
advance a PRNG: a kernel uses phase/cycle explicitly. This is deterministic
visual noise, not cryptographic randomness or a guarantee of unique outputs.

## Lifecycle, bounds and evidence

Changing reconstruction inputs invalidates the affected sequence cache and source
incarnation. Numeric scene-parameter edits keep that source incarnation; document
identity is part of reconstruction identity. This is tested in the existing
synthetic take/readiness/disposal model, not a real GPU allocation lifecycle.

Effects reuse the placement expansion bounds (4096 per expanded sequence,
16 ancestor levels plus the final placement map). They do not unroll cycles,
allocate history or add rendering surfaces to the model. Slots and maps add
bounded CPU plan memory; the full maximum-document/service/native memory matrix
must still qualify it. Rehearsal work and serialized reply budgets include effects.

The tests cover strict admission, exact large-time phases, scoped identity,
nonmonotonic seeks, restart, pauses, stop, Show transitions/revocation, cache
changes, incarnation changes, targeted atomic edits and independent integer
noise vectors. The real stdio proof uses independently expanded author documents,
Python Fraction mapping and SHA-256 seeds: 572 input comparisons, 18 durable
commits, a rejected atomic candidate, retained receipts and checkpoint/restart.
No sound/action is dispatched by that proof.

`analytic_profile` measures 256 simultaneous effect clocks and 4096 deterministic
noise values per sample, flat and nested, with allocator instrumentation. It
contains no effect renderer, geometry upload, colour conversion or draw calls.
See the source-linked checks/profile artifacts and readiness ledger for measured
results. A24 remains partial until native renderer equality is demonstrated.
