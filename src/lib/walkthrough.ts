// ── The first-room walkthrough ────────────────────────────────────────────
//
// A new room is an empty stage, and the empty stage does not explain itself.
// Worse, it used to let you build something broken: a source added before any
// scene existed belonged to NO scene, so the moment you made your first one it
// vanished from the panel — still in the graph, still rendering, with no row
// to select, hide or delete. The engine was right and the user was stranded.
//
// So the order matters: a scene FIRST, then sources into it. This walkthrough
// teaches that order by making the user do it, not by describing it. Every
// step advances on the real action against real UI — there is no simulated
// click, no "next" button that lies about progress.
//
// It runs once. The pref is durable (Rust SQLite, survives a cache clear and a
// reinstall), and Settings → App can switch it back on.

import type { Dock, Layout, PanelId } from "./layout";
import { dockOf } from "./layout";

/** "1" once the walkthrough has been finished OR skipped; absent = show it. */
export const PREF_WALKTHROUGH_OFF = "walkthrough_off";

/** Where the user got to. The walkthrough deliberately LEAVES the room near
 *  the end (Settings → Integrations is not reachable from inside one), which
 *  unmounts the whole view — so the step has to live somewhere the room does
 *  not own. Durable, like the off switch: closing the app mid-walkthrough and
 *  coming back should not start over. Cleared when it finishes or is skipped. */
export const PREF_WALKTHROUGH_STEP = "walkthrough_step";

/** The room the walkthrough was running in when it sent the user out to
 *  Settings. Without this the trip is one-way: the room view is unmounted,
 *  nothing remembers WHICH room, and the user is left to find their way back
 *  by hand — which is not a walkthrough, it is an abandonment. */
export const PREF_WALKTHROUGH_ROOM = "walkthrough_room";

export type WalkStep =
  /** Full-room overlay. The only step that is not a coach mark. */
  | "welcome"
  /** Open the layout editor (the chip in the header, or ⌘E). */
  | "edit"
  /** Put the Scenes panel into a dock — the point of the editor. */
  | "panel"
  /** Leave the editor, so the room is live again. */
  | "done"
  /** Make the first scene. Nothing may be added to the stage before this. */
  | "scene"
  /** Add something to it. Now it lands somewhere. */
  | "source"
  /** Where other people come in. */
  | "guests"
  /** Sound. A show with no audio is the most common first mistake. */
  | "mic"
  /** LEAVES THE ROOM: Settings → Integrations, where stream keys live.
   *  Skippable — plenty of people set this up days after their first room. */
  | "integrations"
  /** They came back. */
  | "back"
  /** Closing card. */
  | "finish";

export const WALK_ORDER: WalkStep[] = [
  "welcome",
  "edit",
  "panel",
  "done",
  "scene",
  "source",
  "guests",
  "mic",
  "integrations",
  "back",
  "finish",
];

/** A step the user reads and dismisses, rather than one the room satisfies.
 *  These get buttons; every other step gets a ring and waits. */
export const CARD_STEPS: WalkStep[] = ["welcome", "integrations", "back", "finish"];

export function isCardStep(s: WalkStep): boolean {
  return CARD_STEPS.includes(s);
}

/** Steps shown in the counter. The card-only ones are not work the user does,
 *  so counting them would promise a longer walkthrough than it is. */
export const COUNTED: WalkStep[] = WALK_ORDER.filter((s) => !isCardStep(s));

export interface WalkCopy {
  title: string;
  body: string;
  /** What the user must actually do. Absent on the two card-only steps. */
  action?: string;
}

