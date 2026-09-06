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
  /** A PROGRAM MONITOR (Boomin `POST /live/rooms/:id/monitor`): a seat's
   *  return-feed participant. True → never a guest source, never a slot,
   *  never a guests-panel row; the host only opens the return leg to it. */
  monitor?: unknown;
}

/** Is this roster row a seat's program monitor? Strictly `true`: an older
 *  server sends nothing, and nothing must read as "hide this guest". */
export const isMonitor = (p: ParticipantLike | null | undefined): boolean => p?.monitor === true;

/** Grants as a Set. ABSENT → the default bundle. PRESENT (even empty) → exactly
 *  what the server said: an empty array is a participant who may do nothing,
 *  not a participant we should quietly upgrade. Non-string entries are
 *  dropped rather than failing the whole row. */
export function resolveGrants(p: ParticipantLike | null | undefined): Set<string> {
  const raw = p?.grants;
  if (Array.isArray(raw)) return new Set(raw.filter((g): g is string => typeof g === "string" && g.length > 0));
  // Boomin's roster and session carry the bundle as a MAP ({grant: bool},
  // api participant-grants.ts); the open server as a list. Same set either
  // way — a map that says nothing is true is a participant who may do nothing.
  if (raw && typeof raw === "object") {
    return new Set(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => k.length > 0 && v === true).map(([k]) => k));
  }
  return new Set(DEFAULT_GRANTS);
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

/** A SEAT WITH MEDIA (the Jamie pattern): a program monitor row the host has
 *  handed camera / mic / screen. It stays a monitor (never a guests-panel
 *  row) but becomes ELIGIBLE for the set — a guest source, staged through
 *  the honest-staging path like anyone else. Without media it stays
 *  invisible to the set, exactly as before. */
export const isMediaSeat = (p: ParticipantLike | null | undefined): boolean => isMonitor(p) && hasAnyMedia(resolveGrants(p));

/** The person behind a monitor row: `display_name` is minted as
 *  "<name> · monitor" (api services/live/monitor.ts) — the board and the
 *  Mods panel show the name alone. */
export function seatDisplayName(p: { display_name?: unknown } | null | undefined): string {
  const raw = typeof p?.display_name === "string" ? p.display_name : "";
  return raw.replace(/\s*·\s*monitor\s*$/i, "").trim() || "Seat";
}

/** The label a MOD FEED wears on the host's set: "<name> — mod camera" /
 *  "<name> — mod screen". Never "· guest": a mod is not a guest (v0.4.32). */
export const modSourceLabel = (p: { display_name?: unknown } | null | undefined, track: TrackLabel): string =>
  `${seatDisplayName(p)} — mod ${track}`;

/** @deprecated v0.4.31 name; the camera feed's label. */
export const seatSourceLabel = (p: { display_name?: unknown } | null | undefined): string => modSourceLabel(p, "camera");

/** The user id a monitor row stands for (`producer_ref "monitor:<userId>"`),
 *  or null — display metadata, never a credential. */
export function seatUserId(p: (ParticipantLike & { producer_ref?: unknown }) | null | undefined): string | null {
  const ref = typeof p?.producer_ref === "string" ? p.producer_ref : "";
  return ref.startsWith("monitor:") && ref.length > 8 ? ref.slice(8) : null;
}

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

/** Which GUEST source ids the roster wants alive: the camera for every
 *  admitted guest, plus a screen source for those who hold media.screen.
 *  Program monitors are excluded entirely — a seat's media is a MOD source
 *  (below), never a guest source, never a guest slot. */
export function wantedSourceIds<T extends ParticipantLike & { id: string }>(
  admitted: readonly T[],
): Map<string, { guest: T; track: TrackLabel }> {
  const out = new Map<string, { guest: T; track: TrackLabel }>();
  for (const guest of admitted) {
    // A seat NEVER goes through the guest path (v0.4.32): its media is a
    // MOD source (wantedModSourceIds) — its own kind, layer and placement,
    // never a guest slot. A monitor without media is not a source at all.
    if (isMonitor(guest)) continue;
    const ids = sourceIdsFor(guest.id);
    out.set(ids.camera, { guest, track: "camera" });
    if (resolveGrants(guest).has("media.screen")) out.set(ids.screen, { guest, track: "screen" });
  }
  return out;
}

