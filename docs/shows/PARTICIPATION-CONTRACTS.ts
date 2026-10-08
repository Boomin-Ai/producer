/** Review contracts, not shipped APIs or an executable schema validator.
 * Companion to PARTICIPATION-AND-ROOM-LINKS-PLAN.md. Generate the final JSON
 * schema and semantic validators in P0; do not import this draft into runtime.
 */
type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type PlayerWidget = 'choices' | 'action-button' | 'text-answer' | 'number-answer';
export type InteractionKind = 'poll' | 'quiz' | 'target-ballot' | 'registered-action';

/** Trusted session choice, not author-supplied manifest permission. */
export type PresentationExecutionContext =
  | { mode: 'live'; roomId: string; runId: string; adapterSet: 'authorized-live' }
  | { mode: 'rehearsal'; sandboxId: string; seed: number;
      adapterSet: 'simulation-only'; clock: 'controlled';
      roomId?: never; runId?: never };
// Adapter instances, storage and queues are independently scoped. Starting live
// creates a new context; simulated identities/results/receipts are never copied.

export interface ParticipationCapabilities {
  protocolVersion: string;
  widgets: PlayerWidget[];
  interactions: InteractionKind[];
  actionRegistryVersions: Record<string, string>;
  identity: Array<'anonymous-device' | 'account-linked'>;
  privateEvaluation: boolean;
  participantReceipts: boolean;
  linkedRoomParticipation: boolean;
  explicitOutputCapture: boolean;
}

/** Actor identity comes from authentication, never the input body. */
export interface InputContext {
  roomId: string;
  runId: string; // Presentation run, not external-stream run_id.
  interactionId: string;
  windowId: string;
  requestId: string;
  principalId?: never;
  userId?: never;
  role?: never;
  correct?: never;
  score?: never;
}
export type RegisteredPlayerInput = InputContext & (
  | { kind: 'choice.submit'; choiceId: string }
  | { kind: 'answer.text'; text: string }
  | { kind: 'answer.number'; value: number }
  | { kind: 'action.invoke'; actionRef: string; args: Record<string, Value> }
);
// Registry validates correlated args, lengths/ranges, semantic target and grant;
// a syntactically valid JSON object alone does not authorize action.invoke.
export interface AcceptedInputReceipt {
  requestId: string;
  receiptId: string;
  interactionId: string;
  windowId: string;
  acceptedAtServerMs: number;
  status: 'accepted';
  // No correctness, tally, private evaluator/config or winner before reveal.
}

export type PlayerControl = {
  id: string;
  label: string;
  enabled: boolean; // Authority projection, advisory; server rechecks on submit.
  disabledReason?: string;
} & (
  | { widget: 'choices'; choices: Array<{ id: string; label: string }> }
  | { widget: 'action-button'; actionRef: string; args: Record<string, Value> }
  | { widget: 'text-answer'; maxLength: number; placeholder?: string }
  | { widget: 'number-answer'; min: number; max: number; step: number }
);

export interface PublicInteractionProjection {
  interactionId: string;
  windowId: string;
  revision: number;
  kind: InteractionKind;
  prompt: string;
  state: 'ready' | 'collecting' | 'paused' | 'closed-awaiting-reveal' | 'revealed' | 'cancelled';
  inputClosesAtServerMs: number | null;
  choices: Array<{ id: string; label: string; targetPublicId?: string }>;
  revealedResult?: {
    revealId: string; revealedAtServerMs: number;
    // Explicit allowlist per kind; no spread of stored doc/evaluator.
    counts?: Record<string, number>;
    correctChoiceIds?: string[];
    scores?: Record<string, number>;
    winnerPublicId?: string | null;
  };
}
export interface OwnPlayerProjection {
  projectionRevision: number;
  roomId: string;
  runId: string;
  publicParticipantId: string;
  controls: PlayerControl[];
  eligibility: 'eligible' | 'sign-in-required' | 'unavailable';
  receipt?: AcceptedInputReceipt;
  permittedOwnAnswer?: { choiceId?: string; text?: string; value?: number };
  revealedOwnResult?: { revealId: string; correct: boolean; awardedPoints: number };
  // No account IDs, provider credentials or other players' private answers.
}

