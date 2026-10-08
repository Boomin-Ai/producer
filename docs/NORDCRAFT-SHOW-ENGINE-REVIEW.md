# Nordcraft as a JSON show UI foundation

Reviewed 2026-10-04. Upstream checkout: `nordcraftengine/nordcraft` commit
`e4ebe92c42f6c4226ad7d0bb33a70ff7206178c8`, inspected in
`/private/tmp/producer-nordcraft-review`. Research only; no Nordcraft dependency
was added to Producer and no show runtime was deployed.

## Product direction

The user wants agents to design highly flexible shows as JSON documents. The
runtime should support expressive layouts, typography, SVG, reusable components,
conditional/repeated elements, data bindings, stateful interactions and animation.
A guided visual builder can follow; predefined widget templates must not be the
ceiling on show design. Audience participation should drive visual states such as
heating up, failure, score changes and winner reveals.

## Findings from upstream code

- Core node types describe HTML elements, text, components, slots, conditions,
  keyed repetition, attributes, styles, variants, classes, custom CSS properties,
  events and keyframes. These form an executable document model, rather than just
  a list of preset widgets.
- `applyFormula` interprets JSON expressions, including paths, branches, boolean
  operations, objects, arrays and registered functions. Data can affect display
  without generating a new JavaScript program for every show.
- The runtime creates DOM/SVG nodes and subscribes text, classes, attributes and
  CSS properties to reactive signals. Keyed repeats preserve node identity.
- `getNodeStyles` emits CSS variants and `@keyframes` from JSON. The runtime's
  editor helpers also contain keyframe preview and timeline scrubbing logic.
  Animation duration, delay, iteration, direction and timing functions use CSS.
- Custom-element embedding exists (`defineComponents`, `ToddleComponent`),
  alongside the page runtime. The code still has Nordcraft/Toddle globals and
  initialization expectations; it is not a ready-made standalone Producer API.
- The repository contains editor metadata and runtime preview helpers. I did not
  find the complete visual editor application/animation timeline authoring UI.
  The open animation renderer is useful independently of that editor.
- The repository and core/runtime packages declare Apache-2.0. Preserve applicable
  license/copyright/NOTICE information and mark modified borrowed code. A package
  dependency audit is still needed if we vendor/build a complete runtime.
- Upstream's README says the packages are used internally and are not yet ready
  for external applications to consume. Pin a revision and put a Producer adapter
  in front of the runtime instead of coupling stored show packages to an unstable
  external API.
- Custom JavaScript handlers exist (including `new Function` in editor preview).
  JSON alone does not provide isolation. The initial Producer document contract
  should use registered expressions/actions and validate node/attribute/URL types.
  Render imported show content separately from the authenticated Tauri control UI
  and expose a narrow event/action bridge.

## Local verification

Ran `/private/tmp/nordcraft-show-review-check.mjs` against upstream core source,
using Producer's existing esbuild to bundle research functions only. A JSON node
with keyframes produced a CSS animation; a JSON switch expression changed its
result from CALM to HEATING UP when audience state changed. No per-show source
compilation was involved. This is a functional proof of the two core mechanisms,
not a complete browser/OBS integration, full Nordcraft test run, frame-rate test,
or benchmark of the shipped runtime's size.

## Proposed Producer integration

1. **Versioned show document:** own schema/version, reusable UI components and
   assets, segment definitions, timing/scoring rules, role-specific control views,
   source-slot bindings, formulas, workflows and animation definitions. Validate
   an agent-authored document before preview/import.
2. **Reusable runtime:** build it once with Producer. On show load, parse/validate
   JSON, resolve assets/components, prepare dependency bindings and emit CSS.
   Ordinary layout/animation changes do not require a per-show npm/Vite build.
3. **Room adapter:** provide a documented state contract containing run identity,
   segment/clock, participants, scores, votes and aggregate audience activity.
   Use explicit event IDs for one-time visual effects. Batch frequent reactions;
   do not broadcast animation frames or run an animation loop in the DO.
