/** Disposable P0 harness. No production endpoint, actions, IPC or native handles. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const lottie=await readFile(new URL('../../src/features/presentation/vendor/lottie-light.js',import.meta.url),'utf8');
const renderer = await readFile(new URL('../../src/features/presentation/frame.js', import.meta.url), 'utf8');
const scriptSafe = text => text.replace(/</g, '\\u003c');
function page(surface, nonce) {
  const frame = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:system-ui,sans-serif}*{box-sizing:border-box}#canvas{position:absolute;transform-origin:top left;overflow:hidden}</style><style id="motion"></style><div id="canvas"></div><script nonce="${nonce}">${lottie}\n${renderer}</script>`;
  return `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{border:0;width:100%;height:100%}</style></head><body><iframe sandbox="allow-scripts" allow="camera 'none'; microphone 'none'; display-capture 'none'" title="Read-only set output"></iframe><script nonce="${nonce}">
  const frame=document.querySelector('iframe'); let port, stopped=false, revision=-1, pending;
  // Diagnostics are visual preparation only. They grant no mutation authority.
  window.__presentationProof={surface:${JSON.stringify(surface)},prepared:null,error:null};
  const publish=()=>{if(port&&pending){port.postMessage({type:'output',surface:${JSON.stringify(surface)},projection:pending});pending=null;}};
  addEventListener('message', e=>{
    if(e.source!==frame.contentWindow||e.data!=='presentation.ready'||port)return;
    const channel=new MessageChannel();port=channel.port1;
    port.onmessage=e=>{if(e.data?.type==='prepared')window.__presentationProof.prepared=e.data;};
    port.start();frame.contentWindow.postMessage('presentation.connect','*',[channel.port2]);publish();
  });
  frame.srcdoc=${scriptSafe(JSON.stringify(frame))};
  async function poll(){
    if(stopped)return;
    try{
      const response=await fetch('./projection.json',{cache:'no-store',credentials:'omit'});
      if(!response.ok)throw new Error('Output revoked or unavailable');
      const p=await response.json();if(p.revision!==revision){revision=p.revision;pending=p;publish();}
    }catch(e){stopped=true;window.__presentationProof.error=e.message;frame.remove();}
    if(!stopped)setTimeout(poll,100);
  }poll();
  </script></body></html>`;
}
export async function startProofBridge(initial) {
  let projection = structuredClone(initial), active = true;
  const token = randomBytes(32).toString('hex'), nonce = randomBytes(24).toString('hex');
  const prefix = `/output/${token}/`;
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), display-capture=()');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; media-src data:; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    const deny = code => { res.writeHead(code); res.end(); };
    if (!active || req.headers.host !== `127.0.0.1:${server.address().port}`) return deny(404);
    if (req.headers.origin && req.headers.origin !== origin) return deny(403);
    if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return deny(403);
    if (req.method !== 'GET' || Number(req.headers['content-length'] || 0) !== 0 || req.headers['transfer-encoding']) return deny(405);
    const route = req.url;
    if (![`${prefix}background`, `${prefix}foreground`, `${prefix}projection.json`].includes(route)) return deny(404);
    const json = route.endsWith('/projection.json');
    res.setHeader('Content-Type', json ? 'application/json' : 'text/html; charset=utf-8');
    res.end(json ? JSON.stringify(projection) : page(route.endsWith('/background') ? 'background' : 'foreground', nonce));
  });
  server.requestTimeout = 3000; server.headersTimeout = 3000; server.keepAliveTimeout = 1000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    backgroundUrl: `${origin}${prefix}background`, foregroundUrl: `${origin}${prefix}foreground`,
    projectionUrl: `${origin}${prefix}projection.json`,
    // Trusted in-process writer only; intentionally no HTTP write route.
    publish(next) {
      if (!active) throw new Error('Output revoked');
      if (next.revision <= projection.revision) throw new Error('Stale projection');
      const encoded = JSON.stringify(next);
      if (Buffer.byteLength(encoded) > 40 * 1024 * 1024) throw new Error('Projection budget exceeded');
      projection = JSON.parse(encoded);
    },
    revoke() { active = false; },
    async close() { active = false; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
