/** A room is a document (DOM-free half: types, parse/serialize and the
 * v0.4.34 migration — importable from the server's vitest). Browser-side
 * helpers live in lib/room.ts, which re-exports everything here.
 *
 * A room is a document. It owns its dock layout, its scenes, which
 * channels it goes out to, and the scene state itself — so switching rooms
 * switches the whole show, not just the picture. Persisted as JSON in
 * live_rooms.config (see live_update_room). */

import { DEFAULT_LAYOUT, normalize, type DockSizes, type Layout } from "./layout";
import type { ExtraSpec } from "./sourceSpec";
import { parseModFeeds, type ModFeeds } from "./modFeed";

/** One item's appearance inside a scene: visibility, geometry (canvas
 * units), stacking. Scenes are LOOKS — applying one never creates or
 * destroys sources, it only re-dresses the ones on stage. */
export interface SceneItemLook {
  visible: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
}

/** How a scene arrives on air. `cut` is instant (the default and what most
 * streamers use); `move` glides items from their current geometry into the
 * scene's — free for us because scenes are looks over ONE graph, where OBS
 * needs a plugin. `fade` dissolves items in and out (libobs items have no
 * opacity, so it rides a colour filter, same as OBS does internally).
 * `stinger` covers the switch with a video. */
export type TransitionKind = "cut" | "move" | "fade" | "stinger";

export interface SceneTransition {
  kind: TransitionKind;
  /** Milliseconds; ignored by `cut`. */
  ms?: number;
  /** Absolute path to the stinger clip. */
  stinger?: string;
}

export interface RoomScene {
  id: string;
  name: string;
  /** Per-scene override; absent = use the room default. */
  transition?: SceneTransition;
  /** LEGACY (pre-v0.4.34) built-in switches. Never written any more and
   * never read by the stage: `migrateBuiltinsToExtras` folds them into
   * `look` once, on the first open of an old room, and strips them. */
  screen?: boolean;
  camera?: boolean;
  /** The look, keyed by item id. Absent/empty = "everything as it is". A
   * scene can only re-dress items the room owns; it never creates one. */
  look?: Record<string, SceneItemLook>;
}

/** One open-list item the room respawns on open (id is room-owned). */
export interface RoomExtra {
  id: string;
  label: string;
  spec: ExtraSpec;
  /** Guests only. The platform issues this once and never again, so it lives
   * with the room rather than only in the dialog that created it. */
  invite_url?: string;
  /** Where this source sits in the program's ledger (#50): a source with a
   * binding (e.g. `{ sponsor: "acme" }`) publishes show / hide as an
   * `overlay` contribution. Absent = an ordinary source, nothing recorded. */
  binding?: Record<string, unknown>;
}

export interface RoomSources {
  /** LEGACY (pre-v0.4.34) built-in switches — migration inputs only, see
   * `migrateBuiltinsToExtras`. Camera, screen and mic are `extras` now. */
  screen?: boolean;
  camera?: boolean;
  mic?: boolean;
  mic_volume?: number;
  mic_muted?: boolean;
  overlay_window?: number | null;
  overlay_url?: string | null;
  extras?: RoomExtra[];
}

