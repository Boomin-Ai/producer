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

import { ipc, listServerRooms, registerRoom, setServerRoomTitle, type LiveRoom, type ServerRoom } from "./ipc";
import { parseConfig, serializeConfig, type RoomConfig } from "./room";

export interface RoomSyncResult {
  /** Local room ids whose server row no longer exists (or never registered). */
  offNetwork: string[];
  /** Anything changed locally — the caller should reload its list. */
  changed: boolean;
}

/** Rooms the server considers gone; tolerant of whichever field it uses. */
function isRetired(r: ServerRoom): boolean {
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
  inflight = runSync(endpointId).finally(() => {
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
  const local = await ipc.liveListRooms(endpointId);
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
    if (claimed.has(srv.id) || isRetired(srv)) continue;
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
}
