// Phase 1 item 7 (#51) — one interaction end to end: a two-choice vote.
import { describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import worker from "../src/index";
import { RealtimeHub } from "../src/realtime";
import { RoomState } from "../src/roomstate";
import { verifyTicket } from "../src/ticket";
import { createRoom, joinRoomByCode, roomRoster, setGrant, setRoomJoinLink } from "../src/guests";
import { listForRoom } from "../src/contributions";
import { parseInteractionCreate, nextState, InteractionError, newInteractionId } from "../src/interactions/schema";
import { applyInput, emptyTally, publicTally, SEEN_CAP } from "../src/interactions/tally";
import { project } from "../src/interactions/project";
import { newAudienceCode } from "../src/interactionRoutes";
import { FakeState, asState, fakeNamespace, upgrade, type FakeSocket } from "./do";

const ORIGIN = "https://producer.example.workers.dev";
const PRIMARY = "primary-token-for-tests";
const AUTOMATION = "automation-token-for-tests";
const SECRET = "a-32-char-signaling-secret-000000";

function env(): Env & { ROOMSTATE: ReturnType<typeof fakeNamespace<RoomState>>; REALTIME: ReturnType<typeof fakeNamespace<RealtimeHub>> } {
  const e = { DB: fakeD1(), MEDIA: {} as R2Bucket, PRIMARY_TOKEN: PRIMARY, AUTOMATION_TOKEN: AUTOMATION, SIGNALING_SECRET: SECRET } as Env;
  const REALTIME = fakeNamespace((state) => new RealtimeHub(asState(state), e));
  const ROOMSTATE = fakeNamespace((state) => new RoomState(asState(state), e));
  return Object.assign(e, { REALTIME, ROOMSTATE });
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
async function call(e: Env, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
}
const json = async <T,>(r: Response) => (await r.json()) as T;

type Ix = { id: string; state: string; version: number; timing: Record<string, unknown>; tally?: { total: number; options: Record<string, number>; by_kind: Record<string, number>; winner: string | null }; spec: { options: { id: string; label: string }[] } };

async function show(e: Env) {
  const { room } = await createRoom(e, { title: "Show", externalRef: "local-1" });
  const link = await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true, autoAdmit: true });
  const code = link.join_url!.split("/").pop()!;
  const g1 = await joinRoomByCode(e, { roomCode: code, displayName: "Maya" });
  const g2 = await joinRoomByCode(e, { roomCode: code, displayName: "Dev" });
  await roomRoster(e, ORIGIN, room.id); // the host is present
  const aud = await json<{ code: string; url: string }>(await call(e, "POST", `/v1/app/live/rooms/${room.id}/audience-link`, {}, PRIMARY));
  return { room, g1, g2, aud };
}

async function openVote(e: Env, roomId: string, extra: Record<string, unknown> = {}) {
  const res = await call(e, "POST", `/v1/app/live/rooms/${roomId}/interactions`, { type: "vote", options: ["Maya", "Dev"], reveal: "on_close", input: { who: "both", once: true, cooldown_ms: 0 }, ...extra }, PRIMARY);
  expect(res.status).toBe(201);
  return (await json<{ interaction: Ix }>(res)).interaction;
}
const patch = (e: Env, roomId: string, ix: string, body: unknown) => call(e, "PATCH", `/v1/app/live/rooms/${roomId}/interactions/${ix}`, body, PRIMARY);

async function audienceToken(e: Env, code: string, device: string) {
  const res = await call(e, "POST", `/v1/connect/audience/${code}/token`, { device_id: device });
  expect(res.status).toBe(201);
  return json<{ token: string; signaling_url: string; room: { id: string } }>(res);
}

