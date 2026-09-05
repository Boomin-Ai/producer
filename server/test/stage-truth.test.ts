// Honest staging (src/lib/stageTruth.ts): a mod's Stage toggle is a request;
// only the host's confirmed list flips the row.
import { describe, expect, it } from "vitest";
import {
  EMPTY_MOD_STAGE,
  HOST_ANSWER_MS,
  HOST_KEPT_ON,
  HOST_SILENT,
  NO_FREE_SLOT,
  hostStagePlan,
  isOwnEcho,
  modRowStage,
  modStageReduce,
  modStageWish,
  type ModStageState,
} from "../../src/lib/stageTruth";
import { parseBoominFrame } from "../../src/lib/boominRoom";

const G = "11111111-1111-4111-8111-111111111111";
const H = "22222222-2222-4222-8222-222222222222";

describe("modStageReduce", () => {
  it("a request is pending until the host answers — the echo does not flip the row", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [], version: 3 };
    s = modStageReduce(s, { type: "request", guestId: G, want: true, version: 4, now: 1000 });
    expect(modRowStage(s, G)).toBe("pending-on");
    // The server pushes our own request back (version 4): still pending.
    s = modStageReduce(s, { type: "frame", on_stage: [G], version: 4, now: 1100 });
    expect(modRowStage(s, G)).toBe("pending-on");
    expect(s.confirmed).toEqual([]);
    // The host confirmed (version 5, guest present): on.
    s = modStageReduce(s, { type: "frame", on_stage: [G], version: 5, now: 1500 });
    expect(modRowStage(s, G)).toBe("on");
    expect(s.pending).toBeNull();
    expect(s.notice).toBeNull();
  });

  it("a newer frame without the guest is a refusal: snaps back with the no-slot reason", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [H], version: 7 };
    s = modStageReduce(s, { type: "request", guestId: G, want: true, version: 8, now: 0 });
    s = modStageReduce(s, { type: "frame", on_stage: [H, G], version: 8, now: 10 }); // echo
    s = modStageReduce(s, { type: "frame", on_stage: [H], version: 9, now: 20 }); // host truth
    expect(modRowStage(s, G)).toBe("off");
    expect(s.confirmed).toEqual([H]);
    expect(s.notice).toEqual({ guestId: G, text: NO_FREE_SLOT });
  });

  it("removing: the host keeping them on is its own message", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [G], version: 1 };
    s = modStageReduce(s, { type: "request", guestId: G, want: false, version: 2, now: 0 });
    expect(modRowStage(s, G)).toBe("pending-off");
    s = modStageReduce(s, { type: "frame", on_stage: [G], version: 3, now: 5 });
    expect(modRowStage(s, G)).toBe("on");
    expect(s.notice?.text).toBe(HOST_KEPT_ON);
  });

  it("no answer within HOST_ANSWER_MS: the row snaps back and says the host is silent", () => {
    let s = modStageReduce(EMPTY_MOD_STAGE, { type: "request", guestId: G, want: true, version: 1, now: 0 });
    s = modStageReduce(s, { type: "tick", now: HOST_ANSWER_MS - 1 });
    expect(modRowStage(s, G)).toBe("pending-on");
    s = modStageReduce(s, { type: "tick", now: HOST_ANSWER_MS });
    expect(modRowStage(s, G)).toBe("off");
    expect(s.notice?.text).toBe(HOST_SILENT);
  });

  it("a failed POST changes nothing but the notice", () => {
    const s = modStageReduce({ ...EMPTY_MOD_STAGE, confirmed: [H] }, { type: "request-failed", guestId: G, error: "stage_full" });
    expect(s.confirmed).toEqual([H]);
    expect(s.pending).toBeNull();
    expect(s.notice).toEqual({ guestId: G, text: "stage_full" });
  });

  it("stale frames are ignored; frames with no request pending are the truth", () => {
    let s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [G], version: 5 };
    expect(modStageReduce(s, { type: "frame", on_stage: [], version: 4, now: 0 })).toBe(s);
    s = modStageReduce(s, { type: "frame", on_stage: [G, H], version: 6, now: 0 });
    expect(s.confirmed).toEqual([G, H]);
    expect(s.version).toBe(6);
  });

  it("the wish is the full confirmed list with one guest flipped", () => {
    const s: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: [H] };
    expect(modStageWish(s, G)).toEqual({ on_stage: [H, G], want: true });
    expect(modStageWish(s, H)).toEqual({ on_stage: [], want: false });
  });

  it("dismiss clears the notice for that guest only", () => {
    const s: ModStageState = { ...EMPTY_MOD_STAGE, notice: { guestId: G, text: "x" } };
    expect(modStageReduce(s, { type: "dismiss", guestId: H })).toBe(s);
    expect(modStageReduce(s, { type: "dismiss", guestId: G }).notice).toBeNull();
    expect(modStageReduce(s, { type: "dismiss" }).notice).toBeNull();
  });
});

describe("hostStagePlan / isOwnEcho", () => {
  it("shows requested-and-admitted guests it is not showing, hides the rest", () => {
    expect(hostStagePlan({ requested: [G, H, "ghost"], shown: [H, "old"], admitted: [G, H, "old"] })).toEqual({
      toShow: [G],
      toHide: ["old"],
    });
  });
  it("a frame no newer than the host's own post is its echo", () => {
    expect(isOwnEcho(4, 4)).toBe(true);
    expect(isOwnEcho(3, 4)).toBe(true);
    expect(isOwnEcho(5, 4)).toBe(false);
  });
});

describe("parseBoominFrame stage", () => {
  it("maps the server's stage publish", () => {
    const raw = JSON.stringify({ channels: ["stage"], action: "stage", payload: { on_stage: [G, 7], version: 3 } });
    expect(parseBoominFrame(raw)).toEqual({ type: "stage", on_stage: [G], version: 3 });
  });
  it("drops a stage publish without a version", () => {
    expect(parseBoominFrame(JSON.stringify({ channels: ["stage"], action: "stage", payload: { on_stage: [] } }))).toBeNull();
  });
});
