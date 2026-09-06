/** The Vote panel's pure half (v0.4.33): which FORM the panel wears follows
 * the dock it sits in and the vote's state — one component, three shapes.
 *
 *   strip  a row dock (slim top/bottom): one line, like chat's console form
 *   card   a column dock, no vote running: last question + "Set up"
 *   edit   a column dock, the host is writing a question (sub-page)
 *   live   a vote is open / collecting / revealed: the bars and the buttons
 *
 * A row dock never shows `edit` in the flow: "Set up" opens the same sub-page
 * as a popover instead, so the strip keeps its one line. */
import type { Dock } from "./layout";

export type VoteForm = "strip" | "card" | "edit" | "live";

export interface VoteFormState {
  /** The shown interaction's state, or null when the room has none. */
  state: string | null;
  /** The host has the question editor open (LiveView's `voteEdit`). */
  editing: boolean;
}

/** A vote that is still on the set: open (waiting for Start), collecting,
 * or revealed. Closed and cancelled votes are history. */
export function voteIsLive(state: string | null | undefined): boolean {
  return !!state && state !== "closed" && state !== "cancelled" && state !== "draft";
}

export function voteFormFor(dock: Dock, s: VoteFormState): VoteForm {
  if (dock === "top") return "strip";
  if (voteIsLive(s.state)) return "live";
  return s.editing ? "edit" : "card";
}

/** The first sentence of a release body, for the Updates strip. Markdown
 * bullets and headings are stripped; links stay as they are. */
export function firstSentence(body: string | null | undefined): string {
  if (!body) return "";
  const line = body
    .split("\n")
    .map((l) => l.replace(/^[-*#\s]+/, "").trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : line).trim();
}
