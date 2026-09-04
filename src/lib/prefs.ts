// Durable app preferences — Rust-side SQLite (`prefs`, ipc::pref_get /
// pref_set), NOT localStorage: a "never show this again" must survive a
// webview cache clear and a reinstall over the same data dir.
//
// One event so a reset in Settings re-renders whatever keyed on the value.

import { hasTauri, ipc } from "./ipc";

export const PREFS_EVENT = "producer:prefs";

/** The self-hoster's "join the Boomin Network" card (NetworkRail). "1" once
 * dismissed; absent = show. Reset only from Settings. */
export const PREF_NETWORK_INVITE_DISMISSED = "network_invite_dismissed";

export async function prefGet(key: string): Promise<string | null> {
  if (!hasTauri()) return null;
  try {
    return await ipc.prefGet(key);
  } catch {
    return null;
  }
}

export async function prefSet(key: string, value: string | null): Promise<void> {
  if (!hasTauri()) return;
  try {
    await ipc.prefSet(key, value);
  } catch {
    /* a failed write shows the card once more next launch — nothing worse */
  }
  window.dispatchEvent(new Event(PREFS_EVENT));
}

/** Server rooms the user deleted HERE, so room sync never pulls them back
 * down when the server still lists them (offline at delete time, a hosted
 * API without the route, a slow replica). JSON array of
 * `{ endpoint_id, server_room_id?, external_ref? }`; see src/lib/roomSync.ts. */
export const PREF_ROOM_TOMBSTONES = "room_tombstones";
