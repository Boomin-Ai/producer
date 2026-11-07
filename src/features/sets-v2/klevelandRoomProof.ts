import {dj, queueTrack} from '../../lib/dj';
import {invoke} from '../../lib/nativeInvoke';
import {showDjVinylReview} from './djFeedRoomProof';
import {preparationDebug} from './preparedScenes';
import type {PresentationPackage} from '../presentation/schema';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(label: string, read: () => Promise<T | null>, timeout = 45000): Promise<T> {
  const end = performance.now() + timeout;
  let error: unknown;
  while (performance.now() < end) {
    try { const result = await read(); if (result !== null) return result; } catch (cause) { error = cause; }
    await delay(150);
  }
  throw Error(label + ' timed out ' + String(error ?? ''));
}
type RenderStatus = {renderedRevision: number; renderSerial: number; transitioning: boolean; scene3dContexts: number};
const readStatus = async (outputId: string) => {
  const {generation} = await invoke<{generation: number}>('live_set_status');
  return invoke<RenderStatus>('live_set_v2', {request: {op: 'status', generation, outputId}});
};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(node => !node.disabled && (node.getAttribute('aria-label') === label || node.textContent?.trim() === label));
async function portrait() {
  const data = await invoke<string>('live_portrait_frame');
  if (!data) throw Error('Portrait not captured yet');
  const image = new Image();
  image.src = data.startsWith('data:') ? data : 'data:image/jpeg;base64,' + data;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1920;
  const context = canvas.getContext('2d', {willReadFrequently: true})!;
  context.drawImage(image, 0, 0, 1080, 1920);
  return context;
}
function bright(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const pixels = context.getImageData(Math.round(x), y, w, h).data;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 180 && pixels[i + 1] > 172 && pixels[i + 2] > 185) count++;
  return count;
}

