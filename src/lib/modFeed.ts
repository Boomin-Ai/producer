/** MOD FEEDS — the placement half of the official mod source (v0.4.32).
 *
 * A seated mod with media is a source KIND of its own on the host's set
 * (`mod-<uuid8>` camera page, `mod-<uuid8>-screen` share page; ids in
 * server/guest/src/participants.ts). Unlike a guest it takes no guest slot
 * and none of the slot math applies: it has its OWN placement rect, saved
 * on the room document under `mod_feeds[participantId][track]` as
 * FRACTIONS of the canvas (so a room re-set from 720p to 4K keeps the same
 * picture), and its own layer rule — above the guest slots, below the
 * overlays — applied when it is placed.
 *
 * Defaults: the camera feed is a lower-right PiP 28% of the canvas width;
 * the screen feed is full frame. Dragging / resizing a placed feed in the
 * stage editor writes the rect back here, so it is remembered across
 * sessions. Pure: no DOM, no IPC (server/test runs it).
 */

import { isModSourceId, type TrackLabel } from "../../server/guest/src/participants";

/** A rect as fractions of the canvas, 0..1. */
export interface ModFeedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ModFeedTrack = TrackLabel;

export type ModFeeds = Record<string, Partial<Record<ModFeedTrack, ModFeedRect>>>;

export const MOD_PIP_WIDTH = 0.28;
const MOD_PIP_MARGIN_X = 0.02;
const MOD_PIP_MARGIN_Y = 0.035;

/** Where a feed lands the first time. Fractions: on a 16:9 canvas a 16:9
 * camera 28% wide is also 28% tall. */
export function defaultModFeedRect(track: ModFeedTrack): ModFeedRect {
  if (track === "screen") return { x: 0, y: 0, w: 1, h: 1 };
  const w = MOD_PIP_WIDTH;
  const h = MOD_PIP_WIDTH;
  return { x: 1 - w - MOD_PIP_MARGIN_X, y: 1 - h - MOD_PIP_MARGIN_Y, w, h };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function readRect(v: unknown): ModFeedRect | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const nums = [o.x, o.y, o.w, o.h];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const r = { x: clamp01(o.x as number), y: clamp01(o.y as number), w: clamp01(o.w as number), h: clamp01(o.h as number) };
  if (r.w <= 0 || r.h <= 0) return null;
  return r;
}

/** Tolerant read of the room-doc field: junk entries dropped, never thrown. */
export function parseModFeeds(raw: unknown): ModFeeds {
  const out: ModFeeds = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [pid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!pid || !v || typeof v !== "object") continue;
    const entry: Partial<Record<ModFeedTrack, ModFeedRect>> = {};
    const cam = readRect((v as Record<string, unknown>).camera);
    const scr = readRect((v as Record<string, unknown>).screen);
    if (cam) entry.camera = cam;
    if (scr) entry.screen = scr;
    if (cam || scr) out[pid] = entry;
  }
  return out;
}

/** The rect to place a seat's feed at: remembered, else the default. */
export function modFeedRect(feeds: ModFeeds | undefined, participantId: string, track: ModFeedTrack): ModFeedRect {
  return feeds?.[participantId]?.[track] ?? defaultModFeedRect(track);
}

/** Remember a placement (pure: returns the next map). */
export function rememberModFeed(feeds: ModFeeds | undefined, participantId: string, track: ModFeedTrack, rect: ModFeedRect): ModFeeds {
  const next: ModFeeds = { ...(feeds ?? {}) };
  next[participantId] = { ...(next[participantId] ?? {}), [track]: rect };
  return next;
}

/** Fractions → canvas units. */
export function toCanvas(r: ModFeedRect, bw: number, bh: number): { x: number; y: number; w: number; h: number } {
  return { x: r.x * bw, y: r.y * bh, w: r.w * bw, h: r.h * bh };
}

/** Canvas units → fractions (what the stage editor hands back). */
export function fromCanvas(g: { x: number; y: number; w: number; h: number }, bw: number, bh: number): ModFeedRect {
  if (!(bw > 0) || !(bh > 0)) return defaultModFeedRect("camera");
  return { x: clamp01(g.x / bw), y: clamp01(g.y / bh), w: clamp01(g.w / bw), h: clamp01(g.h / bh) };
}

/** The LAYER a mod feed is placed at: above every guest slot and guest,
 * below the overlays (the well-known `overlay` item and every `overlay`-kind
 * extra). With overlays on the stack it takes the lowest overlay's index —
 * the engine inserts there and the overlays move up one; with none it goes
 * on top. Items are the engine's list; only `id`, `kind`, `z` are read. */
export function modFeedZ(items: readonly { id: string; kind: string; z: number }[]): number {
  const overlays = items.filter((i) => i.kind === "overlay" || i.id === "overlay");
  if (overlays.length) return Math.max(0, Math.min(...overlays.map((i) => i.z)));
  return items.length ? Math.max(...items.map((i) => i.z)) + 1 : 0;
}

/** Which participant a mod source id belongs to, given the rows that could
 * own it (ids are `mod-<uuid8>`; the roster maps them back). */
export function modSourceOwner<T extends { id: string }>(sourceId: string, rows: readonly T[]): { row: T; track: ModFeedTrack } | null {
  if (!isModSourceId(sourceId)) return null;
  const screen = sourceId.endsWith("-screen");
  const base = screen ? sourceId.slice(0, -"-screen".length) : sourceId;
  const row = rows.find((r) => `mod-${r.id.slice(0, 8)}` === base);
  return row ? { row, track: screen ? "screen" : "camera" } : null;
}