describe("[interaction] pure", () => {
  it("parseInteractionCreate normalises both shapes and refuses a one-option vote", () => {
    const short = parseInteractionCreate({ type: "vote", options: ["A", "B"], reveal: "manual", input: { who: "audience", cooldown_ms: 5000 } }, { roomId: "r", runId: null });
    expect(short.spec.options).toEqual([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    expect(short.input).toMatchObject({ roles: ["audience"], per_identity: "once", cooldown_ms: 5000 });
    expect(short.visibility.reveal).toBe("manual");
    expect(short.id).toMatch(/^ix_[A-Za-z0-9]{12}$/);
    const long = parseInteractionCreate({ type: "vote", spec: { prompt: "Who?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }, input: { roles: ["guest"] }, visibility: { reveal: "on_timer" }, timing: { collect_ms: 30000, reveal_hold_ms: 1500 } }, { roomId: "r", runId: "run_1" });
    expect(long.spec).toEqual({ prompt: "Who?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] });
    expect(long.timing).toMatchObject({ collect_ms: 30000, reveal_hold_ms: 1500 });
    expect(long.run_id).toBe("run_1");
    expect(() => parseInteractionCreate({ type: "vote", options: ["A"] }, { roomId: "r", runId: null })).toThrow(InteractionError);
    expect(() => parseInteractionCreate({ type: "text" }, { roomId: "r", runId: null })).toThrow(/vote/);
    expect(() => parseInteractionCreate({ type: "vote", options: ["A", "B"], reveal: "on_timer" }, { roomId: "r", runId: null })).toThrow(/collect_ms/);
    expect(newInteractionId(() => 0)).toBe("ix_AAAAAAAAAAAA");
  });

  it("the state machine: open → collecting → revealed → closed; nothing after closed", () => {
    expect(nextState("open", "open")).toBe("collecting");
    expect(nextState("collecting", "reveal")).toBe("revealed");
    expect(nextState("revealed", "close")).toBe("closed");
    expect(nextState("collecting", "close")).toBe("closed");
    expect(() => nextState("open", "reveal")).toThrow(/Cannot reveal/);
    expect(() => nextState("closed", "open")).toThrow(InteractionError);
    expect(() => nextState("closed", "cancel")).toThrow(InteractionError);
  });

  it("the tally counts once per identity, by kind, and never grows past the cap", () => {
    let t = emptyTally(["a", "b"]);
    const r1 = applyInput(t, { identity: "h1", kind: "guest", value: "a", now: 1000, cooldownMs: 5000 });
    expect(r1).toMatchObject({ accepted: true, cooldown_until: 6000 });
    t = (r1 as { tally: typeof t }).tally;
    expect(applyInput(t, { identity: "h1", kind: "guest", value: "b", now: 2000, cooldownMs: 5000 })).toMatchObject({ accepted: false, code: "input_already_counted", cooldown_until: 6000 });
    expect(applyInput(t, { identity: "h2", kind: "audience", value: "c", now: 2000, cooldownMs: 0 })).toMatchObject({ accepted: false, code: "input_invalid" });
    t = (applyInput(t, { identity: "h2", kind: "audience", value: "b", now: 2000, cooldownMs: 0 }) as { tally: typeof t }).tally;
    expect(publicTally(t)).toEqual({ total: 2, options: { a: 1, b: 1 }, by_kind: { guest: 1, audience: 1 }, winner: null });
    // Past the cap the DO counts blind: the total grows, the hash set does not.
    t = { ...t, seen_count: SEEN_CAP };
    t = (applyInput(t, { identity: "x-late", kind: "audience", value: "a", now: 3000, cooldownMs: 0 }) as { tally: typeof t }).tally;
    expect(Object.keys(t.seen)).toEqual(["h1", "h2"]);
    expect(t.total).toBe(3);
    expect(t.seen_count).toBe(SEEN_CAP + 1);
    expect(publicTally(t).winner).toBe("a");
  });

  it("project(interaction, role) never sends raw inputs or a running tally to audience", () => {
    const doc = parseInteractionCreate({ type: "vote", options: ["A", "B"] }, { roomId: "r", runId: null });
    doc.state = "collecting";
    const tally = (applyInput(emptyTally(["a", "b"]), { identity: "h", kind: "guest", value: "a", now: 1, cooldownMs: 0 }) as { tally: ReturnType<typeof emptyTally> }).tally;
    const host = project(doc, tally, "host", 123);
    expect(host.tally).toEqual({ total: 1, options: { a: 1, b: 0 }, by_kind: { guest: 1, audience: 0 }, winner: "a" });
    expect(host.server_now).toBe(123);
    const aud = project(doc, tally, "audience", 123);
    expect(aud.tally).toBeUndefined();
    expect(JSON.stringify(aud)).not.toContain("seen");
    expect(JSON.stringify(aud)).not.toContain("by_kind");
    expect((aud as unknown as { input: Record<string, unknown> }).input).toEqual({ roles: ["guest", "audience"], per_identity: "once", cooldown_ms: 0 });
    expect(aud.render.every((r) => r.surface === "audience")).toBe(true);
    expect(project(doc, tally, "guest", 1).tally).toBeUndefined();
    doc.state = "revealed";
    expect(project(doc, tally, "audience", 1).tally?.total).toBe(1);
    expect(project(doc, tally, "set", 1).tally?.winner).toBe("a");
  });

  it("audience codes are four consonants", () => {
    expect(newAudienceCode(() => 0)).toBe("BBBB");
    expect(newAudienceCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  });
});

describe("[interaction] end to end", () => {
  it("POST rooms/:id/interactions creates a vote in state open with server-stamped timing", async () => {
    const e = env();
    const { room } = await show(e);
    const ix = await openVote(e, room.id, { timing: { collect_ms: 30000 } });
    expect(ix.state).toBe("open");
    expect(ix.version).toBe(0);
    expect(ix.timing.opened_at).toBeUndefined();
    const started = (await json<{ interaction: Ix }>(await patch(e, room.id, ix.id, { transition: "open" }))).interaction;
    expect(started.state).toBe("collecting");
    expect(typeof started.timing.opened_at).toBe("string");
    expect(typeof started.timing.reveal_at).toBe("string");
    expect(Date.parse(String(started.timing.reveal_at)) - Date.parse(String(started.timing.opened_at))).toBe(30000);
    const row = await e.DB.prepare("SELECT state, version, result FROM interactions WHERE id = ?1").bind(ix.id).first<{ state: string; version: number; result: string | null }>();
    expect(row).toEqual({ state: "collecting", version: 1, result: null });
    const list = await json<{ interactions: Ix[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/interactions`, undefined, PRIMARY));
    expect(list.interactions.map((i) => i.id)).toEqual([ix.id]);
    const bad = await call(e, "POST", `/v1/app/live/rooms/${room.id}/interactions`, { type: "vote", options: ["only"] }, PRIMARY);
    expect(bad.status).toBe(422);
  });

  it("an automation token cannot open an interaction (403 token_class_insufficient)", async () => {
    const e = env();
    const { room } = await show(e);
    const res = await call(e, "POST", `/v1/app/live/rooms/${room.id}/interactions`, { type: "vote", options: ["A", "B"] }, AUTOMATION);
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("token_class_insufficient");
  });

  it("inputs from a guest and from an audience token are counted once per identity", async () => {
    const e = env();
    const { room, g1, g2, aud } = await show(e);
    const ix = await openVote(e, room.id);
    // Not collecting yet.
    expect((await call(e, "POST", `/v1/connect/guest/${g1.invite_code}/interactions/${ix.id}/inputs`, { value: "a" })).status).toBe(409);
    await patch(e, room.id, ix.id, { transition: "open" });
    const first = await call(e, "POST", `/v1/connect/guest/${g1.invite_code}/interactions/${ix.id}/inputs`, { value: "a" });
    expect(first.status).toBe(202);
    expect(await json<unknown>(first)).toEqual({ accepted: true });
    const again = await call(e, "POST", `/v1/connect/guest/${g1.invite_code}/interactions/${ix.id}/inputs`, { value: "b" });
    expect(again.status).toBe(409);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("input_already_counted");
    // A guest without input.vote is refused at the door.
    await setGrant(e, g2.guest.id, "input.vote", false);
    expect((await call(e, "POST", `/v1/connect/guest/${g2.invite_code}/interactions/${ix.id}/inputs`, { value: "b" })).status).toBe(403);

    // The audience: the door mints a per-device token; the same device keeps its identity.
    expect(aud.url).toBe(`${ORIGIN}/a/${aud.code}`);
    const probe = await json<{ open: boolean; server_now: number }>(await call(e, "GET", `/v1/connect/audience/${aud.code}`));
    expect(probe.open).toBe(true);
    const t1 = await audienceToken(e, aud.code, "device-one-1234");
    const claims = await verifyTicket(SECRET, t1.token, "audience");
    expect(claims?.sub).toMatch(/^aud_/);
    expect(claims?.room).toBe(room.id);
    expect(claims?.grants).toBeUndefined();
    const p1 = await call(e, "POST", `/v1/connect/audience/interactions/${ix.id}/inputs`, { value: "b" }, t1.token);
    expect(p1.status).toBe(202);
    const t1b = await audienceToken(e, aud.code, "device-one-1234"); // reload → same identity
    expect((await call(e, "POST", `/v1/connect/audience/interactions/${ix.id}/inputs`, { value: "b" }, t1b.token)).status).toBe(409);
    const t2 = await audienceToken(e, aud.code, "device-two-5678");
    expect((await call(e, "POST", `/v1/connect/audience/interactions/${ix.id}/inputs`, { value: "a" }, t2.token)).status).toBe(202);
    expect((await call(e, "POST", `/v1/connect/audience/interactions/${ix.id}/inputs`, { value: "zz" }, t2.token)).status).toBe(422);
    expect((await call(e, "POST", `/v1/connect/audience/interactions/${ix.id}/inputs`, { value: "a" }, "not-a-token")).status).toBe(401);

    const list = await json<{ interactions: Ix[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/interactions`, undefined, PRIMARY));
    expect(list.interactions[0].tally).toEqual({ total: 3, options: { a: 2, b: 1 }, by_kind: { guest: 1, audience: 2 }, winner: "a" });

    // The code resolves only while the host is present.
    await e.DB.prepare("UPDATE live_rooms SET host_seen_at = 1 WHERE id = ?1").bind(room.id).run();
    expect((await call(e, "POST", `/v1/connect/audience/${aud.code}/token`, {})).status).toBe(404);
  });

  it("reveal is a server transition: a client PATCH to revealed before reveal_at is refused", async () => {
    const e = env();
    const { room } = await show(e);
    const ix = await openVote(e, room.id, { reveal: "manual", timing: { reveal_hold_ms: 1500 } });
    // `revealed` is not a transition a client may name.
    expect((await patch(e, room.id, ix.id, { transition: "revealed" })).status).toBe(400);
    // Reveal before collecting is not legal from `open`.
    const early = await patch(e, room.id, ix.id, { transition: "reveal" });
    expect(early.status).toBe(409);
    expect((await json<{ error: { code: string } }>(early)).error.code).toBe("interaction_state");
    await patch(e, room.id, ix.id, { transition: "open" });
    // Arming: state stays collecting, reveal_at is stamped, the alarm is set.
    const armed = (await json<{ interaction: Ix }>(await patch(e, room.id, ix.id, { transition: "reveal" }))).interaction;
    expect(armed.state).toBe("collecting");
    expect(typeof armed.timing.reveal_at).toBe("string");
    const inst = e.ROOMSTATE.instances.get(`roomstate:${room.id}`)!;
    expect(inst.state.alarmAt).toBe(Date.parse(String(armed.timing.reveal_at)));
    // The SERVER fires it.
    inst.state.alarmAt = null;
    await inst.object.alarm(); // not due yet → nothing
    let list = await json<{ interactions: Ix[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/interactions`, undefined, PRIMARY));
    expect(list.interactions[0].state).toBe("collecting");
    await e.ROOMSTATE.instances.get(`roomstate:${room.id}`)!.state.storage.put("alarms", [{ id: ix.id, at: Date.now() - 1, action: "reveal" }]);
    await inst.object.alarm();
    list = await json<{ interactions: Ix[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/interactions`, undefined, PRIMARY));
    expect(list.interactions[0].state).toBe("revealed");
    expect(typeof list.interactions[0].timing.revealed_at).toBe("string");
    const row = await e.DB.prepare("SELECT state, result FROM interactions WHERE id = ?1").bind(ix.id).first<{ state: string; result: string }>();
    expect(row?.state).toBe("revealed");
    expect(JSON.parse(row!.result)).toMatchObject({ total: 0 });
    // A hold of 0 reveals at once.
    const ix2 = await openVote(e, room.id, { reveal: "manual" });
    await patch(e, room.id, ix2.id, { transition: "open" });
    expect((await json<{ interaction: Ix }>(await patch(e, room.id, ix2.id, { transition: "reveal", reveal_hold_ms: 0 }))).interaction.state).toBe("revealed");
  });

  it("a closed interaction persists its final tally and is immutable afterwards; inputs land as aggregate contributions", async () => {
    const e = env();
    const { room, g1, aud } = await show(e);
    const ix = await openVote(e, room.id);
    await patch(e, room.id, ix.id, { transition: "open" });
    await call(e, "POST", `/v1/connect/guest/${g1.invite_code}/interactions/${ix.id}/inputs`, { value: "a" });
    const t = await audienceToken(e, aud.code, "device-one-1234");
    await call(e, "POST", `/v1/connect/audience/interactions/${ix.id}/inputs`, { value: "a" }, t.token);
    const closed = (await json<{ interaction: Ix }>(await patch(e, room.id, ix.id, { transition: "close" }))).interaction;
    expect(closed.state).toBe("closed");
    expect(closed.tally).toEqual({ total: 2, options: { a: 2, b: 0 }, by_kind: { guest: 1, audience: 1 }, winner: "a" });
    const row = await e.DB.prepare("SELECT state, result, closed_at FROM interactions WHERE id = ?1").bind(ix.id).first<{ state: string; result: string; closed_at: number }>();
    expect(row?.state).toBe("closed");
    expect(JSON.parse(row!.result)).toEqual(closed.tally);
    expect(row?.closed_at).toBeGreaterThan(0);
    // Immutable: no transition, no input.
    expect((await patch(e, room.id, ix.id, { transition: "open" })).status).toBe(409);
    expect((await call(e, "POST", `/v1/connect/guest/${g1.invite_code}/interactions/${ix.id}/inputs`, { value: "b" })).status).toBe(409);
    // The ledger: one aggregate row per participant kind, never one per phone.
    const rows = (await listForRoom(e, room.id)).filter((r) => r.kind === "input");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => JSON.parse(r.binding)).sort((a, b) => String(a.participant_kind).localeCompare(String(b.participant_kind)))).toEqual([
      { interaction_id: ix.id, participant_kind: "audience" },
      { interaction_id: ix.id, participant_kind: "guest" },
    ]);
    expect(rows.every((r) => r.participant_id === null && r.source === "interaction" && r.ended_at !== null && JSON.parse(r.metadata).count === 1)).toBe(true);
    // The archived list still shows it, with its result.
    const list = await json<{ interactions: Ix[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/interactions`, undefined, PRIMARY));
    expect(list.interactions.find((i) => i.id === ix.id)?.tally?.total).toBe(2);
  });

  it("frames: host + guest projections on the room channel, snapshot + deltas on the audience socket, server_now everywhere", async () => {
    const e = env();
    const { room, g1, aud } = await show(e);
    // The host's control socket subscribes to interaction:host; a guest may not.
    const hub = e.REALTIME.instances.get(`liveroom:${room.id}`) ?? (e.REALTIME.get(e.REALTIME.idFromName(`liveroom:${room.id}`)), e.REALTIME.instances.get(`liveroom:${room.id}`)!);
    await hub.object.acceptUpgrade(upgrade({ "X-Producer-User": "host", "X-Producer-Room": room.id, "X-Producer-Role": "host" }));
    await hub.object.acceptUpgrade(upgrade({ "X-Producer-User": g1.guest.id, "X-Producer-Room": room.id, "X-Producer-Role": "guest" }));
    const [host, guest] = hub.state.getWebSockets() as unknown as FakeSocket[];
    await hub.object.webSocketMessage(host as never, JSON.stringify({ type: "subscribe", channel: "interaction:host" }));
    await hub.object.webSocketMessage(guest as never, JSON.stringify({ type: "subscribe", channel: "interaction:host" }));
    expect(guest.frames().at(-1)).toMatchObject({ type: "error", code: "forbidden", status: 403 });
    await hub.object.webSocketMessage(guest as never, JSON.stringify({ type: "subscribe", channel: "interaction:guest" }));

    // A phone connects before anything is open: an empty snapshot.
    const t = await audienceToken(e, aud.code, "device-one-1234");
    expect(t.signaling_url).toContain("/v1/connect/audience-signal?token=");
    const rs = e.ROOMSTATE.get(e.ROOMSTATE.idFromName(`roomstate:${room.id}`)) && e.ROOMSTATE.instances.get(`roomstate:${room.id}`)!;
    await rs.object.acceptAudience(upgrade({ "X-Producer-User": "aud_x" }));
    const phone = rs.state.getWebSockets()[0] as unknown as FakeSocket;
    expect(phone.frames()[0]).toMatchObject({ type: "snapshot", interactions: [] });
    expect(typeof phone.frames()[0].server_now).toBe("number");

    const ix = await openVote(e, room.id);
    await patch(e, room.id, ix.id, { transition: "open" });
    const hostFrames = host.frames().filter((f) => f.action === "interaction");
    expect(hostFrames.at(-1)).toMatchObject({ channels: ["interaction:host"], payload: { id: ix.id, state: "collecting" } });
    const guestFrames = guest.frames().filter((f) => f.action === "interaction");
    expect(guestFrames.at(-1)).toMatchObject({ channels: ["interaction:guest"], payload: { id: ix.id, state: "collecting" } });
    expect((guestFrames.at(-1)!.payload as { tally?: unknown }).tally).toBeUndefined();
    expect(phone.frames().at(-1)).toMatchObject({ type: "interaction", interaction: { id: ix.id, state: "collecting" } });

    // A vote → a coalesced delta to the host (running tally), none of it to the phone's tally.
    await call(e, "POST", `/v1/connect/guest/${g1.invite_code}/interactions/${ix.id}/inputs`, { value: "b" });
    await new Promise((r) => setTimeout(r, 320));
    const delta = host.frames().filter((f) => f.action === "interaction").at(-1)!;
    expect((delta.payload as { tally: { total: number } }).tally.total).toBe(1);
    const phoneLast = phone.frames().at(-1)!;
    expect((phoneLast.interaction as { tally?: unknown }).tally).toBeUndefined();
    expect(typeof (phoneLast.interaction as { server_now: number }).server_now).toBe("number");

    // Close → the reveal reaches the phone with the tally.
    await patch(e, room.id, ix.id, { transition: "close" });
    expect(phone.frames().at(-1)).toMatchObject({ type: "interaction", interaction: { state: "closed", tally: { total: 1, winner: "b" } } });
    // The phone's socket is read-only: a ping answers with the clock, anything else is ignored.
    await rs.object.webSocketMessage(phone as never, JSON.stringify({ type: "ping" }));
    expect(phone.frames().at(-1)).toMatchObject({ type: "pong" });
    await rs.object.webSocketMessage(phone as never, JSON.stringify({ type: "input", value: "a" }));
    expect(phone.frames().at(-1)).toMatchObject({ type: "pong" });
  });
});

void FakeState;

describe("[interaction] participant-side helpers (guest/src/interactions.ts)", () => {
  it("parses frames of every shape, merges by version, picks the active one, keeps the server clock", async () => {
    const m = await import("../guest/src/interactions");
    const doc = { id: "ix_abcdefghijkl", room_id: "r", type: "vote", state: "collecting", version: 1, spec: { prompt: "", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, input: { roles: ["guest"], per_identity: "once", cooldown_ms: 0 }, timing: { collect_ms: 0, reveal_hold_ms: 0, reveal_at: new Date(5_000).toISOString() }, render: [], server_now: 1_000 };
    expect(m.interactionFromFrame({ action: "interaction", payload: doc })?.id).toBe(doc.id);
    expect(m.interactionFromFrame({ type: "interaction", interaction: doc })?.id).toBe(doc.id);
    expect(m.interactionFromFrame(doc)?.id).toBe(doc.id);
    expect(m.interactionFromFrame({ type: "interaction", interaction: { id: 1 } })).toBeNull();
    const d = m.interactionFromFrame(doc)!;
    let list = m.mergeInteraction([], d);
    list = m.mergeInteraction(list, { ...d, version: 0, state: "open" }); // stale → ignored
    expect(list[0].state).toBe("collecting");
    expect(m.activeInteraction(list)?.id).toBe(d.id);
    list = m.mergeInteraction(list, { ...d, version: 2, state: "cancelled" });
    expect(list).toHaveLength(0);
    list = m.mergeInteraction(list, { ...d, version: 3, state: "closed", tally: { total: 3, options: { a: 2, b: 1 }, winner: "a" } });
    expect(m.activeInteraction(list)?.state).toBe("closed");
    expect(m.shares(list[0].tally, list[0].spec.options)).toEqual({ a: 67, b: 33 });
    expect(m.shares(undefined, list[0].spec.options)).toEqual({ a: 0, b: 0 });
    const offset = m.clockOffset(1_000, 4_000); // the server is 3 s behind this phone
    expect(offset).toBe(-3_000);
    expect(m.msUntil(new Date(5_000).toISOString(), offset, 4_000)).toBe(4_000);
    expect(m.msUntil(undefined, offset)).toBeNull();
  });
});
