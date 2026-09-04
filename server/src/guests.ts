// Live room guests — rooms, join links, admit/revoke, the stage, signaling
// tickets. Ported from Boomin's hosted API (src/services/live/guests.ts) onto
// D1, minus everything that was Boomin-shaped: no brand or org scoping, no
// network knocks, no appearance deals. One deployment = one host.
//
// The contract with Producer (unchanged, so the desktop app needs no fork):
//
//   render URL:  {origin}/connect/guest/render/{guestId}?k={renderKey}
//   join URL:    {origin}/connect/guest/{inviteCode}
//   room link:   {origin}/connect/guest/room/{roomCode}
//
// ONE render URL PER GUEST. Each becomes its own browser source in Producer,
// which is what gives the host independent position/crop/z on the stage and
// an independent fader per guest. The render URL is STABLE FOREVER — a browser
// source's URL is fixed at creation — so it carries only a durable id and a
// DERIVED key; kicking someone is a server-side status flip, never a URL change.
//
// Secrets are stored hashed and returned exactly once.

import type { Env } from "./env";
import { randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import { SIGNAL_TICKET_TTL_SECONDS, signTicket } from "./ticket";

export type GuestStatus = "invited" | "waiting" | "accepted" | "declined" | "revoked" | "ended";
export type Quality = "good" | "degraded" | "failing";

export interface RoomRow {
  id: string;
  title: string | null;
  external_ref: string | null;
  config: string;
  guest_join_code_hash: string | null;
  guest_join_enabled: number;
  guest_auto_admit: number;
  guest_capacity: number;
  stage_guest_ids: string;
  stage_version: number;
  stage_capacity: number;
  host_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GuestRow {
  id: string;
  room_id: string;
  display_name: string;
  avatar_url: string | null;
  invite_code_hash: string;
  status: GuestStatus;
  joined_via: "invite" | "room_link";
  position: number | null;
  snapshot: string | null;
  peer_id: string;
  quality: Quality | null;
  quality_at: number | null;
  quality_stats: string | null;
  last_seen_at: number | null;
  accepted_at: number | null;
  admitted_at: number | null;
  declined_at: number | null;
  revoked_at: number | null;
  ended_at: number | null;
  stage_seconds: number;
  stage_since: number | null;
  created_at: number;
  updated_at: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);
export const iso = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString() : null);

/** Statuses where the slot is still live — the only ones a ticket may be minted for. */
const OPEN_STATUSES: GuestStatus[] = ["invited", "accepted"];

function requireSecret(env: Env): string {
  if (!env.SIGNALING_SECRET) {
    throw new ApiError(503, "realtime_unavailable", "SIGNALING_SECRET is not configured on this server.");
  }
  return env.SIGNALING_SECRET;
}

// ── URLs and the derived render key ──────────────────────────────────────────

/** The render key is DERIVED, never stored: sha256("guest-render:<id>:<secret>").
 *
 *  Guests walk in through the room link, so Producer has no stored copy of a
 *  once-only URL — the roster must return render_url on demand. Deriving beats
 *  both alternatives: storing a recoverable key puts live render secrets at
 *  rest, and minting per read would change the URL on every 3s poll and
 *  destroy the browser source's framing. Revocation never depended on this
 *  key: /guest-signal re-checks status at CONNECT time. */
export async function deriveRenderKey(env: Env, guestId: string): Promise<string> {
  return `gk_${(await sha256Hex(`guest-render:${guestId}:${requireSecret(env)}`)).slice(0, 40)}`;
}

export async function guestRenderUrlFor(env: Env, origin: string, guestId: string): Promise<string> {
  return `${origin}/connect/guest/render/${guestId}?k=${await deriveRenderKey(env, guestId)}`;
}
export const guestRoomJoinUrl = (origin: string, roomCode: string) => `${origin}/connect/guest/room/${roomCode}`;
export const guestJoinUrl = (origin: string, inviteCode: string) => `${origin}/connect/guest/${inviteCode}`;

// ── Rooms ────────────────────────────────────────────────────────────────────

export function publicRoom(room: RoomRow) {
  let config: unknown = {};
  try {
    config = JSON.parse(room.config);
  } catch {
    config = {};
  }
  // Same shape Boomin returns; the fields this server has no concept of are
  // pinned to their defaults rather than omitted, so a client reading them
  // sees a private, non-default camera room with no web-studio session.
  return {
    id: room.id,
    title: room.title,
    kind: "camera" as const,
    config,
    scheduled_at: null,
    visibility: "private" as const,
    is_default: false,
    external_ref: room.external_ref,
    session: null,
    created_at: iso(room.created_at),
  };
}

export async function loadRoom(env: Env, roomId: string): Promise<RoomRow> {
  const room = await env.DB.prepare("SELECT * FROM live_rooms WHERE id = ?1").bind(roomId).first<RoomRow>();
  if (!room) throw new ApiError(404, "room_not_found", "That room was not found.");
  return room;
}

export async function listRooms(env: Env): Promise<RoomRow[]> {
  const rows = await env.DB.prepare("SELECT * FROM live_rooms ORDER BY created_at").all<RoomRow>();
  return rows.results ?? [];
}

/** Idempotent by external_ref: presenting the same ref returns the same room
 *  instead of minting a duplicate on a retry, a reinstall, or a second machine. */
export async function createRoom(
  env: Env,
  input: { title: string; externalRef?: string | null },
): Promise<{ room: RoomRow; created: boolean }> {
  if (input.externalRef) {
    const existing = await env.DB.prepare("SELECT * FROM live_rooms WHERE external_ref = ?1")
      .bind(input.externalRef)
      .first<RoomRow>();
    if (existing) return { room: existing, created: false };
  }
  const id = crypto.randomUUID();
  const now = nowSec();
  // ON CONFLICT DO NOTHING covers the concurrent-registration race; the
  // winner's row is then the answer.
  const res = await env.DB.prepare(
    `INSERT INTO live_rooms (id, title, external_ref, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (external_ref) DO NOTHING`,
  )
    .bind(id, input.title, input.externalRef ?? null, now)
    .run();
  if (!res.meta.changes && input.externalRef) {
    const raced = await env.DB.prepare("SELECT * FROM live_rooms WHERE external_ref = ?1")
      .bind(input.externalRef)
      .first<RoomRow>();
    if (raced) return { room: raced, created: false };
  }
  return { room: await loadRoom(env, id), created: true };
}

export async function updateRoom(
  env: Env,
  roomId: string,
  patch: { title?: string; config?: Record<string, unknown> | null },
): Promise<RoomRow> {
  const room = await loadRoom(env, roomId);
  await env.DB.prepare("UPDATE live_rooms SET title = ?2, config = ?3, updated_at = ?4 WHERE id = ?1")
    .bind(
      room.id,
      patch.title !== undefined ? patch.title : room.title,
      patch.config !== undefined ? JSON.stringify(patch.config ?? {}) : room.config,
      nowSec(),
    )
    .run();
  return loadRoom(env, roomId);
}

/** Delete is refused while anyone is IN the room — waiting at the door or
 *  admitted (connected or within the reconnect grace). A room with people in
 *  it is a session, and a delete would drop them mid-show with no word; the
 *  host removes or revokes them first. Same verdict the roster shows, so the
 *  app can explain the refusal with the names it already has. */
export async function deleteRoom(env: Env, roomId: string): Promise<void> {
  const room = await loadRoom(env, roomId);
  const rows = await env.DB.prepare(
    "SELECT status, last_seen_at FROM live_room_guests WHERE room_id = ?1 AND status IN ('waiting', 'accepted')",
  )
    .bind(room.id)
    .all<Pick<GuestRow, "status" | "last_seen_at">>();
  const present = (rows.results ?? []).filter((g) => rosterState(g) !== "left").length;
  if (present > 0) {
    throw new ApiError(
      409,
      "room_occupied",
      present === 1 ? "Someone is in this room — remove them first." : `${present} people are in this room — remove them first.`,
      { present },
    );
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM live_room_guests WHERE room_id = ?1").bind(room.id),
    env.DB.prepare("DELETE FROM live_rooms WHERE id = ?1").bind(room.id),
  ]);
}

