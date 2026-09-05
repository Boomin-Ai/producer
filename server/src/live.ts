// Live rooms + guests — the routes. Same paths as Boomin's hosted API so the
// Producer desktop app and the guest pages need no fork. TWO route families
// with deliberately different auth:
//
//   /v1/app/live/…      — the HOST. Primary endpoint token ONLY. An
//                          automation token (agents, CLI, CI) must never be
//                          able to open a room to strangers, admit someone
//                          onto a live broadcast, or read render URLs.
//   /v1/connect/guest…  — the GUEST and the RENDERER. No bearer at all; the
//                          invite code / room code / render key IS the
//                          credential (high-entropy, stored hashed, revocable,
//                          scoped to exactly one guest slot).
//
// The public family is the point of the whole feature: guests on a self-hosted
// show have no account anywhere, and need none.

import { Hono } from "hono";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { requirePrimary, type TokenClass } from "./auth";
import { verifyTicket } from "./ticket";
import { closeInterval, listRun, openInterval, publicContribution, startRun, stopRun } from "./contributions";
import {
  acceptGuest,
  admitGuest,
  createModSeat,
  createRoom,
  mintControlTicket,
  currentStage,
  declineGuest,
  deleteRoom,
  guestByInviteCode,
  guestByRenderKey,
  guestChannelName,
  inviteGuest,
  joinRoomByCode,
  listRooms,
  loadRoom,
  parseStage,
  touchHostPresence,
  grantsOf,
  mintGuestSignaling,
  mintRoomTicket,
  publicGuest,
  publicRoom,
  reportQuality,
  revokeGuest,
  roomChannelName,
  roomRoster,
  setGuestPositions,
  setRoomJoinLink,
  setGrant,
  setStage,
  updateRoom,
  grantList,
  type GuestRow,
  type Quality,
} from "./guests";

type Vars = { tokenClass: TokenClass };
type App = Hono<{ Bindings: Env; Variables: Vars }>;

const origin = (url: string) => new URL(url).origin;

async function jsonBody<T extends Record<string, unknown>>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  const body = (await c.req.json().catch(() => null)) as T | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "The request body must be a JSON object.");
  }
  return body;
}

function stringList(value: unknown, max: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every((v) => typeof v === "string" && v.length <= 80)) {
    throw new ApiError(400, "invalid_request", `${field} must be an array of at most ${max} ids.`);
  }
  return value as string[];
}

// ── Host routes: /v1/app/live/* (primary token only) ─────────────────────────

export const liveHostRoutes: App = new Hono<{ Bindings: Env; Variables: Vars }>();

liveHostRoutes.use("*", async (c, next) => {
  requirePrimary(c.get("tokenClass"));
  return next();
});

liveHostRoutes.get("/rooms", async (c) => {
  const rooms = await listRooms(c.env);
  return c.json({ rooms: rooms.map(publicRoom) });
});

/** Idempotent by external_ref. Registration is lazy by contract: Producer
 *  creates rooms offline and only calls this the first time a room needs
 *  something server-side. */
liveHostRoutes.post("/rooms", async (c) => {
  const body = await jsonBody<{ title?: unknown; external_ref?: unknown }>(c);
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
  if (!title) throw new ApiError(400, "invalid_request", "title is required.");
  const externalRef = typeof body.external_ref === "string" ? body.external_ref.trim().slice(0, 200) || null : null;
  const { room, created } = await createRoom(c.env, { title, externalRef });
  return c.json({ room: publicRoom(room), created });
});

liveHostRoutes.patch("/rooms/:id", async (c) => {
  const body = await jsonBody<{ title?: unknown; config?: unknown }>(c);
  const patch: { title?: string; config?: Record<string, unknown> | null } = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) throw new ApiError(400, "invalid_request", "title must be a non-empty string.");
    patch.title = body.title.trim().slice(0, 80);
  }
  if (body.config !== undefined) {
    if (body.config !== null && (typeof body.config !== "object" || Array.isArray(body.config))) {
      throw new ApiError(400, "invalid_request", "config must be an object or null.");
    }
    if (body.config && JSON.stringify(body.config).length > 64 * 1024) {
      throw new ApiError(413, "invalid_request", "config is limited to 64 KB.");
    }
    patch.config = body.config as Record<string, unknown> | null;
  }
  const room = await updateRoom(c.env, c.req.param("id"), patch);
  return c.json({ room: publicRoom(room) });
});

