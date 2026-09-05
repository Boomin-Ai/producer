// Participants, grants and track labels — the PURE half of the room model.
//
// Shared verbatim by the guest pages (this bundle) and Producer's roster
// (src/lib/participants.ts re-exports it), and exercised by server/test so the
// two ends can never disagree about what a participant may do. DOM-free on
// purpose: the server's tsconfig has no DOM lib and this file is type-checked
// there too.
//
// Doctrine (docs: Rooms, Participants, Contributions §03): KIND answers "how
// strong is the identity", GRANTS answer "what can they do". Never conflate
// them — a visitor with media.screen shares their screen, a member without it
// does not.

/** The grant vocabulary the wire carries today. `room.*` are control grants
 *  a mod holds; the guest page never renders those. */
export type Grant =
  | "media.camera"
  | "media.mic"
  | "media.screen"
  | "media.return_feed"
  | "input.vote"
  | "input.text"
  | "input.hand"
  | "room.admit"
  | "room.stage"
  | "room.order"
  | "room.mute"
  | "room.remove"
  | "room.interactions"
  | "room.scene";

/** Every grant the wire knows. A server validates `POST guests/:id/grants`
 *  against this list; an unknown string is a 400, never a silent no-op. */
export const ALL_GRANTS: readonly Grant[] = [
  "media.camera",
  "media.mic",
  "media.screen",
  "media.return_feed",
  "input.vote",
  "input.text",
  "input.hand",
  "room.admit",
  "room.stage",
  "room.order",
  "room.mute",
  "room.remove",
  "room.interactions",
  "room.scene",
];

export const isGrant = (g: unknown): g is Grant => typeof g === "string" && (ALL_GRANTS as readonly string[]).includes(g);

/** What a participant holds when the server says nothing. This is the
 *  "Guest (default)" column of the grants table: appear, hear the show, take
 *  part — but never share a screen. An older server that does not send
 *  `grants` at all therefore behaves exactly as it did before grants existed. */
export const DEFAULT_GRANTS: readonly Grant[] = [
  "media.camera",
  "media.mic",
  "media.return_feed",
  "input.vote",
  "input.text",
  "input.hand",
];

/** A participant as either end sees it: the roster row Producer polls, or the
 *  `guest` object the guest page reads. Every field optional so a server that
 *  predates the field still resolves. */
export interface ParticipantLike {
  grants?: unknown;
  kind?: unknown;
  joined_via?: unknown;
  guest_brand?: unknown;
}

/** Grants as a Set. ABSENT → the default bundle. PRESENT (even empty) → exactly
 *  what the server said: an empty array is a participant who may do nothing,
 *  not a participant we should quietly upgrade. Non-string entries are
 *  dropped rather than failing the whole row. */
export function resolveGrants(p: ParticipantLike | null | undefined): Set<string> {
  const raw = p?.grants;
  if (!Array.isArray(raw)) return new Set(DEFAULT_GRANTS);
  return new Set(raw.filter((g): g is string => typeof g === "string" && g.length > 0));
}

export const hasGrant = (grants: ReadonlySet<string>, grant: Grant): boolean => grants.has(grant);

/** The controls a guest page may RENDER. A control the participant cannot use
 *  is not disabled, it does not exist — the host decides the panel. */
export interface GuestControls {
  camera: boolean;
  mic: boolean;
  screen: boolean;
  returnFeed: boolean;
  hand: boolean;
}

export function controlsFor(grants: ReadonlySet<string>): GuestControls {
  return {
    camera: grants.has("media.camera"),
    mic: grants.has("media.mic"),
    screen: grants.has("media.screen"),
    returnFeed: grants.has("media.return_feed"),
    hand: grants.has("input.hand"),
  };
}

/** The control bundle a MOD holds on the open server: the shared mod link
 *  mints exactly this (docs/CONTRIBUTIONS.md grants table, "Mod" column, plus
 *  `room.scene` — founder decision 2026-09-04: a mod cuts scenes in the first
 *  set of controls, not after). Never `room.end` / `room.settings`: host only.
 *  No media: a control seat appears nowhere on the set. */
export const MOD_GRANTS: readonly Grant[] = [
  "room.admit",
  "room.stage",
  "room.order",
  "room.remove",
  "room.interactions",
  "room.scene",
];