// ── Host presence ────────────────────────────────────────────────────────────

/** A roster poll every ~3 s → 45 s tolerates a dozen missed polls without
 *  flapping, and still closes a dead room fast. */
export const HOST_PRESENCE_WINDOW_MS = 45_000;
/** Stamps are throttled to one UPDATE per this many ms per room. */
export const HOST_PRESENCE_STAMP_MIN_MS = 10_000;

export function hostPresent(hostSeenAtSec: number | null | undefined, now = Date.now()): boolean {
  if (!hostSeenAtSec) return false;
  const age = now - hostSeenAtSec * 1000;
  return age >= 0 ? age < HOST_PRESENCE_WINDOW_MS : true;
}

/** Best-effort: a failed stamp must never fail the roster the host is waiting on. */
export async function touchHostPresence(env: Env, roomId: string): Promise<void> {
  try {
    const now = nowSec();
    await env.DB.prepare(
      "UPDATE live_rooms SET host_seen_at = ?2 WHERE id = ?1 AND (host_seen_at IS NULL OR host_seen_at < ?3)",
    )
      .bind(roomId, now, now - Math.floor(HOST_PRESENCE_STAMP_MIN_MS / 1000))
      .run();
  } catch (err) {
    console.error("[guests] host presence stamp failed", err);
  }
}

