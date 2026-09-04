// The ACTIVE WORKSPACE — which connected brand Producer is acting as.
//
// Endpoints are (base_url, brand_slug) rows sharing one user-scoped token, so a
// brand switch is just "which endpoint id every call uses". Rooms and
// destinations are scoped to it locally (store.rs v3); server rooms, guests,
// the knock and deals are already brand-scoped on the platform.
//
// One source of truth (localStorage) + one event, so the network rail, the
// room list and a room's own lookups all move together on a switch.

import { ipc, type EndpointInfo, type EndpointKind } from "./ipc";

/** The one derivation of what an endpoint is (mirrors ipc.rs
 * `endpoint_kind_of`): a brand scope ⇒ Boomin, otherwise self-hosted. Every
 * Boomin-only surface — network rail, deals, room visibility, "Enter the
 * show" — keys on this; guesting does NOT, it works on either. */
export function endpointKind(ep: EndpointInfo | null | undefined): EndpointKind | null {
  if (!ep) return null;
  if (ep.endpoint_kind) return ep.endpoint_kind;
  return ep.brand_slug ? "boomin" : "selfhost";
}

export const isBoomin = (ep: EndpointInfo | null | undefined) => endpointKind(ep) === "boomin";

const KEY = "producer.workspace.v1";
export const WORKSPACE_EVENT = "producer:workspace";

export function activeEndpointId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActiveEndpointId(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — the fallback resolver still picks one */
  }
  window.dispatchEvent(new Event(WORKSPACE_EVENT));
}

/** The active endpoint row, healing a stale choice: a disconnected workspace
 * falls back to the first connected one (then anything), and that fallback is
 * persisted so every caller agrees. */
export async function resolveActiveEndpoint(): Promise<EndpointInfo | null> {
  const eps = await ipc.listEndpoints();
  const wanted = activeEndpointId();
  const ep = eps.find((e) => e.id === wanted) ?? eps.find((e) => e.kind === "connected") ?? eps[0] ?? null;
  if (ep && ep.id !== wanted) {
    try {
      localStorage.setItem(KEY, ep.id);
    } catch {
      /* ignore */
    }
  }
  return ep;
}
