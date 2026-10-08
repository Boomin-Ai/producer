# GPU shader layers

Producer provides eleven trusted procedural presets: `aurora`, `edgeGlow`, `lightSweep`, `plasma`, `silk`, `rings`, `grid`, `stars`, `petals`, `contours`, and `prism`. They run as native GPU sources inside the set composition, with the same math compiled to WebGL for the editor preview. Native output uses the existing OBS graphics backend (Metal on this Mac). Imported sets choose presets and bounded parameters; they do not contain executable shader code.

**Combo Studio — Shader Duets** is saved at `/Users/klevelandbishop/Documents/boomin/docs/shows/shader-combo.show.json`: 16 segments, 32 landscape/portrait layouts, 11 two-host scenes and five solo scenes. Bind Host 1 and Host 2 to separate room sources. Portrait duets use two 632×356 stacked camera cards, names outside each image, and reserved title/footer space. Solo portrait layouts use a larger 632×652 camera. Camera entrances settle into stable framing; titles, label fades, shader scale, glow intensity and sweeps share the show clock. Each scene stays within four GPU planes.

| Preset | Visual |
| --- | --- |
| plasma | Liquid color fields |
| silk | Flowing parallel ribbons |
| rings | Expanding concentric pulses |
| grid | Moving architectural lines |
| stars | Sparse drifting, twinkling points |
| petals | Sixfold kaleidoscopic petals |
| contours | Animated topographic lines |
| prism | Prismatic diagonal bands |

The demo **Shader Lab — Aurora, Glow & Sweep** is saved in the local library at `/Users/klevelandbishop/Documents/boomin/docs/shows/shader-lab.show.json`. It contains 16 segments and 32 landscape/portrait layouts, with varied palettes, speeds, ribbon scales and alternating landscape compositions. Assign the host camera in Set edit, rehearse, start the show, and use Next. Show shaders follow pause, resume, seek and reset. Standalone sets play their ambient shader clock automatically.

```json
{
  "id": "atmosphere",
  "type": "shader",
  "styles": {
    "position": "absolute",
    "left": 0,
    "top": 0,
    "width": 1280,
    "height": 720
  },
  "shader": {
    "effect": "aurora",
    "colors": ["#071023", "#236bad", "#845ade"],
    "speed": 0.65,
    "intensity": 1.4,
    "scale": 1.15,
    "opacity": 1,
    "radius": 28,
    "quality": "low",
    "clock": "segment"
  }
}
```

All shader fields are explicit. Bounds: three hex colors, speed 0–4, intensity 0–2, scale 0.25–4, opacity 0–1, radius 0–960, quality low/medium, clock show/segment. Up to four shader nodes belong directly under the layout root. The root uses relative positioning, exact numeric canvas width/height, and only position/width/height/background/overflow styles. Shader nodes use absolute numeric left/top/width/height and fit inside the canvas. Components and CSS ancestor effects are intentionally excluded from this first layer path.

Native planes render above the root background, below cameras and foreground graphics, in their own declared order. A glow is a padded procedural rectangle behind a camera; leave room around the camera rather than placing the effect over its pixels. A sweep can light a title region or a reveal card, but opaque foreground graphics can cover it. These are layer effects, not arbitrary camera or text texture filters.

Layout keyframes support `shader.intensity` and `shader.scale` on shader targets, plus the ordinary geometry/opacity tracks. Geometry scales the rendered plane; radius/extent are based on its authored size. Parameter tracks can repeat or ping-pong. The clock is shared with native animations; no per-frame JSON rebuild or IPC is needed. Interaction-to-shader bindings remain separate work.

Aurora and the eight new background presets render at 25% width and height in low quality (one sixteenth of the full pixel count), or 50% in medium quality. Glow and sweep render at 50% in low quality or full authored resolution in medium quality. Text and cameras keep their output resolution. Effects update at most 30 times per second and reuse their texture while their sampled parameters are unchanged, including while paused. Shader compilation happens during preparation; matching native shader sources can be reused across prepared layouts.

Validation includes malformed JSON and shader budgets, shared-kernel GPU preview tests in Chromium and WebKit, native configuration-cache invalidation, and native pixel checks for clock/parameter changes, pause/seek/reset and both canvas outputs. Performance measurements use OBS average render time and active FPS; that metric is native render pressure, not an isolated GPU timer. Synthetic probe artifacts are in `/private/tmp/producer-shaders-o7oNAY`.

The clean dev run on this machine held 30 FPS with three effects on each canvas. OBS reported 12.46 ms average native render time with effects, and 10.97 ms with their opacity set to zero: about 1.48 ms added render pressure in that synthetic comparison. Warm segment application took 32 ms and 1 ms. These numbers include the compositor and diagnostic capture, not just shader instructions; they do not predict a room with many real sources. An earlier run during other work dropped frames, so keep performance sampling separate from builds and browser test runs.

Commands: `node scripts/create-shader-demo.mjs` generates the library demo and probe fixtures. `scripts/test-shaders.mjs` exercises the browser GPU path; set `PRODUCER_PLAYWRIGHT_MODULE` to the installed Playwright module if needed. Native verification uses the existing `PRODUCER_SET_OUTPUT_PROBE` mechanism with the generated fixture directory and its `shader-check` marker. The native probe also verifies that reset and promotion use the incoming clock, rather than retaining a frozen warm-up clock.

`node scripts/create-shader-combo.mjs` generates the combo and its `combo-check` native probe. `scripts/test-shader-combo.mjs` renders all 32 layouts in Chromium and WebKit and requires animated nonblank pixels for every preset. The native combo probe applies every landscape and portrait scene with two synthetic host sources and checks that their original source state survives.
