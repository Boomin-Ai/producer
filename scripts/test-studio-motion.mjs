import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/features/studio/motion.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const {
  STUDIO_MOTION_DURATION_MS,
  STUDIO_MOTION_MIN_MS,
  studioMotionKeyframes,
  studioMotionPose,
  validateStudioMotion,
} = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

const bounds = {
  setControls: { x: 0.76, y: 0.18, w: 0.22, h: 0.71 },
  assistant: { x: 0.02, y: 0.18, w: 0.22, h: 0.71 },
};
const neutral = { panel: null, lift: 0, floating: 0, canvasMix: 0, zoom: 1, panX: 0, panY: 0, yaw: 0, pitch: 0, roll: 0 };
const poseLimits = {
  lift: [0, 1], floating: [0, 1], zoom: [0.7, 2.2], panX: [-0.6, 0.6], panY: [-0.6, 0.6],
  yaw: [-0.72, 0.72], pitch: [-0.72, 0.72], roll: [-0.4, 0.4], canvasMix: [0, 1],
};

function clip(id, target, startMs, durationMs, overrides = {}) {
  return { id, target, startMs, durationMs, transitionMs: 600, lift: 1, zoom: 2.15, angle: 22, ending: 'flow', ...overrides };
}

function assertNativePose(pose) {
  for (const [field, [low, high]] of Object.entries(poseLimits)) {
    assert.ok(Number.isFinite(pose[field]) && pose[field] >= low && pose[field] <= high, `${field}=${pose[field]} outside [${low}, ${high}]`);
  }
  if (pose.lift > 0) assert.ok(Object.values(bounds).includes(pose.panel));
}

function assertContinuous(sequence, atMs) {
  const before = studioMotionPose(sequence, atMs - 1, bounds);
  const at = studioMotionPose(sequence, atMs, bounds);
  const after = studioMotionPose(sequence, atMs + 1, bounds);
  for (const field of Object.keys(poseLimits)) {
    assert.ok(Math.abs(before[field] - at[field]) < 0.002, `${field} jumps before ${atMs} ms`);
    assert.ok(Math.abs(after[field] - at[field]) < 0.002, `${field} jumps after ${atMs} ms`);
  }
}

test('connected panel and window motions stay continuous and return to the original frame', () => {
  const sequence = validateStudioMotion({ clips: [
    clip('intro', 'setControls', 400, 1600),
    clip('sweep', 'window', 2000, 3500),
    clip('outro', 'assistant', 5500, 1700, { ending: 'return' }),
  ] });
  for (const boundary of [400, 2000, 5500, 7200]) assertContinuous(sequence, boundary);

  assert.deepEqual(studioMotionPose(sequence, 0, bounds), neutral);
  assert.deepEqual(studioMotionPose(sequence, 7200, bounds), neutral);
  assert.equal(studioMotionPose(sequence, 2000, bounds).panel, bounds.setControls);
  assert.equal(studioMotionPose(sequence, 5500, bounds).floating, 1);
  assert.ok(studioMotionPose(sequence, 3800, bounds).panX > studioMotionPose(sequence, 2800, bounds).panX);
  assert.equal(studioMotionPose(sequence, 6300, bounds).panel, bounds.assistant);
  assert.deepEqual(studioMotionPose(sequence, 6300, {}), neutral);
  for (let timeMs = 0; timeMs <= STUDIO_MOTION_DURATION_MS; timeMs += 7) {
    assertNativePose(studioMotionPose(sequence, timeMs, bounds));
  }
});

test('a direct handoff between different panels changes crop at zero lift', () => {
  const sequence = validateStudioMotion({ clips: [
    clip('left', 'assistant', 0, 1600),
    clip('right', 'setControls', 1600, 1600),
  ] });
  const frames = studioMotionKeyframes(sequence, 0, bounds);
  const handoff = frames.find(frame => frame.atMs === 1900);
  assert.ok(handoff, 'The middle of the handoff is sampled');
  assert.equal(handoff.lift, 0);
  assert.equal(studioMotionPose(sequence, 1800, bounds).panel, bounds.assistant);
  assert.equal(studioMotionPose(sequence, 2000, bounds).panel, bounds.setControls);
  assertContinuous(sequence, 1900);
});

