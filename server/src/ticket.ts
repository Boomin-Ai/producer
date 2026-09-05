// Signaling tickets — short-lived HS256 JWTs (same wire format Boomin mints,
// so the guest pages need no fork).
//
// A ticket is NOT an identity. It is a CAPABILITY for one live-room guest
// session: its holder may have no account anywhere, it carries no email, and
// it grants nothing beyond opening that one session's signaling WebSocket
// (aud "guest-signal" for the per-guest channel, "guest-room" for the room
// channel). Two minutes of life is enough to open a socket; the peer
// connection outlives the ticket entirely, so expiry can never drop a guest
// mid-show.

import { base64Url, base64UrlToBytes, hmacSign, hmacVerify } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Audiences:
//   guest-signal  — the per-guest channel (host page ↔ guest page)
//   guest-room    — the room channel, guest side (stage pushes, guest↔guest)
//   room-control  — the room channel, CONTROL side: the host's Producer and a
//                   mod seat. Carries the seat's grants so the room DO can
//                   refuse a scene cut from a seat without room.scene.
//   audience      — a per-DEVICE capability for the audience door (#51): no
//                   media, no roster row, lives as long as the show (≤ 12 h).
export type TicketAudience = "guest-signal" | "guest-room" | "room-control" | "audience";

export interface TicketClaims {
  sub: string;
  type: "guest";
  aud: TicketAudience;
  iat: number;
  exp: number;
  /** The participant's grants at mint. Re-read from the row at every
   *  exchange; a revoked row fails the next exchange regardless. */
  grants?: string[];
  /** Participant kind (identity strength) — display only, never a gate. */
  kind?: string;
  /** Room the ticket is pinned to (control + audience tickets). */
  room?: string;
}

export const SIGNAL_TICKET_TTL_SECONDS = 120;

export async function signTicket(
  secret: string,
  claims: { sub: string; aud: TicketAudience; expiresInSeconds?: number; grants?: readonly string[]; kind?: string; room?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64Url(
    encoder.encode(
      JSON.stringify({
        sub: claims.sub,
        type: "guest",
        aud: claims.aud,
        iat: now,
        exp: now + (claims.expiresInSeconds ?? SIGNAL_TICKET_TTL_SECONDS),
        ...(claims.grants ? { grants: [...claims.grants] } : {}),
        ...(claims.kind ? { kind: claims.kind } : {}),
        ...(claims.room ? { room: claims.room } : {}),
      } satisfies TicketClaims),
    ),
  );
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${await hmacSign(unsigned, secret)}`;
}

/** Verify signature, expiry, type AND audience. The audience check is what
 *  keeps a room ticket from opening a per-guest channel and vice versa. */
export async function verifyTicket(secret: string, token: string, aud: TicketAudience): Promise<TicketClaims | null> {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) return null;
  const valid = await hmacVerify(`${header}.${body}`, signature, secret).catch(() => false);
  if (!valid) return null;
  let claims: TicketClaims;
  try {
    claims = JSON.parse(decoder.decode(base64UrlToBytes(body))) as TicketClaims;
  } catch {
    return null;
  }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (claims.type !== "guest" || claims.aud !== aud || typeof claims.sub !== "string") return null;
  if (claims.grants !== undefined && !(Array.isArray(claims.grants) && claims.grants.every((g) => typeof g === "string"))) return null;
  return claims;
}
