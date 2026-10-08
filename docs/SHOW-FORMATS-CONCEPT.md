# Reusable interactive show formats

Saved October 3, 2026 from the host's handwritten concept and discussion. This is a product and architecture proposal, not a description of shipped functionality.

## Experience

A host imports a show package into a Producer room. Show mode gives the host controls and a presentation tailored to the format. Timed segments can be advanced or paused; sponsored drops need an explicit schedule policy. Audience interactions affect the show's graphics and interface. The finished program is the main output, with production controls available in docks or a dedicated host interface.

Examples include **Just Facts**, where two participants debate, a moderator checks facts with AI assistance, and winners progress according to declared criteria; and **Brand Boomin**, where the host awards guest points, potentially using audience votes. AI feedback supports moderation and does not guarantee factual correctness.

Selected audience members can interact onstage, including head-to-head rounds. A guest who also uses Producer could receive the finished program and distribute it to their own networks.

## Model

- **Show package:** An importable, versioned definition of the brief, segments, layouts, assets, timing policy, and scoring rules. Room overrides are explicit.
- **Room:** A persistent, brand-owned venue with a stable public address, independent of its current title or show run.
- **Show run:** A session with its own identity, segment progression, votes, scores, participant history, and results. Successive runs do not inherit an episode's interactions accidentally.
- **Room/show controller:** The existing backend and Durable Objects coordinate admission, moderator permissions, current segment, clock, stage state, reconnects, and authoritative scoring actions.
- **Presentation:** Producer renders the finished show on the host's hardware; audience clients receive program media and the shared interaction state.
- **Host interface:** Show-specific controls such as start round, pause, award points, reveal results, and advance segment alongside production controls.

## Timing and scoring

Track elapsed show time separately from scheduled wall-clock time. Each sponsored segment declares what happens if a host pauses or runs late. Keep scoring actions and corrections in a recorded history; votes may be an input to scoring rather than the complete score model.

## Media and scaling

Keep composition and encoding on host hardware initially and use external networks for wide distribution. Selectively admit interactive participants instead of connecting every audience member to every other audience member. Preserve a guest's mix-minus conversational audio return and avoid feedback or rebroadcast loops when a guest distributes the finished feed. Larger audience video delivery can later use optional rented or self-hosted infrastructure.

## Branded entrances

Support the same public entry experience at `producer.dev` and `boomin.ai`, with Producer defaulting to `producer.dev` and a Settings selector for `boomin.ai`.

Examples:

- `https://producer.dev/kleveland/audience/just-facts`
- `https://boomin.ai/kleveland/audience/just-facts`
- Guest entry uses the same brand and room namespace while retaining an unguessable code and existing admission/revocation behavior.

The display domain does not change Boomin network membership, backend room identity, or the host's media delivery path. Existing shared links remain supported. Self-hosted endpoints retain their own link generation.

## Implementation boundary

The current room, media, audience interaction, and stage infrastructure is the foundation. Importable show packages, timelines, show-specific host mode, formal scoring, and guest rebroadcasting remain future work. The immediate implementation is the branded domain/link capability.

## UI engine direction — 2026-10-04

Show design must be highly flexible and agent-authored through JSON. Prioritize a
reusable document interpreter supporting HTML/SVG layouts, components, formulas,
live data bindings and animation before building a guided editor. Audience events
can drive heat, failure, scores and reveal effects. Ordinary show documents should
load without a separate compilation/build pipeline.

Nordcraft's open core/runtime contains relevant mechanisms, including JSON
keyframes converted into CSS. Research, verified capabilities, integration limits
and the proposed adapter are recorded in [NORDCRAFT-SHOW-ENGINE-REVIEW.md](NORDCRAFT-SHOW-ENGINE-REVIEW.md).

## Room and show workspace — 2026-10-04

Show opens from the room's top bar. An empty room offers import/selection; a loaded
show offers preview and source assignments before Start show creates an episode.
Show mode can fill the Producer workspace with the JSON-defined host interface.
Existing draggable production docks remain accessible through Studio/tools.

The show document defines coordinated program and host-control views, sharing
components and state. The program view enters the native compositor and recording;
the host view provides interactive controls. Producer owns a persistent Stop show
control independently of the imported design. Stop show ends the episode, finalizes
its automatic recording and returns to the room workspace. Opening Studio tools
during an episode does not itself end the episode.

Show runs should automatically record to the host's local device by default, with
the preference visible in show settings. Track whether the show started a recording
or reused an existing one; ending a show must not inadvertently stop a pre-existing
manual recording. Surface recording failures explicitly. This is proposed behavior,
not an implemented feature.

## Output formats

Portrait/vertical (for example 9:16), landscape (16:9), or both are show-package
capabilities. A show keeps one episode state, clock, participant roster, score and
vote history. Its program layouts adapt or explicitly differ per aspect ratio;
agents design these variants and preview them independently. Cropping a completed
landscape program is insufficient as the default portrait experience.

The host selects active output formats before starting. Each active format has
its own composition/layout and destination mapping, reusing source captures and
guest connections. Both formats require additional rendering/encoding work on
host hardware. Produce only active formats and validate simultaneous operation
on the actual engine before advertising it as supported.

The host-control workspace adapts to its window independently of the broadcast
aspect ratio. Audience playback can choose a suitable available output while
sharing the same interactions. Automatic local recording covers active outputs
as separate files associated with one episode. Multi-format output/routing and
recording are proposed features, not confirmed shipped capabilities.
