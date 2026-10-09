import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness(refresh) {
  const sockets = [], peers = [], timers = new Map();
  let next = 1, now = 0, requests = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.frames = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(raw) { this.frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class Peer {
    constructor(configuration) { this.configuration = configuration; this.signalingState = 'stable'; this.connectionState = 'connected'; this.senders = []; peers.push(this); }
    getConfiguration() { return this.configuration; }
    setConfiguration(configuration) { this.configuration = configuration; }
    getSenders() { return this.senders; }
    addTrack(track) { const sender = { track, getParameters: () => ({}), setParameters: async () => {}, replaceTrack: async (fresh) => { sender.track = fresh; } }; this.senders.push(sender); return sender; }
    removeTrack(sender) { this.senders = this.senders.filter(item => item !== sender); }
    close() { this.connectionState = 'closed'; }
    restartIce() {}
  }
  const tracks = [{ kind: 'video', stopped: false, stop() { this.stopped = true; } }, { kind: 'audio', stopped: false, stop() { this.stopped = true; } }];
  const stream = { id: 'camera', getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video') };
  const window = {
    location: { origin: 'https://example.test' },
    setTimeout(fn, delay) { const id = next++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const modules = new Map();
  const require = name => {
    if (modules.has(name)) return modules.get(name);
    const source = readFileSync(new URL(`../server/guest/src/${name.slice(2)}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, require, window, WebSocket: Socket, RTCPeerConnection: Peer, console, URL });
    modules.set(name, exports);
    return exports;
  };
  const session = { ice_servers: [{ urls: 'turn:old.test' }], signaling_url: '/old-ticket' };
  const fresh = { session: { ice_servers: [{ urls: 'turn:fresh.test' }], signaling_url: '/fresh-ticket' }, wsUrl: 'wss://example.test/fresh-ticket' };
  const link = new (require('./hostLink').HostLink)({
    session, wsUrl: 'wss://example.test/old-ticket', refreshSession: async () => { requests++; return refresh ? refresh(requests, fresh) : fresh; },
    localStream: () => stream, returnFeed: false, delayReturnFeedMs: 0, onProgram() {}, onHostAudio() {}, onMainState() {},
  });
  return { link, sockets, peers, tracks, timers, get requests() { return requests; },
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}

test('socket loss renews credentials without recapturing media or rebuilding peers', async () => {
  const h = harness(); h.sockets[0].open(); await flush();
  const peer = h.peers[0], senders = [...peer.senders];
  h.sockets[0].close(); await h.advance(1000);
  assert.equal(h.requests, 1); assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].url, 'wss://example.test/fresh-ticket');
  h.sockets[1].open();
  assert.equal(h.peers.length, 1); assert.deepEqual(peer.senders, senders);
  assert.equal(peer.configuration.iceServers[0].urls, 'turn:fresh.test');
  assert.ok(h.tracks.every(track => !track.stopped));
  assert.ok(h.sockets[1].frames.some(frame => frame.payload.kind === 'hello'));
  h.link.close(); assert.equal(h.timers.size, 0);
});

test('offline renewal retries with backoff and only one outstanding timer', async () => {
  const h = harness((attempt, fresh) => { if (attempt < 3) throw new Error('offline'); return fresh; });
  h.sockets[0].open(); h.sockets[0].close(); h.sockets[0].onclose();
  assert.equal(h.timers.size, 1);
  await h.advance(1000); assert.equal(h.requests, 1);
  await h.advance(1999); assert.equal(h.requests, 1);
  await h.advance(1); assert.equal(h.requests, 2);
  await h.advance(3000); assert.equal(h.requests, 3); assert.equal(h.sockets.length, 2);
  h.link.close();
});

test('leaving during renewal cannot reopen a socket or retain retry timers', async () => {
  let resolve;
  const h = harness((_, fresh) => new Promise(done => { resolve = () => done(fresh); }));
  h.sockets[0].open(); h.sockets[0].close(); await h.advance(1000);
  h.link.close(); resolve(); await flush(); await h.advance(10000);
  assert.equal(h.sockets.length, 1); assert.equal(h.timers.size, 0);
  assert.equal(h.peers[0].connectionState, 'closed');
});

test('reconnect flushes pending offers but never replays an old answer', async () => {
  const h = harness();
  h.peers[0].localDescription = { type: 'answer', sdp: 'old' };
  h.sockets[0].open(); assert.ok(!h.sockets[0].frames.some(frame => frame.payload.kind === 'sdp'));
  h.sockets[0].close(); await h.advance(1000);
  h.peers[0].localDescription = { type: 'offer', sdp: 'pending' };
  h.peers[0].signalingState = 'have-local-offer';
  h.sockets[1].open(); assert.ok(h.sockets[1].frames.some(frame => frame.payload.description?.sdp === 'pending'));
  h.link.close();
});
