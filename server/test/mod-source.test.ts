// The OFFICIAL MOD SOURCE (v0.4.32): a seat's media is its own source kind —
// never a guest source, never a guest slot — with its own placement and its
// own branch of the host's stage plan. Pure halves: participants.ts,
// src/lib/modFeed.ts, src/lib/stageTruth.ts, src/lib/modBoard.ts.
import { describe, expect, it } from "vitest";
import {
  dedupeSeatRows,
  isModSourceId,
  modSourceIdsFor,
  modSourceLabel,
  seatRoleLabel,
  sourceIdsFor,
  wantedModSourceIds,
  wantedSourceIds,
} from "../guest/src/participants";
import { defaultModFeedRect, fromCanvas, modFeedRect, modFeedZ, modSourceOwner, parseModFeeds, rememberModFeed, toCanvas } from "../../src/lib/modFeed";
import { EMPTY_MOD_STAGE, MOD_FEED_NOT_PLACED, NO_FREE_SLOT, hostStagePlan, modStageReduce } from "../../src/lib/stageTruth";
import { throwUpState } from "../../src/lib/modBoard";

const guest = (id: string, grants?: Record<string, boolean>) => ({ id, render_url: "https://x/render", grants, monitor: false });
const seat = (id: string, uid: string, grants: Record<string, boolean>, extra: Record<string, unknown> = {}) => ({
  id,
  render_url: "https://x/render",
  monitor: true,
  producer_ref: `monitor:${uid}`,
  display_name: "Jamie · monitor",
  grants: { "media.return_feed": true, ...grants },
  state: "admitted",
  ...extra,
});

describe("mod source ids", () => {
  it("are their own prefix, never a guest id", () => {
    const ids = modSourceIdsFor("0123456789abcdef");
    expect(ids).toEqual({ camera: "mod-01234567", screen: "mod-01234567-screen" });
    expect(isModSourceId(ids.camera)).toBe(true);
    expect(isModSourceId(ids.screen)).toBe(true);
    expect(isModSourceId(sourceIdsFor("0123456789abcdef").camera)).toBe(false);
  });
  it("label: '<name> — mod camera' / '— mod screen'", () => {
    const s = seat("s1", "u1", { "media.camera": true });
    expect(modSourceLabel(s, "camera")).toBe("Jamie — mod camera");
    expect(modSourceLabel(s, "screen")).toBe("Jamie — mod screen");
  });
});

describe("wantedSourceIds vs wantedModSourceIds", () => {
  const g = guest("g1");
  const gScreen = guest("g2", { "media.camera": true, "media.mic": true, "media.screen": true, "media.return_feed": true });
  const sCam = seat("s1", "u1", { "media.camera": true });
  const sMic = seat("s2", "u2", { "media.mic": true });
  const sScr = seat("s3", "u3", { "media.screen": true });
  const sAll = seat("s4", "u4", { "media.camera": true, "media.mic": true, "media.screen": true });
  const sNone = seat("s5", "u5", {});

  it("guest sources: guests only — a seat with media is NOT a guest source", () => {
    const w = wantedSourceIds([g, gScreen, sCam, sScr, sAll, sNone]);
    expect([...w.keys()].sort()).toEqual(["guest-g1", "guest-g2", "guest-g2-screen"]);
    for (const k of w.keys()) expect(isModSourceId(k)).toBe(false);
  });
  it("mod sources: camera page for camera OR mic, screen page for media.screen; nothing for a bare monitor or a guest", () => {
    const w = wantedModSourceIds([g, gScreen, sCam, sMic, sScr, sAll, sNone]);
    expect([...w.keys()].sort()).toEqual(["mod-s1", "mod-s2", "mod-s3-screen", "mod-s4", "mod-s4-screen"]);
    expect(w.get("mod-s1")).toMatchObject({ seat: sCam, track: "camera" });
    expect(w.get("mod-s3-screen")).toMatchObject({ seat: sScr, track: "screen" });
    expect(w.has("mod-s5")).toBe(false);
    expect(w.has("mod-g1")).toBe(false);
  });
  it("the two sets never overlap", () => {
    const rows = [g, gScreen, sCam, sAll];
    const a = new Set(wantedSourceIds(rows).keys());
    for (const k of wantedModSourceIds(rows).keys()) expect(a.has(k)).toBe(false);
  });
});

