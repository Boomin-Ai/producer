import assert from 'node:assert/strict';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1436/');
 const result=await page.evaluate(async()=>{
  const {PreparedScenes,layoutProjections,morphTargets,runtimePlan}=await import('/src/features/sets-v2/preparedScenes.ts');
  const {HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');
  const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  const {compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts');
  const session=new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare');
  const inventory=layoutProjections(session),calls=[],cache=new Set();let revision=0,compiles=0,updates=0;
  const specs=inventory.map(i=>({projection:i.projection,layout:i.layout,phase:i.phase,definition:session.package.id,instance:'test-room',bindings:{},target:{id:'program',orientation:'landscape',width:1280,height:720,scaling:'contain'},targets:morphTargets(inventory.map(i=>i.projection),i.projection),assetVersion:'v1'}));
  const send=async request=>{await new Promise(r=>setTimeout(r,5));calls.push(request.op);if(request.op==='preload'){revision=request.revision;cache.add(request.key);}if(request.op==='retain')for(const key of cache)if(!request.keys.includes(key))cache.delete(key);return {preparedRevision:revision,renderedRevision:revision,ready:true,warmed:true,transitioning:false,queued:false,cachedKeys:[...cache],renderSerial:1};};
  const bank=new PreparedScenes(send,()=>updates++,async(...args)=>{compiles++;return compileRoomScene(...args);});
  const background=bank.preload(specs,()=>false);await new Promise(r=>setTimeout(r,1));await Promise.all([bank.take(specs[0],async()=>{}),bank.take({...specs[1],target:{...specs[1].target,id:'portrait',orientation:'portrait',width:720,height:1280}},async()=>{})]);await background;const loaded=compiles;
  for(let i=0;i<4;i++)await bank.take(specs[i%specs.length],async(entry)=>{if(!entry.plan)throw Error('missing plan');});
  const pin=bank.take(specs[0],async()=>{await new Promise(r=>setTimeout(r,10));});await bank.retain(specs.slice(1));await pin;
  const repeatCompiles=compiles;
  const changed=structuredClone(specs[0]);changed.projection.root.styles.background='#ff0000';await bank.ensure(changed);
  const edited=compiles;
  const runtime=structuredClone(specs[0].projection);if(runtime.timeline)runtime.timeline.clock={running:true,positionMs:50,segmentMs:0,anchorMs:Date.now()};const plan=runtimePlan(bank.get(specs[0]).plan,runtime);
  bank.dispose();
  return {layouts:specs.length,loaded,repeatCompiles,edited,updates,preloads:calls.filter(c=>c==='preload').length,hasPlan:!!plan.root};
 });
 assert.equal(result.loaded,result.layouts+1);assert.equal(result.repeatCompiles,result.loaded);assert.equal(result.edited,result.loaded+1);assert(result.updates>=result.layouts*2);assert(result.hasPlan);
 console.log('PASS: all layouts compile/prepare once, ready repeat takes skip rebuild, edited design invalidates only its scene',result);
}finally{await browser.close();}
