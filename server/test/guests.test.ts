import { describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import { randomToken, sha256Hex } from "../src/crypto";
import { SIGNAL_TICKET_TTL_SECONDS, signTicket, verifyTicket } from "../src/ticket";
import {
  acceptGuest,
  admitGuest,
  createRoom,
  currentStage,
  deleteRoom,
  deriveRenderKey,
  freshQuality,
  guestByInviteCode,
  guestByRenderKey,
  hostPresent,
  iceServers,
  inviteGuest,
  joinRoomByCode,
  listRooms,
  loadRoom,
  mintGuestSignaling,
  reportQuality,
  revokeGuest,
  roomRoster,
  rosterState,
  setGuestPositions,
  setRoomJoinLink,
  setStage,
  type GuestRow,
} from "../src/guests";
import { ApiError } from "../src/errors";

const ORIGIN = "https://producer.example.workers.dev";

function env(): Env {
  return { DB: fakeD1(), MEDIA: {} as R2Bucket, SIGNALING_SECRET: "a-32-char-signaling-secret-000000" };
}

async function status(e: Env, id: string) {
  return (await e.DB.prepare("SELECT * FROM live_room_guests WHERE id = ?1").bind(id).first<GuestRow>())!;
}

async function openRoom(e: Env) {
  const { room } = await createRoom(e, { title: "Show", externalRef: "local-1" });
  const link = await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true });
  const code = link.join_url!.split("/").pop()!;
  return { room, code };
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

describe("codes", () => {
  it("hash round trip: only the sha256 of the code is stored, and it resolves the guest", async () => {
    const e = env();
    const { room } = await createRoom(e, { title: "Show" });
    const inv = await inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "Drew" });
    const code = inv.invite_url.split("/").pop()!;
    expect(code).toMatch(/^gi_/);
    const row = await status(e, inv.guest.id);
    expect(row.invite_code_hash).toBe(await sha256Hex(code));
    expect(row.invite_code_hash).not.toContain(code);
    expect((await guestByInviteCode(e, code)).id).toBe(inv.guest.id);
    await expectApi(guestByInviteCode(e, "gi_nope"), "guest_not_found", 404);
  });

  it("render key is derived from the secret, stable, and checked before the lookup", async () => {
    const e = env();
    const { room } = await createRoom(e, { title: "Show" });
    const inv = await inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "Drew" });
    const k = new URL(inv.render_url).searchParams.get("k")!;
    expect(k).toBe(await deriveRenderKey(e, inv.guest.id));
    expect(k).toMatch(/^gk_[0-9a-f]{40}$/);
    expect((await guestByRenderKey(e, inv.guest.id, k)).id).toBe(inv.guest.id);
    await expectApi(guestByRenderKey(e, inv.guest.id, "gk_wrong"), "guest_not_found", 404);
    await expectApi(guestByRenderKey(e, inv.guest.id, ""), "guest_not_found", 404);
    // A different secret = a different key: rotating SIGNALING_SECRET changes every render URL.
    expect(await deriveRenderKey({ ...e, SIGNALING_SECRET: "other-secret-0000000000000000000000" }, inv.guest.id)).not.toBe(k);
  });

  it("randomToken carries its prefix and ≥128 bits", () => {
    expect(randomToken("gr_", 18)).toMatch(/^gr_[A-Za-z0-9_-]{24}$/);
    expect(randomToken("gi_", 24)).not.toBe(randomToken("gi_", 24));
  });
});

