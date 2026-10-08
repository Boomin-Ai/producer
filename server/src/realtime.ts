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
import { verifyTicket } from "./ticket";
import { AudienceRoom } from "./audienceRoom";
import type { Env } from "./env";
import { RoomCommands, RoomCommandError, type SceneCommand } from "./roomCommands";
import { EMPTY_SCENES, parseScenePublish, validateSceneCut, type SceneState } from "./scenes";
import { RoomActions, RoomActionError, type RoomSource, type RoomAction } from "./roomActions";
import { RoomMutations } from "./roomMutations";
import { ApiError, errorBody } from "./errors";

type SocketRole = "host" | "guest" | "control" | "audience";
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
  publisherId?: string;
  audienceId?: string;
  audienceHost?: boolean;
  audienceControl?: boolean;
  audienceInvite?: boolean;
  name?: string;
  inviteOrigin?: string;
  authExpiresAt?: number;
  roomControl?: boolean;
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
  | { type: "auth.refresh"; ticket: string; request_id: string }
  // WebRTC signaling relay (guest sessions). The ONLY client->client message
  // type: an SDP offer/answer or a trickled ICE candidate, forwarded verbatim to
  // the other socket in this DO. Deliberately opaque — the server never parses
  // or stores SDP, it just introduces two peers so their media can flow DIRECTLY
  // between them and never through this server. Kilobytes once, at connect time.
  | { type: "signal"; payload: unknown; to?: string }
  // Scene cuts by mods (#47) — see scenes.ts for the frames.
  | { type: "scene.publish"; scenes: unknown; active_scene_id?: unknown; command_protocol?: number }
  | { type: "scene.cut"; scene_id: unknown; transition?: unknown; command_id?: string }
  | { type: "room.sources.publish"; sources: RoomSource[]; participants: string[]; on_stage: string[] }
  | ({ type: "room.action" } & Pick<RoomAction, "command_id" | "kind" | "target" | "on" | "expected_revision">)
  | { type: "room.action.ack"; command_id: string; status: "applied" | "failed"; error?: string; sources: RoomSource[]; participants: string[]; on_stage: string[] }
  | { type: "scene.ack"; command_id: string; status: "applied" | "failed"; error?: string };
type PublishBody = { channels: string[]; action: string; payload: unknown };

