// The engine outlives each room view. Finish an old room's work and release
// before a new room may restore its document, including StrictMode remounts.
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work);
  tail = result.catch(() => {});
  return result;
}
export function roomSession() {
  let alive = true;
  return {
    run(work: () => Promise<void>): Promise<void> {
      return enqueue(async () => { if (alive) await work(); });
    },
    close(release: () => Promise<void>): Promise<void> {
      if (!alive) return Promise.resolve();
      alive = false;
      return enqueue(release);
    },
  };
}