describe("rooms", () => {
  it("create is idempotent by external_ref", async () => {
    const e = env();
    const a = await createRoom(e, { title: "Show", externalRef: "local-1" });
    const b = await createRoom(e, { title: "Show again", externalRef: "local-1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.room.id).toBe(a.room.id);
    const c = await createRoom(e, { title: "Other" });
    expect(c.room.id).not.toBe(a.room.id);
  });

  it("delete is refused while a guest is waiting or admitted, and stays gone after", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const j = await joinRoomByCode(e, { roomCode: code, displayName: "Ana" });
    await expectApi(deleteRoom(e, room.id), "room_occupied", 409);
    await admitGuest(e, j.guest.id);
    await expectApi(deleteRoom(e, room.id), "room_occupied", 409);
    await revokeGuest(e, j.guest.id);
    await deleteRoom(e, room.id);
    expect((await listRooms(e)).map((r) => r.id)).not.toContain(room.id);
    // Registering again under the same external_ref mints a NEW room —
    // the deleted one does not come back.
    const again = await createRoom(e, { title: "Show", externalRef: "local-1" });
    expect(again.created).toBe(true);
    expect(again.room.id).not.toBe(room.id);
  });
});

describe("join by room link", () => {
  it("joins into waiting, resumes the same slot, and revives an ended one", async () => {
    const e = env();
    const { code } = await openRoom(e);
    const first = await joinRoomByCode(e, { roomCode: code, displayName: "  Ana  " });
    expect(first.resumed).toBe(false);
    expect(first.guest.status).toBe("waiting");
    expect(first.guest.joined_via).toBe("room_link");
    expect(first.guest.display_name).toBe("Ana");
    expect(first.invite_code).toMatch(/^gi_/);

    const again = await joinRoomByCode(e, { roomCode: code, displayName: "Ana B", resumeCode: first.invite_code });
    expect(again.resumed).toBe(true);
    expect(again.guest.id).toBe(first.guest.id);
    expect(again.guest.display_name).toBe("Ana B");

    await e.DB.prepare("UPDATE live_room_guests SET status = 'ended', ended_at = 1 WHERE id = ?1").bind(first.guest.id).run();
    const revived = await joinRoomByCode(e, { roomCode: code, displayName: "Ana", resumeCode: first.invite_code });
    expect(revived.resumed).toBe(true);
    expect(revived.guest.status).toBe("waiting");
    expect(revived.guest.ended_at).toBeNull();
  });

  it("an admitted guest stays admitted across a resume", async () => {
    const e = env();
    const { code } = await openRoom(e);
    const j = await joinRoomByCode(e, { roomCode: code, displayName: "Ana" });
    await admitGuest(e, j.guest.id);
    const back = await joinRoomByCode(e, { roomCode: code, displayName: "Ana", resumeCode: j.invite_code });
    expect(back.guest.status).toBe("accepted");
  });

  it("a revoked resume code does not resume — and a bad/disabled link fails", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const j = await joinRoomByCode(e, { roomCode: code, displayName: "Troll" });
    await revokeGuest(e, j.guest.id);
    const fresh = await joinRoomByCode(e, { roomCode: code, displayName: "Troll", resumeCode: j.invite_code });
    expect(fresh.resumed).toBe(false);
    expect(fresh.guest.id).not.toBe(j.guest.id);

    await expectApi(joinRoomByCode(e, { roomCode: "gr_wrong", displayName: "X" }), "room_not_found", 404);
    await expectApi(joinRoomByCode(e, { roomCode: code, displayName: "   " }), "guest_name_required", 400);
    await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: false });
    await expectApi(joinRoomByCode(e, { roomCode: code, displayName: "X" }), "guest_link_disabled", 410);
  });

  it("capacity counts ADMITTED guests only", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    await e.DB.prepare("UPDATE live_rooms SET guest_capacity = 1 WHERE id = ?1").bind(room.id).run();
    const a = await joinRoomByCode(e, { roomCode: code, displayName: "A" });
    const b = await joinRoomByCode(e, { roomCode: code, displayName: "B" }); // waiting costs nothing
    await admitGuest(e, a.guest.id);
    await expectApi(joinRoomByCode(e, { roomCode: code, displayName: "C" }), "guest_room_full", 409);
    // Resume of an existing slot is never blocked by capacity.
    expect((await joinRoomByCode(e, { roomCode: code, displayName: "B", resumeCode: b.invite_code })).resumed).toBe(true);
    await revokeGuest(e, a.guest.id);
    expect((await joinRoomByCode(e, { roomCode: code, displayName: "C" })).guest.status).toBe("waiting");
  });

  it("auto-admit lands guests straight in accepted", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true, autoAdmit: true });
    const j = await joinRoomByCode(e, { roomCode: code, displayName: "Panel" });
    expect(j.guest.status).toBe("accepted");
    expect(j.guest.admitted_at).not.toBeNull();
  });

  it("rotating the link revokes waiting link guests but keeps admitted ones unless asked", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const w = await joinRoomByCode(e, { roomCode: code, displayName: "Waiting" });
    const a = await joinRoomByCode(e, { roomCode: code, displayName: "Admitted" });
    await admitGuest(e, a.guest.id);
    const inv = await inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "Named" });

    const rotated = await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true, rotate: true });
    expect(rotated.join_url).not.toBeNull();
    expect(rotated.join_url!.split("/").pop()).not.toBe(code);
    expect((await status(e, w.guest.id)).status).toBe("revoked");
    expect((await status(e, a.guest.id)).status).toBe("accepted");
    expect((await status(e, inv.guest.id)).status).toBe("invited"); // not a link guest
    await expectApi(joinRoomByCode(e, { roomCode: code, displayName: "Late" }), "room_not_found", 404);

    await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true, rotate: true, removeAdmitted: true });
    expect((await status(e, a.guest.id)).status).toBe("revoked");
    // Re-enabling without rotate keeps the current code (no join_url returned).
    expect((await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true })).join_url).toBeNull();
  });
});

