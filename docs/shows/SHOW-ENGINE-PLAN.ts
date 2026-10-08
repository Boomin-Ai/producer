/**
 * REVIEW ARTIFACT — 2026-10-04. Proposed contracts, not a shipped implementation.
 * Read alongside SHOW-ENGINE-PLAN.md. No dependencies or executable room effects.
 * All API names below are proposals unless explicitly identified as existing.
 * Product composition/UI refinements live in PRESENTATION-ENGINE-FOUNDATION.md;
 * older set/program manifest examples below await conversion, not schema freeze.
 * Extended player/private-evaluation/linked-room contracts are re-exported below.
 */
export * from './PARTICIPATION-CONTRACTS';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Aspect = 'landscape' | 'portrait';
export type Surface = 'host' | 'moderator' | 'output-background' | 'output-foreground';
export type ParticipantId = string;
export type SourceId = string;

// Interpreter inputs are JSON, never JavaScript source. A registry controls functions.
export type Expr =
  | { op: 'literal'; value: Json }
  | { op: 'get'; path: string[] }
  | { op: 'if'; condition: Expr; then: Expr; else: Expr }
  | { op: 'call'; fn: 'eq' | 'not' | 'and' | 'or' | 'add' | 'subtract' | 'multiply' |
      'divide' | 'min' | 'max' | 'clamp' | 'formatClock' | 'formatPercent' | 'concat'; args: Expr[] };
// `op` is reserved at a binding's root. Escape literal objects containing it
// through Expr.literal; literal arrays/objects are data, never recursively executed.
export type Bound = null | boolean | number | string | Json[] |
  (Record<string, Json> & { op?: never }) | Expr;
export interface Animation {
  id: string;
  durationMs: number;
  iterations: number | 'infinite';
  easing: string;
  keyframes: { offset: number; styles: Record<string, Json> }[];
  playWhen?: Expr;
  clock: 'cosmetic-local' | 'episode';
  anchor?: 'episode-start' | 'segment-entry' | 'reveal-event';
  fill?: 'none' | 'forwards' | 'backwards' | 'both';
  // Episode animations seek to authoritative elapsed time; pause freezes them.
}
export interface UINode {
  id: string;
  kind: 'element' | 'text' | 'component';
  tag?: string; // Validated HTML/SVG allowlist; no script, iframe, webview, object.
  component?: string;
  text?: Bound;
  props?: Record<string, Bound>;
  attributes?: Record<string, Bound>;
  styles?: Record<string, Bound>;
  variants?: { when: Expr; styles: Record<string, Bound> }[];
  when?: Expr;
  repeat?: { items: Expr; itemName: string; key: Expr };
  children?: UINode[];
  animations?: Animation[];
  events?: Partial<Record<'click' | 'change' | 'submit', DeclarativeControlEvent>>;
}
export type OutputNode = Omit<UINode, 'events' | 'children'> & {
  events?: never; children?: OutputNode[];
};
export interface ComponentDefinition {
  props: Record<string, { type: 'string' | 'number' | 'boolean' | 'json'; required: boolean; default?: Json }>;
  root: UINode;
}
export interface Asset {
  id: string;
  path: string; // Relative package path, never a privileged filesystem/network URL.
  sha256: string;
  mediaType: string;
  bytes: number;
}
export interface Rect {
  x: number; y: number; width: number; height: number; // Normalized to output canvas.
}
export interface SlotPlacement {
  slotId: string;
  rect: Rect;
  fit: 'contain' | 'cover'; // Cover requires verified native crop math.
  z: number;
  visible: boolean | Expr;
  // MVP: rectangular native video, fixed geometry per segment, no CSS slot animation.
}
export interface Layout {
  id: string;
  aspect: Aspect;
  width: number;
  height: number;
  background: OutputNode;
  foreground: OutputNode;
  slots: SlotPlacement[];
}
export interface Segment {
  id: string;
  title: string;
  durationMs: number | null;
  clock: 'episode-elapsed'; // Sponsored wall-clock policies are deliberately deferred.
  layouts: Partial<Record<Aspect, string>>;
  next: string | null;
  advance: 'host' | 'timer';
  enter: Array<'open-round-vote' | 'reveal-result' | 'backstage-non-winners'>;
  exit: Array<'close-round-vote'>;
}
// Future native adapter; discover support before changing any live configuration.
export interface NativeOutputSpec {
  outputId: string;
  aspect: Aspect;
  width: number;
  height: number;
  fps: number;
  backend: 'main-canvas' | 'private-obs-canvas';
  sharedCaptureSourceIds: SourceId[];
  audio: 'existing-program-bus'; // Do not sum the same microphones a second time.
}
export interface PresentationBase {
  schema: 'producer.show/2'; // Explicit draft migration; /1 is not silently normalized.
  id: string; version: string; engineRange: string; name: string; brief: string;
  assets: Asset[];
  components: Record<string, ComponentDefinition>;
  surfaces: { host: UINode; moderator: UINode };
  layouts: Layout[];
  supportedAspects: Aspect[];
  slots: { id: string; purpose: string; required: boolean; media: 'video' }[];
  presentationValues?: Record<string, {
    type: 'string' | 'number' | 'boolean'; default: string | number | boolean;
    maxLength?: number; min?: number; max?: number;
  }>;
  recording: { default: 'local-auto'; existingManual: 'reuse-with-episode-interval' };
}
export interface CompetitionRules {
  vote: { choices: string[]; oncePerParticipant: true; allowContestantVotes: boolean;
    tie: 'host-decides'; zeroVotes: 'host-decides' };
  heat: { source: 'accepted-reactions'; windowMs: number; maxPerPrincipalPerSecond: number;
    hotAt: number; decay: 'window-expiry' };
  elimination: 'backstage';
}
export interface ParticipantInteractionDefinition {
  id: string; widget: 'choices'; label: string; action: 'vote.submit';
  roles: Array<'audience' | 'guest'>; segmentIds: string[];
  choices?: { id: string; label: string }[];
}
export interface SetManifest extends PresentationBase {
  mode: 'set';
  initialLayouts: Partial<Record<Aspect, string>>; // Every declared aspect requires one.
  initialSegment?: never; segments?: never; rules?: never; participantInteractions?: never;
}
export interface ProgramManifest extends PresentationBase {
  mode: 'program'; // Internal discriminator; user-facing terminology remains Show.
  initialLayouts?: never;
  initialSegment: string;
  segments: Segment[];
  rules?: CompetitionRules; // A future noncompetitive timeline does not need a contest.
  participantInteractions?: ParticipantInteractionDefinition[];
}
export type CompetitiveProgramManifest = ProgramManifest & {
  rules: CompetitionRules; participantInteractions: ParticipantInteractionDefinition[];
};
export type PresentationManifest = SetManifest | ProgramManifest;
export type ShowManifest = PresentationManifest;
export interface ParticipantMediaBinding {
  participantId: ParticipantId;
  interactionPrincipalId: string; // Private authority data; omit from public output.
  videoSourceIds: SourceId[];
  publicAudioSourceIds: SourceId[]; // Includes separate host mic, not just camera.
  mediaGrantRevision: number;
  sourceRevisions: Record<SourceId, number>;
  consent: { camera: boolean; microphone: boolean; screen: boolean };
  publicAudioAdmission: boolean;
  operatorMuted: boolean;
  // Effective public audio = consent && grant && admission && !operatorMuted.
}
export interface SlotBinding {
  slotId: string;
  participantId: ParticipantId;
  videoSourceId: SourceId;
  expectedSourceRevision: number;
  bindingRevision: number;
}
export type EpisodeStatus = 'preparing' | 'starting' | 'running' | 'paused' |
  'recovering' | 'stopping' | 'ended' | 'interrupted' | 'failed';
