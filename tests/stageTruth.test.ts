import { test } from "node:test";
import assert from "node:assert/strict";
import { boundStageIds, PendingStagePublications, hostStagePlan } from "../src/lib/stageTruth.ts";

test("scene 1 → scene 2 → scene 1 never publishes a guest removal", () => {
  const people = [{ id: "windows", sourceId: "guest-windows", seat: false }];
  const bindings = { "gslot-1": "guest-windows" };
  for (const visible of [new Set(["guest-windows"]), new Set<string>(), new Set(["guest-windows"])]) {
    const published = boundStageIds(people, visible, bindings);
    assert.deepEqual(published, ["windows"]);
    assert.deepEqual(hostStagePlan({ requested: published, shown: ["windows"], admitted: ["windows"] }).toHide, []);
  }
  // An actual departure is removed by the admitted roster, even before
  // the engine destroys its old source and the binding is cleaned up.
  assert.deepEqual(boundStageIds([], new Set(["guest-windows"]), bindings), []);
});

test("mod feeds still follow their own placement, guests follow binding", () => {
  const people = [{ id: "mod", sourceId: "mod-feed", seat: true }, { id: "guest", sourceId: "guest-feed", seat: false }];
  assert.deepEqual(boundStageIds(people, new Set(["mod-feed", "guest-feed"]), {}), ["mod"]);
});

test("host recognizes its broadcast before the HTTP response assigns its version", () => {
  const pending = new PendingStagePublications();
  const finish = pending.begin(["windows", "other"]);
  assert.equal(pending.has(["other", "windows"]), true);
  assert.equal(pending.has([]), false); // a different mod request is actionable
  finish();
  assert.equal(pending.has(["windows", "other"]), false);
  finish(); // cleanup is idempotent
});

test("overlapping posts including empty lists remain protected until both settle", () => {
  const pending = new PendingStagePublications();
  const first = pending.begin([]);
  const second = pending.begin([]);
  first();
  assert.equal(pending.has([]), true);
  second();
  assert.equal(pending.has([]), false);
});
