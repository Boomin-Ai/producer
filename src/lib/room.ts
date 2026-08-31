/** A room is a document. It owns its dock layout, its scenes, which
 * channels it goes out to, and the scene state itself — so switching rooms
 * switches the whole show, not just the picture. Persisted as JSON in
 * live_rooms.config (see live_update_room). */

import { DEFAULT_LAYOUT, type Layout } from "./layout";

export interface RoomScene {
  id: string;
  name: string;
  screen: boolean;
  camera: boolean;
}

export interface RoomSources {
  screen?: boolean;
  camera?: boolean;
  mic?: boolean;
  mic_volume?: number;
  mic_muted?: boolean;
  overlay_window?: number | null;
  overlay_url?: string | null;
}

export interface RoomConfig {
  sources: RoomSources;
  layout: Layout;
  scenes: RoomScene[];
  /** destination id → included when this room goes live. */
  channels: Record<string, boolean>;
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
    const l = v.layout as Partial<Layout>;
    base.layout = {
      left: Array.isArray(l.left) ? l.left : [],
      right: Array.isArray(l.right) ? l.right : [],
      bottom: Array.isArray(l.bottom) ? l.bottom : [],
      hidden: Array.isArray(l.hidden) ? l.hidden : [],
    };
  }
  if (Array.isArray(v.scenes) && v.scenes.length) {
    base.scenes = (v.scenes as RoomScene[]).filter(
      (s) => s && typeof s.id === "string" && typeof s.name === "string",
    );
    if (base.scenes.length === 0) base.scenes = DEFAULT_SCENES.map((s) => ({ ...s }));
  }
  if (v.channels && typeof v.channels === "object") base.channels = v.channels as Record<string, boolean>;
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
