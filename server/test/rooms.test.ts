// Phase 1 item 1 (#46) — participant kind + grants on the open server, and
// item 2 (#47) — the access stub. Names mirror Boomin's scripts/rooms-smoke.ts
// so both sides read the same list.
import { describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import worker from "../src/index";
import { verifyTicket } from "../src/ticket";
import { DEFAULT_GRANTS } from "../guest/src/participants";
import {
  createRoom,
  grantsOf,
  guestByInviteCode,
  inviteGuest,
  joinRoomByCode,
  mintGuestSignaling,
  mintRoomTicket,
  revokeGuest,
  roomRoster,
  setGrant,
  setRoomJoinLink,
  type GuestRow,
} from "../src/guests";
import { ApiError } from "../src/errors";

const ORIGIN = "https://producer.example.workers.dev";
const PRIMARY = "primary-token-for-tests";
const AUTOMATION = "automation-token-for-tests";
const SECRET = "a-32-char-signaling-secret-000000";

function env(): Env {
  return { DB: fakeD1(), MEDIA: {} as R2Bucket, PRIMARY_TOKEN: PRIMARY, AUTOMATION_TOKEN: AUTOMATION, SIGNALING_SECRET: SECRET };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(e: Env, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
}

async function openRoom(e: Env) {
  const { room } = await createRoom(e, { title: "Show", externalRef: "local-1" });
  const link = await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true });
  return { room, code: link.join_url!.split("/").pop()! };
}

