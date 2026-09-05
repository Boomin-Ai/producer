// Interactions on the participant side (#51) — the PURE half shared by the
// guest page (room socket, `interaction:guest`) and the audience page
// (RoomState socket). A frame carries a projected interaction and the
// server's clock; a control is disabled until a SERVER timestamp, never a
// local countdown.

export interface VoteOption {
  id: string;
  label: string;
}

export interface ProjectedInteraction {
  id: string;
  room_id: string;
  type: "vote";
  state: "draft" | "open" | "collecting" | "revealed" | "closed" | "cancelled";
  version: number;
  spec: { prompt: string; options: VoteOption[] };
  input: { roles: string[]; per_identity: "once"; cooldown_ms: number };
  timing: { opened_at?: string; reveal_at?: string; collect_ms: number; reveal_hold_ms: number };
  render: { surface: string; kind: string; style?: string }[];
  tally?: { total: number; options: Record<string, number>; winner: string | null };
  server_now: number;
}

/** Parse a projected interaction off any frame shape: the room channel's
 *  `{ action: "interaction", payload }`, the audience socket's
 *  `{ type: "interaction", interaction }`, or a bare document. */
export function interactionFromFrame(raw: unknown): ProjectedInteraction | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const doc = (f.action === "interaction" ? f.payload : f.type === "interaction" ? f.interaction : f) as Record<string, unknown> | undefined;
  if (!doc || typeof doc !== "object") return null;
  if (typeof doc.id !== "string" || doc.type !== "vote" || typeof doc.state !== "string") return null;
  const spec = doc.spec as { options?: unknown } | undefined;
  if (!spec || !Array.isArray(spec.options)) return null;
  return doc as unknown as ProjectedInteraction;
}

/** Keep the newest version of each interaction; drop what is archived. */
export function mergeInteraction(list: ProjectedInteraction[], next: ProjectedInteraction): ProjectedInteraction[] {
  const rest = list.filter((i) => i.id !== next.id);
  const cur = list.find((i) => i.id === next.id);
  if (cur && cur.version > next.version) return list;
  if (next.state === "cancelled") return rest;
  return [...rest, next];
}

/** The one interaction to show: collecting first, then revealed/closed
 *  (results linger), never `open` (not yet accepting). */
export function activeInteraction(list: ProjectedInteraction[]): ProjectedInteraction | null {
  const collecting = list.filter((i) => i.state === "collecting");
  if (collecting.length) return collecting[collecting.length - 1];
  const shown = list.filter((i) => i.state === "revealed" || i.state === "closed");
  return shown.length ? shown[shown.length - 1] : null;
}

/** server_now - Date.now() at the last frame: add to local time to get the
 *  server's clock, so a phone that slept still shows the right countdown. */
export function clockOffset(serverNow: number, localNow = Date.now()): number {
  return serverNow - localNow;
}

/** Milliseconds until `iso` on the server's clock (≤ 0 = due). */
export function msUntil(iso: string | undefined, offset: number, localNow = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return at - (localNow + offset);
}

/** Percent per option for the bar, always summing to 100 when there are votes. */
export function shares(tally: ProjectedInteraction["tally"] | undefined, options: VoteOption[]): Record<string, number> {
  const out: Record<string, number> = {};
  const total = tally?.total ?? 0;
  for (const o of options) out[o.id] = total ? Math.round(((tally?.options[o.id] ?? 0) / total) * 100) : 0;
  return out;
}
