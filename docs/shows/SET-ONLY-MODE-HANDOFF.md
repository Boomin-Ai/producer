# First-class set-only mode for the Show engine

Product clarification from the user: creators must be able to ask an agent to design a beautiful broadcast set without competition, voting, scoring, contestants, elimination, or timed progression. This is a core use of the engine, not a special competition format with its competitive UI hidden.

This handoff requests changes to the proposed design. It does not claim the engine exists or that implementation has been completed. Read `SHOW-ENGINE-PLAN.md`, `SHOW-ENGINE-PLAN.ts`, and `SHOW-ENGINE-ARCHITECTURE-REVIEW.md` alongside it. Other agents may be updating those files; preserve their work.

## Verified current limitation

The current proposed `ShowManifest` still requires `initialSegment`, `segments`, and a `rules` object containing vote, heat, and elimination policies. `Segment.enter`/`exit` also use competition-specific effects. The layout and renderer primitives can describe a noncompetitive set, but the manifest and lifecycle do not yet support it cleanly.

Do not make creators invent contestants, dummy votes, or a fake idle segment to satisfy the schema. Do not use hidden competition defaults.

## Required product behavior

- Agents author the visual set through the same interpreted JSON, assets, components, bindings, styles, and supported animations. Ordinary sets require no separate build.
- A set can contain one layout or several named layouts: solo, conversation, screen share, performance. One layout is sufficient; switching is optional.
- Source slots represent cameras, guests, or other supported room sources. They have no mandatory contestant or competition meaning.
- A set can run indefinitely until the host stops it. It has no required countdown or automatic progression.
- Custom host/mod controls can select layouts and edit explicitly declared presentation values, such as nameplates. Actions still pass through a trusted adapter and existing authority.
- Producer owns always-accessible Stop, Studio, recording status, and recovery controls. Imported graphics never become the whole-window broadcast capture.
- Existing room chat, votes, and reactions remain available under normal policy, but the set neither requires nor creates them. Guest interaction rights, identity continuity, consent, and moderation remain intact.
- Selecting a layout changes composition only. Hiding a video slot must not silently demote/disconnect a guest, change microphone consent, or change public audio admission.
- Retain host-side composition, encoding, and local recording; manual-recording ownership and external-stream preservation rules still apply.
- Native iOS audience UI remains native. Use existing infrastructure and no additional Cloudflare products.

## Contract direction

Use a discriminated union to keep required fields meaningful. The example below refers to the current proposed types; adapt it into the single schema-generating source rather than maintaining a second independent definition.

```ts
type PresentationBase = Omit<ShowManifest,
  'initialSegment' | 'segments' | 'rules' | 'participantInteractions'>;

type SetManifest = PresentationBase & {
  mode: 'set';
  initialLayouts: Partial<Record<Aspect, string>>;
  initialSegment?: never;
  segments?: never;
  rules?: never;
  participantInteractions?: never;
};

type ProgramManifest = PresentationBase & {
  mode: 'program';
  initialSegment: ShowManifest['initialSegment'];
  segments: ShowManifest['segments'];
  rules: ShowManifest['rules'];
  participantInteractions: ShowManifest['participantInteractions'];
};

type PresentationManifest = SetManifest | ProgramManifest;

type SelectLayoutAction = {
  kind: 'layout.select';
  aspect: Aspect;
  layoutId: string;
};
```

For every supported aspect, require a valid initial layout matching that aspect. Validate source bindings and native capabilities exactly as for a program. Unavailable portrait/Both capabilities must fail preflight explicitly.

Extend the registered action validators and grants to support `layout.select`. Allow it only on authorized control surfaces. Output surfaces remain read-only. Route layout changes through the same command arbitration, fencing, revision checks, and native/render receipt machinery; do not introduce another scene controller. A set does not get competition actions such as `result.resolve` or `score.award`.

Separate common run lifecycle from program progression. Both modes retain start/stop, recording, lease/recovery, pinned assets/runtime, and source ownership. Set state carries active layout IDs and their applied revisions; it does not need a segment ID, vote state, score state, or winner state. Do not fabricate those values to satisfy `EpisodeSnapshot`.

Set animations can use cosmetic-local time or the common run clock. Reject `segment-entry`/`reveal-event` anchors in set mode unless a future explicit event contract provides them. Define transition animation anchors separately when layout transitions are supported. Fixed native source geometry remains the initial capability; CSS animations must not imply animated native cameras.

The program branch above preserves the current Head to Head proposal. It is not a decision that all future programs must be competitive. Future timeline and competition modules can be separated without burdening set mode.

Choose an explicit schema migration/version strategy. Either update the Head to Head fixture with `mode: 'program'`, or normalize the existing proposal through a tested compatibility adapter. Do not silently reinterpret manifests.

## First noncompetitive fixture

Create `after-hours.set.json`: charcoal background, violet accents, warm amber details, subtle depth, minimal nameplates, and a small illuminated Boomin mark. Include:

1. Solo layout with one prominent source frame.
2. Conversation layout with host and guest frames.
3. A host control that selects between those layouts.
4. A restrained decorative animation.

No countdown, tally, winner reveal, reaction requirement, elimination, or auto-advance. Keep the JSON rendering model general rather than hard-coding this set. Screen-share and performance layouts may follow; they are not prerequisites for proving set-only support. The visual concept is a suggested fixture, not an additional settled user requirement.

## Acceptance criteria

- A set containing one layout validates with no competition fields, participant interactions, or segments.
- Missing/invalid initial layouts, competition actions, and unsupported animation anchors reject with actionable path diagnostics.
- Import, preview, start, and Stop work without creating an interaction or progression alarm. Reconnect restores the same set and active layout without restarting a program.
- Authorized layout selection produces confirmed native geometry and matching graphics. Denied actions and stale effects cannot mutate the output.
- Layout switching preserves guest connection, canonical interaction identity, grants, operator mute, and consent; it does not implicitly change stage/audio admission.
- A real recording contains the intended native sources and graphics, with no host/mod controls. Renderer isolation and measured composition gates from the architecture review still apply.
- Stop remains usable if the imported surface hangs. It finalizes only an owned recording and preserves manual recording and external streams.
- The existing Head to Head fixture remains valid under the chosen migration and retains its competition behavior.
- P0 can prove the set using mocked authority and source patterns. Live recording ownership, recovery, and participation gates remain mandatory before shipping those integrations.

Deliver the contract update, set fixture, validation coverage, and revised phase plan together. Avoid expanding this request into a new competition format, a second runtime, or unverified portrait/Both support.