/** True when the participant may put media on the set at all. A row with no
 *  media grant (a mod seat) gets no render URL — nothing to render. */
export const hasAnyMedia = (grants: ReadonlySet<string>): boolean =>
  grants.has("media.camera") || grants.has("media.mic") || grants.has("media.screen");

// ── Kinds ────────────────────────────────────────────────────────────────────

export type ParticipantKind = "host" | "member" | "connection" | "producer" | "visitor" | "audience";

const KINDS: ReadonlySet<string> = new Set(["host", "member", "connection", "producer", "visitor", "audience"]);

/** Identity strength. Prefers an explicit `kind` (api #380 and later); falls
 *  back to `joined_via`, which is the backfill rule from the design doc:
 *  room_link → visitor, network → connection, invite → connection when a brand
 *  is attached, else visitor. Unknown → visitor, the weakest claim. */
export function participantKind(p: ParticipantLike | null | undefined): ParticipantKind {
  const k = typeof p?.kind === "string" ? p.kind : "";
  if (KINDS.has(k)) return k as ParticipantKind;
  const via = typeof p?.joined_via === "string" ? p.joined_via : "";
  if (via === "network") return "connection";
  if (via === "producer") return "producer";
  if (via === "invite" && p?.guest_brand) return "connection";
  return "visitor";
}

/** Short roster badge text per kind. */
export const KIND_LABEL: Record<ParticipantKind, string> = {
  host: "Host",
  member: "Member",
  connection: "Connection",
  producer: "Producer",
  visitor: "Visitor",
  audience: "Audience",
};

/** The badge text for a roster row: the kind, and for another Producer the
 *  origin it presented (`producer_ref`, display metadata — never verified). */
export function kindBadge(p: (ParticipantLike & { producer_ref?: unknown }) | null | undefined): string {
  const kind = participantKind(p);
  const ref = typeof p?.producer_ref === "string" ? p.producer_ref.trim() : "";
  if (kind === "producer" && ref && ref !== "producer") return `Producer @ ${ref.replace(/^https?:\/\//, "").slice(0, 40)}`;
  return KIND_LABEL[kind];
}

// ── Track labels ─────────────────────────────────────────────────────────────
//
// A guest may publish two video tracks on one connection: the camera and a
// screen share. WebRTC carries no semantic label, so the sending page announces
// one per MediaStream over signaling: {kind:"track", stream_id, label}. The
// receiving page matches `event.streams[0].id` (the msid, which every browser
// preserves through SDP) against what was announced.

export type TrackLabel = "camera" | "screen";

export interface TrackAnnouncement {
  kind: "track";
  stream_id: string;
  label: TrackLabel;
  /** True when the sender has stopped this stream for good. */
  ended?: boolean;
}

export const announceTrack = (streamId: string, label: TrackLabel, ended = false): TrackAnnouncement => ({
  kind: "track",
  stream_id: streamId,
  label,
  ...(ended ? { ended: true } : null),
});

/** Parse a signaling payload as a track announcement, or null. Tolerant of
 *  junk: a malformed frame from a modified client must never throw. */
export function parseTrackAnnouncement(payload: unknown): TrackAnnouncement | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== "track" || typeof p.stream_id !== "string" || !p.stream_id) return null;
  if (p.label !== "camera" && p.label !== "screen") return null;
  return { kind: "track", stream_id: p.stream_id, label: p.label, ...(p.ended === true ? { ended: true } : null) };
}

/** Which label an incoming video stream carries. UNLABELED → camera: a guest
 *  page from before labels existed only ever sent one video track, and it was
 *  the camera. A screen share is therefore never mistaken for a face, only
 *  ever the other way round on a stale client — the safe direction. */
export function labelForStream(labels: ReadonlyMap<string, TrackLabel>, streamId: string): TrackLabel {
  return labels.get(streamId) ?? "camera";
}

// ── Host peers on one signaling channel ──────────────────────────────────────
//
// Producer renders a guest's camera and screen as two browser sources, so two
// host pages share the guest's signaling channel. Each frame names the peer it
// belongs to; a frame without one is from a page older than screen share and
// belongs to the main (camera) peer.