export interface RoomConfig {
  sources: RoomSources;
  layout: Layout;
  scenes: RoomScene[];
  /** destination id → included when this room goes live. */
  channels: Record<string, boolean>;
  /** Scene the room mounts into when it opens. */
  active_scene?: string;
  /** The room's shareable guest link, cached so it survives restarts and can
   * be copied without a round trip. */
  guest_link?: string;
  /** The platform's id for this room, cached after lazy registration. The
   * local id stays authoritative offline; this is only the seam for
   * server-side features (guests today, broadcasts later). */
  server_room_id?: string;
  /** Where the row was born. `server` = created elsewhere (web, a deal,
   * another machine) and pulled down by room sync; its title follows the
   * server. Absent = minted here, title is ours to push. */
  origin?: "server";
  /** Network exposure, mirrored locally so the control renders offline.
   * Producer is the only writer, so the local copy is authoritative;
   * changing it forces registration and a server PATCH. */
  visibility?: "private" | "connections" | "public";
  /** Dock sizing the user dragged (per room, like the layout itself). */
  sizes?: DockSizes;
  /** Guest-slot occupancy: slot item id → guest item id. Slots are scene
   * furniture (gslot-N extras); guests pop into them and pop out, the slot
   * geometry never moves. */
  slot_bindings?: Record<string, string>;
  /** MOD FEED placement (v0.4.32): participant id → per-track rect as
   * canvas fractions. A seat's feed is its own source kind with its own
   * place — never a guest slot (lib/modFeed.ts). */
  mod_feeds?: ModFeeds;
  /** Room-wide default transition; a scene may override it. */
  transition?: SceneTransition;
  /** Dock-level surface ownership. true = the DOCK paints the card background
   * and its components render flat inside one shared surface; absent/false =
   * every panel owns its own card (the default look). Dock-level by decree —
   * never per component. */
  dock_bg?: Partial<Record<"top" | "left" | "right" | "bottom", boolean>>;
  /** Where the stage's quick controls float: an edge of the canvas. */
  stage_bar?: "bottom" | "top" | "left" | "right";
  /** Output canvas the room was last set to: height (720/1080/2160) and
   * frame rate (30/60). Stored verbatim — the ENGINE is the authority on
   * what a machine can run (4K needs a hardware encoder), never this parser. */
  video?: RoomVideo;
  /** Chat channels the ROOM reads — public handles, set by the host and
   * published to every seat over the monitor leg (lib/monitorFeed.ts). */
  chat_channels?: { twitch?: string; kick?: string; youtube?: string };
}

export interface RoomVideo {
  h: number;
  f: number;
}

/** A new room is BLANK (v0.4.34): no scenes, no sources. Everything on the
 * stage is something the host added. */
export function defaultConfig(): RoomConfig {
  return {
    sources: {},
    layout: { ...DEFAULT_LAYOUT, left: [...DEFAULT_LAYOUT.left], right: [...DEFAULT_LAYOUT.right], bottom: [...DEFAULT_LAYOUT.bottom], hidden: [...DEFAULT_LAYOUT.hidden] },
    scenes: [],
    channels: {},
  };
}

/** Tolerant of every shape we've written: the current object, and the
 * pre-rooms format where config WAS the bare sources state. */
