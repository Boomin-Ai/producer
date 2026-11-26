# Studio design

## What people design

A **studio** is the saved place a host operates. Its **desk** is the arrangement and appearance of controls around the monitor. Its **set** is the composition viewers see. A person designing an Orbital Desk should be able to ship the desk and its matching Atmosphere set together and a host should be able to use either independently.

The three references share one desk composition. Reading from left to right gives people and sound, the program monitor, then set direction. The bottom dock holds work that can continue during a show. An emerald line, pink glow, or sunset backdrop changes the character while the operator’s muscle memory carries across all three.

## Audit of the current native studio

Workspace already persists the edge, order, visibility and relative size of twelve panel types plus each dock’s size and collapsed state. Rune chooses between full panels and strips. Publish and Assistant have special layouts. Several features own headers, scrolling and styling within their content, while the dock also creates headings. Panel identity currently doubles as instance identity, which means a designer cannot independently place two views of Publish. Set artwork and the studio chrome resolve their appearance through different paths.

| Surface | Preserve | Design rule |
| --- | --- | --- |
| Title bar, activity and status bar | Fast access to studio actions and operation feedback | Give each menu an anchor, dismissal, focus return and accessible name. Put actionable errors next to the failed operation. Keep recording and live states legible in every theme. |
| Monitor and quick controls | Independent landscape and portrait previews and explicit program commands | Reserve a minimum monitor area. Use a labeled signal state and preserve aspect ratios. Desk styling edits stay off the audience output. |
| Sources | Direct access from a source chip to its own native-feeling inspector | Resolve the inspector from the source ID and capabilities. Keep identity, device, adjustments and removal in predictable places. Scroll the inspector body within window bounds. |
| Scenes | Fast switching | Give selection, prepared and on-output distinct labels. Scene selection and desk design are separate commands. |
| Set Controls | Layout readiness, missing-source repair and one-step switching | Make layout names and missing source names come from the template. Show “Focus Sam” and “Focus Shaan” as ordinary layouts. |
| People | Guest invitation, waiting and admission | Give the empty slot an action, prioritize pending guests, and place orientation and hosting under settings. |
| Mixer | Per-input level, gain and mute | Use semantic meter and clip colors; retain the numeric value and mute state in compact views. |
| Sound | Fast access to frequently used pads | Treat a pad bank as a reusable view with named actions and short labels. |
| DJ | Transport, seek, track title and gain | Give the horizontal strip a purpose-built layout; keep transport and scrubbing operable. |
| Network | Connections, search, requests and studios | Use a compact switch with an accessible label per icon and a single content region below it. |
| Timeline | Scrubbing, preview and program handoff | Honor horizontal dock capability and show the signal being viewed. Closing the panel should also resolve its monitor mode. |
| Clips | Local capture and queue | Keep local media distinct from scheduled publishing. Local capture status belongs with Clips. |
| Publish | Composer, account destinations, local drafts, scheduled and published views | Model summary and post list as views of one publishing service. They can share one panel today and become separately placed views in a template. |
| Assistant | Turn history, cards, model calls and logs | Keep the current turn visible; disclose diagnostics inside the panel. Generate proposed edits against the same model the designer uses. |
| Set editor, library and account shell | Browse, preview and apply have different consequences | Keep draft, installed and on-output explicit. Scope an account or source inspector to its owner; show the name in the accessible title. |

## What an agent can inspect today

The Studio Assistant’s `inspect_authoring` tool accepts `section: "panels"`. Without an ID it lists the registered keys. With an ID such as `guests` it returns the display label (People), current dock, visibility, layout weight, allowed edges, and the dock’s collapsed and hidden state. Stable IDs come from the native registry, so changing a display label preserves an agent’s target.

For example, this existing command places People immediately before Sound in the left dock. The assistant validates it against a copy of the current workspace and presents it for host review.

```json
{"op":"workspace","command":{"action":"place","panel":"guests","edge":"left","before":"sound"}}
```

The `cameraGrades` section exposes stored overrides by source ID. A missing override means neutral processing. This command adjusts the second camera by a quarter stop. The host reviews it as a source change that affects output.

```json
{"op":"cameraGrade","source":"camera-2","grade":{"exposure":25,"contrast":0,"saturation":0,"warmth":0}}
```

## Vocabulary for a versioned desk format