async function expectApi(p: Promise<unknown>, code: string, status?: number) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    if (status) expect((err as ApiError).status).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("[kind]", () => {
  it("a link guest is kind=visitor", async () => {
    const e = env();
    const { code } = await openRoom(e);
    const { guest } = await joinRoomByCode(e, { roomCode: code, displayName: "Drew" });
    expect(guest.kind).toBe("visitor");
    expect(guest.producer_ref).toBeNull();
    expect(guest.seat).toBe("guest");
  });

  it("join with producer_ref sets kind=producer", async () => {
    const e = env();
    const { code } = await openRoom(e);
    const res = await call(e, "POST", `/v1/connect/guest/room/${code}/join`, { display_name: "Studio B", producer_ref: "https://b.example.workers.dev" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { guest: { kind: string; producer_ref: string; grants: string[] } };
    expect(body.guest.kind).toBe("producer");
    expect(body.guest.producer_ref).toBe("https://b.example.workers.dev");
    // Kind is never what they may do: a Producer walking in gets the same bundle.
    expect(body.guest.grants.sort()).toEqual([...DEFAULT_GRANTS].sort());
  });

  it("guest_brand_id is still refused with network_unavailable (and so are member / connection kinds)", async () => {
    const e = env();
    const { room } = await openRoom(e);
    const a = await call(e, "POST", `/v1/app/live/rooms/${room.id}/guests`, { display_name: "X", guest_brand_id: "b1" }, PRIMARY);
    expect(a.status).toBe(422);
    expect(((await a.json()) as { error: { code: string } }).error.code).toBe("network_unavailable");
    const b = await call(e, "POST", `/v1/app/live/rooms/${room.id}/guests`, { display_name: "X", kind: "member" }, PRIMARY);
    expect(b.status).toBe(422);
  });
});

describe("[grant]", () => {
  it("a visitor's default bundle is camera, mic, return_feed, vote, text, hand — never screen", async () => {
    const e = env();
    const { code } = await openRoom(e);
    const { guest } = await joinRoomByCode(e, { roomCode: code, displayName: "Drew" });
    expect(guest.grants).toBeNull(); // NULL column = the default bundle
    const g = grantsOf(guest);
    for (const want of ["media.camera", "media.mic", "media.return_feed", "input.vote", "input.text", "input.hand"]) expect(g.has(want)).toBe(true);
    expect(g.has("media.screen")).toBe(false);
  });

  it("POST guests/:id/grants grants media.screen and revokes it; unknown grants are 400", async () => {
    const e = env();
    const { room } = await openRoom(e);
    const inv = await inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "Drew" });
    const on = await call(e, "POST", `/v1/app/live/guests/${inv.guest.id}/grants`, { grant: "media.screen", enabled: true }, PRIMARY);
    expect(on.status).toBe(200);
    expect(((await on.json()) as { guest: { grants: string[] } }).guest.grants).toContain("media.screen");
    const off = await call(e, "POST", `/v1/app/live/guests/${inv.guest.id}/grants`, { grant: "media.screen", enabled: false }, PRIMARY);
    expect(((await off.json()) as { guest: { grants: string[] } }).guest.grants).not.toContain("media.screen");
    const bad = await call(e, "POST", `/v1/app/live/guests/${inv.guest.id}/grants`, { grant: "money.print", enabled: true }, PRIMARY);
    expect(bad.status).toBe(400);
    const auto = await call(e, "POST", `/v1/app/live/guests/${inv.guest.id}/grants`, { grant: "media.screen", enabled: true }, AUTOMATION);
    expect(auto.status).toBe(403);
  });

  it("the bundle sealed in the ticket is re-read from the row at exchange; a revoked row fails the exchange", async () => {
    const e = env();
    const { room } = await openRoom(e);
    const inv = await inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "Drew" });
    const code = inv.invite_url.split("/").pop()!;
    await setGrant(e, inv.guest.id, "media.screen", true);
    let row = await guestByInviteCode(e, code);
    const s1 = await mintGuestSignaling(e, row, "guest");
    const c1 = await verifyTicket(SECRET, s1.ticket, "guest-signal");
    expect(c1?.grants).toContain("media.screen");
    expect(c1?.kind).toBe("visitor");
    // The host side of the same channel carries no grants — the host is the room.
    const h = await verifyTicket(SECRET, (await mintGuestSignaling(e, row, "host")).ticket, "guest-signal");
    expect(h?.grants).toBeUndefined();
    // Revoke the grant: the NEXT mint reads the row, not the old ticket.
    await setGrant(e, inv.guest.id, "media.screen", false);
    row = await guestByInviteCode(e, code);
    const c2 = await verifyTicket(SECRET, (await mintGuestSignaling(e, row, "guest")).ticket, "guest-signal");
    expect(c2?.grants).not.toContain("media.screen");
    const rt = await verifyTicket(SECRET, await mintRoomTicket(e, row), "guest-room");
    expect(rt?.grants).toEqual(expect.arrayContaining(["media.camera"]));
    // Revoke the ROW: the exchange itself fails.
    await revokeGuest(e, inv.guest.id);
    await expectApi(guestByInviteCode(e, code), "guest_revoked", 410);
    await expectApi(setGrant(e, inv.guest.id, "media.screen", true), "guest_revoked", 410);
  });

  it("the roster emits kind and grants", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const { guest } = await joinRoomByCode(e, { roomCode: code, displayName: "Drew", producerRef: "studio-b" });
    const roster = await roomRoster(e, ORIGIN, room.id);
    const row = roster.find((g) => g.id === guest.id)!;
    expect(row.kind).toBe("producer");
    expect(row.grants.sort()).toEqual([...DEFAULT_GRANTS].sort());
    expect(row.seat).toBe("guest");
    // Through the route, too.
    const res = await call(e, "GET", `/v1/app/live/rooms/${room.id}/guests`, undefined, PRIMARY);
    const body = (await res.json()) as { guests: { id: string; kind: string; grants: string[] }[] };
    expect(body.guests.find((g) => g.id === guest.id)?.kind).toBe("producer");
  });

  it("a stored empty bundle means a participant who may do nothing (never quietly upgraded)", async () => {
    const e = env();
    const { room } = await openRoom(e);
    const inv = await inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "Drew" });
    await e.DB.prepare("UPDATE live_room_guests SET grants = '[]' WHERE id = ?1").bind(inv.guest.id).run();
    const row = (await e.DB.prepare("SELECT * FROM live_room_guests WHERE id = ?1").bind(inv.guest.id).first<GuestRow>())!;
    expect(grantsOf(row).size).toBe(0);
  });
});

describe("[mod]", () => {
  it("GET rooms/:id/access answers the host stub for a primary token and 403 token_class_insufficient for an automation token", async () => {
    const e = env();
    const { room } = await openRoom(e);
    const res = await call(e, "GET", `/v1/app/live/rooms/${room.id}/access`, undefined, PRIMARY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      role: "host",
      via: "token",
      can: { roster: true, control: true, manage: true, settings: true, billing: false },
      grants: null,
      implicit: true,
    });
    const auto = await call(e, "GET", `/v1/app/live/rooms/${room.id}/access`, undefined, AUTOMATION);
    expect(auto.status).toBe(403);
    expect(((await auto.json()) as { error: { code: string } }).error.code).toBe("token_class_insufficient");
  });
});
