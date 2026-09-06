// The ONE placement button's pure half (src/lib/placement.ts): the ring it
// walks on hover / arrows, and the skip-what's-not-allowed walk.
import { describe, expect, it } from "vitest";
import { PLACEMENTS, nextAllowed, nextPlacement, placementLabel } from "../../src/lib/placement";

describe("nextPlacement", () => {
  it("walks the ring clockwise and wraps", () => {
    expect(nextPlacement("top", PLACEMENTS)).toBe("right");
    expect(nextPlacement("right", PLACEMENTS)).toBe("bottom");
    expect(nextPlacement("bottom", PLACEMENTS)).toBe("left");
    expect(nextPlacement("left", PLACEMENTS)).toBe("top");
  });
  it("steps backwards for the left/up arrows", () => {
    expect(nextPlacement("top", PLACEMENTS, -1)).toBe("left");
    expect(nextPlacement("left", PLACEMENTS, -1)).toBe("bottom");
  });
  it("a full loop of hover ticks returns to the start", () => {
    let p: (typeof PLACEMENTS)[number] = "bottom";
    for (let i = 0; i < PLACEMENTS.length; i++) p = nextPlacement(p, PLACEMENTS);
    expect(p).toBe("bottom");
  });
  it("a value outside the ring lands on the first entry; an empty ring is inert", () => {
    expect(nextPlacement("hidden" as never, PLACEMENTS)).toBe("top");
    expect(nextPlacement("top", [])).toBe("top");
  });
  it("a ring with hidden (the Panels list) cycles through it", () => {
    const ring = [...PLACEMENTS, "hidden"] as const;
    expect(nextPlacement("left", ring)).toBe("hidden");
    expect(nextPlacement("hidden", ring)).toBe("top");
  });
});

describe("nextAllowed", () => {
  it("skips entries the predicate rejects", () => {
    expect(nextAllowed("top", PLACEMENTS, (p) => p !== "right")).toBe("bottom");
  });
  it("stays put when nothing is allowed", () => {
    expect(nextAllowed("top", PLACEMENTS, () => false)).toBe("top");
  });
});

describe("placementLabel", () => {
  it('reads "Move to <dock>"', () => {
    expect(placementLabel("bottom")).toBe("Move to bottom");
  });
});