export interface EpisodeClock {
  elapsedMsAtAnchor: number;
  serverAnchorMs: number;
  running: boolean;
}
export interface SegmentInstance {
  id: string;
  segmentId: string;
  enteredAtEpisodeElapsedMs: number;
}
export type RoundWindow = {
  id: string;
  episodeId: string;
  interactionId: string;
  segmentInstanceId: string;
  revision: number;
  remainingMs: number;
  // Input validity checks authoritative time/status, independently of alarm delivery.
} & (
  | { status: 'accepting'; closesAtServerMs: number }
  | { status: 'paused'; closesAtServerMs: null }
  | { status: 'closed'; closesAtServerMs: number; closedAtServerMs: number }
);
export interface PublisherFence {
  publisherId: string;
  leaseId: string;
  epoch: number;
  leaseExpiresAtServerMs: number;
  abortGeneration: number;
}
export interface CommonRunSnapshot {
  episodeId: string; roomId: string; showId: string; showVersion: string;
  manifestHash: string; rendererBuildHash: string; rendererAbi: string;
  status: EpisodeStatus; revision: number;
  fence: PublisherFence;
  roomExecutionRevision: number; bindingsRevision: number;
  clock: EpisodeClock;
  bindings: SlotBinding[];
  mediaBindings: ParticipantMediaBinding[];
  activeLayouts: Partial<Record<Aspect, { layoutId: string; appliedRevision: number }>>;
  presentationValues: Record<string, string | number | boolean>;
  presentationValuesRevision: number;
  recording: RecordingReceipt | null;
}
export interface SetRunSnapshot extends CommonRunSnapshot {
  mode: 'set';
  transition: { transactionId: string; aspect: Aspect; targetLayoutId: string;
    status: 'applying' | 'failed' } | null;
  // No segments, voting, scores, winners, contestants or competition projections.
}
export interface ProgramRunSnapshot extends CommonRunSnapshot {
  mode: 'program';
  segmentId: string; segmentInstance: SegmentInstance;
  roundWindow: RoundWindow | null;
  decision: { kind: 'tie' | 'zero-votes'; candidateSlotIds: string[] } | null;
  reveal: { eventId: string; atEpisodeElapsedMs: number } | null;
  participants: Record<ParticipantId, {
    competition: 'competing' | 'eliminated' | 'winner' | 'none';
    stage: 'audience' | 'backstage' | 'onstage';
    mediaConnected: boolean; audienceInteractionsAllowed: boolean;
  }>;
  scores?: Record<ParticipantId, number>;
  vote?: { interactionId: string; episodeId: string; status: 'open' | 'closed' | 'revealed';
    tally: Record<string, number>; version: number } | null;
  heat?: { value: number; serverAnchorMs: number; version: number };
  result?: { winnerSlotId: string | null; reason: 'votes' | 'host-tiebreak' | 'host-zero-votes' | null };
  transition: { transactionId: string; targetSegmentId: string; status: 'applying' | 'failed' } | null;
}
export type EpisodeSnapshot = SetRunSnapshot | ProgramRunSnapshot;
export type RecordingReceipt = {
  recordingId: string; outputId: string; recorderGeneration: number; startEffectId: string;
  status: 'recording' | 'finalizing' | 'ready' | 'interrupted' | 'failed';
  mediaTimelineOriginId: string;
  episodeStartMediaPtsMs: number;
  episodeEndMediaPtsMs: number | null;
  durationMs: number | null;
  finalization: { stopEffectId: string; outputStopped: boolean; muxerCompleted: boolean;
    fileVerified: boolean; decodableThroughLastPacket: boolean; errorCode?: string } | null;
} & (
  | { ownership: 'episode'; episodeId: string }
  | { ownership: 'pre-existing-manual'; episodeIntervalId: string }
);
// Private native-host state only. Never serialized in audience/mod/output projections.
export interface OwnedRecorderHandle {
  recordingId: string; episodeId: string; outputId: string;
  recorderGeneration: number; localOwnerToken: string; startEffectId: string;
}
export interface CompareAndStopRecording {
  stopEffectId: string; expected: OwnedRecorderHandle;
}
export type ControlAction =
  | { kind: 'episode.start'; aspect: Aspect; record: boolean }
  | { kind: 'episode.pause' }
  | { kind: 'episode.resume' }
  | { kind: 'episode.stop' }
  | { kind: 'layout.select'; aspect: Aspect; layoutId: string }
  | { kind: 'presentation.update'; key: string; value: string | number | boolean }
  | { kind: 'segment.advance'; segmentId: string }
  | { kind: 'score.award'; participantId: string; delta: number; reason: string }
  | { kind: 'result.resolve'; winnerSlotId: string; reason: string };
export type ParticipantAction =
  | { kind: 'vote.submit'; interactionId: string; choiceId: string }
  | { kind: 'reaction.submit'; reaction: string }
  | { kind: 'hand.raise'; raised: boolean }
  | { kind: 'chat.send'; text: string };
export type ShowAction = ControlAction | ParticipantAction;
// Generic interactions remain future work until registry/schema/version rules exist.
export type ControlPayload<K extends ControlAction['kind']> = {
  [P in keyof Omit<Extract<ControlAction, { kind: K }>, 'kind'>]: Bound
};
export type DeclarativeControlEvent = {
  [K in ControlAction['kind']]: { action: K; payload: ControlPayload<K> }
}[ControlAction['kind']];
export interface CommandEnvelope {
  commandId: string; roomId: string; episodeId: string;
  expectedEpisodeRevision: number;
  action: ControlAction;
  // Server binds authenticated principal + payload hash; conflicting retries fail.
}
export type ParticipantInputEnvelope = {
  requestId: string; roomId: string; episodeId: string;
  // No whole-episode CAS; server resolves principal/policy. Chat can survive vote pause.
} & (
  | { action: Extract<ParticipantAction, { kind: 'vote.submit' }>;
      windowId: string; interactionId: string }
  | { action: Exclude<ParticipantAction, { kind: 'vote.submit' }> }
);
export interface InteractionPrincipal {
  id: string; roomId: string; policyRevision: number;
  allowedActions: ParticipantAction['kind'][];
  deniedActions: ParticipantAction['kind'][];
  revoked: boolean;
}
export interface PromotionExchange {
  exchangeId: string; roomId: string; guestParticipantId: string;
  // Opaque single-use credential; server stores issuer principal, expiry and consumption.
  credential: string; expiresAtServerMs: number;
}
export interface PromotionReceipt {
  exchangeId: string; roomId: string; guestParticipantId: string;
  interactionCapability: string; expiresAtServerMs: number;
  // Credential resolves to issuer's existing principal. Do not return/raw accept its ID.
}
export interface RenderPreparation {
  transactionId: string; episodeId: string; outputId: string;
  manifestHash: string; rendererBuildHash: string;
  layer: 'background' | 'foreground'; projectionRevision: number;
  prepared: boolean; // Not proof of pixels on recorded video.
}
export interface PixelRect { x: number; y: number; width: number; height: number }
export interface CropPx { top: number; right: number; bottom: number; left: number }
export interface NativeCompositionTransactionBase {
  commandId: string; transactionId: string; effectId: string; requestHash: string;
  roomId: string; episodeId: string; outputId: string;
  manifestHash: string; rendererBuildHash: string;
  fence: PublisherFence;
  expectedNativeGeneration: number;
  expectedRoomExecutionRevision: number;
  expectedBindingsRevision: number;
  expectedOutputGeneration: number;
  sequence: number;
  expiresAtServerMs: number;
  desiredProjectionRevision: number;
  sourceChanges: { id: SourceId; expectedRevision: number; rectPx: PixelRect;
    cropPx: CropPx; visible: boolean; z: number; fit: 'contain' | 'cover' }[];
  layers: [RenderPreparation & { layer: 'background' }, RenderPreparation & { layer: 'foreground' }];
}
export type NativeShowTransaction = NativeCompositionTransactionBase & (
  | { target: { kind: 'layout'; aspect: Aspect; layoutId: string }; audioAdmission?: never }
  | { target: { kind: 'segment'; segmentId: string; segmentInstanceId: string };
      audioAdmission: { participantId: string; admitted: boolean; expectedGrantRevision: number }[] }
);
export interface AppliedReceipt {
  commandId: string; transactionId: string; effectId: string; requestHash: string;
  roomId: string; episodeId: string; outputId: string;
  status: 'applied' | 'failed' | 'expired' | 'cancelled';
  fence: PublisherFence;
  nativeGeneration: number; outputGeneration: number; roomExecutionRevision: number;
  actualItems: { sourceId: string; sourceRevision: number; rectPx: PixelRect;
    cropPx: CropPx; z: number; fit: 'contain' | 'cover'; visible: boolean }[];
  actualAudio: { participantId: string; admitted: boolean; operatorMuted: boolean;
    consentAllowsPublish: boolean; grantRevision: number }[];
  layers: { layer: 'background' | 'foreground'; projectionRevision: number; prepared: boolean }[];
  errorCode?: string;
}
export interface NativeExecutionContext {
  roomId: string; episodeId: string; fence: PublisherFence;
  // Trusted native host installs verified fence with conservative clock uncertainty.
  localMonotonicLeaseDeadlineMs: number;
  nativeGeneration: number; roomExecutionRevision: number; bindingsRevision: number;
  outputGenerations: Record<string, number>;
  // Engine checks immediately before mutation; emergency stop increments abort generation.
}
export interface ShowProtocolHello {
  protocol: 'producer.show-control/1'; rendererAbi: string;
  capabilities: { aspects: Aspect[]; independentOutputs: boolean;
    canonicalPrincipalHandoff: boolean; exactVoteOnce: boolean;
    fencedNativeEffects: boolean; ownedRecorderStop: boolean };
}
export type PublicRunBase = Pick<CommonRunSnapshot, 'episodeId' | 'roomId' | 'status' |
  'clock' | 'activeLayouts' | 'presentationValues' | 'presentationValuesRevision'>;
