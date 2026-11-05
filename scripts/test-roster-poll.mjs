import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

async function sourceModule(path) {
  const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
  }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}
const { createRosterPollCoordinator } = await sourceModule('../src/lib/rosterPoll.ts');
const { roomSession } = await sourceModule('../src/lib/roomSession.ts');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
const unexpected = [];
const fail = error => unexpected.push(error);

// Access is already answered: a source render replaces a busy roster effect.
// The replacement must continue when the old request finishes, without a timer.
{
  const coordinator = createRosterPollCoordinator();
  const oldFetch = deferred(), nextFetch = deferred();
  const events = [];
  let accessAnswered = true, oldAlive = true;
  const old = coordinator.generation(async () => {
    events.push('old-fetch');
    await oldFetch.promise;
    if (!oldAlive) return;
    events.push('stale-rtc-start');
  }, fail);
  old.tick();
  oldAlive = false;
  old.close();
  const next = coordinator.generation(async () => {
    assert.equal(accessAnswered, true);
    events.push('next-fetch');
    await nextFetch.promise;
  }, fail);
  next.tick();
  next.tick();
  assert.deepEqual(events, ['old-fetch']);
  oldFetch.resolve();
  await flush();
  assert.deepEqual(events, ['old-fetch', 'next-fetch']);
  next.tick();
  assert.equal(events.length, 2, 'replacement started a duplicate request chain');
  next.close();
  nextFetch.resolve();
  await flush();
}

// Several renders supersede each other while the first request drains.
{
  const coordinator = createRosterPollCoordinator(), gate = deferred();
  const events = [];
  const old = coordinator.generation(async () => { events.push('old'); await gate.promise; }, fail);
  old.tick();
  const stale = coordinator.generation(async () => { events.push('stale'); }, fail);
  old.close(); // Late cleanup cannot erase the newer callback.
  stale.tick();
  stale.close();
  const latest = coordinator.generation(async () => { events.push('latest'); }, fail);
  latest.tick();
  gate.resolve();
  await flush();
  assert.deepEqual(events, ['old', 'latest']);
  old.tick(); stale.tick();
  await flush();
  assert.deepEqual(events, ['old', 'latest']);
  latest.close();
}

// Busy ticks within the SAME generation stay skipped, preserving the view's
// existing polling cadence. Finishing work must not create an extra poll.
{
  const coordinator = createRosterPollCoordinator(), gate = deferred();
  let calls = 0;
  const poll = coordinator.generation(async () => { calls++; await gate.promise; }, fail);
  poll.tick(); poll.tick(); poll.tick();
  gate.resolve();
  await flush();
  assert.equal(calls, 1);
  poll.tick();
  await flush();
  assert.equal(calls, 2);
  poll.close();
}

// Unmount and StrictMode cleanup leave no callback for a late result to revive.
{
  const coordinator = createRosterPollCoordinator(), gate = deferred();
  let calls = 0;
  const phantom = coordinator.generation(async () => { calls++; }, fail);
  phantom.close(); phantom.tick();
  assert.equal(calls, 0);
  const old = coordinator.generation(async () => { calls++; await gate.promise; }, fail);
  old.tick(); old.close();
  const next = coordinator.generation(async () => { calls++; }, fail);
  next.tick(); next.close();
  gate.resolve();
  await flush();
  assert.equal(calls, 1);
}

// A started SDK operation is still awaited. The actual roomSession barrier
// must finish it and release old capture before restoring or starting a room.
{
  const coordinator = createRosterPollCoordinator(), sdk = deferred();
  const oldSession = roomSession(), events = [];
  const old = coordinator.generation(async () => {
    await oldSession.run(async () => {
      events.push('sdk-start'); await sdk.promise; events.push('sdk-finish');
    });
  }, fail);
  old.tick();
  await flush();
  old.close();
  const release = oldSession.close(async () => { events.push('release'); });
  const nextSession = roomSession();
  const restore = nextSession.run(async () => { events.push('restore'); });
  const next = coordinator.generation(async () => {
    await nextSession.run(async () => { events.push('new-rtc-start'); });
  }, fail);
  next.tick();
  assert.deepEqual(events, ['sdk-start']);
  sdk.resolve();
  await Promise.all([release, restore]);
  await flush();
  assert.deepEqual(events, ['sdk-start', 'sdk-finish', 'release', 'restore', 'new-rtc-start']);
  next.close();
  await nextSession.close(async () => {});
}

// Failed old work and even a failing error observer release admission. The
// lifecycle handoff consumes rejections instead of producing an unhandled one.
{
  const coordinator = createRosterPollCoordinator(), gate = deferred();
  const errors = [], events = [], unhandled = [];
  const observeUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', observeUnhandled);
  const old = coordinator.generation(async () => { await gate.promise; }, error => {
    errors.push(error); throw new Error('observer failed');
  });
  old.tick(); old.close();
  const next = coordinator.generation(async () => { events.push('recovered'); }, fail);
  next.tick();
  const failure = new Error('roster failed');
  gate.reject(failure);
  await flush();
  await new Promise(resolve => setImmediate(resolve));
  process.off('unhandledRejection', observeUnhandled);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(events, ['recovered']);
  assert.deepEqual(unhandled, []);
  next.close();
}
assert.deepEqual(unexpected, []);
console.log('PASS: roster replacement handoff, generation/unmount fences, unchanged steady cadence, SDK drain ordering and rejection cleanup.');