describe("admit / accept / revoke state machine", () => {
  it("invite → accept is idempotent; decline/revoke are terminal", async () => {
    const e = env();
    const { room } = await createRoom(e, { title: "Show" });
    const inv = await inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "Drew" });
    expect(inv.guest.status).toBe("invited");
    const acc = await acceptGuest(e, inv.guest.id);
    expect(acc.status).toBe("accepted");
    const first = acc.accepted_at;
    expect((await acceptGuest(e, inv.guest.id)).accepted_at).toBe(first);
    const rev = await revokeGuest(e, inv.guest.id);
    expect(rev.status).toBe("revoked");
    await expectApi(acceptGuest(e, inv.guest.id), "guest_not_acceptable", 409);
    await expectApi(revokeGuest(e, inv.guest.id), "guest_not_found", 404);
    await expectApi(admitGuest(e, inv.guest.id), "guest_not_found", 404);
    const code = inv.invite_url.split("/").pop()!;
    await expectApi(guestByInviteCode(e, code), "guest_revoked", 410);
  });

  it("admit only moves waiting/invited; a second admit 404s", async () => {
    const e = env();
    const { code } = await openRoom(e);
    const j = await joinRoomByCode(e, { roomCode: code, displayName: "Ana" });
    const admitted = await admitGuest(e, j.guest.id);
    expect(admitted.status).toBe("accepted");
    expect(admitted.admitted_at).not.toBeNull();
    await expectApi(admitGuest(e, j.guest.id), "guest_not_found", 404);
  });

  it("revoking a guest on stage folds the open segment into stage_seconds", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const j = await joinRoomByCode(e, { roomCode: code, displayName: "Ana" });
    await admitGuest(e, j.guest.id);
    await setStage(e, { roomId: room.id, onStage: [j.guest.id] });
    await e.DB.prepare("UPDATE live_room_guests SET stage_since = stage_since - 30 WHERE id = ?1").bind(j.guest.id).run();
    const rev = await revokeGuest(e, j.guest.id);
    expect(rev.stage_since).toBeNull();
    expect(rev.stage_seconds).toBeGreaterThanOrEqual(30);
  });

  it("invite by link refuses an empty name", async () => {
    const e = env();
    const { room } = await createRoom(e, { title: "Show" });
    await expectApi(inviteGuest(e, ORIGIN, { roomId: room.id, displayName: " " }), "guest_name_required", 400);
    await expectApi(inviteGuest(e, ORIGIN, { roomId: "nope", displayName: "X" }), "room_not_found", 404);
  });
});