export type HostPeer = "main" | "screen";

export function peerOf(payload: unknown): HostPeer {
  const p = payload && typeof payload === "object" ? (payload as { peer?: unknown }).peer : undefined;
  return p === "screen" ? "screen" : "main";
}

// ── Producer source ids ──────────────────────────────────────────────────────
//
// Producer names a guest's browser sources from the guest id: the camera
// source is `guest-<8 chars>` (unchanged since guests existed — slot bindings
// and scene looks reference it), and the screen source hangs a suffix off it.
// Pure so the roster and the reconcile loop can never disagree.

export function sourceIdsFor(guestId: string): { camera: string; screen: string } {
  const camera = `guest-${guestId.slice(0, 8)}`;
  return { camera, screen: `${camera}-screen` };
}

/** Which guest source ids the roster wants alive: the camera for every
 *  admitted guest, plus a screen source for those who hold media.screen. */
export function wantedSourceIds<T extends ParticipantLike & { id: string }>(
  admitted: readonly T[],
): Map<string, { guest: T; track: TrackLabel }> {
  const out = new Map<string, { guest: T; track: TrackLabel }>();
  for (const guest of admitted) {
    const ids = sourceIdsFor(guest.id);
    out.set(ids.camera, { guest, track: "camera" });
    if (resolveGrants(guest).has("media.screen")) out.set(ids.screen, { guest, track: "screen" });
  }
  return out;
}

// ── Room role, from the access route ─────────────────────────────────────────
//
// `GET /v1/app/live/rooms/:id/access` (api #380) says what THIS token may do
// in a room. Producer feature-detects it: a 404 means the server predates the
// route (or is self-hosted, where the primary token IS the host), and Producer
// behaves exactly as it did before — as the host. The DTO is read tolerantly
// because the contract owner is still settling it; every field is optional.

export type RoomRole = "host" | "manager" | "mod" | "viewer";

export interface RoomAccessResult {
  available?: unknown;
  /** Set by the desktop shell when the server answered 401/403: the route
   *  exists and REFUSED us — never the host, whatever else is missing. */
  denied?: unknown;
  access?: unknown;
}

/** The capability set Producer renders — the api's `can` object, verbatim
 *  (services/live/room-access.ts `roomCapabilities`). A badge and a guard
 *  read the same flags, so they can never disagree. */
export interface RoomCan {
  roster: boolean;
  control: boolean;
  manage: boolean;
  settings: boolean;
  interactions: boolean;
  scene: boolean;
  billing: boolean;
}

export interface RoomAccessInfo {
  role: RoomRole;
  /** org · brand · grant on Boomin; "server" when the primary token is the
   *  host (self-hosted, or a server without the route); "seat" for an open
   *  server mod link. */
  via: "org" | "brand" | "grant" | "server" | "seat" | "unknown";
  can: RoomCan;
  /** The route answered — false means "we assumed" (404, offline). */
  known: boolean;
}

const HOST_ROLES: ReadonlySet<string> = new Set(["host", "owner"]);
const MANAGER_ROLES: ReadonlySet<string> = new Set(["manager", "admin"]);
const MOD_ROLES: ReadonlySet<string> = new Set(["mod", "moderator", "editor"]);
/** Any of these (as a capability string, a `can.*` flag, or a grant) makes a
 *  non-host a mod: they can change who is on the broadcast. */
const CONTROL_KEYS: readonly string[] = ["admit", "stage", "remove", "control", "room.admit", "room.stage", "room.remove"];

function truthyKeys(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).filter(([, on]) => on === true).map(([k]) => k);
  }
  return [];
}

/** The capability bundle of a role, when the server sent none (mirrors the
 *  api's `roomCapabilities`, and the open server's MOD_GRANTS for a seat). */
export function capabilitiesOf(role: RoomRole): RoomCan {
  switch (role) {
    case "host":
      return { roster: true, control: true, manage: true, settings: true, interactions: true, scene: true, billing: false };
    case "manager":
      return { roster: true, control: true, manage: true, settings: false, interactions: true, scene: true, billing: false };
    case "mod":
      return { roster: true, control: true, manage: false, settings: false, interactions: true, scene: true, billing: false };
    default:
      return { roster: true, control: false, manage: false, settings: false, interactions: false, scene: false, billing: false };
  }
}