export async function klevelandRoomProof(doc: PresentationPackage) {
  const checks: Record<string, unknown>[] = [];
  const takes: number[] = [];
  const timing = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail.stage === 'take-request') takes.push(detail.transitionMs);
  };
  window.addEventListener('producer:set-render-timing', timing);
  const report = (value: Record<string, unknown>) => invoke('live_set_v2_report', {result: {kind: 'kleveland-live-mix', checks, ...value}});
  let restored: Awaited<ReturnType<typeof dj.control>> | undefined;
  const layout = doc.set.layouts.find(layout => layout.height > layout.width)!;
  const player = layout.root.children!.find(node => node.id === 'player-wave')!;
  const rail = player.children!.find(node => node.id === 'progress-rail')!;
  const markerX = (percentage: number) => Number(player.styles!.left) + Number(rail.styles!.left) + Number(rail.styles!.width) * percentage / 100;
  const markerY = Number(player.styles!.top) + Number(rail.styles!.top) - 6;
  try {
    await report({stage: 'preparing native 3D'});
    await showDjVinylReview(85000);
    button('Output settings')?.click();
    await until('Both outputs', async () => {
      const option = button('Both');
      if (!option) return null;
      if (option.getAttribute('aria-pressed') !== 'true') { option.click(); return null; }
      return true;
    });
    button('Close output settings')?.click();
    const rendered = await until('Native 3D on both outputs', async () => {
      const states = await Promise.all(['program', 'portrait'].map(readStatus));
      return states.every(s => s.renderedRevision > 0 && !s.transitioning && s.scene3dContexts > 0) ? states : null;
    });
    await report({stage: 'both outputs ready'});
    const frame = await until('Light sign pixels', async () => {
      const context = await portrait();
      return bright(context, 48, 164, 984, 230) > 500 ? context : null;
    });
    checks.push({check: '3D sign on both outputs', contexts: rendered.map(s => s.scene3dContexts), signPixels: bright(frame, 48, 164, 984, 230)});
    const library = await dj.library();
    if (library.tracks.length < 6) throw Error('Six imported tracks expected');
    await dj.control({kind: 'queue', tracks: library.tracks.map(queueTrack)});
    const queue = await until('Six public queue titles', async () => {
      const status = await dj.control({kind: 'status'});
      return status.queue_titles?.length === 6 ? status.queue_titles : null;
    });
    checks.push({check: 'six imported tracks', queue});
    restored = await dj.control({kind: 'status'});
    const track = library.tracks.find(t => /SWEAR TO GOD/.test(t.title)) ?? library.tracks[0];
    await dj.control({kind: 'mix', volume: 0, crossfader: 0, fade: 2, repeat: false, shuffle: false, duck: false});
    await dj.control({kind: 'load', deck: 0, track: queueTrack(track)});
    await dj.control({kind: 'play', deck: 0});
    await until('Native decoder advances', async () => {
      const status = await dj.control({kind: 'status'});
      return status.decks[0].state === 1 && status.decks[0].duration_ms > 0 && status.decks[0].position_ms > 500 ? status : null;
    });
    const beforePause = (await readStatus('portrait')).renderedRevision;
    await dj.control({kind: 'pause', deck: 0});
    await until('Pause shown', async () => {
      const state = await readStatus('portrait');
      return state.renderedRevision > beforePause && !state.transitioning ? true : null;
    });
    const duration = (await dj.control({kind: 'status'})).decks[0].duration_ms;
    for (const percentage of [25, 75]) {
      const playbackTakes = takes.length;
      await dj.control({kind: 'play', deck: 0});
      await until('Playback before seek', async () => (await dj.control({kind: 'status'})).decks[0].state === 1 ? true : null);
      await until('Continuous clock update ready', async () => {
        const status = await readStatus('portrait');
        return takes.slice(playbackTakes).includes(0) && !status.transitioning ? true : null;
      });
      const firstTake = takes.length;
      const before = (await readStatus('portrait')).renderedRevision;
      await dj.control({kind: 'seek', deck: 0, ms: Math.round(duration * percentage / 100)});
      const position = await until('Native seek', async () => {
        const status = await dj.control({kind: 'status'});
        return Math.abs(status.decks[0].position_ms / duration * 100 - percentage) < 1 ? status.decks[0].position_ms : null;
      });
      await until('Seek rendered on portrait', async () => {
        const status = await readStatus('portrait');
        return status.renderedRevision > before && !status.transitioning ? true : null;
      });
      if (takes.slice(firstTake).some(duration => duration !== 0)) throw Error('Timeline updates triggered a content dissolve');
      await dj.control({kind: 'pause', deck: 0});
      await delay(800);
      const marker = await until('Native timeline marker', async () => {
        const context = await portrait();
        const count = bright(context, markerX(percentage) - 3, markerY, 15, 16);
        return count >= 5 ? count : null;
      }, 4000).catch(() => null);
      checks.push({check: 'native playhead seek', percentage, positionMs: position, markerPixels: marker, revision: before,
        pixelConfirmed: marker !== null});
      await report({stage: 'seek ' + percentage});
    }
    const firstHandoff = takes.length;
    const next = library.tracks.find(item => item.id !== track.id)!;
    const beforeHandoff = (await readStatus('portrait')).renderedRevision;
    await dj.control({kind: 'load', deck: 1, track: queueTrack(next)});
    await dj.control({kind: 'play', deck: 1});
    await until('Next track dissolve completed', async () => {
      const status = await dj.control({kind: 'status'});
      const native = await readStatus('portrait');
      return status.program?.current?.title === next.title && native.renderedRevision > beforeHandoff && !native.transitioning
        && takes.slice(firstHandoff).includes(240) ? true : null;
    });
    checks.push({check: 'track changes dissolve, clock updates cut', handoffDurationMs: 240});
    const final = await Promise.all(['program', 'portrait'].map(readStatus));
    if (final.some((state, index) => state.scene3dContexts !== rendered[index].scene3dContexts)) throw Error('Timeline updates recreated 3D contexts');
    await report({ok: checks.every(check => check.pixelConfirmed !== false), handoffVerified: true, final});
  } catch (error) {
    await report({ok: false, error: String(error), preparation: preparationDebug(),
      alerts: [...document.querySelectorAll('.set-error, [role="alert"]')].map(node => node.textContent)}).catch(() => {});
  } finally {
    window.removeEventListener('producer:set-render-timing', timing);
    if (restored) {
      await dj.control({kind: 'clear'}).catch(() => {});
      const {volume, crossfader, fade, repeat, shuffle, duck} = restored;
      await dj.control({kind: 'mix', volume, crossfader, fade, repeat, shuffle, duck}).catch(() => {});
    }
  }
}