liveHostRoutes.delete("/rooms/:id", async (c) => {
  await deleteRoom(c.env, c.req.param("id"));
  return c.json({ ok: true });
});

/** The roster Producer polls (~3s). Stamps host_seen_at. */
liveHostRoutes.get("/rooms/:id/guests", async (c) => {
  return c.json({ guests: await roomRoster(c.env, origin(c.req.url), c.req.param("id")) });
});

/** Producer publishes who is on stage. Authoritative, versioned, pushed. The
 *  server does NOT police the media path — it cannot, once peers hold a direct
 *  connection. It is authoritative about WHO IS ON STAGE; receivers enforce
 *  that by refusing to receive from anyone not on the list. */
liveHostRoutes.post("/rooms/:id/stage", async (c) => {
  const body = await jsonBody<{ on_stage?: unknown }>(c);
  const onStage = stringList(body.on_stage, 16, "on_stage");
  return c.json(await setStage(c.env, { roomId: c.req.param("id"), onStage }));
});

liveHostRoutes.post("/rooms/:id/guest-order", async (c) => {
  const body = await jsonBody<{ order?: unknown }>(c);
  await setGuestPositions(c.env, { roomId: c.req.param("id"), order: stringList(body.order, 32, "order") });
  return c.json({ ok: true });
});

/** Enable, rotate or disable the room's public join link. join_url is
 *  readable only at rotation — the stored form is a hash. */
liveHostRoutes.post("/rooms/:id/guest-link", async (c) => {
  const body = await jsonBody<{ enabled?: unknown; rotate?: unknown; auto_admit?: unknown; remove_admitted?: unknown }>(c);
  if (typeof body.enabled !== "boolean") throw new ApiError(400, "invalid_request", "enabled (boolean) is required.");
  const flag = (v: unknown, name: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") throw new ApiError(400, "invalid_request", `${name} must be a boolean.`);
    return v;
  };
  const result = await setRoomJoinLink(c.env, origin(c.req.url), {
    roomId: c.req.param("id"),
    enabled: body.enabled,
    rotate: flag(body.rotate, "rotate"),
    autoAdmit: flag(body.auto_admit, "auto_admit"),
    removeAdmitted: flag(body.remove_admitted, "remove_admitted"),
  });
  return c.json(result);
});

/** Invite by link. `guest_brand_id` (Boomin's brand-guest path) is refused
 *  here rather than ignored: silently turning a verified-brand invite into an
 *  anonymous link would misrepresent who the host thinks is coming. */
liveHostRoutes.post("/rooms/:id/guests", async (c) => {
  const body = await jsonBody<{ guest_brand_id?: unknown; display_name?: unknown; producer_ref?: unknown; kind?: unknown }>(c);
  if (body.kind === "member" || body.kind === "connection") {
    throw new ApiError(422, "network_unavailable", "member and connection participants need Boomin identities; this server knows visitor and producer.");
  }
  if (body.guest_brand_id) {
    throw new ApiError(
      422,
      "network_unavailable",
      "Brand guests live on the Boomin Network. A self-hosted room invites guests by link — send display_name only.",
    );
  }
  const result = await inviteGuest(c.env, origin(c.req.url), {
    roomId: c.req.param("id"),
    displayName: typeof body.display_name === "string" ? body.display_name : null,
    // `kind: producer` is honoured only as the presence of a producer_ref —
    // the ref IS what makes the row a Producer's; the kind is never asserted bare.
    producerRef: typeof body.producer_ref === "string" ? body.producer_ref : body.kind === "producer" ? "producer" : null,
  });
  // invite_url is returned EXACTLY ONCE (only its hash is stored); render_url
  // is derived and can be re-read from the roster.
  return c.json({ guest: publicGuest(result.guest), invite_url: result.invite_url, render_url: result.render_url }, 201);
});