export type PublicRenderProjection = { projectionRevision: number } & (
  | { episode: PublicRunBase & { mode: 'set' }; derived: { recovering: boolean } }
  | { episode: PublicRunBase & Pick<ProgramRunSnapshot, 'mode' | 'segmentId' |
        'segmentInstance' | 'reveal' | 'result' | 'heat' | 'scores'>;
      displayNames: Record<string, string>; visibleTally: Record<string, number> | null;
      derived: { segmentRemainingMs: number | null; hot: boolean;
        winnerDisplayName: string; needsWinnerDecision: boolean } }
);
// No private binding/grant/principal/recorder/path data in either public projection.
export type ControlRenderProjection = PublicRenderProjection & {
  capabilities: { actions: Record<ControlAction['kind'], boolean> };
  operational: { transitionPending: boolean; recordingStatus: RecordingReceipt['status'] | null };
};
export type RendererSession = {
  sessionId: string; roomId: string; episodeId: string; manifestHash: string;
  rendererBuildHash: string; rendererAbi: string;
  readCapability: string; expiresAtServerMs: number; allowedAssetIds: string[];
} & (
  | { surface: 'output-background' | 'output-foreground'; allowedActions: []; actionChannel: null }
  | { surface: 'host' | 'moderator'; allowedActions: ControlAction['kind'][];
      actionChannel: { channelId: string; expectedFrameOrigin: string;
        boundFrameInstanceId: string } }
);


