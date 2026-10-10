import https from 'node:https';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
// Process-local trust fixture. No system/keychain certificates are installed.
const server = https.createServer({ key: readFileSync(path.join(runtime, 'tls-key.pem')),
  cert: readFileSync(path.join(runtime, 'tls-cert.pem')) }, (_request, response) => response.writeHead(404).end());
server.on('upgrade', (request, socket, head) => {
  if (request.headers.host !== 'localhost:7884') { socket.destroy(); return; }
  const upstream = net.connect(7880, '127.0.0.1', () => {
    const headers = request.rawHeaders.reduce((text, value, index, list) => index % 2 ? text : `${text}${value}: ${list[index + 1]}\r\n`, '');
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
});
server.listen(7884, '127.0.0.1', () => console.log('Loopback WSS fixture: wss://localhost:7884'));
