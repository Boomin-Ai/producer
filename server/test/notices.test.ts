// Notice persistence (src/lib/notices.ts, v0.4.38): after its ttl a notice
// FADES in place instead of vanishing; only the last faded one persists; a
// new notice replaces it; errors never fade.
import { describe, expect, it } from "vitest";
import { fadeIn, pushIn, type Notice } from "../../src/lib/notices";

const mk = (id: number, over: Partial<Notice> = {}): Notice => ({ id, text: `n${id}`, tone: "info", ttl: 4000, ...over });

describe("fadeIn", () => {
  it("dims the notice in place rather than dropping it", () => {
    const l = fadeIn([mk(1)], 1);
    expect(l).toHaveLength(1);
    expect(l[0].faded).toBe(true);
  });
  it("keeps only the LAST faded notice", () => {
    let l: Notice[] = [mk(1), mk(2)];
    l = fadeIn(l, 1);
    l = fadeIn(l, 2);
    expect(l.map((n) => n.id)).toEqual([2]);
    expect(l[0].faded).toBe(true);
  });
  it("leaves active notices alone when an older one fades", () => {
    const l = fadeIn([mk(1), mk(2)], 1);
    expect(l.map((n) => [n.id, !!n.faded])).toEqual([[1, true], [2, false]]);
  });
  it("errors never fade — same list back", () => {
    const l = [mk(1, { tone: "error" })];
    expect(fadeIn(l, 1)).toBe(l);
  });
  it("an unknown id is a no-op", () => {
    const l = [mk(1)];
    expect(fadeIn(l, 9)).toBe(l);
  });
});

describe("pushIn", () => {
  it("a new notice replaces whatever was lingering faded", () => {
    const l = pushIn([mk(1, { faded: true }), mk(2)], mk(3));
    expect(l.map((n) => n.id)).toEqual([2, 3]);
  });
  it("a keyed notice replaces its predecessor by key", () => {
    const l = pushIn([mk(1, { key: "engine" }), mk(2)], mk(3, { key: "engine" }));
    expect(l.map((n) => n.id)).toEqual([2, 3]);
  });
  it("faded + active + fade again → exactly one persisted", () => {
    let l: Notice[] = [];
    l = pushIn(l, mk(1));
    l = fadeIn(l, 1);
    l = pushIn(l, mk(2));
    expect(l.map((n) => n.id)).toEqual([2]);
    l = fadeIn(l, 2);
    expect(l).toEqual([{ ...mk(2), faded: true }]);
  });
});
