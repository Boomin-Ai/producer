import type { RoomSource, RoomActionKind, RoomAction } from "../../server/src/roomActions";
// The room channel's CONTROL side, from Producer (#47).
//
// One WebSocket to the room's Durable Object, opened by the HOST's Producer
// (to publish its scene list and receive mods' cuts) and by a MOD's Producer
// (to see the list and send cuts). Hosted sockets renew their short-lived
// authorization; every reconnect mints a fresh ticket through `session`.
//
// Frames (server/src/scenes.ts is the authority):
//   → { type: "scene.publish", scenes: [{id,name}], active_scene_id }   host only
//   ← { type: "scene.state",   scenes, active_scene_id, version, server_now }
//   → { type: "scene.cut",     scene_id, transition? }                   needs room.scene
//   ← { type: "scene.cut",     scene_id, transition?, from, server_now } host receives
//   ← { type: "scene.command", command_id, status, sequence, epoch }
//   ← { type: "error", code: "forbidden" | "unknown_scene" | …, status }

export interface ControlSession {
  signaling_ticket: string;
  signaling_url: string;
  peer_id?: string;
  role?: string;
  /** Only this negotiated version provides a correlated ownership receipt. */
  publisher_protocol?: number;
}

export interface SceneRef {
  id: string;
  name: string;
}

export interface SceneStateFrame {
  type: "scene.state";
  scenes: SceneRef[];
  active_scene_id: string | null;
  version: number;
  epoch?: number;
  sequence?: number;
  server_now: number;
}

export interface SceneCutFrame {
  type: "scene.cut";
  scene_id: string;
  transition?: string;
  command_id?: string;
  epoch?: number;
  sequence?: number;
  expires_at?: number;
  from: string;
  server_now: number;
}

export interface ControlErrorFrame {
  type: "error";
  code: string;
  status?: number;
  grant?: string;
  scene_id?: string;
}

/** A published channel frame (RealtimeHub `broadcast`): `interaction:host`
 *  carries the host's projection of an interaction. */
export interface InteractionFrame {
  type: "interaction";
  channels: string[];
  payload: unknown;
}

export type ControlFrame = SceneStateFrame | SceneCutFrame | ControlErrorFrame | InteractionFrame | { type: string; [k: string]: unknown };

