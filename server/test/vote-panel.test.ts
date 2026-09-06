// The Vote panel (v0.4.33): its pure half — the form it wears by dock and
// state, the layout migration that introduces it exactly once, and the
// promise that the vote bar overlay is never the guest reconcile's to touch.
import { describe, expect, it } from "vitest";
import { firstSentence, voteFormFor, voteIsLive } from "../../src/lib/votePanel";
import { PANEL_ORDER, PRESETS, dockOf, movePanel, normalize, type Layout } from "../../src/lib/layout";
import { guestReconcileIds, wantedSourceIds } from "../guest/src/participants";

describe("voteFormFor", () => {
  it("wears the strip in a row dock whatever the state", () => {
    expect(voteFormFor("top", { state: null, editing: false })).toBe("strip");
    expect(voteFormFor("top", { state: "collecting", editing: false })).toBe("strip");
    expect(voteFormFor("top", { state: null, editing: true })).toBe("strip");
  });
  it("is the card when idle in a column, the editor while writing", () => {
    expect(voteFormFor("left", { state: null, editing: false })).toBe("card");
    expect(voteFormFor("right", { state: "closed", editing: false })).toBe("card");
    expect(voteFormFor("bottom", { state: "cancelled", editing: false })).toBe("card");
    expect(voteFormFor("left", { state: null, editing: true })).toBe("edit");
  });
  it("goes live for open / collecting / revealed, editor or not", () => {
    for (const st of ["open", "collecting", "revealed"]) {
      expect(voteFormFor("left", { state: st, editing: false })).toBe("live");
      expect(voteFormFor("right", { state: st, editing: true })).toBe("live");
    }
    expect(voteIsLive("closed")).toBe(false);
    expect(voteIsLive(null)).toBe(false);
  });
});

describe("layout migration: the vote panel", () => {
  it("is in the inventory, right after guests", () => {
    expect(PANEL_ORDER.indexOf("vote")).toBe(PANEL_ORDER.indexOf("guests") + 1);
  });
  it("lands on the left ONCE for a layout saved before it existed", () => {
    const old: Partial<Layout> = {
      top: [],
      left: ["scenes", "guests", "sources"],
      right: ["chat", "channels"],
      bottom: ["mixer", "stats"],
      hidden: ["mods", "updates"],
    };
    const l = normalize(old);
    expect(dockOf(l, "vote")).toBe("left");
    expect(l.left.filter((x) => x === "vote")).toHaveLength(1);
  });
  it("is never re-added after the user hides it", () => {
    const l = normalize({ left: ["scenes"], hidden: ["vote"] });
    expect(dockOf(l, "vote")).toBe("hidden");
    const hidden = movePanel(normalize({ left: ["scenes", "vote"] }), "vote", "hidden");
    const again = normalize(JSON.parse(JSON.stringify(hidden)));
    expect(dockOf(again, "vote")).toBe("hidden");
    expect(again.left).not.toContain("vote");
  });
  it("is explicit in every preset", () => {
    for (const p of PRESETS) {
      const all = [...p.layout.top, ...p.layout.left, ...p.layout.right, ...p.layout.bottom, ...p.layout.hidden];
      expect(all, p.key).toContain("vote");
      expect(new Set(all).size, p.key).toBe(PANEL_ORDER.length);
    }
  });
});

describe("the vote bar overlay and the guest reconcile", () => {
  const items = [
    { id: "guest-aaaaaaaa", kind: "guest" },
    { id: "overlay-vote01", kind: "overlay" },
    { id: "mod-bbbbbbbb", kind: "mod" },
    { id: "window-cccccc", kind: "window" },
  ];
  it("only guest-kind items are the roster's to add or remove", () => {
    const present = guestReconcileIds(items);
    expect([...present]).toEqual(["guest-aaaaaaaa"]);
    expect(present.has("overlay-vote01")).toBe(false);
  });
  it("wantedSourceIds never names an overlay id", () => {
    const wanted = wantedSourceIds([
      { id: "dddddddd-0000-4000-8000-000000000000", render_url: "https://x/y", kind: "guest", grants: ["media.camera"] } as never,
    ]);
    for (const id of wanted.keys()) expect(id.startsWith("overlay")).toBe(false);
    // a guest who left is removed; the closed-vote overlay is never on the list
    const present = guestReconcileIds(items);
    const doomed = [...present].filter((id) => !wanted.has(id));
    expect(doomed).toEqual(["guest-aaaaaaaa"]);
  });
});
