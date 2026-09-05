// Interactions (#51) — the routes. Two families, like the rest of live:
//
//   /v1/app/live/rooms/:id/interactions[/:ix]   — the HOST (primary token):
//       list, open, transition. The RoomState DO is authoritative; D1 keeps
//       the envelope + outcome.
//   /v1/app/live/rooms/:id/audience-link         — the host mints / rotates
//       the room's short audience code (/a/CODE).
//   /v1/connect/guest/:code/interactions/:ix/inputs — a GUEST's input; the
//       invite code is the credential, input.vote the grant.
//   /v1/connect/audience/:code/token             — the audience door: a
//       per-DEVICE capability token, no account, no email.
//   /v1/connect/audience/:code                   — the room probe a phone
//       reads before it opens a socket.
//   /v1/connect/audience/interactions/:ix/inputs — an input from a phone
//       (Authorization: Bearer <audience token>).
//   /v1/connect/audience-signal?token=           — the phone's hibernating
//       WebSocket to RoomState (state + tally, projected; read-only).
//
// Identity: `once` is enforced on sha256(sub : interaction : room-salt) —
// the DO never sees a sub, the tally never stores one.

import { Hono } from "hono";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { requirePrimary, type TokenClass } from "./auth";
import { sha256Hex } from "./crypto";
import { signTicket, verifyTicket } from "./ticket";
import { grantsOf, guestByInviteCode, hostPresent, loadRoom, type RoomRow } from "./guests";
import { InteractionError, parseInteractionCreate, type InteractionDoc, type Transition } from "./interactions/schema";
import type { InputKind } from "./interactions/tally";

type Vars = { tokenClass: TokenClass };
type App = Hono<{ Bindings: Env; Variables: Vars }>;

const nowSec = () => Math.floor(Date.now() / 1000);
const origin = (url: string) => new URL(url).origin;

async function jsonBody<T extends Record<string, unknown>>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  const body = (await c.req.json().catch(() => null)) as T | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "The request body must be a JSON object.");
  }
  return body;
}

// ── RoomState access ─────────────────────────────────────────────────────────

function roomStateStub(env: Env, roomId: string): DurableObjectStub {
  if (!env.ROOMSTATE) throw new ApiError(503, "interactions_unavailable", "Interactions are not configured (ROOMSTATE binding missing).");
  return env.ROOMSTATE.get(env.ROOMSTATE.idFromName(`roomstate:${roomId}`));
}

/** Call the DO and translate its error envelope back into an ApiError. */
async function roomStateCall<T>(env: Env, roomId: string, path: string, init?: RequestInit): Promise<T> {
  const res = await roomStateStub(env, roomId).fetch(`https://do${path}`, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "interaction_error", body?.error?.message ?? "Interaction call failed.");
  }
  return body as T;
}

const IX_ID = /^ix_[A-Za-z0-9]{12,}$/;
function ixParam(raw: string): string {
  if (!IX_ID.test(raw)) throw new ApiError(404, "interaction_not_found", "No such interaction.");
  return raw;
}

async function loadInteractionRow(env: Env, id: string): Promise<{ id: string; room_id: string; run_id: string | null; state: string }> {
  const row = await env.DB.prepare("SELECT id, room_id, run_id, state FROM interactions WHERE id = ?1")
    .bind(id)
    .first<{ id: string; room_id: string; run_id: string | null; state: string }>();
  if (!row) throw new ApiError(404, "interaction_not_found", "No such interaction.");
  return row;
}

/** The identity hash `once` is keyed on. Room-salted; never stored raw. */
async function identityHash(env: Env, sub: string, interactionId: string, roomId: string): Promise<string> {
  return (await sha256Hex(`${sub}:${interactionId}:${roomId}:${env.SIGNALING_SECRET ?? ""}`)).slice(0, 32);
}

async function submitInput(env: Env, row: { id: string; room_id: string }, sub: string, kind: InputKind, body: Record<string, unknown>) {
  const identity = await identityHash(env, sub, row.id, row.room_id);
  return roomStateCall<{ accepted: true; cooldown_until?: string }>(env, row.room_id, "/input", {
    method: "POST",
    body: JSON.stringify({ id: row.id, identity, kind, value: body.value }),
  });
}

// ── Host family ──────────────────────────────────────────────────────────────

export const interactionHostRoutes: App = new Hono<{ Bindings: Env; Variables: Vars }>();

interactionHostRoutes.use("*", async (c, next) => {
  requirePrimary(c.get("tokenClass"));
  return next();
});

/** The open run's interactions, projected for the host. Live ones come from
 *  the DO (running tally); archived ones from D1 with their final result. */