describe("dedupeSeatRows — one row per (room, member)", () => {
  it("hides ended / left rows and keeps the newest accepted row per user", () => {
    const old = seat("s-old", "u1", { "media.camera": true }, { joined_at: "2026-09-05T10:00:00Z" });
    const gone = seat("s-gone", "u1", {}, { state: "left", render_url: null, joined_at: "2026-09-05T10:30:00Z" });
    const fresh = seat("s-new", "u1", {}, { joined_at: "2026-09-05T11:00:00Z" });
    const other = seat("s-o", "u2", {}, { joined_at: "2026-09-05T09:00:00Z" });
    const out = dedupeSeatRows([gone, old, fresh, other, guest("g1")]);
    expect(out.map((r) => r.id)).toEqual(["s-new", "s-o"]);
  });
  it("a row with a render url beats one without, whatever the clock says", () => {
    const noUrl = seat("s-a", "u1", {}, { render_url: null, joined_at: "2026-09-05T12:00:00Z" });
    const withUrl = seat("s-b", "u1", {}, { joined_at: "2026-09-05T11:00:00Z" });
    expect(dedupeSeatRows([noUrl, withUrl]).map((r) => r.id)).toEqual(["s-b"]);
  });
  it("rows without a user fall back to producer_ref, then the row id", () => {
    const a = { id: "a", monitor: true, producer_ref: "Producer @ x", state: "admitted" };
    const b = { id: "b", monitor: true, producer_ref: "Producer @ x", state: "admitted", joined_at: "2026-09-05T12:00:00Z" };
    const c = { id: "c", monitor: true, state: "admitted" };
    expect(dedupeSeatRows([a, b, c]).map((r) => r.id)).toEqual(["b", "c"]);
  });
  it("never lists a non-monitor", () => {
    expect(dedupeSeatRows([guest("g1")])).toEqual([]);
  });
});

describe("seatRoleLabel — read from truth, never Host by default", () => {
  const s = seat("s1", "u1", {});
  const grantRow = (uid: string, room_role: string, grant_role = "editor") => ({ room_role, grant_role, member: { id: "m", role: "viewer", type: "collaborator" }, user: { id: uid } });
  it("a room grant wins: manager / mod / viewer", () => {
    expect(seatRoleLabel({ seat: s, grants: [grantRow("u1", "manager", "admin")], members: [] })).toBe("Manager");
    expect(seatRoleLabel({ seat: s, grants: [grantRow("u1", "mod")], members: [] })).toBe("Mod");
    expect(seatRoleLabel({ seat: s, grants: [grantRow("u1", "viewer", "viewer")], members: [] })).toBe("Viewer");
  });
  it("no grant: a team member at editor+ is the brand's host standing", () => {
    expect(seatRoleLabel({ seat: s, grants: [], members: [{ user_id: "u1", type: "team", role: "editor" }] })).toBe("Host");
    expect(seatRoleLabel({ seat: s, grants: null, members: [{ user_id: "u1", type: "team", role: "owner" }] })).toBe("Host");
    expect(seatRoleLabel({ seat: s, grants: null, members: [{ user_id: "u1", type: "team", role: "viewer" }] })).toBe("Viewer");
    expect(seatRoleLabel({ seat: s, grants: null, members: [{ user_id: "u1", type: "collaborator", role: "editor" }] })).toBe("Viewer");
  });
  it("unknown seat → Viewer, never Host", () => {
    expect(seatRoleLabel({ seat: s, grants: null, members: null })).toBe("Viewer");
    expect(seatRoleLabel({ seat: { monitor: true }, grants: null, members: null })).toBe("Viewer");
    expect(seatRoleLabel({ seat: s, grants: [grantRow("u9", "manager")], members: [{ user_id: "u9", type: "team", role: "owner" }] })).toBe("Viewer");
  });
});

