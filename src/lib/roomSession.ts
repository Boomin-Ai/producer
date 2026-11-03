// The engine outlives each room view. Finish an old room's work and release
// before a new room may restore its document, including StrictMode remounts.
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work);
  tail = result.catch(() => {});
  return result;
}
export function roomSession() {
  let alive = true, started = false;
  return {
    run(work: () => Promise<void>): Promise<void> {
      return enqueue(async () => { if (alive) {started=true;await work();} });
    },
    close(release: () => Promise<void>): Promise<void> {
      if (!alive) return Promise.resolve();
      alive = false;
      // A StrictMode probe can close before its queued work starts. It never
      // acquired the engine; releasing here could stop the real mount's RTC.
      return enqueue(async()=>{if(started)await release();});
    },
  };
}
