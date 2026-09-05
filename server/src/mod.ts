// The control seat's routes (#47): /v1/connect/mod/:code/* — no bearer; the
// mod code IS the credential, exactly like a guest's invite code. Every
// route re-reads the seat row (revoke lands at the next call) and checks the
// grant the action needs. The server is the gate; Producer's UI only hides.
//
// What a seat can do here is the roster half. Scene cuts are FRAMES on the
// room channel (see scenes.ts / realtime.ts) — a mod opens the control
// socket with the ticket from POST /mod/:code/session.

import { Hono } from "hono";
import type { Env } from "./env";
import { ApiError } from "./errors";
import type { TokenClass } from "./auth";
import {
  admitGuest,
  currentStage,
  grantList,
  loadRoom,
  mintControlTicket,
  publicGuest,
  publicRoom,
  requireGrant,
  revokeGuest,
  roomRoster,
  seatByModCode,
  setGuestPositions,
  setStage,
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

/** A guest the seat acts on must be in the SEAT's room — a mod link for one
 *  room is not a key to another. */
async function guestInRoom(env: Env, roomId: string, guestId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT room_id, seat FROM live_room_guests WHERE id = ?1")
    .bind(guestId)
    .first<{ room_id: string; seat: string }>();
  if (!row || row.room_id !== roomId || row.seat !== "guest") throw new ApiError(404, "guest_not_found", "No such guest in this room.");
}

export const modRoutes: App = new Hono<{ Bindings: Env; Variables: Vars }>();

/** The seat's bootstrap: who am I, what may I do, which room, who is on stage. */
modRoutes.get("/mod/:code", async (c) => {
  const seat = await seatByModCode(c.env, c.req.param("code"));
  const room = await loadRoom(c.env, seat.room_id);
  return c.json({
    seat: { ...publicGuest(seat), grants: grantList(seat) },
    room: publicRoom(room),
    grants: grantList(seat),
    stage: await currentStage(c.env, room.id),
  });
});

/** The roster, as the host sees it (render URLs withheld: a seat never
 *  renders anyone). Does NOT stamp host presence — the seat is not the host. */
modRoutes.get("/mod/:code/guests", async (c) => {
  const seat = await seatByModCode(c.env, c.req.param("code"));
  const guests = (await roomRoster(c.env, origin(c.req.url), seat.room_id, { stampHost: false })).map((g) => ({
    ...g,
    // A mod may put someone on stage; it never gets the key to their feed.
    render_url: g.render_url ? "withheld" : null,
  }));
  return c.json({ guests, stage: await currentStage(c.env, seat.room_id) });
});

modRoutes.post("/mod/:code/guests/:id/admit", async (c) => {
  const seat = await seatByModCode(c.env, c.req.param("code"));
  requireGrant(seat, "room.admit");
  await guestInRoom(c.env, seat.room_id, c.req.param("id"));
  return c.json({ guest: publicGuest(await admitGuest(c.env, c.req.param("id"))) });
});

modRoutes.post("/mod/:code/guests/:id/revoke", async (c) => {
  const seat = await seatByModCode(c.env, c.req.param("code"));
  requireGrant(seat, "room.remove");
  await guestInRoom(c.env, seat.room_id, c.req.param("id"));
  return c.json({ guest: publicGuest(await revokeGuest(c.env, c.req.param("id"))) });
});

/** The FULL on-stage list, like the host's — the server filters to admitted
 *  guests of this room and enforces capacity. */
modRoutes.post("/mod/:code/stage", async (c) => {
  const seat = await seatByModCode(c.env, c.req.param("code"));
  requireGrant(seat, "room.stage");
  const body = await jsonBody<{ on_stage?: unknown }>(c);
  return c.json(await setStage(c.env, { roomId: seat.room_id, onStage: stringList(body.on_stage, 16, "on_stage"), stampHost: false }));
});

modRoutes.post("/mod/:code/guest-order", async (c) => {
  const seat = await seatByModCode(c.env, c.req.param("code"));
  requireGrant(seat, "room.order");
  const body = await jsonBody<{ order?: unknown }>(c);
  await setGuestPositions(c.env, { roomId: seat.room_id, order: stringList(body.order, 32, "order") });
  return c.json({ ok: true });
});

/** A ticket to the room channel's control side. Minted fresh on every call
 *  so the seat can reconnect indefinitely; grants re-read from the row. */
modRoutes.post("/mod/:code/session", async (c) => {
  const seat = await seatByModCode(c.env, c.req.param("code"));
  const s = await mintControlTicket(c.env, { roomId: seat.room_id, seat });
  return c.json({
    signaling_ticket: s.ticket,
    signaling_url: `/v1/connect/room-control?ticket=${encodeURIComponent(s.ticket)}`,
    peer_id: s.peerId,
    role: "control",
    grants: grantList(seat),
    expires_in: s.expiresIn,
  });
});
