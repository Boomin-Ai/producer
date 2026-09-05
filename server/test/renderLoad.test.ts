import { describe, expect, it } from "vitest";
import {
  areaPath,
  pushSample,
  renderPressure,
  renderScale,
  renderTone,
  RENDER_WINDOW,
} from "../guest/src/renderLoad";

describe("renderPressure", () => {
  it("prefers render time over the frame budget", () => {
    // 30 fps → 33 333 µs budget; 11 111 µs render = 33.3%
    expect(renderPressure({ render_time_us: 11111, video_fps: 30, cpu: 80 })).toBeCloseTo(33.33, 1);
    expect(renderPressure({ render_time_us: 60000, video_fps: 60 })).toBe(100); // clamped
  });
  it("falls back to skipped-frame share vs cpu when no frame time", () => {
    const prev = { skipped_frames: 0, total_frames: 100 };
    // 10 skipped out of 40 expected = 25%, cpu 3 → 25
    expect(renderPressure({ skipped_frames: 10, total_frames: 130, cpu: 3 }, prev)).toBe(25);
    // no skips → cpu
    expect(renderPressure({ skipped_frames: 0, total_frames: 130, cpu: 3.5 }, prev)).toBe(3.5);
    // no prev, no skips, no cpu → 0
    expect(renderPressure({})).toBe(0);
    expect(renderPressure(null)).toBe(0);
  });
});

describe("renderTone", () => {
  it("bands at 70 / 90", () => {
    expect(renderTone(0)).toBe("mint");
    expect(renderTone(70)).toBe("mint");
    expect(renderTone(70.1)).toBe("amber");
    expect(renderTone(90)).toBe("amber");
    expect(renderTone(90.1)).toBe("red");
  });
});

describe("pushSample / renderScale", () => {
  it("keeps a rolling window and clamps", () => {
    let h: number[] = [];
    for (let i = 0; i < RENDER_WINDOW + 5; i++) h = pushSample(h, i);
    expect(h.length).toBe(RENDER_WINDOW);
    expect(h[0]).toBe(5);
    expect(pushSample([], 250)[0]).toBe(100);
    expect(pushSample([], -3)[0]).toBe(0);
  });
  it("scales the axis to the window's peak, floor 5, ceiling 100", () => {
    expect(renderScale([])).toBe(5);
    expect(renderScale([0.4, 0.9, 1.2])).toBe(5);
    expect(renderScale([20])).toBe(30);
    expect(renderScale([95])).toBe(100);
  });
});

describe("areaPath", () => {
  it("is empty with no samples and a point with one", () => {
    expect(areaPath([], 120, 40, 5)).toEqual({ line: "", area: "" });
    const one = areaPath([2.5], 120, 40, 5);
    expect(one.line).toMatch(/^M120,20$/); // right-anchored, mid-height
    expect(one.area).toMatch(/Z$/);
  });
  it("anchors the newest sample at the right edge and closes the area to the baseline", () => {
    const hist = [1, 2, 3, 2, 1];
    const { line, area } = areaPath(hist, 120, 40, 5);
    expect(line.startsWith("M")).toBe(true);
    expect(line.split(" C").length - 1).toBe(hist.length - 1);
    expect(line).toMatch(/ 120,31\.4$/); // last point: y = 40-1-(1/5)*38
    expect(area).toMatch(/ L120,40 L[\d.]+,40 Z$/);
  });
  it("monotone: a flat run stays flat (no overshoot)", () => {
    const { line } = areaPath([2, 2, 2, 2], 100, 20, 5);
    // every y in the path equals the flat value's y
    const ys = [...line.matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBe(1);
  });
});
