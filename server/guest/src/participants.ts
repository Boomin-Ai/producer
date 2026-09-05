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
  | "room.mute"
  | "room.remove";

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
