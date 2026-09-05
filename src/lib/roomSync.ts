/** Room sync — the workspace's rooms live on the SERVER (web, deals, other
 * machines all mint them); the local live_rooms rows are this machine's
 * look/scene state attached to them. Endpoint-agnostic: a self-hosted
 * producer-server lists rooms at the same paths Boomin does (no brandSlug),
 * so sync runs for every endpoint kind. Reconcile on Home mount and on focus:
 *
 *  a. server room with no local row      → create a local row, origin=server
 *  b. local row with no server_room_id   → register (idempotent by external_ref)
 *  c. local row whose server row is gone → keep it, report it (chip on the card)
 *
 * Match by server id first, external_ref second. Idempotent: every branch
 * converges on the same rows, so repeated syncs never duplicate. Offline (no
 * endpoint, request fails) → no local writes at all. */

import {
  deleteServerRoom,
  guests,
  ipc,
  listServerRooms,
  registerRoom,
  setServerRoomTitle,
  type LiveRoom,
  type ServerRoom,
} from "./ipc";
import { PREF_ROOM_TOMBSTONES, prefGet, prefSet } from "./prefs";
import { parseConfig, serializeConfig, type RoomConfig } from "./room";

// ── Tombstones ───────────────────────────────────────────────────────────────
//
// A room deleted HERE must stay deleted. The server row is deleted too, but
// that call can fail (offline, a hosted API without the route, a replica that
// still lists it for a beat) — and pass 2 below would happily re-create the
// local row from the server's copy. So every delete leaves a tombstone: the
// server id and our external_ref, per endpoint. Sync skips tombstoned server
// rooms, retries the server delete while the server still lists them, and
// drops the tombstone once the server confirms the room is gone.

export interface RoomTombstone {
  endpoint_id: string;
  server_room_id?: string;
  external_ref?: string;
}

const TOMBSTONE_CAP = 200;

export async function loadTombstones(): Promise<RoomTombstone[]> {
  const raw = await prefGet(PREF_ROOM_TOMBSTONES);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (t): t is RoomTombstone =>
        !!t && typeof t === "object" && typeof (t as RoomTombstone).endpoint_id === "string",
    );
  } catch {
    return [];
  }
}

async function saveTombstones(list: RoomTombstone[]): Promise<void> {
  const trimmed = list.slice(-TOMBSTONE_CAP);
  await prefSet(PREF_ROOM_TOMBSTONES, trimmed.length ? JSON.stringify(trimmed) : null);
}

function tombstoneMatches(t: RoomTombstone, srv: ServerRoom): boolean {
  return (!!t.server_room_id && t.server_room_id === srv.id) || (!!t.external_ref && t.external_ref === srv.external_ref);
}

async function addTombstone(t: RoomTombstone): Promise<void> {
  const list = await loadTombstones();
  const dup = list.some(
    (x) => x.endpoint_id === t.endpoint_id && x.server_room_id === t.server_room_id && x.external_ref === t.external_ref,
  );
  if (!dup) await saveTombstones([...list, t]);
}

async function removeTombstone(t: RoomTombstone): Promise<void> {
  const list = await loadTombstones();
  await saveTombstones(
    list.filter((x) => !(x.endpoint_id === t.endpoint_id && x.server_room_id === t.server_room_id && x.external_ref === t.external_ref)),
  );
}

/** Fired on `window` after anything changes the room set — a sync that
 * registered or pulled rooms, a rename, a delete, a room created at Home.
 * Any view that lists rooms (Home, Settings → Access) re-reads on it, so
 * a room minted in one place shows up in the other without a relaunch. */
export const ROOMS_EVENT = "producer:rooms";
export function notifyRoomsChanged(): void {
  window.dispatchEvent(new Event(ROOMS_EVENT));
}

export interface RoomSyncResult {
  /** Local room ids whose server row no longer exists (or never registered). */
  offNetwork: string[];
  /** Anything changed locally — the caller should reload its list. */
  changed: boolean;
}