interactionHostRoutes.get("/rooms/:id/interactions", async (c) => {
  const room = await loadRoom(c.env, c.req.param("id"));
  const live = await roomStateCall<{ interactions: unknown[] }>(c.env, room.id, "/list?role=host");
  const liveIds = new Set((live.interactions as { id: string }[]).map((i) => i.id));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM interactions WHERE room_id = ?1 ORDER BY created_at DESC LIMIT 50",
  )
    .bind(room.id)
    .all<Record<string, unknown>>();
  const archived = (rows.results ?? [])
    .filter((r) => !liveIds.has(String(r.id)))
    .map((r) => ({
      id: r.id,
      room_id: r.room_id,
      run_id: r.run_id,
      type: r.type,
      state: r.state,
      version: r.version,
      spec: parse(r.spec),
      input: parse(r.input),
      visibility: parse(r.visibility),
      timing: parse(r.timing),
      render: parse(r.render, []),
      tally: r.result ? parse(r.result) : undefined,
      server_now: Date.now(),
    }));
  return c.json({ interactions: [...live.interactions, ...archived] });
});

const parse = (v: unknown, dflt: unknown = {}) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : dflt;
  } catch {
    return dflt;
  }
};

/** Open an interaction: validated here, envelope persisted, the DO takes it
 *  live in state `open`. `PATCH … {transition: "open"}` starts collecting. */
interactionHostRoutes.post("/rooms/:id/interactions", async (c) => {
  const room = await loadRoom(c.env, c.req.param("id"));
  const body = await jsonBody(c);
  let doc: InteractionDoc;
  try {
    doc = parseInteractionCreate(body, { roomId: room.id, runId: room.run_id });
  } catch (err) {
    if (err instanceof InteractionError) throw new ApiError(err.status, err.code, err.message);
    throw err;
  }
  const now = nowSec();
  await c.env.DB.prepare(
    `INSERT INTO interactions (id, room_id, run_id, type, state, spec, input, visibility, timing, render, version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)`,
  )
    .bind(doc.id, room.id, room.run_id, doc.type, JSON.stringify(doc.spec), JSON.stringify(doc.input), JSON.stringify(doc.visibility), JSON.stringify(doc.timing), JSON.stringify(doc.render), now)
    .run();
  const res = await roomStateCall<{ interaction: unknown }>(c.env, room.id, "/create", { method: "POST", body: JSON.stringify({ doc }) });
  return c.json(res, 201);
});

/** open · reveal · close · cancel. `revealed` is never set by a client: a
 *  reveal with a hold ARMS the alarm and the server flips the state. */
interactionHostRoutes.patch("/rooms/:id/interactions/:ix", async (c) => {
  const room = await loadRoom(c.env, c.req.param("id"));
  const ix = ixParam(c.req.param("ix"));
  const row = await loadInteractionRow(c.env, ix);
  if (row.room_id !== room.id) throw new ApiError(404, "interaction_not_found", "No such interaction in this room.");
  const body = await jsonBody<{ transition?: unknown; reveal_hold_ms?: unknown }>(c);
  const t = body.transition;
  if (t !== "open" && t !== "reveal" && t !== "close" && t !== "cancel") {
    throw new ApiError(400, "invalid_request", "transition must be open, reveal, close or cancel.");
  }
  const hold = typeof body.reveal_hold_ms === "number" && body.reveal_hold_ms >= 0 ? Math.min(60_000, Math.floor(body.reveal_hold_ms)) : undefined;
  const res = await roomStateCall<{ interaction: unknown }>(c.env, room.id, "/transition", {
    method: "POST",
    body: JSON.stringify({ id: ix, transition: t as Transition, reveal_hold_ms: hold }),
  });
  return c.json(res);
});

// ── The audience door (host side) ────────────────────────────────────────────

/** 4 uppercase consonants: typeable, no accidental words, ~200k live space.
 *  Resolvable only while the host is present. */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export function newAudienceCode(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}
export const audienceUrl = (origin: string, code: string) => `${origin}/a/${code}`;

interactionHostRoutes.post("/rooms/:id/audience-link", async (c) => {
  const room = await loadRoom(c.env, c.req.param("id"));
  const body = await jsonBody<{ rotate?: unknown }>(c);
  let code = room.audience_code;
  if (!code || body.rotate === true) {
    // Unique among rooms on this server — retry the 1-in-160k collision.
    for (let i = 0; i < 5; i++) {
      code = newAudienceCode();
      const clash = await c.env.DB.prepare("SELECT id FROM live_rooms WHERE audience_code = ?1 AND id != ?2").bind(code, room.id).first();
      if (!clash) break;
    }
    await c.env.DB.prepare("UPDATE live_rooms SET audience_code = ?2, updated_at = ?3 WHERE id = ?1").bind(room.id, code, nowSec()).run();
  }
  return c.json({ code, url: audienceUrl(origin(c.req.url), code!) });
});

// ── Connect family ───────────────────────────────────────────────────────────

export const interactionConnectRoutes: App = new Hono<{ Bindings: Env; Variables: Vars }>();