describe("modFeed placement", () => {
  it("defaults: camera = lower-right PiP 28% wide; screen = full frame", () => {
    const cam = defaultModFeedRect("camera");
    expect(cam.w).toBeCloseTo(0.28);
    expect(cam.h).toBeCloseTo(0.28);
    expect(cam.x + cam.w).toBeLessThan(1);
    expect(cam.y + cam.h).toBeLessThan(1);
    expect(cam.x).toBeGreaterThan(0.5);
    expect(cam.y).toBeGreaterThan(0.5);
    expect(defaultModFeedRect("screen")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("canvas conversions round-trip at any canvas size", () => {
    const r = { x: 0.7, y: 0.65, w: 0.28, h: 0.28 };
    for (const [bw, bh] of [[1280, 720], [1920, 1080], [3840, 2160]] as const) {
      const c = toCanvas(r, bw, bh);
      expect(c).toEqual({ x: 0.7 * bw, y: 0.65 * bh, w: 0.28 * bw, h: 0.28 * bh });
      const back = fromCanvas(c, bw, bh);
      expect(back.x).toBeCloseTo(r.x);
      expect(back.h).toBeCloseTo(r.h);
    }
  });
  it("remembered rects win over the default; junk is dropped on parse", () => {
    const feeds = rememberModFeed(undefined, "p1", "camera", { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(modFeedRect(feeds, "p1", "camera")).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(modFeedRect(feeds, "p1", "screen")).toEqual(defaultModFeedRect("screen"));
    expect(modFeedRect(feeds, "p2", "camera")).toEqual(defaultModFeedRect("camera"));
    const parsed = parseModFeeds({ p1: { camera: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, screen: { x: "no" } }, p2: null, p3: { camera: { x: 0, y: 0, w: 0, h: 1 } } });
    expect(parsed).toEqual({ p1: { camera: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } } });
    expect(parseModFeeds("junk")).toEqual({});
  });
  it("layer: above guest slots and guests, just under the lowest overlay; on top when there is none", () => {
    const items = [
      { id: "screen", kind: "screen", z: 0 },
      { id: "gslot-1", kind: "color", z: 1 },
      { id: "guest-abc", kind: "guest", z: 2 },
      { id: "overlay", kind: "overlay", z: 3 },
      { id: "overlay-x", kind: "overlay", z: 4 },
    ];
    expect(modFeedZ(items)).toBe(3);
    expect(modFeedZ(items.filter((i) => i.kind !== "overlay"))).toBe(3);
    expect(modFeedZ([])).toBe(0);
  });
  it("modSourceOwner maps a source id back to its seat and track", () => {
    const rows = [seat("0123456789ab", "u1", { "media.camera": true }), guest("g1")];
    expect(modSourceOwner("mod-01234567", rows)).toMatchObject({ row: rows[0], track: "camera" });
    expect(modSourceOwner("mod-01234567-screen", rows)).toMatchObject({ row: rows[0], track: "screen" });
    expect(modSourceOwner("guest-g1", rows)).toBeNull();
    expect(modSourceOwner("mod-ffffffff", rows)).toBeNull();
  });
});

describe("hostStagePlan — seats take the MOD path", () => {
  it("a requested seat lands in toPlaceMod, never toShow; a dropped seat in toRemoveMod, never toHide", () => {
    const plan = hostStagePlan({ requested: ["g1", "s1"], shown: ["g2", "s2"], admitted: ["g1", "g2", "s1", "s2"], seats: ["s1", "s2"] });
    expect(plan).toEqual({ toShow: ["g1"], toHide: ["g2"], toPlaceMod: ["s1"], toRemoveMod: ["s2"] });
  });
  it("a seat the host has not handed media (not admitted to the set) is ignored", () => {
    const plan = hostStagePlan({ requested: ["s9"], shown: [], admitted: ["g1"], seats: ["s9"] });
    expect(plan.toPlaceMod).toEqual([]);
    expect(plan.toShow).toEqual([]);
  });
  it("without `seats` everyone is a guest (v0.4.31 callers unchanged)", () => {
    const plan = hostStagePlan({ requested: ["a"], shown: [], admitted: ["a"] });
    expect(plan).toEqual({ toShow: ["a"], toHide: [], toPlaceMod: [], toRemoveMod: [] });
  });
  it("a seat that is already placed and still requested moves nowhere", () => {
    const plan = hostStagePlan({ requested: ["s1"], shown: ["s1"], admitted: ["s1"], seats: ["s1"] });
    expect(plan).toEqual({ toShow: [], toHide: [], toPlaceMod: [], toRemoveMod: [] });
  });
});

describe("throw up (seat side) — the refusal is worded for a mod feed", () => {
  const grants = new Set(["media.camera", "media.return_feed"]);
  it("a refused placement reads MOD_FEED_NOT_PLACED, not the guest-slot line", () => {
    let st = modStageReduce(EMPTY_MOD_STAGE, { type: "request", guestId: "s1", want: true, version: 2, now: 0 });
    st = modStageReduce(st, { type: "frame", on_stage: [], version: 3, now: 100 });
    expect(st.notice?.text).toBe(NO_FREE_SLOT);
    const t = throwUpState({ stage: st, seatId: "s1", grants, canAsk: true });
    expect(t.row).toBe("off");
    expect(t.notice).toBe(MOD_FEED_NOT_PLACED);
  });
  it("a placed seat reads ON SET", () => {
    let st = modStageReduce(EMPTY_MOD_STAGE, { type: "request", guestId: "s1", want: true, version: 2, now: 0 });
    st = modStageReduce(st, { type: "frame", on_stage: ["s1"], version: 3, now: 100 });
    const t = throwUpState({ stage: st, seatId: "s1", grants, canAsk: true });
    expect(t.row).toBe("on");
    expect(t.notice).toBeNull();
  });
});