// ── MOD sources (v0.4.32) ─────────────────────────────────────────────────────
//
// A seated mod with media is an OFFICIAL SOURCE KIND on the host's set:
// `mod-<uuid8>` (camera + mic page) and `mod-<uuid8>-screen` (the share).
// It is not a guest: it never takes a guest slot, never counts toward slot
// math, sits ABOVE the guest slots and below overlays by default, and has its
// own placement rect (room doc `mod_feeds[participantId]`, lib/modFeed.ts).

export const MOD_SOURCE_PREFIX = "mod-";
export const isModSourceId = (id: string): boolean => id.startsWith(MOD_SOURCE_PREFIX);

export function modSourceIdsFor(participantId: string): { camera: string; screen: string } {
  const camera = `${MOD_SOURCE_PREFIX}${participantId.slice(0, 8)}`;
  return { camera, screen: `${camera}-screen` };
}

/** Which MOD source ids the roster wants alive: for every seat (monitor row)
 *  the host handed media, a camera page when it holds camera or mic (the
 *  camera page carries the mic), and a screen page when it holds
 *  media.screen. A seat without media, a guest, a non-monitor: nothing. */
export function wantedModSourceIds<T extends ParticipantLike & { id: string }>(
  rows: readonly T[],
): Map<string, { seat: T; track: TrackLabel }> {
  const out = new Map<string, { seat: T; track: TrackLabel }>();
  for (const seat of rows) {
    if (!isMediaSeat(seat)) continue;
    const g = resolveGrants(seat);
    const ids = modSourceIdsFor(seat.id);
    if (g.has("media.camera") || g.has("media.mic")) out.set(ids.camera, { seat, track: "camera" });
    if (g.has("media.screen")) out.set(ids.screen, { seat, track: "screen" });
  }
  return out;
}

/** Seat rows the Mods panel lists — ONE per (room, member). The api mints a
 *  fresh monitor row every time a seat reopens the room, so a roster can
 *  carry the same person twice (the old one ended, in grace). Rule: ended /
 *  left / revoked rows are hidden; among the rest, rows are keyed by the
 *  user behind them (`producer_ref` "monitor:<userId>", else the ref
 *  itself, else the row id) and the NEWEST ACCEPTED row wins — a row with a
 *  render url beats one without; later `joined_at` beats earlier. Order of
 *  the result follows the winner's first appearance. */