/** A guest answers. The invite code is the credential; input.vote the grant. */
interactionConnectRoutes.post("/guest/:code/interactions/:ix/inputs", async (c) => {
  const guest = await guestByInviteCode(c.env, c.req.param("code"));
  if (guest.status !== "accepted") throw new ApiError(409, "guest_not_accepted", "Not in the room.");
  if (!grantsOf(guest).has("input.vote")) throw new ApiError(403, "grant_required", "This guest may not vote.", { grant: "input.vote" });
  const row = await loadInteractionRow(c.env, ixParam(c.req.param("ix")));
  if (row.room_id !== guest.room_id) throw new ApiError(404, "interaction_not_found", "No such interaction in this room.");
  const body = await jsonBody(c);
  return c.json(await submitInput(c.env, row, `guest:${guest.id}`, "guest", body), 202);
});

async function roomByAudienceCode(env: Env, code: string): Promise<RoomRow> {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(clean)) throw new ApiError(404, "room_not_open", "No show at that code.");
  const room = await env.DB.prepare("SELECT * FROM live_rooms WHERE audience_code = ?1").bind(clean).first<RoomRow>();
  // The code resolves only while the host is present — a closed show is a
  // 404, not a room someone can sit in.
  if (!room || !hostPresent(room.host_seen_at)) throw new ApiError(404, "room_not_open", "No show at that code right now.");
  return room;
}

/** The room probe (INTERACTIVE.md §4.5): a phone reads this before it opens
 *  a socket. No identity involved. */
interactionConnectRoutes.get("/audience/:code", async (c) => {
  const room = await roomByAudienceCode(c.env, c.req.param("code"));
  return c.json({ open: true, room: { id: room.id, title: room.title }, full: false, locked: false, name_required: false, server_now: Date.now() });
});

export const AUDIENCE_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** The door: mint a per-DEVICE capability. `device_id`, replayed on
 *  reconnect, keeps the same identity hash so `once` survives a reload. */
interactionConnectRoutes.post("/audience/:code/token", async (c) => {
  const room = await roomByAudienceCode(c.env, c.req.param("code"));
  if (!c.env.SIGNALING_SECRET) throw new ApiError(503, "realtime_unavailable", "SIGNALING_SECRET is not configured.");
  const body = (await c.req.json().catch(() => ({}))) as { device_id?: unknown; display_name?: unknown };
  const device = typeof body.device_id === "string" && body.device_id.length >= 8 ? body.device_id.slice(0, 64) : crypto.randomUUID();
  const sub = `aud_${(await sha256Hex(`${device}:${room.id}:${c.env.SIGNALING_SECRET}`)).slice(0, 24)}`;
  const displayName = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 24) || null : null;
  const token = await signTicket(c.env.SIGNALING_SECRET, { sub, aud: "audience", room: room.id, kind: "audience", expiresInSeconds: AUDIENCE_TOKEN_TTL_SECONDS });
  return c.json(
    {
      token,
      expires_at: new Date((nowSec() + AUDIENCE_TOKEN_TTL_SECONDS) * 1000).toISOString(),
      room: { id: room.id, title: room.title },
      display_name: displayName,
      signaling_url: `/v1/connect/audience-signal?token=${encodeURIComponent(token)}`,
    },
    201,
  );
});

async function audienceClaims(c: { req: { header(n: string): string | undefined } }, env: Env) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!env.SIGNALING_SECRET) throw new ApiError(503, "realtime_unavailable", "SIGNALING_SECRET is not configured.");
  const claims = await verifyTicket(env.SIGNALING_SECRET, token, "audience");
  if (!claims || !claims.room) throw new ApiError(401, "invalid_token", "Audience token is invalid or expired.");
  return claims;
}

/** An input from a phone. Counted once per identity hash; 429 on the
 *  cooldown; the tally never stores the sub. */
interactionConnectRoutes.post("/audience/interactions/:ix/inputs", async (c) => {
  const claims = await audienceClaims(c, c.env);
  const row = await loadInteractionRow(c.env, ixParam(c.req.param("ix")));
  if (row.room_id !== claims.room) throw new ApiError(404, "interaction_not_found", "No such interaction in this room.");
  const body = await jsonBody(c);
  return c.json(await submitInput(c.env, row, claims.sub, "audience", body), 202);
});

/** The phone's socket: read-only, hibernating, state + tally projected for
 *  the audience, server_now in every frame. */
interactionConnectRoutes.get("/audience-signal", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") throw new ApiError(426, "upgrade_required", "WebSocket upgrade required.");
  if (!c.env.SIGNALING_SECRET) throw new ApiError(503, "realtime_unavailable", "SIGNALING_SECRET is not configured.");
  const claims = await verifyTicket(c.env.SIGNALING_SECRET, c.req.query("token") ?? "", "audience");
  if (!claims || !claims.room) throw new ApiError(401, "invalid_token", "Audience token is invalid or expired.");
  const forwarded = new Request(`https://do/audience-ws`, c.req.raw);
  forwarded.headers.set("X-Producer-User", claims.sub);
  forwarded.headers.set("X-Producer-Room", claims.room);
  return roomStateStub(c.env, claims.room).fetch(forwarded);
});
