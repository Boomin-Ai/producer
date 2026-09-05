// Staged access changes → plain words and an ordered plan. Pure: no IPC, no
// React, so the server test suite can cover it (server/test/access.test.ts).
//
// The Access tab never applies a click; it stages it. This file turns one
// member's staged state (the surfaces they should end with, the room seat
// they should hold in each room) against what they hold now into
//   · a sentence a founder can read before confirming, e.g.
//     "Kleveland Bishop gains Canvas and Flows · loses Commerce ·
//      becomes Manager of Room · may connect channels"
//   · an ordered list of calls — surface grants, surface revokes, room
//     grants, room revokes, then the channel control last, since it is the
//     one grant that changes what the member can do to the brand's outside.

import type { RoomRole } from "./participants";

export interface MemberGrant {
  id: string;
  scope_type: "surface" | "folder" | "room" | string;
  surface_key: string | null;
  folder_id: string | null;
  room_id: string | null;
  role: string;
}

export interface Member {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "editor" | "viewer" | string;
  type: "team" | "collaborator" | string;
  created_at: string;
  grants: MemberGrant[];
}

/** The surfaces a collaborator can be scoped to. Mirrors the api's surface
 * registry as the console lists it; the key is what the grant row carries. */
export const SURFACES: { key: string; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "channels", label: "Channels" },
  { key: "content", label: "Content" },
  { key: "canvas", label: "Canvas" },
  { key: "connect", label: "Connect" },
  { key: "connect.inbox", label: "Inbox" },
  { key: "connect.contacts", label: "Contacts" },
  { key: "connect.entities", label: "Connect entities" },
  { key: "connect.network", label: "Network" },
  { key: "entities", label: "Entities" },
  { key: "flows", label: "Flows" },
  { key: "agents", label: "Agents" },
  { key: "commerce", label: "Commerce" },
];

/** The grant that lets a member connect / disconnect channels: the
 * `channels` surface. The API has no finer control today, so the surface
 * grant IS the channel control (Settings → Access → Channel controls). */
export const CHANNEL_CONTROL_SURFACE = "channels";

export const ROOM_ROLES: { role: RoomRole; grant: "admin" | "editor" | "viewer" | null; label: string }[] = [
  { role: "host", grant: null, label: "Host" },
  { role: "manager", grant: "admin", label: "Manager" },
  { role: "mod", grant: "editor", label: "Mod" },
  { role: "viewer", grant: "viewer", label: "Viewer" },
];


export type SeatRole = Exclude<RoomRole, "host">;

export interface RoomRef {
  sid: string;
  name: string;
}

/** What a member should end up with. Rooms map sid → seat role, "" = no seat. */
export interface Desired {
  surfaces: Set<string>;
  rooms: Record<string, SeatRole | "">;
}

export type AccessOp =
  | { kind: "surface.grant"; memberId: string; surfaceKey: string; label: string }
  | { kind: "surface.revoke"; memberId: string; grantId: string; surfaceKey: string; label: string }
  | { kind: "room.grant"; memberId: string; roomId: string; roomName: string; grant: "admin" | "editor" | "viewer"; label: string }
  | { kind: "room.revoke"; memberId: string; roomId: string; roomName: string; grantId: string; label: string };

export interface MemberChange {
  memberId: string;
  who: string;
  gains: string[];
  loses: string[];
  rooms: { sid: string; name: string; from: SeatRole | null; to: SeatRole | null; grant: MemberGrant | null }[];
  channels: "on" | "off" | null;
  ops: AccessOp[];
}

const surfaceLabel = (key: string) => SURFACES.find((s) => s.key === key)?.label ?? key;

export function surfaceGrant(m: Member, key: string): MemberGrant | null {
  return m.grants.find((g) => g.scope_type === "surface" && g.surface_key === key) ?? null;
}

export function heldSurfaces(m: Member): Set<string> {
  return new Set(m.grants.filter((g) => g.scope_type === "surface" && g.surface_key).map((g) => g.surface_key as string));
}

/** A member's seat in a room from their room grants alone (hosts are
 * handled by the caller — they hold no seat row). */
export function heldSeat(m: Member, sid: string): { role: SeatRole | null; grant: MemberGrant | null } {
  const g = m.grants.find((x) => x.scope_type === "room" && x.room_id === sid) ?? null;
  if (!g) return { role: null, grant: null };
  const role: SeatRole = g.role === "admin" || g.role === "owner" ? "manager" : g.role === "editor" ? "mod" : "viewer";
  return { role, grant: g };
}

