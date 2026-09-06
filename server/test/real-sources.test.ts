// v0.4.34: rooms start BLANK and camera / screen / mic are ordinary sources
// (src/lib/room.ts). The one-time migration folds a pre-v0.4.34 room's
// built-in switches into extras + looks; a look can never create a source.
import { describe, expect, it } from "vitest";
import {
  builtinLook,
  defaultConfig,
  migrateBuiltinsToExtras,
  needsBuiltinMigration,
  parseConfig,
  serializeConfig,
  type RoomConfig,
} from "../../src/lib/room";
import { expandSlotBindings, lookPatch } from "../../src/lib/slotMath";

const legacyDefaults = () => [
  { id: "pip", name: "PiP", screen: true, camera: true },
  { id: "cam", name: "Full cam", screen: false, camera: true },
  { id: "screen", name: "Screen", screen: true, camera: false },
];

describe("blank rooms", () => {
  it("a new room has no scenes and no sources", () => {
    const c = defaultConfig();
    expect(c.scenes).toEqual([]);
    expect(c.sources).toEqual({});
    expect(c.active_scene).toBeUndefined();
  });

  it("empty scenes survive a parse round-trip (no re-seed)", () => {
    const c = defaultConfig();
    const back = parseConfig(serializeConfig(c));
    expect(back.scenes).toEqual([]);
    expect(parseConfig(JSON.stringify({ sources: {}, scenes: [] })).scenes).toEqual([]);
    expect(parseConfig(null).scenes).toEqual([]);
    expect(parseConfig("{}").scenes).toEqual([]);
  });

  it("a room saved with the three legacy defaults keeps them", () => {
    const back = parseConfig(JSON.stringify({ sources: {}, scenes: legacyDefaults() }));
    expect(back.scenes.map((s) => s.id)).toEqual(["pip", "cam", "screen"]);
  });

  it("needs no migration", () => {
    expect(needsBuiltinMigration(defaultConfig())).toBe(false);
    const c = defaultConfig();
    expect(migrateBuiltinsToExtras(c)).toBe(c);
  });
});

describe("migrateBuiltinsToExtras", () => {
  const old = (): RoomConfig => ({
    ...defaultConfig(),
    sources: { screen: true, camera: true, mic: true, mic_volume: 0.8, mic_muted: false },
    scenes: legacyDefaults(),
    active_scene: "pip",
  });

  it("synthesizes camera / screen / mic extras under the legacy ids", () => {
    const m = migrateBuiltinsToExtras(old(), {}, { w: 1280, h: 720 });
    expect(m).not.toBe(old());
    const ids = (m.sources.extras ?? []).map((e) => [e.id, e.spec.kind]);
    expect(ids).toEqual([
      ["camera", "camera"],
      ["screen", "screen"],
      ["mic", "mic"],
    ]);
    // System default: no device pinned when none was known.
    expect(m.sources.extras![0].spec).toEqual({ kind: "camera" });
    expect(m.sources.extras![2].spec).toEqual({ kind: "mic" });
  });

  it("carries the engine's device selection when known", () => {
    const m = migrateBuiltinsToExtras(old(), { camera: "cam-1", screen: "disp-2", mic: "usb-3" });
    expect(m.sources.extras).toEqual([
      { id: "camera", label: "Camera", spec: { kind: "camera", device: "cam-1" } },
      { id: "screen", label: "Screen", spec: { kind: "screen", display: "disp-2" } },
      { id: "mic", label: "Microphone", spec: { kind: "mic", device: "usb-3" } },
    ]);
  });

  it("turns each flag-only scene into the exact built-in look and strips the flags", () => {
    const m = migrateBuiltinsToExtras(old(), {}, { w: 1280, h: 720 });
    expect(m.scenes.map((s) => s.id)).toEqual(["pip", "cam", "screen"]);
    for (const s of m.scenes) {
      expect("screen" in s).toBe(false);
      expect("camera" in s).toBe(false);
    }
    expect(m.scenes[0].look).toEqual(builtinLook({ screen: true, camera: true }, 1280, 720));
    // PiP geometry: camera 28% wide bottom-right, screen full-frame, z order fixed.
    expect(m.scenes[0].look!.camera).toEqual({ visible: true, x: 1280 - 358 - 26, y: 720 - 201 - 26, w: 358, h: 201, z: 2 });
    expect(m.scenes[0].look!.screen).toEqual({ visible: true, x: 0, y: 0, w: 1280, h: 720, z: 0 });
    expect(m.scenes[1].look!.screen).toEqual({ visible: false });
    expect(m.scenes[1].look!.camera).toEqual({ visible: true, x: 0, y: 0, w: 1280, h: 720, z: 2 });
    expect(m.scenes[2].look!.camera).toEqual({ visible: false });
    expect(m.active_scene).toBe("pip");
  });

  it("keeps a scene's own look untouched (the look won under the old apply)", () => {
    const c = old();
    c.scenes[0] = { ...c.scenes[0], look: { camera: { visible: true, x: 1, y: 2, w: 3, h: 4, z: 9 }, "text-abc": { visible: true } } };
    const m = migrateBuiltinsToExtras(c);
    expect(m.scenes[0].look).toEqual({ camera: { visible: true, x: 1, y: 2, w: 3, h: 4, z: 9 }, "text-abc": { visible: true } });
    expect("screen" in m.scenes[0]).toBe(false);
  });

  it("strips the legacy switches from sources and keeps everything else", () => {
    const c = old();
    c.sources.overlay_url = "https://x/overlay";
    c.sources.extras = [{ id: "text-1", label: "Lower third", spec: { kind: "text", text: "hi" } }];
    const m = migrateBuiltinsToExtras(c);
    expect(m.sources.screen).toBeUndefined();
    expect(m.sources.camera).toBeUndefined();
    expect(m.sources.mic).toBeUndefined();
    expect(m.sources.mic_volume).toBeUndefined();
    expect(m.sources.mic_muted).toBeUndefined();
    expect(m.sources.overlay_url).toBe("https://x/overlay");
    expect(m.sources.extras!.map((e) => e.id)).toEqual(["text-1", "camera", "screen", "mic"]);
    expect(needsBuiltinMigration(m)).toBe(false);
    // Idempotent: the migrated room is left alone.
    expect(migrateBuiltinsToExtras(m)).toBe(m);
  });

  it("synthesizes only what the room used", () => {
    // Switches off, but the default scenes still ask for camera + screen.
    const c: RoomConfig = { ...defaultConfig(), sources: { screen: false, camera: false, mic: false }, scenes: legacyDefaults() };
    const m = migrateBuiltinsToExtras(c);
    expect(m.sources.extras!.map((e) => e.spec.kind)).toEqual(["camera", "screen"]);
    // A camera-only room: no screen extra, and no screen entry in any look.
    const camOnly: RoomConfig = {
      ...defaultConfig(),
      sources: { screen: false, camera: true, mic: true },
      scenes: [{ id: "cam", name: "Full cam", screen: false, camera: true }],
    };
    const m2 = migrateBuiltinsToExtras(camOnly);
    expect(m2.sources.extras!.map((e) => e.spec.kind)).toEqual(["camera", "mic"]);
    expect(Object.keys(m2.scenes[0].look!).sort()).toEqual(["camera", "overlay"]);
  });

  it("never duplicates an extra of a kind the room already has", () => {
    const c = old();
    c.sources.extras = [{ id: "camera-xyz", label: "Cam 2", spec: { kind: "camera", device: "d" } }];
    const m = migrateBuiltinsToExtras(c);
    expect(m.sources.extras!.filter((e) => e.spec.kind === "camera")).toHaveLength(1);
    expect(m.sources.extras!.map((e) => e.spec.kind)).toEqual(["camera", "screen", "mic"]);
    // The look for the pip scene then names the id the room owns... no
    // legacy "camera" id exists, so the recipe's entry for it is pruned.
    expect("camera" in m.scenes[0].look!).toBe(false);
  });

  it("migrates a pre-rooms blob (bare SourcesState) too", () => {
    const back = parseConfig(JSON.stringify({ screen: true, camera: false, mic: true }));
    expect(needsBuiltinMigration(back)).toBe(true);
    const m = migrateBuiltinsToExtras(back);
    expect(m.sources.extras!.map((e) => e.spec.kind)).toEqual(["screen", "mic"]);
    expect(m.scenes).toEqual([]);
  });

  it("round-trips through the serializer without the flags coming back", () => {
    const m = parseConfig(serializeConfig(migrateBuiltinsToExtras(old())));
    expect(needsBuiltinMigration(m)).toBe(false);
    expect(m.scenes[0].look!.camera!.visible).toBe(true);
  });
});

