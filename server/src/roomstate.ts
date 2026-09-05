// RoomState — the room's game-state Durable Object (#51, docs/INTERACTIVE.md
// §4). One per room, beside RealtimeHub (which stays signaling + scene
// frames). Authoritative while an interaction is LIVE: the tally, the
// identity hashes that make `once` true, the alarm that fires the reveal.
// Never durable truth: the envelope and the final tally persist in D1
// (`interactions`), input aggregates in `contributions`; the DO can be
// evicted at any moment and the show is not lost.
//
// Spokes:
//   audience phones  — hibernating WebSockets HERE (no media, JSON only),
//                      snapshot on connect, projected deltas ≤ 4 Hz
//   host + guests    — the room's RealtimeHub channel (`interaction:host`,
//                      `interaction:guest`), published from here; the host's
//                      Producer subscribes on its control socket, the guest
//                      page on its room socket. ≤ 10 Hz to the host.
//   the set          — never from here. Producer feeds its overlay page from
//                      the host's clock (INTERACTIVE.md decision 1).
//
// Worker → DO (trusted, internal fetch):
//   POST /create      { doc }
//   POST /transition  { id, transition, reveal_hold_ms? }
//   POST /input       { id, identity, kind, value }
//   GET  /list        → { interactions: Projected[] }   (host view)
//   GET  /audience-ws (WebSocket upgrade; X-Producer-User = aud sub)

import type { Env } from "./env";
import { project, type Projected, type ViewerRole } from "./interactions/project";
import { InteractionError, nextState, type InteractionDoc, type Transition } from "./interactions/schema";
import { applyInput, emptyTally, publicTally, type InputKind, type LiveTally } from "./interactions/tally";
import { roomChannelName } from "./guests";
import { recordInputAggregates } from "./contributions";

interface Live {
  doc: InteractionDoc;
  tally: LiveTally;
}

interface Alarm {
  id: string;
  at: number;
  action: "reveal" | "close";
}

type AudienceSocket = { role: "audience"; id: string };

const AUDIENCE_DELTA_MS = 250; // ≤ 4 Hz
const HOST_DELTA_MS = 100; // ≤ 10 Hz

export class RoomState {
  private pendingAudience: Set<string> = new Set();
  private pendingHost: Set<string> = new Set();
  private audienceTimer: ReturnType<typeof setTimeout> | null = null;
  private hostTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // ── storage ────────────────────────────────────────────────────────────────

  private key = (id: string) => `ix:${id}`;

  private async load(id: string): Promise<Live | null> {
    return (await this.state.storage.get<Live>(this.key(id))) ?? null;
  }

  private async save(live: Live): Promise<void> {
    await this.state.storage.put(this.key(live.doc.id), live);
    const index = (await this.state.storage.get<string[]>("index")) ?? [];
    if (!index.includes(live.doc.id)) await this.state.storage.put("index", [...index, live.doc.id]);
  }

  private async all(): Promise<Live[]> {
    const index = (await this.state.storage.get<string[]>("index")) ?? [];
    const out: Live[] = [];
    for (const id of index) {
      const l = await this.load(id);
      if (l) out.push(l);
    }
    return out;
  }

  /** Live = still worth fanning out: anything not archived. */
  private isLive = (l: Live) => l.doc.state !== "closed" && l.doc.state !== "cancelled";

