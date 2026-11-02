# Producer Set authoring MCP and CLI

Local, deterministic authoring for Claude Code, Codex and other MCP clients. The
agent supplies a design or an edit; Producer compiles and validates a new Set.
There is no second model request, provider credential or native app requirement.

## Contracts

Capability catalog revision **2** supports two profiles through the same tools:

| Profile | Input | Coverage |
| --- | --- | --- |
| Compact | `producer.design-plan/1` | Flat panels, text, source slots, authorized images and four voice-effect recipes |
| Canonical | `producer.design-plan/2` | Every field accepted by the canonical Set codec: nested components, all 19 trusted shader presets/parameters, managed 3D worlds, charts, masks, blur, bindings, animations, controls, modules, paired views and optional Shows |

Canonical plans use `{schema, package, assetRefs?}`. `package` is a complete
`producer.presentation/2` document **without `set.assets`**. `assetRefs` lists IDs
from an explicitly authorized `assetsFrom` Set. Media bytes never enter model
context. Canonical schemas are generated from the actual import codec, avoiding a
second advanced-feature grammar. Unsupported fields are rejected, not dropped.
This does not add arbitrary JavaScript, HTML, shader code, network endpoints or
Blender geometry to the renderer.

Both profiles accept up to **32 individual layouts**. Author explicit `set.views`
pairs and shared field/slot IDs; use `builtin:layout` for host navigation. Compact
elements remain bounded at 64 per layout. Canonical node/world/resource limits
remain those of the package codec and native renderer. A larger inventory does
not override GPU budgets.

`producer.set-edit/2` provides up to 64 atomic RFC 6902 `add`, `replace`, and
`remove` operations with RFC 6901 pointers and an exact `baseRevision`. It supports
nested geometry, editable field defaults, bindings, modules and Show changes.
Assets and prototype keys cannot be patched. Final validation rejects dangling
references or invalid intermediate combinations before saving anything. Legacy
`producer.set-edit/1` remains supported for direct-child moves, literal text,
camera replacement and layout duplication. Source files are never overwritten.

## Portable integrations

A Set may declare `integrations: {schema:"producer.integrations/1", requirements:[]}`.
Requirements describe `role`, `label`, versioned `capability`, `input`, `output`,
`delivery`, optional `transport`/`refresh`, optionality and optional exact adapter
identity/version/operation. Existing weather/agent modules imply requirements, so
older packages need no migration. Prefer inferred requirements for built-in weather/agent modules. Explicit integration metadata requires the updated importer. Conflicting roles/contracts are rejected.

A weather Set carries its design, module behavior and `data.weather@1` contract.
It does not carry the author's saved connection ID, endpoint or API key. Import
and download remain valid when the recipient has no matching adapter or account.
Set edit lists the missing requirement and lets the recipient add a weather or
agent connection and select it. Unregistered adapters leave the authored design
and defaults available; unavailable data is not presented as a live measurement.
A configured connection is distinguished from a successfully tested connection.
Stale connection revisions require reselection. Account secrets remain in the
existing workspace connection store, outside exported Set JSON.

Adapter compatibility checks use registered capability, input/output versions,
delivery, transport, refresh and optional adapter pins. The existing trusted
registry describes weather polling and agent requests; its contracts also admit
webhook and streaming transports. **A declaration does not implement or install
an adapter.** New transports/providers still need trusted execution code and
runtime binding support. Imported Sets cannot install executable connectors.

## Setup

Requires Node 22+ and installed repository dependencies:

```sh
npm ci
npm ci --prefix tools/producer-mcp
```

The repository `.mcp.json` registers the local server for Claude Code. The skill
is `.claude/skills/producer-sets/SKILL.md`. For Codex:

```sh
codex mcp add producer-sets -- node /absolute/producer/tools/producer-mcp/server.mjs
```

Use the same skill in `~/.codex/skills/producer-sets`. Restart the MCP connection
after updating the server. The default artifact directory is
`~/Documents/Producer Sets`, configurable with `PRODUCER_SETS_DIR`. The server
reads regular `.set.json` files directly inside that directory; outside paths and
symlinks are rejected. Outputs use unique filenames and preserve originals.

## Tools