export const reviewPlan = {
  status: 'reviewed-with-conditions-P0-P0b-only-not-implemented',
  chosenByUser: {
    prototype: 'Two contestants, audience vote, heat effect and winner reveal',
    nordcraft: 'Adapt selected open-source modules behind our stable schema',
    customUI: 'Producer host/mod workspace and show output',
    ios: 'Native audience UI with existing vote/chat/reaction controls',
    guests: 'Keep audience interaction powers before, during and after stage participation',
  },
  reviewDisposition: {
    source: 'docs/shows/SHOW-ENGINE-ARCHITECTURE-REVIEW.md',
    verdict: 'Ready with conditions for bounded P0/P0b',
    scopeNow: 'Contracts and plans only; live episode effects remain gated. No blocker is implementation-fixed by changing this file.',
    conditions: [
      { id: 'B1', title: 'Dedicated renderer isolation/resource/action boundary', before: 'P0 untrusted loading', state: 'contract revised; attack harness pending' },
      { id: 'B2', title: 'Native fencing, arbitration, cancellation and replay receipts', before: 'P1/P2 media effects', state: 'contract revised; implementation pending' },
      { id: 'B3', title: 'Canonical guest principal, eligibility and exact vote-once', before: 'P1 live participation', state: 'contract revised; existing overflow bug independently reproduced; implementation pending' },
      { id: 'B4', title: 'Participant audio bundle and separate public admission', before: 'P2 stage changes', state: 'contract revised; tone tests pending' },
      { id: 'B5', title: 'Segment clock, persistent reveal and authoritative input window', before: 'P1 timed reducer', state: 'contract revised; deadline/alarm tests pending' },
      { id: 'B6', title: 'Separate layer preparation and complete native readback', before: 'P0/P2 composition commit', state: 'contract revised; skew proof pending' },
      { id: 'B7', title: 'Native recorder ownership and finalization evidence', before: 'P2 automatic recording', state: 'contract revised; implementation pending' },
      { id: 'B8', title: 'Executable schema, correlated payloads and coverage fixtures', before: 'P0 schema freeze', state: 'typed contracts revised; executable validator/coverage fixtures pending' },
      { id: 'B9', title: 'Negotiated hosted/self-hosted protocol parity', before: 'P1 release', state: 'handshake proposed; cross-backend audit/tests pending' },
    ],
    productDefaultsPending: {
      studioOverride: 'Suspend/reconcile if editing show-owned stage/geometry; unrelated controls remain usable.',
      moderator: 'Explicit operational delegation; result overrides and unrecorded-start decisions host-only.',
      votingCapacity: 'Exact remembered-principal admission with visible capacity error; no count-blind fallback. Final numeric ceiling remains a release decision.',
      hardware: 'Mac/Windows reference hardware and numerical budgets must be measured/confirmed before release.',
    },
  },
  principles: [
    'Room is the venue; Show is the reusable definition; Episode is one run.',
    'Keep composition, animation, recording and encoding on host hardware.',
    'Reuse existing backend, Durable Objects, control link and interaction services.',
    'No new Cloudflare product or required rented media server.',
    'The runtime builds once; ordinary show packages are interpreted JSON and assets.',
    'Show mode has its own UI; Producer owns always-accessible Stop and Studio controls.',
    'A segment may select a scene, but timeline/competition state is not the scene state.',
    'Never confuse accepted controller intent with applied native source/output state.',
    'Stage/visibility/mute/competition membership/interaction rights are independent.',
    'A show does not automatically start or stop external streams.',
  ],
  currentEvidence: [
    { path: 'src-tauri/src/live/engine.rs', fact: 'reset_video derives width from height * 16 / 9.' },
    { path: 'src-tauri/src/live/graph.rs', fact: 'apply_scene prevalidates and uses obs_scene_atomic_update; audio mute is applied in the batch, but audio is not an OBS video-frame transaction.' },
    { path: 'src-tauri/src/live/record.rs', fact: 'One recording output uses obs_get_video; multiple network outputs do not prove multiple aspect canvases.' },
    { path: 'src/lib/programCapture.ts', fact: 'Shared program capture and separate conversation audio return exist; output identity/aspect extension is still needed.' },
    { path: 'src/lib/roomControl.ts', fact: 'Existing control socket coordinates scene/actions; extend it rather than opening a rival show authority.' },
    { path: 'server/src/interactionRoutes.ts', fact: 'Guest input.vote and per-device audience identities already exist; principal continuity across promotion needs explicit work.' },
    { path: 'src/lib/roomVotes.ts', fact: 'Historical room votes can be selected; show state must select by episode and interaction ID.' },
    { path: 'src-tauri/src/live/bridge.rs', fact: 'Loopback overlay bridge exists, but current overlay templates are not a generic show runtime.' },
    { path: 'src/lib/ipc.ts', fact: 'Studio captures the entire application window; this cannot become the show-output renderer.' },
    { path: 'boomin-ios/Sources/RoomAudienceView.swift', fact: 'Native audience surface exists; arbitrary JSON HTML does not become SwiftUI.' },
  ],
  nordcraft: {
    upstream: 'https://github.com/nordcraftengine/nordcraft',
    inspectedCommit: 'e4ebe92c42f6c4226ad7d0bb33a70ff7206178c8',
    borrowCandidates: ['Formula evaluator subset', 'JSON CSS/keyframe generation', 'Reactive signals and keyed node updates'],
    boundary: 'Vendor audited modules under a thin adapter; our schema and lifecycle are independent.',
    proof: 'Local source checks verified JSON formulas and keyframe generation only; full OBS renderer remains a spike.',
    obligations: ['Retain applicable Apache-2.0 license/NOTICE and copyright', 'Mark modifications', 'Audit transitive imports and dependencies'],
    exclude: ['Upstream arbitrary JavaScript handlers', 'Editor new Function path', 'Unrestricted global/network/API context'],
  },
  verticalCanvasResearch: {
    package: '/Users/klevelandbishop/Downloads/vertical-canvas-macos-universal.pkg',
    inspectedOnly: true,
    packageVersion: '1.6.4',
    sha256: '281348c4de542f56f0737fbdd70a9fbb644dd40d14e04acbbd4914addc9fdd2b',
    upstream: 'https://github.com/Aitum/obs-vertical-canvas',
    matchingSourceCommit: '9cd13b8f3cd9afe01d665a2c869a24e88b9a8555',
    lessons: ['Per-canvas dimensions/video mix', 'Shared source references with independent scene items/layout', 'Encoder binds to canvas-specific video output', 'Canvas-local lifecycle instead of global reset for second output'],
    producerObs: '32.1.2, commit fb4d98bf88fae5fc85cb11fc57f7c5e309282194',
    candidateAPIs: ['obs_canvas_create_private', 'obs_canvas_scene_create', 'obs_canvas_set_channel', 'obs_canvas_reset_video', 'obs_canvas_get_video', 'obs_view_add2 as alternative lower-level mix path'],
    evidence: 'Pinned OBS headers and exported symbols in the local signed dev engine both contain these APIs.',
    integration: 'Use libobs directly in a Qt-free native adapter; do not load the OBS frontend/Qt plugin.',
    audio: 'Additional canvas flags must not duplicate shared microphones in public audio; retain one processed program bus.',
    license: 'Aitum contains GPL v2 license text; verify exact applicable license before copying code. No plugin code is vendored by this plan.',
    uncertainty: 'API availability is verified; multi-canvas browser render/capture/recording and cleanup still require P0b.',
  },
  guestInteractionContract: {
    roles: ['audience', 'guest-backstage', 'guest-onstage', 'moderator', 'host'],
    sharedAudiencePowers: ['Read/send permitted chat', 'Vote', 'React', 'Use declared participant interaction actions'],
    mediaPowers: 'Separate grants for camera, microphone and screen; UI actions never silently enable capture.',
    controlPowers: 'Separate room/show grants for scenes, admission, voting lifecycle and results.',
    identity: 'Carry a verified room interaction principal from audience to guest; one participant is counted once.',
    directGuest: 'Guest invitation exchanges into the same interaction capability family; existing input.vote must be preserved.',
    handoff: 'Backend links identities using an authenticated single-use promotion exchange, never by a client-claimed ID or leaked invite code.',
    dedupe: 'Vote identity, cooldowns and moderation restrictions survive promotion, demotion, reload and reconnect.',
    limits: 'Anonymous per-device identity cannot guarantee one human across unrelated devices; do not claim that.',
    exactOnce: 'Remember every admitted principal for the full interaction lifetime, or reject capacity visibly; existing SEEN_CAP overflow counting is not acceptable.',
    eligibility: 'Every HTTP/WebSocket input resolves current principal policy and gate in the authority transaction. Ban denies input; chat mute scope is declared per action.',
    policy: 'Contestants may vote once, including for themselves in the test; show rules may explicitly exclude contestants.',
    elimination: 'Move the losing competitor backstage after native confirmation; retain interaction rights and guest connection.',
    privacy: 'Guests receive their own capabilities and public state, not privileged host/mod control data.',
    customClicks: 'Define versioned registered player widgets/actions in P0, then gate implementation by negotiated support; choices/text/number/action buttons use private evaluation and explicit reveal. No arbitrary JS/endpoint submit.',
    clients: ['Guest web page: persistent dynamic player controls beside return feed', 'Native iOS: SwiftUI widget adapter; preserve identity across stage invitation', 'Producer guest: player controls while producing/streaming own room', 'Guest media page: same identity; no arbitrary show HTML inside native iOS'],
    extendedPlan: 'PARTICIPATION-AND-ROOM-LINKS-PLAN.md and PARTICIPATION-CONTRACTS.ts: private answers, target ballots, phone contestant sign-in and own-room streaming/relay gates',
  },
  runtime: {
    language: 'Validated element/text/component trees, conditional/keyed repetition, formulas, CSS/SVG and keyframes.',
    build: 'Compile the reusable runtime once. Parse/validate/generate bounded CSS when importing JSON.',
    state: 'Dependency-based updates; one immutable episode snapshot plus bounded local UI state.',
    actions: 'Host-owned adapter receives declarative intents, validates surface/grants, submits authenticated commands.',
    layers: 'Background browser source below native video; foreground browser source above video. Both consume one state revision/clock.',
    nativeSlots: 'Named source bindings translated to normalized rectangles then exact native canvas coordinates.',
    restrictions: 'MVP fixed rectangular source slots per segment; animated native slots, arbitrary video masks and interleaved DOM/video depth are capability-gated.',
    unsupported: 'Reject unsupported requested visual/native features at import/preflight with a node/segment diagnostic; never silently render the wrong geometry.',
    preview: 'Use mock/source placeholders and deterministic recorded event fixtures; edits affect preview only.',
    pinning: 'Episode pins manifest hash, assets and runtime version; an agent edit makes a new package version.',
  },
  isolation: {
    document: 'Imported content never runs in the authenticated Tauri origin or receives its global IPC bridge.',
    renderer: 'Sandboxed host/mod frame plus read-only local OBS browser-source renderer; distinct scoped bridge capabilities.',
    loopback: 'Dedicated show routes, GET/HEAD reads only, exact path/method/Host/origin policies; unknown route is 404, invalid method 405. Scoped revocable read capabilities, no wildcard CORS or output action endpoint.',
    bridge: 'Control-only MessagePort/session bound to actual trusted frame instance plus source/origin/runtime/package checks. No IPC forwarding; opaque sandbox origins require frame/port identity, not origin text alone.',
    assets: 'Import JSON plus local asset directory; copy validated assets to managed package storage. Archive transport can follow.',
    validation: ['Schema and semantic validator from one contract source', 'No prototype pollution paths', 'Acyclic typed component props/defaults', 'Unique node and scoped repeat occurrence identity', 'Finite geometry and bounded expression arity/result/work', 'Validate evaluated URLs/attributes/CSS as well as bindings', 'Local asset IDs only; deny SVG external refs/CSS imports/inline handlers/navigation', 'Bound files/nodes/repeats/keyframes/textures/filter work', 'Hash/size/MIME verification', 'Reject output events and expanded components containing controls', 'Reject unknown fields and mismatched action payloads', 'No raw HTML/JS or privileged network calls'],
    proposedBudgets: { manifestBytes: 2_000_000, assetBytes: 50_000_000, nodesPerSurface: 2000, depth: 64, repeatedNodes: 2000, actionsPerSecond: 10 },
    budgetsNote: 'Initial review defaults; measure real memory/render cost and tune without relaxing trust boundaries.',
  },
  authority: {
    owner: 'Existing room controller, with the same protocol in hosted and self-hosted deployments.',
    actions: 'Control commands use CAS; high-rate participant inputs use atomic window/eligibility/dedupe gates without whole-episode CAS. Principal+payload hash binds command ID; conflicting retry fails.',
    persistence: 'Persist episode transition intent and effect outbox before sending; native receipt advances committed state.',
    outbox: 'Idempotent interaction create/close/reveal and native effects have separate receipts; crash/retry reconciles them.',
    atomicity: 'One controller commit is atomic; there is no distributed transaction spanning native OBS, browser paint and the vote service.',
    starting: 'Prepare sources/renderer/recording locally, persist starting intent, apply native layout, verify receipts, then commit running clock.',
    advancing: 'Close/freeze vote at authority deadline, save result, issue source/layout transition, expose applying state; commit target segment after native receipt.',
    failure: 'Pause in recovering on missing/failed receipt; snapshot actual native state, do not fake success or replay an expired stage action.',
    nativeGuard: 'Native engine checks verified lease ID, conservative monotonic expiry, epoch, abort/output/native generations, source/binding/execution revision and sequence immediately before mutation. Persist/reconcile replay receipt by effect ID for episode retention.',
    audioGuard: 'Bind complete video/audio bundles, including separate host mic. Demote by closing/acknowledging public admission before stage/video changes. Consent, grants, operator mute and monitoring remain independent; failures stay closed.',
    timers: 'Persist segment instance/entry, round window/deadline and immutable reveal event. Server-time input gate determines eligibility even when alarm is late. Keep due effects durable until settled; retry/rearm failures.',
    emergencyStop: 'Increment abort generation on trusted host before restoration; invalidate pending show effects and ignore late receipts. Queue priority alone is insufficient.',
    arbitration: 'Show, mod, scene and direct Studio source effects share one ownership/execution revision and arbitration policy; separate legacy sequences must not supersede independently.',
    highRate: 'Coalesce accepted audience aggregates; local CSS owns frames. No animation-frame events in DO or action log.',
    hostLoss: 'Publisher lease expiry freezes progression, closes vote inputs at the freeze boundary, retains episode as recovering.',
    reconnect: 'Recover same episode/hash/epoch with new lease; host explicitly resumes after output/recording reconciliation.',
    moderator: 'May operate only delegated show controls; cannot become publisher or grant themselves authority.',
  },
  data: {
    existing: ['Room identity and branded entrances', 'Current live run ledger', 'Interaction envelope/tally storage', 'Local recording catalogue'],
    proposed: [
      'Show definitions: owner, show/version, immutable manifest+asset hashes and engine range',
      'Room show attachment: pinned definition reference + validated room bindings/overrides',
      'Episodes: room/show hash, lifecycle/clock, segment, roster/results, revision and recording association',
      'Episode action log/outbox: idempotency keys, principal reference, outcomes and recovery checkpoints',
      'Interaction episode_id: additive linkage; do not overload existing external-stream run_id',
      'Recording episode/output association: local ownership plus recording intervals and safe metadata sync',
    ],
    episodeAndRun: 'An episode may coexist with the existing external stream run; starting/stopping either must not terminate the other.',
    noFrameLog: 'Store decisions, transition receipts and checkpoints; aggregate reactions with bounded retention, not every rendered frame.',
    metadata: 'No guest personal details or local filesystem path required in audience snapshots.',
  },
  recording: {
    default: 'Local auto-record shown before Start; explicit unrecorded override is allowed and logged.',
    startFailure: 'Do not mark the episode running if required recording fails; report disk/encoder error and offer retry or explicit unrecorded start.',
    manualAlreadyRunning: 'Reuse without taking ownership; record episode interval offsets. Stop show must not stop the manual recorder.',
    owned: 'Persist native owner intent before start. Compare-and-stop exact recorder ID/generation/owner token; ready requires terminal stop/muxer result, verified final file and truthful media timeline/catalogue.',
    offsets: 'Manual reuse interval uses recorder media PTS/timeline origin, not wall-clock estimates; no episode-owned stop token is issued.',
    interrupted: 'Recovery reads catalogue/file state; failed finalization is interrupted/failed, never a silently successful recording.',
    restore: 'Restore show-owned room geometry with revision checks; do not overwrite host manual changes. End retains normal room media/session.',
    outputs: 'MVP one landscape recording; future active formats each get a distinct file/output ID under the same episode.',
    streaming: 'Preserve ongoing external output; first show must match existing canvas configuration, not reset it while live.',
  },
  formatGates: [
    { phase: 'MVP', support: 'One landscape output at the current compatible video mode', gate: 'Full JSON render + native source composition + capture + local recording on Mac and Windows' },
    { phase: 'Portrait', support: 'One explicitly selected portrait output', gate: 'Explicit width/height config throughout engine, preview, geometry, captures, recordings and destination routing; safe mode change while idle' },
    { phase: 'Both', support: 'Concurrent landscape and portrait', gate: 'Proven independent compositors/output identities and encoders sharing captures; never reset global obs_get_video underneath another output' },
  ],
  rollout: {
    featureFlag: 'show_engine_v1 (proposed), off until rehearsal gates pass',
    installation: 'No forced restart, network migration or show-start action as part of this review artifact.',
    compatibility: 'Ordinary rooms, moderator sources, existing links, conversations, voting and native iOS remain usable without loading a show.',
    negotiation: 'Versioned protocol/renderer ABI/capabilities and role projections; incompatible show start rejected while ordinary room continues. Shared vectors must execute on both backend adapters.',
    shipping: 'Separate reviewable changes per phase; no release-number change or deployment implicitly included in writing this plan.',
  },
} as const;

