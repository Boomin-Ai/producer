/** Edge contract tests. All upstream and ASSETS responses are fixtures;
 * nothing is fetched from Boomin/GitHub or published to a real site. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../site/_worker.js';

const canonical='https://producer.dev';
const identityOrigin='https://api.boomin.ai';
const publicBrand={brand:{id:'public-brand-id',slug:'kleveland',name:'Kleveland',headline:'Live from the studio',bio:'Make something worth watching.'}};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function request(path,{method='GET',headers={},upstream=()=>json(publicBrand),host=canonical}={}){
 const calls=[],assets=[],oldFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init});return upstream(input,init);};
 try{
  const req=new Request(host+path,{method,headers});
  const response=await worker.fetch(req,{ASSETS:{fetch:async original=>{assets.push(original);return new Response('STATIC:'+new URL(original.url).pathname);}}});
  const text=await response.text();
  return {response,text,calls,assets};
 }finally{globalThis.fetch=oldFetch;}
}
function privateCache(response){
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 assert.equal(response.headers.get('set-cookie'),null);
 assert.equal(response.headers.get('etag'),null);
}

test('canonical public brand renders a Producer profile with a fixed anonymous issuer',async()=>{
 const r=await request('/kleveland');
 assert.equal(r.response.status,200);assert.equal(r.assets.length,0);assert.equal(r.calls.length,1);
 assert.equal(r.calls[0].url,identityOrigin+'/v1/connect/b/kleveland');
 assert.equal(r.calls[0].init.method,'GET');assert.equal(r.calls[0].init.redirect,'manual');assert.equal(r.calls[0].init.credentials,'omit');
 assert.equal(r.calls[0].init.cf.cacheTtl,0);assert.equal(r.calls[0].init.cf.cacheEverything,false);
 assert.match(r.text,/<h1>Kleveland<\/h1>/);assert.match(r.text,/@kleveland/);assert.match(r.text,/https:\/\/boomin.ai\/kleveland/);
 assert.match(r.text,/rel="canonical" href="https:\/\/producer.dev\/kleveland"/);
 assert.match(r.text,/Public Set downloads are not available yet/);assert.doesNotMatch(r.text,/Download Set|\.set\.json|<script|<iframe|<img/);
 privateCache(r.response);assert.match(r.response.headers.get('content-security-policy'),/default-src 'none'/);
});

test('query/header credentials, cookies, Range and caller-selected origins never reach the public issuer',async()=>{
 const r=await request('/kleveland?token=PRIVATE_QUERY&url=https://attacker.invalid/private&brand_id=foreign',{
  headers:{Authorization:'Bearer PRIVATE_TOKEN',Cookie:'session=PRIVATE_COOKIE','X-Brand-Id':'foreign','X-Forwarded-Host':'attacker.invalid',Range:'bytes=0-5','If-None-Match':'private-etag'},
 });
 assert.equal(r.response.status,200);assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,identityOrigin+'/v1/connect/b/kleveland');
 assert.deepEqual(r.calls[0].init.headers,{'Accept':'application/json','Cache-Control':'no-cache'});
 assert.doesNotMatch(r.text,/PRIVATE_|attacker\.invalid|foreign|private-etag/);privateCache(r.response);
});

test('only explicit safe text is rendered, never untrusted markup, URLs, IDs or future fields',async()=>{
 const r=await request('/kleveland',{upstream:()=>json({
  ...publicBrand,brand:{...publicBrand.brand,name:'<img src=x onerror="boom()"> & \'hello\'',headline:'<script>PRIVATE_JS</script>',bio:'</main><iframe src="https://tracker.invalid">',
   avatar_url:'https://tracker.invalid/avatar',links:[{url:'javascript:PRIVATE_LINK'}],token:'PRIVATE_SECRET'},
  private_workspace:{token:'PRIVATE_WORKSPACE'},sets:[{download_url:'file:///Users/owner/private.set.json'}],
 })});
 assert.equal(r.response.status,200);assert.match(r.text,/&lt;img src=x onerror=&quot;boom\(\)&quot;&gt; &amp; &#39;hello&#39;/);
 assert.doesNotMatch(r.text,/<script|<iframe|<img|javascript:|PRIVATE_SECRET|PRIVATE_WORKSPACE|PRIVATE_LINK|file:|public-brand-id/);
 assert.equal(r.calls.length,1);
});

test('HEAD checks the same identity and returns no body with the same safe page headers',async()=>{
 const get=await request('/kleveland'),head=await request('/kleveland',{method:'HEAD'});
 assert.equal(head.response.status,200);assert.equal(head.text,'');assert.equal(head.calls.length,1);assert.equal(head.calls[0].init.method,'GET');
 for(const key of ['content-type','cache-control','content-security-policy','referrer-policy','x-content-type-options'])assert.equal(head.response.headers.get(key),get.response.headers.get(key));
});

for(const path of ['/Kleveland','/kleveland/','/KLEVELAND/?token=PRIVATE_QUERY','/Kleveland/SET/InternetDJ/','/kleveland/set/internetdj/DOWNLOAD/']){
 test('case/trailing-slash normalization does not fetch identity or reflect query: '+path,async()=>{
  const r=await request(path);assert.equal(r.response.status,308);assert.equal(r.calls.length,0);assert.equal(r.assets.length,0);
  assert.equal(r.response.headers.get('location'),canonical+(path.toLowerCase().includes('/set/')?'/kleveland/set/internetdj'+(path.toLowerCase().includes('/download')?'/download':''):'/kleveland'));
  privateCache(r.response);
 });
}

for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){
 test('public routes are read-only, with no upstream/ASSETS activity: '+method,async()=>{
  for(const path of ['/kleveland','/kleveland/set/internetdj','/kleveland/set/internetdj/download']){
   const r=await request(path,{method});assert.equal(r.response.status,405);assert.equal(r.response.headers.get('allow'),'GET, HEAD');
   assert.equal(r.calls.length,0);assert.equal(r.assets.length,0);privateCache(r.response);
  }
 });
}

test('missing/deleted/nonpublic identity returns a safe404, never the landing-page fallback',async()=>{
 for(const method of ['GET','HEAD']){
  const r=await request('/not-a-public-brand',{method,upstream:()=>new Response('PRIVATE_ERROR',{status:404,headers:{'Set-Cookie':'private=x'}})});
  assert.equal(r.response.status,404);assert.equal(r.assets.length,0);assert.doesNotMatch(r.text,/PRIVATE_ERROR/);assert.equal(method==='HEAD'?r.text:'','');
  privateCache(r.response);assert.match(r.response.headers.get('x-robots-tag'),/noindex/);
 }
});

test('upstream redirects, auth failures, HTML, malformed identity and JSON errors fail closed',async()=>{
 for(const upstream of [
  ()=>new Response(null,{status:302,headers:{Location:'https://attacker.invalid','Set-Cookie':'private=x'}}),
  ()=>new Response('PRIVATE_ERROR',{status:401}),()=>new Response('PRIVATE_ERROR',{status:500}),
  ()=>new Response('<script>PRIVATE</script>',{headers:{'Content-Type':'text/html'}}),
  ()=>new Response('invalid-json',{headers:{'Content-Type':'application/json'}}),
  ()=>json({...publicBrand,brand:{...publicBrand.brand,slug:'other-brand'}}),
  ()=>json({...publicBrand,brand:{...publicBrand.brand,name:42}}),
  ()=>{throw Error('PRIVATE_UPSTREAM_TOKEN');},
 ]){
  const r=await request('/kleveland',{upstream});assert.equal(r.response.status,503);assert.equal(r.calls.length,1);assert.equal(r.assets.length,0);
  assert.doesNotMatch(r.text,/PRIVATE|attacker|invalid-json/);assert.equal(r.response.headers.get('location'),null);privateCache(r.response);
 }
});

test('identity body size is bounded with or without a trustworthy Content-Length',async()=>{
 for(const upstream of [
  ()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'1048577'}}),
  ()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'unknown'}}),
  ()=>json({...publicBrand,padding:'x'.repeat(1024*1024)}),
 ]){
  const r=await request('/kleveland',{upstream});assert.equal(r.response.status,503);assert.equal(r.calls.length,1);assert.ok(r.text.length<10000);privateCache(r.response);
 }
});

test('rejected metadata/body streams are cancelled rather than consumed indefinitely',async()=>{
 for(const mode of ['404','length','chunk']){
  let cancelled=false;
  const stream=new ReadableStream({start(controller){if(mode==='chunk')controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}});
  const r=await request('/kleveland',{upstream:()=>new Response(stream,{status:mode==='404'?404:200,headers:{'Content-Type':'application/json',...(mode==='length'?{'Content-Length':'1048577'}:{})}})});
  assert.equal(r.response.status,mode==='404'?404:503);assert.equal(cancelled,true,mode);privateCache(r.response);
 }
});

test('Set page and download explicitly stay unavailable without invoking any artifact source',async()=>{
 for(const handle of ['kleveland','nonexistent','private-brand'])for(const suffix of ['', '/download'])for(const method of ['GET','HEAD']){
  const r=await request(`/${handle}/set/internetdj${suffix}?url=file:///private/local.set.json&download=1`,{method,upstream:()=>{throw Error('NO artifact or identity call is permitted');}});
  assert.equal(r.response.status,404);assert.equal(r.calls.length,0);assert.equal(r.assets.length,0);privateCache(r.response);
  assert.equal(r.response.headers.get('content-disposition'),null);assert.equal(r.response.headers.get('location'),null);
  if(method==='HEAD')assert.equal(r.text,'');else if(suffix)assert.equal(JSON.parse(r.text).error.code,'public_set_unavailable');else assert.match(r.text,/Set unavailable/);
  assert.doesNotMatch(r.text,/local\.set|file:|producer-media:|Download Set|native|\bR2\b/);
 }
});

test('invalid public route grammar never looks up an identity or package',async()=>{
 for(const path of ['/-bad','/bad-','/bad--handle','/two_words','/caf%C3%A9','/%6bleveland','/a'.padEnd(82,'a'),'/kleveland//','/kleveland//set/slug',
  '/kleveland/set','/kleveland/set/','/kleveland/set/-bad','/kleveland/set/file.set.json','/kleveland/set/%2Fsecret',
  '/kleveland/set/ok/extra','/kleveland/set/ok/download/extra','/kleveland./set/slug','/kleveland/set/'+('a'.repeat(81)),
 ]){
  const r=await request(path);assert.equal(r.response.status,404,path);assert.equal(r.calls.length,0,path);assert.equal(r.assets.length,0,path);privateCache(r.response);
 }
});

test('reserved system/static namespaces keep their existing static routing',async()=>{
 for(const path of ['/', '/index.html','/favicon.png','/github.svg','/robots.txt','/.well-known/security.txt',
  '/assets/app.js','/shots/host.mp4','/login','/signup','/auth/callback/google','/api','/download',
  '/download/set/nope','/producer','/room-assets-missing.js','/sets','/e','/c','/t','/l','/o','/r','/s',
  '/ordinary/nested-static-file.css',
 ]){
  const r=await request(path);assert.equal(r.response.status,200,path);assert.equal(r.text,'STATIC:'+path,path);assert.equal(r.calls.length,0,path);assert.equal(r.assets.length,1,path);
 }
});

test('branded guest/audience and legacy room shells keep precedence and credential isolation',async()=>{
 const html='<html><meta property="og:site_name" content="Boomin"><meta property="og:url" content="https://boomin.ai/original"><body>Room</body></html>';
 for(const path of ['/kleveland/guest/inside/gi_abcdefghijklmnopqrstuvwx','/kleveland/audience/inside',
  '/download/guest/inside/gr_abcdefghijklmnopqrstuvwx','/audience/room-id','/connect/guest/room/gr_abcdefghijklmnopqrstuvwx','/connect/guest/gi_abcdefghijklmnopqrstuvwx']){
  const r=await request(path,{headers:{Authorization:'Bearer PRIVATE',Cookie:'private=x'},upstream:()=>new Response(html,{headers:{'Content-Type':'text/html','Set-Cookie':'private=x'}})});
  assert.equal(r.response.status,200,path);assert.equal(r.calls.length,1,path);assert.equal(r.assets.length,0,path);
  assert.equal(new URL(r.calls[0].url).origin,'https://boomin.ai');assert.deepEqual(r.calls[0].init.headers,{accept:'text/html'});
  assert.equal(r.calls[0].init.redirect,'manual');assert.equal(r.response.headers.get('set-cookie'),null);assert.equal(r.response.headers.get('cache-control'),'no-store');
  assert.match(r.text,/og:site_name" content="Producer"/);
 }
});

test('room assets stay a fixed Boomin proxy and reject upstream HTML',async()=>{
 const r=await request('/room-assets/main.js?version=1',{upstream:()=>new Response('ROOM_JS',{headers:{'Content-Type':'application/javascript'}})});
 assert.equal(r.response.status,200);assert.equal(r.calls[0].url,'https://boomin.ai/room-assets/main.js?version=1');assert.equal(r.text,'ROOM_JS');assert.equal(r.response.headers.get('cache-control'),'no-cache');
 const bad=await request('/room-assets/main.js',{upstream:()=>new Response('<html>',{headers:{'Content-Type':'text/html'}})});
 assert.equal(bad.response.status,503);assert.equal(bad.assets.length,0);
});

const release={tag_name:'v0.4.88',draft:false,prerelease:false,assets:[
 {id:10,name:'Producer_aarch64.dmg',size:123,browser_download_url:'https://github.com/Boomin-Ai/producer/releases/download/v0.4.88/Producer_aarch64.dmg'},
 {id:11,name:'Producer-setup.exe',size:456,browser_download_url:'https://github.com/Boomin-Ai/producer/releases/download/v0.4.88/Producer-setup.exe'},
]};
test('stable installer downloads and metadata keep precedence and their existing envelopes',async()=>{
 const upstream=url=>String(url).endsWith('/releases/latest')?json(release):new Response('INSTALLER');
 const meta=await request('/download/meta.json',{upstream});assert.equal(meta.response.status,200);assert.equal(JSON.parse(meta.text).version,'v0.4.88');assert.equal(meta.assets.length,0);assert.equal(meta.calls.length,1);
 const download=await request('/download/windows',{upstream});assert.equal(download.response.status,200);assert.equal(download.text,'INSTALLER');assert.equal(download.calls.length,2);assert.equal(download.assets.length,0);
 assert.match(download.calls[0].url,/api.github.com\/repos\/Boomin-Ai\/producer\/releases\/latest$/);assert.match(download.calls[1].url,/\?ck=11$/);
 assert.equal(download.response.headers.get('content-disposition'),'attachment; filename="Producer-Setup.exe"');assert.equal(download.response.headers.get('cache-control'),'no-store');
 const preview=await request('/download/meta.json',{upstream:()=>json({...release,prerelease:true})});assert.equal(preview.response.status,503);
});

test('legacy host redirects and Pages previews retain the existing host policy',async()=>{
 const old=await request('/kleveland?ref=legacy',{host:'https://producer.boomin.ai'});
 assert.equal(old.response.status,301);assert.equal(old.response.headers.get('location'),'https://producer.dev/kleveland?ref=legacy');assert.equal(old.calls.length,0);
 const preview=await request('/kleveland',{host:'https://candidate.producer-site.pages.dev'});
 assert.equal(preview.response.status,200);assert.equal(preview.calls.length,1);assert.match(preview.text,/canonical" href="https:\/\/producer.dev\/kleveland/);
});