| Tool | Purpose |
| --- | --- |
| `producer_capabilities` | Current profiles, limits, target and instructions |
| `producer_schema` | Exact package schema or focused node/runtime/integrations/animation section |
| `producer_list_sets` | Discover authorized source files |
| `producer_inspect_set` | Asset-free tree and exact revision |
| `producer_compile_set` | Compile either design profile, retaining authorized assets |
| `producer_edit_set` | Apply either revision-fenced edit profile to a new draft |
| `producer_requirements` | Discover portable integration and visual requirements |
| `producer_validate_set` | Canonical structural validation |
| `producer_check_geometry` | Ring alignment and advisory overlap checks |
| `producer_visual_check` | Actual-browser text fit and estimated native batching budgets |
| `producer_repair_ring` | Explicit, revision-fenced ring repair preserving the camera |
| `producer_preview_set` | Standalone HTML using Producer's Set renderer |

Resources `producer://authoring/guide` and `producer://authoring/schema` expose the
contract and full generated schema. Use focused discovery when possible rather
than repeatedly supplying the full schema for a small edit.

## CLI

The CLI calls exactly the same compiler and validators:

```sh
npm run generate:set -- capabilities
npm run generate:set -- schema
npm run generate:set -- compile --plan design.json --assets-from source.set.json --out draft.set.json
npm run generate:set -- edit --base draft.set.json --edit changes.json --out revised.set.json
npm run generate:set -- requirements --file revised.set.json
npm run generate:set -- check --file revised.set.json
npm run generate:set -- preview --file revised.set.json --out preview.html
```

The caller authors the plan; the CLI does not call a model. Design/edit input is
bounded at 1 MiB and Set input at 40 MiB. Output files must be new. `check` needs
an installed Chromium; on macOS the default is Google Chrome. Configure
`PRODUCER_BROWSER_PATH` elsewhere. No browser is downloaded during a tool call.

## Verification boundaries

Visual review measures configured text with the real browser renderer and lowers
each layout at 1080p to estimate native nodes, graphics batches and raster pixels,
including retained morph targets. It warns before likely 128-node, 16-surface or
8-Mi-pixel graphics-limit failures. Estimates mirror current batching logic and
are not GPU allocation, media decoding, driver, first-frame, peak retained-store
or hardware certification. Review estimates alongside actual native preparation.
Future feed values and all animation states are not covered by default snapshots.
Browser cameras are placeholders; microphone response is simulated.

These tools do not load room preparation, take output, activate devices, record,
stream or deploy. Structural validity, browser visual review and native readiness
are separate results. The app defaults to the full compiler; update app/workspace capability catalog revision 2 together. Saved-Claude design authoring uses these same profiles with
explicit saved token budgets (256–32,768, model permitting), one request per click,
and no automatic retry. Existing budgets/defaults are unchanged. A complex request
can still truncate; revision-fenced incremental edits avoid regenerating assets
or an entire Set for each adjustment.

```sh
npm run test:authoring-full
node scripts/test-authoring-cli.mjs
npm run test:mcp
PRODUCER_PLAYWRIGHT_MODULE=/absolute/path/playwright-core/index.mjs node scripts/test-set-integration-portability-browser.mjs
```

Tests include full-schema round trips of real launch, weather, visual-effects and
managed-3D packages and a Show; nested atomic edits and capability failures; the actual MCP
stdio transport; recipient connection creation/binding; and immutable CLI output.
These establish compiler/transport/setup behavior, not a statistical natural-
language generation success rate. Paid model acceptance remains opt-in through
`scripts/test-design-generation-live.mjs --live` with an existing saved connection.

Fresh agent-authored acceptance scenarios are reproducible through real MCP:

```sh
node tools/producer-mcp/prompt-acceptance.mjs
node tools/producer-mcp/review-acceptance.mjs
```

The first command writes new CTA, portable-weather and reactive-3D Sets plus
previews; it never takes room output. `--scenario prompt-five-offers` (or
`prompt-weather` / `prompt-reactive-studio`) refreshes one scenario in an existing
report. The review command captures all 14 previews and requires ready 3D canvases.
Both write local evidence under `target/prompt-acceptance/`. Native tests remain
separate: `scripts/test-authoring-native.mjs --package /path/to/new.set.json`,
with `--reactive` for voice effects, uses synthetic sources without recording.
`PRODUCER_PORTABILITY_PACKAGE=/path/to/weather.set.json` points the recipient
integration browser test at a newly generated package. See
[the acceptance report](../../docs/set-runtime/PROMPT-ACCEPTANCE.md) for outcomes
and the distinction between browser, native and physical-device coverage.

## Compute Atlas example

`node tools/producer-mcp/compute-atlas.mjs --discover` discovers the live contract.
Running it without flags compiles the canonical plan in
`fixtures/compute-atlas.mjs` through the actual MCP transport, then requests a
preview, requirements and visual checks. `--edit` performs revision-fenced layout
and field-default edits of its last generated copy; `--review` rechecks that copy. Evidence is written to
`target/compute-atlas/`. The compiler resolves authorized assets from the local
`Atlantium-Atlanta-Capacity-35-Second-Cut.set.json` package; no personal images
or embedded asset bytes are committed. The runner never takes room output.

