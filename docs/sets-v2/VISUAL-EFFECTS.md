# Shared layer effects, version 1

This is an optional extension to `producer.presentation/2`, shared by every Set. Add `requires: ["mask@1", "backdrop@1"]` for the features a package uses. Unsupported feature identifiers or effect fields fail validation rather than silently changing the output. Existing packages need no migration; their existing rounded camera clipping remains supported.

## Masks

Attach a `mask` to a box, camera slot or media placement. A box masks the combined pixels of its children, including native video, images and graphics. A root mask can reveal the whole composition, including its 3D scene; nested 3D placements remain subject to existing schema restrictions. It does not alter the physical camera or another placement of that source.

```json
{
  "id": "guest-reveal",
  "type": "box",
  "styles": {"position":"absolute","left":900,"top":140,"width":600,"height":800},
  "mask": {"kind":"circle","progress":0,"x":0.5,"y":0.5,"feather":6},
  "children": []
}
```

Fill `children` with the source or layers being revealed. Circle progress goes from fully hidden at 0 to fully visible at 1; the radius expands to the farthest corner from the normalized center. For a permanently circular camera window, continue using the existing source appearance/circular clipping rather than a full-frame reveal.

Kinds:

- `rounded`: static rounded clipping, `radius` in logical pixels (0–960).
- `circle`: expanding circular reveal, normalized `x` and `y` center (0–1, defaults 0.5).
- `wipe`: linear reveal from `direction`: `left`, `right`, `up` (top), or `down` (bottom).

Circle/wipe share normalized `progress` (0–1, default 1), `feather` (0–32 logical pixels), `invert` (default false), and optional rounded outer `radius`. Feather softens the reveal edge, not the text or camera pixels. Endpoints are exact: 0 and 1 fully hide/show the region before inversion. Geometry remains clipped to the element bounds. Rounded masks use radius, not progress/inversion.

Numeric/boolean mask fields accept normal validated data bindings. This supports module-controlled progress without arbitrary executable code. Module state remains subject to existing operator/moderator authority and instance isolation.

Animate reveals through the existing layout animation system:

```json
{
  "target":"guest-reveal",
  "property":"mask.progress",
  "keyframes":[{"atMs":0,"value":0},{"atMs":900,"value":1}],
  "easing":"easeInOut",
  "clock":"segment"
}
```

The standard delays, repeat/pingpong, show/segment clocks and pause semantics apply. Module view actions select an authored reveal layout; Show segments can select it through ordinary sequencing. Cached scenes reset mask progress to the authored value before reentry. No set-specific Producer logic is required. This does not add a separate workflow language or automatic animation to every state edit.

## Backdrop blur

```json
{
  "id":"glass-header",
  "type":"box",
  "styles":{"position":"absolute","left":24,"top":20,"width":1872,"height":116,"background":"#10203066","border":"1px solid #ffffff88"},
  "mask":{"kind":"rounded","radius":20},
  "backdrop":{"blur":12},
  "children":[]
}
```

Place crisp heading/text children inside the panel. The native compositor first draws earlier siblings in the **same parent group**, blurs their already-composited pixels within the panel region, then draws the panel tint, border and children. Later siblings are unaffected. Nested panels see their local siblings; they do not read arbitrary ancestors, room UI, or output devices. Empty/transparent areas remain transparent. This is a local effect, not a filter on the physical source.

Blur is 0–24 logical pixels. In v1 a backdrop panel has static, axis-aligned placement; its opacity and mask progress can animate. Geometry transforms/tracks on that panel are rejected. Ancestor composition transforms apply after its local composition. Image/SVG/luma masks, blend modes, displacement and magnification are not included in this feature version.

## Budgets and implementation

Validation occurs in the package parser, resolved projection and independent native IPC contract. Maximums per layout: 16 explicitly authored masks, four backdrop panels and 4,194,304 logical backdrop pixels. Existing timeline, node, depth, texture and total scene-byte budgets still apply. Package authors cannot submit shader code, URLs, native handles or arbitrary CSS effects. Invalid bindings and out-of-range runtime values fail closed, preserving the previously presented output.

The GPU path uses ping-pong RGBA accumulation to avoid sampling the active render target, followed by a bounded separable blur cropped to the panel. Source video, images and Three.js remain in the existing ordered compositor. Foreground text is drawn after the blur. Two accumulator textures and one reusable padded blur texture are charged to native scene budgets before activation. No CPU video readback is introduced in the live effect path. Tests use readback only to verify actual pixels.

Unchanged sets retain their direct-draw path. Simple source circles keep the existing clipping path. Effects allocate only for opted-in graphs; final references release their textures with the scene. GPU cost depends on panel area/output resolution and must be measured on the intended machine; smoothness is not guaranteed by schema validation alone.

The trusted browser preview mirrors the same masks and timing using CSS gradients and `backdrop-filter`; the native output uses GPU shaders. Effects require the new native binary. The output hook checks native capability discovery before preparing a package; an older engine without the required capability reports an update requirement instead of approximating the effect. This work does not publish or deploy a release.

## Verification

- `node scripts/test-visual-effects.mjs`
- `node scripts/test-visual-effects-browser.mjs` (Vite 1436 and local Playwright harness)
- `cargo test --manifest-path scripts/sets-v2/rust-probe/Cargo.toml --test contract`
- `PRODUCER_PROBE_VISUAL_EFFECTS_ONLY=1 PRODUCER_PROBE_OUTPUT=/private/tmp/producer-visual-effects-proof bash scripts/sets-v2/run-native-probe.sh`

The native proof checks mask endpoints/midpoint and inversion, a real native animation track at a paused midpoint, cached reset, known-color backdrop pixels, unaffected foreground/outside pixels, preserved translucent alpha, both linear and nonlinear color contexts, and released group resources.

For hands-on review, load `docs/shows/visual-effects-lab.json`, bind its host slot and start its Reveal direction module. Hide/reset, Circle reveal and Wipe reveal select ordinary authored layouts. Atmosphere also opts in to a 12-pixel glass header. Neither package needs custom runtime behavior.
