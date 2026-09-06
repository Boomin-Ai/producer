// The ONE placement button's pure half (src/lib/placement.ts): a STATIC
// glyph + an explicit menu (v0.4.40). Nothing cycles on hover any more.
import { describe, expect, it } from "vitest";
import {
  PLACEMENTS,
  placementLabel,
  placementMenuKey,
  placementMenuStart,
  placementOptionLabel,
  placementOptions,
} from "../../src/lib/placement";

describe("placementLabel", () => {
  it('reads "In the <dock> dock" for the current placement', () => {
    expect(placementLabel("bottom")).toBe("In the bottom dock");
  });
  it("hidden reads Hidden", () => {
    expect(placementLabel("hidden")).toBe("Hidden");
  });
});

describe("placementOptions", () => {
  it("lists the ring in order with the current value active", () => {
    const ring = [...PLACEMENTS, "hidden"] as const;
    const opts = placementOptions("left", ring);
    expect(opts.map((o) => o.value)).toEqual(["top", "right", "bottom", "left", "hidden"]);
    expect(opts.map((o) => o.label)).toEqual(["Top", "Right", "Bottom", "Left", "Hidden"]);
    expect(opts.filter((o) => o.active).map((o) => o.value)).toEqual(["left"]);
  });
  it("a value outside the ring has no active row", () => {
    expect(placementOptions("hidden" as never, PLACEMENTS).some((o) => o.active)).toBe(false);
  });
  it("labels are capitalised", () => {
    expect(placementOptionLabel("top")).toBe("Top");
  });
});

describe("placementMenuStart", () => {
  it("starts on the current value, or the first row", () => {
    expect(placementMenuStart("bottom", PLACEMENTS)).toBe(2);
    expect(placementMenuStart("hidden" as never, PLACEMENTS)).toBe(0);
    expect(placementMenuStart("top", [])).toBe(-1);
  });
});

describe("placementMenuKey", () => {
  it("arrows move the highlight and wrap", () => {
    expect(placementMenuKey(0, "ArrowDown", 4).highlight).toBe(1);
    expect(placementMenuKey(3, "ArrowDown", 4).highlight).toBe(0);
    expect(placementMenuKey(0, "ArrowUp", 4).highlight).toBe(3);
    expect(placementMenuKey(1, "ArrowLeft", 4).highlight).toBe(0);
    expect(placementMenuKey(-1, "ArrowDown", 4).highlight).toBe(0);
  });
  it("Enter commits the highlighted row and closes", () => {
    expect(placementMenuKey(2, "Enter", 4)).toEqual({ highlight: 2, commit: true, close: true, handled: true });
    expect(placementMenuKey(-1, "Enter", 4).commit).toBe(false);
  });
  it("Escape closes without committing; unknown keys are not handled", () => {
    expect(placementMenuKey(1, "Escape", 4)).toMatchObject({ commit: false, close: true, handled: true });
    expect(placementMenuKey(1, "x", 4).handled).toBe(false);
  });
  it("Home / End jump", () => {
    expect(placementMenuKey(2, "Home", 5).highlight).toBe(0);
    expect(placementMenuKey(2, "End", 5).highlight).toBe(4);
  });
});
