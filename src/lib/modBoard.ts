/** The MOD VIEW — a board, not the host's dock layout.
 *
 * Rendered for any non-host seat on a Boomin room, and for a mod seat on an
 * open server (views/ModBoard.tsx). Founder design, 2026-09-05:
 *
 *   ┌──────────────────────── HOST OUTPUT ───────────────────────┐
 *   │  room · LIVE · clock          (the program monitor)        │
 *   ├─────────────────── the strip: scene PADS ──────────────────┤
 *   │ [ Cam ] [ Wide ] [ Screen ] … [ Vote ▸ ] [ Audience link ] │
 *   ├── PEOPLE ──────────────┬── MY FEEDS ────────────────────────┤
 *   │ waiting → Admit/Decline│ CAMERA        SCREEN               │
 *   │ staged → Stage/order   │ (self-preview or "Ask the host")   │
 *   │                        │ [Throw up]    [Throw up]           │
 *   ├────────────────── the row of switches ─────────────────────┤
 *   │ holds: chips · sending: cam / mic / screen · capabilities  │
 *   └────────────────────────────────────────────────────────────┘
 *
 * This file is the PURE half: the board's layout (panels on regions, saved
 * per seat under `producer.modboard.v1`) and the throw-up reducer (the
 * seat's own row through the honest-staging path). No DOM, no IPC — the
 * server's vitest runs it. Structured so a future "sound board" strip is
 * one more panel id landing in `strip`.
 */

import { hasAnyMedia } from "./participants";
import { modRowStage, type ModStageState } from "./stageTruth";

// ── Layout ──────────────────────────────────────────────────────────────────

export type ModBoardPanel = "monitor" | "scenes" | "people" | "feeds" | "switches";

/** The board's regions. `strip` runs under the monitor and is where pad
 *  rows live (scenes today; a sound board tomorrow). */
export type ModBoardRegion = "top" | "strip" | "left" | "right" | "bottom" | "hidden";

export interface ModBoardLayout {
  top: ModBoardPanel[];
  strip: ModBoardPanel[];
  left: ModBoardPanel[];
  right: ModBoardPanel[];
  bottom: ModBoardPanel[];
  hidden: ModBoardPanel[];
}

export const MOD_BOARD_PREF = "producer.modboard.v1";

export const MOD_BOARD_PANELS: readonly ModBoardPanel[] = ["monitor", "scenes", "people", "feeds", "switches"];

export const MOD_BOARD_META: Record<ModBoardPanel, { title: string; hint: string }> = {
  monitor: { title: "Host output", hint: "The host's program, as it goes out" },
  scenes: { title: "Scenes", hint: "Pads — one tap cuts the host's room (⌘1–9)" },
  people: { title: "People", hint: "Waiting guests to admit; staged guests to order" },
  feeds: { title: "My feeds", hint: "Your camera and screen, when the host has given them" },
  switches: { title: "Switches", hint: "What this seat holds and what it is sending" },
};

const REGIONS: readonly ModBoardRegion[] = ["top", "strip", "left", "right", "bottom", "hidden"];

/** Where a panel lands the first time a layout that never saw it is loaded. */
const INTRO_REGION: Record<ModBoardPanel, ModBoardRegion> = {
  monitor: "top",
  scenes: "strip",
  people: "left",
  feeds: "right",
  switches: "bottom",
};

export const DEFAULT_MOD_BOARD: ModBoardLayout = {
  top: ["monitor"],
  strip: ["scenes"],
  left: ["people"],
  right: ["feeds"],
  bottom: ["switches"],
  hidden: [],
};

/** Every panel exactly once; unknown ids dropped; a panel absent from every
 *  region (added after the layout was saved) lands at its intro region.
 *  Accepts the stored JSON string, a parsed object, or junk (→ default). */
export function normalizeModBoard(raw: unknown): ModBoardLayout {
  let p: unknown = raw;
  if (typeof raw === "string") {
    try {
      p = JSON.parse(raw);
    } catch {
      p = null;
    }
  }
  const obj = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  const seen = new Set<ModBoardPanel>();
  const take = (v: unknown): ModBoardPanel[] => {
    if (!Array.isArray(v)) return [];
    const out: ModBoardPanel[] = [];
    for (const id of v) {
      if (MOD_BOARD_PANELS.includes(id as ModBoardPanel) && !seen.has(id as ModBoardPanel)) {
        seen.add(id as ModBoardPanel);
        out.push(id as ModBoardPanel);
      }
    }
    return out;
  };
  const l: ModBoardLayout = { top: take(obj.top), strip: take(obj.strip), left: take(obj.left), right: take(obj.right), bottom: take(obj.bottom), hidden: take(obj.hidden) };
  for (const id of MOD_BOARD_PANELS) if (!seen.has(id)) l[INTRO_REGION[id]].push(id);
  return l;
}

