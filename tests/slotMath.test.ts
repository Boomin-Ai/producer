// Run: node --experimental-strip-types --test tests/slotMath.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandSlotBindings, guestSlotPatch, lookPatch, slotOfGuest, type LookEntry } from "../src/lib/slotMath.ts";

const slotLook: LookEntry = { visible: true, x: 640, y: 0, w: 640, h: 360, z: 2 };

test("lookPatch: a HIDDEN entry still carries its geometry (slot never re-expands)", () => {
  const p = lookPatch({ ...slotLook, visible: false }, false);
  assert.deepEqual(p, { visible: false, x: 640, y: 0, w: 640, h: 360 });
});

test("lookPatch: visible entries take the caller's stacking index, not the look's z", () => {
  const p = lookPatch(slotLook, true, 5);
  assert.deepEqual(p, { visible: true, z: 5, x: 640, y: 0, w: 640, h: 360 });
});

test("lookPatch: entries without geometry set visibility only", () => {
  assert.deepEqual(lookPatch({ visible: true }, true), { visible: true });
});

test("expandSlotBindings: a bound guest takes the slot's look; the slot hides AT ITS OWN RECT", () => {
  const out = expandSlotBindings(
    [
      ["screen", { visible: true, x: 0, y: 0, w: 1280, h: 720, z: 0 }],
      ["gslot-1", slotLook],
    ],
    { "gslot-1": "guest-abcd1234" },
    new Set(["screen", "gslot-1", "guest-abcd1234"]),
  );
  assert.deepEqual(out, [
    ["screen", { visible: true, x: 0, y: 0, w: 1280, h: 720, z: 0 }],
    ["guest-abcd1234", { visible: true, x: 640, y: 0, w: 640, h: 360, z: 2 }],
    ["gslot-1", { visible: false, x: 640, y: 0, w: 640, h: 360, z: 2 }],
  ]);
});

test("expandSlotBindings: a slot hidden in this scene hides its guest too", () => {
  const out = expandSlotBindings(
    [["gslot-1", { ...slotLook, visible: false }]],
    { "gslot-1": "guest-abcd1234" },
    new Set(["gslot-1", "guest-abcd1234"]),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0][0], "guest-abcd1234");
  assert.equal(out[0][1].visible, false);
});

test("expandSlotBindings: a binding to a guest who is gone leaves the slot as authored", () => {
  const out = expandSlotBindings([["gslot-1", slotLook]], { "gslot-1": "guest-gone0000" }, new Set(["gslot-1"]));
  assert.deepEqual(out, [["gslot-1", slotLook]]);
});

test("expandSlotBindings: non-slot ids never expand, even if a binding names them", () => {
  const out = expandSlotBindings([["camera", slotLook]], { camera: "guest-abcd1234" }, new Set(["camera", "guest-abcd1234"]));
  assert.deepEqual(out, [["camera", slotLook]]);
});

test("guestSlotPatch: null when the guest already sits in the slot at an adjacent layer", () => {
  const slot = { x: 640, y: 0, w: 640, h: 360, z: 3 };
  assert.equal(guestSlotPatch(slot, { ...slot, z: 2 }), null);
  assert.equal(guestSlotPatch(slot, { ...slot, z: 4 }), null);
  assert.equal(guestSlotPatch(slot, { ...slot, x: 640.2 }), null);
});

test("guestSlotPatch: a guest at full frame is put back into the slot's rect", () => {
  const slot = { x: 640, y: 0, w: 640, h: 360, z: 3 };
  const p = guestSlotPatch(slot, { x: 0, y: 0, w: 1280, h: 720, z: 3 });
  assert.deepEqual(p, { x: 640, y: 0, w: 640, h: 360 });
});

test("guestSlotPatch: a guest on top of the stack is pulled down to the slot's layer", () => {
  const slot = { x: 640, y: 0, w: 640, h: 360, z: 1 };
  const p = guestSlotPatch(slot, { ...slot, z: 7 });
  assert.deepEqual(p, { z: 1 });
});

test("slotOfGuest: reverse lookup", () => {
  assert.equal(slotOfGuest({ "gslot-2": "guest-x" }, "guest-x"), "gslot-2");
  assert.equal(slotOfGuest({ "gslot-2": "guest-x" }, "guest-y"), null);
});