  // ── fetch ──────────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname.endsWith("/audience-ws")) {
        const client = await this.acceptAudience(request);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (request.method === "GET" && url.pathname.endsWith("/list")) {
        const role = (url.searchParams.get("role") as ViewerRole | null) ?? "host";
        const now = Date.now();
        return json({ interactions: (await this.all()).map((l) => project(l.doc, l.tally, role, now)) });
      }
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return json({ error: { code: "invalid_request", message: "JSON body required." } }, 400);
      if (request.method === "POST" && url.pathname.endsWith("/create")) return json(await this.create(body.doc as InteractionDoc));
      if (request.method === "POST" && url.pathname.endsWith("/transition")) {
        return json(await this.transition(String(body.id), body.transition as Transition, typeof body.reveal_hold_ms === "number" ? body.reveal_hold_ms : undefined));
      }
      if (request.method === "POST" && url.pathname.endsWith("/input")) {
        return json(await this.input(String(body.id), String(body.identity), body.kind as InputKind, body.value));
      }
      return json({ error: { code: "not_found", message: "No such RoomState route." } }, 404);
    } catch (err) {
      if (err instanceof InteractionError) return json({ error: { code: err.code, message: err.message } }, err.status);
      console.error("[roomstate]", err);
      return json({ error: { code: "internal_error", message: String(err) } }, 500);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async create(doc: InteractionDoc): Promise<{ interaction: Projected }> {
    if (!doc || typeof doc !== "object" || !doc.id) throw new InteractionError(400, "invalid_request", "doc required.");
    if (await this.load(doc.id)) throw new InteractionError(409, "interaction_exists", "That interaction already exists.");
    const live: Live = { doc: { ...doc, state: "open", version: 0 }, tally: emptyTally(doc.spec.options.map((o) => o.id)) };
    await this.save(live);
    await this.persist(live);
    this.publishState(live);
    return { interaction: project(live.doc, live.tally, "host") };
  }

  async transition(id: string, t: Transition, revealHoldMs?: number): Promise<{ interaction: Projected }> {
    const live = await this.load(id);
    if (!live) throw new InteractionError(404, "interaction_not_found", "No such interaction.");
    const now = Date.now();
    const doc = live.doc;
    // Arming a timed reveal: the client asks for `reveal` with a hold; the
    // SERVER flips to revealed when the alarm fires — never the client.
    if (t === "reveal" && doc.state === "collecting" && (revealHoldMs ?? doc.timing.reveal_hold_ms) > 0) {
      const at = now + (revealHoldMs ?? doc.timing.reveal_hold_ms);
      doc.timing = { ...doc.timing, reveal_at: new Date(at).toISOString() };
      doc.version += 1;
      await this.save(live);
      await this.armAlarm({ id, at, action: "reveal" });
      this.publishState(live);
      return { interaction: project(doc, live.tally, "host", now) };
    }
    const next = nextState(doc.state, t);
    if (next === doc.state && t === "open") return { interaction: project(doc, live.tally, "host", now) }; // idempotent re-open
    doc.state = next;
    doc.version += 1;
    if (next === "collecting") {
      doc.timing = { ...doc.timing, opened_at: new Date(now).toISOString() };
      if (doc.timing.collect_ms > 0) {
        const at = now + doc.timing.collect_ms + doc.timing.stream_delay_ms;
        doc.timing.reveal_at = new Date(at + doc.timing.reveal_hold_ms).toISOString();
        await this.armAlarm({ id, at: at + doc.timing.reveal_hold_ms, action: "reveal" });
      }
    }
    if (next === "revealed") {
      doc.timing = { ...doc.timing, revealed_at: new Date(now).toISOString() };
      if (doc.timing.close_after_ms > 0) await this.armAlarm({ id, at: now + doc.timing.close_after_ms, action: "close" });
    }
    if (next === "closed" || next === "cancelled") {
      doc.timing = { ...doc.timing, closed_at: new Date(now).toISOString() };
      await this.dropAlarms(id);
    }
    await this.save(live);
    await this.persist(live);
    this.publishState(live);
    return { interaction: project(doc, live.tally, "host", now) };
  }

  async input(id: string, identity: string, kind: InputKind, value: unknown): Promise<{ accepted: true; cooldown_until?: string } > {
    const live = await this.load(id);
    if (!live) throw new InteractionError(404, "interaction_not_found", "No such interaction.");
    if (live.doc.state !== "collecting") throw new InteractionError(409, "interaction_not_collecting", "This interaction is not taking inputs.");
    if (!live.doc.input.roles.includes(kind)) throw new InteractionError(403, "input_role", `${kind}s may not answer this one.`);
    const verdict = applyInput(live.tally, { identity, kind, value, now: Date.now(), cooldownMs: live.doc.input.cooldown_ms });
    if (!verdict.accepted) {
      const status = verdict.code === "rate_limited" ? 429 : verdict.code === "input_invalid" ? 422 : 409;
      const e = new InteractionError(status, verdict.code, verdict.code === "input_already_counted" ? "Already counted." : "Not a valid answer.");
      throw e;
    }
    live.tally = verdict.tally;
    await this.save(live);
    this.publishDelta(live.doc.id);
    return { accepted: true, ...(verdict.cooldown_until ? { cooldown_until: new Date(verdict.cooldown_until).toISOString() } : {}) };
  }

  // ── alarms ─────────────────────────────────────────────────────────────────

  private async armAlarm(a: Alarm): Promise<void> {
    const alarms = ((await this.state.storage.get<Alarm[]>("alarms")) ?? []).filter((x) => !(x.id === a.id && x.action === a.action));
    alarms.push(a);
    alarms.sort((x, y) => x.at - y.at);
    await this.state.storage.put("alarms", alarms);
    await this.state.storage.setAlarm(alarms[0].at);
  }

  private async dropAlarms(id: string): Promise<void> {
    const alarms = ((await this.state.storage.get<Alarm[]>("alarms")) ?? []).filter((x) => x.id !== id);
    await this.state.storage.put("alarms", alarms);
    if (alarms.length) await this.state.storage.setAlarm(alarms[0].at);
    else await this.state.storage.deleteAlarm();
  }

  /** At-least-once, may slip: the host renders countdowns from reveal_at and
   *  treats THIS as the authority for the state, not the clock. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const alarms = (await this.state.storage.get<Alarm[]>("alarms")) ?? [];
    const due = alarms.filter((a) => a.at <= now);
    const later = alarms.filter((a) => a.at > now);
    await this.state.storage.put("alarms", later);
    for (const a of due) {
      const live = await this.load(a.id);
      if (!live) continue;
      try {
        if (a.action === "reveal" && live.doc.state === "collecting") await this.transition(a.id, "reveal", 0);
        else if (a.action === "close" && (live.doc.state === "revealed" || live.doc.state === "collecting")) await this.transition(a.id, "close");
      } catch (err) {
        console.error("[roomstate] alarm transition failed", err);
      }
    }
    if (later.length) await this.state.storage.setAlarm(later[0].at);
  }

  // ── persistence (D1) ───────────────────────────────────────────────────────

  private async persist(live: Live): Promise<void> {
    const { doc } = live;
    const final = doc.state === "revealed" || doc.state === "closed" || doc.state === "cancelled";
    const sec = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
    try {
      await this.env.DB.prepare(
        `UPDATE interactions SET state = ?2, version = ?3, timing = ?4, result = ?5, opened_at = ?6, revealed_at = ?7, closed_at = ?8, updated_at = ?9
         WHERE id = ?1`,
      )
        .bind(
          doc.id,
          doc.state,
          doc.version,
          JSON.stringify(doc.timing),
          final ? JSON.stringify(publicTally(live.tally)) : null,
          sec(doc.timing.opened_at),
          sec(doc.timing.revealed_at),
          sec(doc.timing.closed_at),
          Math.floor(Date.now() / 1000),
        )
        .run();
      if (doc.state === "closed") {
        await recordInputAggregates(this.env, {
          roomId: doc.room_id,
          runId: doc.run_id,
          interactionId: doc.id,
          openedAt: doc.timing.opened_at ? Date.parse(doc.timing.opened_at) : Date.now(),
          closedAt: doc.timing.closed_at ? Date.parse(doc.timing.closed_at) : Date.now(),
          byKind: live.tally.by_kind,
        });
      }
    } catch (err) {
      console.error("[roomstate] persist failed", err);
    }
  }

  // ── fan-out ────────────────────────────────────────────────────────────────

  /** A state change goes out immediately, to everyone, projected per role. */
  private publishState(live: Live): void {
    const now = Date.now();
    this.publishRoom("interaction:host", project(live.doc, live.tally, "host", now));
    this.publishRoom("interaction:guest", project(live.doc, live.tally, "guest", now));
    this.sendAudience(project(live.doc, live.tally, "audience", now));
  }

  /** A tally change is coalesced: ≤ 10 Hz to the host, ≤ 4 Hz to phones. */
  private publishDelta(id: string): void {
    this.pendingHost.add(id);
    this.pendingAudience.add(id);
    if (!this.hostTimer) {
      this.hostTimer = setTimeout(() => {
        this.hostTimer = null;
        void this.flush("host");
      }, HOST_DELTA_MS);
    }
    if (!this.audienceTimer) {
      this.audienceTimer = setTimeout(() => {
        this.audienceTimer = null;
        void this.flush("audience");
      }, AUDIENCE_DELTA_MS);
    }
  }

  private async flush(which: "host" | "audience"): Promise<void> {
    const ids = which === "host" ? [...this.pendingHost] : [...this.pendingAudience];
    if (which === "host") this.pendingHost.clear();
    else this.pendingAudience.clear();
    const now = Date.now();
    for (const id of ids) {
      const live = await this.load(id);
      if (!live) continue;
      if (which === "host") {
        this.publishRoom("interaction:host", project(live.doc, live.tally, "host", now));
        this.publishRoom("interaction:guest", project(live.doc, live.tally, "guest", now));
      } else {
        this.sendAudience(project(live.doc, live.tally, "audience", now));
      }
    }
  }

  /** Host + guests ride the room's RealtimeHub channel. Best effort. */
  private publishRoom(channel: string, interaction: Projected): void {
    if (!this.env.REALTIME) return;
    const roomId = interaction.room_id;
    try {
      const stub = this.env.REALTIME.get(this.env.REALTIME.idFromName(roomChannelName(roomId)));
      void stub
        .fetch("https://do/publish", {
          method: "POST",
          body: JSON.stringify({ channels: [channel], action: "interaction", payload: interaction }),
        })
        .catch((err: unknown) => console.error("[roomstate] room publish failed", err));
    } catch (err) {
      console.error("[roomstate] room publish failed", err);
    }
  }

  private sendAudience(interaction: Projected): void {
    const frame = JSON.stringify({ type: "interaction", interaction, server_now: interaction.server_now });
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as AudienceSocket | null;
      if (a?.role !== "audience") continue;
      try {
        ws.send(frame);
      } catch {
        // dead socket
      }
    }
  }

  // ── audience sockets ───────────────────────────────────────────────────────

  /** Accept a phone. Attachment is tiny on purpose ({role, id}); a snapshot
   *  of everything live goes out first so a reconnecting phone is correct
   *  before the next delta. */
  async acceptAudience(request: Request): Promise<WebSocket> {
    const id = request.headers.get("X-Producer-User") ?? "";
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ role: "audience", id } satisfies AudienceSocket);
    const now = Date.now();
    const live = (await this.all()).filter(this.isLive);
    server.send(JSON.stringify({ type: "snapshot", interactions: live.map((l) => project(l.doc, l.tally, "audience", now)), server_now: now }));
    return client;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 256) return;
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    // Inputs travel over HTTP with the audience token (the contract's
    // route); the socket is read-only for a phone. Ping keeps the clock.
    if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong", server_now: Date.now() }));
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
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
