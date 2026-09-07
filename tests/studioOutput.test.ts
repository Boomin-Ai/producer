// "Broadcast the studio" means every OUTPUT — and exactly one exception.
import { strict as assert } from "node:assert";
import test from "node:test";
import { outputSceneFor } from "../src/lib/studioOutput";

test("studio off: everything is the room", () => {
  assert.equal(outputSceneFor("program", false), "room");
  assert.equal(outputSceneFor("stage", false), "room");
  assert.equal(outputSceneFor("return", false), "room");
});

test("studio on: the program and the return feed both carry the studio", () => {
  assert.equal(outputSceneFor("program", true), "studio");
  // The regression this fixes: a host using Producer as their camera in Meet
  // got the bare stage while the stream got the studio.
  assert.equal(outputSceneFor("return", true), "studio");
});

test("the STAGE never carries the studio — that is the infinite mirror", () => {
  // The stage is the preview inside the window the studio scene captures.
  assert.equal(outputSceneFor("stage", true), "room");
});
