// Studio output (src/lib/studioOutput.ts): which consumer sees which scene —
// the decision that keeps "broadcast the studio" from mirroring itself.
import { describe, expect, it } from "vitest";
import { outputSceneFor, studioToggleTarget } from "../../src/lib/studioOutput";

describe("outputSceneFor", () => {
  it("everyone sees the room while studio is off", () => {
    expect(outputSceneFor("program", false)).toBe("room");
    expect(outputSceneFor("stage", false)).toBe("room");
    expect(outputSceneFor("return", false)).toBe("room");
  });
  it("only the program sees the studio while it is on", () => {
    expect(outputSceneFor("program", true)).toBe("studio");
    // the stage inside the captured window must never show the capture
    expect(outputSceneFor("stage", true)).toBe("room");
    // guests' return feed and mod monitors never see the UI
    expect(outputSceneFor("return", true)).toBe("room");
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
