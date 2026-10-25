# Managed Three.js Set layers

The managed renderer now plugs into the existing presentation/2 package, module
runtime, editor preview, native prepare/take path and recordings. Grand Arena’s
existing package remains intact. `docs/shows/grand-arena-3d-study.json` is a
separate development-only design study using the normal Set controller.

See [the authoring and lifecycle contract](../../docs/shows/scene3d.md).

Build the pinned trusted renderer:

```sh
npm --prefix scripts/scene3d ci
node scripts/scene3d/build-renderer.mjs
node scripts/scene3d/make-study.mjs
```

The browser acceptance check requires Vite on port 1436 and the local Playwright
installation described in `test-managed-browser.mjs`. Native acceptance is
opt-in through `VITE_SCENE3D_STUDIO=1 VITE_SCENE3D_STUDIO_PROOF=1` and the
isolated Sets v2 dev app. It uses camera permission and creates short local
recordings. It does not start a stream.

## Earlier isolated prototype

The instructions below describe the original engineering diagnostic, retained
for comparison. Its private descriptor and temporary control bar are separate
from the managed presentation/2 implementation above.

# Three.js native-output experiment

An isolated development prototype, built on Producer's existing browser sources,
ordered native groups and v2 prepare/take API. It does not change released Set
packages or introduce a second module runtime.

## Run

From the Producer checkout:

```sh
npm --prefix scripts/scene3d ci
node scripts/scene3d/dev-room.mjs
```

Requires the existing isolated Sets v2 dev app, root frontend dependencies, and a
free port 1436. Set `PRODUCER_SCENE3D_DEV_APP` to another isolated dev app bundle.
`--no-open` starts only the local services; `--record-proof` also records ten
seconds through Producer's normal recording API. No live-stream output starts.
The existing local workspace service remains responsible for the dev room.

The dev room has Blue/Gold/Neutral lighting cues, pause/resume, recording and Exit
prototype. Exit returns to the room scene and removes sources created by this
run. The prototype uses a separate **Producer 3D GPU lab** room and the isolated
app profile. The temporary controls are visible only in the development entry
when the runner supplies `VITE_SCENE3D_PROOF`.

## What exists

- Pinned Three.js 0.183.2 with locally bundled, trusted renderer code.
- Bounded JSON geometry, material, camera, animation and camera-slot descriptor.
- Independent landscape and portrait camera framing.
- A perspective stage behind native video, and transparent trim above it.
- A shared anchor and revisioned cue snapshots; polling does not recreate canvas,
  meshes or animation clocks. Static foreground and paused scenes do not redraw
  continuously.
- Shader precompilation, renderer telemetry, explicit geometry/material/renderer
  disposal, and an explicit context-loss failure signal.
- Real CEF WebGL2 sources composited through libobs Metal, including a physical
  camera, with no screenshot transport or WebGL pixel readback in the renderer.

`producer.scene3d-proof/1` is an **experimental descriptor**, not a published Set
schema or import capability. The cue endpoint is a private loopback development
fixture, not a replacement for authoritative Set/module state. Production must
feed the same renderer from existing committed module projections.

## Verification

```sh
node scripts/scene3d/test.mjs
# With a running serve.mjs manifest:
node scripts/scene3d/test.mjs /private/tmp/producer-scene3d-manifest.json
PRODUCER_PROBE_SCENE3D_MANIFEST=/private/tmp/producer-scene3d-manifest.json \
PRODUCER_PROBE_OUTPUT=/private/tmp/producer-scene3d-proof \
bash scripts/sets-v2/run-native-probe.sh
```

Optional native probe flags: `PRODUCER_PROBE_SCENE3D_CAMERA=1` (physical camera;
requires macOS permission), `PRODUCER_PROBE_SCENE3D_PORTRAIT=1`, and
`PRODUCER_PROBE_SCENE3D_CEF_FPS=60`. Diagnostic captures use readback only at test
boundaries. Physical-camera images and recordings stay local.

The native proof checks actual transparent pixels outside trim and inside camera
openings, native video between layers, changing animation pixels, per-run WebGL2
readiness and healthy renderer telemetry. The browser check verifies retained
canvas identity across cue/pause changes, applied revisions, descriptor budgets
and the local request boundary. A renderer-ready report alone is not a native
presentation acknowledgement; the room harness separately checks the native
rendered revision.

## Gates before the public Set capability

1. Resolve CEF/frame pacing and measure sustained frame delivery in a realistic
   room. Initial 30 fps CEF runs show approximately 67 ms p95 RAF intervals. A
   60 fps CEF experiment with static foreground improved that short sample to
   approximately 50 ms p95; neither establishes steady 30 fps production output.
   The final isolated room sample reached 33.4 ms p95 (about 30 fps) after
   excluding the normal Set controller and making the foreground static. See
   proof.json. These are short tests on a memory/disk-constrained M1 machine.
2. Verify the actual accelerated IOSurface import path; the reported Apple Metal
   WebGL renderer proves GPU rendering, not absence of copies in every transport
   stage. Compare the pinned [OBS browser source](https://github.com/obsproject/obs-browser/tree/ea04212e4bbadd077f9e6038758c4e4779c24fa3).
3. Add a managed, trusted native renderer resource with bounded instance/context
   lifetime, first-frame readiness, clock updates and automatic context recovery.
   Local development HTTP services are not the production resource transport.
4. Add `scene3d` validation/lowering to the existing presentation schema/compiler,
   package assets and capabilities. Reuse existing module authority and lifecycle;
   do not put scores, voting decisions or integration credentials in Three.js.
5. Exercise simultaneous landscape/portrait output, recording, rapid takes,
   cancellation, disposal and recovery against the new managed resource.

A normal Producer recording was decoded and verified at 1920×1080, 30 fps,
10.133 seconds. 8,006 sampled stage pixels changed between seconds 1 and 8 in
bands outside both native camera slots. The local camera clip is not committed.
Use `xcrun swift scripts/scene3d/inspect-recording.swift <recording.mp4>` to repeat
this independent encoded-output check.

Native video is planar. Perspective-mapped video textures, GLB loading, skeletal
animation, bloom and public authoring controls are not implemented by this proof.
The procedural stage is an engineering pilot, not the final Grand Arena design.
