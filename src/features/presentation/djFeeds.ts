import { useEffect } from 'react';
import { type DJStatus } from '../../lib/dj';
import {observeDjStatus,djSnapshot} from '../../lib/djObserver';
import type { RehearsalSession } from './rehearsal';
import type { PresentationPackage, Scalar } from './schema';

type FeedDefinitions = PresentationPackage['set']['feeds'];
const textKeys = ['dj_phase', 'dj_now', 'dj_next', 'dj_next_kind', 'dj_deck', 'dj_next_deck', 'dj_fade',
  'dj_elapsed', 'dj_duration', 'dj_remaining',
  'dj_queue_1', 'dj_queue_2', 'dj_queue_3', 'dj_queue_4', 'dj_queue_5', 'dj_queue_6'] as const;

export function hasDjSetFeeds(definitions: FeedDefinitions): boolean {
  return textKeys.some(key => definitions[key]?.type === 'text')
    || definitions.dj_blend?.type === 'number' || definitions.dj_progress?.type === 'number';
}

function displayTitle(title: string, maxLength: number): string {
  const clean = title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Metadata should be a title. If it contains an absolute path, show its filename only.
  const name = /^(?:file:|[a-z]:[\\/]|[\\/])/i.test(clean) ? clean.replace(/^.*[\\/]/, '') : clean;
  if (name.length <= maxLength) return name;
  return name.slice(0, maxLength - 1).replace(/[\ud800-\udbff]$/, '') + '…';
}

/** Project public deck timing and the bounded native tracklist into the Set. */
export function djSetFeeds(status: DJStatus, definitions: FeedDefinitions): Record<string, Scalar> {
  const program = status.program;
  if (!program) return {};
  const deck = (track: typeof program.current) => track ? (track.deck === 0 ? 'A' : 'B') : '';
  const fade = Number.isFinite(status.fade) && status.fade >= 0
    ? (status.fade === 0 ? 'Cut' : `${Number(status.fade.toFixed(1))} s`)
    : '';
  const current = program.current ? status.decks[program.current.deck] : undefined;
  const duration = Math.max(0, Number.isFinite(current?.duration_ms) ? current!.duration_ms : 0);
  const elapsed = Math.min(duration, Math.max(0, Number.isFinite(current?.position_ms) ? current!.position_ms : 0));
  const time = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const queueSlots = Math.max(0, ...Array.from({length: 6}, (_, index) => definitions['dj_queue_' + (index + 1)]?.type === 'text' ? index + 1 : 0));
  const queue = status.queue_titles ?? [];
  const currentIndex = queue.findIndex(title => title === program.current?.title);
  const queueStart = Math.max(0, currentIndex - queueSlots + 1);
  const visibleQueue = queue.slice(queueStart, queueStart + queueSlots);
  const labels = {
    dj_phase: program.phase,
    dj_now: program.current?.title ?? '',
    dj_next: program.next?.title ?? '',
    dj_next_kind: program.next_kind,
    dj_deck: deck(program.current),
    dj_next_deck: deck(program.next),
    dj_fade: fade,
    dj_elapsed: time(elapsed), dj_duration: time(duration), dj_remaining: time(duration - elapsed),
    dj_queue_1: visibleQueue[0] ?? '', dj_queue_2: visibleQueue[1] ?? '',
    dj_queue_3: visibleQueue[2] ?? '', dj_queue_4: visibleQueue[3] ?? '',
    dj_queue_5: visibleQueue[4] ?? '', dj_queue_6: visibleQueue[5] ?? '',
  };
  const feeds: Record<string, Scalar> = {};
  for (const key of textKeys) {
    const definition = definitions[key];
    if (definition?.type !== 'text') continue;
    const label = labels[key];
    if (key === 'dj_now' || key === 'dj_next' || key.startsWith('dj_queue_')) feeds[key] = displayTitle(label, definition.maxLength);
    else if (label.length <= definition.maxLength) feeds[key] = label;
  }
  const blend = Math.min(100, Math.max(0, Math.round(status.crossfader * 10) * 10));
  const blendDefinition = definitions.dj_blend;
  if (blendDefinition?.type === 'number' && Number.isFinite(status.crossfader) && blend >= blendDefinition.min && blend <= blendDefinition.max) {
    feeds.dj_blend = blend;
  }
  const progress = duration > 0 ? Math.round(elapsed / duration * 100) : 0;
  const progressDefinition = definitions.dj_progress;
  if (progressDefinition?.type === 'number' && progress >= progressDefinition.min && progress <= progressDefinition.max) feeds.dj_progress = progress;
  return feeds;
}

/** The host room owns observation so it outlives the DJ panel and stops with
 * the room, Set, or host privileges. Older engines use the authored defaults. */
export function useDjSetFeeds(session: RehearsalSession, roomId: string | null, enabled: boolean): void {
  const requested = hasDjSetFeeds(session.package.set.feeds);
  useEffect(() => {
    if (!enabled || !requested) return;
    const update=()=>{
      const {status,error}=djSnapshot();
      if(error){session.setRoomFeeds({});return;}
      if(!status)return;
      if(status.audio)window.dispatchEvent(new CustomEvent('producer:dj-audio',{detail:status.audio}));
      session.setRoomFeeds(djSetFeeds(status,session.package.set.feeds));
    };
    const stop=observeDjStatus(update);update();
    return()=>{stop();session.setRoomFeeds({});};
  }, [session, roomId, enabled, requested]);
}