4. **Authority:** host/mod/audience controls issue permission-checked room actions.
   Shared scores, vote lifecycle, segment changes and pause/resume are room-owned.
   Local UI state and cosmetic animation stay local. A show imports rules, not
   unrestricted authority to change room permissions.
5. **Host rendering:** load the show in a transparent local browser source and
   compose/encode with existing host hardware. The main output distributes the
   rendered show through existing audience and external network paths.
6. **Video placement bridge:** JSON layouts need explicit native camera/guest
   slots. HTML moving or resizing does not automatically move native video below
   it. Translate stable slot layout changes into normal acknowledged source
   operations. Animated native slot transforms need a deliberately synchronized
   path; do not imply that CSS animation alone solves compositor synchronization.
7. **Run/version lifecycle:** pin a show version for a run, keep interactions
   episode-specific, reconstruct state on reconnect, and seek timers/animations
   from the authoritative clock. An agent's preview edits should not silently
   replace an on-air show. A deliberate apply operation can support live changes.
8. **Audience and control surfaces:** the on-air layout, host desk, moderator desk
   and audience interaction layout can share component definitions and room state
   while exposing different actions. Preserve the native iOS audience shell and
   media controls. Arbitrary HTML/CSS show layouts require an isolated web surface
   or a separately implemented native interpreter; JSON is not automatically a
   SwiftUI renderer. This presentation choice remains open.

Prototype one expressive agent-authored show before building an editor: two native
video slots, typography/SVG graphics, a countdown, scores, a vote-driven heat
visual and a winner/failure animation. Test hot preview updates and pause/reconnect
on the actual OBS browser source as well as browsers. Compare borrowing selected
core/runtime modules with embedding the custom-element runtime, then choose from
integration and performance evidence. No additional Cloudflare product is needed
for the graphics renderer; existing media-delivery limits still apply.

## Primary sources

- Repository/status: https://github.com/nordcraftengine/nordcraft
- License: https://github.com/nordcraftengine/nordcraft/blob/main/LICENSE
- Document model: https://github.com/nordcraftengine/nordcraft/blob/main/packages/core/src/component/component.types.ts
- Formula interpreter: https://github.com/nordcraftengine/nordcraft/blob/main/packages/core/src/formula/formula.ts
- CSS generation: https://github.com/nordcraftengine/nordcraft/blob/main/packages/core/src/styling/style.css.ts
- DOM/SVG bindings: https://github.com/nordcraftengine/nordcraft/blob/main/packages/runtime/src/components/createElement.ts
- Runtime embedding: https://github.com/nordcraftengine/nordcraft/blob/main/packages/runtime/src/custom-element/defineComponents.ts
- Timeline support: https://github.com/nordcraftengine/nordcraft/blob/main/packages/runtime/src/editor/timeline.ts
- Animation docs: https://docs.nordcraft.com/styling/animation-editor

## 2026-10-07 implementation follow-up

Inspected upstream commit `5e7dd894c762f7d8bfdfb7138bc6195f7b465e8b`.
The useful additional references are `packages/core/src/styling/theme.ts`
(typed token groups and font variants), `styling/customProperty.ts` (bounded
property resolution), and `component/component.types.ts` (composition and
variants). Producer now implements shared scalar `set.tokens`, named decorative
`set.styles`, and node `styleId` with local overrides. Token references use
`{ "get": "tokens.mint" }`; they resolve before native transport. Presets remain
unflattened in exported packages so editing a shared preset changes its users.

The typography vocabulary adds fontFamily, fontStyle, textTransform, textShadow,
whiteSpace, wordSpacing, backgroundSize and backgroundPosition. Graphics also
support filter, clipPath, mixBlendMode and isolation. Effects enclosing native
camera/shader layers are rejected rather than rendering differently in preview
and native output. These are graphic effects, not new native camera filters.
Fonts currently use installed families and explicit fallbacks; embedded custom
font loading is not implemented. Whole-camera group transforms and arbitrary
native masks remain separate compositor work. Existing components, conditional
bindings and animation provide graphic composition and state variants.

No upstream runtime dependency or additional upstream code was copied. Both
JSON UI Test (two segments) and Local Host now use the shared typography system.
