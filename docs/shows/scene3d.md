# Managed 3D layers

A `scene3d` node in a `producer.presentation/2` layout declares a trusted,
bounded `producer.scene3d/1` world. This is an additive visual capability:
existing module state, actions, source bindings, typography, audio and optional
Show orchestration remain authoritative.

## Composition and controls

Place up to two 3D nodes directly under the layout root, with numeric dimensions
and absolute placement. Use `background` before native camera slots and
`foreground` afterward. Both passes use the same authored world; mesh `pass`
selects where a mesh renders. Foreground slot trim is orthographic, so camera
openings remain aligned while perspective studio views move. Cameras themselves
remain crisp native sources; this version does not map video onto 3D surfaces.

`scene3d.id` identifies a reusable world. `cue` and `view` can bind to public
module outputs. Optional numeric `cueSequence` changes replay an unchanged cue.
Cue transitions last only their authored `durationMs` (or world default);
Producer does not add a segment transition. Lighting targets, mesh visibility,
camera views and bounded procedural motion are declarative. Motion may use the
Set clock or restart with a cue. Modules continue to own permissions and state.

The study generator demonstrates scoring independent from studio direction,
wide/close views, host/challenger lighting and a replayable foreground emblem.
Landscape and portrait have independently authored framing and text placement.

## Preparation, presentation and recovery

The package is validated in JavaScript and independently in native Rust. Geometry
preparation identity excludes cue, view and cue sequence. Preloading prepares
resources without publishing visual changes; an accepted take publishes current
committed controls. Hidden worlds retain logical time while skipping GPU draws.
Pause and context restoration preserve the animation timeline.

Native leases retain browser sources and reuse their GPU contexts across control
updates. Each output permits up to six retained contexts and 24 Mi logical pixels
in its resource store; a layout contains at most two passes. World limits include
128 meshes, eight lights, eight slots, twelve views and thirty-two cues. Imported
packages cannot provide renderer JavaScript, arbitrary shaders or network URLs.

Native presentation waits for the browser revision report and matching fence
pixels in the actual imported surface. The fence occupies a clipped extra row
and is checked at presentation boundaries, not through per-frame JavaScript
readback. Stale sessions/reports do not acknowledge a newer revision. Renderer
failure, context loss and expired readiness prevent a false presentation success.

## Current boundaries

This implementation targets Producer's macOS native compositor and requires a
build advertising `live_set_v2_scene3d_enabled`. Three.js uses WebGL2; the tested
Mac reports ANGLE/Metal on Apple silicon. End-to-end zero-copy browser transport
has not been established. This is not yet a general 3D asset pipeline: GLB models,
external textures, skeletal animation, adaptive quality tiers and perspective
video surfaces are future capabilities. The included study uses procedural
geometry and studio environment reflections, rather than photoreal asset models.

## Validation

`test-managed-browser.mjs` exercises real editor previews, native plan lowering,
module cues, retained canvases, context restoration, portrait and disposal.
`studioRoomProof.ts` is a local opt-in native acceptance helper using the normal
editor and module controls, both output acknowledgements, stable context counts,
and repeated recording labels. Camera captures and recordings stay local.

## First native measurement

The [sanitized acceptance receipt](proofs/scene3d-managed.json) records seven
module cues presented on both outputs, four retained 3D contexts before and
after controls and after a flat/3D package round trip, and two distinct pairs of
1080p/30 recordings. The flat counterpart kept the same native cameras, text and
output dimensions and omitted both 3D passes.

On this Apple M1 development build, average compositor time was 6.49 ms for the
flat counterpart and 8.78 / 11.75 ms in the two 3D samples; reported output FPS was
30. These short, uncontrolled desktop samples do not isolate GPU execution,
attribute system GPU utilization, or establish a dropped-frame rate. The timing
samples ran with recording stopped; paired recording acceptance was separate.

`VITE_SCENE3D_STUDIO_BENCHMARK=1` enables that optional local comparison in the
native acceptance helper. `gpu-sample.py` samples system-wide Apple GPU counters;
its phase labels come from periodic progress reports and can lag transitions,
so use it as diagnostic context, not a precise Producer-only percentage.
`PRODUCER_SCENE3D_DEBUG=1` enables bounded native readiness diagnostics for reports
and the clipped fence strip. These diagnostics contain no room camera pixels.

## Coordinated camera and studio transitions

The 0.2 studio study uses existing module views and `set.views` to select
face-off, host-focus and challenger-focus layouts in both orientations. Each
layout explicitly authors a 650 ms `morph`; no dissolve is added. Its direction
action commits lighting, the 3D camera view and module view together.

Video positions, sizes and outlines render natively. Caption containers follow
the native morph, keeping typography visible. The stage and emblem now share
one background 3D pass per output; the emblem sits behind video. A transparent
foreground pass remains available to other packages when their composition
requires it.

Standalone Sets can now use the same native morph machinery as Shows.
Ephemeral motion tracks are generated for each authored orientation variant,
so simultaneous portrait output follows its own geometry. Rapid reversals sample
the interrupted motion. Geometry preparation excludes those transient tracks;
all six poses prepare ahead and reuse the orientation's world resource.
Setting authored morph duration to zero gives an immediate cut.

The declared view controller reasserts its selected view on its own state/view
commit, including a repeated direction action after a manual layout override.
Commits from an unrelated module such as scoring leave that override intact.
This does not add room-source authority to the studio module.

New or recovered WebGL surfaces draw three warm-up frames before entering their
static draw-suppression path. This gives the offscreen browser compositor paint
opportunities while native revision-fence verification remains authoritative.
It does not introduce a per-segment transition delay.

## Native readiness threading

Warm-up draws and marker/fence readbacks queue synchronously to OBS's graphics
thread. The owner thread must not hold the graphics lock while waiting. Merely
entering the graphics context on the owner thread allows source rendering to
interleave with the graphics thread's tick/draw lifecycle; crash reports from
this development build showed invalid Metal render-target references in that
path and at the next frame reset.

Cold 3D preparation allows up to 30 seconds for shader compilation and the first
imported browser paint; ordinary media retains its 12-second deadline. This does
not change cached layout switching or relax the browser/fence acknowledgement.

`VITE_SCENE3D_STUDIO_SOAK=1`, together with the existing native proof flag, adds
120 repeated direction changes. Each requires landscape and portrait commits
and unchanged GPU-world counts. Run without manual control or Set changes.
The initial local run stayed alive for over six minutes through repeated cues
and a subsequent manual switch to Grand Arena, with no new native crash report.
That switch interrupted the soak's resource-count assertion, so it is not a
completed 120-cycle acceptance result. Browser acceptance and the initial native
apply, six-layout preparation, seven cues and paired recording checks passed.
