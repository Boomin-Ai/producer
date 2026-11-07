import { dj, type DJProgram } from '../../lib/dj';
import { invoke } from '../../lib/nativeInvoke';
import { ipc, listenLiveEvents } from '../../lib/ipc';
import type { PresentationPackage } from '../presentation/schema';
import { preparationDebug } from './preparedScenes';

type RenderStatus = { renderedRevision: number; renderSerial: number; transitioning: boolean };
type ExpectedProgram = { phase: 'idle' } | {
  phase: Exclude<DJProgram['phase'], 'idle'>;
  current: string;
  next?: string;
  nextKind: DJProgram['next_kind'];
};

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until<T>(label: string, read: () => T | Promise<T>, timeout = 20_000): Promise<NonNullable<T>> {
  const end = performance.now() + timeout;
  let error: unknown;
  while (performance.now() < end) {
    try {
      const value = await read();
      if (value) return value as NonNullable<T>;
    } catch (cause) {
      error = cause;
    }
    await delay(100);
  }
  throw Error(label + ' timed out' + (error ? ': ' + String(error) : ''));
}

function button(label: string, root: ParentNode = document) {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find(node =>
    !node.disabled && (node.getAttribute('aria-label') === label || node.textContent?.trim() === label));
}

async function renderStatus(outputId: string) {
  const { generation } = await invoke<{ generation: number }>('live_set_status');
  return invoke<RenderStatus>('live_set_v2', { request: { op: 'status', generation, outputId } });
}

async function showDjSet(timeout = 45000) {
  let tries = 0;
  let retryAfter = 0;
  await until('Set on room output', () => {
    const controls = document.querySelector('.set-controls[data-layouts-ready]');
    if(!controls){
      document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      return false;
    }
    const output = controls?.querySelector<HTMLButtonElement>('.set-output-switch');
    if (output?.dataset.output === 'set') return true;
    if (output?.dataset.output === 'scene' && Number(controls?.getAttribute('data-layouts-ready')) > 0 && tries < 4 && performance.now() >= retryAfter) {
      tries++;
      retryAfter = performance.now() + 1000;
      output.click();
    }
    return false;
  }, timeout);
}

async function chooseOutput(mode: 'Both' | 'Portrait') {
  const picker = await until('Output orientation picker', () => document.querySelector('section:popover-open [aria-label="Room output view"]'));
  const option = await until(mode + ' option', () => button(mode, picker));
  if (option.getAttribute('aria-pressed') !== 'true') option.click();
  await until(mode + ' selected', () => option.getAttribute('aria-pressed') === 'true');
}

type Region = [number, number, number, number];
const vinylCredits: Region = [54, 1649, 430, 32];
const vinylDisc: Region = [80, 806, 238, 238];
const vinylCovers = ['swear-to-god', 'did-it-again', 'somebody', 'groovier'];
const vinylTracks = ["(FREE) FUTURE TYPE BEAT - ''SWEAR TO GOD''", "[FREE] Lil Baby Type Beat 2025 - ''DID IT AGAIN"];

function slice(context: CanvasRenderingContext2D, region: Region) {
  return context.getImageData(...region).data;
}

function vinylSlice(context: CanvasRenderingContext2D, [x, y, w, h]: Region) {
  return slice(context, [Math.round(x * 480 / 1080), Math.round(y * 854 / 1920),
    Math.round(w * 480 / 1080), Math.round(h * 854 / 1920)]);
}

async function portraitPixels(vinyl: boolean) {
  const frame = await invoke<string>('live_portrait_frame');
  if (!frame) throw Error('Portrait has no frame yet');
  const image = new Image();
  image.src = frame.startsWith('data:') ? frame : 'data:image/jpeg;base64,' + frame;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 854;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw Error('Canvas unavailable');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const regions = vinyl ? {
    current: vinylSlice(context, [343, 809, 650, 147]),
    next: vinylSlice(context, [343, 962, 650, 77]),
    transition: vinylSlice(context, [686, 1082, 311, 51]),
  } : {
    current: slice(context, [28, 414, 424, 101]),
    next: slice(context, [28, 525, 424, 82]),
    transition: slice(context, [28, 615, 424, 88]),
  };
  return { width: image.naturalWidth, height: image.naturalHeight, regions, context };
}

export async function showDjVinylReview(timeout = 45000) {
  await showDjSet(timeout);
  await until('Vinyl on landscape output', async () => (await renderStatus('program')).renderedRevision > 0);
  const { volume, program } = await dj.control({ kind: 'status' });
  await invoke('live_set_v2_report', { result: { kind: 'dj-vinyl-manual-review', ok: true, mode: 'landscape', volume, phase: program?.phase } });
}

function changedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 48) changed++;
  }
  return changed;
}

export async function djLandscapeProof(tones: string) {
  const checks: Array<Record<string, unknown>> = [];
  const report = (result: Record<string, unknown>) => invoke('live_set_v2_report', {
    result: { kind: 'dj-landscape-native', checks, ...result },
  });
  let revision = 0;
  let latest = '';
  let thumbnail = 0;
  let sampled = 0;
  const unlisten = await listenLiveEvents(event => {
    if (event.type !== 'guest_thumbs') return;
    const program = event.thumbs.find(thumb => thumb.id === 'program');
    if (program) { latest = program.jpeg; thumbnail++; }
  });
  const sample = async () => {
    const jpeg = await until('New native program thumbnail', () => thumbnail > sampled ? latest : null);
    sampled = thumbnail;
    const image = new Image();
    image.src = jpeg.startsWith('data:') ? jpeg : 'data:image/jpeg;base64,' + jpeg;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 288;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0, 512, 288);
    return { jpeg: image.src, disc: slice(context, [382, 39, 92, 86]), panel: slice(context, [365, 140, 124, 90]) };
  };
  const capture = async (phase: DJProgram['phase'], title?: string) => {
    const { program } = await until(phase + ' DJ state', async () => {
      const result = await dj.control({ kind: 'status' });
      return result.program?.phase === phase && result.program?.current?.title === title ? result : null;
    });
    const status = await until(phase + ' landscape revision', async () => {
      const result = await renderStatus('program');
      return result.renderedRevision > revision && !result.transitioning ? result : null;
    });
    revision = status.renderedRevision;
    // The monitor sends JPEGs asynchronously. Drain the thumbnail from before the take.
    await delay(450);
    sampled = thumbnail;
    const frame = await sample();
    checks.push({ phase, revision, program });
    await report({ stage: phase });
    return frame;
  };
  const a = { id: 'dj-proof-a', title: vinylTracks[0], path: tones + '/a.wav' };
  const b = { id: 'dj-proof-b', title: vinylTracks[1], path: tones + '/b.wav' };
  const { volume, crossfader, fade, repeat, shuffle, duck } = await dj.control({ kind: 'status' });
  try {
    await report({ stage: 'warming landscape' });
    await showDjSet();
    await ipc.liveSetProgramThumb(true);
    const idle = await capture('idle');
    await dj.control({ kind: 'mix', volume: 0, crossfader: 0, fade: 6, repeat: false, shuffle: false, duck: false });
    await dj.control({ kind: 'queue', tracks: [a, b] });
    await dj.control({ kind: 'load', deck: 0, track: a });
    const ready = await capture('ready', a.title);
    if (changedPixels(idle.panel, ready.panel) < 50) throw Error('Landscape title and queue did not change on cue');
    await dj.control({ kind: 'play', deck: 0 });
    const playing = await capture('playing', a.title);
    await delay(420);
    const spun = await sample();
    const spinPixels = changedPixels(playing.disc, spun.disc);
    if (spinPixels < 120) throw Error('Landscape record did not visibly spin');
    await dj.control({ kind: 'next', previous: false });
    const crossfade = await capture('crossfade', a.title);
    const promoted = await capture('playing', b.title);
    if (changedPixels(playing.panel, promoted.panel) < 50) throw Error('Landscape did not promote the next title');
    if (changedPixels(crossfade.panel, promoted.panel) < 50) throw Error('Landscape still shows the crossfade');
    await report({ ok: true, spinPixels, frame: promoted.jpeg });
  } catch (error) {
    const alerts = [...document.querySelectorAll('.set-error, [role="alert"]')].map(node => node.textContent);
    await report({ ok: false, error: String(error), alerts, status: await renderStatus('program').catch(String) });
  } finally {
    unlisten();
    await ipc.liveSetProgramThumb(false).catch(() => {});
    await dj.control({ kind: 'clear' }).catch(() => {});
    await dj.control({ kind: 'mix', volume: volume > 0 ? volume : .65, crossfader, fade, repeat, shuffle, duck }).catch(() => {});
  }
}

const samples = [[.28,.28],[.5,.28],[.72,.28],[.28,.5],[.72,.5],[.28,.72],[.5,.72],[.72,.72]];
function colorSignature(context: CanvasRenderingContext2D, [x, y, w, h]: Region) {
  return samples.flatMap(([u, v]) => {
    const patch = context.getImageData(Math.round(x + u * w) - 3, Math.round(y + v * h) - 3, 7, 7).data;
    return [0, 1, 2].map(channel => {
      let total = 0;
      for (let i = channel; i < patch.length; i += 4) total += patch[i];
      return total / 49;
    });
  });
}

