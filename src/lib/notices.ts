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
  /** ms before auto-dismiss (hover pauses). Default 4000. */
  ttl: number;
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
  list = [...(n.key ? list.filter((x) => x.key !== n.key) : list), n];
  emit();
  return id;
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