| Term | Example | Owns |
| --- | --- | --- |
| Theme | Orbital / Emerald | Named colors for surfaces, text, borders, actions and focus; type, spacing, radii and allowed materials. Semantic live, recording, missing and error states have independent roles. |
| Dock | Left or bottom | Placement, ordering, minimum size and space allocation. |
| Panel type | People or Publish | Behavior, supported commands, available views, valid dock edges and compact behavior. |
| Panel instance | publish-history | Stable identity, dock position, selected view and presentation overrides. |
| Panel frame | Standard, compact or hidden header | Surface, header, content, optional footer, scrolling and focus outline. A hidden header retains a name and a drag handle in Design mode. |
| View | Publish history or DJ transport | A particular projection of feature state. Instances subscribe to the same service. |
| Inspector | Camera settings anchored to Sam’s source | Contextual configuration for a target. It follows that target, survives resizing, and dismisses if the source disappears. |
| Studio template | Orbital Desk with Atmosphere | Versioned desk, theme, optional set, preview image, requirements and editable defaults. |

The proposed frame resolves **default theme → studio theme → panel override → interaction state**. For coordinated looks, let a template explicitly map a desk accent to an editable set field in its draft. Preview the two together and use the existing output handoff to put the set on air. This lets the globe, weather cards and studio trim share a palette without a desk preference recoloring a live broadcast. Reserve overrides for genuine exceptions. Apply materials to shared surfaces, bound blur coverage, and cache stable surfaces. Verify text contrast over the brightest permitted backdrop. A header toggle should never remove keyboard access to the panel’s commands.

## Camera inspector

Group controls into **Device**, **Lighting & color**, and **System effects**. Hardware focus, exposure mode, white balance and frame rate depend on the input device. Software exposure, contrast, saturation and warmth attach to a camera’s stable source ID. They should survive restarting the studio and switching layouts and should affect the same camera in every program orientation. An adjustment to Sam’s camera must leave Shaan’s picture, titles, artwork and screen share alone. Reset returns to neutral. Expose precise units and ranges to agents. A later advanced section can add tint, shadows, highlights and a before/after comparison once those controls have working processing and pixel tests.

## Shared frame in Native Dev

Every dock panel uses the Rune panel frame for its outer bounds and surface. All twelve panels use its pinned heading. Panel actions remain available in Hidden mode. In Edit dock layout (⌘E), open a panel’s ⋯ menu to choose Standard, Compact or Hidden. In Hidden mode, People settings and Close Timeline remain available. Collapsed docks retain their feature-specific strips.

Choose Edit (⌘E) → Desk theme in the top bar to switch between Classic and Orbital Green. This saves `workspace.theme` per studio. Agents can apply `{"op":"workspace","command":{"action":"setTheme","theme":"orbitalGreen"}}`. Desk paint is resolved only in the operator view.

The header command is `{"op":"workspace","command":{"action":"setHeader","panel":"guests","mode":"compact"}}`. Inspect a panel’s `headerMode` and `headerModes` before proposing a change. Older workspaces default to Standard.

## Default design experience and delivery order

1. **Shared frame and theme.** Move panel background, heading, scroll body, overflow and resize affordance into a Rune component. Migrate People, Sound and Network first, followed by the other nine panel types. Map legacy workspaces to current appearance. Keep Classic as the new-install default. Verify each panel in a side dock, a horizontal dock when supported, and collapsed.
2. **Design mode.** Start from the current desk. Click a panel to inspect its view, header, surface, dock and size. Change the room accent once and see the desk update. Offer preview, undo, reset and Save as template. In a narrow window, collapse lower-priority views before shrinking the monitor below its minimum.
3. **Agent-readable authoring.** Extend the panel registry with supported views, header modes, minimum sizes, required capabilities and writable properties. Generate UI controls and input schemas from those descriptors. Agents inspect a stable ID, propose a typed patch against a revision, validate it, render a preview, then apply the accepted change. Return field-specific validation errors, including available alternatives. Preserve the distinction between arranging a desk and sending something to program.
4. **Showcase and clone.** Render a thumbnail from a clean preview studio. Include the desk manifest, theme, set references and portable artwork in a versioned bundle. Include placeholders for local cameras and account integrations. Exclude tokens, device IDs, guest links, private clips and queue history. A recipient previews the desk, clones it, then maps their devices. Test on a clean installation.

A first end-to-end design milestone is one Orbital template with three theme variants. Acceptance means switching variants preserves panel geometry and device routing, hiding a header keeps its panel accessible, live resizing keeps the monitor usable, and cloning the desk produces the same layout with fresh source setup actions.
