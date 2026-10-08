import fs from 'node:fs';import assert from 'node:assert/strict';import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {parsePackage} from './src/features/presentation/schema';export {outputProjection} from './src/features/presentation/projection';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,parsePackage,outputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const file='/Users/klevelandbishop/Documents/boomin/docs/shows/shader-lab.show.json',doc=JSON.parse(fs.readFileSync(file));
assert.equal(doc.show.phases.length,16);assert.equal(doc.set.layouts.length,32);
for(const phase of doc.show.phases){assert.ok(doc.set.layouts.some(l=>l.id===phase.id+'-portrait'));}
for(const mutate of [d=>d.set.layouts[0].root.children[0].shader.effect='arbitrary',d=>d.set.layouts[0].root.children[0].shader.intensity=10,d=>d.set.layouts[0].root.children[0].shader.colors[0]='red',d=>d.set.layouts[0].root.children[0].styles.left='5%',d=>d.set.layouts[0].root.children[0].styles.transform='rotate(5deg)',d=>d.set.layouts[0].root.styles.padding=10,d=>d.set.layouts[0].animation.tracks[0].target='title',d=>d.set.layouts[0].animation.tracks[0].keyframes[1].value=3,d=>d.set.layouts[0].animation.tracks.push({target:d.set.layouts[0].root.id,property:'opacity',keyframes:[{atMs:0,value:0},{atMs:500,value:1}]}),d=>d.set.layouts[0].root.children.push(...[1,2].map(i=>({...structuredClone(d.set.layouts[0].root.children[0]),id:'extra'+i})))]){const bad=structuredClone(doc);mutate(bad);assert.throws(()=>parsePackage(bad));}
const solo=structuredClone(doc);delete solo.show;delete solo.set.layouts[0].animation;const session=new RehearsalSession(solo);assert.equal(outputProjection(session.package,session.snapshot()).timeline.clock.running,true);assert.ok(!JSON.stringify(session.exportPreparedPackage()).includes('anchorMs'));
console.log('PASS bounded shader presets, colors, native geometry, parameter tracks, layer budget, standalone autoplay and portable JSON');
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
for(const engine of [chromium,webkit]){
 const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://localhost:1420/scripts/animation-browser.html');await page.getByLabel('Load animation demo').setInputFiles(file);
  const frame=page.frameLocator('iframe').first(),shaders=frame.locator('canvas[data-gpu="webgl"]');await shaders.first().waitFor();assert.equal(await shaders.count(),3);
  const hash=()=>shaders.first().evaluate(el=>{const gl=el.getContext('webgl'),p=new Uint8Array(el.width*el.height*4);gl.readPixels(0,0,el.width,el.height,gl.RGBA,gl.UNSIGNED_BYTE,p);let h=2166136261,lit=0;for(let i=0;i<p.length;i++){h=Math.imul(h^p[i],16777619);if(i%4!==3&&p[i]>20)lit++;}return {hash:h,lit,width:el.width,height:el.height};});
  const zero=await hash();assert.ok(zero.lit>100);assert.equal(zero.width,320);assert.equal(zero.height,180);
  await page.getByRole('button',{name:'Rehearse',exact:true}).click();await page.getByRole('button',{name:'Start show',exact:true}).first().click();await page.waitForTimeout(600);assert.notEqual((await hash()).hash,zero.hash);
  await page.getByRole('button',{name:'Pause',exact:true}).first().click();await page.waitForTimeout(100);const paused=await hash();await page.waitForTimeout(250);assert.deepEqual(await hash(),paused);
  await page.getByRole('button',{name:'Set edit',exact:true}).click();await page.getByText('Animation',{exact:true}).click();await page.getByLabel('Animation position').evaluate(el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'2400');el.dispatchEvent(new Event('input',{bubbles:true}));});await page.getByRole('button',{name:'Close preview',exact:true}).click();await page.waitForTimeout(100);assert.notEqual((await hash()).hash,paused.hash);
  await page.screenshot({path:'/private/tmp/producer-shaders-'+engine.name()+'.png'});
  await page.getByRole('button',{name:'Resume',exact:true}).first().click();await page.getByRole('button',{name:'Next',exact:true}).first().click();await page.waitForTimeout(1000);assert.equal(await page.getByTestId('phase').textContent(),'glow');assert.equal(await shaders.count(),3);
  await page.getByRole('button',{name:'Reset',exact:true}).click();await page.waitForTimeout(200);assert.deepEqual(await hash(),zero);assert.equal(await shaders.count(),3);assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Start show',exact:true}).first().click();
  for(const phase of doc.show.phases.slice(1)){
   await page.getByRole('button',{name:'Next',exact:true}).first().click();await page.waitForTimeout(900);
   assert.equal(await page.getByTestId('phase').textContent(),phase.id);assert.equal(await shaders.count(),3);assert.ok((await hash()).lit>100);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS shared GPU kernel, low-resolution aurora, play/pause/seek/reset and crossfade cleanup: '+engine.name());
 }finally{await browser.close();}
}
