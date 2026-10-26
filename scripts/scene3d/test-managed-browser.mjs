import assert from 'node:assert/strict';
import fs from 'node:fs';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const out='/private/tmp/producer-managed-3d';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:1436/scripts/scene3d/study-preview.html');
 const compiled=await page.evaluate(async()=>{
  const {parsePackage}=await import('/src/features/presentation/schema.ts'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{outputProjection}=await import('/src/features/presentation/projection.ts'),{compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts'),{runtimePlan,sceneIdentity}=await import('/src/features/sets-v2/preparedScenes.ts');
  const doc=parsePackage(await(await fetch('/docs/shows/grand-arena-3d-study.json')).json());window.doc=doc;window.Session=RehearsalSession;window.projection=outputProjection;
  const session=new RehearsalSession(doc,undefined,'prepare');window.session=session;
  const plans=[];
  for(const layout of doc.set.layouts){session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});const p=outputProjection(doc,session.snapshot());plans.push(await compileRoomScene(p,{definitionId:doc.id,instanceId:'managed-studio',canvasId:layout.id,target:{id:layout.width>layout.height?'program':'portrait',orientation:layout.width>layout.height?'landscape':'portrait',width:layout.width,height:layout.height,scaling:'contain'},bindings:{host:'synthetic-camera',guest:'synthetic-camera'}}));}
  session.send({type:'control',action:{type:'layout.select',layoutId:'studio-landscape'}});session.enterRehearsal();await session.sendModule('studio','start');
  const neutral=outputProjection(doc,session.snapshot());await session.sendModule('studio','hostFloor');let host=outputProjection(doc,session.snapshot());
  await session.sendModule('studio','revealEmblem');const reveal=outputProjection(doc,session.snapshot());
  await session.sendModule('studio','revealEmblem');const replay=outputProjection(doc,session.snapshot());
  const revealPlan=runtimePlan(plans[0],reveal),replayPlan=runtimePlan(plans[0],replay);
  const sequenceAdvanced=Object.values(replayPlan.scenes3d).every((s,i)=>s.cueSequence>Object.values(revealPlan.scenes3d)[i].cueSequence);
  const foreground=Object.values(replayPlan.scenes3d)[0];
  const authoredForeground=foreground.world.objects.some(o=>o.id==='emblem-core')&&Object.keys(foreground.world.cues['reveal-emblem'].visibility).length>0;
  window.compile=compileRoomScene;window.basePlan=plans[0];
  const patched=runtimePlan(plans[0],host);const cues=Object.values(patched.scenes3d).map(s=>s.cue);
  const spec=p=>({definition:doc.id,instance:'managed-studio',layout:'studio-landscape',projection:p,bindings:{},target:plans[0].target,assetVersion:''});
  const bad=structuredClone(doc);bad.set.layouts[0].root.children[0].scene3d.world.objects[0].url='https://untrusted.invalid/model';let rejected=false;try{parsePackage(bad)}catch{rejected=true}
  return {plans,cues,sequenceAdvanced,authoredForeground,samePreparationIdentity:sceneIdentity(spec(reveal))===sceneIdentity(spec(replay)),rejected};
 });
 assert(compiled.rejected);assert(compiled.samePreparationIdentity);assert(compiled.sequenceAdvanced);assert(compiled.authoredForeground);assert(compiled.cues.every(c=>c==='host-floor'),JSON.stringify(compiled.cues));
 for(const plan of compiled.plans)fs.writeFileSync(`${out}/${plan.canvasId}.json`,JSON.stringify(plan));
 console.log('PASS public package validation, module-bound lighting, stable preparation identity and native lowering');
 await page.evaluate(async()=>{
  const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');window.session=new RehearsalSession(window.doc,undefined,'prepare');
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx');window.React=R.default??R;window.previewRoot=(D.default??D).createRoot(document.getElementById('root'));window.SetPreview=SetPreview;
  window.paint=()=>window.previewRoot.render(window.React.createElement(window.SetPreview,{doc:window.doc,state:window.session.snapshot()}));window.paint();
 });
 const frame=page.frameLocator('iframe');await frame.locator('canvas[data-scene3d-ready="true"]').first().waitFor({timeout:90000});
 await page.screenshot({path:`${out}/studio-landscape.png`});
 const before=await frame.locator('canvas').evaluateAll(nodes=>{for(const n of nodes)n.dataset.retained='yes';return nodes.length});assert.equal(before,1);
 const initialCamera=await frame.locator('[data-node$="/camera-0"]').boundingBox();
 await page.evaluate(async()=>{window.session.enterRehearsal();await window.session.sendModule('studio','start');await window.session.sendModule('studio','hostFloor');window.paint();});
 await page.waitForTimeout(200);const movingCamera=await frame.locator('[data-node$="/camera-0"]').boundingBox();assert(movingCamera.width>initialCamera.width&&movingCamera.width<1075.2,'Camera must pass through an intermediate native pose');
 console.log('PASS authored slot geometry interpolates instead of jumping');
 await page.waitForTimeout(1700);assert.equal(await frame.locator('canvas[data-retained="yes"]').count(),1);
 await page.screenshot({path:`${out}/studio-host-floor.png`});
 await page.evaluate(async()=>{await window.session.sendModule('studio','revealEmblem');window.paint();});
 await page.waitForTimeout(1400);await page.screenshot({path:`${out}/studio-emblem.png`});
 await page.evaluate(async()=>{await window.session.sendModule('studio','revealEmblem');window.paint();});
 await page.waitForTimeout(1000);assert.equal(await frame.locator('canvas[data-retained="yes"]').count(),1);
 console.log('PASS emblem geometry and repeated authored cue retain the GPU canvas');
 const context=await frame.locator('canvas').first().evaluate(canvas=>{const gl=canvas.getContext('webgl2');const extension=gl.getExtension('WEBGL_lose_context');extension.loseContext();setTimeout(()=>extension.restoreContext(),1200);return !!extension;});assert(context);
 await frame.locator('canvas[data-scene3d-ready="false"]').first().waitFor({timeout:10000});
 await frame.locator('canvas[data-scene3d-ready="true"]').first().waitFor({timeout:30000});
 await page.evaluate(()=>{window.session.send({type:'control',action:{type:'layout.select',layoutId:'studio-portrait'}});document.getElementById('root').style.width='1080px';window.paint();});await page.setViewportSize({width:1080,height:1920});
 await frame.locator('canvas[data-scene3d-ready="true"]').first().waitFor({timeout:90000});await page.screenshot({path:`${out}/studio-portrait.png`});
 await page.evaluate(()=>window.previewRoot.unmount());assert.equal(await page.locator('iframe').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS real SetPreview, retained GPU canvases across cues, context restoration, portrait and teardown');
}finally{await browser.close();}
