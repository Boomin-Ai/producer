import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from '../tools/producer-mcp/node_modules/playwright-core/index.mjs';
const built=await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/features/presentation/rehearsal';export * from './src/features/presentation/projection';"},bundle:true,platform:'node',format:'esm',write:false});
const {RehearsalSession,outputProjection}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const doc=JSON.parse(readFileSync('docs/shows/classic.json')),session=new RehearsalSession(doc);
session.send({type:'control',action:{type:'layout.select',layoutId:'break-landscape'}});
const nodes=outputProjection(doc,session.snapshot()).root.children.filter(n=>n.type==='scene3d');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:700}});await page.setContent('<body style="margin:0;background:#141a20"></body>');
 await page.addScriptTag({path:'src/features/presentation/vendor/scene3d-renderer.js'});
 const reports=[];
 for(const role of ['frame','ring']){
  const node=nodes.find(n=>n.scene3d.world.dj.role===role);
  await page.evaluate(async({node,role})=>{
   document.body.replaceChildren();const canvas=document.createElement('canvas');document.body.append(canvas);
   window.control={revision:1,anchor:Date.now(),elapsed:0,paused:false,cue:'neutral',rendering:true,music:{...node.scene3d.music,motion:role==='frame'?.7:0}};
   window.receipts=[];
   window.world=await ProducerScene3d.mountWorld(canvas,node.scene3d.world,{pass:'foreground',width:role==='frame'?960:500,height:role==='frame'?540:500,control:window.control,onStatus:s=>window.receipts.push({at:performance.now(),revision:s.revision,ready:s.ready})});
  },{node,role});
  await page.waitForFunction(()=>window.world.status().frames>=3);
  if(role==='frame'){
   const first=await page.evaluate(()=>window.world.status().frames);await page.waitForTimeout(200);assert((await page.evaluate(()=>window.world.status().frames))>first);
   await page.evaluate(()=>{window.control={...window.control,revision:2,music:{...window.control.music,motion:0}};window.world.update(window.control);});
   await page.waitForTimeout(100);const paused=await page.evaluate(()=>window.world.status().frames);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.world.status().frames),paused,'Pause motion must stop frame rendering');
  }else{
   const quiet=await page.locator('canvas').screenshot();
   await page.evaluate(()=>{window.audioTimer=setInterval(()=>window.world.audio({energy:.6,bass:.5,high:.2,bands:Array(8).fill(.5),wave:Array.from({length:32},(_,i)=>Math.sin(i*.9)*.7)}),40);});
   await page.waitForTimeout(150);const active=await page.locator('canvas').screenshot();assert.notDeepEqual(active,quiet,'Music waveform must change actual pixels');assert((await page.evaluate(()=>window.world.status().music.energy))>.3);
   await page.evaluate(()=>clearInterval(window.audioTimer));await page.waitForTimeout(1200);assert((await page.evaluate(()=>window.world.status().music.energy))<.005,'Waveform must settle when the music feed stops');
  }
  await page.evaluate(()=>{window.control={...window.control,revision:3,rendering:false};window.world.update(window.control);});
  await page.waitForTimeout(150);const hidden=await page.evaluate(()=>window.world.status().frames);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.world.status().frames),hidden,'Cached invisible surface must stop drawing');
  // Native first-pixel readiness expires receipts after four seconds. A hidden
  // cached surface must remain provably alive without submitting GPU work.
  await page.waitForTimeout(4300);
  assert(await page.evaluate(()=>performance.now()-window.receipts.at(-1).at<1800),'Hidden renderer must keep native readiness receipts fresh');
  assert.equal(await page.evaluate(()=>window.world.status().frames),hidden,'Readiness heartbeats must not redraw cached surfaces');
  await page.evaluate(()=>{window.control={...window.control,revision:4,rendering:true};window.world.update(window.control);});
  await page.waitForFunction(()=>window.receipts.at(-1).ready&&window.receipts.at(-1).revision===4);
  assert((await page.evaluate(()=>window.world.status().frames))>hidden,'Returning to a cached view must produce pixels for its current revision');
  const report=await page.evaluate(()=>window.world.status());assert(report.calls<=8);assert(report.triangles<30000);reports.push({role,...report});await page.evaluate(()=>window.world.dispose());
 }
 mkdirSync('/private/tmp/producer-classic-review',{recursive:true});writeFileSync('/private/tmp/producer-classic-review/graphics-proof.json',JSON.stringify(reports,null,2));
 console.log('PASS Classic GPU: real waveform pixels, stale-audio decay, paused lights, hidden-surface demand and bounded draw/geometry counts.');
}finally{await browser.close();}
