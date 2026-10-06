import signalDesk from './fixtures/signal-desk.json';
import afterHours from './fixtures/after-hours.json';
import { parsePackage, type PresentationPackage } from './schema';

export const AFTER_HOURS = parsePackage(afterHours);
const head: PresentationPackage = structuredClone(AFTER_HOURS);
head.id = 'head-to-head'; head.name = 'Head to Head';
const set = head.set;
set.values.topic.default = 'Who takes the round?';
set.values.hostName.default = 'Contestant A'; set.values.guestName.default = 'Contestant B';
for (const layout of set.layouts) {
  const title = layout.root.children?.find(n => n.id.endsWith('title'));
  if (title && 'text' in title) title.text = 'HEAD TO HEAD';
  layout.root.children!.push({ id: `${layout.id}-winner`, type: 'text',
    text: { op: 'if', args: [{ op: 'eq', args: [{ get: 'show.result' }, 'draw'] }, 'DRAW', { op: 'concat', args: ['WINNER · ', { get: 'show.winner' }] }] }, when: { get: 'show.revealed' },
    styles: { position: 'absolute', left: '35%', top: '11%', fontSize: '30px', color: '#ffc58a', fontWeight: 700 } });
  layout.root.children!.unshift({ id: `${layout.id}-heat`, type: 'box', children: [],
    styles: { position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 40%, #f0883244, #f0601022)', opacity: { get: 'show.heat' } } });
}
head.show = { id: 'head-to-head', version: '0.1.0', initialPhase: 'intro',
  phases: [
    { id: 'intro', label: 'Introduction', layoutId: 'conversation', next: 'round' },
    { id: 'round', label: 'Audience vote', layoutId: 'conversation', collectMs: 60_000, next: 'outro' },
    { id: 'outro', label: 'Winner reveal', layoutId: 'conversation' },
  ], choices: [{ id: 'a', label: 'Contestant A' }, { id: 'b', label: 'Contestant B' }],
};
set.controls = [
  ...set.controls,
  { id: 'start-show', type: 'button', label: 'Start show', action: { type: 'show.start' } },
  { id: 'next-phase', type: 'button', label: 'Next', action: { type: 'show.next' } },
  { id: 'reveal-winner', type: 'button', label: 'Reveal winner', action: { type: 'show.reveal' } },
];
export const HEAD_TO_HEAD = parsePackage(head);

export const SIGNAL_DESK = parsePackage(signalDesk);
