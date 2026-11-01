---
name: producer-sets
description: Create and edit Producer broadcast Sets from prompts, including landscape and portrait layouts, camera slots, editable text and microphone-reactive effects, using the Producer MCP compiler and preview tools.
---

# Producer Sets

Use the `producer-sets` MCP tools to turn design intent into a validated Set artifact and a browser preview. Claude authors the compact plan itself; no second provider call or API key is needed.

Read `producer_capabilities` first. Its instructions define the current plan and edit formats; do not invent node types or infer installed app capabilities from this compiler catalog. The full canonical Set schema supports more than the compact compiler. If the requested feature is absent from the compact profile, explain that limit rather than quietly replacing it with a simpler design. For advanced full-tree authoring, read `producer://authoring/schema` only when needed, write a new `.set.json` in the configured directory using available file tools, and run `producer_validate_set`. The canonical schema is generated from Producer's codec; native feature support still needs verification.

For a new Set, call `producer_compile_set` with a `producer.design-plan/1` document. Use distinct landscape and portrait compositions when requested. Bounds use 1920×1080 and 1080×1920 respectively. Keep text large enough to read and give each line enough room. Reuse camera slot and editable field IDs across layouts. Effects react to the existing mic bus in native output; the browser preview simulates audio. Never imply that a preview has activated a microphone.

For an existing Set, use `producer_list_sets` and `producer_inspect_set`. Preserve its stable IDs and asset references. Submit `producer.set-edit/1` through `producer_edit_set` with the returned revision. The original stays intact and edits produce a new file. If the revision changed, inspect again and reconsider the edit; do not reuse stale edits. A layout variant should duplicate the layout before modifying it. Nested geometry and bound-text edits are not supported by this edit profile.

The server can read only `.set.json` files in its configured directory. Assets remain in those files; inspection returns identities without media bytes. `assetsFrom` authorizes use of asset IDs from another Set in that directory. Do not paste base64 assets into the model context or request provider keys.

Run `producer_preview_set` for the completed artifact, open the returned HTML using the client's available file/browser tools, and inspect every requested layout for fit, hierarchy and clipping. This uses Producer's browser renderer, with placeholder cameras and simulated effects. Report anything that needs a native check, including microphone response, source bindings, GPU effects and local media references. Structural validation and browser preview are not native output acceptance.

Give the user the new `.set.json` and preview paths. They can import the Set into Producer, bind sources and rehearse. This MCP version does not load a room's preparation, select output, record, stream or deploy. Do not claim those actions occurred. If the user asks to put it on output, use a separately available authorized native control workflow.
