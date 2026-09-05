// Phase 1 item 5 (#50) — the contribution ledger. Names mirror Boomin's
// rooms-smoke so both sides read the same list.
import { describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import worker from "../src/index";
import { HOST_PRESENCE_WINDOW_MS, createRoom, joinRoomByCode, revokeGuest, setGrant, setRoomJoinLink, setStage, type GuestRow } from "../src/guests";
import { closeInterval, expireStale, listForRoom, openInterval, presenceSeconds, startRun, stopRun, syncPresence, type ContributionRow } from "../src/contributions";

const ORIGIN = "https://producer.example.workers.dev";
const PRIMARY = "primary-token-for-tests";

function env(): Env {
  return { DB: fakeD1(), MEDIA: {} as R2Bucket, PRIMARY_TOKEN: PRIMARY, SIGNALING_SECRET: "a-32-char-signaling-secret-000000" };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
async function call(e: Env, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
}
const json = async <T,>(r: Response) => (await r.json()) as T;

async function roomWithGuests(e: Env, n = 2) {
  const { room } = await createRoom(e, { title: "Show", externalRef: "local-1" });
  const link = await setRoomJoinLink(e, ORIGIN, { roomId: room.id, enabled: true, autoAdmit: true });
  const code = link.join_url!.split("/").pop()!;
  const guests: GuestRow[] = [];
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const j = await joinRoomByCode(e, { roomCode: code, displayName: `G${i}` });
    guests.push(j.guest);
    codes.push(j.invite_code);
  }
  return { room, guests, codes };
}
const openRows = (rows: ContributionRow[]) => rows.filter((r) => r.ended_at === null);

describe("[ledger]", () => {
  it("stage publish opens a presence interval with server time and closes it on the next publish", async () => {
    const e = env();
    const { room, guests } = await roomWithGuests(e);
    const before = Date.now() - 1000;
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    let rows = await listForRoom(e, room.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ participant_id: guests[0].id, kind: "presence", source: "host_stage", binding: JSON.stringify({ slot: 0 }), ended_at: null });
    expect(rows[0].started_at).toBeGreaterThanOrEqual(before);
    await setStage(e, { roomId: room.id, onStage: [guests[1].id] });
    rows = await listForRoom(e, room.id);
    expect(rows).toHaveLength(2);
    const g0 = rows.find((r) => r.participant_id === guests[0].id)!;
    expect(g0.ended_at).not.toBeNull();
    expect(openRows(rows).map((r) => r.participant_id)).toEqual([guests[1].id]);
  });

  it("a retry of the same open never forks a second interval (UNIQUE participant, kind, started_at)", async () => {
    const e = env();
    const { room, guests } = await roomWithGuests(e, 1);
    const a = await openInterval(e, { roomId: room.id, participantId: guests[0].id, kind: "presence", binding: { slot: 0 }, source: "host_stage", at: 1000 });
    const b = await openInterval(e, { roomId: room.id, participantId: guests[0].id, kind: "presence", binding: { slot: 0 }, source: "host_stage", at: 1000 });
    expect(b.id).toBe(a.id);
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    expect(await listForRoom(e, room.id)).toHaveLength(1);
    // Same second, direct INSERT path: the UNIQUE index absorbs it.
    await closeInterval(e, { roomId: room.id, participantId: guests[0].id, kind: "presence", binding: { slot: 0 }, at: 1001 });
    const c = await openInterval(e, { roomId: room.id, participantId: guests[0].id, kind: "presence", binding: { slot: 0 }, source: "host_stage", at: 1000 });
    expect(c.id).toBe(a.id);
    expect(await listForRoom(e, room.id)).toHaveLength(1);
  });

  it("overlay show and hide write one overlay interval carrying its binding", async () => {
    const e = env();
    const { room } = await roomWithGuests(e, 0);
    const show = await call(e, "POST", `/v1/app/live/rooms/${room.id}/overlays`, { source_id: "image-ab12", binding: { sponsor: "acme", corner: "tl" }, shown: true, label: "Acme logo" }, PRIMARY);
    expect(show.status).toBe(200);
    const again = await call(e, "POST", `/v1/app/live/rooms/${room.id}/overlays`, { source_id: "image-ab12", binding: { corner: "tl", sponsor: "acme" }, shown: true }, PRIMARY);
    expect((await json<{ contribution: { id: string } }>(again)).contribution.id).toBe((await json<{ contribution: { id: string } }>(show)).contribution.id);
    const hide = await call(e, "POST", `/v1/app/live/rooms/${room.id}/overlays`, { source_id: "image-ab12", binding: { sponsor: "acme", corner: "tl" }, shown: false }, PRIMARY);
    const hidden = (await json<{ contribution: { ended_at: string | null; binding: Record<string, unknown>; metadata: Record<string, unknown> } }>(hide)).contribution;
    expect(hidden.ended_at).not.toBeNull();
    expect(hidden.binding).toEqual({ corner: "tl", source_id: "image-ab12", sponsor: "acme" });
    const rows = await listForRoom(e, room.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "overlay", participant_id: null, source: "host_stage" });
    expect(JSON.parse(rows[0].metadata)).toEqual({ label: "Acme logo" });
  });

  it("screen share start and stop write one media.screen interval; without the grant it is 403", async () => {
    const e = env();
    const { room, guests, codes } = await roomWithGuests(e, 1);
    const denied = await call(e, "POST", `/v1/connect/guest/${codes[0]}/share`, { active: true });
    expect(denied.status).toBe(403);
    await setGrant(e, guests[0].id, "media.screen", true);
    expect((await call(e, "POST", `/v1/connect/guest/${codes[0]}/share`, { active: true })).status).toBe(200);
    expect((await call(e, "POST", `/v1/connect/guest/${codes[0]}/share`, { active: false })).status).toBe(200);
    const rows = await listForRoom(e, room.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "media.screen", participant_id: guests[0].id, source: "participant", binding: JSON.stringify({ track: "screen" }) });
    expect(rows[0].ended_at).not.toBeNull();
  });

  it("an open interval self-expires against the host heartbeat", async () => {
    const e = env();
    const { room, guests } = await roomWithGuests(e, 1);
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    const seen = Math.floor(Date.now() / 1000) - 600;
    await e.DB.prepare("UPDATE live_rooms SET host_seen_at = ?2 WHERE id = ?1").bind(room.id, seen).run();
    // Still present → nothing closes.
    expect(await expireStale(e, (seen + 10) * 1000)).toBe(0);
    // Past the window → closed at last-seen + window, not "now".
    expect(await expireStale(e)).toBe(1);
    const row = (await listForRoom(e, room.id))[0];
    expect(row.ended_at).toBe(Math.max(row.started_at, seen * 1000 + HOST_PRESENCE_WINDOW_MS));
    // Revoking a guest also ends everything they held.
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    await revokeGuest(e, guests[0].id);
    expect(openRows(await listForRoom(e, room.id))).toHaveLength(0);
  });

  it("GET rooms/:id/contributions lists both kinds with intervals, newest first, scoped to the run", async () => {
    const e = env();
    const { room, guests } = await roomWithGuests(e, 1);
    // Before any run: rows carry run_id null and the list shows everything.
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    await setStage(e, { roomId: room.id, onStage: [] });
    const started = await call(e, "POST", `/v1/app/live/rooms/${room.id}/runs`, { action: "start" }, PRIMARY);
    expect(started.status).toBe(201);
    const { run_id } = await json<{ run_id: string }>(started);
    expect(run_id).toMatch(/^run_/);
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    await call(e, "POST", `/v1/app/live/rooms/${room.id}/overlays`, { source_id: "text-1", binding: { sponsor: "acme" }, shown: true }, PRIMARY);
    const res = await call(e, "GET", `/v1/app/live/rooms/${room.id}/contributions`, undefined, PRIMARY);
    const body = await json<{ contributions: { kind: string; run_id: string; started_at: string; ended_at: string | null }[]; run_id: string }>(res);
    expect(body.run_id).toBe(run_id);
    expect(body.contributions.map((c) => c.kind).sort()).toEqual(["overlay", "presence"]);
    expect(body.contributions.every((c) => c.run_id === run_id && c.ended_at === null && typeof c.started_at === "string")).toBe(true);
    const stopped = await json<{ run_id: string; closed: number }>(await call(e, "POST", `/v1/app/live/rooms/${room.id}/runs`, { action: "stop" }, PRIMARY));
    expect(stopped).toEqual({ run_id, closed: 2 });
    // After the stop, the default view is still that run (the latest with rows).
    const after = await json<{ contributions: { ended_at: string | null }[] }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/contributions?run=${run_id}`, undefined, PRIMARY));
    expect(after.contributions).toHaveLength(2);
    expect(after.contributions.every((c) => c.ended_at !== null)).toBe(true);
    const dflt = await json<{ run_id: string }>(await call(e, "GET", `/v1/app/live/rooms/${room.id}/contributions`, undefined, PRIMARY));
    expect(dflt.run_id).toBe(run_id);
    // A start while on stage opens presence under the NEW run; stop twice is fine.
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    const r2 = await startRun(e, room.id, [guests[0].id]);
    const open = openRows(await listForRoom(e, room.id, r2.run_id));
    expect(open).toHaveLength(1);
    expect(open[0].run_id).toBe(r2.run_id);
    await stopRun(e, room.id);
    expect((await stopRun(e, room.id)).run_id).toBeNull();
  });

  it("stage_seconds equals the summed closed presence intervals for the guest", async () => {
    const e = env();
    const { room, guests } = await roomWithGuests(e, 1);
    // Drive the clock by hand through syncPresence with explicit times, and
    // the guest-row cache the same way the stage publish does.
    await syncPresence(e, room.id, [guests[0].id], 1_000_000);
    await syncPresence(e, room.id, [], 1_090_000);
    await syncPresence(e, room.id, [guests[0].id], 2_000_000);
    await syncPresence(e, room.id, [], 2_030_000);
    expect(await presenceSeconds(e, room.id, guests[0].id)).toBe(120);
    // The live path: both clocks move in the same publish.
    await setStage(e, { roomId: room.id, onStage: [guests[0].id] });
    await setStage(e, { roomId: room.id, onStage: [] });
    const row = (await e.DB.prepare("SELECT stage_seconds FROM live_room_guests WHERE id = ?1").bind(guests[0].id).first<{ stage_seconds: number }>())!;
    expect(await presenceSeconds(e, room.id, guests[0].id)).toBe(120 + row.stage_seconds);
  });
});