export const serializeModBoard = (l: ModBoardLayout): string => JSON.stringify(l);

export function boardRegionOf(l: ModBoardLayout, id: ModBoardPanel): ModBoardRegion {
  for (const r of REGIONS) if (l[r].includes(id)) return r;
  return "hidden";
}

/** Move a panel to a region (appended). Pure. */
export function moveBoardPanel(l: ModBoardLayout, id: ModBoardPanel, to: ModBoardRegion): ModBoardLayout {
  const next: ModBoardLayout = { top: [...l.top], strip: [...l.strip], left: [...l.left], right: [...l.right], bottom: [...l.bottom], hidden: [...l.hidden] };
  for (const r of REGIONS) next[r] = next[r].filter((x) => x !== id);
  next[to].push(id);
  return next;
}

export function sameBoard(a: ModBoardLayout, b: ModBoardLayout): boolean {
  return REGIONS.every((r) => a[r].length === b[r].length && a[r].every((x, i) => x === b[r][i]));
}

// ── My feeds: what the seat holds ───────────────────────────────────────────

export type FeedKind = "camera" | "screen";

export interface SeatFeeds {
  camera: boolean;
  mic: boolean;
  screen: boolean;
  /** Any media at all — the sending half opens only then. */
  any: boolean;
}

export function seatFeeds(grants: ReadonlySet<string>): SeatFeeds {
  return {
    camera: grants.has("media.camera"),
    mic: grants.has("media.mic"),
    screen: grants.has("media.screen"),
    any: hasAnyMedia(grants),
  };
}

/** The greyed window's one line. */
export const ASK_HOST: Record<FeedKind, string> = {
  camera: "Ask the host for camera",
  screen: "Ask the host for screen",
};

/** The chips under the switches: the grants this seat holds, in the words
 *  the doctrine uses. Control grants read off the access DTO; media off the
 *  seat's own row. */
export function heldChips(input: { grants: ReadonlySet<string>; can: { control: boolean; scene: boolean; interactions: boolean; manage: boolean } }): string[] {
  const out: string[] = [];
  if (input.can.scene) out.push("cuts scenes");
  if (input.can.control) out.push("admits · stages");
  if (input.can.interactions) out.push("runs votes");
  if (input.can.manage) out.push("grants roles");
  if (input.grants.has("media.camera")) out.push("camera");
  if (input.grants.has("media.mic")) out.push("mic");
  if (input.grants.has("media.screen")) out.push("screen");
  if (input.grants.has("media.return_feed")) out.push("return feed");
  return out;
}

// ── Throw up: the seat's own row through honest staging ─────────────────────
//
// "Throw up" asks the host's set for a slot for THIS seat: the seat's row
// (its monitor row on Boomin) goes through the same stage request every
// participant does (lib/stageTruth.ts). The button is therefore a projection
// of the honest-staging state for one guest id — never optimistic.

export type ThrowUpRow =
  /** No media granted: nothing to throw. */
  | "no-media"
  /** No row yet (the monitor has not been minted), or the seat cannot ask. */
  | "unavailable"
  | "off"
  | "pending-on"
  | "on"
  | "pending-off";

export interface ThrowUpState {
  row: ThrowUpRow;
  /** The host's last answer about this seat (a refusal, silence). */
  notice: string | null;
  /** The button's label. */
  label: string;
  disabled: boolean;
}

export function throwUpState(input: {
  stage: ModStageState;
  seatId: string | null;
  grants: ReadonlySet<string>;
  /** `can.control` — the stage request needs room control on the server. */
  canAsk: boolean;
}): ThrowUpState {
  if (!hasAnyMedia(input.grants)) return { row: "no-media", notice: null, label: "Throw up", disabled: true };
  if (!input.seatId || !input.canAsk) return { row: "unavailable", notice: null, label: "Throw up", disabled: true };
  const row = modRowStage(input.stage, input.seatId);
  const notice = input.stage.notice?.guestId === input.seatId ? input.stage.notice.text : null;
  switch (row) {
    case "pending-on":
      return { row, notice, label: "Asking the host…", disabled: true };
    case "pending-off":
      return { row, notice, label: "Coming down…", disabled: true };
    case "on":
      return { row, notice, label: "On the set — take down", disabled: false };
    default:
      return { row: "off", notice, label: "Throw up", disabled: false };
  }
}

// ── Seats on the roster (the host's Mods panel) ─────────────────────────────

export interface SeatRow<T> {
  row: T;
  name: string;
  userId: string | null;
  grants: Set<string>;
  media: SeatFeeds;
}
