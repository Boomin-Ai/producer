/** Panel inventory + dock layout (our take on OBS docks).
 *
 * Everything in the room that isn't the stage is a PANEL, and every panel
 * lives in one of four docks — or is hidden. The chrome that never moves:
 * the 48px header (health, output, virtual cam, record, GO LIVE) and the
 * canvas. Everything else is a card.
 * Beginners pick a preset; everyone else moves panels one by one. */

export type PanelId = "scenes" | "sources" | "mixer" | "chat" | "channels" | "guests" | "stats" | "updates";

export type Dock = "top" | "left" | "right" | "bottom" | "hidden";

export interface Layout {
  top: PanelId[];
  left: PanelId[];
  right: PanelId[];
  bottom: PanelId[];
  hidden: PanelId[];
}

export const PANEL_META: Record<PanelId, { title: string; hint: string }> = {
  scenes: { title: "Scenes", hint: "Cut between looks — hits the broadcast instantly" },
  sources: { title: "Sources", hint: "What's in the scene right now" },
  mixer: { title: "Audio mixer", hint: "Levels, mute, and gain per input" },
  chat: { title: "Chat", hint: "Every platform's chat, merged" },
  channels: { title: "Channels", hint: "Where this room goes out" },
  stats: { title: "Stats", hint: "FPS, CPU, bitrate, drops — the numbers behind the health dot" },
  updates: { title: "Updates", hint: "What shipped — every entry links to its exact PR" },
  guests: { title: "Guests", hint: "Who's in the room, and who's on screen" },

};

// Stream health is deliberately NOT here: it lives in the header, always
// visible. Health you have to dock is health you find out about too late.
export const PANEL_ORDER: PanelId[] = ["scenes", "sources", "mixer", "chat", "channels", "guests", "stats", "updates"];

/** Per-room sizing: bottom panels carry a flex weight (they share one row),
 * side docks carry a pixel width. Absent = the built-in default. */
export interface DockSizes {
  /** "<dock>:<panel id>" → flex weight along that dock's axis (1 = default
   * share). Weights are EARNED by a pair-drag in a specific dock and apply
   * only there — a bottom-row drag must never pin chat's height in a side
   * rail. Legacy bare panel-id keys read as bottom-row weights. */
  weights?: Partial<Record<string, number>>;
  left?: number;
  right?: number;
  /** Dock heights (px). Bottom under BOTTOM_SLIM collapses its panels into
   * their slim (top-dock) forms — the dock axes share one form system. */
  bottom?: number;
  top?: number;
}

export const SIDE_MIN = 200;
export const SIDE_MAX = 560;
export const BOTTOM_MAX = 480;
export const TOP_MAX = 240;
/** The universal mini view: dragging any row dock under ROW_SNAP warps it to
 * exactly ROW_MINI, where every panel wears its console (top) form. One
 * threshold, one landing size — no broken in-between heights. */
export const ROW_SNAP = 120;
export const ROW_MINI = 56;

export const PRESETS: { key: string; label: string; note: string; layout: Layout }[] = [
  {
    key: "studio",
    label: "Studio",
    note: "The full desk — scenes and guests left, chat and channels right",
    layout: {
      top: [],
      left: ["scenes", "guests", "sources"],
      right: ["chat", "channels"],
      bottom: ["mixer", "stats"],
      hidden: [],
    },
  },
  {
    key: "simple",
    label: "Simple",
    note: "Stage plus the two things you touch live",
    layout: { top: [], left: [], right: [], bottom: ["sources", "mixer"], hidden: ["scenes", "chat", "channels", "guests", "stats"] },
  },
  {
    key: "chat",
    label: "Chat first",
    note: "The conversation gets the column; controls stay below",
    layout: { top: [], left: [], right: ["chat"], bottom: ["sources", "mixer", "guests"], hidden: ["scenes", "channels", "stats"] },
  },
]

export const DEFAULT_LAYOUT: Layout = PRESETS.find((p) => p.key === "studio")!.layout;




function clone(l: Layout): Layout {
  return {
    top: [...(l.top ?? [])],
    left: [...l.left],
    right: [...l.right],
    bottom: [...l.bottom],
    hidden: [...l.hidden],
  };
}

/** Every panel appears exactly once; unknown ids are dropped, new panels
 * (added in a later version) land in `hidden` so nothing silently vanishes
 * from the app without also being listed as available.
 *
 * Exported because EVERY stored layout must pass through here, not just the
 * one in localStorage: a room document saved before a panel was retired will
 * still name it, and rendering a panel the inventory no longer knows about
 * takes the whole room down. */
export function normalize(p: Partial<Layout>): Layout {
  const seen = new Set<PanelId>();
  const take = (arr: unknown): PanelId[] => {
    if (!Array.isArray(arr)) return [];
    const out: PanelId[] = [];
    for (const id of arr) {
      if (PANEL_ORDER.includes(id as PanelId) && !seen.has(id as PanelId)) {
        seen.add(id as PanelId);
        out.push(id as PanelId);
      }
    }
    return out;
  };
  const l: Layout = { top: take(p.top), left: take(p.left), right: take(p.right), bottom: take(p.bottom), hidden: take(p.hidden) };
  // A panel absent from EVERY array was never seen by this layout's owner —
  // it cannot have been deliberately hidden. Introduce it at its natural
  // dock ONCE; after the first save the user's placement (incl. hidden)
  // wins forever. Hidden stays the default for future panels.
  const INTRO_DOCK: Partial<Record<PanelId, Dock>> = { stats: "bottom", updates: "right" };
  for (const id of PANEL_ORDER) if (!seen.has(id)) l[INTRO_DOCK[id] ?? "hidden"].push(id);
  return l;
}

export function dockOf(l: Layout, id: PanelId): Dock {
  if (l.top.includes(id)) return "top";
  if (l.left.includes(id)) return "left";
  if (l.right.includes(id)) return "right";
  if (l.bottom.includes(id)) return "bottom";
  return "hidden";
}

export function movePanel(l: Layout, id: PanelId, to: Dock): Layout {
  const next = clone(l);
  for (const d of ["top", "left", "right", "bottom", "hidden"] as Dock[]) {
    next[d] = next[d].filter((x) => x !== id);
  }
  next[to].push(id);
  return next;
}

/** Reorder within a dock: -1 moves earlier, +1 later. */
export function shiftPanel(l: Layout, id: PanelId, delta: number): Layout {
  const next = clone(l);
  const d = dockOf(l, id);
  if (d === "hidden") return next;
  const arr = next[d];
  const i = arr.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= arr.length) return next;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return next;
}

/** Drop a panel into a dock at a precise slot (drag-and-drop). */
export function movePanelTo(l: Layout, id: PanelId, to: Dock, index: number): Layout {
  const from = dockOf(l, id);
  const next: Layout = {
    top: l.top.filter((x) => x !== id),
    left: l.left.filter((x) => x !== id),
    right: l.right.filter((x) => x !== id),
    bottom: l.bottom.filter((x) => x !== id),
    hidden: l.hidden.filter((x) => x !== id),
  };
  // Removing an earlier sibling shifts the target slot left by one.
  const at = from === to && l[to].indexOf(id) < index ? index - 1 : index;
  next[to].splice(Math.max(0, Math.min(at, next[to].length)), 0, id);
  return next;
}