export class RealtimeHub {
  private readonly mutations = new RoomMutations();
  private readonly publisherMessages = new RoomMutations();
  private readonly actions: RoomActions;
  private readonly commands: RoomCommands;
  private readonly audience: AudienceRoom;
  constructor(private readonly state: DurableObjectState, private readonly env: Env) { this.actions = new RoomActions(state.storage); this.commands = new RoomCommands(state.storage); this.audience = new AudienceRoom(state.storage, () => state.getWebSockets().filter(ws => ws.readyState === 1), (url) => state.getWebSockets().some((ws) => (ws.deserializeAttachment() as SocketState | null)?.inviteOrigin === url.origin)); }


  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/room-stage") {
      try {
        const input=await request.json() as {roomId?:unknown;onStage?:unknown;stampHost?:unknown;expectedVersion?:unknown};
        if(typeof input.roomId!=="string" || !Array.isArray(input.onStage) || input.onStage.length>16 || input.onStage.some(id=>typeof id!=="string") || (input.expectedVersion!==undefined && (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion)<0)))throw new ApiError(400,"invalid_room_command","Invalid room command.");
        const command={roomId:input.roomId,onStage:input.onStage as string[],stampHost:input.stampHost!==false,expectedVersion:input.expectedVersion as number|undefined};
        const {setStage}=await import("./guests");
        return Response.json(await this.mutations.run(()=>setStage(this.env,command,true)));
      }catch(error){
        if(error instanceof ApiError)return Response.json(errorBody(error),{status:error.status});
        console.error("[room] stage mutation failed",error);
        return Response.json({error:{code:"room_control_unavailable",message:"Room control is unavailable."}},{status:503});
      }
    }

    if (url.pathname === "/audience/status") return Response.json(await this.audience.status());
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
    const role: SocketRole = roleHeader === "host" || roleHeader === "control" || roleHeader === "audience" ? roleHeader : "guest";

    const grants = parseGrantsHeader(request.headers.get("X-Producer-Grants"));
    const { 0: client, 1: server } = new WebSocketPair();

    // Hibernation: accept (don't .accept()/addEventListener) so idle sockets don't bill.
    this.state.acceptWebSocket(server);
    const socketState: SocketState = { userId, roomId, channels: [], role, roomControl: new URL(request.url).pathname.endsWith("/room-control"), authExpiresAt: Date.now() + (role === "audience" ? 3600000 : 120000), inviteOrigin: new URL(request.url).origin, ...(role === "audience" ? { audienceId: userId, name: request.headers.get("X-Producer-Name") ?? "Viewer" } : {}), audienceHost: role === "host", audienceInvite: role === "control" && (grants ?? []).includes("room.admit"), audienceControl: role === "control" && (grants ?? []).includes("room.remove"), ...(role === "host" ? { publisherId: crypto.randomUUID() } : {}), ...(grants ? { grants } : {}) };
    server.serializeAttachment(socketState);
    // A control seat starts from the host's last published scene list, so a
    // mod who joins mid-show sees the active scene lit without waiting for
    // the host to change something.
    if (role === "control" || role === "host") {
      const scenes = await this.sceneState();
      if (scenes.version > 0) server.send(JSON.stringify({ type: "scene.state", ...scenes, server_now: Date.now() }));
      const catalog = await this.actions.snapshot();
      server.send(JSON.stringify({ type: "room.sources", sources: catalog.sources, on_stage: catalog.on_stage, epoch: catalog.epoch, command_protocol: catalog.publisher ? 1 : 0 }));
    }
    if (role === "audience") await this.audience.admit(server);
    else if (role === "host" || role === "control") await this.audience.snapshot(server);
    return client;
  }

  private async sceneState(): Promise<SceneState> {
    return (await this.state.storage.get<SceneState>("scenes")) ?? EMPTY_SCENES;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 65536) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    // Preserve wire order across storage awaits: configure follows publication.
    if (["scene.publish", "scene.ack", "scene.cut", "audience.configure", "room.sources.publish", "room.action", "room.action.ack"].includes(msg.type)) {
      try { await this.publisherMessages.run(() => this.handleClientMessage(ws, msg)); }
      catch (error) { ws.send(JSON.stringify({type:"error",code:error instanceof ApiError ? error.code : "room_control_unavailable"})); }
      return;
    }
    await this.handleClientMessage(ws, msg);
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    const state = (ws.deserializeAttachment() as SocketState | null) ?? { userId: "", roomId: "", channels: [] };
    if (msg.type === "auth.refresh") {
      const claims = typeof msg.ticket === "string" ? await verifyTicket(this.env.SIGNALING_SECRET??"", msg.ticket, "room-control") : null;
      if (!state.roomControl || !claims || claims.sub !== state.userId || claims.room !== state.roomId) { ws.close(4001,"Room authorization expired"); return; }
      const grants = claims.grants ?? [];
      ws.serializeAttachment({...state,grants,channels:state.channels.filter(channel=>!channel.endsWith(":host")||state.role==="host"||grants.includes("room.interactions")),authExpiresAt:claims.exp*1000,audienceControl:state.role==="control"&&grants.includes("room.remove"),audienceInvite:state.role==="control"&&grants.includes("room.admit")});
      ws.send(JSON.stringify({type:"room.authorized",request_id:msg.request_id}));return;
    }
    if ((state.roomControl || state.role === "audience") && state.authExpiresAt && Date.now() >= state.authExpiresAt) {
      ws.close(4001, "Room authorization expired"); return;
    }
    if (msg.type === ("audience.configure" as string)) {
      const authority = await this.commands.snapshot();
      if (!state.publisherId || authority.publisher !== state.publisherId) {
        ws.send(JSON.stringify({ type: "audience.error", code: "publisher_busy" })); return;
      }
    }
    if (await this.audience.handle(ws, msg as unknown as Record<string, unknown>)) return;
    if (state.role === "audience") {
      if (msg.type === "subscribe" && msg.channel === "interaction:audience") { state.channels = [msg.channel]; ws.serializeAttachment(state); }
      return;
    }
    if (msg.type === "room.action" || msg.type === "room.sources.publish" || msg.type === "room.action.ack") {
      await this.sourceAction(ws, state, msg); return;
    }
    if (msg.type === "subscribe" && msg.channel) {
      // Per-role projections ride per-role channels: a guest socket may not
      // subscribe to the host's (`interaction:host` carries the running
      // tally and, later, raw inputs).
      if (msg.channel.endsWith(":host") && state.role !== "host" && (state.role !== "control" || !(state.grants??[]).includes("room.interactions"))) {
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
      if (state.role !== "host" || !state.publisherId) return;
      const next = parseScenePublish(msg, await this.sceneState());
      if (!next) return;
      try {
        const current = await this.commands.snapshot();
        if (msg.command_protocol !== 2) {
          if (current.publisher) throw new RoomCommandError("controller_upgrade_required",409);
          await this.state.storage.put("scenes",next);
          this.sendToRoles(["control","host"],{type:"scene.state",...next,command_protocol:1,server_now:Date.now()});return;
        }
        const previousLive = this.state.getWebSockets().some((other) => other !== ws && other.readyState === 1 && (other.deserializeAttachment() as SocketState | null)?.publisherId === current.publisher);
        const confirmed = await this.commands.publish(state.publisherId, next.scenes, next.active_scene_id, !previousLive);
        const directory = { ...next, active_scene_id: confirmed.active_scene_id };
        await this.state.storage.put("scenes", directory);
        this.sendToRoles(["control", "host"], { type: "scene.state", ...directory, epoch: confirmed.epoch, sequence: confirmed.sequence, server_now: Date.now() });
      } catch (error) { this.commandError(ws, error); }
    } else if (msg.type === "scene.cut") {
      const verdict = validateSceneCut(msg, state, await this.sceneState());
      if (!verdict.ok) { ws.send(JSON.stringify({ type: "error", ...verdict, ok: undefined })); return; }
      try {
        const current = await this.commands.snapshot();
        if (current.epoch === 0) {
          this.sendToRoles(["host"],{type:"scene.cut",scene_id:verdict.scene_id,transition:verdict.transition,from:state.userId,server_now:Date.now()});
          ws.send(JSON.stringify({type:"scene.cut.ok",scene_id:verdict.scene_id,command_protocol:1,server_now:Date.now()}));return;
        }
        const host = this.state.getWebSockets().find((other) => (other.deserializeAttachment() as SocketState | null)?.publisherId === current.publisher);
        if (!host) throw new RoomCommandError("host_unavailable", 503);
        const command = await this.commands.submit({ command_id: msg.command_id ?? crypto.randomUUID(), scene_id: verdict.scene_id, from: state.userId }, Date.now());
        if (command.status === "accepted") host.send(JSON.stringify({ type: "scene.cut", ...command, server_now: Date.now() }));
        this.commandResult(command);
        await this.rearm();
      } catch (error) { this.commandError(ws, error); }
    } else if (msg.type === "scene.ack") {
      if (state.role !== "host" || !state.publisherId || (msg.status !== "applied" && msg.status !== "failed")) return;
      try {
        const command = await this.commands.acknowledge(state.publisherId, msg.command_id, msg.status, Date.now(), msg.error);
        if (command.status === "applied") {
          const directory = await this.sceneState();
          await this.state.storage.put("scenes", { ...directory, active_scene_id: command.scene_id });
        }
        this.commandResult(command);
      } catch (error) { this.commandError(ws, error); }
    }
  }

  private async sourceAction(ws: WebSocket, state: SocketState, msg: Extract<ClientMessage, { type: "room.action" | "room.sources.publish" | "room.action.ack" }>): Promise<void> {
    try {
      if (!state.roomControl || !["host", "control"].includes(state.role ?? "guest")) throw new RoomActionError("forbidden", 403);
      const authority = await this.commands.snapshot();
      const host = this.state.getWebSockets().find(other => other.readyState === 1 && (other.deserializeAttachment() as SocketState | null)?.publisherId === authority.publisher);
      if (!host) throw new RoomActionError("host_unavailable", 503);
      if (msg.type === "room.action") {
        if (state.role !== "host" && !(state.grants ?? []).includes(msg.kind === "source.visibility" ? "room.scene" : "room.stage")) throw new RoomActionError("forbidden", 403);
        const catalog = await this.actions.snapshot();
        if (catalog.publisher !== authority.publisher || catalog.epoch !== authority.epoch) throw new RoomActionError("host_sources_unavailable", 503);
        const command = await this.actions.submit({ command_id: msg.command_id, kind: msg.kind, target: msg.target, on: msg.on, expected_revision: msg.expected_revision, from: state.userId }, Date.now());
        if (command.status === "accepted") host.send(JSON.stringify({ type: "room.action", ...command, server_now: Date.now() }));
        this.sendToRoles(["host", "control"], { type: "room.action.command", ...command });
      } else {
        if (state.role !== "host" || state.publisherId !== authority.publisher) throw new RoomActionError("stale_publisher", 403);
        if (!Array.isArray(msg.sources) || !Array.isArray(msg.participants) || !Array.isArray(msg.on_stage)) throw new RoomActionError("invalid_source_catalog", 400);
        const catalog = await this.actions.publish(state.publisherId, authority.epoch, msg.sources, msg.participants, msg.on_stage);
        this.sendToRoles(["host", "control"], { type: "room.sources", sources: catalog.sources, on_stage: catalog.on_stage, epoch: catalog.epoch, command_protocol: 1 });
        if (msg.type === "room.action.ack") {
          if (msg.status !== "applied" && msg.status !== "failed") throw new RoomActionError("invalid_command", 400);
          const result = await this.actions.acknowledge(state.publisherId, authority.epoch, msg.command_id, msg.status, Date.now(), msg.error);
          this.sendToRoles(["host", "control"], { type: "room.action.command", ...result });
        }
      }
      await this.rearm();
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", command_id: "command_id" in msg ? msg.command_id : undefined,
        code: error instanceof RoomActionError ? error.code : "room_control_unavailable" }));
    }
  }

  private commandError(ws: WebSocket, error: unknown): void {
    ws.send(JSON.stringify({ type: "error", code: error instanceof RoomCommandError ? error.code : "room_control_unavailable", status: error instanceof RoomCommandError ? error.status : 503 }));
  }
  private commandResult(command: SceneCommand): void {
    this.sendToRoles(["control", "host"], { type: "scene.command", ...command });
  }
  private async rearm(): Promise<void> {
    const pending = [...(await this.commands.snapshot()).commands, ...(await this.actions.snapshot()).commands].filter((c) => c.status === "accepted");
    if (pending.length) await this.state.storage.setAlarm(Math.min(...pending.map((c) => c.expires_at)));
    else await this.state.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    for (const expired of await this.commands.expire(Date.now())) this.commandResult(expired);
    for (const expired of await this.actions.expire(Date.now())) this.sendToRoles(["host", "control"], { type: "room.action.command", ...expired });
    await this.rearm();
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
    await this.audience.leave(ws);
    try {
      ws.close(code === 1006 ? 1011 : code);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.audience.leave(ws);
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