describe("stage", () => {
  it("filters to admitted guests of THIS room, bumps a monotonic version, enforces capacity", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const a = await joinRoomByCode(e, { roomCode: code, displayName: "A" });
    const b = await joinRoomByCode(e, { roomCode: code, displayName: "B" });
    await admitGuest(e, a.guest.id);

    const s1 = await setStage(e, { roomId: room.id, onStage: [a.guest.id, b.guest.id, "not-a-guest", a.guest.id] });
    expect(s1).toEqual({ on_stage: [a.guest.id], version: 1 });
    expect(await currentStage(e, room.id)).toEqual({ on_stage: [a.guest.id], version: 1 });
    expect((await status(e, a.guest.id)).stage_since).not.toBeNull();

    // Re-publishing the same list is idempotent for the clock but still versions.
    const since = (await status(e, a.guest.id)).stage_since;
    const s2 = await setStage(e, { roomId: room.id, onStage: [a.guest.id] });
    expect(s2.version).toBe(2);
    expect((await status(e, a.guest.id)).stage_since).toBe(since);

    // Leaving the stage closes the segment.
    const s3 = await setStage(e, { roomId: room.id, onStage: [] });
    expect(s3).toEqual({ on_stage: [], version: 3 });
    const closed = await status(e, a.guest.id);
    expect(closed.stage_since).toBeNull();
    expect(closed.stage_seconds).toBeGreaterThanOrEqual(0);

    await e.DB.prepare("UPDATE live_rooms SET stage_capacity = 0 WHERE id = ?1").bind(room.id).run();
    await expectApi(setStage(e, { roomId: room.id, onStage: [a.guest.id] }), "stage_full", 409);
    expect((await loadRoom(e, room.id)).stage_version).toBe(3);
  });

  it("guest-order writes positions only for guests of the room", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const a = await joinRoomByCode(e, { roomCode: code, displayName: "A" });
    const b = await joinRoomByCode(e, { roomCode: code, displayName: "B" });
    await setGuestPositions(e, { roomId: room.id, order: [b.guest.id, a.guest.id, "ghost"] });
    expect((await status(e, b.guest.id)).position).toBe(0);
    expect((await status(e, a.guest.id)).position).toBe(1);
    await setGuestPositions(e, { roomId: "other-room", order: [a.guest.id] });
    expect((await status(e, a.guest.id)).position).toBe(1);
  });
});

describe("signaling tickets", () => {
  const secret = "ticket-secret-000000000000000000000";

  it("mint/verify round trip, audience-pinned, expiring", async () => {
    const t = await signTicket(secret, { sub: "host:g1", aud: "guest-signal" });
    expect(t.split(".")).toHaveLength(3);
    const claims = await verifyTicket(secret, t, "guest-signal");
    expect(claims?.sub).toBe("host:g1");
    expect(claims?.type).toBe("guest");
    expect(claims!.exp - claims!.iat).toBe(SIGNAL_TICKET_TTL_SECONDS);
    expect(await verifyTicket(secret, t, "guest-room")).toBeNull();
    expect(await verifyTicket("wrong", t, "guest-signal")).toBeNull();
    expect(await verifyTicket(secret, `${t}x`, "guest-signal")).toBeNull();
    expect(await verifyTicket(secret, "garbage", "guest-signal")).toBeNull();
    const expired = await signTicket(secret, { sub: "guest:g1", aud: "guest-signal", expiresInSeconds: -1 });
    expect(await verifyTicket(secret, expired, "guest-signal")).toBeNull();
  });

  it("mintGuestSignaling pins the session, sets peer ids per role, and stamps last_seen", async () => {
    const e = env();
    const { code } = await openRoom(e);
    const j = await joinRoomByCode(e, { roomCode: code, displayName: "Ana" });
    await admitGuest(e, j.guest.id);
    const guest = await status(e, j.guest.id);
    expect(guest.last_seen_at).toBeNull();
    const g = await mintGuestSignaling(e, guest, "guest");
    const h = await mintGuestSignaling(e, guest, "host");
    expect(g.channel).toBe(`guest:${guest.id}`);
    expect(h.channel).toBe(g.channel);
    expect(g.peerId).toBe(guest.peer_id);
    expect(h.peerId).toBe(`${guest.peer_id}_host`);
    expect(g.expiresIn).toBe(120);
    expect(g.iceServers).toEqual(iceServers({}));
    expect((await verifyTicket(e.SIGNALING_SECRET!, g.ticket, "guest-signal"))?.sub).toBe(`guest:${guest.id}`);
    expect((await verifyTicket(e.SIGNALING_SECRET!, h.ticket, "guest-signal"))?.sub).toBe(`host:${guest.id}`);
    expect((await status(e, j.guest.id)).last_seen_at).not.toBeNull();
  });

  it("no SIGNALING_SECRET → 503, never a ticket signed with an empty key", async () => {
    const e = { ...env(), SIGNALING_SECRET: undefined };
    const { room } = await createRoom(e, { title: "Show" });
    await expectApi(inviteGuest(e, ORIGIN, { roomId: room.id, displayName: "X" }), "realtime_unavailable", 503);
  });

  it("ICE_SERVERS overrides only when valid", () => {
    expect(iceServers({ ICE_SERVERS: '[{"urls":"turn:t"}]' })).toEqual([{ urls: "turn:t" }]);
    expect(iceServers({ ICE_SERVERS: "nope" })).toEqual(iceServers({}));
    expect(iceServers({ ICE_SERVERS: "[]" })).toEqual(iceServers({}));
  });
});

