/** Edge contract tests. All upstream and ASSETS responses are fixtures;
 * nothing is fetched from Boomin/GitHub or published to a real site. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../site/_worker.js';

const canonical='https://producer.dev';
const identityOrigin='https://api.boomin.ai';
const publication={id:'not-reflected',handle:'kleveland',slug:'internetdj',title:'Internet DJ',description:'An original live music Set.',status:'published',visibility:'public',revision:2,version:1,sha256:'a'.repeat(64),byte_length:2048,layout_count:6,orientations:['landscape','portrait'],url:'https://ignored.invalid',download_url:'https://ignored.invalid/download',preview_url:null,og_image_url:'https://ignored.invalid/og.png'};
const publicBrand={handle:'kleveland',name:'Kleveland',bio:'Make something worth watching.',sets:[publication]};
const detail={profile:{handle:'kleveland',name:'Kleveland',bio:publicBrand.bio},publication};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function request(path,{method='GET',headers={},upstream=input=>json(String(input).includes('/sets/')?detail:publicBrand),host=canonical}={}){
 const calls=[],assets=[],oldFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init});return upstream(input,init);};
 try{
  const req=new Request(host+path,{method,headers});
  const response=await worker.fetch(req,{ASSETS:{fetch:async original=>{assets.push(original);return new Response('STATIC:'+new URL(original.url).pathname);}}});
  const text=await response.text();
  return {response,text,calls,assets};
 }finally{globalThis.fetch=oldFetch;}
}
function privateCache(response,expectedEtag=null){
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 assert.equal(response.headers.get('set-cookie'),null);
 assert.equal(response.headers.get('etag'),expectedEtag);
}

test('canonical public brand renders a Producer profile with a fixed anonymous issuer',async()=>{
 const r=await request('/kleveland');
 assert.equal(r.response.status,200);assert.equal(r.assets.length,0);assert.equal(r.calls.length,1);
 assert.equal(r.calls[0].url,identityOrigin+'/v1/connect/producer/kleveland');
 assert.equal(r.calls[0].init.method,'GET');assert.equal(r.calls[0].init.redirect,'manual');assert.equal(r.calls[0].init.credentials,'omit');
 assert.equal(r.calls[0].init.cf.cacheTtl,0);assert.equal(r.calls[0].init.cf.cacheEverything,false);
 assert.match(r.text,/<h1>Kleveland<\/h1>/);assert.match(r.text,/@kleveland/);assert.match(r.text,/href="\/kleveland\/set\/internetdj"/);
 assert.match(r.text,/rel="canonical" href="https:\/\/producer.dev\/kleveland"/);
 assert.match(r.text,/Sets by Kleveland/);assert.match(r.text,/og:image" content="https:\/\/producer.dev\/kleveland\/og.png/);assert.doesNotMatch(r.text,/<script|<iframe|<img(?! class="brand-mark")/);
 privateCache(r.response);assert.match(r.response.headers.get('content-security-policy'),/default-src 'none'/);
});

test('query/header credentials, cookies, Range and caller-selected origins never reach the public issuer',async()=>{
 const r=await request('/kleveland?token=PRIVATE_QUERY&url=https://attacker.invalid/private&brand_id=foreign',{
  headers:{Authorization:'Bearer PRIVATE_TOKEN',Cookie:'session=PRIVATE_COOKIE','X-Brand-Id':'foreign','X-Forwarded-Host':'attacker.invalid',Range:'bytes=0-5','If-None-Match':'private-etag'},
 });
 assert.equal(r.response.status,200);assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,identityOrigin+'/v1/connect/producer/kleveland');
 assert.deepEqual(r.calls[0].init.headers,{'Accept':'application/json','Cache-Control':'no-cache'});
 assert.doesNotMatch(r.text,/PRIVATE_|attacker\.invalid|foreign|private-etag/);privateCache(r.response);
});

test('only explicit safe text is rendered, never untrusted markup, URLs, IDs or future fields',async()=>{
 const r=await request('/kleveland',{upstream:()=>json({
  ...publicBrand,name:'<img src=x onerror="boom()"> & \'hello\'',bio:'</main><iframe src="https://tracker.invalid">',
   avatar_url:'https://tracker.invalid/avatar',links:[{url:'javascript:PRIVATE_LINK'}],token:'PRIVATE_SECRET',
  private_workspace:{token:'PRIVATE_WORKSPACE'},sets:[{...publication,download_url:'file:///Users/owner/private.set.json'}],
 })});
 assert.equal(r.response.status,200);assert.match(r.text,/&lt;img src=x onerror=&quot;boom\(\)&quot;&gt; &amp; &#39;hello&#39;/);
 assert.doesNotMatch(r.text,/<script|<iframe|<img(?! class="brand-mark")|javascript:|PRIVATE_SECRET|PRIVATE_WORKSPACE|PRIVATE_LINK|file:|public-brand-id/);
 assert.equal(r.calls.length,1);
});

test('HEAD checks the same identity and returns no body with the same safe page headers',async()=>{
 const get=await request('/kleveland'),head=await request('/kleveland',{method:'HEAD'});
 assert.equal(head.response.status,200);assert.equal(head.text,'');assert.equal(head.calls.length,1);assert.equal(head.calls[0].init.method,'GET');
 for(const key of ['content-type','cache-control','content-security-policy','referrer-policy','x-content-type-options'])assert.equal(head.response.headers.get(key),get.response.headers.get(key));
});

for(const path of ['/Kleveland','/kleveland/','/KLEVELAND/?token=PRIVATE_QUERY','/Kleveland/SET/InternetDJ/','/kleveland/set/internetdj/DOWNLOAD/','/Kleveland/SETS/InternetDJ/']){
 test('case/trailing-slash normalization does not fetch identity or reflect query: '+path,async()=>{
  const r=await request(path);assert.equal(r.response.status,308);assert.equal(r.calls.length,0);assert.equal(r.assets.length,0);
  assert.equal(r.response.headers.get('location'),canonical+(/\/sets?\//.test(path.toLowerCase())?'/kleveland/set/internetdj'+(path.toLowerCase().includes('/download')?'/download':''):'/kleveland'));
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
  ()=>json({...publicBrand,handle:'other-brand'}),
  ()=>json({...publicBrand,name:42}),
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
  const r=await request('/kleveland',{upstream});assert.equal(r.response.status,503);assert.equal(r.calls.length,1);assert.ok(r.text.length<20000);privateCache(r.response);
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

test('published Set page uses canonical routes, metadata and import instructions without Set execution',async()=>{
 const r=await request('/kleveland/set/internetdj');
 assert.equal(r.response.status,200);assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,identityOrigin+'/v1/connect/producer/kleveland/sets/internetdj');
 assert.match(r.text,/<h1>Internet DJ<\/h1>/);assert.match(r.text,/Download Set/);assert.match(r.text,/Files → Import Set/);
 assert.match(r.text,/href="\/kleveland\/set\/internetdj\/download"/);assert.match(r.text,/href="\/kleveland\/sets"/);
 assert.match(r.text,/og:image" content="https:\/\/producer.dev\/kleveland\/set\/internetdj\/og.png"/);
 assert.match(r.text,/og:image:type" content="image\/png"/);assert.match(r.text,/og:image:width" content="1200"/);
 assert.match(r.text,/<span>Version<\/span><strong>1<\/strong>/);assert.doesNotMatch(r.text,/<span>Version<\/span><strong>2<\/strong>/);
 assert.match(r.text,/6 layouts/);assert.match(r.text,/Vertical/);assert.match(r.text,/Landscape/);
 assert.doesNotMatch(r.text,/ignored.invalid|not-reflected|<script|<iframe|producer-media:|<img(?! class="brand-mark")/);privateCache(r.response);
});

test('Set previews use a same-origin image proxy; missing preview uses metadata artwork',async()=>{
 const r=await request('/kleveland/set/internetdj',{upstream:()=>json({...detail,publication:{...publication,preview_url:'https://tracker.invalid/preview.png'}})});
 assert.match(r.text,/<img src="\/kleveland\/set\/internetdj\/preview"/);assert.doesNotMatch(r.text,/tracker.invalid/);
 assert.match(r.response.headers.get('content-security-policy'),/img-src 'self'/);
 const fallback=await request('/kleveland/set/internetdj');assert.doesNotMatch(fallback.text,/<img(?! class="brand-mark")/);assert.match(fallback.text,/creator adds a preview/);
});

test('gallery has the same approved profile and all public Sets, including an honest empty state',async()=>{
 const gallery=await request('/kleveland/sets');assert.equal(gallery.response.status,200);assert.equal(gallery.calls[0].url,identityOrigin+'/v1/connect/producer/kleveland');
 assert.match(gallery.text,/canonical" href="https:\/\/producer.dev\/kleveland\/sets/);
 const empty=await request('/kleveland',{upstream:()=>json({...publicBrand,sets:[]})});assert.equal(empty.response.status,200);assert.match(empty.text,/No public Sets to share/);
 const filtered=await request('/kleveland',{upstream:()=>json({...publicBrand,sets:[{...publication,title:'PRIVATE_TITLE',visibility:'private'},{...publication,title:'UNLISTED_TITLE',visibility:'unlisted'},{...publication,title:'WITHDRAWN_TITLE',status:'withdrawn'}]})});
 assert.equal(filtered.response.status,200);assert.doesNotMatch(filtered.text,/PRIVATE_TITLE|UNLISTED_TITLE|WITHDRAWN_TITLE/);
});

test('unlisted detail is available by exact link but is noindex and never appears in a gallery',async()=>{
 const r=await request('/kleveland/set/internetdj',{upstream:()=>json({...detail,publication:{...publication,visibility:'unlisted'}})});
 assert.equal(r.response.status,200);assert.match(r.text,/Unlisted/);assert.match(r.response.headers.get('x-robots-tag'),/noindex/);
});

test('Set text cannot inject HTML, metadata, authored URLs or unknown fields',async()=>{
 const r=await request('/kleveland/set/internetdj',{upstream:()=>json({...detail,publication:{...publication,title:'<script>title</script>',description:'" onload="oops() <iframe>',url:'javascript:bad()',token:'PRIVATE_SECRET',orientations:['landscape','<img>']}})});
 assert.equal(r.response.status,200);assert.match(r.text,/&lt;script&gt;title&lt;\/script&gt;/);assert.match(r.text,/&quot; onload=&quot;oops\(\) &lt;iframe&gt;/);
 assert.doesNotMatch(r.text,/<script|<iframe|javascript:|PRIVATE_SECRET|<img(?! class="brand-mark")/);
});

test('unknown, private, withdrawn and foreign publication metadata fail closed, including HEAD',async()=>{
 for(const value of [null,{...publication,visibility:'private'},{...publication,status:'withdrawn'},{...publication,handle:'other'},{...publication,slug:'other'},{...publication,layout_count:NaN}])for(const method of ['GET','HEAD']){
  const r=await request('/kleveland/set/internetdj',{method,upstream:()=>json({...detail,publication:value})});assert.equal(r.response.status,404);privateCache(r.response);assert.equal(r.assets.length,0);
  assert.doesNotMatch(r.text,/Download Set|PRIVATE_SECRET/);if(method==='HEAD')assert.equal(r.text,'');
 }
});

test('every Set or image/download request rechecks visibility; no stale cached public result',async()=>{
 for(const suffix of ['', '/download','/preview','/og.png']){
  let visible=true;const upstream=()=>visible?(suffix?new Response(suffix==='/download'?'{}':'PNG',{headers:{'Content-Type':suffix==='/download'?'application/json':'image/png'}}):json(detail)):new Response('PRIVATE_ERROR',{status:404});
  const first=await request('/kleveland/set/internetdj'+suffix,{upstream});assert.equal(first.response.status,200);privateCache(first.response);
  visible=false;const withdrawn=await request('/kleveland/set/internetdj'+suffix,{upstream});assert.equal(withdrawn.response.status,404);assert.equal(withdrawn.calls.length,1);privateCache(withdrawn.response);assert.doesNotMatch(withdrawn.text,/PRIVATE_ERROR|Download Set/);
 }
});

for(const [suffix,apiSuffix,type,data] of [['/download','/download','application/json','{"set":{"title":"Original"}}'],['/preview','/preview','image/png','PNG'],['/og.png','/og.png','image/png','OG_PNG']]){
 test('bounded fixed-origin '+suffix+' proxy preserves safe content and HEAD',async()=>{
  for(const method of ['GET','HEAD']){
   let cancelled=false;const r=await request('/kleveland/set/internetdj'+suffix+'?url=https://attacker.invalid',{method,headers:{Authorization:'Bearer PRIVATE',Cookie:'private=x',Range:'bytes=0-2'},upstream:()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(data));c.close();},cancel(){cancelled=true;}}),{headers:{'Content-Type':type,'Set-Cookie':'private=x','Content-Disposition':'inline; filename="UNTRUSTED"','ETag':'private'}})});
   assert.equal(r.response.status,200);assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,identityOrigin+'/v1/connect/producer/kleveland/sets/internetdj'+apiSuffix);
   assert.deepEqual(r.calls[0].init.headers,{Accept:suffix==='/preview'?'image/png,image/jpeg':type,'Cache-Control':'no-cache'});assert.equal(r.calls[0].init.credentials,'omit');assert.equal(r.calls[0].init.redirect,'manual');privateCache(r.response);
   assert.equal(r.response.headers.get('content-type'),type);assert.equal(r.text,method==='HEAD'?'':data);
   assert.equal(r.response.headers.get('content-disposition'),suffix==='/download'?'attachment; filename="internetdj.set.json"':null);
   if(method==='HEAD')assert.equal(cancelled,true);
  }
 });
}

test('profile PNG proxies its dedicated endpoint and never returns the profile JSON as an image',async()=>{
 const r=await request('/kleveland/og.png',{upstream:()=>new Response('PNG',{headers:{'Content-Type':'image/png'}})});
 assert.equal(r.response.status,200);assert.equal(r.calls[0].url,identityOrigin+'/v1/connect/producer/kleveland/og.png');privateCache(r.response);
 const wrong=await request('/kleveland/og.png');assert.equal(wrong.response.status,503);
});

test('binary errors, redirect, unsupported image MIME and oversized streams fail closed',async()=>{
 for(const suffix of ['/download','/preview','/og.png'])for(const upstream of [
  ()=>new Response('PRIVATE',{status:404}),()=>new Response('PRIVATE',{status:410}),()=>new Response('PRIVATE',{status:500}),
  ()=>new Response(null,{status:302,headers:{Location:'https://attacker.invalid'}}),
  ()=>new Response('<svg onload="PRIVATE()">',{headers:{'Content-Type':'image/svg+xml'}}),
  ()=>new Response('PRIVATE',{headers:{'Content-Type':'text/html'}}),
  ()=>new Response('PRIVATE',{headers:{'Content-Type':suffix==='/download'?'application/json':'image/png','Content-Length':'99999999'}}),
 ]){
  const r=await request('/kleveland/set/internetdj'+suffix,{upstream});assert.ok([404,503].includes(r.response.status));assert.equal(r.calls.length,1);privateCache(r.response);assert.equal(r.response.headers.get('location'),null);assert.equal(r.response.headers.get('content-disposition'),null);assert.doesNotMatch(r.text,/PRIVATE|attacker/);
 }
 const large=await request('/kleveland/set/internetdj/preview',{upstream:()=>new Response(new Uint8Array(524289),{headers:{'Content-Type':'image/png'}})});assert.equal(large.response.status,503);
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

test('plural Set aliases redirect to singular canonical routes without a lookup',async()=>{
 for(const suffix of ['', '/download','/preview','/og.png']){
  const r=await request('/kleveland/sets/internetdj'+suffix+'?token=PRIVATE');assert.equal(r.response.status,308);assert.equal(r.response.headers.get('location'),canonical+'/kleveland/set/internetdj'+suffix);assert.equal(r.calls.length,0);assert.doesNotMatch(r.response.headers.get('location'),/PRIVATE/);
 }
});
test('square orientation remains visible and unknown orientations are never reflected',async()=>{
 const r=await request('/kleveland/set/internetdj',{upstream:()=>json({...detail,publication:{...publication,orientations:['square','portrait','landscape','PRIVATE_ORIENTATION']}})});
 assert.equal(r.response.status,200);assert.match(r.text,/>Square<\/span>/);assert.doesNotMatch(r.text,/PRIVATE_ORIENTATION/);
});
test('malformed UTF-8 and malformed profile collection contracts fail closed',async()=>{
 for(const upstream of [()=>new Response(new Uint8Array([123,255,125]),{headers:{'Content-Type':'application/json'}}),()=>json({...publicBrand,sets:{private:'not a list'}}),()=>json({...publicBrand,sets:Array.from({length:201},()=>publication)})]){
  const r=await request('/kleveland',{upstream});assert.equal(r.response.status,503);assert.equal(r.assets.length,0);privateCache(r.response);
 }
});

test('binary GET and genuine upstream HEAD preserve exact size and normalized SHA-256 headers',async()=>{
 const digest='Ab'.repeat(32),data='{"package":"ready"}';
 for(const method of ['GET','HEAD'])for(const tag of [digest,`"${digest}"`]){
  const r=await request('/kleveland/set/internetdj/download',{method,headers:{'If-None-Match':'PRIVATE_VALIDATOR',Range:'bytes=1-2'},upstream:(_input,init)=>{
   assert.equal(init.method,method);assert.deepEqual(init.headers,{Accept:'application/json','Cache-Control':'no-cache'});
   return new Response(method==='HEAD'?null:data,{headers:{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data)),'ETag':tag,'X-Content-SHA256':digest}});
  }});
  assert.equal(r.response.status,200);assert.equal(r.text,method==='HEAD'?'':data);assert.equal(r.response.headers.get('content-length'),String(Buffer.byteLength(data)));
  assert.equal(r.response.headers.get('etag'),`"${digest.toLowerCase()}"`);assert.equal(r.response.headers.get('x-content-sha256'),digest.toLowerCase());privateCache(r.response,`"${digest.toLowerCase()}"`);
 }
});
test('GET computes actual payload length; untrusted or malformed digest headers are never copied',async()=>{
 for(const [etag,sha]of [['private-tag','PRIVATE_DIGEST'],['"'+('a'.repeat(63))+'"','b'.repeat(65)],['W/"'+('a'.repeat(64))+'"','https://attacker.invalid/token']]){
  const r=await request('/kleveland/set/internetdj/download',{upstream:()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'1','ETag':etag,'X-Content-SHA256':sha}})});
  assert.equal(r.response.status,200);assert.equal(r.response.headers.get('content-length'),'2');assert.equal(r.response.headers.get('etag'),null);assert.equal(r.response.headers.get('x-content-sha256'),null);privateCache(r.response);
 }
});
test('HEAD cannot reflect invalid or over-budget lengths even with valid digest headers',async()=>{
 for(const length of ['-1','8.5','unknown','8388609']){
  const r=await request('/kleveland/set/internetdj/download',{method:'HEAD',upstream:()=>new Response(null,{headers:{'Content-Type':'application/json','Content-Length':length,'ETag':'"'+('a'.repeat(64))+'"','X-Content-SHA256':'b'.repeat(64)}})});
  assert.equal(r.response.status,503);assert.equal(r.text,'');assert.equal(r.response.headers.get('content-length'),null);assert.equal(r.response.headers.get('x-content-sha256'),null);privateCache(r.response);
 }
});