liveHostRoutes.post("/guests/:id/admit", async (c) => {
  return c.json({ guest: publicGuest(await admitGuest(c.env, c.req.param("id"))) });
});

liveHostRoutes.post("/guests/:id/revoke", async (c) => {
  return c.json({ guest: publicGuest(await revokeGuest(c.env, c.req.param("id"))) });
});

/** Grant or revoke ONE grant (#46). `media.screen` is the higher grant a
 *  guest does not hold by default; this is where the host hands it out. */
liveHostRoutes.post("/guests/:id/grants", async (c) => {
  const body = await jsonBody<{ grant?: unknown; enabled?: unknown }>(c);
  if (typeof body.grant !== "string" || typeof body.enabled !== "boolean") {
    throw new ApiError(400, "invalid_request", "grant (string) and enabled (boolean) are required.");
  }
  const guest = await setGrant(c.env, c.req.param("id"), body.grant, body.enabled);
  return c.json({ guest: { ...publicGuest(guest), grants: grantList(guest) } });
});

/** The host mints a mod link (#47): a control seat another Producer opens. */
liveHostRoutes.post("/rooms/:id/mod-link", async (c) => {
  const body = await jsonBody<{ display_name?: unknown }>(c);
  const result = await createModSeat(c.env, origin(c.req.url), {
    roomId: c.req.param("id"),
    displayName: typeof body.display_name === "string" ? body.display_name : null,
  });
  // The URL is returned EXACTLY ONCE — only its hash is stored.
  return c.json({ guest: publicGuest(result.guest), mod_url: result.mod_url }, 201);
});

/** The room's control seats — the Moderators list. Revoke one with
 *  `POST guests/:id/revoke` like any participant. */
liveHostRoutes.get("/rooms/:id/mods", async (c) => {
  const room = await loadRoom(c.env, c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM live_room_guests WHERE room_id = ?1 AND seat = 'control' AND status = 'accepted' ORDER BY created_at DESC",
  )
    .bind(room.id)
    .all<GuestRow>();
  return c.json({ mods: (rows.results ?? []).map((g) => ({ ...publicGuest(g), grants: grantList(g) })) });
});

/** The host's Producer joins the room channel's CONTROL side: it publishes
 *  its scene list there and receives mods' scene cuts as frames. */
liveHostRoutes.post("/rooms/:id/control-session", async (c) => {
  const room = await loadRoom(c.env, c.req.param("id"));
  const s = await mintControlTicket(c.env, { roomId: room.id });
  return c.json({
    signaling_ticket: s.ticket,
    signaling_url: `/v1/connect/room-control?ticket=${encodeURIComponent(s.ticket)}`,
    peer_id: s.peerId,
    role: "host",
    expires_in: s.expiresIn,
  });
});

// ── The contribution ledger (#50) ────────────────────────────────────────────

/** The run's interval ledger. `run_id` (or `run`) limits to one run; absent =
 *  the open run, else the latest. Newest first; an open interval has
 *  ended_at null. */
liveHostRoutes.get("/rooms/:id/contributions", async (c) => {
  const room = await loadRoom(c.env, c.req.param("id"));
  const runId = c.req.query("run_id") ?? c.req.query("run") ?? null;
  const { run_id, rows } = await listRun(c.env, room.id, runId);
  return c.json({ contributions: rows.map(publicContribution), run_id });
});

/** Runs bracket a show: start when Producer goes live, stop at End. The
 *  stop closes every open interval; the client then reads the report. */
liveHostRoutes.post("/rooms/:id/runs", async (c) => {
  const body = await jsonBody<{ action?: unknown }>(c);
  const room = await loadRoom(c.env, c.req.param("id"));
  if (body.action === "start") {
    const stage = parseStage(room);
    return c.json(await startRun(c.env, room.id, stage.on_stage), 201);
  }
  if (body.action === "stop") return c.json(await stopRun(c.env, room.id));
  throw new ApiError(400, "invalid_request", "action must be start or stop.");
});