describe("roster", () => {
  const base = { status: "accepted", last_seen_at: null } as Pick<GuestRow, "status" | "last_seen_at">;
  const now = 1_000_000 * 1000;

  it("connected / admitted / left windows", () => {
    expect(rosterState({ ...base, status: "waiting" }, now)).toBe("waiting");
    expect(rosterState({ ...base, status: "invited" }, now)).toBe("invited");
    expect(rosterState({ ...base, last_seen_at: 1_000_000 - 10 }, now)).toBe("connected");
    expect(rosterState({ ...base, last_seen_at: 1_000_000 - 16 }, now)).toBe("admitted");
    expect(rosterState(base, now)).toBe("admitted");
    expect(rosterState({ ...base, status: "ended" }, now)).toBe("left");
    expect(rosterState({ ...base, status: "revoked" }, now)).toBe("left");
  });

  it("quality goes stale after 20s", () => {
    expect(freshQuality({ quality: "good", quality_at: 1_000_000 - 5 }, now)).toBe("good");
    expect(freshQuality({ quality: "good", quality_at: 1_000_000 - 25 }, now)).toBe("unknown");
    expect(freshQuality({ quality: null, quality_at: null }, now)).toBe("unknown");
  });

  it("host presence window", () => {
    expect(hostPresent(null)).toBe(false);
    expect(hostPresent(1_000_000 - 10, now)).toBe(true);
    expect(hostPresent(1_000_000 - 60, now)).toBe(false);
    expect(hostPresent(1_000_000 + 60, now)).toBe(true); // clock skew ≠ absence
  });

  it("render_url only for admitted; ended guests linger 90s; the poll stamps host_seen_at", async () => {
    const e = env();
    const { room, code } = await openRoom(e);
    const w = await joinRoomByCode(e, { roomCode: code, displayName: "W" });
    const a = await joinRoomByCode(e, { roomCode: code, displayName: "A" });
    await admitGuest(e, a.guest.id);
    const gone = await joinRoomByCode(e, { roomCode: code, displayName: "Gone" });
    await e.DB.prepare("UPDATE live_room_guests SET status = 'ended', updated_at = 1 WHERE id = ?1").bind(gone.guest.id).run();
    const recent = await joinRoomByCode(e, { roomCode: code, displayName: "Blip" });
    await e.DB.prepare("UPDATE live_room_guests SET status = 'ended' WHERE id = ?1").bind(recent.guest.id).run();
    await reportQuality(e, a.guest.id, { quality: "degraded", stats: { rtt: 80 } });

    const roster = await roomRoster(e, ORIGIN, room.id);
    const ids = roster.map((g) => g.id);
    expect(ids).toContain(w.guest.id);
    expect(ids).toContain(a.guest.id);
    expect(ids).toContain(recent.guest.id);
    expect(ids).not.toContain(gone.guest.id);

    const wr = roster.find((g) => g.id === w.guest.id)!;
    const ar = roster.find((g) => g.id === a.guest.id)!;
    expect(wr.render_url).toBeNull();
    expect(wr.state).toBe("waiting");
    expect(ar.render_url).toBe(`${ORIGIN}/connect/guest/render/${a.guest.id}?k=${await deriveRenderKey(e, a.guest.id)}`);
    expect(ar.state).toBe("connected"); // the quality report is evidence of life
    expect(ar.quality).toBe("degraded");
    expect(ar.joined_via).toBe("room_link");
    expect(ar.guest_brand).toBeNull();
    expect(roster.find((g) => g.id === recent.guest.id)!.state).toBe("left");
    expect(Object.keys(ar).sort()).toEqual(
      ["avatar_url", "display_name", "guest_brand", "id", "joined_at", "joined_via", "last_seen_at", "position", "quality", "render_url", "snapshot", "state"],
    );
    expect((await loadRoom(e, room.id)).host_seen_at).not.toBeNull();
    await expectApi(roomRoster(e, ORIGIN, "nope"), "room_not_found", 404);
  });
});
