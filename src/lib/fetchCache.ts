/** A small in-memory cache for the room surface's reads (rooms, network
 * connections, deals, live rooms): keyed by endpoint + resource, kept for
 * the life of the window.
 *
 * The rule it enforces: a view never clears what it knows before a refetch.
 * It mounts on the LAST-KNOWN value (no empty flash when you come back
 * from a room), refetches in the background only when the entry is older
 * than STALE_MS, and reconciles — an identical answer is not a re-render.
 *
 * Workspace switches stay honest: the key carries the endpoint id, so the
 * previous brand's data is never shown under the new one — the new key is
 * either cached (that brand's own last answer) or empty. */

export const STALE_MS = 30_000;

interface Entry {
  at: number;
  value: unknown;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** The last-known value, whatever its age. */
export function cached<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

export function isFresh(key: string, now = Date.now()): boolean {
  const e = store.get(key);
  return !!e && now - e.at < STALE_MS;
}

export function remember<T>(key: string, value: T, now = Date.now()): T {
  store.set(key, { at: now, value });
  return value;
}

export function forget(prefix: string): void {
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
}

/** Stale-while-revalidate: a fresh entry answers at once; otherwise fetch
 * (one in-flight call per key), remember, answer. `force` skips the
 * freshness check (an interval poll, an action that changed the data).
 * A failed fetch keeps the last-known value and rethrows. */
export async function swr<T>(key: string, fetcher: () => Promise<T>, opts: { force?: boolean } = {}): Promise<T> {
  if (!opts.force && isFresh(key)) return cached<T>(key) as T;
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fetcher()
    .then((v) => remember(key, v))
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Deep-equal-by-JSON reconcile for setState updaters: keeps the previous
 * reference when nothing changed, so memoized children stay put. */
export function reconcile<T>(prev: T, next: T): T {
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}