// ── Guests: invite, join, accept, admit, revoke ──────────────────────────────

async function loadGuest(env: Env, guestId: string): Promise<GuestRow | null> {
  return env.DB.prepare("SELECT * FROM live_room_guests WHERE id = ?1").bind(guestId).first<GuestRow>();
}

async function insertGuest(
  env: Env,
  input: {
    roomId: string;
    displayName: string;
    inviteCode: string;
    joinedVia: "invite" | "room_link";
    status: GuestStatus;
  },
): Promise<GuestRow> {
  const id = crypto.randomUUID();
  const now = nowSec();
  const admitted = input.status === "accepted";
  await env.DB.prepare(
    `INSERT INTO live_room_guests
       (id, room_id, display_name, invite_code_hash, status, joined_via, peer_id, accepted_at, admitted_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9)`,
  )
    .bind(
      id,
      input.roomId,
      input.displayName,
      await sha256Hex(input.inviteCode),
      input.status,
      input.joinedVia,
      // Stable across reconnects, so a reconnect is one participant, not ghosts.
      `guest_${crypto.randomUUID()}`,
      admitted ? now : null,
      now,
    )
    .run();
  return (await loadGuest(env, id))!;
}

/** Invite a named guest by link. The link goes to the guest, the render URL
 *  into Producer's browser source; both come back exactly once (the roster can
 *  re-derive render_url, the invite code is hashed). */
export async function inviteGuest(
  env: Env,
  origin: string,
  input: { roomId: string; displayName?: string | null },
): Promise<{ guest: GuestRow; invite_url: string; render_url: string }> {
  const room = await loadRoom(env, input.roomId);
  const displayName = input.displayName?.trim().slice(0, 80) || null;
  if (!displayName) throw new ApiError(400, "guest_name_required", "Give the guest a name — it labels their source.");
  const inviteCode = randomToken("gi_", 24);
  const guest = await insertGuest(env, { roomId: room.id, displayName, inviteCode, joinedVia: "invite", status: "invited" });
  return {
    guest,
    invite_url: guestJoinUrl(origin, inviteCode),
    render_url: await guestRenderUrlFor(env, origin, guest.id),
  };
}

/** Resolve a guest by the invite code from their join page. Unauthenticated by
 *  design — the code IS the credential. */
