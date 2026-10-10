// Loopback-only signaling/UDP NAT fixture. Never decrypts or records media payloads.
import http from 'node:http';
import dgram from 'node:dgram';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { SignalResponse } from '@livekit/protocol';

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
const udp = dgram.createSocket('udp4'), peers = new Map(), timers = new Set(), sockets = new Set();
const profile = process.env.LIVEKIT_LAB_PACKET_PROFILE ?? 'baseline';
if (!['baseline','video-jitter','audio-jitter','hard-loss'].includes(profile)) throw new Error('Invalid packet profile');
let stopping = false, rng = 123456789;
function random() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0)/4294967296; }
const counts = { profile, signaling_rewrites: 0, rejected_tcp_candidates: 0, rejected_non_mux_candidates: 0, pending_max: 0,
  peer_limit_drops: 0, overflow_drops: 0, send_errors: 0, websocket_backpressure_closes: 0, packets: {},
  payloads_decrypted: false, payloads_logged: false, packet_profile_effect_observed: false };
function rewriteCandidate(candidate) {
  const prefix = candidate.startsWith('a=') ? 'a=' : '';
  const fields = candidate.slice(prefix.length).trim().split(/\s+/);
  if (!fields[0]?.startsWith('candidate:')) return candidate;
  if (fields[2]?.toLowerCase() === 'tcp') { counts.rejected_tcp_candidates++; return null; }
  if (fields[2]?.toLowerCase() !== 'udp' || fields[5] !== '7882') { counts.rejected_non_mux_candidates++; return null; }
  fields[4] = '127.0.0.1'; fields[5] = '7883'; counts.signaling_rewrites++;
  return prefix + fields.join(' ');
}
function rewriteSdp(sdp) {
  return sdp.split('\r\n').flatMap(line => line.startsWith('a=candidate:') ? [rewriteCandidate(line)].filter(Boolean) : [line]).join('\r\n');
}
function rewrite(data, binary) {
  const signal = binary ? SignalResponse.fromBinary(data) : SignalResponse.fromJsonString(data.toString());
  const message = signal.message;
  if (message.case === 'offer' || message.case === 'answer') message.value.sdp = rewriteSdp(message.value.sdp);
  if (message.case === 'trickle') {
    const candidate = JSON.parse(message.value.candidateInit);
    if (candidate.candidate) {
      candidate.candidate = rewriteCandidate(candidate.candidate);
      if (candidate.candidate === null) return null;
      message.value.candidateInit = JSON.stringify(candidate);
    }
  }
  return binary ? Buffer.from(signal.toBinary()) : signal.toJsonString();
}
const server = http.createServer((request,response) => {
  if (request.headers.host !== '127.0.0.1:7885') { response.writeHead(403).end(); return; }
  if (request.url === '/stats') {
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(counts));
  } else response.writeHead(404).end();
});
const wsServer = new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
server.on('upgrade',(request,socket,head) => {
  if (request.headers.host !== '127.0.0.1:7885' || !request.url.startsWith('/rtc')) { socket.destroy(); return; }
  wsServer.handleUpgrade(request,socket,head,client => {
    const headers = {};
    for (const name of ['authorization','origin']) { if (request.headers[name]) headers[name] = request.headers[name]; }
    const upstream = new WebSocket(`ws://127.0.0.1:7880${request.url}`,{headers});
    upstream.on('unexpected-response',(_request,response) => { console.error('Upstream handshake status:',response.statusCode); client.close(1011); upstream.terminate(); });
    sockets.add(client); sockets.add(upstream);
    let pending = [], pendingBytes = 0;
    upstream.on('open',() => { for (const [data,binary] of pending) upstream.send(data,{binary}); pending=[]; pendingBytes=0; });
    // Rust may send its initial request before the upstream handshake completes.
    // Bound that handshake buffer and clear it on either close.
    client.on('message',(data,binary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount+data.length > 1024*1024) { counts.websocket_backpressure_closes++; client.close(1013); upstream.close(); }
        else upstream.send(data,{binary});
      }
      else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 64 && pendingBytes+data.length <= 128*1024) {
        pending.push([data,binary]); pendingBytes += data.length;
      } else client.close(1013);
    });
    upstream.on('message',(data,binary) => {
      try { const result = rewrite(data,binary); if (result !== null && client.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount+Buffer.byteLength(result)>1024*1024) { counts.websocket_backpressure_closes++; client.close(1013); upstream.close(); }
        else client.send(result,{binary});
      } }
      catch (error) { console.error('Fixture signal rewrite:',error.message); client.close(1011); upstream.close(); }
    });
    for (const [from,to] of [[client,upstream],[upstream,client]]) {
      from.on('error',error => { console.error('Fixture websocket:',error.message); to.terminate(); });
      from.on('close',() => { pending=[]; pendingBytes=0; sockets.delete(from); to.terminate(); });
    }
  });
});
function mediaKind(packet) {
  if (packet.length < 12 || (packet[0] & 0xc0) !== 0x80) return 'control';
  // DTLS/STUN aren't RTPv2. RTCP remains unimpaired to preserve sender reports.
  if (packet[1] >= 192 && packet[1] <= 223) return 'control';
  return (packet[1] & 127) === 111 ? 'audio' : 'video';
}
function forward(packet,direction,send) {
  if (stopping) return;
  const kind = mediaKind(packet), key = `${direction}:${kind}`;
  const stat = counts.packets[key] ??= {received:0,forwarded:0,dropped:0,delayed:0,max_delay_ms:0}; stat.received++;
  let delay = 0, drop = false;
  if (kind !== 'control') {
    if (profile === 'hard-loss') drop = true;
    if (profile === 'video-jitter' && kind === 'video') { delay = 20+Math.floor(random()*100); drop = random()<0.02; }
    if (profile === 'audio-jitter' && kind === 'audio') { delay = 20+Math.floor(random()*60); drop = random()<0.02; }
  }
  if (drop) { stat.dropped++; counts.packet_profile_effect_observed = true; return; }
  const deliver = () => { send(error => { if (error) counts.send_errors++; else stat.forwarded++; }); };
  if (!delay) { deliver(); return; }
  if (timers.size >= 1024) { counts.overflow_drops++; stat.dropped++; return; }
  stat.delayed++; stat.max_delay_ms = Math.max(stat.max_delay_ms,delay); counts.packet_profile_effect_observed = true;
  const timer = setTimeout(() => { timers.delete(timer); if (!stopping) deliver(); },delay);
  timers.add(timer); counts.pending_max = Math.max(counts.pending_max,timers.size);
}
udp.on('message',(packet,remote) => {
  if (remote.address !== '127.0.0.1') return;
  const key = `${remote.address}:${remote.port}`;
  let upstream = peers.get(key);
  if (!upstream) {
    if (peers.size >= 16) { counts.peer_limit_drops++; return; }
    upstream = dgram.createSocket('udp4'); peers.set(key,upstream);
    upstream.on('error',() => { counts.send_errors++; });
    upstream.on('message',reply => forward(reply,'sfu_to_client',callback => udp.send(reply,remote.port,remote.address,callback)));
    upstream.bind(0,'127.0.0.1');
  }
  forward(packet,'client_to_sfu',callback => upstream.send(packet,7882,'127.0.0.1',callback));
});
udp.on('error',error => { console.error(error.message); shutdown(); });
function snapshot() { writeFileSync(path.join(runtime,`packet-proxy-${profile}.json`),JSON.stringify({...counts,peers:peers.size,pending:timers.size},null,2)); }
function shutdown() {
  if (stopping) return; stopping = true; clearInterval(report);
  for (const timer of timers) clearTimeout(timer); timers.clear();
  for (const socket of sockets) socket.terminate(); sockets.clear();
  for (const upstream of peers.values()) upstream.close(); peers.clear();
  snapshot(); udp.close(); wsServer.close(); server.close();
}
const report = setInterval(snapshot,1000); report.unref();
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
udp.bind(7883,'127.0.0.1'); server.listen(7885,'127.0.0.1',() => console.log(`Packet relay ${profile}: loopback UDP 7883 / signaling 7885`));
