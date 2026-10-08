import type { PresentationPackage } from './schema';

export function timeLabel(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Follow declared transitions, rather than treating declaration order as a schedule.
 * A repeating show has no finite total; untimed phases are operator controlled. */
export function rundown(doc: PresentationPackage) {
  const phases: NonNullable<PresentationPackage['show']>['phases'] = [];
  const seen = new Set<string>();
  let id: string | undefined = doc.show?.initialPhase;
  while (id && !seen.has(id)) {
    const phase = doc.show?.phases.find(p => p.id === id);
    if (!phase) break;
    seen.add(id); phases.push(phase); id = phase.next;
  }
  return { phases, repeats: !!id && seen.has(id),
    timedMs: phases.reduce((total, phase) => total + (phase.collectMs ?? 0), 0),
    manual: phases.some(phase => !phase.collectMs) };
}
