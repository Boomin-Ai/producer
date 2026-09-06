// The Mod View's pure half (src/lib/modBoard.ts): the board's layout and the
// throw-up projection over honest staging.
import { describe, expect, it } from "vitest";
import {
  ASK_HOST,
  DEFAULT_MOD_BOARD,
  MOD_BOARD_PANELS,
  boardRegionOf,
  heldChips,
  moveBoardPanel,
  normalizeModBoard,
  sameBoard,
  seatFeeds,
  serializeModBoard,
  throwUpState,
} from "../../src/lib/modBoard";
import { MOD_FEED_NOT_PLACED, EMPTY_MOD_STAGE, HOST_ANSWER_MS, HOST_SILENT, NO_FREE_SLOT, modStageReduce, type ModStageState } from "../../src/lib/stageTruth";

const SEAT = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

describe("the board layout", () => {
  it("the default is the founder's board: monitor top, scene pads in the strip, people left, feeds right, switches bottom", () => {
    expect(DEFAULT_MOD_BOARD).toEqual({ top: ["monitor"], strip: ["scenes"], left: ["people"], right: ["feeds"], bottom: ["switches"], hidden: [] });
    expect(normalizeModBoard(null)).toEqual(DEFAULT_MOD_BOARD);
    expect(normalizeModBoard("not json")).toEqual(DEFAULT_MOD_BOARD);
    expect(normalizeModBoard({})).toEqual(DEFAULT_MOD_BOARD);
  });
  it("round-trips through the pref string and keeps every panel exactly once", () => {
    const moved = moveBoardPanel(DEFAULT_MOD_BOARD, "feeds", "left");
    const back = normalizeModBoard(serializeModBoard(moved));
    expect(back.left).toEqual(["people", "feeds"]);
    expect(back.right).toEqual([]);
    expect(sameBoard(back, moved)).toBe(true);
    const all = [...back.top, ...back.strip, ...back.left, ...back.right, ...back.bottom, ...back.hidden].sort();
    expect(all).toEqual([...MOD_BOARD_PANELS].sort());
  });
  it("a saved layout that predates a panel gets it at its intro region; unknown ids and duplicates are dropped", () => {
    const old = { top: ["monitor"], strip: ["scenes", "scenes", "soundboard"], left: ["people"], right: [], bottom: [], hidden: [] };
    const l = normalizeModBoard(old);
    expect(l.strip).toEqual(["scenes"]);
    expect(l.right).toEqual(["feeds"]);
    expect(l.bottom).toEqual(["switches"]);
    expect(boardRegionOf(l, "feeds")).toBe("right");
  });
  it("a hidden panel stays hidden once the seat saved it so", () => {
    const l = normalizeModBoard(moveBoardPanel(DEFAULT_MOD_BOARD, "switches", "hidden"));
    expect(l.hidden).toEqual(["switches"]);
    expect(l.bottom).toEqual([]);
  });
});

describe("my feeds", () => {
  it("windows follow the media grants; the greyed line asks the host", () => {
    expect(seatFeeds(new Set(["media.return_feed"]))).toEqual({ camera: false, mic: false, screen: false, any: false });
    expect(seatFeeds(new Set(["media.camera", "media.mic", "media.return_feed"]))).toEqual({ camera: true, mic: true, screen: false, any: true });
    expect(ASK_HOST.camera).toMatch(/host/i);
    expect(ASK_HOST.screen).toMatch(/host/i);
  });
  it("held chips name control and media in the doctrine's words", () => {
    const chips = heldChips({ grants: new Set(["media.camera", "media.return_feed"]), can: { control: true, scene: true, interactions: false, manage: false } });
    expect(chips).toEqual(["cuts scenes", "admits · stages", "camera", "return feed"]);
  });
});

describe("throw up (the seat's own row through honest staging)", () => {
  const media = new Set(["media.camera", "media.mic", "media.return_feed"]);
  it("no media → nothing to throw; no row / no control → unavailable", () => {
    expect(throwUpState({ stage: EMPTY_MOD_STAGE, seatId: SEAT, grants: new Set(["media.return_feed"]), canAsk: true }).row).toBe("no-media");
    expect(throwUpState({ stage: EMPTY_MOD_STAGE, seatId: null, grants: media, canAsk: true }).row).toBe("unavailable");
    expect(throwUpState({ stage: EMPTY_MOD_STAGE, seatId: SEAT, grants: media, canAsk: false }).row).toBe("unavailable");
  });
  it("off → asking → on, only when the HOST's answer carries the seat", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [OTHER], version: 2 };
    expect(throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true })).toMatchObject({ row: "off", label: "Throw up", disabled: false });
    s = modStageReduce(s, { type: "request", guestId: SEAT, want: true, version: 3, now: 0 });
    expect(throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true })).toMatchObject({ row: "pending-on", disabled: true });
    // The server's echo of our own ask: still pending.
    s = modStageReduce(s, { type: "frame", on_stage: [OTHER, SEAT], version: 3, now: 10 });
    expect(throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true }).row).toBe("pending-on");
    // The host's set confirmed.
    s = modStageReduce(s, { type: "frame", on_stage: [OTHER, SEAT], version: 4, now: 20 });
    expect(throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true })).toMatchObject({ row: "on", disabled: false });
    expect(throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true }).label).toMatch(/take down/i);
  });
  it("a refusal snaps back to off with the reason on the button — worded for a MOD FEED (no slot to run out of, v0.4.32)", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [], version: 5 };
    s = modStageReduce(s, { type: "request", guestId: SEAT, want: true, version: 6, now: 0 });
    s = modStageReduce(s, { type: "frame", on_stage: [], version: 7, now: 5 });
    expect(s.notice?.text).toBe(NO_FREE_SLOT);
    const t = throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true });
    expect(t.row).toBe("off");
    expect(t.notice).toBe(MOD_FEED_NOT_PLACED);
  });
  it("the host's silence is its own message; another guest's notice is not ours", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [], version: 1 };
    s = modStageReduce(s, { type: "request", guestId: SEAT, want: true, version: 2, now: 0 });
    s = modStageReduce(s, { type: "tick", now: HOST_ANSWER_MS + 1 });
    expect(throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true }).notice).toBe(HOST_SILENT);
    expect(throwUpState({ stage: s, seatId: OTHER, grants: media, canAsk: true }).notice).toBeNull();
  });
  it("taking down goes through the same pending state", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [SEAT], version: 9 };
    s = modStageReduce(s, { type: "request", guestId: SEAT, want: false, version: 10, now: 0 });
    expect(throwUpState({ stage: s, seatId: SEAT, grants: media, canAsk: true })).toMatchObject({ row: "pending-off", disabled: true });
  });
});