export async function guestByInviteCode(env: Env, inviteCode: string): Promise<GuestRow> {
  const guest = await env.DB.prepare("SELECT * FROM live_room_guests WHERE invite_code_hash = ?1")
    .bind(await sha256Hex(inviteCode))
    .first<GuestRow>();
  if (!guest) throw new ApiError(404, "guest_not_found", "This invite link is not valid.");
  assertUsable(guest);
  return guest;
}

/** Resolve a guest for the RENDER page. Same discipline, different secret: the
 *  render key never leaves the host's own Producer instance. */
export async function guestByRenderKey(env: Env, guestId: string, renderKey: string): Promise<GuestRow> {
  const expected = await deriveRenderKey(env, guestId);
  // Key checked BEFORE the lookup, so a wrong key cannot probe which ids exist.
  if (!renderKey || !timingSafeEqual(renderKey, expected)) {
    throw new ApiError(404, "guest_not_found", "This guest source is not valid.");
  }
  const guest = await loadGuest(env, guestId);
  if (!guest) throw new ApiError(404, "guest_not_found", "This guest source is not valid.");
  assertUsable(guest);
  return guest;
}

export function assertUsable(guest: Pick<GuestRow, "status">): void {
  // 'waiting' is usable: the render page resolves so the host can pre-frame the
  // slot, and the guest's own page works. Neither publishes to the stage until
  // the host admits.
  if (guest.status === "revoked") throw new ApiError(410, "guest_revoked", "This guest access was revoked.");
  if (guest.status === "declined") throw new ApiError(410, "guest_declined", "This invitation was declined.");
  if (guest.status === "ended") throw new ApiError(410, "guest_ended", "This appearance has ended.");
}

/** The guest accepts. Idempotent by design rather than a 409: a guest page on
 *  a flaky connection WILL retry this. Already accepted = success. */
export async function acceptGuest(env: Env, guestId: string): Promise<GuestRow> {
  const now = nowSec();
  const res = await env.DB.prepare(
    "UPDATE live_room_guests SET status = 'accepted', accepted_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'invited'",
  )
    .bind(guestId, now)
    .run();
  const row = await loadGuest(env, guestId);
  if (res.meta.changes && row) return row;
  if (row?.status === "accepted") return row;
  throw new ApiError(409, "guest_not_acceptable", "This invitation can no longer be accepted.");
}

export async function declineGuest(env: Env, guestId: string): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    "UPDATE live_room_guests SET status = 'declined', declined_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'invited'",
  )
    .bind(guestId, now)
    .run();
}

/** The host admits a waiting (or invited) guest. Until this, nothing they send
 *  can reach the broadcast. */
