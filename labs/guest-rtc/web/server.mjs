import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import {fixtureConnection} from './cloud-profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, '../runtime');
const syncStreams = process.env.LIVEKIT_LAB_SYNC_STREAMS === '1';
const connection=fixtureConnection(process.env);
const roomName = connection.roomName;
await mkdir(runtime, { recursive: true });
await build({ entryPoints: [path.join(here, 'fixture.js')], bundle: true,
  outfile: path.join(runtime, 'fixture.js'), format: 'esm', sourcemap: false });

// Credentials stay in this server process; clients receive short-lived room tokens.
export function token(identity, videoGrant) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: connection.key, sub: identity,
    nbf: now - 10, exp: now + (process.env.LIVEKIT_LAB_CLOUD_TEST==='1'?600:3600), roomConfig: syncStreams ? { name: roomName, syncStreams: true, departureTimeout: 1 } : undefined, video: videoGrant ?? { roomJoin: true, room: roomName,
      canPublish: true, canSubscribe: true, canPublishData: false } })}`;
  return `${body}.${createHmac('sha256', connection.secret).update(body).digest('base64url')}`;
}
if (syncStreams) {
  // Provision only the isolated fixture room selected by the validated configuration.
  const response = await fetch(connection.url.replace(/^wss:/,'https:').replace(/^ws:/,'http:')+'/twirp/livekit.RoomService/CreateRoom', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${token('fixture-admin', { roomCreate: true })}` },
    body: JSON.stringify({ name: roomName, syncStreams: true, departureTimeout: 1 }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`RTC test room creation failed: ${response.status}`);
  await writeFile(path.join(runtime, 'sync-room.json'), JSON.stringify(await response.json(), null, 2));
}
await writeFile(path.join(runtime, 'fixture-settings.json'), JSON.stringify({ roomName, syncStreams }));
await writeFile(path.join(runtime, 'native-token'), token('native-host'), { mode: 0o600 });
await chmod(path.join(runtime,'native-token'),0o600);

const server = http.createServer(async (request, response) => {
  try {
    if (!['127.0.0.1:8990', 'localhost:8990'].includes(request.headers.host)) {
      response.writeHead(403).end(); return;
    }
    const url = new URL(request.url, 'http://127.0.0.1:8990');
    if (url.pathname === '/token') {
      const identity = url.searchParams.get('identity');
      if (!/^guest-[1-3]$/.test(identity ?? '') ||
          (request.headers.origin && request.headers.origin !== 'http://127.0.0.1:8990')) {
        response.writeHead(403).end(); return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ token: token(identity), url: connection.url, syncStreams })); return;
    }
    const files = {
      '/': [path.join(here, 'index.html'), 'text/html'],
      '/fixture.js': [path.join(runtime, 'fixture.js'), 'text/javascript'],
      '/pulse-worklet.js': [path.join(here, 'pulse-worklet.js'), 'text/javascript'],
    };
    if (process.env.LIVEKIT_LAB_GUEST_MONITOR === '1') files['/monitor-speech.wav'] = [path.join(runtime, 'near-speech.wav'), 'audio/wav'];
    if(process.env.LIVEKIT_LAB_VOICE_REVIEW==='1') files['/voice-review-worklet.js']=[path.join(here,'voice-review-worklet.js'),'text/javascript'];
    files['/source-marker-trace.mjs'] = [path.join(here, 'source-marker-trace.mjs'), 'text/javascript'];
    const file = files[url.pathname];
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    response.end(await readFile(file[0]));
  } catch (error) { console.error(error.message); response.writeHead(500).end(); }
});
server.listen(8990, '127.0.0.1', () => console.log('Guest RTC lab: http://127.0.0.1:8990'));
