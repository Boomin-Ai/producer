// Studio output (src/lib/studioOutput.ts): which consumer sees which scene —
// the decision that keeps "broadcast the studio" from mirroring itself, and
// (v0.4.48) that makes it mean every output rather than only the stream.
import { describe, expect, it } from "vitest";
import { outputSceneFor, studioToggleTarget } from "../../src/lib/studioOutput";

describe("outputSceneFor", () => {
  it("everyone sees the room while studio is off", () => {
    expect(outputSceneFor("program", false)).toBe("room");
    expect(outputSceneFor("stage", false)).toBe("room");
    expect(outputSceneFor("return", false)).toBe("room");
  });
  it("every OUTPUT sees the studio while it is on", () => {
    expect(outputSceneFor("program", true)).toBe("studio");
    // v0.4.48: the return feed follows. It used to stay on the room so guests
    // never saw the UI — but the virtual camera is also how a host uses
    // Producer as their camera in Meet or Zoom, and that sent the bare stage
    // while the stream sent the studio. One switch must not mean two pictures.
    // The cost is real and deliberate: with studio ON, guests see the UI.
    expect(outputSceneFor("return", true)).toBe("studio");
  });
  it("the STAGE is the one exception — it is the infinite mirror", () => {
    // The stage is the preview inside the very window the studio captures.
    expect(outputSceneFor("stage", true)).toBe("room");
  });
});

describe("studioToggleTarget", () => {
  it("flips the room-doc value", () => {
    expect(studioToggleTarget(undefined, true)).toEqual({ on: true });
    expect(studioToggleTarget(true, true)).toEqual({ on: false });
  });
  it("refuses without an engine", () => {
    expect(studioToggleTarget(false, false)).toHaveProperty("blocked");
  });
});
