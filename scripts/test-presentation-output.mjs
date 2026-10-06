import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { startProofBridge } from './presentation-proof/bridge.mjs';
import { loadRuntime } from './presentation-proof/runtime.mjs';
import { connectPage } from './presentation-proof/cdp.mjs';
import { buildNative } from './presentation-proof/build-native.mjs';
const { RehearsalSession, AFTER_HOURS, outputProjection }=await loadRuntime();
const sharedSource=process.argv.includes('--shared-source');
let session=new RehearsalSession(AFTER_HOURS,'native-proof');
let revisionBase=0;
const project=()=>({...outputProjection(session.package,session.snapshot()),revision:revisionBase+session.snapshot().revision});
const bridge=await startProofBridge(project());
const playwrightModule=process.env.PRODUCER_PLAYWRIGHT_MODULE || '/private/tmp/rene-browser/node_modules/playwright/index.mjs';
const { chromium }=await import(playwrightModule);
const {ws:Socket}=createRequire(playwrightModule)('playwright-core/lib/utilsBundle');
const wait=async (fn,timeout=15000)=>{const until=Date.now()+timeout;let error;while(Date.now()<until){try{const value=await fn();if(value)return value;}catch(e){error=e;}await delay(100);}throw new Error(`Proof timed out: ${error?.message||'condition'}`);};
const status=async(url,options)=> (await fetch(url,options)).status;
let browser,native,finished=false,exitPromise,nativeLog='';
try{
 assert.equal(await status(bridge.projectionUrl),200);
 assert.equal(await status(bridge.projectionUrl,{method:'POST',body:'{}'}),405);
 assert.equal(await status(bridge.projectionUrl,{headers:{Origin:'https://untrusted.example'}}),403);
 assert.equal(await status(bridge.projectionUrl,{headers:{'Sec-Fetch-Site':'cross-site'}}),403);
 assert.equal(await new Promise((resolve,reject)=>{const req=request(bridge.projectionUrl,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();}),404);
 assert.equal(await status(bridge.projectionUrl+'?leak=1'),404);
 assert.equal(await status(bridge.projectionUrl.replace(/\/output\/[a-f0-9]+\//,'/output/wrong/')),404);
 assert.equal(await status(bridge.foregroundUrl.replace(/foreground$/,'action')),404);
 const headers=(await fetch(bridge.foregroundUrl)).headers;
 assert.equal(headers.get('access-control-allow-origin'),null);assert.match(headers.get('permissions-policy'),/microphone=\(\)/);
 assert.throws(()=>bridge.publish(project()),/Stale/);
 console.log('PASS: scoped GET-only capability; origin/host/method/routes; no action endpoint');
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:720}});await page.goto(bridge.foregroundUrl);
 await wait(()=>page.evaluate(()=>window.__presentationProof?.prepared));
 let prepared=await page.evaluate(()=>window.__presentationProof.prepared);
 assert.equal(prepared.slots.length,2);assert.ok(Math.abs(prepared.slots[0].x-51.2)<0.1);
 const frame=page.frames().find(f=>f.parentFrame());
 assert.equal(await frame.evaluate(()=>location.origin),'null');
 assert.equal(await frame.evaluate(()=>typeof window.__TAURI_INTERNALS__),'undefined');
 assert.equal(await frame.evaluate(()=>{try{return parent.document.title;}catch{return 'blocked';}}),'blocked');
 assert.equal(await frame.evaluate(async()=>{try{await fetch('https://untrusted.example');return 'unsafe';}catch{return 'blocked';}}),'blocked');
 assert.equal(await frame.evaluate(()=>getComputedStyle(document.querySelector('[data-slot]')).backgroundColor),'rgba(0, 0, 0, 0)');
 assert.equal(await frame.evaluate(()=>getComputedStyle(document.querySelector('#canvas > div')).backgroundColor),'rgba(0, 0, 0, 0)');
 console.log('PASS: shared output renderer, transparent native slots, opaque frame and blocked network');
 await browser.close();browser=null;
 const sourceOnly=process.argv.includes('--native-sources');
 if(!process.argv.includes('--native')&&!sourceOnly){bridge.revoke();assert.equal(await status(bridge.foregroundUrl),404);console.log('PASS: capability revocation');process.exitCode=0;}
 else{
  const built=await buildNative();console.log('Native proof artifacts:',built.dir);
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  native=spawn(built.executable,[sourceOnly?(sharedSource?'pattern-shared':'pattern'):bridge.backgroundUrl,bridge.foregroundUrl,built.dir,`--remote-debugging-port=${port}`],{stdio:['ignore','pipe','pipe']});
  exitPromise=new Promise(resolve=>native.once('exit',(code,signal)=>{finished=true;resolve({code,signal});}));
  for(const stream of [native.stdout,native.stderr])stream.on('data',data=>{nativeLog=(nativeLog+data.toString()).slice(-150000);});
  let fg,bg;
  if(sourceOnly){
    await wait(()=>nativeLog.includes('NATIVE_READY'));
    browser=await chromium.launch({channel:'chrome',headless:true});
    fg=await browser.newPage({viewport:{width:1280,height:720}});bg=await browser.newPage({viewport:{width:1280,height:720}});
    await fg.goto(bridge.foregroundUrl);await bg.goto(bridge.backgroundUrl);
  }else{
    await wait(async()=>{if(finished)throw new Error('Native process exited');const r=await fetch(`http://127.0.0.1:${port}/json/list`);return (await r.json()).some(p=>p.url===bridge.foregroundUrl);},45000);
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    fg=await connectPage(targets.find(p=>p.url===bridge.foregroundUrl).webSocketDebuggerUrl,Socket);
    bg=await connectPage(targets.find(p=>p.url===bridge.backgroundUrl).webSocketDebuggerUrl,Socket);
  }
  async function ready(rev){await wait(async()=>{const a=await fg.evaluate(()=>window.__presentationProof?.prepared),b=await bg.evaluate(()=>window.__presentationProof?.prepared);return a?.revision===rev&&b?.revision===rev?a:null;});return await fg.evaluate(()=>window.__presentationProof.prepared);}
  async function capture(stage){
    const p=await ready(project().revision);
    await writeFile(join(built.dir,'command.next'),JSON.stringify({stage,revision:p.revision,slots:p.slots}));await rename(join(built.dir,'command.next'),join(built.dir,'command.json'));
    await wait(async()=>{await access(join(built.dir,`frame-${stage}.bgra`));return (await readFile(join(built.dir,`frame-${stage}.bgra`))).length===1280*720*4;});
    const receipt=JSON.parse(await readFile(join(built.dir,`native-${stage}.json`),'utf8'));
    assert.equal(receipt.revision,p.revision);
    for(const slot of p.slots){const actual=receipt.slots.find(s=>s.slotId===slot.slotId);for(const key of ['x','y','width','height'])assert.ok(Math.abs(actual[key]-slot[key])<=1,`native ${key} readback mismatch`);}
    const raw=await readFile(join(built.dir,`frame-${stage}.bgra`));await writeFile(join(built.dir,`frame-${stage}.png`),png(raw,1280,720));
    for(const slot of p.slots){const x=Math.floor(slot.x+slot.width/2),y=Math.floor(slot.y+slot.height/2),pixel=rgba(raw,x,y);let expected=slot.slotId==='host'||sharedSource?[32,192,96]:[240,128,48];if(slot.appearance?.grayscale===1){const luma=expected[0]*.2126+expected[1]*.7152+expected[2]*.0722;expected=[luma,luma,luma];}if(slot.appearance?.opacity!==undefined){const a=slot.appearance.opacity,bg=rgba(raw,10,650);expected=expected.map((v,i)=>v*a+bg[i]*(1-a));}for(let i=0;i<3;i++)assert.ok(Math.abs(pixel[i]-expected[i])<8,`native ${slot.slotId} center ${pixel} expected ${expected}`);
      // At midpoint, allow one output pixel of rasterization error at each edge.
      if(slot.appearance?.shape!=='circle'&&!slot.appearance?.outlineWidth) for(const offset of [-2,2]){const rgb=rgba(raw,Math.floor(slot.x)+offset,y);const isPattern=expected.every((v,i)=>Math.abs(v-rgb[i])<80);assert.equal(isPattern,offset>0,'native slot left edge');}
    }
    // Native pattern is visible through FG; title graphic appears over BG.
    let ink=0;for(let y=43;y<75;y++)for(let x=51;x<280;x++){const px=rgba(raw,x,y);if(px[0]>140&&px[2]>140)ink++;}if(!sourceOnly)assert.ok(ink>60,'CEF title absent from native output');
    console.log(`PASS: actual OBS stage ${stage}, ${p.slots.length} native slots, rectangle readback and pixel edges${sourceOnly?'':' plus CEF graphics/alpha'}`);
    return {raw,prepared:p};
  }
  await capture(1);
  if(!sourceOnly){
  const cefFrame=await wait(()=>fg.child());
  assert.equal(await cefFrame.evaluate(()=>{try{return parent.document.title;}catch{return 'blocked';}}),'blocked');
  assert.equal(await cefFrame.evaluate(()=>typeof window.__TAURI_INTERNALS__),'undefined');
  assert.equal(await cefFrame.evaluate(async()=>{try{await fetch('https://untrusted.example');return 'unsafe';}catch{return 'blocked';}}),'blocked');
  assert.equal(await fg.evaluate(()=>new Promise(resolve=>{
    if(!window.obsstudio)return resolve('absent');
    window.obsstudio.getControlLevel(resolve);
  })),0,'CEF browser must have no OBS control privileges');
  assert.equal(await cefFrame.evaluate(async()=>{
    try{const media=await navigator.mediaDevices.getUserMedia({video:true,audio:true});media.getTracks().forEach(t=>t.stop());return 'unsafe';}
    catch{return 'blocked';}
  }),'blocked','read-only renderer must not acquire capture devices');
  console.log('PASS: isolation in actual OBS CEF renderer');
  }
  session.send({type:'control',action:{type:'layout.select',layoutId:'solo'}});bridge.publish(project());await capture(2);
  session.send({type:'control',action:{type:'layout.select',layoutId:'conversation'}});bridge.publish(project());await capture(3);
  if(sourceOnly){
    const doc=structuredClone(AFTER_HOURS);
    for(const layout of doc.set.layouts)for(const n of layout.root.children)if(n.type==='slot')n.appearance=sharedSource&&n.slotId==='guest'?{}:{shape:'circle',grayscale:1,outlineWidth:12,outlineColor:'#ffffff'};
    revisionBase=project().revision+1;session=new RehearsalSession(doc,'appearance-proof');
    bridge.publish(project());
    const {raw,prepared:p}=await capture(4);
    for(const slot of p.slots){
      if(sharedSource&&slot.slotId==='guest')continue;
      const cx=slot.x+slot.width/2,cy=slot.y+slot.height/2,r=Math.min(slot.width,slot.height)/2;
      const border=rgba(raw,Math.floor(cx),Math.floor(cy-r+5));assert.ok(border.slice(0,3).every(c=>c>235),'white outline absent');
      const corner=rgba(raw,Math.floor(slot.x+10),Math.floor(slot.y+10));assert.ok(corner[1]<70,'circle did not mask corner');
    }
    console.log('PASS: native circle crop, inside outline, grayscale and transparent corners');
    if(sharedSource)console.log('PASS: one native capture, independent circle/grayscale and original-color rectangular placements; no capture filters or wrapper audio');
    const rounded=structuredClone(AFTER_HOURS);
    for(const layout of rounded.set.layouts)for(const n of layout.root.children)if(n.type==='slot')n.appearance={cornerRadius:64,outlineWidth:6,outlineColor:'#ff0000',opacity:0.5};
    revisionBase=project().revision+1;session=new RehearsalSession(rounded,'rounded-proof');bridge.publish(project());
    const roundedFrame=await capture(5);
    for(const slot of roundedFrame.prepared.slots){
      const corner=rgba(roundedFrame.raw,Math.floor(slot.x+4),Math.floor(slot.y+4));assert.ok(corner[1]<60,'rounded corner not masked');
      const outline=rgba(roundedFrame.raw,Math.floor(slot.x+slot.width/2),Math.floor(slot.y+3));assert.ok(outline[0]>100&&outline[1]<40,'colored inside outline absent');
    }
    console.log('PASS: native corner radius, colored outline and opacity');
  }
  bridge.revoke();await wait(()=>fg.evaluate(()=>!!window.__presentationProof?.error));assert.equal(await fg.evaluate(()=>document.querySelectorAll('iframe').length),0);console.log('PASS: revoked native output clears graphics');
  await fg.close();await bg.close();
  await writeFile(join(built.dir,'command.next'),JSON.stringify({stop:true}));await rename(join(built.dir,'command.next'),join(built.dir,'command.json'));
  if(!sourceOnly){
    await wait(()=>nativeLog.includes('NATIVE_GRAPH_RELEASED'));
    await wait(async()=>{const response=await fetch(`http://127.0.0.1:${port}/json/list`);return (await response.json()).length===0;});
    await writeFile(join(built.dir,'command.next'),JSON.stringify({shutdown:true}));await rename(join(built.dir,'command.next'),join(built.dir,'command.json'));
  }
  const result=await wait(async()=>finished?await exitPromise:null);assert.equal(result.code,0);console.log('PASS: isolated native engine shutdown');
 }
}finally{
 if(native&&!finished){native.kill('SIGTERM');await Promise.race([exitPromise,delay(3000)]);if(!finished)native.kill('SIGKILL');}
 if(browser)await browser.close().catch(()=>{});
 await bridge.close();
 if(nativeLog)await writeFile('/private/tmp/producer-presentation-native-proof.log',nativeLog.replaceAll(/\/output\/[a-f0-9]{64}\//g,'/output/REDACTED/'));
}
function rgba(raw,x,y){const i=(y*1280+x)*4;return [raw[i+2],raw[i+1],raw[i],raw[i+3]];}
function png(raw,w,h){
 const rows=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){for(let x=0;x<w;x++){const from=(y*w+x)*4,to=y*(w*4+1)+1+x*4;rows[to]=raw[from+2];rows[to+1]=raw[from+1];rows[to+2]=raw[from];rows[to+3]=255;}}
 const crc=buf=>{let c=0xffffffff;for(const b of buf){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const t=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
