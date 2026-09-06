/** Notices — the ONE place the room talks back (v0.4.36).
 *
 * Every toast, banner, hint and "copied" bubble goes through `notify` and is
 * drawn by `components/Notice.tsx` in the top bar's drag strip, between the
 * layout button and the Link cluster. A tiny module-level store (no React
 * context: `notify` is called from IPC listeners and async handlers that are
 * not inside render) plus `useNotices()` for the one host that draws them.
 *
 * Tones map to tokens, never to a hand-picked colour: success = mint tint,
 * info = surface-2, warning = amber tint, error = red tint. */

export type NoticeTone = "success" | "info" | "warning" | "error";

export interface Notice {
  id: number;
  text: string;
  tone: NoticeTone;
  /** A stable name; a new notice with the same key REPLACES the old one
   * (engine status, "banner"). */
  key?: string;
  /** Stays until dismissed by key — engine errors that clear on idle. */
  sticky?: boolean;
  /** Draw the check-draws-in confirmation (copy success). */
  check?: boolean;
  /** ms before the notice FADES (hover pauses). Default 4000. */
  ttl: number;
  /** Past its ttl: still drawn, dimmed, until hovered, clicked or replaced
   * (v0.4.38). Only the LAST notice persists — a fade drops older ones. */
  faded?: boolean;
}

export interface NotifyOpts {
  tone?: NoticeTone;
  key?: string;
  sticky?: boolean;
  check?: boolean;
  ttl?: number;
}

type Listener = (list: Notice[]) => void;

let seq = 0;
let list: Notice[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(list);
}

/** Post a notice. Returns its id (for `dismiss`). Empty text is a no-op. */
export function notify(text: string, opts: NotifyOpts = {}): number {
  const t = (text ?? "").trim();
  if (!t) return -1;
  const id = ++seq;
  const n: Notice = {
    id,
    text: t,
    tone: opts.tone ?? "info",
    key: opts.key,
    sticky: opts.sticky,
    check: opts.check,
    ttl: opts.ttl ?? 4000,
  };
  // A new notice REPLACES whatever was lingering faded — the slot is for
  // the latest thing the room said, never a stack of stale ones.
  list = pushIn(list, n);
  emit();
  return id;
}

/** The ttl ran out. Errors never fade (they stay at full opacity until
 * dismissed); everything else dims in place and outlives the clock. Any
 * OTHER faded notice goes — one persisted notice, the last. */
export function fade(id: number) {
  const next = fadeIn(list, id);
  if (next === list) return;
  list = next;
  emit();
}

/** Pure reducer over a list — what `fade` does, for tests and for anyone
 * who wants to reason about the persistence rule without the store. */
export function fadeIn(l: Notice[], id: number): Notice[] {
  const n = l.find((x) => x.id === id);
  if (!n || n.tone === "error") return l;
  return l.filter((x) => x.id === id || !x.faded).map((x) => (x.id === id ? { ...x, faded: true } : x));
}

/** Pure form of `notify`'s list rule: the new notice drops faded ones and
 * anything sharing its key. */
export function pushIn(l: Notice[], n: Notice): Notice[] {
  return [...l.filter((x) => !x.faded && (!n.key || x.key !== n.key)), n];
}

export function dismiss(id: number) {
  if (!list.some((n) => n.id === id)) return;
  list = list.filter((n) => n.id !== id);
  emit();
}

/** Drop every notice posted under `key` (a `null`-banner in the old model). */
export function dismissKey(key: string) {
  if (!list.some((n) => n.key === key)) return;
  list = list.filter((n) => n.key !== key);
  emit();
}

export function clearNotices() {
  list = [];
  emit();
}

export function subscribeNotices(l: Listener): () => void {
  listeners.add(l);
  l(list);
  return () => {
    listeners.delete(l);
  };
}

/** A thrown value as one line a person can read. Strips the `Error:` prefix
 * and maps the routes a server may simply not have (a 404 on an optional
 * route — Boomin has no mod-link mint, an open server has no seats) to a
 * friendly sentence instead of the raw `Route not found`. */
export function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : String(e ?? "");
  const s = raw.replace(/^Error:\s*/, "").trim();
  if (/route not found|not_found|\b404\b/i.test(s)) return "That isn't available on this workspace.";
  return s || "Something went wrong.";
}

/** Convenience: an error notice from a thrown value. */
export function notifyError(e: unknown, opts: Omit<NotifyOpts, "tone"> = {}): number {
  return notify(errText(e), { ...opts, tone: "error" });
}
