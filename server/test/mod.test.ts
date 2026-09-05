// Phase 1 item 2 (#47) — the mod link, the control seat, scene cuts as frames.
import { describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import worker from "../src/index";
import { RealtimeHub } from "../src/realtime";
import { verifyTicket } from "../src/ticket";
import { MOD_GRANTS } from "../guest/src/participants";
import { createRoom, inviteGuest, joinRoomByCode, revokeGuest, setGrant, setRoomJoinLink } from "../src/guests";
import { parseScenePublish, validateSceneCut, EMPTY_SCENES } from "../src/scenes";
import { FakeState, asState, upgrade, type FakeSocket } from "./do";

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
const json = async <T,>(r: Response) => (await r.json()) as T;

async function roomWithSeat(e: Env) {
  const { room } = await createRoom(e, { title: "Show", externalRef: "local-1" });
  const link = await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true });
  const code = link.join_url!.split("/").pop()!;
  const res = await call(e, "POST", `/v1/app/live/rooms/${room.id}/mod-link`, { display_name: "Sam" }, PRIMARY);
  expect(res.status).toBe(201);
  const body = await json<{ guest: { id: string; kind: string; grants: string[] }; mod_url: string }>(res);
  const modCode = body.mod_url.split("/").pop()!;
  return { room, code, seat: body.guest, modCode, modUrl: body.mod_url };
}