/** A host source with a binding (a sponsor's logo, a ticker) publishes show
 *  and hide; one overlay interval per (source, binding). */
liveHostRoutes.post("/rooms/:id/overlays", async (c) => {
  const body = await jsonBody<{ source_id?: unknown; binding?: unknown; shown?: unknown; label?: unknown }>(c);
  const room = await loadRoom(c.env, c.req.param("id"));
  if (typeof body.source_id !== "string" || !body.source_id || typeof body.shown !== "boolean") {
    throw new ApiError(400, "invalid_request", "source_id (string) and shown (boolean) are required.");
  }
  const rawBinding = body.binding && typeof body.binding === "object" && !Array.isArray(body.binding) ? (body.binding as Record<string, unknown>) : {};
  if (JSON.stringify(rawBinding).length > 2048) throw new ApiError(413, "invalid_request", "binding is limited to 2 KB.");
  const binding = { ...rawBinding, source_id: body.source_id };
  await touchHostPresence(c.env, room.id);
  const row = body.shown
    ? await openInterval(c.env, {
        roomId: room.id,
        participantId: null,
        kind: "overlay",
        binding,
        source: "host_stage",
        metadata: typeof body.label === "string" ? { label: body.label.slice(0, 80) } : {},
      })
    : await closeInterval(c.env, { roomId: room.id, participantId: null, kind: "overlay", binding });
  return c.json({ contribution: row ? publicContribution(row) : null });
});

/** What THIS token may do in the room (#47). One deployment = one host, and
 *  the primary token IS the host, so the answer is the host stub: everything
 *  but billing, which does not exist here. Mods on this server are not
 *  tokens — they are control seats behind the mod link (see modRoutes). */
liveHostRoutes.get("/rooms/:id/access", async (c) => {
  await loadRoom(c.env, c.req.param("id"));
  return c.json({
    role: "host",
    via: "token",
    can: { roster: true, control: true, manage: true, settings: true, billing: false },
    grants: null,
    implicit: true,
  });
});

// ── Public guest routes: /v1/connect/guest* (no bearer; the code is the credential)

export const connectGuestRoutes: App = new Hono<{ Bindings: Env; Variables: Vars }>();

/** A stranger opens the room link and types a name. They land in `waiting`
 *  unless the host turned on auto-admit, so nothing reaches the broadcast
 *  until a human says so. (Snapshot upload is not accepted in v1: the field
 *  is ignored rather than rejected so a Boomin-shaped page still joins.) */
connectGuestRoutes.post("/guest/room/:code/join", async (c) => {
  const body = await jsonBody<{ display_name?: unknown; resume_code?: unknown; producer_ref?: unknown }>(c);
  if (typeof body.display_name !== "string") throw new ApiError(400, "invalid_request", "display_name is required.");
  const resumeCode = typeof body.resume_code === "string" ? body.resume_code.trim().slice(0, 120) : null;
  const { guest, invite_code, resumed } = await joinRoomByCode(c.env, {
    roomCode: c.req.param("code"),
    displayName: body.display_name,
    resumeCode,
    producerRef: typeof body.producer_ref === "string" ? body.producer_ref : null,
  });
  // The guest keeps its own invite code so it can reconnect and poll its own
  // admission status without any session.
  return c.json({ guest: publicGuest(guest), invite_code, resumed }, resumed ? 200 : 201);
});

/** What the guest's join page renders before they agree to go on. */
connectGuestRoutes.get("/guest/:code", async (c) => {
  return c.json({ guest: publicGuest(await guestByInviteCode(c.env, c.req.param("code"))) });
});

connectGuestRoutes.post("/guest/:code/accept", async (c) => {
  const guest = await guestByInviteCode(c.env, c.req.param("code"));
  return c.json({ guest: publicGuest(await acceptGuest(c.env, guest.id)) });
});

