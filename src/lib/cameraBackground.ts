import type { FilterOp, FilterState } from './filters';
import type { LiveSources } from './ipc';

export type CameraBackground = 'framed' | 'cutout' | 'soft';
export interface CameraBackgroundControls {
  read(slot: string, source: string): Promise<CameraBackground>;
  set(slot: string, source: string, mode: 'framed' | 'cutout'): Promise<CameraBackground>;
  subscribe(listener: (source: string) => void): () => void;
}
export interface CameraBackgroundContext {
  room: string | null;
  owner: { run(work: () => Promise<void>): Promise<void> } | null;
  set: object;
  enabled: boolean;
  bindings: Record<string, string>;
  sources: LiveSources;
}
const kind = 'producer_person_mask';
function mask(chain: FilterState[]) {
  const matches = chain.filter(filter => filter.kind === kind);
  if (matches.length > 1) throw Error('This camera has multiple Cutout filters. Use Filters to choose one first.');
  return matches[0];
}
function background(chain: FilterState[]): CameraBackground {
  const filter = mask(chain);
  if (filter?.error) throw Error(filter.error);
  if (!filter?.enabled || filter.settings.mode === 'off' || !filter) return 'framed';
  if (filter.settings.mode === 'cut') return 'cutout';
  if (filter.settings.mode === 'soft') return 'soft';
  throw Error('The camera did not confirm its background mode.');
}

/** A local host control over an already-owned camera, never an imported
 * hardware command. One room transaction includes mutation and persistence. */
export function cameraBackgroundControls(options: {
  current(): CameraBackgroundContext;
  filters(source: string, op: FilterOp): Promise<FilterState[]>;
  persist(source: string, chain: FilterState[]): Promise<void>;
}): CameraBackgroundControls & { changed(source: string): void } {
  const listeners = new Set<(source: string) => void>();
  const request = (slot: string, source: string, mode?: 'framed' | 'cutout') => {
    const initial = { ...options.current() };
    const device = initial.sources.items?.find(item => item.id === source)?.device;
    const ownsRoom = () => {
      const now = options.current();
      return !!initial.owner && now.owner === initial.owner && now.room === initial.room;
    };
    const assertCurrent = () => {
      const now = options.current(), camera = now.sources.items?.find(item => item.id === source);
      if (!ownsRoom() || !now.enabled || now.set !== initial.set || now.bindings[slot] !== source ||
          camera?.kind !== 'camera' || camera.device !== device)
        throw Error('The camera assignment or room changed. Try again with the current camera.');
    };
    try { assertCurrent(); } catch (error) { return Promise.reject(error); }
    let result: CameraBackground | undefined;
    return initial.owner!.run(async () => {
      assertCurrent();
      let chain = await options.filters(source, { op: 'list' });
      assertCurrent();
      let saved = false;
      const mutate = async (op: FilterOp) => {
        assertCurrent();
        chain = await options.filters(source, op);
        // Persist the exact changed source even if its slot was rebound while
        // native work ran. A successor room must never receive this receipt.
        if (!ownsRoom()) throw Error('The room closed before the camera change was saved.');
        await options.persist(source, chain);
        saved = true;
        assertCurrent();
      };
      let filter = mask(chain);
      if (mode === 'cutout' && !filter) {
        const names = new Set(chain.map(item => item.name));
        let name = 'Cutout', suffix = 2;
        while (names.has(name)) name = `Cutout ${suffix++}`;
        await mutate({ op: 'add', kind, name });
        filter = mask(chain);
        if (!filter) throw Error('The camera could not add Cutout.');
      }
      if (mode && filter) {
        const nativeMode = mode === 'cutout' ? 'cut' : 'off';
        if (filter.settings.mode !== nativeMode) await mutate({ op: 'update', name: filter.name, settings: { mode: nativeMode } });
        if (mode === 'cutout' && !mask(chain)?.enabled) await mutate({ op: 'enable', name: filter.name, on: true });
      }
      // A prior native receipt may have succeeded while its save failed.
      // Retrying the same selected mode must still retry persistence.
      if (mode && filter && !saved) {
        await options.persist(source, chain);
        assertCurrent();
      }
      result = background(chain);
      if (mode && result !== mode) throw Error('The camera did not confirm the requested background mode.');
    }).then(() => {
      assertCurrent();
      if (!result) throw Error('The room is closed. Reopen it to change the camera background.');
      return result;
    });
  };
  return {
    read: (slot, source) => request(slot, source), set: request,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    changed: source => { for (const listener of listeners) listener(source); },
  };
}
