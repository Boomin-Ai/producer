// One roster request chain at a time across effect replacements. Scheduling
// belongs to the view: ordinary busy ticks are skipped, never replayed.
export function createRosterPollCoordinator() {
  let busy = false;
  let current: (() => void) | null = null;
  return {
    generation(work: () => Promise<void>, onError: (error: unknown) => void) {
      let active = true;
      const tick = () => {
        if (!active || busy) return;
        busy = true;
        void (async () => {
          try {
            await work();
          } catch (error) {
            onError(error);
          } finally {
            busy = false;
            // A replaced effect's first tick may have found the old chain
            // busy. Continue only the latest live generation after it drains,
            // including when room access has already been answered.
            if (!active) current?.();
          }
        })().catch(() => {
          // Work errors go to onError; its own failure must not produce an
          // unhandled rejection from a fire-and-forget lifecycle handoff.
        });
      };
      current = tick;
      return {
        tick,
        close() {
          active = false;
          if (current === tick) current = null;
        },
      };
    },
  };
}
