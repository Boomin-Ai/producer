// Producer's Boomin transport (src/lib/boominRoom.ts): the pure translation
// between Boomin's `{channels, action, payload}` publishes and the frames the
// host's control loop handles, plus the scene directory and the run window.
import { describe, expect, it } from "vitest";
import {
  boominAudienceUrl,
  boominStageConfig,
  boominVoteBody,
  contributionsInWindow,
  normalizeBoominInteraction,
  parseBoominFrame,
  scenesFromBoominConfig,
} from "../../src/lib/boominRoom";

const pub = (channels: string[], action: string, payload: unknown) => JSON.stringify({ channels, action, payload });

describe("parseBoominFrame", () => {
  it("maps scene.cut onto the host's frame", () => {
    const f = parseBoominFrame(pub(["stage"], "scene.cut", { room_id: "r", scene_id: "cam", version: 4, by: { user_id: "u1", role: "mod" }, server_now: 5 }));
    expect(f).toMatchObject({ type: "scene.cut", scene_id: "cam", from: "u1", server_now: 5, version: 4 });
  });
  it("drops stage pushes (the roster poll carries them) and junk", () => {
    expect(parseBoominFrame(pub(["stage"], "stage", { on_stage: [], version: 1 }))).toBeNull();
    expect(parseBoominFrame("{not json")).toBeNull();
    expect(parseBoominFrame(pub(["stage"], "scene.cut", {}))).toBeNull();
    expect(parseBoominFrame(42)).toBeNull();
  });
  it("keeps direct frames (subscribed / error) as they are", () => {
    expect(parseBoominFrame(JSON.stringify({ type: "error", code: "forbidden", channel: "interactions:control" }))).toMatchObject({ type: "error", code: "forbidden" });
  });
  it("carries a closed contribution through", () => {
    const c = { id: "c1", kind: "overlay", binding: { source_id: "img-1" }, started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:01:00Z" };
    expect(parseBoominFrame(pub(["contributions", "stage"], "contribution.closed", { contribution: c, server_now: 9 }))).toMatchObject({ type: "contribution.closed", contribution: c });
    expect(parseBoominFrame(pub(["contributions"], "contribution.closed", { contribution: {} }))).toBeNull();
  });
  it("normalises every interaction action into one `interaction` frame", () => {
    const ix = { id: "ix1", room_id: "r", type: "vote", state: "collecting", version: 2, spec: { prompt: "A or B?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, tally: { total: 3, options: { a: 2, b: 1 }, winner: "a", tie: false } };
    for (const action of ["interaction.open", "interaction.tally", "interaction.revealed", "interaction.closed", "interaction.cancelled"]) {
      const f = parseBoominFrame(pub(["interactions:control"], action, { interaction: ix, server_now: 7 })) as { type: string; payload: { id: string; tally?: { by_kind: unknown } ; server_now: number } };
      expect(f.type).toBe("interaction");
      expect(f.payload.id).toBe("ix1");
      expect(f.payload.server_now).toBe(7);
      expect(f.payload.tally?.by_kind).toEqual({});
    }
  });
});

describe("normalizeBoominInteraction", () => {
  it("fills the defaults the open server always sends", () => {
    const ix = normalizeBoominInteraction({ id: "x", state: "open", spec: { options: [{ id: "a" }] } })!;
    expect(ix.input).toEqual({ roles: ["guest", "audience"], per_identity: "once", cooldown_ms: 0 });
    expect(ix.spec.options).toEqual([{ id: "a", label: "a" }]);
    expect(ix.timing.collect_ms).toBe(0);
    expect(ix.tally).toBeUndefined();
  });
  it("refuses a document without id/state", () => {
    expect(normalizeBoominInteraction({ spec: {} })).toBeNull();
    expect(normalizeBoominInteraction(null)).toBeNull();
  });
});

describe("boominVoteBody", () => {
  it("is the contract envelope with stable option ids", () => {
    const b = boominVoteBody({ a: "Yes", b: "No", prompt: "Ship it?", who: "both" });
    expect(b.spec.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(b.input.roles).toEqual(["guest", "audience"]);
    expect(boominVoteBody({ a: "1", b: "2", prompt: "", who: "audience" }).input.roles).toEqual(["audience"]);
  });
});

describe("scene directory", () => {
  it("round-trips through the room config, stage disabled, ids capped", () => {
    const long = "s".repeat(60);
    const cfg = boominStageConfig([{ id: "cam", name: "Full cam" }, { id: long, name: "Custom" }], long);
    expect(cfg.stage_enabled).toBe(false);
    expect(cfg.scenes[1].id).toHaveLength(40);
    expect(cfg.active_scene_id).toBe(long.slice(0, 40));
    expect(scenesFromBoominConfig(cfg)).toEqual({ scenes: [{ id: "cam", name: "Full cam" }, { id: long.slice(0, 40), name: "Custom" }], active_scene_id: long.slice(0, 40) });
  });
  it("never publishes an empty list (the schema wants one scene) nor an active id it does not list", () => {
    const cfg = boominStageConfig([], "ghost");
    expect(cfg.scenes).toHaveLength(1);
    expect(cfg.active_scene_id).toBeUndefined();
    expect(scenesFromBoominConfig(null)).toEqual({ scenes: [], active_scene_id: null });
  });
});

describe("contributionsInWindow", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
  const rows = [
    { id: "before", started_at: t(0), ended_at: t(5) },
    { id: "overlap", started_at: t(8), ended_at: t(12) },
    { id: "inside", started_at: t(11), ended_at: t(14) },
    { id: "open", started_at: t(13), ended_at: null },
    { id: "after", started_at: t(30), ended_at: null },
  ];
  it("keeps every interval that overlaps the run", () => {
    const got = contributionsInWindow(rows, Date.parse(t(10)), Date.parse(t(20))).map((r) => r.id);
    expect(got).toEqual(["overlap", "inside", "open"]);
  });
});

describe("boominAudienceUrl", () => {
  it("is the web page for one interaction", () => {
    expect(boominAudienceUrl("ix-1")).toBe("https://boomin.ai/a/ix-1");
    expect(boominAudienceUrl("ix 1", "https://x.test/")).toBe("https://x.test/a/ix%201");
  });
});
