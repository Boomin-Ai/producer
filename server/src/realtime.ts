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

type SocketState = { userId: string; roomId: string; channels: string[] };
type ClientMessage =
  | { type: "subscribe"; channel: string }
  | { type: "unsubscribe"; channel: string }
  | { type: "ping" }
  // WebRTC signaling relay (guest sessions). The ONLY client->client message
  // type: an SDP offer/answer or a trickled ICE candidate, forwarded verbatim to
  // the other socket in this DO. Deliberately opaque — the server never parses
  // or stores SDP, it just introduces two peers so their media can flow DIRECTLY
  // between them and never through this server. Kilobytes once, at connect time.
  | { type: "signal"; payload: unknown; to?: string };
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

    const userId = request.headers.get("X-Producer-User") ?? "";
    const roomId = request.headers.get("X-Producer-Room") ?? "";
    const { 0: client, 1: server } = new WebSocketPair();

    // Hibernation: accept (don't .accept()/addEventListener) so idle sockets don't bill.
    this.state.acceptWebSocket(server);
    const socketState: SocketState = { userId, roomId, channels: [] };
    server.serializeAttachment(socketState);

    return new Response(null, { status: 101, webSocket: client });
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
      if (!state.channels.includes(msg.channel)) {
        state.channels.push(msg.channel);
        ws.serializeAttachment(state);
      }
      ws.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
    } else if (msg.type === "unsubscribe" && msg.channel) {
      state.channels = state.channels.filter((c) => c !== msg.channel);
      ws.serializeAttachment(state);
    } else if (msg.type === "signal") {
      // Relay to every OTHER socket here. Guest-signaling DOs are addressed per
      // guest session (idFromName("guest:<id>")), so "everyone else" is exactly
      // the counterpart peer — no channel bookkeeping needed. `to` targets one
      // peer by its socket identity. Required in a ROOM channel, where
      // broadcasting an offer meant for one guest to all four would have every
      // peer try to answer it.
      this.relaySignal(ws, state.userId, msg.payload, msg.to);
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