export async function admitGuest(env: Env, guestId: string): Promise<GuestRow> {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE live_room_guests
       SET status = 'accepted', accepted_at = ?2, admitted_at = ?2, snapshot = NULL, updated_at = ?2
     WHERE id = ?1 AND status IN ('waiting', 'invited')`,
  )
    .bind(guestId, now)
    .run();
  if (!res.meta.changes) throw new ApiError(404, "guest_not_found", "No such guest awaiting admission.");
  return (await loadGuest(env, guestId))!;
}

/** Kick. A server-side flip, deliberately: the host must not have to delete a
 *  browser source (and lose its framing) to remove someone. The render page's
 *  next ticket exchange fails, and /guest-signal refuses the reconnect. */
export async function revokeGuest(env: Env, guestId: string): Promise<GuestRow> {
  const now = nowSec();
  // Close an open stage segment: the appearance ends here.
  const res = await env.DB.prepare(
    `UPDATE live_room_guests
       SET status = 'revoked', revoked_at = ?2, snapshot = NULL, updated_at = ?2,
           stage_seconds = stage_seconds + COALESCE(MAX(0, ?2 - stage_since), 0),
           stage_since = NULL
     WHERE id = ?1 AND status IN ('invited', 'accepted', 'waiting')`,
  )
    .bind(guestId, now)
    .run();
  if (!res.meta.changes) throw new ApiError(404, "guest_not_found", "No such active guest.");
  return (await loadGuest(env, guestId))!;
}

// ── Room join link ───────────────────────────────────────────────────────────

/** Enable, rotate or disable the room's public join link. Rotating REVOKES
 *  everyone who walked in on the old code — that is the point of rotating —
 *  but NOT admitted guests unless `removeAdmitted` says so, because tearing a
 *  live panel off the air to remove one troll in the waiting list is worse
 *  than the problem. */
export async function setRoomJoinLink(
  env: Env,
  origin: string,
  input: { roomId: string; enabled: boolean; rotate?: boolean; autoAdmit?: boolean; removeAdmitted?: boolean },
): Promise<{ join_url: string | null; enabled: boolean; auto_admit: boolean }> {
  const room = await loadRoom(env, input.roomId);
  const rotating = !!input.rotate || (!room.guest_join_code_hash && input.enabled);
  const code = rotating ? randomToken("gr_", 18) : null;
  const now = nowSec();

  if (rotating) {
    const statuses = input.removeAdmitted ? "('waiting', 'accepted', 'invited')" : "('waiting', 'invited')";
    await env.DB.prepare(
      `UPDATE live_room_guests SET status = 'revoked', revoked_at = ?2, snapshot = NULL, updated_at = ?2,
         stage_seconds = stage_seconds + COALESCE(MAX(0, ?2 - stage_since), 0), stage_since = NULL
       WHERE room_id = ?1 AND joined_via = 'room_link' AND status IN ${statuses}`,
    )
      .bind(room.id, now)
      .run();
  }

  const autoAdmit = input.autoAdmit !== undefined ? (input.autoAdmit ? 1 : 0) : room.guest_auto_admit;
  await env.DB.prepare(
    `UPDATE live_rooms SET guest_join_enabled = ?2, guest_join_code_hash = ?3, guest_auto_admit = ?4, updated_at = ?5 WHERE id = ?1`,
  )
    .bind(room.id, input.enabled ? 1 : 0, code ? await sha256Hex(code) : room.guest_join_code_hash, autoAdmit, now)
    .run();

  return {
    // Readable only at rotation — the stored form is a hash.
    join_url: code ? guestRoomJoinUrl(origin, code) : null,
    enabled: input.enabled,
    auto_admit: autoAdmit === 1,
  };
}

/** A stranger opens the link and types a name. Unauthenticated by design —
 *  that is the entire feature. Defences: the code is the credential, capacity
 *  is enforced here, and they land in `waiting` unless auto-admit is on. */
export async function joinRoomByCode(
  env: Env,
  input: { roomCode: string; displayName: string; resumeCode?: string | null },
): Promise<{ guest: GuestRow; invite_code: string; resumed: boolean }> {
  const name = input.displayName.trim().slice(0, 80);
  if (!name) throw new ApiError(400, "guest_name_required", "Enter a name so the host knows who you are.");

  // RESUME an existing slot before creating a new one: a reload must not mint
  // a new guest id (= a new render_url = Producer destroys the source and the
  // host's framing). Doubles as the revoke blocklist: a revoked code fails here.
  if (input.resumeCode) {
    const existing = await env.DB.prepare("SELECT * FROM live_room_guests WHERE invite_code_hash = ?1")
      .bind(await sha256Hex(input.resumeCode))
      .first<GuestRow>();
    if (existing && existing.status !== "revoked" && existing.status !== "declined") {
      const now = nowSec();
      // Revive a slot that timed out; keep an admitted guest admitted.
      const revive = existing.status === "ended";
      await env.DB.prepare(
        `UPDATE live_room_guests SET display_name = ?2, last_seen_at = ?3, updated_at = ?3,
           status = CASE WHEN ?4 THEN 'waiting' ELSE status END,
           ended_at = CASE WHEN ?4 THEN NULL ELSE ended_at END
         WHERE id = ?1`,
      )
        .bind(existing.id, name, now, revive ? 1 : 0)
        .run();
      return { guest: (await loadGuest(env, existing.id))!, invite_code: input.resumeCode, resumed: true };
    }
  }

  const room = await env.DB.prepare("SELECT * FROM live_rooms WHERE guest_join_code_hash = ?1")
    .bind(await sha256Hex(input.roomCode))
    .first<RoomRow>();
  if (!room) throw new ApiError(404, "room_not_found", "This link is not valid.");
  if (!room.guest_join_enabled) throw new ApiError(410, "guest_link_disabled", "This link is no longer accepting guests.");

  // Capacity counts ADMITTED guests only. A waiting guest holds no connection
  // and costs nothing; counting them would let anyone with the link exhaust
  // the room without consuming a resource. On-stage guests are a subset of
  // the admitted, so promoting someone never frees a slot.
  if ((await admittedCount(env, room.id)) >= room.guest_capacity) {
    throw new ApiError(409, "guest_room_full", "This room is full right now. Ask the host to make space.");
  }

  const inviteCode = randomToken("gi_", 24);
  const guest = await insertGuest(env, {
    roomId: room.id,
    displayName: name,
    inviteCode,
    joinedVia: "room_link",
    status: room.guest_auto_admit ? "accepted" : "waiting",
  });
  return { guest, invite_code: inviteCode, resumed: false };
}

export async function admittedCount(env: Env, roomId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM live_room_guests WHERE room_id = ?1 AND status = 'accepted'",
  )
    .bind(roomId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// ── Signaling ────────────────────────────────────────────────────────────────

/** Free public STUN. Media is PEER-TO-PEER, so a guest costs this server
 *  nothing per minute. TURN (a relay for the ~10-20% of networks where direct
 *  traversal fails) is deliberately not configured by default — it is the only
 *  part of this that would cost money. Set ICE_SERVERS to add it. */
export const DEFAULT_ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

export function iceServers(env: Pick<Env, "ICE_SERVERS">): unknown[] {
  if (!env.ICE_SERVERS) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(env.ICE_SERVERS);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_ICE_SERVERS;
  } catch {
    // A malformed override must not take guests offline — fall back loudly.
    console.error("[guests] ICE_SERVERS is not valid JSON; using defaults");
    return DEFAULT_ICE_SERVERS;
  }
}

/** The room-level channel: one coordinator per ROOM holding the guests'
 *  sockets. Per-guest channels (`guest:<id>`) are right for host↔guest but
 *  cannot introduce guests to each other. */
export const roomChannelName = (roomId: string) => `liveroom:${roomId}`;
export const guestChannelName = (guestId: string) => `guest:${guestId}`;

/** Everything a peer needs to find the other one and connect DIRECTLY: a
 *  ticket to the same signaling channel plus ICE servers. Both sides address
 *  the SAME Durable Object (one per guest session), so "the other socket in
 *  here" is exactly the counterpart. */
export async function mintGuestSignaling(env: Env, guest: GuestRow, role: "host" | "guest") {
  const ticket = await signTicket(requireSecret(env), {
    sub: `${role}:${guest.id}`,
    aud: "guest-signal",
    expiresInSeconds: SIGNAL_TICKET_TTL_SECONDS,
  });
  // Behaviour-derived presence: asking for a ticket is real evidence someone
  // is arriving, unlike a heartbeat the desktop asserts.
  const now = nowSec();
  await env.DB.prepare("UPDATE live_room_guests SET last_seen_at = ?2, updated_at = ?2 WHERE id = ?1")
    .bind(guest.id, now)
    .run();
  return {
    ticket,
    channel: guestChannelName(guest.id),
    peerId: role === "host" ? `${guest.peer_id}_host` : guest.peer_id,
    role,
    iceServers: iceServers(env),
    expiresIn: SIGNAL_TICKET_TTL_SECONDS,
  };
}

export async function mintRoomTicket(env: Env, guest: GuestRow): Promise<string> {
  return signTicket(requireSecret(env), {
    sub: `${guest.room_id}:${guest.id}`,
    aud: "guest-room",
    expiresInSeconds: SIGNAL_TICKET_TTL_SECONDS,
  });
}

// ── Public projections ───────────────────────────────────────────────────────

/** Never leaks the hashes. `guest_brand` is always null here: there are no
 *  brands on a self-hosted server. */
export function publicGuest(guest: GuestRow) {
  return {
    id: guest.id,
    room_id: guest.room_id,
    display_name: guest.display_name,
    avatar_url: guest.avatar_url,
    guest_brand: null,
    is_link_guest: true,
    status: guest.status,
    invited_at: iso(guest.created_at),
    accepted_at: iso(guest.accepted_at),
    last_seen_at: iso(guest.last_seen_at),
  };
}

/** A guest is CONNECTED if it exchanged a signaling ticket (or reported
 *  quality) recently — evidence, not self-report. */
export const CONNECTED_WINDOW_MS = 15_000;
/** How long a departed guest stays on the roster, so a wifi blip does not
 *  cost the host a re-frame: Producer keeps the source alive meanwhile. */
export const LEFT_GRACE_MS = 90_000;
/** Past this a quality reading reports `unknown` rather than a stale value. */
export const QUALITY_FRESH_MS = 20_000;

export type RosterState = "waiting" | "invited" | "connected" | "admitted" | "left";

export function rosterState(guest: Pick<GuestRow, "status" | "last_seen_at">, now = Date.now()): RosterState {
  if (guest.status === "waiting") return "waiting";
  if (guest.status === "invited") return "invited";
  if (guest.status === "accepted") {
    const seen = guest.last_seen_at ? now - guest.last_seen_at * 1000 : Infinity;
    return seen <= CONNECTED_WINDOW_MS ? "connected" : "admitted";
  }
  return "left";
}

export function freshQuality(guest: Pick<GuestRow, "quality" | "quality_at">, now = Date.now()): Quality | "unknown" {
  if (!guest.quality || !guest.quality_at) return "unknown";
  return now - guest.quality_at * 1000 <= QUALITY_FRESH_MS ? guest.quality : "unknown";
}

/** The roster Producer polls (~3s). render_url is derived, so it comes back
 *  on EVERY read; only an ADMITTED guest gets one — a waiting guest must not
 *  be renderable, or the waiting room is decoration. The poll doubles as the
 *  host's heartbeat. */
export async function roomRoster(env: Env, origin: string, roomId: string) {
  await loadRoom(env, roomId);
  await touchHostPresence(env, roomId);
  const cutoff = nowSec() - Math.floor(LEFT_GRACE_MS / 1000);
  const rows = await env.DB.prepare(
    `SELECT * FROM live_room_guests
     WHERE room_id = ?1 AND (status IN ('invited', 'waiting', 'accepted') OR (status = 'ended' AND updated_at >= ?2))
     ORDER BY created_at DESC`,
  )
    .bind(roomId, cutoff)
    .all<GuestRow>();
  return Promise.all(
    (rows.results ?? []).map(async (g) => ({
      id: g.id,
      display_name: g.display_name,
      state: rosterState(g),
      joined_via: g.joined_via,
      render_url: g.status === "accepted" ? await guestRenderUrlFor(env, origin, g.id) : null,
      guest_brand: null,
      avatar_url: g.avatar_url,
      position: g.position,
      snapshot: g.snapshot,
      quality: freshQuality(g),
      joined_at: iso(g.created_at),
      last_seen_at: iso(g.last_seen_at),
    })),
  );
}

// ── The stage ────────────────────────────────────────────────────────────────

/** Set who is on stage. Producer is authoritative and calls this on every
 *  change. Persisted AND versioned, then pushed — never polled. Only ADMITTED
 *  guests of THIS room may be staged, so a stale client cannot put a departed
 *  guest into everyone's subscribe set. */
export async function setStage(
  env: Env,
  input: { roomId: string; onStage: string[] },
): Promise<{ on_stage: string[]; version: number }> {
  const room = await loadRoom(env, input.roomId);
  await touchHostPresence(env, room.id);

  const admitted = await env.DB.prepare(
    "SELECT id FROM live_room_guests WHERE room_id = ?1 AND status = 'accepted'",
  )
    .bind(room.id)
    .all<{ id: string }>();
  const allowed = new Set((admitted.results ?? []).map((g) => g.id));
  const onStage = [...new Set(input.onStage)].filter((id) => allowed.has(id));
  if (onStage.length > room.stage_capacity) {
    throw new ApiError(409, "stage_full", `A scene holds ${room.stage_capacity} guests.`);
  }

  const now = nowSec();
  const version = room.stage_version + 1;
  const placeholders = onStage.map((_, i) => `?${i + 3}`).join(", ");
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE live_rooms SET stage_guest_ids = ?2, stage_version = ?3, updated_at = ?4 WHERE id = ?1")
      .bind(room.id, JSON.stringify(onStage), version, now),
    // The on-stage clock: close the segment of every guest that just left the
    // stage, open one for every guest that just reached it. Both idempotent —
    // a re-publish of the same list touches nothing.
    env.DB.prepare(
      `UPDATE live_room_guests SET stage_seconds = stage_seconds + MAX(0, ?2 - stage_since), stage_since = NULL
       WHERE room_id = ?1 AND stage_since IS NOT NULL${onStage.length ? ` AND id NOT IN (${placeholders})` : ""}`,
    ).bind(room.id, now, ...onStage),
  ];
  if (onStage.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE live_room_guests SET stage_since = ?2 WHERE room_id = ?1 AND stage_since IS NULL AND id IN (${placeholders})`,
      ).bind(room.id, now, ...onStage),
    );
  }
  await env.DB.batch(statements);

  await publishStage(env, room.id, onStage, version);
  return { on_stage: onStage, version };
}

