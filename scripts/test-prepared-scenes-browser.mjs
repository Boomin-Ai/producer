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
  let failed=false,retryCompiles=0;
  const retryBank=new PreparedScenes(async request=>{if(request.op==='preload'&&!failed){failed=true;throw Error('Missing media asset portrait');}return send(request);},()=>{},async(...args)=>{retryCompiles++;return compileRoomScene(...args);});
  await retryBank.ensure(specs[0]).catch(()=>{});if(retryBank.readiness(specs[0]).state!=='error')throw Error('Missing failed state');retryBank.retry();await retryBank.ensure(specs[0]);if(retryCompiles!==2||retryBank.readiness(specs[0]).state!=='ready')throw Error('Retry reused a failed compiled plan');retryBank.dispose();
  const churnCache=new Map(),compiledKeys=[];let peak=0,churnRevision=0;
  const churnSend=async request=>{if(request.op==='preload'){churnCache.set(request.key,request.outputId);churnRevision=request.revision;peak=Math.max(peak,churnCache.size);}if(request.op==='retain')for(const [key,output]of churnCache)if(output===request.outputId&&!request.keys.includes(key))churnCache.delete(key);return {preparedRevision:churnRevision,renderedRevision:churnRevision,ready:true,warmed:true,transitioning:false,queued:false,cachedKeys:[...churnCache.keys()],renderSerial:1};};
  const churn=new PreparedScenes(churnSend,()=>{},async spec=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:{}}));
  await churn.retain(specs.slice(0,2));await churn.preload(specs.slice(0,2),()=>false);
  for(let i=0;i<80;i++){
   const changing=structuredClone(specs[0]);changing.projection.root.styles.background='#'+i.toString(16).padStart(6,'0');if(i%2)changing.target={...changing.target,id:'portrait',orientation:'portrait'};
   await churn.take(changing,async entry=>{compiledKeys.push(entry.key);});
   if(churnCache.size>4||churn.debug().entries.length>4)throw Error('Live snapshots accumulated');
  }
  if(peak>5)throw Error('Unbounded overlapping preparation');if(!churnCache.has(compiledKeys.at(-1)))throw Error('Active snapshot was evicted');
  for(const spec of specs.slice(0,2))if(!churnCache.has(churn.get(spec).key))throw Error('Authored inventory was evicted');churn.dispose();
  // A new live text snapshot must not re-upload the loaded artwork. The native
  // retain operation discards only assets outside this explicitly bounded list.
  const uploaded=[],manifests=[];let mediaRev=0;const mediaCache=new Set();
  const mediaSpec=structuredClone(specs[0]);mediaSpec.projection.assets={art:{name:'art',mime:'image/png',data:'data:image/png;base64,AA=='}};
  const mediaBank=new PreparedScenes(async request=>{if(request.op==='preload'){mediaCache.add(request.key);mediaRev=request.revision;uploaded.push(...Object.keys(request.plan.assets??{}));}if(request.op==='retain'){manifests.push(request.assetIds);for(const key of mediaCache)if(!request.keys.includes(key))mediaCache.delete(key);}return {preparedRevision:mediaRev,renderedRevision:mediaRev,ready:true,warmed:true,transitioning:false,queued:false,cachedKeys:[...mediaCache],renderSerial:1};},()=>{},async projection=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:projection.assets}));
  await mediaBank.retain([mediaSpec]);await mediaBank.preload([mediaSpec],()=>false);
  for(let i=0;i<8;i++){const next=structuredClone(mediaSpec);next.projection.root.styles.background='#'+i;await mediaBank.take(next,async()=>{});}
  if(uploaded.join(',')!=='art'||manifests.some(ids=>ids.join(',')!=='art'))throw Error('Loaded artwork was re-uploaded during live snapshots');
  await mediaBank.retain([]); // The active output retains its artwork until replaced.
  const empty=structuredClone(mediaSpec);empty.projection.assets={};empty.projection.root.styles.background='empty';await mediaBank.take(empty,async()=>{});
  if(manifests.at(-1).length)throw Error('Unused artwork manifest was retained');mediaBank.dispose();
  // Cold WebGL can become ready after the former 600-poll deadline. Advance
  // a synthetic clock while yielding microtasks so this exercises the fence
  // without a 13-second wall-clock sleep.
  const originalNow=Date.now,originalTimer=window.setTimeout;let coldNow=originalNow(),polls=0,coldKey='',coldRevision=0;
  Date.now=()=>coldNow;window.setTimeout=(run,ms,...args)=>ms===20?(queueMicrotask(()=>run(...args)),0):originalTimer(run,ms,...args);
  const cold=new PreparedScenes(async request=>{if(request.op==='preload'){coldKey=request.key;coldRevision=request.revision;}if(request.op==='status'&&coldKey){coldNow+=20;polls++;}return {preparedRevision:coldRevision,renderedRevision:0,cachedKeys:polls>=650?[coldKey]:[],ready:polls>=650,warmed:polls>=650};},()=>{},async()=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},scenes3d:{test:{}},assets:{}}));
  try{await cold.ensure(specs[0]);if(polls<650||cold.readiness(specs[0]).state!=='ready')throw Error('Cold WebGL startup was cancelled prematurely');}finally{cold.dispose();Date.now=originalNow;window.setTimeout=originalTimer;}
  bank.dispose();
  return {layouts:specs.length,loaded,repeatCompiles,edited,updates,preloads:calls.filter(c=>c==='preload').length,hasPlan:!!plan.root,churnPeak:peak,churnFinal:churnCache.size};
 });
 assert.equal(result.loaded,result.layouts+1);assert.equal(result.repeatCompiles,result.loaded);assert.equal(result.edited,result.loaded+1);assert(result.updates>=result.layouts*2);assert(result.hasPlan);assert(result.churnPeak<=5);assert(result.churnFinal<=4);
 console.log('PASS: all layouts compile/prepare once, ready repeat takes skip rebuild, edited design invalidates only its scene, and 80 live variants remain bounded',result);
}finally{await browser.close();}
