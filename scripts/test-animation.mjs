import fs from 'node:fs';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {parsePackage} from './src/features/presentation/schema';export {clockPosition,sampleTrack} from './src/features/presentation/animation';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,parsePackage,clockPosition,sampleTrack}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const file='/Users/klevelandbishop/Documents/boomin/docs/shows/animation-foundation.show.json',doc=JSON.parse(fs.readFileSync(file));
for(const mutate of [d=>d.set.layouts[0].animation.tracks[0].keyframes[1].atMs=0,d=>d.set.layouts[0].animation.tracks[1].keyframes[0].value=2,d=>d.set.layouts[0].animation.tracks[0].target='missing',d=>d.set.layouts[0].animation.tracks[0].target=d.set.layouts[0].root.id]){const bad=structuredClone(doc);mutate(bad);assert.throws(()=>parsePackage(bad));}
const track={target:'test',property:'x',keyframes:[{atMs:0,value:0},{atMs:1000,value:100}],easing:'linear',loop:'pingpong'};assert.equal(sampleTrack(track,1500),50);
let now=100000;const realNow=Date.now;Date.now=()=>now;
const session=new RehearsalSession(doc);session.send({type:'control',action:{type:'show.start'}});now+=500;assert.equal(clockPosition(session.snapshot().animationClock).segmentMs,500);
session.send({type:'pause',paused:true});now+=1000;assert.equal(clockPosition(session.snapshot().animationClock).segmentMs,500);
session.send({type:'seek',milliseconds:200});assert.equal(clockPosition(session.snapshot().animationClock).segmentMs,200);
session.send({type:'pause',paused:false});now+=300;assert.equal(clockPosition(session.snapshot().animationClock).segmentMs,500);
session.send({type:'control',action:{type:'show.next'}});assert.equal(clockPosition(session.snapshot().animationClock).segmentMs,0);assert.equal(clockPosition(session.snapshot().animationClock).positionMs,500);
session.send({type:'reset'});assert.equal(session.snapshot().animationClock.running,false);assert.equal(session.snapshot().animationClock.positionMs,0);assert.ok(!JSON.stringify(session.exportPreparedPackage()).includes('anchorMs'));Date.now=realNow;
console.log('PASS bounded animation authoring, easing, monotonic anchors, pause/resume/seek, segment entry, reset and portable JSON');
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
for(const engine of [chromium,webkit]){
 const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://localhost:1420/scripts/animation-browser.html');await page.getByLabel('Load animation demo').setInputFiles(file);
  const frame=page.frameLocator('iframe').first(),camera=frame.locator('[data-node$="/camera"]').first();await camera.waitFor();
  const geometry=()=>camera.evaluate(el=>{const s=getComputedStyle(el);return {x:parseFloat(s.left),w:parseFloat(s.width)};});
  await page.getByRole('button',{name:'Rehearse',exact:true}).click();await page.getByRole('button',{name:'Start show',exact:true}).first().click();await page.waitForTimeout(250);const a=await geometry();await page.waitForTimeout(300);const b=await geometry();assert.ok(b.x<a.x&&b.w>a.w);
  await page.getByRole('button',{name:'Pause',exact:true}).first().click();await page.waitForTimeout(150);const paused=await geometry();await page.waitForTimeout(250);assert.deepEqual(await geometry(),paused);
  await page.getByRole('button',{name:'Set edit',exact:true}).click();await page.getByText('Animation',{exact:true}).click();await page.getByLabel('Animation position').evaluate(el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'200');el.dispatchEvent(new Event('input',{bubbles:true}));});await page.getByRole('button',{name:'Close preview',exact:true}).click();await page.waitForTimeout(150);assert.ok((await geometry()).x>paused.x);
  await page.getByRole('button',{name:'Resume',exact:true}).first().click();await page.getByRole('button',{name:'Next',exact:true}).first().click();await page.waitForTimeout(150);assert.equal(await page.getByTestId('phase').textContent(),'focus');
  await page.getByRole('button',{name:'Pause',exact:true}).first().click();await page.waitForTimeout(100);const old=frame.locator('[data-transition="crossfade"]');assert.equal(await old.count(),1);const opacity=await old.evaluate(el=>getComputedStyle(el).opacity);await page.waitForTimeout(250);assert.equal(await old.evaluate(el=>getComputedStyle(el).opacity),opacity);
  await page.getByRole('button',{name:'Resume',exact:true}).first().click();await page.waitForTimeout(1100);assert.equal(await old.count(),0);
  await page.getByRole('button',{name:'Reset',exact:true}).click();await page.waitForTimeout(180);assert.equal(await page.getByTestId('phase').textContent(),'opening');assert.equal(await old.count(),0);assert.equal(Math.round((await geometry()).x),900);assert.deepEqual(errors,[]);
  console.log('PASS browser title/camera motion, pause/seek, crossfade pause/resume and reset: '+engine.name());
 }finally{await browser.close();}
}
