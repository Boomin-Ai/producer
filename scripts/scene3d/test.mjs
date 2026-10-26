import assert from 'node:assert/strict';
import {validateScene,validateControl} from './contract.mjs';
import {arena} from './make-arena.mjs';
for(const portrait of[false,true]){
 const scene=arena(portrait);assert.deepEqual(validateScene(scene),scene);
 for(const mutate of[
  s=>{s.objects[1].id=s.objects[0].id},
  s=>{s.objects[0].args[0]=Infinity},
  s=>{s.objects[1].args[3]=100000},
  s=>{s.objects[0].motion={kind:'javascript',speed:1,amplitude:0,phase:0}},
  s=>{s.camera.fov=180},
  s=>{s.slots[0]=[0.5,0.5,1,1]},
 ]){const invalid=structuredClone(scene);mutate(invalid);assert.throws(()=>validateScene(invalid));}
}
assert.throws(()=>validateControl({revision:-1}));
console.log('PASS: scene budgets, bounded geometry/motion, duplicate identities, framing and control validation');
if(!process.argv[2])process.exit(0);
const {readFile}=await import('node:fs/promises');
const manifest=JSON.parse(await readFile(process.argv[2],'utf8'));
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(manifest.background);
 await page.waitForSelector('canvas');
 const instance=await page.locator('canvas').getAttribute('data-scene3d-instance');
 const snapshot=async()=>await(await fetch(manifest.report)).json();
 for(let i=0;i<300;i++){const r=(await snapshot()).telemetry['landscape/background'];if(r?.instance===instance&&r?.rendered>=3)break;await new Promise(r=>setTimeout(r,100));}
 const initial=(await snapshot()).telemetry['landscape/background'];assert.equal(initial?.instance,instance);assert(initial?.ready);assert(initial.webgl2);assert(initial.calls<100);
 const canvas=await page.locator('canvas').evaluate(e=>{e.dataset.identity='retained';return true});assert(canvas);
 let expectedRevision=initial.revision;
 for(const action of['blue','gold','pause','resume','neutral']){
  const result=await fetch(manifest.control,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});assert.equal(result.status,200);expectedRevision=(await result.json()).revision;
 }
 for(let i=0;i<100;i++){if((await snapshot()).telemetry['landscape/background']?.revision>=expectedRevision)break;await page.waitForTimeout(100);}
 assert.equal(await page.locator('canvas').getAttribute('data-identity'),'retained');
 const after=(await snapshot()).telemetry['landscape/background'];assert(after.revision>=expectedRevision);assert(after.rendered>initial.rendered);
 const bad=await fetch(manifest.control,{method:'POST',body:'{"action":"execute"}'});assert.equal(bad.status,400);
 const denied=await fetch(manifest.control,{method:'POST',headers:{Origin:'https://untrusted.example'},body:'{"action":"blue"}'});assert.equal(denied.status,403);
 await page.goto(manifest.foreground);await page.waitForTimeout(1800);assert.equal(errors.length,0,errors.join('\n'));
 console.log('PASS: actual WebGL2 renderer, retained canvas across cues/pause, revision consumption and local control boundary');
}finally{await browser.close();}
