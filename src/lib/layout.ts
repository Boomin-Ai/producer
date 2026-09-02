/** Panel inventory + dock layout (our take on OBS docks).
 *
 * Everything in the room that isn't the stage is a PANEL, and every panel
 * lives in one of three docks — or is hidden. The chrome that never moves:
 * the top bar (brand, room, stream health) and the canvas. Transport —
 * GO LIVE, record, virtual cam, channels — is the CONTROLLER panel, dockable
 * like everything else but never hideable (a hidden Go Live is a dead room).
 * Beginners pick a preset; everyone else moves panels one by one. */

export type PanelId = "scenes" | "sources" | "mixer" | "chat" | "channels" | "guests";

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
  channels: { title: "Controller", hint: "Go live, record, virtual cam, and where this room goes out" },
  guests: { title: "Guests", hint: "Who's in the room, and who's on screen" },

};

// Stream health is deliberately NOT here: it lives in the header, always
// visible. Health you have to dock is health you find out about too late.
export const PANEL_ORDER: PanelId[] = ["scenes", "sources", "mixer", "chat", "channels", "guests"];

/** Per-room sizing: bottom panels carry a flex weight (they share one row),
 * side docks carry a pixel width. Absent = the built-in default. */
export interface DockSizes {
  /** panel id → flex weight in the bottom row (1 = default share). */
  weights?: Partial<Record<PanelId, number>>;
  left?: number;
  right?: number;
}

export const SIDE_MIN = 200;
export const SIDE_MAX = 560;

export const PRESETS: { key: string; label: string; note: string; layout: Layout }[] = [
  {
    key: "simple",
    label: "Simple",
    note: "Stage plus the two things you touch live",
    layout: { top: [], left: [], right: [], bottom: ["sources", "mixer", "channels"], hidden: ["scenes", "chat",] },
  },
  {
    key: "streamer",
    label: "Streamer",
    note: "Scenes left, chat right, controls below",
    layout: { top: [], left: ["scenes"], right: ["chat"], bottom: ["sources", "mixer", "channels"], hidden: [] },
  },
  {
    key: "chat",
    label: "Chat first",
    note: "Big chat, everything else compact",
    layout: { top: [], left: ["scenes"], right: ["chat"], bottom: ["sources", "mixer", "channels"], hidden: [] },
  },
  {
    key: "studio",
    label: "Studio",
    note: "Everything on deck, including health",
    layout: { top: [], left: ["scenes"], right: ["chat", "channels"], bottom: ["sources", "mixer"], hidden: [] },
  },
];

export const DEFAULT_LAYOUT: Layout = PRESETS[1].layout;

const KEY = "producer.layout.v1";

export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_LAYOUT);
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return normalize(parsed);
  } catch {
    return clone(DEFAULT_LAYOUT);
  }
}

export function saveLayout(l: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* layout is a convenience, never a blocker */
  }
}

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
  for (const id of PANEL_ORDER) if (!seen.has(id)) l.hidden.push(id);
  // The Controller carries GO LIVE — a layout that hides it bricks the room.
  const ci = l.hidden.indexOf("channels");
  if (ci >= 0) {
    l.hidden.splice(ci, 1);
    l.bottom.push("channels");
  }
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
