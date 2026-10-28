import assert from 'node:assert/strict';
import fs from 'node:fs';
import {visualEffectsFixture} from './sets-v2/visual-effects-fixture.mjs';
fs.mkdirSync('/private/tmp/producer-visual-effects-proof',{recursive:true});
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1320,height:780}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async doc=>{
  const R=await import('/node_modules/.vite/deps/react.js'),React=R.default??R,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetPreview}=await import('/src/features/presentation/SetPreview.tsx'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{outputProjection}=await import('/src/features/presentation/projection.ts'),{compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts');
  const session=new RehearsalSession(doc);window.fixture=doc;window.session=session;
  const p=outputProjection(doc,session.snapshot());window.effectPlan=await compileRoomScene(p,{definitionId:doc.id,instanceId:'effect-proof',canvasId:'reveal',target:{id:'program',orientation:'landscape',width:1280,height:720,scaling:'contain'},bindings:{host:'camera-proof'}});
  const host=document.createElement('div');host.style.width='1280px';document.body.replaceChildren(host);
  function View(){const [time,setTime]=React.useState(600);window.setEffectTime=setTime;return React.createElement(SetPreview,{doc,state:{...session.snapshot(),revision:time,animationClock:{running:false,positionMs:time,segmentMs:time,anchorMs:Date.now()}}});}
  (D.createRoot??D.default.createRoot)(host).render(React.createElement(View));
 },visualEffectsFixture);
 const frame=page.frameLocator('iframe');await frame.getByText('LIVE · GPU GLASS + ANIMATED REVEALS',{exact:true}).waitFor();
 const mask=frame.locator('[data-node$="/host-mask"]');await mask.waitFor();
 await page.waitForFunction(()=>!!window.setEffectTime);
 await page.waitForTimeout(200);const middle=await mask.evaluate(el=>el.style.maskImage);assert.match(middle,/radial-gradient/);
 assert.equal(await frame.locator('[data-node$="/glass"]').evaluate(el=>el.style.backdropFilter),'blur(12px)');
 await page.evaluate(()=>window.setEffectTime(0));await page.waitForTimeout(200);assert.match(await mask.evaluate(el=>el.style.maskImage),/transparent/);
 await page.evaluate(()=>window.setEffectTime(1200));await page.waitForTimeout(200);assert.notEqual(await mask.evaluate(el=>el.style.maskImage),middle);
 await page.locator('.set-preview').screenshot({path:'/private/tmp/producer-visual-effects-proof/browser.png'});
 const plan=await page.evaluate(()=>window.effectPlan);const flatten=n=>[n,...n.children.flatMap(flatten)];const nodes=flatten(plan.root);assert.equal(nodes.find(n=>n.backdrop)?.backdrop.blur,12);assert.equal(nodes.find(n=>n.mask?.kind==='circle')?.children[0].kind,'source');assert.equal(plan.motion[0].property,'mask.progress');assert.deepEqual(errors,[]);
 fs.writeFileSync('/private/tmp/producer-visual-effects-proof/compiled-plan.json',JSON.stringify(plan));
 console.log('PASS browser mask endpoints/midpoint, paused animation clocks, glass filter, native source wrapper and compiled animation track');
}finally{await browser.close();}
