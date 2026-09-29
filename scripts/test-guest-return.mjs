import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

const source = readFileSync(new URL('../server/guest/src/guestReturnFeed.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function harness(capture = async () => { throw new Error('denied'); }) {
  const timers = new Map(), listeners = new Map();
  let next = 1, now = 0;
  const media = {
    getUserMedia: capture,
    enumerateDevices: async () => [{ kind: 'videoinput', label: 'Producer Virtual Camera', deviceId: 'vcam' }],
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const context = { exports: {}, navigator: { mediaDevices: media }, document, console: { warn() {} }, Date: { now: () => now }, window: {
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  } };
  vm.runInNewContext(compiled, context);
  const senders = [];
  const pc = { signalingState: 'stable', connectionState: 'connected', frames: 0,
    getStats: async () => new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: pc.frames }]]),
    addTrack(track) { const sender = { track, async replaceTrack(t) { this.track = t; } }; senders.push(sender); return sender; },
  };
  return { ...context.exports, pc, media, listeners, timers, senders, document,
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function stream(kind = 'video') {
  const events = new Map();
  const track = { kind, stopped: false, stop() { this.stopped = true; }, addEventListener: (name, fn) => events.set(name, fn) };
  return { track, end: () => events.get('ended')?.(), getTracks: () => [track], getVideoTracks: () => kind === 'video' ? [track] : [], getAudioTracks: () => kind === 'audio' ? [track] : [] };
}
const options = (h) => ({ pc: h.pc, enabled: true, programLabel: 'Producer Virtual Camera', micLabel: null });

test('denied microphone does not block video; duplicate requests capture once', async () => {
  const video = stream(); let captures = 0;
  const h = harness(async (constraints) => { if (constraints.audio) throw new Error('denied'); captures++; return video; });
  const feed = new h.GuestReturnFeed(options(h));
  feed.request(); feed.request(); await flush(); feed.request(); await flush();
  assert.equal(captures, 1); assert.equal(h.senders[0].track, video.track);
  feed.close(); assert.ok(video.track.stopped); assert.equal(h.listeners.size, 0);
});

test('late microphone capture after timeout is stopped, while video succeeds', async () => {
  let resolveAudio; const audio = stream('audio'), video = stream();
  const h = harness((constraints) => constraints.audio ? new Promise((resolve) => { resolveAudio = resolve; }) : Promise.resolve(video));
  const feed = new h.GuestReturnFeed(options(h)); feed.request(); await h.advance(5001);
  resolveAudio(audio); await flush(); assert.ok(audio.track.stopped); assert.equal(h.senders.length, 1);
  feed.close();
});

test('late video capture after connection teardown is stopped', async () => {
  let resolveVideo; const video = stream();
  const h = harness((constraints) => constraints.audio ? Promise.reject(new Error('denied')) : new Promise((resolve) => { resolveVideo = resolve; }));
  const feed = new h.GuestReturnFeed(options(h)); feed.request(); await flush(); feed.close();
  resolveVideo(video); await flush(); assert.ok(video.track.stopped); assert.equal(h.senders.length, 0);
});

test('virtual camera appearance and restart recover without accumulating senders', async () => {
  const first = stream(), second = stream(); let ready = false, count = 0;
  const h = harness(async (constraints) => { if (constraints.audio) throw new Error('denied'); return count++ ? second : first; });
  h.media.enumerateDevices = async () => ready ? [{ kind: 'videoinput', label: 'Producer Virtual Camera', deviceId: 'vcam' }] : [{ kind: 'videoinput', label: 'Physical camera', deviceId: 'physical' }];
  const feed = new h.GuestReturnFeed(options(h)); feed.request(); await flush(); assert.equal(count, 0);
  ready = true; await h.advance(2000); assert.equal(h.senders.length, 1);
  first.end(); await h.advance(2000); assert.equal(h.senders.length, 1); assert.equal(h.senders[0].track, second.track);
  feed.close();
});

test('no return grant means no camera or microphone capture', async () => {
  let calls = 0; const h = harness(async () => { calls++; return stream(); });
  const feed = new h.GuestReturnFeed({ ...options(h), enabled: false }); feed.request(); await flush();
  assert.equal(calls, 0); feed.close();
});

test('request retries lost messages and stops only with advancing decoded frames', async () => {
  const h = harness(); let requests = 0; h.pc.frames = 100;
  const request = new h.ProgramRequest(h.pc, () => requests++);
  request.connected(); await h.advance(0); assert.equal(requests, 1);
  await h.advance(3000); assert.equal(requests, 2, 'Old decoded frames do not prove the new return');
  h.pc.frames = 105; await h.advance(3000); assert.equal(requests, 2);
  request.restart(); await h.advance(0); assert.equal(requests, 3);
  request.close(); await h.advance(6000); assert.equal(requests, 3); assert.equal(h.listeners.size, 0);
});

test('iOS delay, background return and teardown leave no request timers', async () => {
  const h = harness(); let requests = 0;
  const request = new h.ProgramRequest(h.pc, () => requests++, 5000);
  request.connected(); await h.advance(4999); assert.equal(requests, 0);
  h.document.visibilityState = 'hidden'; await h.advance(1); assert.equal(requests, 0);
  h.document.visibilityState = 'visible'; h.listeners.get('visibilitychange')(); await h.advance(5000); assert.equal(requests, 1);
  request.close(); assert.equal(h.timers.size, 0);
});