export const seatLabel = (role: SeatRole) => ROOM_ROLES.find((r) => r.role === role)?.label ?? role;
const seatGrant = (role: SeatRole) => ROOM_ROLES.find((r) => r.role === role)?.grant ?? null;

/** Everything that differs between what `m` holds and `desired`. Null when
 * nothing does. Rooms not present in `desired.rooms` are left alone. */
export function diffMember(m: Member, desired: Desired, rooms: RoomRef[]): MemberChange | null {
  const who = m.name ?? m.email;
  const held = heldSurfaces(m);
  const ops: AccessOp[] = [];
  const gains: string[] = [];
  const loses: string[] = [];
  let channels: MemberChange["channels"] = null;

  const grantOps: AccessOp[] = [];
  const revokeOps: AccessOp[] = [];
  let channelOp: AccessOp | null = null;
  for (const sf of SURFACES) {
    const want = desired.surfaces.has(sf.key);
    const has = held.has(sf.key);
    if (want === has) continue;
    if (sf.key === CHANNEL_CONTROL_SURFACE) {
      channels = want ? "on" : "off";
      const g = surfaceGrant(m, sf.key);
      channelOp = want
        ? { kind: "surface.grant", memberId: m.id, surfaceKey: sf.key, label: "May connect channels" }
        : { kind: "surface.revoke", memberId: m.id, grantId: g?.id ?? "", surfaceKey: sf.key, label: "May no longer connect channels" };
      continue;
    }
    if (want) {
      gains.push(sf.label);
      grantOps.push({ kind: "surface.grant", memberId: m.id, surfaceKey: sf.key, label: `Grant ${sf.label}` });
    } else {
      loses.push(sf.label);
      const g = surfaceGrant(m, sf.key);
      revokeOps.push({ kind: "surface.revoke", memberId: m.id, grantId: g?.id ?? "", surfaceKey: sf.key, label: `Revoke ${sf.label}` });
    }
  }

  const roomChanges: MemberChange["rooms"] = [];
  const roomGrantOps: AccessOp[] = [];
  const roomRevokeOps: AccessOp[] = [];
  for (const r of rooms) {
    if (!(r.sid in desired.rooms)) continue;
    const to = desired.rooms[r.sid] || null;
    const cur = heldSeat(m, r.sid);
    if (cur.role === to) continue;
    roomChanges.push({ sid: r.sid, name: r.name, from: cur.role, to, grant: cur.grant });
    if (to) {
      const grant = seatGrant(to);
      if (grant) roomGrantOps.push({ kind: "room.grant", memberId: m.id, roomId: r.sid, roomName: r.name, grant, label: `${seatLabel(to)} of ${r.name}` });
    } else if (cur.grant) {
      roomRevokeOps.push({ kind: "room.revoke", memberId: m.id, roomId: r.sid, roomName: r.name, grantId: cur.grant.id, label: `Clear seat in ${r.name}` });
    }
  }

  ops.push(...grantOps, ...revokeOps, ...roomGrantOps, ...roomRevokeOps);
  if (channelOp) ops.push(channelOp);
  if (ops.length === 0 && roomChanges.length === 0) return null;
  return { memberId: m.id, who, gains, loses, rooms: roomChanges, channels, ops };
}

/** "A", "A and B", "A, B and C". */
export function joinWords(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** The change in one sentence, clauses joined by " · ". */
export function changeSentence(c: MemberChange): string {
  const parts: string[] = [];
  if (c.gains.length) parts.push(`gains ${joinWords(c.gains)}`);
  if (c.loses.length) parts.push(`loses ${joinWords(c.loses)}`);
  for (const r of c.rooms) {
    if (r.to) parts.push(`becomes ${seatLabel(r.to)} of ${r.name}`);
    else parts.push(`loses their seat in ${r.name}`);
  }
  if (c.channels === "on") parts.push("may connect channels");
  if (c.channels === "off") parts.push("may no longer connect channels");
  return `${c.who} ${parts.join(" · ")}`;
}

/** Every staged member, in the order given, dropping the unchanged. */
export function planChanges(members: Member[], staged: Record<string, Desired>, rooms: RoomRef[]): MemberChange[] {
  const out: MemberChange[] = [];
  for (const m of members) {
    const d = staged[m.id];
    if (!d) continue;
    const c = diffMember(m, d, rooms);
    if (c) out.push(c);
  }
  return out;
}

export { surfaceLabel };