describe("[mod] the mod link", () => {
  it("mints a control seat: kind producer, the mod bundle, no media, not on the roster, primary token only", async () => {
    const e = env();
    const { room, seat, modUrl, modCode } = await roomWithSeat(e);
    expect(modUrl).toBe(`${ORIGIN}/connect/mod/${modCode}`);
    expect(modCode).toMatch(/^gm_/);
    expect(seat.kind).toBe("producer");
    expect(seat.grants.sort()).toEqual([...MOD_GRANTS].sort());
    expect(seat.grants.some((g) => g.startsWith("media."))).toBe(false);
    const roster = await json<{ guests: { id: string }[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/guests`, undefined, PRIMARY));
    expect(roster.guests.find((g) => g.id === seat.id)).toBeUndefined();
    const mods = await json<{ mods: { id: string }[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/mods`, undefined, PRIMARY));
    expect(mods.mods.map((m) => m.id)).toEqual([seat.id]);
    expect((await call(e, "POST", `/v1/app/live/rooms/${room.id}/mod-link`, {}, AUTOMATION)).status).toBe(403);
    expect((await call(e, "POST", `/v1/app/live/rooms/${room.id}/mod-link`, {})).status).toBe(401);
  });

  it("the seat bootstraps with no bearer; a guest code opens no seat and a seat code opens no guest page", async () => {
    const e = env();
    const { room, code, modCode, seat } = await roomWithSeat(e);
    const boot = await call(e, "GET", `/v1/connect/mod/${modCode}`);
    expect(boot.status).toBe(200);
    expect(boot.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const b = await json<{ seat: { id: string }; room: { id: string }; grants: string[]; stage: { on_stage: string[] } }>(boot);
    expect(b.seat.id).toBe(seat.id);
    expect(b.room.id).toBe(room.id);
    expect(b.grants).toContain("room.scene");
    expect(b.stage.on_stage).toEqual([]);
    const { invite_code } = await joinRoomByCode(e, { roomCode: code, displayName: "Drew" });
    expect((await call(e, "GET", `/v1/connect/mod/${invite_code}`)).status).toBe(404);
    expect((await call(e, "GET", `/v1/connect/guest/${modCode}`)).status).toBe(404);
    expect((await call(e, "OPTIONS", `/v1/connect/mod/${modCode}/stage`)).status).toBe(204);
  });

  it("admit / stage / order / remove through the seat, each gated by its grant; another room's guest is 404", async () => {
    const e = env();
    const { room, code, modCode, seat } = await roomWithSeat(e);
    const { guest } = await joinRoomByCode(e, { roomCode: code, displayName: "Drew" });
    const admit = await call(e, "POST", `/v1/connect/mod/${modCode}/guests/${guest.id}/admit`, {});
    expect(admit.status).toBe(200);
    const roster = await json<{ guests: { id: string; render_url: string | null }[]; stage: { on_stage: string[] } }>(
      await call(e, "GET", `/v1/connect/mod/${modCode}/guests`),
    );
    // The seat sees who is admitted but never the render key.
    expect(roster.guests.find((g) => g.id === guest.id)?.render_url).toBe("withheld");
    const stage = await call(e, "POST", `/v1/connect/mod/${modCode}/stage`, { on_stage: [guest.id] });
    expect(stage.status).toBe(200);
    expect((await json<{ on_stage: string[] }>(stage)).on_stage).toEqual([guest.id]);
    expect((await call(e, "POST", `/v1/connect/mod/${modCode}/guest-order`, { order: [guest.id] })).status).toBe(200);

    // A seat that lost room.remove cannot remove; the UI only hides, the server gates.
    await setGrant(e, seat.id, "room.remove", false);
    const denied = await call(e, "POST", `/v1/connect/mod/${modCode}/guests/${guest.id}/revoke`, {});
    expect(denied.status).toBe(403);
    expect((await json<{ error: { code: string } }>(denied)).error.code).toBe("grant_required");
    await setGrant(e, seat.id, "room.remove", true);
    expect((await call(e, "POST", `/v1/connect/mod/${modCode}/guests/${guest.id}/revoke`, {})).status).toBe(200);

    // Another room's guest is not reachable through this seat.
    const other = await createRoom(e, { title: "Other" });
    const inv = await inviteGuest(e, ORIGIN, { roomId: other.room.id, displayName: "Elsewhere" });
    expect((await call(e, "POST", `/v1/connect/mod/${modCode}/guests/${inv.guest.id}/admit`, {})).status).toBe(404);
    void room;
  });

  it("the control ticket seals the seat's grants; revoking the seat kills it at the next call", async () => {
    const e = env();
    const { room, modCode, seat } = await roomWithSeat(e);
    const s = await json<{ signaling_ticket: string; signaling_url: string; peer_id: string }>(await call(e, "POST", `/v1/connect/mod/${modCode}/session`, {}));
    expect(s.signaling_url).toContain("/v1/connect/room-control?ticket=");
    const claims = await verifyTicket(SECRET, s.signaling_ticket, "room-control");
    expect(claims?.sub).toBe(`control:${seat.id}`);
    expect(claims?.room).toBe(room.id);
    expect(claims?.grants).toContain("room.scene");
    const h = await json<{ signaling_ticket: string; role: string }>(await call(e, "POST", `/v1/app/live/rooms/${room.id}/control-session`, {}, PRIMARY));
    const hc = await verifyTicket(SECRET, h.signaling_ticket, "room-control");
    expect(hc?.sub).toBe("host");
    expect(hc?.grants).toBeUndefined();
    await revokeGuest(e, seat.id);
    expect((await call(e, "GET", `/v1/connect/mod/${modCode}`)).status).toBe(410);
  });
});

describe("[mod] scene cuts on the room channel", () => {
  it("parseScenePublish / validateSceneCut are the authority", () => {
    const st = parseScenePublish({ scenes: [{ id: "s1", name: "Wide" }, { id: "s2" }, { nope: 1 }], active_scene_id: "s2" }, EMPTY_SCENES)!;
    expect(st).toEqual({ scenes: [{ id: "s1", name: "Wide" }, { id: "s2", name: "s2" }], active_scene_id: "s2", version: 1 });
    expect(parseScenePublish({ scenes: "x" }, st)).toBeNull();
    expect(validateSceneCut({ scene_id: "s1" }, { role: "control", grants: [] }, st)).toMatchObject({ ok: false, status: 403, grant: "room.scene" });
    expect(validateSceneCut({ scene_id: "zz" }, { role: "control", grants: ["room.scene"] }, st)).toMatchObject({ ok: false, status: 422, code: "unknown_scene" });
    expect(validateSceneCut({ scene_id: "s1", transition: "cut" }, { role: "control", grants: ["room.scene"] }, st)).toEqual({ ok: true, scene_id: "s1", transition: "cut" });
    expect(validateSceneCut({ scene_id: "s1" }, { role: "host" }, st)).toMatchObject({ ok: true });
    expect(validateSceneCut({}, { role: "host" }, st)).toMatchObject({ ok: false, status: 400 });
  });

  it("mod.scene.cut → a scene.cut frame reaches the host; viewer → 403; unknown → 422; late seats get scene.state", async () => {
    const state = new FakeState();
    const hub = new RealtimeHub(asState(state), {} as Env);
    const sock = async (headers: Record<string, string>) => {
      await hub.acceptUpgrade(upgrade(headers));
      const all = state.getWebSockets();
      return all[all.length - 1] as unknown as FakeSocket;
    };
    const host = await sock({ "X-Producer-User": "host", "X-Producer-Room": "r1", "X-Producer-Role": "host" });
    const mod = await sock({ "X-Producer-User": "control:m1", "X-Producer-Room": "r1", "X-Producer-Role": "control", "X-Producer-Grants": JSON.stringify(MOD_GRANTS) });
    const viewer = await sock({ "X-Producer-User": "control:v1", "X-Producer-Room": "r1", "X-Producer-Role": "control", "X-Producer-Grants": "[]" });
    const guest = await sock({ "X-Producer-User": "g1", "X-Producer-Room": "r1", "X-Producer-Role": "guest" });

    // Only the host's publish counts.
    await hub.webSocketMessage(mod as never, JSON.stringify({ type: "scene.publish", scenes: [{ id: "evil" }] }));
    expect(host.sent).toHaveLength(0);
    await hub.webSocketMessage(host as never, JSON.stringify({ type: "scene.publish", scenes: [{ id: "s1", name: "Wide" }, { id: "s2", name: "Close" }], active_scene_id: "s1" }));
    expect(mod.frames().at(-1)).toMatchObject({ type: "scene.state", active_scene_id: "s1", version: 1 });
    expect(viewer.frames().at(-1)).toMatchObject({ type: "scene.state" });
    expect(guest.sent).toHaveLength(0); // guests never see the scene list

    await hub.webSocketMessage(mod as never, JSON.stringify({ type: "scene.cut", scene_id: "s2" }));
    const cut = host.frames().at(-1)!;
    expect(cut).toMatchObject({ type: "scene.cut", scene_id: "s2", from: "control:m1" });
    expect(typeof cut.server_now).toBe("number");
    expect(mod.frames().at(-1)).toMatchObject({ type: "scene.cut.ok", scene_id: "s2" });

    await hub.webSocketMessage(viewer as never, JSON.stringify({ type: "scene.cut", scene_id: "s2" }));
    expect(viewer.frames().at(-1)).toMatchObject({ type: "error", code: "forbidden", status: 403, grant: "room.scene" });
    await hub.webSocketMessage(mod as never, JSON.stringify({ type: "scene.cut", scene_id: "nope" }));
    expect(mod.frames().at(-1)).toMatchObject({ type: "error", code: "unknown_scene", status: 422 });
    expect(host.frames().filter((f) => f.type === "scene.cut")).toHaveLength(1);

    // A seat connecting later starts from the stored list.
    const late = await sock({ "X-Producer-User": "control:m2", "X-Producer-Room": "r1", "X-Producer-Role": "control", "X-Producer-Grants": JSON.stringify(MOD_GRANTS) });
    expect(late.frames()[0]).toMatchObject({ type: "scene.state", active_scene_id: "s1", scenes: [{ id: "s1", name: "Wide" }, { id: "s2", name: "Close" }] });
  });
});