async function coverSignatures(pkg: PresentationPackage) {
  return Promise.all(vinylCovers.map(async id => {
    const source = pkg.set.assets?.[id]?.data;
    if (!source) throw Error('Missing embedded cover ' + id);
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 100;
    const context = canvas.getContext('2d')!;
    const size = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 100, 100);
    return colorSignature(context, [0, 0, 100, 100]);
  }));
}

function assertCover(context: CanvasRenderingContext2D, [x, y, w, h]: Region, references: number[][], expected: number) {
  const signature = colorSignature(context, [x * 480 / 1080, y * 854 / 1920, w * 480 / 1080, h * 854 / 1920]);
  const distances = references.map(reference => Math.round(reference.reduce((sum, value, i) => sum + Math.abs(value - signature[i]), 0) / reference.length));
  if (distances[expected] > 25 || distances.some((distance, index) => index !== expected && distance <= distances[expected])) {
    throw Error(`Native cover ${vinylCovers[expected]} did not match its embedded artwork: ${distances.join(', ')}`);
  }
  return distances;
}

export async function djFeedRoomProof(tones: string, vinyl?: PresentationPackage) {
  const report = (result: Record<string, unknown>) => invoke('live_set_v2_report', {
    result: { kind: vinyl ? 'dj-vinyl-native-portrait' : 'dj-feed-native-portrait', ...result },
  });
  const checks: Array<Record<string, unknown>> = [];
  let previous: Awaited<ReturnType<typeof portraitPixels>> | undefined;
  let previousRevision = 0;
  let portraitFrame: string | undefined;
  let lastPortraitStatus: RenderStatus | undefined;
  const state = () => dj.control({ kind: 'status' });
  const a = { id: 'dj-test-a', title: vinyl ? vinylTracks[0] : 'Neon Circuit', path: tones + '/a.wav' };
  const b = { id: 'dj-test-b', title: vinyl ? vinylTracks[1] : 'Late Checkout', path: tones + '/b.wav' };
  const capture = async (label: string, output: RenderStatus, expected: ExpectedProgram, expectedRegions: string[] = []) => {
    const frame = await until(label + ' native portrait frame', async () => {
      const pixels = await portraitPixels(!!vinyl);
      if (!previous || !expectedRegions.length) return pixels;
      return expectedRegions.every(key => {
        const region = key as keyof typeof pixels.regions;
        return changedPixels(previous!.regions[region], pixels.regions[region]) >= 30;
      }) ? pixels : null;
    }, 8_000);
    const program = (await state()).program;
    if (program?.phase !== expected.phase) throw Error(`${label}: expected ${expected.phase}, got ${program?.phase}`);
    if (expected.phase !== 'idle' && (program.current?.title !== expected.current || program.next?.title !== expected.next
      || program.next_kind !== expected.nextKind)) throw Error(`${label}: wrong current or next track`);
    checks.push({ label, program: expected.phase === 'idle' ? expected : program, renderedRevision: output.renderedRevision, renderSerial: output.renderSerial,
      portrait: [frame.width, frame.height], changed: previous && Object.fromEntries(
        Object.entries(frame.regions).map(([key, value]) => [key, changedPixels(previous!.regions[key as keyof typeof frame.regions], value)])) });
    previous = frame;
    previousRevision = output.renderedRevision;
    return frame;
  };
  try {
    await report({ stage: 'opening isolated DJ room', checks });
    const covers = vinyl ? await coverSignatures(vinyl) : null;
    await showDjSet();
    await until('Program frame', async () => (await renderStatus('program')).renderedRevision > 0);
    await report({ stage: 'Set on program output', checks });
    (await until('Output settings', () => button('Output settings'))).click();
    await chooseOutput('Both');
    const waitForPortrait = (label: string) => until(label, async () => {
      const result = await renderStatus('portrait');
      lastPortraitStatus = result;
      return result.renderedRevision > previousRevision && !result.transitioning ? result : null;
    });
    const idle = await capture('Idle', await waitForPortrait('Initial portrait'), { phase: 'idle' });
    if (covers) {
      const credit = vinylSlice(idle.context, vinylCredits);
      let creditPixels = 0;
      for (let i = 0; i < credit.length; i += 4) {
        if (credit[i] > 105 && credit[i + 1] > 95 && credit[i + 2] > 120) creditPixels++;
      }
      if (creditPixels < 30) throw Error('Producer.dev credit did not render');
      const lineup = vinylCovers.map((id, index) => ({ id, distances: assertCover(idle.context,
        [60 + index * 246, 1222, 221, 221], covers, index) }));
      checks.push({ label: 'Credit and four sleeves on native output', creditPixels, lineup });
    }
    button('Close output settings')?.click();

    await dj.control({ kind: 'mix', volume: 0, crossfader: 0, fade: 8, repeat: false, shuffle: false, duck: false });
    await dj.control({ kind: 'queue', tracks: [a, b] });
    await dj.control({ kind: 'load', deck: 0, track: a });
    await until('Ready track', async () => (await state()).program?.phase === 'ready');
    await capture('Ready A, queue B', await waitForPortrait('Portrait showed queued B'),
      { phase: 'ready', current: a.title, next: b.title, nextKind: 'queue' }, ['current', 'next']);
    if (covers) {
      await delay(650);
      const ready = await portraitPixels(true);
      const distances = assertCover(ready.context, vinylDisc, covers, 0);
      await delay(500);
      const stationary = await portraitPixels(true);
      const stationaryPixels = changedPixels(vinylSlice(ready.context, vinylDisc), vinylSlice(stationary.context, vinylDisc));
      if (stationaryPixels > 30) throw Error(`Cued disc changed across settled frames (${stationaryPixels} pixels)`);
      checks.push({ label: 'Deck A cover holds while cued', distances, stationaryPixels });
    }
    await report({ stage: 'queue rendered', checks });
    await dj.control({ kind: 'play', deck: 0 });
    await until('Decoder playing A', async () => (await state()).program?.phase === 'playing');
    await capture('Playing A', await waitForPortrait('Portrait showed playing A'),
      { phase: 'playing', current: a.title, next: b.title, nextKind: 'queue' }, ['current']);
    if (covers) {
      await delay(650);
      const playing = await portraitPixels(true);
      const spinPixels = await until('Native record spin', async () => {
        const frame = await portraitPixels(true);
        const changed = changedPixels(vinylSlice(playing.context, vinylDisc), vinylSlice(frame.context, vinylDisc));
        return changed > 120 ? changed : null;
      }, 4_000);
      checks.push({ label: 'Deck A record spins during playback', spinPixels });
    }
    await report({ stage: 'track A rendered', checks });
    await dj.control({ kind: 'next', previous: false });
    await until('Native crossfade started', async () => (await state()).program?.phase === 'crossfade');
    const fade = await capture('Crossfade A to B', await waitForPortrait('Portrait showed active crossfade'),
      { phase: 'crossfade', current: a.title, next: b.title, nextKind: 'incoming' }, ['transition']);
    if (covers) {
      const thumbnail = document.createElement('canvas');
      thumbnail.width = 360;
      thumbnail.height = 640;
      thumbnail.getContext('2d')!.drawImage(fade.context.canvas, 0, 0, 360, 640);
      portraitFrame = thumbnail.toDataURL('image/jpeg', 0.72);
    }
    await report({ stage: 'crossfade rendered', checks });
    await until('B promoted to current', async () => {
      const program = (await state()).program;
      return program?.phase === 'playing' && program.current?.title === b.title;
    });
    await capture('Playing B', await waitForPortrait('Portrait promoted B'),
      { phase: 'playing', current: b.title, nextKind: 'none' }, ['current']);
    if (covers) {
      await dj.control({ kind: 'pause', deck: 1 });
      await capture('Paused B', await waitForPortrait('Portrait held paused B'),
        { phase: 'paused', current: b.title, nextKind: 'none' }, ['current']);
      await delay(650);
      const paused = await portraitPixels(true);
      const distances = assertCover(paused.context, vinylDisc, covers, 1);
      checks.push({ label: 'Deck B cover after playback promotes to B', distances });
    }
    await report({ ok: true, checks, portraitFrame });
  } catch (error) {
    const alerts = [...document.querySelectorAll('.set-error, [role="alert"]')].map(node => node.textContent);
    const program = await renderStatus('program').catch(String);
    const portrait = await renderStatus('portrait').catch(String);
    const djPhase = (await state().catch(() => null))?.program?.phase;
    const preparation = preparationDebug().map(bank => ({ ...bank, trace: bank.trace.slice(-18),
      entries: bank.entries.filter(entry => entry.state.state === 'error').slice(0, 8) }));
    await report({ ok: false, error: String(error), checks, alerts, program, portrait, lastPortraitStatus, previousRevision, djPhase, preparation, portraitFrame }).catch(() => {});
  } finally {
    await dj.control({ kind: 'clear' }).catch(() => {});
  }
}
