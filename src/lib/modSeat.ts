// A MOD SEAT on an open server (#47): Producer opened someone's mod link.
//
// No endpoint, no token — the mod code in the URL is the credential, exactly
// like a guest's invite code, so this talks to /v1/connect/mod/:code/*
// straight from the webview (the server answers CORS on that family). The
// server is the gate for every action; `grants` only decides what to draw.

import type { RoomGuest } from "./ipc";
import type { ControlSession } from "./roomControl";

export interface ModLink {
  origin: string;
  code: string;
}

/** `https://host/connect/mod/<code>` → { origin, code }; null if not a mod link. */
export function parseModLink(input: string): ModLink | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const m = /^\/connect\/mod\/([A-Za-z0-9_-]{8,})\/?$/.exec(u.pathname);
  if (!m || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  return { origin: u.origin, code: m[1] };
}

export interface ModBootstrap {
  seat: RoomGuest & { grants: string[] };
  room: { id: string; title: string | null };
  grants: string[];
  stage: { on_stage: string[]; version: number };
}

export interface ModRoster {
  guests: RoomGuest[];
  stage: { on_stage: string[]; version: number };
}

async function req<T>(link: ModLink, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${link.origin}/v1/connect/mod/${encodeURIComponent(link.code)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.error?.code ?? `HTTP ${res.status}`;
    throw new Error(res.status === 410 ? "This mod link was revoked." : msg);
  }
  return body as T;
}

export const modSeat = {
  bootstrap: (link: ModLink) => req<ModBootstrap>(link, ""),
  roster: (link: ModLink) => req<ModRoster>(link, "/guests"),
  admit: (link: ModLink, guestId: string) => req<unknown>(link, `/guests/${guestId}/admit`, { method: "POST", body: "{}" }),
  remove: (link: ModLink, guestId: string) => req<unknown>(link, `/guests/${guestId}/revoke`, { method: "POST", body: "{}" }),
  setStage: (link: ModLink, onStage: string[]) =>
    req<{ on_stage: string[]; version: number }>(link, "/stage", { method: "POST", body: JSON.stringify({ on_stage: onStage }) }),
  order: (link: ModLink, order: string[]) => req<unknown>(link, "/guest-order", { method: "POST", body: JSON.stringify({ order }) }),
  session: (link: ModLink) => req<ControlSession & { grants: string[] }>(link, "/session", { method: "POST", body: "{}" }),
};
