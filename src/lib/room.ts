/** A room is a document. It owns its dock layout, its scenes, which
 * channels it goes out to, and the scene state itself — so switching rooms
 * switches the whole show, not just the picture. Persisted as JSON in
 * live_rooms.config (see live_update_room). */

import { DEFAULT_LAYOUT, normalize, type DockSizes, type Layout } from "./layout";
import type { ExtraSpec } from "./ipc";

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
  /** Legacy flags — still written so old builds stay readable; the built-in
   * scenes also derive their recipes from these. */
  screen: boolean;
  camera: boolean;
  /** Full captured look, keyed by item id (custom scenes). Built-ins leave
   * this unset and compute a canvas-sized recipe at apply time. */
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
}

export interface RoomSources {
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
  /** Room-wide default transition; a scene may override it. */
  transition?: SceneTransition;
  /** Dock-level surface ownership. true = the DOCK paints the card background
   * and its components render flat inside one shared surface; absent/false =
   * every panel owns its own card (the default look). Dock-level by decree —
   * never per component. */
  dock_bg?: Partial<Record<"top" | "left" | "right" | "bottom", boolean>>;
  /** Where the stage's quick controls float: an edge of the canvas. */
  stage_bar?: "bottom" | "top" | "left" | "right";
}

export const DEFAULT_SCENES: RoomScene[] = [
  { id: "pip", name: "PiP", screen: true, camera: true },
  { id: "cam", name: "Full cam", screen: false, camera: true },
  { id: "screen", name: "Screen", screen: true, camera: false },
];

export function defaultConfig(): RoomConfig {
  return {
    sources: {},
    layout: { ...DEFAULT_LAYOUT, left: [...DEFAULT_LAYOUT.left], right: [...DEFAULT_LAYOUT.right], bottom: [...DEFAULT_LAYOUT.bottom], hidden: [...DEFAULT_LAYOUT.hidden] },
    scenes: DEFAULT_SCENES.map((s) => ({ ...s })),
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
  if (Array.isArray(v.scenes) && v.scenes.length) {
    base.scenes = (v.scenes as RoomScene[]).filter(
      (s) => s && typeof s.id === "string" && typeof s.name === "string",
    );
    if (base.scenes.length === 0) base.scenes = DEFAULT_SCENES.map((s) => ({ ...s }));
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
  if (v.sizes && typeof v.sizes === "object") base.sizes = v.sizes as DockSizes;
  if (v.stage_bar === "bottom" || v.stage_bar === "top" || v.stage_bar === "left" || v.stage_bar === "right") {
    base.stage_bar = v.stage_bar;
  }
  if (v.dock_bg && typeof v.dock_bg === "object") {
    base.dock_bg = Object.fromEntries(
      Object.entries(v.dock_bg as Record<string, unknown>).filter(
        ([k, val]) => ["top", "left", "right", "bottom"].includes(k) && typeof val === "boolean",
      ),
    ) as RoomConfig["dock_bg"];
  }
  if (v.transition && typeof v.transition === "object") base.transition = v.transition as SceneTransition;
  return base;
}

export function serializeConfig(c: RoomConfig): string {
  return JSON.stringify(c);
}

/** Which room is broadcasting right now (survives collapsing back to the
 * control room — the engine keeps streaming while the view goes away). */
const LIVE_ROOM_KEY = "producer.live_room";

export function markLiveRoom(id: string | null) {
  try {
    if (id) localStorage.setItem(LIVE_ROOM_KEY, id);
    else localStorage.removeItem(LIVE_ROOM_KEY);
  } catch {
    /* best effort */
  }
}

export function liveRoomId(): string | null {
  try {
    return localStorage.getItem(LIVE_ROOM_KEY);
  } catch {
    return null;
  }
}