/** Rooms the server considers gone; tolerant of whichever field it uses. */
export function isRetired(r: ServerRoom): boolean {
  if (r.deleted_at || r.archived_at) return true;
  const st = (r.status ?? "").toLowerCase();
  return st === "archived" || st === "deleted" || st === "closed";
}

async function writeCfg(room: LiveRoom, patch: Partial<RoomConfig>) {
  // Read-modify-write against FRESH config: a room open in another view may
  // have saved a guest link or slot binding since we listed.
  const fresh = (await ipc.liveListRooms()).find((r) => r.id === room.id);
  const cfg = parseConfig(fresh?.config ?? room.config);
  await ipc.liveUpdateRoom(room.id, { config: serializeConfig({ ...cfg, ...patch }) });
}

let inflight: Promise<RoomSyncResult | null> | null = null;

/** Reconcile once; concurrent callers (mount + focus firing together) share
 * the same run rather than racing each other into duplicate local rows. */
export function syncRooms(endpointId: string | null | undefined): Promise<RoomSyncResult | null> {
  if (!endpointId) return Promise.resolve(null);
  if (inflight) return inflight;
  inflight = runSync(endpointId)
    .then((res) => {
      if (res?.changed) notifyRoomsChanged();
      return res;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function runSync(endpointId: string): Promise<RoomSyncResult | null> {
  let server: ServerRoom[];
  try {
    server = (await listServerRooms(endpointId)).rooms ?? [];
  } catch {
    // Offline or the endpoint is down: the local rows stay authoritative and
    // nothing is written. No "off network" verdicts either — we can't know.
    return null;
  }
  // Deleted-here rooms: retry the server delete while the server still lists
  // them, forget the ones it no longer does, and never pull any of them down.
  const tombstones = await loadTombstones();
  const mine = tombstones.filter((t) => t.endpoint_id === endpointId);
  const buried = new Set<string>();
  let tombstonesChanged = false;
  let remaining = tombstones;
  for (const t of mine) {
    const still = server.find((r) => tombstoneMatches(t, r));
    if (!still) {
      remaining = remaining.filter((x) => x !== t);
      tombstonesChanged = true;
      continue;
    }
    buried.add(still.id);
    if (!isRetired(still)) await deleteServerRoom(endpointId, still.id).catch(() => {});
  }
  if (tombstonesChanged) await saveTombstones(remaining);

  // Only rows that belong to THIS endpoint take part. A room belongs to one
  // workspace; syncing another workspace must neither register it there nor
  // clone it. (Legacy NULL rows were claimed at migration — store.rs v3.)
  const local = (await ipc.liveListRooms(endpointId)).filter((r) => !r.endpoint_id || r.endpoint_id === endpointId);
  const byId = new Map(server.map((r) => [r.id, r]));
  const byRef = new Map(server.filter((r) => r.external_ref).map((r) => [r.external_ref as string, r]));
  const claimed = new Set<string>();
  const offNetwork: string[] = [];
  let changed = false;

  // Pass 1 — local rows: attach, register, or flag.
  for (const room of local) {
    const cfg = parseConfig(room.config);
    let sid = cfg.server_room_id;
    let srv = sid ? byId.get(sid) : undefined;
    if (!srv) {
      // Registered elsewhere under our local id (a reinstall, or a row that
      // predates the cached id) — adopt it instead of registering again.
      const ref = byRef.get(room.id);
      if (ref && !claimed.has(ref.id)) srv = ref;
    }
    if (srv) {
      claimed.add(srv.id);
      const patch: Partial<RoomConfig> = {};
      if (sid !== srv.id) patch.server_room_id = srv.id;
      const vis = srv.visibility;
      if ((vis === "private" || vis === "connections" || vis === "public") && cfg.visibility !== vis) {
        patch.visibility = vis;
      }
      if (Object.keys(patch).length) {
        await writeCfg(room, patch);
        changed = true;
      }
      // A server-born room's title follows the server (renamed on the web).
      const title = (srv.title ?? "").trim();
      if (cfg.origin === "server" && title && title !== room.name) {
        await ipc.liveUpdateRoom(room.id, { name: title });
        changed = true;
      }
      continue;
    }
    if (sid) {
      // (c) we had a server id and the server no longer lists it.
      offNetwork.push(room.id);
      continue;
    }
    // (b) never registered: the existing lazy path, idempotent by external_ref.
    try {
      const reg = await registerRoom(endpointId, room.name, room.id);
      sid = reg.room.id;
      claimed.add(sid);
      await writeCfg(room, { server_room_id: sid });
      changed = true;
    } catch {
      // Registration is best-effort; the room keeps working locally.
    }
  }

  // Pass 2 — (a) server rooms nobody here owns: pull them down.
  for (const srv of server) {
    if (claimed.has(srv.id) || isRetired(srv) || buried.has(srv.id)) continue;
    const title = (srv.title ?? "").trim() || "Room";
    try {
      const created = await ipc.liveCreateRoom(title, endpointId);
      const vis = srv.visibility;
      await writeCfg(created, {
        server_room_id: srv.id,
        origin: "server",
        ...(vis === "private" || vis === "connections" || vis === "public" ? { visibility: vis } : {}),
      });
      claimed.add(srv.id);
      changed = true;
    } catch {
      // A failed create leaves no row behind; the next sync retries.
    }
  }

  return { offNetwork, changed };
}

/** Rename a room here AND on the network. The local write always happens;
 * the server PATCH is best-effort (offline → the next rename or a web edit
 * heals it). Never registers: an unregistered room has nothing to push to. */
export async function renameRoom(endpointId: string | null | undefined, room: LiveRoom, title: string): Promise<void> {
  const name = title.trim();
  if (!name || name === room.name) return;
  await ipc.liveUpdateRoom(room.id, { name });
  const sid = parseConfig(room.config).server_room_id;
  if (endpointId && sid) await setServerRoomTitle(endpointId, sid, name).catch(() => {});
  notifyRoomsChanged();
}

// ── Delete ───────────────────────────────────────────────────────────────────

export type RoomDeleteRefusal = { reason: string };

/** Who is in the room right now, by the server's roster. `null` = the room
 * has no server presence (never registered, or no endpoint) — nobody can be
 * in it. Offline → `null` as well: we cannot know, and the server will refuse
 * on its own if the delete reaches it later. */
export async function roomOccupancy(
  endpointId: string | null | undefined,
  room: LiveRoom,
): Promise<{ present: number; names: string[] } | null> {
  const sid = parseConfig(room.config).server_room_id;
  if (!endpointId || !sid) return null;
  try {
    const roster = (await guests.roster(endpointId, sid)).guests ?? [];
    const present = roster.filter((g) => g.state === "waiting" || g.state === "connected" || g.state === "admitted");
    return { present: present.length, names: present.map((g) => (g.display_name ?? "").trim()).filter(Boolean) };
  } catch {
    return null;
  }
}

/** Delete a room here AND on its server, so sync cannot bring it back.
 *
 *  1. Tombstone first (server id + our external_ref), so a crash between the
 *     server call and the local delete still converges on "gone".
 *  2. DELETE the server room. A REFUSAL (someone is in it / on air) wins:
 *     the tombstone is withdrawn and the room stays, with the server's reason.
 *     A transport failure or a missing route does not — the tombstone keeps
 *     sync honest until the server catches up.
 *  3. Delete the local row.
 *
 * Returns `null` on success, or the refusal to show inline. */
export async function deleteRoomEverywhere(
  endpointId: string | null | undefined,
  room: LiveRoom,
): Promise<RoomDeleteRefusal | null> {
  const sid = parseConfig(room.config).server_room_id;
  const epId = endpointId || room.endpoint_id || null;
  if (epId) {
    const stone: RoomTombstone = { endpoint_id: epId, ...(sid ? { server_room_id: sid } : {}), external_ref: room.id };
    await addTombstone(stone);
    if (sid) {
      try {
        const res = await deleteServerRoom(epId, sid);
        if (!res.ok) {
          await removeTombstone(stone);
          return { reason: res.message || "The network refused to delete this room." };
        }
      } catch {
        // Offline / no route: the tombstone carries the intent; sync retries.
      }
    }
  }
  await ipc.liveDeleteRoom(room.id);
  notifyRoomsChanged();
  return null;
}
