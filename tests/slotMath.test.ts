// Run: node --experimental-strip-types --test tests/slotMath.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureSlotLook, commitSlotEdit, expandSlotBindings, guestSlotPatch, lookPatch, slotOfGuest, type LookEntry } from "../src/lib/slotMath.ts";

const slotLook: LookEntry = { visible: true, x: 640, y: 0, w: 640, h: 360, z: 2 };

test("final guest resize persists in JSON and restores both recreated items at that rect", () => {
  const edited = commitSlotEdit(slotLook, { x: 85, y: 60, w: 350, h: 200 });
  const document = JSON.parse(JSON.stringify({
    scenes: [{ id: "scene-1", look: { "gslot-1": edited } }],
    slot_bindings: { "gslot-1": "guest-windows" },
  }));
  const entries = expandSlotBindings(Object.entries(document.scenes[0].look), document.slot_bindings,
    new Set(["gslot-1", "guest-windows"]));
  assert.deepEqual(lookPatch(entries[0][1], true), { visible: true, x: 85, y: 60, w: 350, h: 200 });
  assert.deepEqual(lookPatch(entries[1][1], false), { visible: false, x: 85, y: 60, w: 350, h: 200 });
  assert.deepEqual(slotLook, { visible: true, x: 640, y: 0, w: 640, h: 360, z: 2 });
});

test("partial slot edit preserves visibility and unedited geometry", () => {
  assert.deepEqual(commitSlotEdit(slotLook, { x: 90, visible: false }), { ...slotLook, x: 90 });
});

test("occupied scene survives capture, switching away and returning at its edited size", () => {
  const slot = { id: "gslot-1", kind: "color", visible: false, x: 120, y: 50, w: 420, h: 240, z: 2 };
  const guest = { ...slot, id: "guest-present", kind: "guest", visible: true, z: 3 };
  const bindings = { "gslot-1": guest.id };
  const exists = new Set([slot.id, guest.id]);
  const saved = captureSlotLook([slot, guest], bindings);
  assert.equal(saved[slot.id].visible, true);
  assert.equal(saved[guest.id], undefined);
  // Cutting to a scene with no slot hides both engine items. It must not
  // mutate the saved scene, or the subsequent return loses its occupant.
  const returned = expandSlotBindings(Object.entries(saved), bindings, exists);
  assert.deepEqual(returned[0], [guest.id, { visible: true, x: 120, y: 50, w: 420, h: 240, z: 2 }]);
  assert.equal(returned[1][1].visible, false);
  const recaptured = captureSlotLook([slot, guest], bindings);
  assert.deepEqual(recaptured, saved);
});

test("a guest departure restores the authored placeholder without disabling its saved scene", () => {
  const slot = { id: "gslot-1", kind: "color", visible: false, x: 120, y: 50, w: 420, h: 240, z: 2 };
  const guest = { ...slot, id: "guest-present", kind: "guest", visible: true };
  const saved = captureSlotLook([slot, guest], { [slot.id]: guest.id });
  const afterLeave = expandSlotBindings(Object.entries(saved), {}, new Set([slot.id]));
  assert.deepEqual(afterLeave, [[slot.id, { visible: true, x: 120, y: 50, w: 420, h: 240, z: 2 }]]);
});

test("an intentionally hidden occupied slot stays hidden in the captured scene", () => {
  const slot = { id: "gslot-1", kind: "color", visible: false, x: 120, y: 50, w: 420, h: 240, z: 2 };
  const guest = { ...slot, id: "guest-present", kind: "guest" };
  assert.equal(captureSlotLook([slot, guest], { [slot.id]: guest.id })[slot.id].visible, false);
});

test("a temporarily missing guest engine item does not disable its occupied scene slot", () => {
  const slot = { id: "gslot-1", kind: "color", visible: false, x: 120, y: 50, w: 420, h: 240, z: 2 };
  const previous = { [slot.id]: { ...slotLook, x: 120, y: 50, w: 420, h: 240 } };
  assert.equal(captureSlotLook([slot], { [slot.id]: "guest-present" }, previous)[slot.id].visible, true);
});

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
