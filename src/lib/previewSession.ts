export type PreviewBounds = { x: number; y: number; width: number; height: number };
type Driver = { attach: (r: PreviewBounds) => Promise<boolean>; move: (r: PreviewBounds) => Promise<unknown>; detach: () => Promise<unknown> };
// Native preview is one per window. Serialize teardown before a new mount can
// attach, including when the previous attach has not resolved yet.
let tail: Promise<unknown> = Promise.resolve();
const activeSessions = new Set<{ closeWith: (ack: Promise<void>) => void }>();
// Separate native close receipts from unrelated queued RTC/room work. A room
// that never attached a preview must not keep its exit cover up for that work.
let lastClose: Promise<void> = Promise.resolve();
export function afterPreviewWork<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work); tail = result.catch(() => {}); return result;
}
/** Retire only sessions belonging to the outgoing room. The single native
 * operation acknowledges BOTH views' conceal/removal before this resolves. */
export function closePreviewSessions(detachAll: () => Promise<unknown>, force = false): Promise<void> {
  const outgoing = [...activeSessions];
  if (!outgoing.length && !force) return lastClose;
  const ack = afterPreviewWork(async () => { await detachAll(); });
  lastClose = ack;
  // Promise work cannot begin before these synchronous invalidations, so a
  // delayed old attach/move cannot publish itself after navigation starts.
  outgoing.forEach(session => session.closeWith(ack));
  return ack;
}
export type PreviewExitState = 'idle' | 'closing' | 'error';
/** A late close receipt belongs to its original navigation, never a reopened
 * room or a newer close. Native ordering remains owned by afterPreviewWork. */
export function previewExit(detachAll: () => Promise<unknown>, changed: (state: PreviewExitState) => void) {
  let generation = 0;
  const begin = (force = false) => {
    const ticket = ++generation;
    changed('closing');
    const ack = closePreviewSessions(detachAll, force);
    void ack.then(
      () => { if (ticket === generation) changed('idle'); },
      () => { if (ticket === generation) changed('error'); },
    );
    return ack;
  };
  return {
    close(navigate: () => void) { const ack = begin(); navigate(); return ack; },
    retry: () => begin(true),
    cancel() { ++generation; changed('idle'); },
    dispose() { ++generation; },
  };
}
export function previewSession(driver: Driver, stage: (transparent: boolean) => void) {
  let alive = true, attached = false, busy = false, retryAt = 0;
  let closeAck:Promise<void>|undefined;
  const stop=()=>{if(!alive)return;alive=false;activeSessions.delete(owner);stage(false);};
  const owner={closeWith(ack:Promise<void>){if(closeAck)return;closeAck=ack;stop();}};
  activeSessions.add(owner);
  let last: PreviewBounds | undefined;
  const same = (r: PreviewBounds) => last && Math.abs(last.x-r.x)<.5 && Math.abs(last.y-r.y)<.5 && Math.abs(last.width-r.width)<.5 && Math.abs(last.height-r.height)<.5;
  return {
    async sync(measure: () => PreviewBounds | undefined, refresh = false) {
      if (!alive || busy || Date.now() < retryAt) return;
      const r = measure();
      if (!r || !Object.values(r).every(Number.isFinite) || r.width < 10 || r.height < 10 || (attached && same(r) && !refresh)) return;
      busy = true;
      try {
        await afterPreviewWork(async () => {
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
          await afterPreviewWork(() => driver.detach()).catch(() => {});
        }
      } finally { busy = false; }
    },
    close() {
      if(!closeAck){
        closeAck=afterPreviewWork(async()=>{await driver.detach();});
        // Local portrait/landscape cleanup is narrower than the authoritative
        // window-wide close. Preserve any unresolved or rejected sibling
        // receipt until a successful BOTH-view operation supersedes it.
        lastClose=Promise.all([lastClose,closeAck]).then(()=>{});
        void lastClose.catch(()=>{});
        stop();
      }
      // Component effect cleanup remains best-effort. Window exits retain
      // the original receipt above so a failed conceal keeps their cover.
      return closeAck.catch(() => {});
    },
  };
}

// Both native displays sit under the same webview. Detaching one must not
// make the remaining display's transparent viewing area opaque.
const transparentDisplays=new Set<string>();
export function setPreviewTransparency(id:string,on:boolean){
 if(on)transparentDisplays.add(id);else transparentDisplays.delete(id);
 document.documentElement.dataset.stage=transparentDisplays.size?'transparent':'opaque';
}
