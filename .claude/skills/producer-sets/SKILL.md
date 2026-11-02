---
name: producer-sets
description: Create and edit Producer broadcast Sets using the Producer MCP compiler, canonical schema, visual checks and portable integration contracts.
---

# Producer Sets

Read `producer_capabilities` first. This is a local authoring catalog, not a connected native-renderer probe. The agent authors the plan; MCP and CLI do not make a second model request.

Use `producer_compile_set` for generation. Compact `producer.design-plan/1` suits flat panels, text, cameras, existing images and its four trusted voice effects. For advanced designs use `producer.design-plan/2`: `{schema,package,assetRefs?}`. `package` is the complete canonical `producer.presentation/2` tree with `set.assets` omitted. Read `producer_schema` sections or `producer://authoring/schema` for exact fields. This route exposes existing 3D, charts, masks, blur, nested components, trusted shaders, animation, bindings, controls, runtime modules and optional Shows. Do not silently simplify unsupported requirements or invent node types, executable shaders or renderer capabilities.

Author explicit `set.views` mappings from one logical view to landscape/portrait/square layout IDs. Preserve shared slot, field and module-role identities. Use distinct compositions per orientation, and `builtin:layout` in the host arrangement instead of separate navigation buttons per orientation. The package allows up to 32 individual layouts; codec and native budgets still apply.

For edits, list/inspect the source and retain its revision. `producer.set-edit/2` accepts up to 64 atomic RFC 6902 add/replace/remove operations using RFC 6901 pointers. Nested geometry, field defaults, bindings, effects, modules, views and Shows can be edited; asset/prototype replacement is rejected. Change a bound text's declared field instead of replacing its binding. Legacy `producer.set-edit/1` remains available for direct-child moves, literal text, camera replacement and layout duplication. On a revision conflict inspect again. Originals remain intact.

The MCP reads regular `.set.json` files only in its configured directory. Existing asset IDs are authorized through `assetsFrom`; asset bytes stay local and never belong in model input. Use `producer_requirements` to inspect portable integration contracts. Weather/agent modules imply requirements; explicit `integrations` can declare versioned capabilities, input/output contracts, delivery and adapter constraints. Set definitions carry roles, never saved connection IDs or credentials. Missing adapters or connections do not invalidate an otherwise valid import. Recipients configure their own connection in Set edit. Declaring an adapter does not install or execute provider code; webhook/stream transports still need a trusted implementation.

Run `producer_visual_check` and review every requested layout using `producer_preview_set`. Text is measured with the actual browser renderer; lowering also reports estimated native graph/graphics budgets at 1080p. These estimates do not test media decoding, driver behavior, native readiness or combined retained resources. Browser cameras are placeholders and microphone effects are simulated. Do not imply that a preview activated a microphone.

For a voice ring around a circular host, use the same center and radius as the camera, at least 90px wave padding, and draw the ring before the camera. `producer_repair_ring` performs an explicit revision-fenced repair without moving the camera; insufficient space produces a diagnostic. Review editorial overlaps rather than removing intentional layering automatically.

Give the new Set and preview paths, plus unresolved findings. Authoring tools do not load room preparation, take output, activate devices, record, stream or deploy. Use a separately authorized native workflow for those actions.

When MCP is unavailable, `node scripts/generate-set.mjs` exposes the same compiler through `capabilities`, `schema`, `compile`, `edit`, `requirements`, `check` and `preview`. Inputs are bounded; outputs are new files. Read its usage rather than constructing an unvalidated alternative generator.