export function parseConfig(raw: string | null | undefined): RoomConfig {
  const base = defaultConfig();
  if (!raw) return base;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return base;
  }
  if (!v || typeof v !== "object") return base;

  // legacy: the whole blob was SourcesState
  if ("screen" in v && !("sources" in v)) {
    return { ...base, sources: v as RoomSources };
  }
  if (v.sources && typeof v.sources === "object") base.sources = v.sources as RoomSources;
  if (v.layout && typeof v.layout === "object") {
    // Through normalize, never verbatim: a room saved when a panel still
    // existed must not be able to ask for one that has since been retired.
    base.layout = normalize(v.layout as Partial<Layout>);
  }
  if (Array.isArray(v.scenes)) {
    // Empty stays empty: a blank room is a real state, not a missing one.
    base.scenes = (v.scenes as RoomScene[]).filter(
      (s) => s && typeof s.id === "string" && typeof s.name === "string",
    );
  }
  if (v.channels && typeof v.channels === "object") base.channels = v.channels as Record<string, boolean>;
  if (typeof v.active_scene === "string") base.active_scene = v.active_scene;
  if (typeof v.server_room_id === "string") base.server_room_id = v.server_room_id;
  if (v.origin === "server") base.origin = "server";
  if (v.visibility === "connections" || v.visibility === "public" || v.visibility === "private") {
    base.visibility = v.visibility;
  }
  if (typeof v.guest_link === "string") base.guest_link = v.guest_link;
  if (v.slot_bindings && typeof v.slot_bindings === "object") {
    base.slot_bindings = Object.fromEntries(
      Object.entries(v.slot_bindings as Record<string, unknown>).filter(
        ([k, val]) => k.startsWith("gslot-") && typeof val === "string",
      ),
    ) as Record<string, string>;
  }
  if (v.mod_feeds && typeof v.mod_feeds === "object") {
    const mf = parseModFeeds(v.mod_feeds);
    if (Object.keys(mf).length) base.mod_feeds = mf;
  }
  if (v.sizes && typeof v.sizes === "object") base.sizes = v.sizes as DockSizes;
  if (v.stage_bar === "bottom" || v.stage_bar === "top" || v.stage_bar === "left" || v.stage_bar === "right") {
    base.stage_bar = v.stage_bar;
  }
  if (v.video && typeof v.video === "object") {
    const { h, f } = v.video as Partial<RoomVideo>;
    // Positive integers pass through unclamped; the engine rejects modes it
    // cannot run and says why.
    if (Number.isInteger(h) && (h as number) > 0 && Number.isInteger(f) && (f as number) > 0) {
      base.video = { h: h as number, f: f as number };
    }
  }
  if (v.dock_bg && typeof v.dock_bg === "object") {
    base.dock_bg = Object.fromEntries(
      Object.entries(v.dock_bg as Record<string, unknown>).filter(
        ([k, val]) => ["top", "left", "right", "bottom"].includes(k) && typeof val === "boolean",
      ),
    ) as RoomConfig["dock_bg"];
  }
  if (v.transition && typeof v.transition === "object") base.transition = v.transition as SceneTransition;
  if (v.chat_channels && typeof v.chat_channels === "object") {
    base.chat_channels = Object.fromEntries(
      Object.entries(v.chat_channels as Record<string, unknown>).filter(
        ([k, val]) => ["twitch", "kick", "youtube"].includes(k) && typeof val === "string" && val.trim(),
      ),
    ) as RoomConfig["chat_channels"];
  }
  return base;
}

export function serializeConfig(c: RoomConfig): string {
  return JSON.stringify(c);
}

// --- v0.4.34 migration: built-in switches → ordinary sources ---------------

/** Ids the migrated capture sources keep. They match the engine item ids the
 * built-ins used, so a saved custom `look` keyed by "camera"/"screen" keeps
 * dressing the same picture after the move. */
export const LEGACY_CAMERA_ID = "camera";
export const LEGACY_SCREEN_ID = "screen";
export const LEGACY_MIC_ID = "mic";

/** Which devices the built-ins would have used (engine selection at the
 * time, if known). Absent = system default, which is what a fresh built-in
 * resolved to. */
export interface LegacyDevices {
  camera?: string | null;
  screen?: string | null;
  mic?: string | null;
}

export type CaptureKind = "camera" | "screen" | "mic";

export function isCaptureKind(kind: string | undefined | null): kind is CaptureKind {
  return kind === "camera" || kind === "screen" || kind === "mic";
}

/** The old built-in recipe for a flag pair, as a look over the legacy ids:
 * screen full-frame at z 0, overlay above it, camera on top — PiP
 * bottom-right when the screen is up, full-frame otherwise. Used ONLY to
 * migrate a flag-only scene; nothing computes recipes at apply time now. */
export function builtinLook(
  p: { screen?: boolean; camera?: boolean },
  bw: number,
  bh: number,
): Record<string, SceneItemLook> {
  const pipW = Math.round(bw * 0.28);
  const pipH = Math.round((pipW * 9) / 16);
  const m = Math.round(bw * 0.02);
  const look: Record<string, SceneItemLook> = {};
  look[LEGACY_SCREEN_ID] = p.screen ? { visible: true, x: 0, y: 0, w: bw, h: bh, z: 0 } : { visible: false };
  look.overlay = { visible: true, z: 1 };
  look[LEGACY_CAMERA_ID] = p.camera
    ? p.screen
      ? { visible: true, x: bw - pipW - m, y: bh - pipH - m, w: pipW, h: pipH, z: 2 }
      : { visible: true, x: 0, y: 0, w: bw, h: bh, z: 2 }
    : { visible: false };
  return look;
}

