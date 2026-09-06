/** Browser-side room helpers. The document itself — types, parseConfig,
 * serializeConfig, migrateBuiltinsToExtras — lives in lib/roomConfig.ts
 * (DOM-free, tested from server/test) and is re-exported here. */

export * from "./roomConfig";

/** Which room is broadcasting right now (survives collapsing back to the
 * control room — the engine keeps streaming while the view goes away). */
const LIVE_ROOM_KEY = "producer.live_room";

export function markLiveRoom(id: string | null) {
  try {
    if (id) localStorage.setItem(LIVE_ROOM_KEY, id);
    else localStorage.removeItem(LIVE_ROOM_KEY);
  } catch {
    /* best effort */
  }
}

export function liveRoomId(): string | null {
  try {
    return localStorage.getItem(LIVE_ROOM_KEY);
  } catch {
    return null;
  }
}
