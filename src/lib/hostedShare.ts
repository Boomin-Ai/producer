import { guests, ipc, type EndpointInfo } from "./ipc";
import { isBoomin } from "./workspace";
import { prefGet } from "./prefs";
import { PREF_SHARE_DOMAIN, shareDomain, audienceShareUrl, guestShareUrl } from "./shareDomain";

type SharePaths = { room_id: string; audience_path: string; guest_path: string };
async function paths(endpointId: string, roomId: string): Promise<SharePaths> {
  const result = await guests.request(endpointId, "GET", `/v1/app/live/rooms/${encodeURIComponent(roomId)}/share-links`);
  const body = result.body as SharePaths | undefined;
  if (result.status !== 200 || body?.room_id !== roomId || !body.audience_path || !body.guest_path)
    throw new Error("Could not load this room's share address. Reconnect and try again.");
  return body;
}

export async function hostedAudienceLink(endpointId: string, roomId: string): Promise<string> {
  const [links, preference] = await Promise.all([paths(endpointId, roomId), prefGet(PREF_SHARE_DOMAIN)]);
  return audienceShareUrl(shareDomain(preference), links.audience_path);
}

export async function formatGuestLink(input: EndpointInfo | string, roomId: string, original: string): Promise<string> {
  const endpoint = typeof input === "string" ? (await ipc.listEndpoints()).find(value => value.id === input) : input;
  if (!endpoint) throw new Error("Reconnect to the workspace before sharing a link.");
  if (!isBoomin(endpoint)) return original;
  const [links, preference] = await Promise.all([paths(endpoint.id, roomId), prefGet(PREF_SHARE_DOMAIN)]);
  return guestShareUrl(shareDomain(preference), links.guest_path, original);
}