/** Never serialize this authority record to imported output/player renderers. */
export interface PrivateInteractionAuthority {
  interactionId: string;
  windowId: string;
  revision: number;
  inputPolicy: {
    identity: 'anonymous-device' | 'account-linked';
    perPrincipal: 'once' | 'latest-wins';
    maxAdmittedPrincipals: number; // Exact dedupe or explicit rejection at cap.
    contestantVotes: 'allowed' | 'excluded';
    selfVote: 'allowed' | 'excluded';
    pause: 'freeze-input' | 'continue-input';
  };
  evaluator: {
    registryId: string; version: string;
    privateConfigRef: string; snapshotRef?: string;
    missingData: 'block' | 'pause' | 'explicit-fallback';
  } | null;
  /** Frozen lookup by public choice ID; clients submit only that choice ID. */
  choiceTargets: Record<string, {
    participantId: string;
    effect: 'support' | 'oppose' | 'elimination-ballot';
    weight: number;
  }>;
  definitionHash: string;
  policyVersion: string;
}

export interface PrivateSubmissionRecord {
  receiptId: string;
  canonicalPrincipalId: string;
  interactionId: string;
  windowId: string;
  payloadHash: string;
  payload: RegisteredPlayerInput;
  acceptedSequence: number;
  acceptedAtServerMs: number;
  evaluatorVersion: string | null;
  privateEvaluation?: { correct: boolean; proposedPoints: number };
  // Bounded protected storage with retention; public receipts are projected.
}

export interface MediaEndpointRef {
  backendId: string;
  roomId: string;
  outputId: string;
}
export interface GuestAppearanceBinding {
  appearanceId: string;
  ownRoomId: string;
  originRoomId: string;
  originRunId: string;
  contribution: MediaEndpointRef;
  participantCapabilityRef: string; // Private room/run-scoped session reference.
  captureMode: 'explicit-output' | 'verified-virtual-camera';
  returnUse: 'monitor-only' | 'authorized-local-source';
}
export interface PrivateRelayGrant {
  grantId: string;
  origin: MediaEndpointRef;
  originRunId: string;
  recipientBackendId: string;
  recipientRoomId: string;
  permission: 'rebroadcast-output';
  expiresAtServerMs: number;
  revision: number;
  // Trusted issuer signs/checks this grant; the client cannot self-issue it.
}
export interface MediaRouteIntent {
  routeId: string;
  source: MediaEndpointRef;
  destination: MediaEndpointRef;
  purpose: 'monitor' | 'guest-contribution' | 'local-program' | 'authorized-relay';
  authorizationRef: string;
  audioBus: 'contribution-mix-minus' | 'monitor-return' | 'public-program';
  // Authority/native graph computes lineage. Client-supplied ancestor IDs are
  // not proof that a route is acyclic or has safe audio admission.
}

export const extendedParticipationPlan = {
  status: 'proposed-contracts-not-implemented',
  architecture: 'set + optional show; separate output/operator/player surfaces',
  authority: 'canonical origin room/run; private evaluation + explicit reveal',
  transport: 'same typed registry across native iOS, web and Producer players',
  contestantSignIn: 'existing phone email/code auth; account-only play with scoped guest/native handoff',
  deferred: ['guest social OAuth and social-data games'],
  guestProducer: 'own-room stream plus upstream appearance, explicit capture/routing',
  linkedRoomVoting: 'scoped origin-run capabilities; no aggregate vote forwarding',
  releaseGates: ['B1–B9', 'public-response privacy', 'native widget parity',
    'exact account/guest dedupe', 'phone account-only play', 'media graph/no audio loop'],
  fixtures: ['After Hours', 'Head to Head', 'Locked Answer', 'Support/Oppose',
    'Phone Contestant Sign-in', 'Guest Room G / Origin Room H'],
} as const;