function hasLegacyFlags(s: RoomScene): boolean {
  return typeof s.screen === "boolean" || typeof s.camera === "boolean";
}

function hasLegacySources(src: RoomSources): boolean {
  return (
    typeof src.screen === "boolean" ||
    typeof src.camera === "boolean" ||
    typeof src.mic === "boolean" ||
    typeof src.mic_volume === "number" ||
    typeof src.mic_muted === "boolean"
  );
}

/** Does the room still carry the pre-v0.4.34 built-in switches anywhere? */
export function needsBuiltinMigration(c: RoomConfig): boolean {
  return hasLegacySources(c.sources) || c.scenes.some(hasLegacyFlags);
}

/** Fold the built-in switches of a pre-v0.4.34 room into ordinary sources,
 * ONCE. Pure; returns the same object when nothing needs doing.
 *
 * Rule:
 *  - A capture source is synthesized when the room used it: the saved
 *    switch was on, or any scene's flag asked for it (a flag-only scene
 *    turned the source on at apply time, so the room depended on it). The
 *    mic follows its switch alone — scenes never carried a mic flag.
 *  - Ids are the legacy engine ids ("camera" / "screen" / "mic"), so every
 *    saved custom look keyed by them still applies. Nothing is synthesized
 *    when an extra of that kind already exists (a room saved by this build
 *    or later).
 *  - A scene with flags and no look gets the built-in recipe as its look
 *    (the exact geometry the flags produced); a scene that already has a
 *    look keeps it untouched — under the old apply the look won anyway.
 *  - The flags and the switches are stripped. User scenes are never
 *    deleted; a room saved with the three defaults keeps them.
 */
export function migrateBuiltinsToExtras(
  c: RoomConfig,
  devices: LegacyDevices = {},
  canvas: { w: number; h: number } = { w: 1280, h: 720 },
): RoomConfig {
  if (!needsBuiltinMigration(c)) return c;
  const src = c.sources;
  const extras: RoomExtra[] = [...(src.extras ?? [])];
  const has = (kind: CaptureKind) => extras.some((e) => e.spec.kind === kind);
  const anyFlag = (k: "screen" | "camera") => c.scenes.some((s) => s[k] === true);
  const wantScreen = src.screen === true || anyFlag("screen");
  const wantCamera = src.camera === true || anyFlag("camera");
  const wantMic = src.mic === true;

  if (wantCamera && !has("camera")) {
    extras.push({
      id: LEGACY_CAMERA_ID,
      label: "Camera",
      spec: devices.camera ? { kind: "camera", device: devices.camera } : { kind: "camera" },
    });
  }
  if (wantScreen && !has("screen")) {
    extras.push({
      id: LEGACY_SCREEN_ID,
      label: "Screen",
      spec: devices.screen ? { kind: "screen", display: devices.screen } : { kind: "screen" },
    });
  }
  if (wantMic && !has("mic")) {
    extras.push({
      id: LEGACY_MIC_ID,
      label: "Microphone",
      spec: devices.mic ? { kind: "mic", device: devices.mic } : { kind: "mic" },
    });
  }

  const scenes = c.scenes.map((s) => {
    if (!hasLegacyFlags(s)) return s;
    const { screen, camera, ...rest } = s;
    const own = rest.look && Object.keys(rest.look).length ? rest.look : null;
    if (own) return rest;
    // A recipe may only name items the room owns: drop entries for a
    // source that was never synthesized (flag false everywhere).
    const recipe = builtinLook({ screen, camera }, canvas.w, canvas.h);
    const owned = new Set([...extras.map((e) => e.id), "overlay"]);
    const look = Object.fromEntries(Object.entries(recipe).filter(([id]) => owned.has(id)));
    return { ...rest, look };
  });

  const { screen: _s, camera: _c, mic: _m, mic_volume: _v, mic_muted: _mm, ...restSources } = src;
  void _s; void _c; void _m; void _v; void _mm;
  return { ...c, sources: { ...restSources, extras }, scenes };
}
