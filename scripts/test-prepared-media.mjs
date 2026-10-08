import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadRuntime} from './presentation-proof/runtime.mjs';
const {RehearsalSession,outputProjection}=await loadRuntime();
const doc=JSON.parse(fs.readFileSync('/Users/klevelandbishop/Documents/boomin/docs/shows/claude-code-media-walkthrough.json'));
const projection=outputProjection(doc,new RehearsalSession(doc).snapshot());
const each=(n,fn)=>{fn(n);n.children.forEach(c=>each(c,fn));};
each(projection.root,n=>{if(n.playback)n.playback={playing:false,positionMs:0,anchorMs:Date.now()};if(n.type==='media')n.autoplay=false;});
const frame=fs.readFileSync('src/features/presentation/frame.js','utf8');
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
for(const engine of [chromium,webkit]){
 const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});
 try{
  const page=await browser.newPage({viewport:{width:1282,height:720}});
  await page.setContent('<iframe sandbox="allow-scripts" style="width:1282px;height:720px;border:0"></iframe>');
  await page.evaluate(({frame,projection})=>{
   const iframe=document.querySelector('iframe');
   addEventListener('message',e=>{if(e.source!==iframe.contentWindow||e.data!=='presentation.ready'||window.transportPort)return;const c=new MessageChannel();window.transportPort=c.port1;c.port1.onmessage=e=>{if(e.data.type==='prepared')window.prepared=e.data;};c.port1.start();iframe.contentWindow.postMessage('presentation.connect','*',[c.port2]);c.port1.postMessage({type:'output',surface:'foreground',serial:0,projection});});
   iframe.srcdoc='<style>body{margin:0}#canvas{transform-origin:top left}</style><style id="motion"></style><div id="canvas"></div><script>'+frame+'</script>';
  },{frame,projection});
  await page.waitForFunction(()=>window.prepared);
  const video=page.frameLocator('iframe').locator('video');
  assert.equal(await video.evaluate(v=>{window.decodedVideo=v;return v.paused;}),true);
  const next=structuredClone(projection);delete next.assets;
  each(next.root,n=>{if(n.playback)n.playback={playing:true,positionMs:0,anchorMs:Date.now()};});
  await page.evaluate(projection=>window.transportPort.postMessage({type:'output',transportOnly:true,projection}),next);
  await video.evaluate(v=>new Promise((resolve,reject)=>{const until=Date.now()+4000;const tick=()=>{if(!v.paused&&v.currentTime>.15)resolve();else if(Date.now()>until)reject(new Error('Prepared clip did not start'));else setTimeout(tick,30);};tick();}));
  assert.equal(await video.evaluate(v=>v===window.decodedVideo),true,'promotion must keep the decoded video element');
  const position=await video.evaluate(v=>v.currentTime*1000);each(next.root,n=>{if(n.playback)n.playback={playing:false,positionMs:position,anchorMs:Date.now()};});
  await page.evaluate(projection=>window.transportPort.postMessage({type:'output',transportOnly:true,projection}),next);
  await page.waitForTimeout(150);assert.equal(await video.evaluate(v=>v.paused),true);
  const paused=await video.evaluate(v=>v.currentTime);await page.waitForTimeout(300);assert.ok(Math.abs(await video.evaluate(v=>v.currentTime)-paused)<.12);
  console.log('PASS paused first frame, decoder-preserving promotion, shared-clock play and pause: '+engine.name());
 }finally{await browser.close();}
}
