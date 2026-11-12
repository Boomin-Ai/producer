// Real browser layout/compiler regression; no app, capture or native GPU calls.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
 import {compileRoomScene,nativeNodeId} from './src/features/sets-v2/roomCompiler';
 import {estimateRenderPlan} from './src/features/presentation/authoring/preflight';
 import {planPasses} from './src/features/sets-v2/planner';
 import {runtimePlan} from './src/features/sets-v2/preparedScenes';
 Object.assign(window,{compileRoomScene,nativeNodeId,estimateRenderPlan,planPasses,runtimePlan});
 `},bundle:true,format:'iife',platform:'browser',write:false});
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
try{
 const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><body></body>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 const result=await page.evaluate(async()=>{
  const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
  const host={id:'host',type:'slot',slotId:'host',styles:rect(32,100,400,400),appearance:{shape:'rectangle',cornerRadius:12,outlineWidth:2},framing:{mode:'fill',x:.5,y:.46},children:[]};
  const screen={id:'screen',type:'slot',slotId:'screen',styles:rect(480,100,560,315),framing:{mode:'fit',x:.5,y:.5},children:[]};
  const chat={id:'chat-feed',type:'slot',slotId:'chat',styles:rect(-72,-1374,4000,2600),appearance:{shape:'rectangle',cornerRadius:8,outlineWidth:0},framing:{mode:'fill',x:.5,y:.5},children:[]};
  const projection={width:1080,height:1920,revision:1,css:'',root:{id:'root',type:'box',styles:{position:'relative',width:1080,height:1920,background:'#101114'},children:[host,screen,{id:'chat-panel',type:'box',styles:{...rect(52,919,976,188),overflow:'hidden',borderRadius:10,background:'#13161D'},children:[chat]}]}};
  const options={definitionId:'unbound-slot-proof',instanceId:'proof',canvasId:'portrait',target:{id:'portrait',orientation:'portrait',width:1080,height:1920,scaling:'contain'},bindings:{host:'camera-existing',screen:'screen-existing'},retainedTargets:['chat-panel','chat-panel']};
  const compile=(bound,masked=false)=>{
   const p=structuredClone(projection);if(masked)p.root.children[2].children[0].mask={kind:'circle',feather:8};
   return window.compileRoomScene(p,{...options,bindings:{...options.bindings,...(bound?{chat:'chat-existing'}:{})}});
  };
  const unbound=await compile(false),maskedUnbound=await compile(false,true),bound=await compile(true),maskedBound=await compile(true,true),unboundAgain=await compile(false);
  const animated=structuredClone(projection);animated.timeline={clock:{running:true,positionMs:0,segmentMs:0,anchorMs:Date.now()},tracks:[...['x','y','width','height','opacity','scale','rotation','mask.progress'].map(property=>({target:'chat-feed',property,keyframes:[{atMs:0,value:1},{atMs:420,value:1}]})),{target:'host',property:'x',keyframes:[{atMs:0,value:32},{atMs:420,value:60}]}]};
  const compiledMotion=await window.compileRoomScene(animated,options);
  const runtime=window.runtimePlan(unbound,animated);
  const boundRuntime=window.runtimePlan(bound,animated);
  const flatten=n=>[n,...n.children.flatMap(flatten)],find=(p,id)=>flatten(p.root).find(n=>n.id===window.nativeNodeId(id));
  return {unbound:find(unbound,'chat-feed'),maskedUnbound:find(maskedUnbound,'chat-feed'),bound:find(bound,'chat-feed'),maskedBound:find(maskedBound,'chat-feed'),unboundAgain:find(unboundAgain,'chat-feed'),
   expectedId:window.nativeNodeId('chat-feed'),expectedContentId:window.nativeNodeId('chat-feed-content'),appearance:chat.appearance,framing:chat.framing,
   resources:unbound.resources,boundResources:bound.resources,retainedTargets:unbound.retainedTargets,boundRetainedTargets:bound.retainedTargets,existingRetainedId:window.nativeNodeId('chat-panel'),runtimeRetainedTargets:runtime.retainedTargets,runtimeMotion:runtime.motion,compiledMotion:compiledMotion.motion,boundMotion:boundRuntime.motion,hostId:window.nativeNodeId('host'),admission:window.estimateRenderPlan(unbound),passes:window.planPasses(unbound),boundPasses:window.planPasses(bound),
   unchangedSources:['host','screen'].every(id=>JSON.stringify(find(unbound,id))===JSON.stringify(find(bound,id))),remainingDOM:document.body.childElementCount};
 });
 console.log('Admission estimate:',JSON.stringify(result.admission));
 for(const node of [result.unbound,result.maskedUnbound,result.unboundAgain]){
  assert.equal(node.id,result.expectedId,'Keep the authored slot identity for later binding');
  assert.equal(node.kind,'group');assert.deepEqual(node.bounds,{x:-72,y:-1374,width:1,height:1});
  assert.equal(node.properties.visible,undefined,'Keep a materialized native identity');assert.equal(node.properties.opacity,0);
  assert.deepEqual(node.children,[]);assert.equal(node.mask,undefined);assert.equal(node.backdrop,undefined);assert.equal(node.isolate,undefined,'Do not allocate an empty effects wrapper');
 }
 assert.deepEqual(result.retainedTargets,[result.existingRetainedId,result.expectedId],'Merge/deduplicate placeholder and existing retained targets');assert.deepEqual(result.runtimeRetainedTargets,result.retainedTargets);
 for(const motion of [result.compiledMotion,result.runtimeMotion]){assert.equal(motion.length,1,'Drop every placeholder track, including late runtime morph tracks');assert.equal(motion[0].target,result.hostId,'Unrelated native animation remains intact');}
 assert.equal(result.boundMotion.length,9,'Binding restores normal animation handling');
 assert(!result.boundRetainedTargets.includes(result.expectedId),'Binding restores normal native source batching');
 assert(!result.resources.includes('chat-existing'));assert.deepEqual(result.admission.issues,[]);assert(result.admission.graphicsPixels<8*1024*1024);
 assert(!result.passes.operations.some(op=>op.op==='graphics'&&op.nodes.some(n=>n.id===result.expectedId)),'An empty retained group has no graphics leaf');
 assert.equal(result.bound.id,result.expectedId);assert.equal(result.bound.kind,'source');assert.equal(result.bound.resource,'chat-existing');assert.equal(result.bound.properties.visible,undefined);
 assert.deepEqual(result.bound.bounds,{x:-72,y:-1374,width:4000,height:2600});assert.deepEqual(result.bound.appearance,result.appearance);assert.deepEqual(result.bound.framing,result.framing);assert.equal(result.bound.fit,'cover');
 assert(result.boundResources.includes('chat-existing'));assert(result.boundPasses.operations.some(op=>op.op==='source'&&op.node.resource==='chat-existing'));
 assert.equal(result.maskedBound.id,result.expectedId);assert.equal(result.maskedBound.kind,'group');assert.deepEqual(result.maskedBound.mask,{kind:'circle',feather:8});assert.equal(result.maskedBound.isolate,true);
 assert.equal(result.maskedBound.children.length,1);const content=result.maskedBound.children[0];assert.equal(content.id,result.expectedContentId);assert.equal(content.kind,'source');assert.equal(content.resource,'chat-existing');assert.deepEqual(content.bounds,{x:0,y:0,width:4000,height:2600});assert.deepEqual(content.appearance,result.appearance);assert.deepEqual(content.framing,result.framing);
 assert(result.unchangedSources,'Binding chat does not change unrelated camera/screen source plans');assert.equal(result.remainingDOM,0,'Compiler releases its hidden measurement DOM');assert.deepEqual(errors,[]);
 console.log('PASS: huge clipped unbound slots retain 1px transparent identities without browser raster/effects; compile/runtime tracks cannot enlarge them; binding restores normal native source, animation, appearance, framing and mask');
}finally{await browser.close();}