// Actual JSON-compatible fixture, not just a named preset. Full styles/components are
// authorable; these two contestant frames do not limit future formats to this design.
const get = (...path: string[]): Expr => ({ op: 'get', path });
const lit = (value: Json): Expr => ({ op: 'literal', value });
const eq = (a: Expr, b: Expr): Expr => ({ op: 'call', fn: 'eq', args: [a, b] });
const button = <K extends ControlAction['kind']>(
  id: string, text: string, action: K,
  ...payload: keyof ControlPayload<K> extends never
    ? [payload?: ControlPayload<K>] : [payload: ControlPayload<K>]
): UINode => {
  // Generic call-site payload checks preserve correlation; runtime validators remain required.
  const event = { action, payload: payload[0] ?? {} } as DeclarativeControlEvent;
  return {
    id, kind: 'element', tag: 'button', attributes: {
      type: 'button', disabled: { op: 'call', fn: 'not', args: [get('capabilities', 'actions', action)] },
    },
    styles: { padding: '12px 18px', borderRadius: '12px', background: '#a8ffce', color: '#07121a', fontWeight: 700 },
    events: { click: event },
    children: [{ id: `${id}-label`, kind: 'text', text }],
  };
};
export const testShow: CompetitiveProgramManifest = {
  schema: 'producer.show/2', mode: 'program', id: 'producer.two-contestant-test', version: '0.1.0',
  engineRange: '>=0.1.0 <0.2.0', name: 'Head to Head',
  brief: 'Two contestants get a timed round. Everyone with voting rights, including guests, can choose a winner. Reactions heat the visuals. The host resolves ties.',
  assets: [], components: {}, supportedAspects: ['landscape'],
  recording: { default: 'local-auto', existingManual: 'reuse-with-episode-interval' },
  slots: [
    { id: 'left', purpose: 'Contestant A camera', required: true, media: 'video' },
    { id: 'right', purpose: 'Contestant B camera', required: true, media: 'video' },
  ],
  participantInteractions: [{
    id: 'round-vote', widget: 'choices', label: 'Who wins this round?',
    action: 'vote.submit', roles: ['audience', 'guest'], segmentIds: ['round'],
    choices: [{ id: 'left', label: 'Contestant A' }, { id: 'right', label: 'Contestant B' }],
  }],
  rules: {
    vote: { choices: ['left', 'right'], oncePerParticipant: true, allowContestantVotes: true, tie: 'host-decides', zeroVotes: 'host-decides' },
    heat: { source: 'accepted-reactions', windowMs: 10_000, maxPerPrincipalPerSecond: 1, hotAt: 10, decay: 'window-expiry' },
    elimination: 'backstage',
  },
  initialSegment: 'intro',
  segments: [
    { id: 'intro', title: 'Meet the contestants', durationMs: null, clock: 'episode-elapsed', layouts: { landscape: 'duel' }, next: 'round', advance: 'host', enter: [], exit: [] },
    { id: 'round', title: 'Audience round', durationMs: 60_000, clock: 'episode-elapsed', layouts: { landscape: 'duel' }, next: 'reveal', advance: 'timer', enter: ['open-round-vote'], exit: ['close-round-vote'] },
    { id: 'reveal', title: 'Winner', durationMs: null, clock: 'episode-elapsed', layouts: { landscape: 'winner' }, next: 'outro', advance: 'host', enter: ['reveal-result', 'backstage-non-winners'], exit: [] },
    { id: 'outro', title: 'Thanks for watching', durationMs: null, clock: 'episode-elapsed', layouts: { landscape: 'winner' }, next: null, advance: 'host', enter: [], exit: [] },
  ],
  surfaces: {
    host: { id: 'host-desk', kind: 'element', tag: 'main', styles: { display: 'grid', gap: '16px', padding: '24px', background: '#07121a', color: '#ffffff' }, children: [
      { id: 'host-title', kind: 'text', text: 'Head to Head — Control desk' },
      { id: 'host-clock', kind: 'text', text: { op: 'call', fn: 'formatClock', args: [get('derived', 'segmentRemainingMs')] } },
      { ...button('begin-round', 'Start audience round', 'segment.advance', { segmentId: 'round' }), when: eq(get('episode', 'segmentId'), lit('intro')) },
      { ...button('pause', 'Pause', 'episode.pause'), when: eq(get('episode', 'status'), lit('running')) },
      { ...button('resume', 'Resume', 'episode.resume'), when: eq(get('episode', 'status'), lit('paused')) },
      { ...button('resolve-left', 'Choose contestant A', 'result.resolve', { winnerSlotId: 'left', reason: 'Host resolves tie or no votes' }), when: get('derived', 'needsWinnerDecision') },
      { ...button('resolve-right', 'Choose contestant B', 'result.resolve', { winnerSlotId: 'right', reason: 'Host resolves tie or no votes' }), when: get('derived', 'needsWinnerDecision') },
      { ...button('outro', 'Finish reveal', 'segment.advance', { segmentId: 'outro' }), when: eq(get('episode', 'segmentId'), lit('reveal')) },
    ] },
    moderator: { id: 'mod-desk', kind: 'element', tag: 'main', styles: { padding: '20px', background: '#07121a', color: '#ffffff' }, children: [
      { id: 'mod-title', kind: 'text', text: 'Head to Head — Moderator desk' },
      { id: 'mod-status', kind: 'text', text: get('episode', 'segmentId') },
      button('mod-pause', 'Pause round', 'episode.pause'),
    ] },
  },
  layouts: ['duel', 'winner'].map((id): Layout => ({
    id, aspect: 'landscape', width: 1280, height: 720,
    slots: id === 'duel'
      ? [
          { slotId: 'left', rect: { x: .04, y: .19, width: .44, height: .65 }, z: 10, visible: true, fit: 'contain' },
          { slotId: 'right', rect: { x: .52, y: .19, width: .44, height: .65 }, z: 11, visible: true, fit: 'contain' },
        ]
      : ['left', 'right'].map((slotId): SlotPlacement => ({
          slotId, rect: { x: .22, y: .19, width: .56, height: .65 }, z: 10,
          visible: eq(get('episode', 'result', 'winnerSlotId'), lit(slotId)), fit: 'contain',
        })),
    background: { id: `${id}-background`, kind: 'element', tag: 'div', styles: { position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at top, #21396b, #07121a 75%)' } },
    foreground: { id: `${id}-foreground`, kind: 'element', tag: 'div', styles: { position: 'absolute', inset: 0, color: '#ffffff', fontFamily: 'sans-serif' }, children: [
      { id: `${id}-title`, kind: 'element', tag: 'h1', styles: { position: 'absolute', left: '4%', top: '2%', margin: 0, fontSize: '48px' }, children: [{ id: `${id}-title-text`, kind: 'text', text: 'HEAD TO HEAD' }] },
      { id: `${id}-clock`, kind: 'element', tag: 'div', when: eq(get('episode', 'segmentId'), lit('round')), styles: { position: 'absolute', right: '4%', top: '4%', fontSize: '42px', fontVariantNumeric: 'tabular-nums' }, children: [{ id: `${id}-clock-text`, kind: 'text', text: { op: 'call', fn: 'formatClock', args: [get('derived', 'segmentRemainingMs')] } }] },
      { id: `${id}-heat`, kind: 'element', tag: 'div', when: get('derived', 'hot'), styles: { position: 'absolute', inset: '1%', border: '8px solid #ff793e', borderRadius: '24px', boxShadow: '0 0 40px #ff793e' }, animations: [{ id: `${id}-pulse`, durationMs: 800, iterations: 'infinite', easing: 'ease-in-out', clock: 'cosmetic-local', keyframes: [{ offset: 0, styles: { opacity: .45 } }, { offset: .5, styles: { opacity: 1 } }, { offset: 1, styles: { opacity: .45 } }] }] },
      { id: `${id}-result`, kind: 'element', tag: 'div', when: { op: 'call', fn: 'or', args: [eq(get('episode', 'segmentId'), lit('reveal')), eq(get('episode', 'segmentId'), lit('outro'))] }, styles: { position: 'absolute', bottom: '5%', left: '4%', fontSize: '48px', fontWeight: 800 }, children: [{ id: `${id}-winner-name`, kind: 'text', text: { op: 'call', fn: 'concat', args: [lit('WINNER: '), get('derived', 'winnerDisplayName')] } }], animations: [{ id: `${id}-reveal`, durationMs: 900, iterations: 1, easing: 'ease-out', clock: 'episode', anchor: 'reveal-event', fill: 'forwards', keyframes: [{ offset: 0, styles: { opacity: 0, transform: 'translateY(30px)' } }, { offset: 1, styles: { opacity: 1, transform: 'translateY(0px)' } }] }] },
    ] },
  })),
};

// First-class noncompetitive set: no segments, contestant rules or show interactions.
export const testSet: SetManifest = {
  schema: 'producer.show/2', mode: 'set', id: 'producer.after-hours', version: '0.1.0',
  engineRange: '>=0.1.0 <0.2.0', name: 'After Hours',
  brief: 'A warm charcoal broadcast set. Select Solo or Conversation and edit nameplates. Run until Stop; normal room interactions remain available.',
  supportedAspects: ['landscape'], initialLayouts: { landscape: 'solo' },
  recording: { default: 'local-auto', existingManual: 'reuse-with-episode-interval' },
  assets: [{ id: 'boomin-mark', path: 'assets/boomin-mark.png',
    sha256: 'a3ea0851d120c6a718346c43c2d4852859679982ad69a9ad6ac1d5f1d384ab69', mediaType: 'image/png', bytes: 9443 }],
  components: {
    Nameplate: {
      props: { caption: { type: 'string', required: true }, accent: { type: 'string', required: false, default: '#ffc58a' } },
      root: { id: 'nameplate-template', kind: 'element', tag: 'div',
        styles: { display: 'flex', alignItems: 'center', gap: '12px', fontSize: '22px', letterSpacing: '.04em', fontFamily: 'sans-serif', color: '#f5f2fb' },
        children: [
          { id: 'nameplate-accent', kind: 'element', tag: 'span', styles: { width: '4px', height: '24px', borderRadius: '2px', background: get('props', 'accent') } },
          { id: 'nameplate-caption', kind: 'text', text: get('props', 'caption') },
        ] },
    },
  },
  presentationValues: {
    hostName: { type: 'string', default: 'Host', maxLength: 40 },
    guestName: { type: 'string', default: 'Guest', maxLength: 40 },
  },
  slots: [
    { id: 'host', purpose: 'Primary camera or room source', required: true, media: 'video' },
    { id: 'guest', purpose: 'Optional second camera or guest source', required: false, media: 'video' },
  ],
  surfaces: {
    host: { id: 'set-host', kind: 'element', tag: 'main', styles: { padding: '24px', display: 'grid', gap: '16px', background: '#14131b', color: '#f5f2fb', fontFamily: 'sans-serif' }, children: [
      { id: 'set-host-title', kind: 'text', text: 'After Hours — Set controls' },
      button('select-solo', 'Solo', 'layout.select', { aspect: 'landscape', layoutId: 'solo' }),
      button('select-conversation', 'Conversation', 'layout.select', { aspect: 'landscape', layoutId: 'conversation' }),
      { id: 'edit-host-name', kind: 'element', tag: 'input', attributes: { type: 'text', 'aria-label': 'Host nameplate', maxlength: 40, value: get('episode', 'presentationValues', 'hostName') }, events: { change: { action: 'presentation.update', payload: { key: 'hostName', value: get('event', 'value') } } } },
      { id: 'set-host-hint', kind: 'text', text: 'Use Producer’s Stop and Studio controls. Changing this layout does not change guest stage or microphone settings.' },
    ] },
    moderator: { id: 'set-mod', kind: 'element', tag: 'main', styles: { padding: '20px', background: '#14131b', color: '#f5f2fb', fontFamily: 'sans-serif' }, children: [
      { id: 'set-mod-title', kind: 'text', text: 'After Hours — Layout controls' },
      button('mod-select-solo', 'Solo', 'layout.select', { aspect: 'landscape', layoutId: 'solo' }),
      button('mod-select-conversation', 'Conversation', 'layout.select', { aspect: 'landscape', layoutId: 'conversation' }),
    ] },
  },
  layouts: ['solo', 'conversation'].map((id): Layout => {
    const frames: Array<{ slotId: string; rect: Rect }> = id === 'solo'
      ? [{ slotId: 'host', rect: { x: .10, y: .14, width: .80, height: .74 } }]
      : [
          { slotId: 'host', rect: { x: .04, y: .19, width: .44, height: .65 } },
          { slotId: 'guest', rect: { x: .52, y: .19, width: .44, height: .65 } },
        ];
    return {
      id, aspect: 'landscape', width: 1280, height: 720,
      slots: frames.map((f, i): SlotPlacement => ({ ...f, z: 10 + i, fit: 'contain', visible: true })),
      background: { id: `${id}-set-bg`, kind: 'element', tag: 'div', styles: { position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 30% 0%, #312342 0%, #17161e 55%, #100f15 100%)' }, children: [
        ...frames.map((f): OutputNode => ({ id: `${id}-${f.slotId}-well`, kind: 'element', tag: 'div', styles: { position: 'absolute', left: `${f.rect.x * 100}%`, top: `${f.rect.y * 100}%`, width: `${f.rect.width * 100}%`, height: `${f.rect.height * 100}%`, background: '#09090d', boxShadow: '0 12px 40px #00000088' } })),
      ] },
      foreground: { id: `${id}-set-fg`, kind: 'element', tag: 'div', styles: { position: 'absolute', inset: 0, color: '#f5f2fb', fontFamily: 'sans-serif' }, children: [
        { id: `${id}-set-title`, kind: 'element', tag: 'div', styles: { position: 'absolute', left: '4%', top: '5%', fontSize: '24px', letterSpacing: '.2em', color: '#cfb7f2' }, children: [{ id: `${id}-set-title-text`, kind: 'text', text: 'AFTER HOURS' }] },
        { id: `${id}-boomin-mark`, kind: 'element', tag: 'img', attributes: { src: 'asset:boomin-mark', alt: 'Boomin' }, styles: { position: 'absolute', right: '4%', top: '4%', width: '42px', height: '42px', borderRadius: '10px', boxShadow: '0 0 18px #bc8eff55' } },
        { id: `${id}-ambient-line`, kind: 'element', tag: 'div', styles: { position: 'absolute', left: '4%', bottom: '4%', width: '92%', height: '2px', background: 'linear-gradient(90deg, #b996e8, #ffc58a, #b996e800)' }, animations: [{ id: `${id}-ambient-glow`, durationMs: 6000, iterations: 'infinite', easing: 'ease-in-out', clock: 'cosmetic-local', keyframes: [{ offset: 0, styles: { opacity: .35 } }, { offset: .5, styles: { opacity: .65 } }, { offset: 1, styles: { opacity: .35 } }] }] },
        ...frames.map((f): OutputNode => ({ id: `${id}-${f.slotId}-label`, kind: 'element', tag: 'div', styles: { position: 'absolute', left: `${f.rect.x * 100}%`, top: `${(f.rect.y + f.rect.height) * 100 + 2}%` }, children: [
          { id: `${id}-${f.slotId}-nameplate`, kind: 'component', component: 'Nameplate', props: { caption: get('episode', 'presentationValues', f.slotId === 'host' ? 'hostName' : 'guestName'), accent: f.slotId === 'host' ? '#ffc58a' : '#cfb7f2' } },
        ] })),
      ] },
    };
  }),
};

export const implementationPhases = [
  {
    id: 'P0', title: 'Freeze contracts and prove the renderer boundary',
    changes: ['One schema-generating contract and semantic/action validator; adapt bounded audited Nordcraft modules', 'Set + optional show composition; output/operator/player projection and widget/action registry contracts', 'First-class Rehearsal context with isolated simulation adapters/storage/clock, same reducer semantics and no live effects', 'Dedicated resource/session/projection boundary; mocked set/feed/episode/round/reveal state only', 'General JSON renderer with source test patterns, fixed rectangles, countdown/heat/reveal in actual OBS', 'Tiny asset/component/repeat/malicious fixtures plus trusted Stop test; no real episode persistence/vote lifecycle/elimination/automatic recording'],
    files: ['NEW shared/show/schema.ts', 'NEW shared/show/validate.ts', 'NEW src/features/shows/runtime/', 'NEW src/features/shows/nordcraft-adapter/', 'src-tauri/src/live/bridge.rs'],
    pass: ['Unknown/unsafe fields, expanded output actions and wrong evaluated payloads rejected', 'Rehearsal reset deterministic; forged actions cannot invoke live adapters; active room/output/recorder unchanged', 'Real Tauri/CEF attack fixtures cannot cross session/room/IPC/asset boundary; trusted Stop responds within 1 second', '100 transitions: geometry within 1 output pixel, skew <=2 output frames, zero wrong-winner exposure; use verified transition cover if needed', '30-minute matched load: proposed added drop rate <0.5 percentage points, p95 render time <frame period, no continuing memory growth >10% after warm-up; hardware matrix still requires measurement'],
    stopIf: 'If isolated rendering or video-layer synchronization fails, revise renderer boundary before implementing authority/UI.',
  },
  {
    id: 'P0b', title: 'Early vertical/multi-canvas native spike informed by Aitum',
    changes: ['Disposable Qt-free private portrait-canvas harness beside existing landscape graph', 'Share one input with independent scene items and browser overlay sizes', 'Explicit encoder/video and processed-audio routing; scoped test outputs rather than production recorder ownership', 'Test explicit per-output capture and cleanup; return capability matrix and reference/lifetime rules'],
    files: ['NEW disposable native output spike harness', 'src-tauri/src/live/ffi.rs', 'src-tauri/src/live/engine.rs', 'src-tauri/src/live/graph.rs', 'src-tauri/src/live/record.rs'],
    pass: ['Exact FFI/export ABI on both shipped engine artifacts', '10-minute simultaneous aspect recordings plus 100 secondary start/stop cycles', 'Main dimensions/encoder/timestamps continuous; no doubled tone or new source/peer capture', 'Output capture explicitly selects aspect; global virtual camera alone insufficient', 'No continuing resource growth or primary interruption during secondary cleanup'],
    stopIf: 'Do not promise Both or port the Qt plugin if the Qt-free compositor/browser/output spike fails; retain landscape MVP and revise adapter.',
  },
  {
    id: 'P1', title: 'Episode authority, interaction identity and recovery contracts',
    changes: ['Atomically persist intent/outbox/snapshot and replay results for episode retention', 'Negotiated protocol, explicit allowlisted role projections and shared hosted/self-hosted reducer vectors', 'Canonical principal/account upgrade, cross-transport policy enforcement and exact dedupe or explicit capacity rejection', 'Segment instances, authority-gated windows and persistent reveal anchors; retry-safe alarm effects', 'Separate control CAS from participant inputs; private answer/evaluator and own-receipt storage; closed-awaiting-reveal distinct from public results', 'Frozen target choices; registered input types gated by validated schemas/native support; no arbitrary action endpoint'],
    files: ['NEW shared/show/protocol.ts', 'NEW shared/show/reducer.ts', 'server/src/roomstate.ts', 'server/src/realtime.ts', 'server/src/roomCommands.ts', 'server/src/roomActions.ts', 'server/src/interactionRoutes.ts', 'Hosted backend corresponding realtime/migration files in its own repository', 'src/lib/boominRoom.ts', 'src/lib/roomControl.ts'],
    pass: ['100 retries produce one effect; conflicting IDs/senders/payloads fail', 'Crash injection at every intent/native/commit boundary reconciles without replay', 'Gate at deadline -1/exact/+1 ms; delayed/lost alarm cannot extend votes; pause preserves tally', 'Principal continuity through stage/reload/native return; exact checks at identities 4999–5002 and overflow', 'HTTP and websocket share action restrictions; stale episode/window never reopens'],
  },
  {
    id: 'P2', title: 'Native show source and recording adapter',
    changes: ['Complete participant media bundles; independent fail-closed public audio admission', 'One arbitration policy for Studio/mod/show; native monotonic lease and abort-generation fencing', 'Per-layer render preparations + full pixel geometry/crop/z readback; measured frame cover/fallback', 'Native compare-and-stop recorder owner/generation and durable finalization receipts; media PTS intervals for manual reuse'],
    files: ['NEW src/lib/showNative.ts', 'src/lib/ipc.ts', 'src/lib/programCapture.ts', 'src-tauri/src/live/graph.rs', 'src-tauri/src/live/engine.rs', 'src-tauri/src/live/commands.rs', 'src-tauri/src/live/bridge.rs', 'src-tauri/src/live/record.rs', 'src-tauri/src/recordings.rs'],
    pass: ['Expired/stale/cancelled queued effects mutate nothing and emergency Stop cannot be undone', 'Separate host mic and guest loser tones absent after public gate; prior consent/operator mute preserved', 'Actual geometry/layer/readback matches recorded composition; controls absent', 'Owned stop matches generation/token; manual recorder/external stream continue; media offsets within one frame', 'Stop timeout never ready; muxer errors/crash/disk-full reconcile; completed file decodes through final packet'],
  },
  {
    id: 'P3', title: 'Core Set controls panel and participant UI',
    changes: ['Room top-bar Set entry/import/preflight; use existing source inspector', 'One responsive dynamic Set controls panel in existing four docks, no mandatory workspace takeover', 'Isolated JSON host/mod surfaces with capability-aware actions', 'Producer-owned Stop/recovery/recording status above imported UI; existing Studio capture is separate', 'Web and Producer guest player controls beside return feed', 'Native iOS semantic widget adapter, existing email/code contestant sign-in, account-only play and identity continuity across stage invitation'],
    files: ['NEW src/features/shows/SetControlsPanel.tsx', 'NEW src/features/shows/ShowPreflight.tsx', 'src/views/Live.tsx', 'src/views/ModBoard.tsx', 'src/views/ModSeat.tsx', 'server/guest/src/GuestRoomPage.tsx', 'server/guest/src/interactions.ts', 'server/guest/src/AudiencePage.tsx', 'boomin-ios/Sources/SessionStore.swift', 'boomin-ios/Sources/BoominApp.swift', 'boomin-ios/Sources/AudienceModels.swift', 'boomin-ios/Sources/AudienceRoomStore.swift', 'boomin-ios/Sources/RoomAudienceView.swift'],
    pass: ['Mac/Windows host and mod rights are distinct', 'Guest votes/reactions work before/on/after stage; scroll/buttons remain responsive', 'No imported show HTML replaces native iOS audience UI', 'Phone sign-in returns to the same room/run; no social OAuth or forced brand creation; account identity survives workspace change', 'Stop remains usable with malformed/hung show surface'],
  },
  {
    id: 'P4', title: 'After Hours then Head to Head rehearsal and gated release',
    changes: ['Import standalone After Hours; edit names/layout in Set controls without competition modules', 'Import Head to Head; sign phone contestants in using existing email/code flow; assign two sources; start recording/intro', 'Run 60-second vote round; audience and guests interact', 'Reveal winner, backstage loser, retain their connection/interactions', 'Stop orchestration with set still loaded and inspect file/catalogue; repeat with reconnect and failed native effect'],
    files: ['NEW show integration/reducer/native harnesses', 'NEW docs/shows/REHEARSAL-CHECKLIST.md', 'src/lib/featureFlags.ts', 'Release notes only after gates'],
    pass: ['Actual Mac + Windows OBS/encoder recordings verified', 'Signed-in phone contestants and web guests get coherent video/audio plus inputs; native/browser handoff and reconnect preserve principal', 'Participant consent/mutes and mix-minus remain intact', 'Ordinary room/mod workflow regression checks pass'],
  },
  {
    id: 'P4b', title: 'Additional game fixtures and linked-room production proofs',
    changes: ['Locked Answer and Support/Oppose fixtures after P1 projection/input gates', 'Own-room stream while guest in origin room; explicit contribution/output identity and audio buses', 'Optional authorized origin-output source and relay; origin-run participant capabilities for linked audience'],
    files: ['docs/shows/PARTICIPATION-AND-ROOM-LINKS-PLAN.md lists backend/native/UI integration seams; corresponding implementation files only after prior gates'],
    pass: ['No private correctness/tally/key in HTTP/WS/errors/assets before reveal', 'Target rename/slot reuse/latest-wins and account-alias merge preserve exact counts', 'Native/web/Producer required widget negotiation; pinned evaluator never changes during a round', 'Mac/Windows concurrent own stream and upstream guest; independent stop/reconnect', 'Reject media feedback; no duplicate audio/capture or cross-room grants; original room owns all game inputs'],
  },
  {
    id: 'P5', title: 'Portrait support, then independent dual output',
    changes: ['Add explicit width/height/output identity through native graph/capture/recording', 'Design agent-authored portrait layout without crop-only fallback', 'Prove two native composition/encoder outputs sharing source captures before enabling Both', 'Route each destination/recording to explicit output; test hardware load and disconnect isolation'],
    files: ['src-tauri/src/live/engine.rs', 'src-tauri/src/live/graph.rs', 'src-tauri/src/live/multi.rs', 'src-tauri/src/live/record.rs', 'src/lib/programCapture.ts', 'src/lib/ipc.ts', 'Show manifest/capability preflight'],
    pass: ['Portrait pipeline validated first', 'Two correct aspect outputs run together without resetting live global canvas', 'Both disabled on unsupported platforms/hardware configurations'],
  },
] as const;

export const reviewerQuestions = [
  'Does the imported UI isolation hold in actual Tauri host frames AND OBS CEF, including asset URL/CSS paths?',
  'Is adapting audited Nordcraft subsets less costly than a small independent runtime with the same schema? Confirm after P0 evidence.',
  'Are room controller storage and outbox effects durable/atomic under hosted and self-hosted implementations?',
  'How does the native bridge verify lease expiry after network partition without trusting stale queued commands?',
  'Can one state revision reliably synchronize both browser overlay layers with native source changes? Define measured tolerance and recovery.',
  'Can elimination mute fail closed without claiming OBS video lock makes audio atomic?',
  'Does identity handoff preserve guest input.vote while preventing promotion from creating a second audience principal?',
  'Are recording ownership and reuse intervals accurate across stop timeouts/crashes/reconnects?',
  'Does show restoration respect live host overrides and maintain external stream/capture continuity?',
  'Which exact libobs API/output graph can support dual aspect on Mac/Windows? P5 requires a prototype, not a promise.',
] as const;
