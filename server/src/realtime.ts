// RealtimeHub — the signaling Durable Object. Ported verbatim from Boomin's
// hosted API (src/realtime/hub.ts); only the trusted-header names changed.
//
// One instance per guest session (`guest:<id>`) and one per room
// (`liveroom:<id>`), addressed by name. Holds browser WebSocket connections
// via the Hibernation API and fans out published events to sockets subscribed
// to matching channels. It carries NO media: an SDP offer, an SDP answer and a
// trickle of ICE candidates cross it once, then the peers talk directly.
//
// Written in the classic constructor(state, env) style (no `cloudflare:workers`
// import) so that importing the Worker entry from plain Node (tests) doesn't
// choke on the workerd-only module scheme. The hibernation handlers work
// regardless of base class.
//
// Subscriptions live ONLY in each socket's serialized attachment (not an
// instance field) so they survive DO eviction/hibernation. The Worker
// authenticates the upgrade (short-lived ticket) and passes identity via
// X-Producer-* headers, which this DO trusts.
import type { Env } from "./env";
import { EMPTY_SCENES, parseScenePublish, validateSceneCut, type SceneState } from "./scenes";

type SocketRole = "host" | "guest" | "control";
type SocketState = {
  userId: string;
  roomId: string;
  channels: string[];
  /** Who this socket is: the host page / the host's Producer, a guest, or a
   *  control seat (mod). Absent on sockets from before roles = guest. */
  role?: SocketRole;
  /** The participant's grants at CONNECT (from the row, via the Worker).
   *  What the DO enforces: media.screen on the screen peer, room.scene on a
   *  cut. Kept small — the attachment is capped at a few KB. */
  grants?: string[];
};

/** Which peer a signaling frame belongs to (guest/src/participants.ts
 *  `peerOf`): "screen" only when the frame says so. */
const peerOf = (payload: unknown): "main" | "screen" =>
  payload && typeof payload === "object" && (payload as { peer?: unknown }).peer === "screen" ? "screen" : "main";

/** Ticket/row grants, parsed off the trusted header. Absent = the default
 *  guest bundle, which never includes media.screen. */
function parseGrantsHeader(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === "string") : undefined;
  } catch {
    return undefined;
  }
}
type ClientMessage =
  | { type: "subscribe"; channel: string }
  | { type: "unsubscribe"; channel: string }
  | { type: "ping" }
  // WebRTC signaling relay (guest sessions). The ONLY client->client message
  // type: an SDP offer/answer or a trickled ICE candidate, forwarded verbatim to
  // the other socket in this DO. Deliberately opaque — the server never parses
  // or stores SDP, it just introduces two peers so their media can flow DIRECTLY
  // between them and never through this server. Kilobytes once, at connect time.
  | { type: "signal"; payload: unknown; to?: string }
  // Scene cuts by mods (#47) — see scenes.ts for the frames.
  | { type: "scene.publish"; scenes: unknown; active_scene_id?: unknown }
  | { type: "scene.cut"; scene_id: unknown; transition?: unknown };
type PublishBody = { channels: string[]; action: string; payload: unknown };