connectGuestRoutes.post("/guest/:code/decline", async (c) => {
  const guest = await guestByInviteCode(c.env, c.req.param("code"));
  await declineGuest(c.env, guest.id);
  return c.json({ ok: true });
});

function signalingResponse(s: Awaited<ReturnType<typeof mintGuestSignaling>>) {
  return {
    signaling_ticket: s.ticket,
    signaling_url: `/v1/connect/guest-signal?ticket=${encodeURIComponent(s.ticket)}`,
    channel: s.channel,
    peer_id: s.peerId,
    role: s.role,
    ice_servers: s.iceServers,
    expires_in: s.expiresIn,
  };
}

/** The GUEST side's signaling ticket. Minted fresh on every call so the page
 *  can reconnect indefinitely. */
connectGuestRoutes.post("/guest/:code/session", async (c) => {
  const guest = await guestByInviteCode(c.env, c.req.param("code"));
  if (guest.status !== "accepted") throw new ApiError(409, "guest_not_accepted", "Accept the invitation before joining.");
  return c.json(signalingResponse(await mintGuestSignaling(c.env, guest, "guest")));
});

/** The guest page reports its screen share starting and stopping (#50):
 *  one media.screen interval per share. Opening needs the grant; the DO
 *  enforces the track itself, this is the ledger's view of it. */
connectGuestRoutes.post("/guest/:code/share", async (c) => {
  const guest = await guestByInviteCode(c.env, c.req.param("code"));
  const body = await jsonBody<{ active?: unknown }>(c);
  if (typeof body.active !== "boolean") throw new ApiError(400, "invalid_request", "active (boolean) is required.");
  if (guest.status !== "accepted") throw new ApiError(409, "guest_not_accepted", "Not in the room.");
  const binding = { track: "screen" };
  if (body.active) {
    if (!grantsOf(guest).has("media.screen")) throw new ApiError(403, "grant_required", "This guest may not share a screen.", { grant: "media.screen" });
    const row = await openInterval(c.env, { roomId: guest.room_id, participantId: guest.id, kind: "media.screen", binding, source: "participant" });
    return c.json({ contribution: publicContribution(row) });
  }
  const row = await closeInterval(c.env, { roomId: guest.room_id, participantId: guest.id, kind: "media.screen", binding });
  return c.json({ contribution: row ? publicContribution(row) : null });
});

/** The RENDER side's ticket — what Producer's browser source uses. NOT gated
 *  on acceptance: the host adds the source while building the show, long
 *  before the guest arrives; the page renders nothing until the guest
 *  publishes. This is why the ticket is not in the URL: a browser source's URL
 *  is fixed at creation, so an expiring token in it would kill the guest
 *  mid-show. The page calls this on load and on every reconnect instead. */
connectGuestRoutes.post("/guest/render/:id/session", async (c) => {
  const guest = await guestByRenderKey(c.env, c.req.param("id"), c.req.query("k") ?? "");
  const s = await mintGuestSignaling(c.env, guest, "host");
  return c.json({
    ...signalingResponse(s),
    display_name: guest.display_name,
    // The render page renders ONLY this one peer's media, and must never play
    // the host's own return audio locally, or it lands in the broadcast as echo.
    guest_status: guest.status,
  });
});

/** A guest's ticket to the ROOM channel: stage pushes, and guest↔guest
 *  introductions. Returns the CURRENT stage list so a joining client starts
 *  correct instead of waiting for the next push. */
connectGuestRoutes.post("/guest/:code/room-session", async (c) => {
  const guest = await guestByInviteCode(c.env, c.req.param("code"));
  if (guest.status !== "accepted") throw new ApiError(409, "guest_not_accepted", "Wait to be let in first.");
  const ticket = await mintRoomTicket(c.env, guest);
  return c.json({
    signaling_ticket: ticket,
    signaling_url: `/v1/connect/guest-room-signal?ticket=${encodeURIComponent(ticket)}`,
    peer_id: guest.id,
    stage: await currentStage(c.env, guest.room_id),
  });
});

