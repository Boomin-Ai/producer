// The room channel's CONTROL side, from Producer (#47).
//
// One WebSocket to the room's Durable Object, opened by the HOST's Producer
// (to publish its scene list and receive mods' cuts) and by a MOD's Producer
// (to see the list and send cuts). A 120-second ticket opens it; the socket
// outlives the ticket, and a reconnect mints a fresh one through `session`.
//
// Frames (server/src/scenes.ts is the authority):
//   → { type: "scene.publish", scenes: [{id,name}], active_scene_id }   host only
//   ← { type: "scene.state",   scenes, active_scene_id, version, server_now }
//   → { type: "scene.cut",     scene_id, transition? }                   needs room.scene
//   ← { type: "scene.cut",     scene_id, transition?, from, server_now } host receives
//   ← { type: "scene.cut.ok",  scene_id, server_now }
//   ← { type: "error", code: "forbidden" | "unknown_scene" | …, status }

export interface ControlSession {
  signaling_ticket: string;
  signaling_url: string;
  peer_id?: string;
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
  server_now: number;
}

export interface SceneCutFrame {
  type: "scene.cut";
  scene_id: string;
  transition?: string;
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
}

/** A self-healing control socket. `send` queues while offline; the newest
 *  scene.publish wins (a mod only needs the latest list). */
export class RoomControlLink {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;
  private timer: number | null = null;
  private ping: number | null = null;
  private pendingPublish: string | null = null;

  constructor(private readonly opts: RoomControlOptions) {}

  start(): void {
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) window.clearTimeout(this.timer);
    if (this.ping) window.clearInterval(this.ping);
    this.timer = null;
    this.ping = null;
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

  /** Host: publish the scene list. Re-sent on reconnect if it never went out. */
  publishScenes(scenes: readonly { id: string; name: string }[], activeSceneId: string | null | undefined): void {
    const frame = scenePublishFrame(scenes, activeSceneId);
    if (this.open) this.ws!.send(frame);
    else this.pendingPublish = frame;
  }

  /** Mod: cut to a scene. Resolves false if the socket is not open. */
  cut(sceneId: string, transition?: string): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify({ type: "scene.cut", scene_id: sceneId, ...(transition ? { transition } : {}) }));
    return true;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let session: ControlSession;
    try {
      session = await this.opts.session();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(controlWsUrl(this.opts.origin, session));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      for (const channel of this.opts.subscribe ?? []) ws.send(JSON.stringify({ type: "subscribe", channel }));
      if (this.pendingPublish) {
        ws.send(this.pendingPublish);
        this.pendingPublish = null;
      }
      if (this.ping) window.clearInterval(this.ping);
      this.ping = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 25_000);
      this.opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      const frame = (this.opts.parse ?? parseControlFrame)(ev.data);
      if (frame && frame.type !== "pong") this.opts.onFrame(frame);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.ping) window.clearInterval(this.ping);
      this.ping = null;
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

  private scheduleRetry(): void {
    if (this.closed || this.timer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, wait);
  }
}