/** Turn the server's relative `signaling_url` into an absolute ws(s) URL. */
export function controlWsUrl(origin: string, session: ControlSession): string {
  const u = new URL(session.signaling_url, origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/** Parse one frame off the wire. Tolerant: junk from a modified peer must
 *  never throw in the host's control loop. */
export function parseControlFrame(raw: unknown): ControlFrame | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  // A channel publish has `action` instead of `type`; normalise it.
  const a = v as { type?: unknown; action?: unknown; channels?: unknown; payload?: unknown };
  if (typeof a.type !== "string" && a.action === "interaction") {
    return { type: "interaction", channels: Array.isArray(a.channels) ? (a.channels as string[]) : [], payload: a.payload };
  }
  if (typeof a.type !== "string" && a.action === "stage") {
    // The server's versioned stage list (lib/stageTruth.ts): the host acts
    // on a mod's request and posts what its set actually shows.
    const p = (a.payload && typeof a.payload === "object" ? a.payload : {}) as { on_stage?: unknown; version?: unknown };
    if (!Array.isArray(p.on_stage) || typeof p.version !== "number") return null;
    return { type: "stage", on_stage: p.on_stage.filter((x): x is string => typeof x === "string"), version: p.version };
  }
  if (typeof a.type !== "string") return null;
  const f = v as ControlFrame;
  if (f.type === "scene.cut" && typeof (f as SceneCutFrame).scene_id !== "string") return null;
  if (f.type === "scene.state" && !Array.isArray((f as SceneStateFrame).scenes)) return null;
  return f;
}

/** The scene.publish frame the host sends: ids + names only, never looks. */
export function scenePublishFrame(scenes: readonly { id: string; name: string }[], activeSceneId: string | null | undefined): string {
  return JSON.stringify({
    type: "scene.publish",
    command_protocol: 2,
    scenes: scenes.map((s) => ({ id: s.id, name: s.name })),
    active_scene_id: activeSceneId ?? null,
  });
}

export interface RoomControlOptions {
  /** Server origin (https://…); the ws URL is derived from it. */
  origin: string;
  /** Mint a fresh ticket. Called on every (re)connect. */
  session: () => Promise<ControlSession>;
  onFrame: (frame: ControlFrame) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Channels to subscribe on every (re)connect, e.g. `interaction:host`. */
  subscribe?: string[];
  /** Wire → frame. Default: the open server's `{type}` frames; Boomin's
   *  `{channels, action, payload}` publishes pass lib/boominRoom.ts here. */
  parse?: (raw: unknown) => ControlFrame | null;
  /** Re-authorize long-running sockets before the short-lived room ticket expires. */
  renewAfterMs?: number;
  /** Hosted rooms acknowledge publisher ownership separately from OPEN. */
  requirePublishAck?: boolean;
  onPublisherState?: (state: PublisherState) => void;
}

export interface PublisherState {
  phase: "registering" | "ready" | "rejected";
  code?: string;
  confirmed?: boolean;
  retrying?: boolean;
}

const REGISTER_RETRIES = [1000, 2000, 4000, 8000, 15000];
const PUBLISHER_WRITES = new Set(["set.presented", "audience.configure", "audience.signal", "room.action.ack", "scene.ack"]);

/** A self-healing control socket. `send` queues while offline; the newest
 *  scene.publish wins (a mod only needs the latest list). */
export class RoomControlLink {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;
  private timer: number | null = null;
  private ping: number | null = null;
  private renewal: number | null = null;
  private renewalAck: number | null = null;
  private renewalId: string | null = null;
  private latestPublish: string | null = null;
  private pendingSources: string | null = null;
  private latestSources: string | null = null;
  // OPEN describes transport readiness, not whether this socket has sent the
  // host registration. IPC source updates can arrive before the open callback.
  private scenesPublished = false;
  private publisherRejected = false;
  private generation = 0;
  private publishAckRequired = false;
  private publisherAllowed = true;
  private registration: { requestId: string | null; publish: string } | null = null;
  private published: string | null = null;
  private registerTimer: number | null = null;
  private registerAck: number | null = null;
  private registerAttempt = 0;
  private registerExhausted = false;
  private publisherState = "";
  private claimedEpoch: number | null = null;
  private pendingHost = new Map<string, string>();
  private latestHost = new Map<string, string>();

  constructor(private readonly opts: RoomControlOptions) {}

  start(): void {
    if (this.ws || this.timer) return;
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    this.generation++;
    if (this.timer) window.clearTimeout(this.timer);
    if (this.ping) window.clearInterval(this.ping);
    this.timer = null;
    this.ping = null;
    if (this.renewal) window.clearTimeout(this.renewal);
    this.renewal = null;
    if (this.renewalAck) window.clearTimeout(this.renewalAck);
    this.renewalAck = null;
    this.renewalId = null;
    this.latestPublish = null;
    this.pendingSources = null;
    this.latestSources = null;
    this.scenesPublished = false;
    this.publisherRejected = false;
    this.clearRegistrationTimers();
    this.registration = null;
    this.published = null;
    this.registerAttempt = 0;
    this.registerExhausted = false;
    this.publisherState = "";
    this.claimedEpoch = null;
    this.pendingHost.clear();
    this.latestHost.clear();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get publisherReady(): boolean {
    return this.open && this.scenesPublished && !this.publisherRejected;
  }

  get publisherEpoch(): number | null {
    return this.claimedEpoch;
  }

  /** Host: publish the scene list. Re-sent on reconnect if it never went out. */
  publishScenes(scenes: readonly { id: string; name: string }[], activeSceneId: string | null | undefined): void {
    const frame = scenePublishFrame(scenes, activeSceneId);
    if (this.closed) return;
    this.latestPublish = frame;
    this.registerPublisher();
  }

  publishSources(sources: RoomSource[], participants: string[], onStage: string[]): boolean {
    if (this.closed) return false;
    this.pendingSources = JSON.stringify({ type: "room.sources.publish", sources, participants, on_stage: onStage });
    this.latestSources = this.pendingSources;
    return this.flushSources();
  }

  private flushSources(): boolean {
    if (!this.publisherReady || !this.pendingSources) return false;
    this.ws!.send(this.pendingSources);
    this.pendingSources = null;
    return true;
  }

  sourceAction(kind: RoomActionKind, target: string, on: boolean, revision?: number): string | null {
    if (!this.open) return null;
    const command_id = crypto.randomUUID();
    this.send({ type: "room.action", command_id, kind, target, on, expected_revision: revision });
    return command_id;
  }

  acknowledgeAction(command: RoomAction, sources: RoomSource[], participants: string[], onStage: string[], error?: string): void {
    this.send({ type: "room.action.ack", command_id: command.command_id, status: error ? "failed" : "applied", sources, participants, on_stage: onStage, error });
  }

  /** Mod: cut to a scene. Resolves false if the socket is not open. */
  cut(sceneId: string, transition?: string): string | null {
    if (!this.open) return null;
    const command_id = crypto.randomUUID();
    this.ws!.send(JSON.stringify({ type: "scene.cut", command_id, scene_id: sceneId, ...(transition ? { transition } : {}) }));
    return command_id;
  }

  send(frame: Record<string, unknown>): boolean {
    if (this.closed) return false;
    const type = String(frame.type);
    if (PUBLISHER_WRITES.has(type)) {
      // Only complete state can be replayed. Commands and media signaling
      // belong to the current claim and must never outlive its ownership.
      const output = (frame.receipt as { output?: unknown } | undefined)?.output;
      const key = type === "audience.configure" ? type
        : type === "set.presented" && (output === "program" || output === "portrait") ? `${type}:${output}` : null;
      if (key) {
        const value = JSON.stringify(frame);
        this.latestHost.set(key, value);
        if (!this.publisherReady) { this.pendingHost.set(key, value); return true; }
      } else if (!this.publisherReady) return false;
    }
    if (!this.open) return false;
    this.ws!.send(JSON.stringify(frame)); return true;
  }

  private publisherStatus(state: PublisherState): void {
    const identity = JSON.stringify(state);
    if (identity === this.publisherState) return;
    this.publisherState = identity;
    this.opts.onPublisherState?.(state);
  }

  private clearRegistrationTimers(): void {
    if (this.registerTimer) window.clearTimeout(this.registerTimer);
    if (this.registerAck) window.clearTimeout(this.registerAck);
    this.registerTimer = this.registerAck = null;
  }

  private flushHost(): void {
    if (!this.publisherReady) return;
    this.flushSources();
    for (const value of this.pendingHost.values()) this.ws!.send(value);
    this.pendingHost.clear();
  }

  private registerPublisher(): void {
    if (!this.open || !this.publisherAllowed || !this.latestPublish || this.registerExhausted || this.registerTimer || this.registration) return;
    if (this.publisherReady && this.published === this.latestPublish) return;
    const ws = this.ws!, generation = this.generation;
    const publish = this.latestPublish;
    const requestId = this.publishAckRequired ? crypto.randomUUID() : null;
    this.registration = { requestId, publish };
    if (this.publishAckRequired) this.scenesPublished = false;
    if (!this.publisherRejected) this.publisherStatus({ phase: "registering" });
    ws.send(requestId ? JSON.stringify({ ...JSON.parse(publish), request_id: requestId }) : publish);
    if (this.publishAckRequired) {
      const timer = window.setTimeout(() => {
        if (this.registerAck !== timer) return;
        this.registerAck = null;
        if (!this.closed && this.ws === ws && this.generation === generation && this.registration?.requestId === requestId)
          this.rejectPublisher("publisher_ack_timeout", ws);
      }, 6000);
      this.registerAck = timer;
    } else {
      // Older servers guarantee ordered writes but offer no ownership receipt.
      // Keep that protocol; a rejection requires a fresh authorized connection.
      this.registration = null;
      this.published = publish;
      this.scenesPublished = !this.publisherRejected;
      if (!this.publisherRejected) this.publisherStatus({ phase: "ready", confirmed: false });
      this.flushHost();
    }
  }

  private rejectPublisher(code: string, ws: WebSocket): void {
    if (this.registerAck) window.clearTimeout(this.registerAck);
    this.registerAck = null;
    this.registration = null;
    this.publisherRejected = true;
    this.scenesPublished = false;
    this.claimedEpoch = null;
    this.published = null;
    this.pendingSources = this.latestSources;
    this.pendingHost = new Map(this.latestHost);
    if (!this.registerTimer && !this.registerExhausted && this.latestPublish && this.publisherAllowed) {
      const delay = REGISTER_RETRIES[this.registerAttempt++];
      if (delay === undefined) this.registerExhausted = true;
      else {
        const generation = this.generation;
        const timer = window.setTimeout(() => {
          if (this.registerTimer !== timer) return;
          this.registerTimer = null;
          if (this.closed || this.ws !== ws || generation !== this.generation) return;
          if (this.publishAckRequired) this.registerPublisher();
          else ws.close(1000, "Retry room publisher registration");
        }, delay);
        this.registerTimer = timer;
      }
    }
    this.publisherStatus({ phase: "rejected", code, retrying: !!this.registerTimer });
  }

  acknowledge(commandId: string, status: "applied" | "failed", error?: string): void {
    this.send({ type: "scene.ack", command_id: commandId, status, error });
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    let session: ControlSession;
    try {
      session = await this.opts.session();
    } catch {
      if (!this.closed && generation === this.generation) this.scheduleRetry();
      return;
    }
    if (this.closed || generation !== this.generation) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(controlWsUrl(this.opts.origin, session));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.scenesPublished = false;
    this.publisherRejected = false;
    this.claimedEpoch = null;
    this.publishAckRequired = this.opts.requirePublishAck === true || session.publisher_protocol === 1;
    this.publisherAllowed = session.role == null || session.role === "host";
    this.registration = null;
    this.published = null;
    this.pendingHost = new Map(this.latestHost);
    ws.onopen = () => {
      if (this.closed || this.ws !== ws || generation !== this.generation) { ws.close(); return; }
      this.retryMs = 1000;
      for (const channel of this.opts.subscribe ?? []) ws.send(JSON.stringify({ type: "subscribe", channel }));
      this.registerPublisher();
      if (this.ping) window.clearInterval(this.ping);
      this.ping = window.setInterval(() => {
        if (!this.closed && this.ws === ws && generation === this.generation && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      }, 25_000);
      if (this.renewal) window.clearTimeout(this.renewal);
      this.scheduleRenewal(ws);
      this.opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (this.closed || this.ws !== ws || generation !== this.generation) return;
      const frame = (this.opts.parse ?? parseControlFrame)(ev.data);
      if (frame?.type === "scene.published") {
        const registration = this.registration;
        // Broadcast snapshots and receipts from older requests cannot grant
        // ownership to this connection, including after a retry or reconnect.
        if (!this.publishAckRequired || !registration?.requestId || frame.publisher_protocol !== 1 ||
            frame.request_id !== registration.requestId || !Number.isSafeInteger(frame.epoch) || Number(frame.epoch) < 1 ||
            !Number.isSafeInteger(frame.sequence) || Number(frame.sequence) < 0) return;
        this.clearRegistrationTimers();
        this.registration = null;
        this.published = registration.publish;
        this.publisherRejected = false;
        this.scenesPublished = true;
        this.claimedEpoch = Number(frame.epoch);
        this.registerAttempt = 0;
        this.registerExhausted = false;
        if (this.latestPublish !== registration.publish) { this.registerPublisher(); return; }
        this.publisherStatus({ phase: "ready", confirmed: true });
        this.flushHost();
      }
      if (frame?.type === "error" && typeof frame.code === "string" &&
          ["publisher_busy", "stale_publisher", "host_unavailable"].includes(frame.code)) {
        this.rejectPublisher(frame.code, ws);
      }
      if (frame?.type === "room.authorized" && frame.request_id === this.renewalId && this.renewalId) {
        if (this.renewalAck) window.clearTimeout(this.renewalAck);
        this.renewalAck = null; this.renewalId = null;
        this.scheduleRenewal(ws); return;
      }
      if (frame && frame.type !== "pong") this.opts.onFrame(frame);
    };
    ws.onclose = () => {
      if (this.closed || this.ws !== ws || generation !== this.generation) return;
      this.ws = null;
      this.scenesPublished = false;
      this.claimedEpoch = null;
      this.clearRegistrationTimers();
      this.registration = null;
      this.published = null;
      this.pendingSources = this.latestSources;
      this.pendingHost = new Map(this.latestHost);
      if (this.ping) window.clearInterval(this.ping);
      this.ping = null;
      if (this.renewal) window.clearTimeout(this.renewal);
      this.renewal = null;
      if (this.renewalAck) window.clearTimeout(this.renewalAck);
      this.renewalAck = null; this.renewalId = null;
      this.opts.onClose?.();
      this.scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // closing
      }
    };
  }

  private scheduleRenewal(ws: WebSocket): void {
    if (!this.opts.renewAfterMs) return;
    const timer = window.setTimeout(async () => {
      if (this.renewal !== timer || this.closed || this.ws !== ws) return;
      this.renewal = null;
      try {
        // Re-read permission through the normal ticket service, keeping the
        // same publisher socket and media legs alive during successful renewal.
        const session = await this.opts.session();
        if (this.closed || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        const requestId = crypto.randomUUID();
        this.renewalId = requestId;
        ws.send(JSON.stringify({type:"auth.refresh",ticket:session.signaling_ticket,request_id:requestId}));
        this.renewalAck = window.setTimeout(() => {
          if (!this.closed && this.ws === ws && this.renewalId === requestId)
            ws.close(1000,"Renew room authorization");
        },6000);
      } catch { if (this.ws === ws) ws.close(4001,"Room authorization expired"); }
    },this.opts.renewAfterMs);
    this.renewal = timer;
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
    const generation = this.generation;
    const timer = window.setTimeout(() => {
      if (this.timer !== timer || this.closed || generation !== this.generation) return;
      this.timer = null;
      void this.connect();
    }, wait);
    this.timer = timer;
  }
}