export const WALK_COPY: Record<WalkStep, WalkCopy> = {
  welcome: {
    title: "Welcome to your Producer room",
    body: "This is your stage. In about a minute you'll have a scene with a camera in it, built the way every show here is built.",
  },
  edit: {
    title: "Open the layout editor",
    body: "Your room's panels are yours to arrange. The editor is where you add them.",
    action: "Click Edit layout in the header, or press ⌘E.",
  },
  panel: {
    title: "Add the Scenes panel",
    body: "Scenes are the shots your show cuts between. You need the panel before you can make one.",
    action: "Press + on any dock and choose Scenes.",
  },
  done: {
    title: "That's the editor",
    body: "Every panel moves this way — drag it by its grip, or use its placement button.",
    action: "Click Done to close the editor.",
  },
  scene: {
    title: "Make your first scene",
    body: "A scene is a look: which sources are on, where they sit, which one is on top. Your room needs at least one before anything can go on the stage.",
    action: "Click + in the Scenes panel.",
  },
  source: {
    title: "Now add a camera",
    body: "Sources join the scene you add them in. That's why the scene came first — added to no scene, a source belongs nowhere and you can't reach it again.",
    action: "Open the Sources panel and add a camera.",
  },
  guests: {
    title: "This is where people join you",
    body: "Guests get a link, open it in a browser, and land on your stage. No account, no install, and they're free.",
    action: "Open the Guests panel — the invite link lives there.",
  },
  mic: {
    title: "Give the scene a voice",
    body: "Audio is per scene, like everything else: this scene carries its own mic. A show that looks right and sounds like nothing is the most common first mistake here.",
    action: "Add a microphone from Sources.",
  },
  integrations: {
    title: "Last thing: where it goes out",
    body: "Stream keys live in Settings, outside the room — so this step takes you there and brings you back. If you don't have your keys handy, skip it. Nothing here is required to build a show.",
  },
  back: {
    title: "Welcome back",
    body: "That's the whole loop: a room to build in, settings for the plumbing. Your set is exactly where you left it.",
  },
  finish: {
    title: "You're ready",
    body: "Scenes hold sources. Guests join by link. When you're set, GO LIVE is in the header. You can replay this any time from Settings → App.",
  },
};

/** Whether the room is untouched enough to teach on: no scenes, no sources.
 *  A room someone already built is not a classroom. */
export function roomIsFresh(input: { scenes: number; extras: number }): boolean {
  return input.scenes === 0 && input.extras === 0;
}

/** The state each step watches. Advancing is a FACT about the room, never a
 *  claim the card makes about itself. */
export interface WalkWorld {
  layoutEdit: boolean;
  layout: Layout;
  scenes: number;
  extras: number;
  /** Mic sources specifically — "add a source" and "add a MIC" are different
   *  lessons, and a camera must not satisfy the audio step. */
  mics: number;
}

/** Has the user done what this step asked? The two card-only steps
 *  ("welcome", "finish") are never satisfied by the world — a button
 *  dismisses those. */
export function stepSatisfied(step: WalkStep, w: WalkWorld): boolean {
  switch (step) {
    case "edit":
      return w.layoutEdit;
    case "panel":
      return dockOf(w.layout, "scenes") !== "hidden";
    case "done":
      return !w.layoutEdit;
    case "scene":
      return w.scenes > 0;
    case "source":
      return w.extras > 0;
    case "guests":
      return dockOf(w.layout, "guests") !== "hidden";
    case "mic":
      return w.mics > 0;
    default:
      // "welcome", "integrations", "back", "finish" are dismissed by a
      // button, never by the room.
      return false;
  }
}

/** Where the coach card points. `null` centres it (no anchor on screen yet). */
export type WalkAnchor =
  | "header-edit"
  | "editbar-add"
  | "editbar-done"
  | "panel-scenes"
  | "panel-sources"
  | "panel-guests"
  | null;

export function anchorFor(step: WalkStep, layout: Layout): WalkAnchor {
  switch (step) {
    case "edit":
      return "header-edit";
    case "panel":
      return "editbar-add";
    case "done":
      return "editbar-done";
    case "scene":
      return dockOf(layout, "scenes") === "hidden" ? null : "panel-scenes";
    case "source":
    case "mic":
      return dockOf(layout, "sources") === "hidden" ? null : "panel-sources";
    case "guests":
      return dockOf(layout, "guests") === "hidden" ? "editbar-add" : "panel-guests";
    default:
      return null;
  }
}

/** A step the user can no longer satisfy because they undid an earlier one —
 *  they closed the editor while we were asking them to add a panel. Rather
 *  than stranding the card, walk BACK to the step that is now true. */
export function rewindFor(step: WalkStep, w: WalkWorld): WalkStep | null {
  if (step === "panel" && !w.layoutEdit) return "edit";
  if (step === "scene" && dockOf(w.layout, "scenes") === "hidden") return "panel";
  return null;
}

/** The dock a panel sits in, for the highlight ring. Re-exported so the view
 *  does not need to import layout internals. */
export function dockForPanel(layout: Layout, id: PanelId): Dock {
  return dockOf(layout, id);
}
