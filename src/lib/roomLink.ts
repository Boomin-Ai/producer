// The room's guest link — the thing a host sends out. One helper for the room
// card, the room header and the Guests panel, so every place mints the same
// link the same way: register the local room with the ACTIVE workspace's
// server (idempotent by external_ref), ask for the join link, and mirror both
// into the room config so the next click is instant.

import { invoke } from "@tauri-apps/api/core";
import { guests, ipc, registerRoom, type LiveRoom } from "./ipc";
import { parseConfig, serializeConfig } from "./room";
import { resolveActiveEndpoint } from "./workspace";

/** The server stores only a hash of the join code, so a link is readable
 * exactly once — at mint. When the room already has a code but this machine
 * has no copy (fresh install, re-synced room), the enable call answers with
 * `join_url: null`; rotate to get a readable one. Waiting link guests are
 * revoked by the rotation, admitted ones stay. */
export async function mintJoinLink(endpointId: string, serverRoomId: string): Promise<string> {
  const first = await guests.joinLink(endpointId, serverRoomId);
  const url = first.join_url ?? first.url ?? null;
  if (url) return url;
  const rotated = await guests.joinLink(endpointId, serverRoomId, true);
  const url2 = rotated.join_url ?? rotated.url ?? null;
  if (!url2) throw new Error("The server did not return a link.");
  return url2;
}

export async function ensureRoomJoinLink(room: LiveRoom): Promise<string> {
  const cfg = parseConfig(room.config);
  if (cfg.guest_link) return cfg.guest_link;
  const ep = await resolveActiveEndpoint();
  if (!ep) throw new Error("Connect a workspace first.");
  let sid = cfg.server_room_id;
  if (!sid) {
    const reg = await registerRoom(ep.id, room.name, room.id);
    sid = reg.room.id;
  }
  const url = await mintJoinLink(ep.id, sid);
  // Read-modify-write against FRESH config (a slot binding saved meanwhile must survive).
  const fresh = (await ipc.liveListRooms()).find((r) => r.id === room.id);
  const now = parseConfig(fresh?.config ?? room.config);
  await ipc.liveUpdateRoom(room.id, { config: serializeConfig({ ...now, server_room_id: sid, guest_link: url }) });
  return url;
}

/** Copy to the clipboard. WKWebView refuses the async clipboard API in some
 * states (no page focus, no user-activation credit), so fall back to the
 * selection route, which the webview always honours from a click handler. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await invoke("copy_text", { text });
    return true;
  } catch {
    /* engine-less build — try the web routes */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