export class RealtimeHub {
  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal publish — called only by the Worker (trusted), never exposed publicly.
    if (request.method === "POST" && url.pathname.endsWith("/publish")) {
      const body = (await request.json().catch(() => null)) as PublishBody | null;
      if (body?.channels?.length) this.broadcast(body.channels, body.action, body.payload);
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const client = await this.acceptUpgrade(request);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Accept the upgrade: read the trusted identity headers, take the server
   *  half into hibernation with its attachment, hand back the client half.
   *  Separate from fetch() so tests (plain Node, no 101 responses) can drive
   *  the hub without workerd. */
  async acceptUpgrade(request: Request): Promise<WebSocket> {
    const userId = request.headers.get("X-Producer-User") ?? "";
    const roomId = request.headers.get("X-Producer-Room") ?? "";
    const roleHeader = request.headers.get("X-Producer-Role");
    const role: SocketRole = roleHeader === "host" || roleHeader === "control" ? roleHeader : "guest";
    const grants = parseGrantsHeader(request.headers.get("X-Producer-Grants"));
    const { 0: client, 1: server } = new WebSocketPair();

    // Hibernation: accept (don't .accept()/addEventListener) so idle sockets don't bill.
    this.state.acceptWebSocket(server);
    const socketState: SocketState = { userId, roomId, channels: [], role, ...(grants ? { grants } : {}) };
    server.serializeAttachment(socketState);
    // A control seat starts from the host's last published scene list, so a
    // mod who joins mid-show sees the active scene lit without waiting for
    // the host to change something.
    if (role === "control" || role === "host") {
      const scenes = await this.sceneState();
      if (scenes.version > 0) server.send(JSON.stringify({ type: "scene.state", ...scenes, server_now: Date.now() }));
    }
    return client;
  }

  private async sceneState(): Promise<SceneState> {
    return (await this.state.storage.get<SceneState>("scenes")) ?? EMPTY_SCENES;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    const state = (ws.deserializeAttachment() as SocketState | null) ?? { userId: "", roomId: "", channels: [] };
    if (msg.type === "subscribe" && msg.channel) {
      // Per-role projections ride per-role channels: a guest socket may not
      // subscribe to the host's (`interaction:host` carries the running
      // tally and, later, raw inputs).
      if (msg.channel.endsWith(":host") && state.role !== "host" && state.role !== "control") {
        ws.send(JSON.stringify({ type: "error", code: "forbidden", status: 403, channel: msg.channel }));
        return;
      }
      if (!state.channels.includes(msg.channel)) {
        state.channels.push(msg.channel);
        ws.serializeAttachment(state);
      }
      ws.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
    } else if (msg.type === "unsubscribe" && msg.channel) {
      state.channels = state.channels.filter((c) => c !== msg.channel);
      ws.serializeAttachment(state);
    } else if (msg.type === "signal") {
      // A guest's SCREEN peer exists only with media.screen. The grant was
      // sealed into the ticket and re-read from the row at connect; a guest
      // without it gets its screen offer dropped here, so a modified page
      // cannot put a second track on the host by simply sending one.
      if ((state.role ?? "guest") === "guest" && peerOf(msg.payload) === "screen" && !(state.grants ?? []).includes("media.screen")) {
        ws.send(JSON.stringify({ type: "error", code: "grant_required", grant: "media.screen", status: 403 }));
        return;
      }
      // Relay to every OTHER socket here. Guest-signaling DOs are addressed per
      // guest session (idFromName("guest:<id>")), so "everyone else" is exactly
      // the counterpart peer — no channel bookkeeping needed. `to` targets one
      // peer by its socket identity. Required in a ROOM channel, where
      // broadcasting an offer meant for one guest to all four would have every
      // peer try to answer it.
      this.relaySignal(ws, state.userId, msg.payload, msg.to);
    } else if (msg.type === "scene.publish") {
      // Only the host knows the scene list; a mod publishing one is ignored.
      if (state.role !== "host") return;
      const next = parseScenePublish(msg, await this.sceneState());
      if (!next) return;
      await this.state.storage.put("scenes", next);
      this.sendToRoles(["control", "host"], { type: "scene.state", ...next, server_now: Date.now() }, ws);
    } else if (msg.type === "scene.cut") {
      const verdict = validateSceneCut(msg, state, await this.sceneState());
      if (!verdict.ok) {
        ws.send(JSON.stringify({ type: "error", ...verdict, ok: undefined }));
        return;
      }
      const now = Date.now();
      // The frame the host's Producer applies as if the host pressed the scene.
      this.sendToRoles(["host"], { type: "scene.cut", scene_id: verdict.scene_id, transition: verdict.transition, from: state.userId, server_now: now });
      ws.send(JSON.stringify({ type: "scene.cut.ok", scene_id: verdict.scene_id, server_now: now }));
    }
  }

  /** Send one frame to every socket holding one of `roles` (except `skip`). */
  private sendToRoles(roles: SocketRole[], frame: Record<string, unknown>, skip?: WebSocket): void {
    const data = JSON.stringify(frame);
    for (const ws of this.state.getWebSockets()) {
      if (ws === skip) continue;
      const peer = ws.deserializeAttachment() as SocketState | null;
      if (!peer || !roles.includes(peer.role ?? "guest")) continue;
      try {
        ws.send(data);
      } catch {
        // dead socket; webSocketClose cleans up
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1006 ? 1011 : code);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011);
    } catch {
      // already closed
    }
  }

  /** Forward one signaling frame to the other peer(s) in this DO. */
  private relaySignal(sender: WebSocket, from: string, payload: unknown, to?: string): void {
    const frame = JSON.stringify({ type: "signal", from, payload });
    for (const ws of this.state.getWebSockets()) {
      if (ws === sender) continue;
      if (to) {
        const peer = ws.deserializeAttachment() as SocketState | null;
        if (peer?.userId !== to) continue;
      }
      try {
        ws.send(frame);
      } catch {
        // drop dead socket; webSocketClose will clean up
      }
    }
  }

  private broadcast(channels: string[], action: string, payload: unknown): void {
    const wanted = new Set(channels);
    const frame = JSON.stringify({ channels, action, payload });
    for (const ws of this.state.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state?.channels?.length) continue;
      if (state.channels.some((c) => wanted.has(c))) {
        try {
          ws.send(frame);
        } catch {
          // drop dead socket; webSocketClose will clean up
        }
      }
    }
  }
}