test('a canvas sweep ramps the clean program without needing a panel crop', () => {
  const sequence = validateStudioMotion({ clips: [
    clip('window', 'window', 0, 2000),
    clip('program', 'canvas', 2000, 2800, { ending: 'return' }),
  ] });
  for (const boundary of [2000, 4800]) assertContinuous(sequence, boundary);
  assert.equal(studioMotionPose(sequence, 2000, {}).canvasMix, 0);
  assert.ok(studioMotionPose(sequence, 2300, {}).canvasMix > 0);
  const middle = studioMotionPose(sequence, 3000, {});
  assert.equal(middle.canvasMix, 1);
  assert.equal(middle.panel, null);
  assert.ok(middle.zoom > 1);
  assert.deepEqual(studioMotionPose(sequence, 4800, {}), neutral);
});

test('a full timeline and a scrub near its end both fit the native keyframe budget', () => {
  const clipCount = STUDIO_MOTION_DURATION_MS / STUDIO_MOTION_MIN_MS;
  const targets = ['setControls', 'window', 'assistant'];
  const sequence = validateStudioMotion({ clips: Array.from({ length: clipCount }, (_, index) =>
    clip(`clip-${index}`, targets[index % targets.length], index * STUDIO_MOTION_MIN_MS, STUDIO_MOTION_MIN_MS)) });

  for (const fromMs of [0, 1425, STUDIO_MOTION_DURATION_MS - 1]) {
    const keyframes = studioMotionKeyframes(sequence, fromMs, bounds);
    assert.ok(keyframes.length >= 2 && keyframes.length <= 180, `${keyframes.length} native keyframes`);
    assert.ok(keyframes.every((frame, index) => Number.isInteger(frame.atMs) && (index === 0 || frame.atMs > keyframes[index - 1].atMs)));
    const [first, last] = [keyframes[0], keyframes.at(-1)];
    assert.deepEqual(first, { atMs: 0, ...studioMotionPose(sequence, fromMs, bounds) });
    assert.deepEqual(last, { atMs: STUDIO_MOTION_DURATION_MS - fromMs, ...neutral });
    for (const frame of keyframes) assertNativePose(frame);
  }
});

test('motion validation rejects invalid timing, overlaps and unsupported poses', () => {
  const first = clip('first', 'window', 100, 1000);
  const second = clip('second', 'setControls', 1100, 1000);
  assert.deepEqual(validateStudioMotion({ clips: [second, first] }).clips, [first, second]);
  assert.throws(() => validateStudioMotion({ clips: [first, { ...second, startMs: 1099 }] }), /overlap/i);
  assert.throws(() => validateStudioMotion({ clips: [first, { ...second, id: first.id }] }), /unique ID/i);

  for (const [overrides, message] of [
    [{ startMs: -1 }, /clip start/i],
    [{ startMs: 100.5 }, /whole milliseconds/i],
    [{ durationMs: STUDIO_MOTION_MIN_MS - 1 }, /clip duration/i],
    [{ startMs: STUDIO_MOTION_DURATION_MS - STUDIO_MOTION_MIN_MS, durationMs: 801 }, /clip duration/i],
    [{ transitionMs: 0 }, /transition/i],
    [{ lift: NaN }, /lift/i],
    [{ zoom: 3 }, /close-up/i],
    [{ angle: -23 }, /angle/i],
    [{ target: 'missing' }, /target/i],
  ]) {
    assert.throws(() => validateStudioMotion({ clips: [{ ...first, ...overrides }] }), message);
  }
});

test('one-minute sources retain duration and generate bounded native playback', () => {
  const sequence = validateStudioMotion({durationMs:60000, clips:[clip('long','window',0,60000)]});
  assert.equal(sequence.durationMs,60000);
  for(const start of [0, 45000,59999]){
    const frames=studioMotionKeyframes(sequence,start,bounds);
    assert.ok(frames.length>=2 && frames.length<=1200);
    assert.equal(frames.at(-1).atMs,60000-start);
    frames.forEach(assertNativePose);
  }
  assert.throws(()=>validateStudioMotion({durationMs:60001,clips:[]}),/source duration/i);
  assert.throws(()=>validateStudioMotion({durationMs:1000,clips:[clip('over','window',0,1100)]}),/clip duration/i);
});