function readCan(v: unknown, role: RoomRole): RoomCan {
  const base = capabilitiesOf(role);
  if (!v || typeof v !== "object" || Array.isArray(v)) return base;
  const o = v as Record<string, unknown>;
  const flag = (k: keyof RoomCan) => (typeof o[k] === "boolean" ? (o[k] as boolean) : base[k]);
  return {
    roster: flag("roster"),
    control: flag("control"),
    manage: flag("manage"),
    settings: flag("settings"),
    interactions: flag("interactions"),
    scene: flag("scene"),
    billing: false,
  };
}

/** The whole answer: role, how it was earned, and what it may do. */
export function roomAccessFrom(result: RoomAccessResult | null | undefined): RoomAccessInfo {
  // Unknown or unavailable → the host, i.e. the behaviour before the route.
  if (!result || result.available !== true) {
    return { role: "host", via: "server", can: capabilitiesOf("host"), known: false };
  }
  if (result.denied === true) {
    return { role: "viewer", via: "unknown", can: capabilitiesOf("viewer"), known: true };
  }
  const a = (result.access && typeof result.access === "object" ? result.access : {}) as Record<string, unknown>;
  const role = typeof a.role === "string" ? a.role.toLowerCase() : "";
  const roles = truthyKeys(a.roles).map((r) => r.toLowerCase());
  const has = (set: ReadonlySet<string>) => set.has(role) || roles.some((r) => set.has(r));
  let out: RoomRole;
  if (a.is_host === true || a.host === true || has(HOST_ROLES)) out = "host";
  else if (has(MANAGER_ROLES)) out = "manager";
  else if (has(MOD_ROLES)) out = "mod";
  else {
    const keys = new Set([...truthyKeys(a.can), ...truthyKeys(a.capabilities), ...truthyKeys(a.grants)]);
    out = CONTROL_KEYS.some((k) => keys.has(k)) ? "mod" : "viewer";
  }
  const viaRaw = typeof a.via === "string" ? a.via.toLowerCase() : "";
  const via: RoomAccessInfo["via"] =
    viaRaw === "org" || viaRaw === "brand" || viaRaw === "grant" ? viaRaw : out === "host" ? "brand" : "unknown";
  return { role: out, via, can: readCan(a.can, out), known: true };
}

export function roomRoleFrom(result: RoomAccessResult | null | undefined): RoomRole {
  return roomAccessFrom(result).role;
}

/** An open-server mod seat (#47): the grants the seat holds, as the same DTO. */
export function seatAccessFrom(grants: Iterable<string>): RoomAccessInfo {
  const g = new Set(grants);
  const control = g.has("room.admit") || g.has("room.stage") || g.has("room.remove");
  return {
    role: control ? "mod" : "viewer",
    via: "seat",
    can: { roster: true, control, manage: false, settings: false, interactions: g.has("room.interactions"), scene: g.has("room.scene"), billing: false },
    known: true,
  };
}

/** What to SAY about a role — one line, the same on every screen. */
export function roleTitle(info: RoomAccessInfo, host?: string | null): string {
  if (info.via === "seat") return host ? `Mod seat on ${host}` : "Mod seat";
  switch (info.role) {
    case "host":
      return info.via === "org" ? "Host · via org" : info.via === "brand" ? "Host · via brand" : "Host";
    case "manager":
      return "Manager";
    case "mod":
      return "Mod";
    default:
      return "Viewer";
  }
}

/** The quiet chips under the title: what the role may do, in the words the
 *  doctrine uses (CONTRIBUTIONS.md grants). */
export function roleChips(info: RoomAccessInfo): string[] {
  const c = info.can;
  const out: string[] = [];
  if (info.role === "host") out.push("runs the show");
  if (c.scene) out.push("cuts scenes");
  if (c.control) out.push("admits guests");
  if (c.interactions) out.push("runs votes");
  if (c.manage) out.push("grants roles");
  if (c.settings) out.push("room settings");
  if (!c.control && !c.scene && c.roster) out.push("watches the roster");
  return out;
}

/** Move `id` one step up or down in an ordered list; unchanged if it can't. */
export function moveInOrder(order: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const out = [...order];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