describe("a look never enables a missing source", () => {
  // The apply path only addresses ids the engine holds (Live.tsx applyScene
  // filters the look by `exists` before expandSlotBindings). Mirror that
  // contract here so it cannot silently regress.
  const apply = (look: Record<string, { visible: boolean }>, exists: Set<string>) =>
    expandSlotBindings(
      Object.entries(look).filter(([id]) => exists.has(id)),
      {},
      exists,
    ).map(([id]) => id);

  it("skips the camera entry when the room removed its camera", () => {
    const look = builtinLook({ screen: true, camera: true }, 1280, 720);
    expect(apply(look, new Set(["screen", "overlay"]))).toEqual(["screen", "overlay"]);
    expect(apply(look, new Set([]))).toEqual([]);
  });

  it("lookPatch carries geometry and visibility only", () => {
    const p = lookPatch({ visible: true, x: 1, y: 2, w: 3, h: 4, z: 5 }, true, 7);
    expect(p).toEqual({ visible: true, x: 1, y: 2, w: 3, h: 4, z: 7 });
  });
});

describe("slot math ignores capture extras", () => {
  it("camera / screen ids are never slots and never guests", () => {
    const look = {
      "gslot-1": { visible: true, x: 0, y: 0, w: 100, h: 100, z: 1 },
      camera: { visible: true, x: 5, y: 5, w: 50, h: 50, z: 2 },
      "screen-ab12cd": { visible: true, x: 0, y: 0, w: 1280, h: 720, z: 0 },
    };
    const exists = new Set(["gslot-1", "camera", "screen-ab12cd", "guest-1234abcd"]);
    const out = expandSlotBindings(Object.entries(look), { "gslot-1": "guest-1234abcd" }, exists);
    const ids = out.map(([id]) => id);
    // The slot expands into its guest; capture items pass through untouched.
    expect(ids).toContain("guest-1234abcd");
    expect(out.find(([id]) => id === "camera")![1]).toEqual(look.camera);
    expect(out.find(([id]) => id === "screen-ab12cd")![1]).toEqual(look["screen-ab12cd"]);
  });
});
