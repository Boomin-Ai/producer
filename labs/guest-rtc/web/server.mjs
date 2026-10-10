import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, '../runtime');
await mkdir(runtime, { recursive: true });
await build({ entryPoints: [path.join(here, 'fixture.js')], bundle: true,
  outfile: path.join(runtime, 'fixture.js'), format: 'esm', sourcemap: false });

// These are LiveKit's public --dev credentials, exclusively for loopback fixtures.
export function token(identity) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'devkey', sub: identity,
    nbf: now - 10, exp: now + 3600, video: { roomJoin: true, room: 'producer-g1-lab',
      canPublish: true, canSubscribe: true, canPublishData: false } })}`;
  return `${body}.${createHmac('sha256', 'secret').update(body).digest('base64url')}`;
}
await writeFile(path.join(runtime, 'native-token'), token('native-host'), { mode: 0o600 });

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
        .end(JSON.stringify({ token: token(identity), url: 'ws://127.0.0.1:7880' })); return;
    }
    const files = {
      '/': [path.join(here, 'index.html'), 'text/html'],
      '/fixture.js': [path.join(runtime, 'fixture.js'), 'text/javascript'],
      '/pulse-worklet.js': [path.join(here, 'pulse-worklet.js'), 'text/javascript'],
    };
    const file = files[url.pathname];
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    response.end(await readFile(file[0]));
  } catch (error) { console.error(error.message); response.writeHead(500).end(); }
});
server.listen(8990, '127.0.0.1', () => console.log('Guest RTC lab: http://127.0.0.1:8990'));