/** The render page reports what it is actually receiving. Authorised by the
 *  render key, which only the host's own Producer holds — a guest cannot make
 *  a failing connection look healthy. */
connectGuestRoutes.post("/guest/render/:id/quality", async (c) => {
  const guest = await guestByRenderKey(c.env, c.req.param("id"), c.req.query("k") ?? "");
  const body = await jsonBody<{ quality?: unknown; stats?: unknown }>(c);
  if (body.quality !== "good" && body.quality !== "degraded" && body.quality !== "failing") {
    throw new ApiError(400, "invalid_request", "quality must be good, degraded, or failing.");
  }
  const stats = body.stats && typeof body.stats === "object" && !Array.isArray(body.stats) ? (body.stats as Record<string, unknown>) : undefined;
  await reportQuality(c.env, guest.id, { quality: body.quality as Quality, stats });
  return c.json({ ok: true });
});

async function loadGuestForUpgrade(env: Env, guestId: string): Promise<GuestRow | null> {
  return env.DB.prepare("SELECT * FROM live_room_guests WHERE id = ?1").bind(guestId).first<GuestRow>();
}

function requireUpgrade(c: { req: { header(name: string): string | undefined } }, env: Env): { realtime: DurableObjectNamespace; secret: string } {
  if (c.req.header("Upgrade") !== "websocket") throw new ApiError(426, "upgrade_required", "WebSocket upgrade required.");
  if (!env.REALTIME) throw new ApiError(503, "realtime_unavailable", "Signaling is not configured (REALTIME binding missing).");
  if (!env.SIGNALING_SECRET) throw new ApiError(503, "realtime_unavailable", "SIGNALING_SECRET is not configured.");
  return { realtime: env.REALTIME, secret: env.SIGNALING_SECRET };
}

/** The per-guest signaling channel — THE ONLY server infrastructure a guest
 *  connection touches, and it carries no media. Both peers present a ticket
 *  and land in the SAME Durable Object (one per guest session), so the hub's
 *  relay forwards each frame to exactly the counterpart.
 *
 *  Mounted at /guest-signal rather than /guest/signal on purpose: the latter
 *  sits inside the /guest/:code namespace. */
connectGuestRoutes.get("/guest-signal", async (c) => {
  const { realtime, secret } = requireUpgrade(c, c.env);
  const claims = await verifyTicket(secret, c.req.query("ticket") ?? "", "guest-signal");
  if (!claims) throw new ApiError(401, "invalid_ticket", "Signaling ticket is invalid or expired.");
  // sub is "<role>:<guestId>" — a peer can only ever reach its own session's channel.
  const [role, guestId] = claims.sub.split(":");
  if (!guestId || (role !== "host" && role !== "guest")) throw new ApiError(401, "invalid_ticket", "Signaling ticket is malformed.");

  // Re-check the guest is still live at CONNECT time, not just at mint time —
  // this is what makes a revoke actually kick someone.
  const row = await loadGuestForUpgrade(c.env, guestId);
  if (!row || row.status === "revoked" || row.status === "ended" || row.status === "declined") {
    throw new ApiError(410, "guest_unavailable", "This guest session is no longer active.");
  }

  const forwarded = new Request(c.req.url, c.req.raw);
  forwarded.headers.set("X-Producer-User", `${role}:${guestId}`);
  forwarded.headers.set("X-Producer-Room", row.room_id);
  forwarded.headers.set("X-Producer-Role", role);
  // Grants come from the ROW at connect, not the ticket: the ticket sealed
  // them at mint (≤ 120 s ago); the row is what a revoke since then changed.
  if (role === "guest") forwarded.headers.set("X-Producer-Grants", JSON.stringify(grantList(row)));
  return realtime.get(realtime.idFromName(guestChannelName(guestId))).fetch(forwarded);
});

/** The room channel upgrade. Same discipline: the ticket is pinned to one
 *  room and one guest, and status is re-checked at CONNECT. */
