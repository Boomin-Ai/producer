# Shared source appearance

2026-10-04. Implemented contract, source-editor controls and native video filter;
video-only placement wrappers are also implemented and proved in the isolated
native graph. Live room integration and release remain gated by P0.

Source appearance is a media primitive used by ordinary source editing and JSON
sets. It changes video pixels. It never enables capture, admits a microphone,
changes monitoring, disconnects a guest or changes recording ownership.

## Contract

`src/lib/sourceAppearance.ts` owns the literal contract and its bounds. The
presentation codec includes the same definitions and accepts typed pure bindings
for each property. Projection resolves bindings and validates the complete
appearance again before handing it to a native adapter.

| Property | Default | Meaning |
| --- | --- | --- |
| `shape` | `rectangle` | Rounded rectangle or an inscribed circle, centered in the slot |
| `cornerRadius` | `0` | Pixels, 0–960; ignored for a circle and capped at half the smaller extent |
| `outlineWidth` | `0` | Pixels, 0–64; painted inside the mask |
| `outlineColor` | `#ffffff` | Six-digit RGB hex; unaffected by grayscale |
| `grayscale` | `0` | 0–1, original color to black and white |
| `opacity` | `1` | 0–1, transparent to opaque, including the outline |

Unspecified fields use defaults. Unknown fields, nonfinite/out-of-range numbers,
executable values and invalid colors fail validation. A circle keeps the placement
rectangle intact: its diameter is the smaller extent, with transparent margins.
It does not distort a face into an ellipse or change capture dimensions.

Example media node, using the fixture's already declared bounded `energy` feed:

```json
{
  "id": "guest-video",
  "type": "slot",
  "slotId": "guest",
  "styles": {
    "position": "absolute",
    "left": 700,
    "top": 160,
    "width": 420,
    "height": 420
  },
  "appearance": {
    "shape": "circle",
    "outlineWidth": 6,
    "outlineColor": "#ffaa22",
    "grayscale": { "get": "feeds.energy" },
    "opacity": 1
  }
}
```

Media slots accept positioning/sizing styles only. Radius, opacity, outlines and
grayscale must use `appearance`; CSS effects on an empty overlay placeholder do
not style the native video. Ancestor transforms/masks, media animation and general
interleaved layer order still need native preflight and receipts before live use.

## Source editor and ownership

The existing source **Filters** editor now offers **Source appearance** with
shape, corner radius, outline width/color, black-and-white and opacity controls.
The native filter is registered for the Mac and Windows builds. The normal
filter chain remains the source of truth; no additional dock is introduced.

Ordinary source filters are source-wide. With no placement extent, the native
filter measures radius/outline in input pixels; normal aspect-preserving source
scaling scales the whole result. A set adapter supplies its resolved placement
extent so its pixel units are measured at the final slot size.

**Live sets must attach their overrides to a separate video-only placement
wrapper, not the shared capture source.** The native constructor now retains an
existing input in an immutable private video-only proxy. It exposes no capture
selection in settings/IPC, refuses recursive proxies/scenes, and enumerates its
input for normal activation/lifetime propagation. Filters attach to that proxy.
The shared-input proof renders the same native source as a grayscale circle in
one slot and an unmodified colored rectangle in the other. Capture filter chains
stay unchanged, the wrappers have no audio output flag, and teardown is clean.

The constructor is not yet called by the live room/set adapter: readiness/grants,
generation fences, override precedence, effective inspector state and recovery
lifecycles are remaining integration gates. Source-wide masks cannot
be undone by a placement, so source-wide edits and placement overrides must remain
explicit in the inspector and effective appearance resolution.

Imported JSON never receives native handles, filter IDs, shader text or arbitrary
filter settings. Only the trusted adapter resolves a source binding and sets the
internal placement extent. Rust validates editor patches; native code clamps
bounds defensively. The graphics thread compiles only Producer's embedded shader.

## Evidence and limits

```sh
npm run test:presentation
npm run test:presentation-browser
npm run test:presentation-native-sources
npm run test:presentation-native-output
node scripts/test-presentation-output.mjs --native-sources --shared-source
```

The native proofs use Metal/NV12 by default on macOS. Set
`PRODUCER_PROOF_METAL=0` for the separately tested OpenGL source-effects fallback.
They require the existing engine frameworks/plugins in `/Applications/Producer.app`
and Playwright at `PRODUCER_PLAYWRIGHT_MODULE`. They run a disposable isolated
graph with solid-color native sources, no capture devices/audio/recording/stream
destinations, and leave the installed app unchanged.

Actual output pixels verify circle/rounded masks, transparent corners, colored
inside outlines, grayscale and opacity. Native position/bounds readback is checked
within one design pixel. Browser tests verify matching inscribed-circle preview
geometry, colored outlines and grayscale fill in Chrome and WebKit.

Captured examples: [circle and grayscale](../previews/source-appearance-circle.png),
[rounded corners, outline and opacity](../previews/source-appearance-rounded.png).
The [shared capture example](../previews/source-appearance-shared-capture.png)
shows independent styling of a single native input.
These are actual Metal output captures with synthetic inputs. Windows/D3D11,
transparent/HDR capture chains, live placement lifecycle/grants, live source
adapters and simultaneous portrait/landscape remain unproved. The source editor
needs a new native Producer build before the installed app can use this filter.