/** Fan the stage list out to every guest socket in the room. Best-effort: the
 *  list is persisted, so a failed push costs latency, not correctness. */
export async function publishStage(env: Env, roomId: string, onStage: string[], version: number): Promise<void> {
  if (!env.REALTIME) return;
  try {
    const stub = env.REALTIME.get(env.REALTIME.idFromName(roomChannelName(roomId)));
    await stub.fetch("https://do/publish", {
      method: "POST",
      body: JSON.stringify({ channels: ["stage"], action: "stage", payload: { on_stage: onStage, version } }),
    });
  } catch (err) {
    console.error("[guests] stage publish failed", err);
  }
}

export function parseStage(room: Pick<RoomRow, "stage_guest_ids" | "stage_version">): { on_stage: string[]; version: number } {
  let ids: unknown = [];
  try {
    ids = JSON.parse(room.stage_guest_ids);
  } catch {
    ids = [];
  }
  return { on_stage: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [], version: room.stage_version };
}

export async function currentStage(env: Env, roomId: string): Promise<{ on_stage: string[]; version: number }> {
  const room = await env.DB.prepare("SELECT stage_guest_ids, stage_version FROM live_rooms WHERE id = ?1")
    .bind(roomId)
    .first<Pick<RoomRow, "stage_guest_ids" | "stage_version">>();
  return room ? parseStage(room) : { on_stage: [], version: 0 };
}

/** Host-controlled slot order — explicit and stable. */
export async function setGuestPositions(env: Env, input: { roomId: string; order: string[] }): Promise<void> {
  if (!input.order.length) return;
  const now = nowSec();
  await env.DB.batch(
    input.order.map((guestId, index) =>
      env.DB.prepare("UPDATE live_room_guests SET position = ?3, updated_at = ?4 WHERE id = ?1 AND room_id = ?2")
        .bind(guestId, input.roomId, index, now),
    ),
  );
}

/** Record a quality sample from the render page. Also proof the render page is
 *  alive and talking to this guest, which is exactly what `connected` means. */
export async function reportQuality(
  env: Env,
  guestId: string,
  input: { quality: Quality; stats?: Record<string, unknown> },
): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    `UPDATE live_room_guests SET quality = ?2, quality_at = ?3, quality_stats = ?4, last_seen_at = ?3, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(guestId, input.quality, now, input.stats ? JSON.stringify(input.stats) : null)
    .run();
}