connectGuestRoutes.get("/guest-room-signal", async (c) => {
  const { realtime, secret } = requireUpgrade(c, c.env);
  const claims = await verifyTicket(secret, c.req.query("ticket") ?? "", "guest-room");
  if (!claims) throw new ApiError(401, "invalid_ticket", "Signaling ticket is invalid or expired.");
  const [roomId, guestId] = claims.sub.split(":");
  if (!roomId || !guestId) throw new ApiError(401, "invalid_ticket", "Signaling ticket is malformed.");

  const row = await loadGuestForUpgrade(c.env, guestId);
  if (!row || row.room_id !== roomId || row.status !== "accepted") {
    throw new ApiError(410, "guest_unavailable", "This guest session is no longer active.");
  }

  const forwarded = new Request(c.req.url, c.req.raw);
  // Identity is the GUEST id, which is what `to` targets when one guest offers to another.
  forwarded.headers.set("X-Producer-User", guestId);
  forwarded.headers.set("X-Producer-Room", roomId);
  forwarded.headers.set("X-Producer-Role", "guest");
  forwarded.headers.set("X-Producer-Grants", JSON.stringify(grantList(row)));
  return realtime.get(realtime.idFromName(roomChannelName(roomId))).fetch(forwarded);
});

/** The room channel's CONTROL side: the host's Producer (sub "host") or a
 *  mod seat (sub "control:<id>", grants sealed at mint and re-read from the
 *  row here). Same DO as the guests' room channel, so a cut is one hop. */
connectGuestRoutes.get("/room-control", async (c) => {
  const { realtime, secret } = requireUpgrade(c, c.env);
  const claims = await verifyTicket(secret, c.req.query("ticket") ?? "", "room-control");
  if (!claims || !claims.room) throw new ApiError(401, "invalid_ticket", "Control ticket is invalid or expired.");
  const forwarded = new Request(c.req.url, c.req.raw);
  forwarded.headers.set("X-Producer-Room", claims.room);
  if (claims.sub === "host") {
    forwarded.headers.set("X-Producer-User", "host");
    forwarded.headers.set("X-Producer-Role", "host");
  } else {
    const [kind, seatId] = claims.sub.split(":");
    if (kind !== "control" || !seatId) throw new ApiError(401, "invalid_ticket", "Control ticket is malformed.");
    const row = await loadGuestForUpgrade(c.env, seatId);
    if (!row || row.room_id !== claims.room || row.seat !== "control" || row.status !== "accepted") {
      throw new ApiError(410, "guest_unavailable", "This mod seat is no longer active.");
    }
    forwarded.headers.set("X-Producer-User", `control:${row.id}`);
    forwarded.headers.set("X-Producer-Role", "control");
    forwarded.headers.set("X-Producer-Grants", JSON.stringify(grantList(row)));
  }
  return realtime.get(realtime.idFromName(roomChannelName(claims.room))).fetch(forwarded);
});

// ── Static guest pages ───────────────────────────────────────────────────────
// /connect/guest/:code, /connect/guest/room/:code, /connect/guest/render/:id all
// serve the same single-page bundle from public/guest/index.html; the page
// reads its role and code from location.pathname.

export const guestPageRoutes: App = new Hono<{ Bindings: Env; Variables: Vars }>();

export async function guestPage(c: { env: Env; req: { url: string } }): Promise<Response> {
  if (!c.env.ASSETS) {
    return new Response("<h3>Guest pages are not deployed on this server.</h3>", {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const res = await c.env.ASSETS.fetch(new Request(`${origin(c.req.url)}/guest/index.html`));
  // Never cache: the page's code lives in the path, and a redeploy must land.
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

guestPageRoutes.get("/guest/room/:code", guestPage);
guestPageRoutes.get("/guest/render/:id", guestPage);
guestPageRoutes.get("/guest/:code", guestPage);
// The mod link lands on the same bundle: a browser shows "open this in
// Producer" with the link; Producer itself never loads the page — it reads
// the code off the URL and speaks /v1/connect/mod/:code directly.
guestPageRoutes.get("/mod/:code", guestPage);
