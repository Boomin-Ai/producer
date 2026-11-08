import { handoff, validSignature, hash, PEERS, MAX_BODY, MAX_PENDING } from './protocol.mjs';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const tokenFor = (env, peer) => env[`${peer.toUpperCase()}_TOKEN`];

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ service: 'producer-agent-bridge', protocol: 1 });
    if (!['/github', '/ticket', '/ws', '/status'].includes(path)) return json({ error: 'Not found' }, 404);
    return env.BRIDGE.get(env.BRIDGE.idFromName('producer-development')).fetch(request);
  },
};

export class Bridge {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async authenticate(request, peer) {
    if (!PEERS.includes(peer) || !tokenFor(this.env, peer)) return false;
    // WebCrypto verifies the credential proof without timing-sensitive string comparison.
    return validSignature('peer authentication', request.headers.get('x-peer-proof'), tokenFor(this.env, peer));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/github' && request.method === 'POST') {
      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'Too large' }, 413);
      const reader = request.body?.getReader();
      const chunks = []; let size = 0;
      if (!reader) return json({ error: 'Missing body' }, 400);
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > MAX_BODY) { await reader.cancel(); return json({ error: 'Too large' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const body = new TextDecoder().decode(bytes);
      if (!await validSignature(body, request.headers.get('x-hub-signature-256'), this.env.GITHUB_WEBHOOK_SECRET)) return json({ error: 'Invalid signature' }, 401);
      if (request.headers.get('x-github-event') === 'ping') return json({ ok: true });
      let payload; try { payload = JSON.parse(body); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const packet = handoff(payload, request.headers.get('x-github-event'), this.env);
      if (!packet) return json({ ignored: true });
      const key = `event:${packet.to}:${packet.id}`;
      const added = await this.ctx.storage.transaction(async store => {
        if (await store.get(key)) return 'duplicate';
        const pending = await store.list({ prefix: `event:${packet.to}:` });
        if ([...pending.values()].filter(e => !e.acknowledgedAt).length >= MAX_PENDING) return 'full';
        await store.put(key, packet);
        return 'accepted';
      });
      if (added === 'full') return json({ error: 'Queue full; redeliver after draining' }, 503);
      if (added === 'accepted') {
        for (const ws of this.ctx.getWebSockets(packet.to)) { try { ws.send(JSON.stringify(packet)); } catch {} }
      }
      await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
      return json({ result: added, id: packet.id });
    }

    if (url.pathname === '/ticket' && request.method === 'POST') {
      const peer = url.searchParams.get('peer');
      if (!await this.authenticate(request, peer)) return json({ error: 'Unauthorized' }, 401);
      const ticket = crypto.randomUUID() + crypto.randomUUID();
      await this.ctx.storage.put(`ticket:${await hash(ticket)}`, { peer, expires: Date.now() + 60_000 });
      await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
      return json({ ticket });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const peer = url.searchParams.get('peer');
      if (!await this.authenticate(request, peer)) return json({ error: 'Unauthorized' }, 401);
      const events = await this.ctx.storage.list({ prefix: `event:${peer}:` });
      return json({ online: Object.fromEntries(PEERS.map(p => [p, this.ctx.getWebSockets(p).length > 0])), pending: [...events.values()].filter(e => !e.acknowledgedAt).length });
    }

    if (url.pathname === '/ws' && request.method === 'GET') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      const key = `ticket:${await hash(url.searchParams.get('ticket') ?? '')}`;
      const session = await this.ctx.storage.transaction(async store => {
        const value = await store.get(key);
        if (value) await store.delete(key);
        return value;
      });
      if (!session || session.expires < Date.now()) return json({ error: 'Expired ticket' }, 401);
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      // One listener per machine; durable local queue prevents duplicate workers.
      for (const old of this.ctx.getWebSockets(session.peer)) old.close(1000, 'Replaced by peer');
      this.ctx.acceptWebSocket(server, [session.peer]);
      server.serializeAttachment({ peer: session.peer });
      server.send(JSON.stringify({ type: 'connected', peer: session.peer }));
      const events = await this.ctx.storage.list({ prefix: `event:${session.peer}:` });
      for (const event of events.values()) if (!event.acknowledgedAt) server.send(JSON.stringify(event));
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 1024) { ws.close(1008, 'Invalid message'); return; }
    let data; try { data = JSON.parse(message); } catch { return; }
    if (data.type !== 'ack' || !/^github-\d+$/.test(data.id ?? '')) return;
    const { peer } = ws.deserializeAttachment();
    const key = `event:${peer}:${data.id}`; const event = await this.ctx.storage.get(key);
    if (event && !event.acknowledgedAt) await this.ctx.storage.put(key, { ...event, acknowledgedAt: Date.now() });
  }
  webSocketClose() {}
  webSocketError() {}
  async alarm() {
    const all = await this.ctx.storage.list(); const cutoff = Date.now() - 7 * 86_400_000;
    const expired = [...all].filter(([k, v]) => k.startsWith('ticket:') ? v.expires < Date.now() : v.acknowledgedAt && v.acknowledgedAt < cutoff).map(([k]) => k);
    if (expired.length) await this.ctx.storage.delete(expired);
    if (all.size > expired.length) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}
