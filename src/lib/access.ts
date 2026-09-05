// The ACCESS surface: who may do what, on this workspace's server.
//
// Boomin (a brand-scoped endpoint) has accounts: members with a type and a
// role, per-surface grants, per-room roles (host · manager · mod · viewer —
// docs/ROOM_ACCESS.md in the api), invites by email. An open server has none
// of that: a mod is a CAPABILITY the host hands out (a mod link), a guest
// link is a door the host opens — CONTRIBUTIONS.md's four nouns, no others.
// Both talk through one IPC door (`guests.request`); this file knows the
// routes and their shapes, and nothing else does.

import { guests, type RoomGuest } from "./ipc";
import { roomAccessFrom, type RoomAccessInfo, type RoomRole } from "./participants";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function call<T>(endpointId: string, method: Method, path: string, body?: unknown): Promise<T> {
  const r = await guests.request(endpointId, method, path, body);
  if (!r.available) throw new Error("This server has no such route.");
  return r.body as T;
}

/** Same call, but a missing route answers null instead of throwing — for
 * the pieces a server may simply not have (2FA state, mod seats). */
async function maybe<T>(endpointId: string, method: Method, path: string, body?: unknown): Promise<T | null> {
  const r = await guests.request(endpointId, method, path, body);
  return r.available ? (r.body as T) : null;
}

// ── Boomin: you ───────────────────────────────────────────────────────────────

export interface Me {
  email: string | null;
  name: string | null;
  /** How this account signs in, when the API says (otp · google · …). */
  signInMethod: string | null;
  /** null = the API exposes no 2FA state; Producer then points at boomin.ai. */
  twoFactor: boolean | null;
  brandName: string | null;
  brandSlug: string | null;
  brandRole: string | null;
}

export async function fetchMe(endpointId: string): Promise<Me> {
  const raw = await call<Record<string, unknown>>(endpointId, "GET", "/v1/app/auth/me");
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const brand = (raw.brand ?? {}) as Record<string, unknown>;
  const bu = (raw.brand_user ?? raw.brandUser ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const tf = user.two_factor_enabled ?? user.twoFactorEnabled ?? user.mfa_enabled ?? raw.two_factor_enabled;
  return {
    email: str(user.email),
    name: str(user.name),
    signInMethod: str(user.auth_provider) ?? str(user.provider) ?? str(user.sign_in_method) ?? null,
    twoFactor: typeof tf === "boolean" ? tf : null,
    brandName: str(brand.name),
    brandSlug: str(brand.slug),
    brandRole: str(bu.role),
  };
}

// ── Boomin: the team ──────────────────────────────────────────────────────────

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

/** A member's standing in a room, from their brand role and room grants —
 * the client-side mirror of the api's resolveRoomRole. */
export function memberRoomRole(m: Member, roomId: string): { role: RoomRole | null; grant: MemberGrant | null } {
  if (m.role === "owner" || m.role === "admin" || m.role === "editor") return { role: "host", grant: null };
  const g = m.grants.find((x) => x.scope_type === "room" && x.room_id === roomId) ?? null;
  if (!g) return { role: null, grant: null };
  const role: RoomRole = g.role === "admin" || g.role === "owner" ? "manager" : g.role === "editor" ? "mod" : "viewer";
  return { role, grant: g };
}

export const team = {
  members: async (endpointId: string, brandId: string) =>
    (await call<{ members: Member[] }>(endpointId, "GET", `/v1/app/brands/${brandId}/members`)).members ?? [],
  /** Scope a member to a surface (idempotent). */
  grantSurface: (endpointId: string, brandId: string, memberId: string, surfaceKey: string) =>
    call<{ grants: MemberGrant[] }>(endpointId, "POST", `/v1/app/brands/${brandId}/members/${memberId}/grants`, {
      scopeType: "surface",
      surfaceKey,
    }),
  revokeGrant: (endpointId: string, brandId: string, memberId: string, grantId: string) =>
    call<{ success: boolean }>(endpointId, "DELETE", `/v1/app/brands/${brandId}/members/${memberId}/grants/${grantId}`),
  /** A room role for a member: the room-access door (a manager may use it
   * for their room; a brand admin may too). */
  setRoomRole: (endpointId: string, roomId: string, memberId: string, grant: "admin" | "editor" | "viewer") =>
    call<{ grant: { id: string } }>(endpointId, "POST", `/v1/app/live/rooms/${roomId}/access/grants`, { member_id: memberId, role: grant }),
  clearRoomRole: (endpointId: string, roomId: string, grantId: string) =>
    call<{ ok: boolean }>(endpointId, "DELETE", `/v1/app/live/rooms/${roomId}/access/grants/${grantId}`),
  invite: (
    endpointId: string,
    brandId: string,
    input: { email: string; type: "team" | "collaborator"; role: "admin" | "editor" | "viewer"; surfaces?: string[]; room?: { id: string; grant: "admin" | "editor" | "viewer" } },
  ) =>
    call<{ invite: unknown }>(endpointId, "POST", `/v1/app/brands/${brandId}/invites`, {
      email: input.email,
      type: input.type,
      role: input.role,
      grants: [
        ...(input.surfaces ?? []).map((surfaceKey) => ({ scopeType: "surface", surfaceKey })),
        ...(input.room ? [{ scopeType: "room", roomId: input.room.id, role: input.room.grant }] : []),
      ],
    }),
  /** The brand id behind a slug — members routes key on the id. */
  brandId: async (endpointId: string): Promise<string | null> => {
    const raw = await call<Record<string, unknown>>(endpointId, "GET", "/v1/app/auth/me");
    const brand = raw.brand as { id?: string } | undefined;
    return brand?.id ?? null;
  },
};

// ── Any server: my standing in a room ─────────────────────────────────────────

export async function myRoomAccess(endpointId: string, roomId: string): Promise<RoomAccessInfo> {
  const res = await guests.access(endpointId, roomId);
  return roomAccessFrom(res);
}

// ── Open server: mods and the guest door ──────────────────────────────────────

export interface ModSeatRow extends RoomGuest {
  grants?: string[];
}

export const mods = {
  /** Active control seats of a room (`GET rooms/:id/mods`); null when the
   * server predates mod links. */
  list: async (endpointId: string, roomId: string): Promise<ModSeatRow[] | null> => {
    const r = await maybe<{ mods?: ModSeatRow[] }>(endpointId, "GET", `/v1/app/live/rooms/${roomId}/mods`);
    return r ? (r.mods ?? []) : null;
  },
  /** A seat is a participant row: revoking it kills the link at its next exchange. */
  revoke: (endpointId: string, seatId: string) => guests.revoke(endpointId, seatId),
  mint: (endpointId: string, roomId: string, displayName?: string | null) => guests.modLink(endpointId, roomId, displayName ?? null),
};

export interface GuestDoor {
  join_url: string | null;
  enabled: boolean;
  auto_admit: boolean;
}

export const guestDoor = {
  set: (endpointId: string, roomId: string, input: { enabled: boolean; rotate?: boolean; auto_admit?: boolean }) =>
    call<GuestDoor>(endpointId, "POST", `/v1/app/live/rooms/${roomId}/guest-link`, input),
};
