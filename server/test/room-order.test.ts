// Home's ON AIR order (src/lib/roomOrder.ts): main stage first, then by
// creation — and never by last_live_at, so leaving a room moves nothing.
import { describe, expect, it } from "vitest";
import { sortRooms } from "../../src/lib/roomOrder";

const r = (id: string, created_at: string, last_live_at: string | null = null) => ({ id, created_at, last_live_at });

describe("sortRooms", () => {
  it("pins the main stage first, then oldest first", () => {
    const rooms = [r("c", "2026-03"), r("a", "2026-01"), r("m", "2026-02")];
    expect(sortRooms(rooms, "m").map((x) => x.id)).toEqual(["m", "a", "c"]);
    expect(sortRooms(rooms, null).map((x) => x.id)).toEqual(["a", "m", "c"]);
  });
  it("ignores last_live_at: going live and leaving reorders nothing", () => {
    const before = [r("a", "2026-01", null), r("b", "2026-02", null)];
    const after = [r("a", "2026-01", null), r("b", "2026-02", "2026-09-05T00:00:00Z")];
    expect(sortRooms(before, null).map((x) => x.id)).toEqual(sortRooms(after, null).map((x) => x.id));
  });
  it("is stable for equal creation stamps (id breaks the tie)", () => {
    const rooms = [r("b", "2026-01"), r("a", "2026-01")];
    expect(sortRooms(rooms, null).map((x) => x.id)).toEqual(["a", "b"]);
    expect(sortRooms([...rooms].reverse(), null).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("does not mutate its input", () => {
    const rooms = [r("b", "2026-02"), r("a", "2026-01")];
    sortRooms(rooms, null);
    expect(rooms.map((x) => x.id)).toEqual(["b", "a"]);
  });
});
