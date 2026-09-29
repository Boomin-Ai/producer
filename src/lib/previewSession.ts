export type PreviewBounds = { x: number; y: number; width: number; height: number };
type Driver = { attach: (r: PreviewBounds) => Promise<boolean>; move: (r: PreviewBounds) => Promise<unknown>; detach: () => Promise<unknown> };
// Native preview is one per window. Serialize teardown before a new mount can
// attach, including when the previous attach has not resolved yet.
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work); tail = result.catch(() => {}); return result;
}
export function previewSession(driver: Driver, stage: (transparent: boolean) => void) {
  let alive = true, attached = false, busy = false, retryAt = 0;
  let last: PreviewBounds | undefined;
  const same = (r: PreviewBounds) => last && Math.abs(last.x-r.x)<.5 && Math.abs(last.y-r.y)<.5 && Math.abs(last.width-r.width)<.5 && Math.abs(last.height-r.height)<.5;
  return {
    async sync(measure: () => PreviewBounds | undefined) {
      if (!alive || busy || Date.now() < retryAt) return;
      const r = measure();
      if (!r || !Object.values(r).every(Number.isFinite) || r.width < 10 || r.height < 10 || (attached && same(r))) return;
      busy = true;
      try {
        await enqueue(async () => {
          if (!alive) return;
          if (!attached) {
            const transparent = await driver.attach(r);
            if (!alive) return; // close has already queued detach behind us
            attached = true; stage(transparent);
          }
          const now = measure();
          if (!alive || !now || now.width < 10 || now.height < 10) return;
          await driver.move(now);
          if (alive) last = { ...now }; // failed moves must be retried
        });
      } catch {
        if (alive) {
          attached = false; last = undefined; stage(false); retryAt = Date.now() + 1000;
          // Attach may have reached the engine even when the bridge rejected.
          await enqueue(() => driver.detach()).catch(() => {});
        }
      } finally { busy = false; }
    },
    close() {
      alive = false; stage(false);
      return enqueue(() => driver.detach()).catch(() => {});
    },
  };
}
