import type {LiveItem, LiveSources} from '../../lib/ipc';
import type {PresentationPackage} from './schema';

export interface SourceRecovery {
  sourceId: string;
  slots: PresentationPackage['set']['slots'];
  candidates: LiveItem[];
  suggested?: LiveItem;
}

export function unavailableSetSource(message: string): string | undefined {
  return /^(?:Error: )?Room source ([A-Za-z0-9_-]+) is unavailable for Set output$/.exec(message)?.[1];
}

/** A suggestion is never an assignment. Multiple captures require an explicit choice. */
export function sourceRecoveries(slots: PresentationPackage['set']['slots'], bindings: Record<string,string>, sources: LiveSources): SourceRecovery[] {
  // An absent inventory is not evidence that sources have been removed.
  if (!sources.items) return [];
  const candidates = sources.items.filter(item => item.kind !== 'mic');
  const available = new Set(candidates.map(item => item.id));
  const missing = new Map<string, SourceRecovery>();
  for (const slot of slots) {
    const id = bindings[slot.id];
    if (!id || available.has(id)) continue;
    let recovery = missing.get(id);
    if (!recovery) {
      const kind = /^(screen|camera)(?:-|$)/.exec(id)?.[1];
      const matches = kind ? candidates.filter(item => item.kind === kind) : [];
      recovery = {sourceId:id,slots:[],candidates,suggested:matches.length === 1 ? matches[0] : undefined};
      missing.set(id,recovery);
    }
    recovery.slots.push(slot);
  }
  return [...missing.values()];
}