The example has six paired chapters, a shared managed 3D server studio,
interactive charts and operator cards, a microphone-reactive portrait surround,
an optional Host slot, source visibility and editable headlines/CTA copy.
Its suggested 35-second pacing uses manual layout cues. The default embedded
photo works without a connected camera or API adapter.

Market figures are a **H1 2026 snapshot**, not a live GPU inventory. The four
markets are the largest by existing inventory within CBRE's eight primary
markets. Construction is rounded to approximately 2.9 GW. Capacity, availability
and actual electricity consumption are distinct. Sources:
[CBRE inventory table](https://www.cbre.com/press-releases/north-american-data-center-demand-continues-to-outpace-supply-despite-record-construction-activity),
[Atlanta market chapter](https://www.cbre.com/insights/books/north-america-data-center-trends-h1-2026/atlanta-data-center-market),
[Edged Atlanta](https://edged.us/atlanta),
[QTS Atlanta 1](https://q.com/data-centers/atlanta-1/),
[DataBank Atlanta](https://www.databank.com/data-centers/atlanta/).
Operator details also use the user's October 28 Atlantium entity register.
Mixed-stage campus figures are never summed into metro inventory or used to
infer chip counts, GPU models or inference availability. No recipient-owned
credentials or live connection are required or included.

The November 2, 2026 dev acceptance passed all 12 browser previews, seven
browser control variations, all 12 native layouts, six paired chapter switches
(and return to the opener), and 17 paired native interaction checks. The native
Host slot used a persisted image source; physical microphone/camera activation,
recording, streaming and production deployment were not part of that check.
Local receipts are `target/compute-atlas/browser-proof.json` and
`target/compute-atlas/native-proof.json`.

`node tools/producer-mcp/compute-atlas.mjs --art --edit` makes a new motion/art
direction revision from `fixtures/compute-atlas-motion.mjs`. It preserves the
paired chapter identities, editable copy, source slot and data controls. The
chapter treatments use a map-led opener, cream comparison, dedicated 3D
construction shot, oversized availability metric, operator dossier and mint CTA.
Segment-clock wipe masks, staggered entrances and a chapter pacing meter supply
motion; switching chapters remains manual. Output and evidence are isolated in
`target/compute-atlas-motion/`. This revision passed all 12 browser layouts,
seven browser control variations, all 12 native layouts and 17 paired native
interaction checks. No native renderer change or rebuild was required.

## Design references

### AI Engineering Essentials shell

`node tools/producer-mcp/ai-engineering-essentials.mjs` compiles a new reusable
Atlantium-branded episode shell through MCP. `--edit` creates a revision-fenced
layout/default update of its previous output. Six logical chapters each pair
landscape and portrait: tool spotlight, before/after, input-to-output workflow,
demo, quick start and takeaway/CTA. Episode copy is exposed in the host controls.
The demo has an animated placeholder and an optional source slot for a screen,
image or video; it is a stage for future tool-specific animations, not an
automatically generated tool demonstration. The embedded headshot is the
default and both source slots are optional until selected. No provider account
or physical device is required to display the shell.

Canonical authored input lives in `fixtures/ai-engineering-essentials.mjs`.
The authorized source assets remain outside Git. Receipts and previews live in
`target/ai-engineering-essentials/`: all 12 browser/native layouts passed, four
browser content variations passed, and the native logical chapters switched in
both orientations. Native source verification covered the bound headshot; an
external demo stream and physical camera/microphone were not activated.

[Remotion parameterized rendering](https://www.remotion.dev/docs/parameterized-rendering)
informs schema-driven inputs and editable controls.
[Node-RED credentials](https://nodered.org/docs/creating-nodes/credentials) and
[configuration nodes](https://nodered.org/docs/creating-nodes/config-nodes) inform
separating reusable definitions from recipient-owned connections and secrets.
[OBS scene collections](https://obsproject.com/kb/scene-collections) provide a
reference for portable collections with separately configured dependencies.
[Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
are a provider-side reliability option; the complete recursive Producer schema
is not blindly passed as strict output configuration. Provider schema support and
semantic validation must both be established before claiming strict conformance.

The MCP acceptance test also repairs six nested temperature text boxes in a new
weather draft and rechecks all six layouts. The source fixture stays unchanged;
its editorial-overlap findings remain advisory.