export function dedupeSeatRows<T extends ParticipantLike & { id: string; state?: unknown; render_url?: unknown; producer_ref?: unknown; joined_at?: unknown }>(
  rows: readonly T[],
): T[] {
  const gone = new Set(["left", "ended", "revoked", "declined", "expired"]);
  const key = (r: T): string => {
    const uid = seatUserId(r);
    if (uid) return `u:${uid}`;
    const ref = typeof r.producer_ref === "string" ? r.producer_ref.trim() : "";
    return ref ? `r:${ref}` : `i:${r.id}`;
  };
  const when = (r: T): number => {
    const t = typeof r.joined_at === "string" || typeof r.joined_at === "number" ? new Date(r.joined_at).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  const better = (a: T, b: T): boolean => {
    const ra = !!a.render_url;
    const rb = !!b.render_url;
    if (ra !== rb) return ra;
    return when(a) > when(b);
  };
  const order: string[] = [];
  const best = new Map<string, T>();
  for (const r of rows) {
    if (!isMonitor(r)) continue;
    if (typeof r.state === "string" && gone.has(r.state)) continue;
    const k = key(r);
    const cur = best.get(k);
    if (!cur) {
      order.push(k);
      best.set(k, r);
    } else if (better(r, cur)) {
      best.set(k, r);
    }
  }
  return order.map((k) => best.get(k)!);
}

/** One room-grant row as the access DTO lists them (`GET
 *  /live/rooms/:id/access` → `grants`, api room-access.ts listRoomGrants). */
export interface RoomGrantRowLike {
  room_role?: unknown;
  grant_role?: unknown;
  member?: { id?: unknown; role?: unknown; type?: unknown } | null;
  user?: { id?: unknown } | null;
}

/** A brand member as the team route lists them — the part the label needs. */
export interface MemberLike {
  user_id?: unknown;
  type?: unknown;
  role?: unknown;
}

export type SeatRoleLabel = "Host" | "Manager" | "Mod" | "Viewer";

/** The Mods panel's role label for a seat, from TRUTH and nothing else:
 *   1. a room grant on this room for the seat's user → its room_role
 *      (manager → Manager, mod → Mod, else Viewer);
 *   2. no grant: a TEAM member at editor or above is the brand's host
 *      standing → Host (they hold no grant row; the standing is implicit);
 *   3. otherwise Viewer.
 *  Never Host by default: an unknown seat is a viewer until the truth says
 *  more. */
export function seatRoleLabel(input: {
  seat: (ParticipantLike & { producer_ref?: unknown }) | null | undefined;
  grants: readonly RoomGrantRowLike[] | null | undefined;
  members: readonly MemberLike[] | null | undefined;
}): SeatRoleLabel {
  const uid = seatUserId(input.seat);
  if (!uid) return "Viewer";
  const g = (input.grants ?? []).find((x) => x?.user && x.user.id === uid);
  if (g) {
    const rr = typeof g.room_role === "string" ? g.room_role.toLowerCase() : "";
    if (rr === "manager") return "Manager";
    if (rr === "mod") return "Mod";
    if (rr === "host") return "Host";
    const gr = typeof g.grant_role === "string" ? g.grant_role.toLowerCase() : "";
    if (gr === "admin" || gr === "owner") return "Manager";
    if (gr === "editor") return "Mod";
    return "Viewer";
  }
  const m = (input.members ?? []).find((x) => x?.user_id === uid);
  if (m && m.type === "team" && (m.role === "owner" || m.role === "admin" || m.role === "editor")) return "Host";
  return "Viewer";
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
  via: "org" | "brand" | "surface" | "grant" | "server" | "seat" | "unknown";
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
    viaRaw === "org" || viaRaw === "brand" || viaRaw === "surface" || viaRaw === "grant" ? viaRaw : out === "host" ? "brand" : "unknown";
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

/** The banner every refused set edit shows — the same words as the panels. */
export const SET_IS_HOSTS = "The set is the host's";

/** May this seat edit the SET (sources, filters, transforms, mixer)? Only
 *  the host's engine is the stage: a mod or manager cuts scenes, runs the
 *  roster and votes, but never adds or removes what is on the picture.
 *  While a Boomin access route is still pending we assume NOT — flashing
 *  host chrome at a mod is worse than a beat of read-only at a host. */
export function setEditingAllowed(info: Pick<RoomAccessInfo, "role">, pending = false): boolean {
  return !pending && info.role === "host";
}

/** Should THIS Producer apply the room document to its OWN engine — local
 *  scenes, the camera, a screen capture, the mic, the virtual camera? Only
 *  the seat that runs the show. On a Boomin room the access route decides:
 *  until it has answered (or three misses assume the host) nothing local is
 *  applied — a mod's own webcam and desktop must never become "the picture"
 *  in a room whose picture is the host's. An open server has no route: the
 *  person who opened the room is its host (a mod there runs views/ModSeat). */
export type LocalSetDecision = "apply" | "wait" | "skip";
export function localSetDecision(opts: {
  boomin: boolean;
  answered: boolean;
  tries: number;
  role: RoomRole;
}): LocalSetDecision {
  if (!opts.boomin) return "apply";
  if (!opts.answered) return opts.tries >= 3 ? "apply" : "wait";
  return opts.role === "host" ? "apply" : "skip";
}

/** What to SAY about a role — one line, the same on every screen. */
export function roleTitle(info: RoomAccessInfo, host?: string | null): string {
  if (info.via === "seat") return host ? `Mod seat on ${host}` : "Mod seat";
  switch (info.role) {
    case "host":
      return info.via === "org" ? "Host · via org" : info.via === "brand" ? "Host · via brand" : info.via === "surface" ? "Host · via Live surface" : "Host";
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
