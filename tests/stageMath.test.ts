// Run: node --experimental-strip-types --test tests/stageMath.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeBox, contentAspect, type ResizeSource } from "../src/lib/stageMath.ts";

const base: ResizeSource = {
  x: 100, y: 100, w: 320, h: 180,
  src_w: 1920, src_h: 1080,
  crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0,
};
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("east handle scales width AND height, keeps west edge, stays vertically centred", () => {
  const r = resizeBox(base, "e", 160, 0);
  close(r.w, 480); close(r.h, 270); close(r.x, 100); close(r.y, 100 - 45);
});

test("west handle mirrors east: east edge fixed", () => {
  const r = resizeBox(base, "w", -160, 0);
  close(r.w, 480); close(r.h, 270); close(r.x + r.w, 420); close(r.y, 55);
});

test("north/south handles scale width to match, horizontally centred", () => {
  const s = resizeBox(base, "s", 0, 90);
  close(s.h, 270); close(s.w, 480); close(s.y, 100); close(s.x, 100 - 80);
  const n = resizeBox(base, "n", 0, -90);
  close(n.h, 270); close(n.y + n.h, 280); close(n.x, 20);
});

test("a side drag never translates the picture without scaling it", () => {
  const r = resizeBox(base, "e", 50, 0);
  assert.notEqual(r.w, base.w);
  assert.notEqual(r.h, base.h);
});

test("corner keeps the opposite corner and source aspect", () => {
  const r = resizeBox(base, "nw", -320, 12345);
  close(r.w, 640); close(r.h, 360); close(r.x + r.w, 420); close(r.y + r.h, 280);
});

test("minimum side is clamped and deltas are from gesture start (no compounding)", () => {
  const a = resizeBox(base, "e", -10_000, 0);
  close(a.w, 32);
  const b = resizeBox(base, "e", 10, 0);
  const c = resizeBox(base, "e", 10, 0);
  assert.deepEqual(b, c);
});

test("crop changes the aspect the box follows", () => {
  const cropped = { ...base, crop_left: 480, crop_right: 480 }; // 960x1080 → 8:9
  close(contentAspect(cropped)!, 960 / 1080);
  const r = resizeBox(cropped, "e", 100, 0);
  close(r.h, r.w * 1080 / 960);
});

test("unknown source size falls back to free resize", () => {
  const r = resizeBox({ ...base, src_w: 0, src_h: 0 }, "e", 100, 0);
  close(r.w, 420); close(r.h, 180);
});
