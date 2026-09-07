// The rescue must never hide a person.
//
// A guest BOUND to a slot inherits that slot's whole look entry, visibility
// included (lib/slotMath.ts `expandSlotBindings`). So adopting an orphan slot
// as hidden does not park a harmless rectangle — it hides the guest standing
// in it, on every scene apply, with no row to turn them back on.
import { strict as assert } from "node:assert";
import test from "node:test";
import { adoptOrphanSources, orphanExtraIds } from "../src/lib/roomConfig";
import { expandSlotBindings } from "../src/lib/slotMath";
import type { RoomConfig } from "../src/lib/roomConfig";

const room = (extras: { id: string }[], look: Record<string, { visible: boolean }>): RoomConfig =>
  ({
    scenes: [{ id: "s1", name: "Scene 1", look }],
    sources: { extras: extras.map((e) => ({ id: e.id, label: e.id, spec: { kind: "color", color: "#000" } })) },
  }) as unknown as RoomConfig;

test("a plain orphan source is adopted, hidden", () => {
  const c = room([{ id: "camera-abc" }], {});
  const out = adoptOrphanSources(c);
  assert.equal(out.scenes[0]!.look!["camera-abc"]!.visible, false);
});

test("an orphan GUEST SLOT is left alone", () => {
  const c = room([{ id: "gslot-1" }], {});
  assert.deepEqual(orphanExtraIds(c), ["gslot-1"], "it is still an orphan");
  const out = adoptOrphanSources(c);
  assert.equal(out, c, "but adoption does not touch it");
});

test("the bug it prevents: an adopted slot would hide its guest", () => {
  // What the old rescue produced.
  const look = { "gslot-1": { visible: false } };
  const expanded = expandSlotBindings(
    Object.entries(look) as [string, { visible: boolean }][] as never,
    { "gslot-1": "guest-xyz" },
    new Set(["gslot-1", "guest-xyz"]),
  );
  const guest = expanded.find(([id]) => id === "guest-xyz");
  assert.ok(guest, "the guest inherits the slot's entry");
  assert.equal(guest![1].visible, false, "…including visible:false — the person disappears");
});

test("a slot that legitimately joined a scene still drives its guest", () => {
  const c = room([{ id: "gslot-1" }], { "gslot-1": { visible: true } });
  assert.deepEqual(orphanExtraIds(c), [], "not an orphan — it has a home");
  assert.equal(adoptOrphanSources(c), c);
});
