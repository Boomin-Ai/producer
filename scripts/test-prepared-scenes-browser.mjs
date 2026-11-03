import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1436/');
 const result=await page.evaluate(async()=>{
  const {PreparedScenes,layoutProjections,moduleViewProjections,valueControlProjections,sceneIdentity,warmInventory,preparationInventory,morphTargets,runtimePlan}=await import('/src/features/sets-v2/preparedScenes.ts');
  const {HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');
  const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  const {compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts');
  const session=new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare');
  const inventory=layoutProjections(session),calls=[],cache=new Set();let revision=0,compiles=0,updates=0;
  const specs=inventory.map(i=>({projection:i.projection,layout:i.layout,phase:i.phase,definition:session.package.id,instance:'test-room',bindings:{},target:{id:'program',orientation:'landscape',width:1280,height:720,scaling:'contain'},targets:morphTargets(inventory.map(i=>i.projection),i.projection),assetVersion:'v1'}));
  const currentPair=new Set(specs.slice(0,2).map(s=>s.layout)),replacement=specs.map(s=>({...s,definition:'replacement'}));
  const staged=preparationInventory(specs,replacement,currentPair);
  if(staged.length!==replacement.length+currentPair.size||staged.filter(s=>s.definition===session.package.id).some(s=>!currentPair.has(s.layout)))throw Error('Replacement retained unrelated old layouts');
  if(preparationInventory(specs,[],currentPair).length!==specs.length)throw Error('Cancelling replacement did not restore full inventory');
  if(preparationInventory(specs,specs,currentPair).length!==specs.length*2)throw Error('Same-Set edit dropped authored layouts');
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
  // A priority take can overtake a queued retain after values invalidate every
  // authored scene. Evict the superseded inventory before loading that take.
  const pressureCache=new Set();let pressureRevision=0;
  const pressure=new PreparedScenes(async request=>{
   if(request.op==='preload'){await new Promise(r=>setTimeout(r,12));if(!pressureCache.has(request.key)&&pressureCache.size>=4)throw Error('Texture budget reached');pressureCache.add(request.key);pressureRevision=request.revision;}
   if(request.op==='retain')for(const key of pressureCache)if(!request.keys.includes(key))pressureCache.delete(key);
   return {preparedRevision:pressureRevision,renderedRevision:pressureRevision,cachedKeys:[...pressureCache],ready:true,warmed:true};
  },()=>{},async()=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:{}}));
  await pressure.retain(specs);await pressure.preload(specs,()=>false);await pressure.take(specs[0],async()=>{});
  const editedSpecs=specs.map(s=>{const next=structuredClone(s);next.projection.root.styles.background='#123456';return next;});
  const backgroundPressure=pressure.ensure({...editedSpecs[2],layout:'background'});
  await new Promise(r=>setTimeout(r,2));const reconcile=pressure.retain(editedSpecs);
  await pressure.take(editedSpecs[0],async()=>{});await reconcile;await backgroundPressure;
  if(pressure.readiness(editedSpecs[0]).state!=='ready'||!pressureCache.has(pressure.get(editedSpecs[0]).key))throw Error('Updated take did not survive cache pressure');pressure.dispose();
  const tightCache=new Set(),tightManifests=[];let tightRevision=0;
  const tight=new PreparedScenes(async request=>{
   if(request.op==='preload'){if(!tightCache.has(request.key)&&tightCache.size>=3)throw Error('No spare scene slot');tightCache.add(request.key);tightRevision=request.revision;}
   if(request.op==='retain'){tightManifests.push(request.assetIds);for(const key of tightCache)if(!request.keys.includes(key))tightCache.delete(key);}
   return {preparedRevision:tightRevision,renderedRevision:tightRevision,cachedKeys:[...tightCache],ready:true,warmed:true};
  },()=>{},async projection=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:projection.assets??{}}));
  const oldPhoto=structuredClone(specs[0]);oldPhoto.projection.assets={oldPhoto:{name:'photo',mime:'image/png',data:'data:image/png;base64,AA=='}};
  await tight.retain(specs);await tight.take(oldPhoto,async()=>{});
  await tight.retain(editedSpecs);await tight.preload(editedSpecs.slice(1),()=>false);
  await tight.take(editedSpecs[0],async()=>{});
  if(tight.readiness(editedSpecs[0]).state!=='ready'||!tightManifests.some(ids=>ids.includes('oldPhoto'))||tightManifests.at(-1).includes('oldPhoto'))throw Error('Replacement lost live artwork or retained it after replacement');tight.dispose();
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
  // without a 48-second wall-clock sleep.
  const originalNow=Date.now,originalTimer=window.setTimeout;let coldNow=originalNow(),polls=0,coldKey='',coldRevision=0;
  Date.now=()=>coldNow;window.setTimeout=(run,ms,...args)=>ms===20?(queueMicrotask(()=>run(...args)),0):originalTimer(run,ms,...args);
  const cold=new PreparedScenes(async request=>{if(request.op==='preload'){coldKey=request.key;coldRevision=request.revision;}if(request.op==='status'&&coldKey){coldNow+=40;polls++;}return {preparedRevision:coldRevision,renderedRevision:0,cachedKeys:polls>=1200?[coldKey]:[],ready:polls>=1200,warmed:polls>=1200};},()=>{},async()=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},scenes3d:{test:{}},assets:{}}));
  try{await cold.ensure(specs[0]);if(polls<1200||cold.readiness(specs[0]).state!=='ready')throw Error('Cold WebGL startup was cancelled prematurely');}finally{cold.dispose();Date.now=originalNow;window.setTimeout=originalTimer;}
  const atmosphere=await(await fetch('/docs/shows/atmosphere.json')).json();
  const weatherSession=new RehearsalSession(atmosphere,undefined,'rehearsal');
  const beforeSnapshot=JSON.stringify(weatherSession.snapshot()),beforeModules=JSON.stringify(weatherSession.moduleSnapshot());
  const warmViews=moduleViewProjections(weatherSession);
  if(warmViews.length!==6)throw Error('Expected three alternate views for each current composition orientation: '+warmViews.length);
  const landscape=warmViews.filter(v=>v.projection.width>v.projection.height);
  if(landscape.length!==3||new Set(landscape.map(v=>v.entry.modules.sky.view)).size!==3)throw Error('Missing distinct view variants');
  if(JSON.stringify(weatherSession.snapshot())!==beforeSnapshot||JSON.stringify(weatherSession.moduleSnapshot())!==beforeModules)throw Error('Speculation mutated authoritative state');
  const allViews=[...layoutProjections(weatherSession),...warmViews].map(item=>({...specs[0],definition:'atmosphere',layout:item.layout,projection:item.projection,phase:item.phase,speculative:item.variant,target:{...specs[0].target,id:item.projection.width>item.projection.height?'program':'portrait'}}));
  const warmed=warmInventory(allViews,new Set(['hero-landscape','hero-portrait']));
  for(const target of ['program','portrait']){const selected=warmed.filter(s=>s.target.id===target);if(selected.length!==5||selected.filter(s=>s.layout.startsWith('hero-')).length!==4)throw Error('View warming did not prioritize the four active-composition views within budget');}
  const unchanged=allViews.filter(s=>!s.speculative);if(warmInventory(unchanged,new Set()).length!==unchanged.length)throw Error('Ordinary layout inventory changed');
  const viewCache=new Set();let viewRevision=0,viewBuilds=0;
  const viewBank=new PreparedScenes(async request=>{if(request.op==='preload'){viewCache.add(request.key);viewRevision=request.revision;}return {preparedRevision:viewRevision,renderedRevision:viewRevision,cachedKeys:[...viewCache],ready:true,warmed:true};},()=>{},async()=>{viewBuilds++;return {root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:{}};});
  const makeSpec=item=>({...specs[0],definition:'atmosphere',layout:item.layout,projection:item.projection,phase:item.phase});
  await viewBank.preload(landscape.map(makeSpec),()=>false);const preparedBuilds=viewBuilds;
  await weatherSession.sendModule('sky','start');await weatherSession.sendModule('sky','today');
  const actual=layoutProjections(weatherSession).find(v=>v.layout==='hero-landscape');
  await viewBank.take(makeSpec(actual),async()=>{});
  if(viewBuilds!==preparedBuilds)throw Error('Prepared module view rebuilt on selection');
  viewBank.dispose();
  // Literal controls prepare the finite visible family without dispatching
  // commands, crossing fields or retaining unrelated slide compositions.
  const finiteDoc=structuredClone(HEAD_TO_HEAD),defaultTopic=finiteDoc.set.values.topic.default;
  finiteDoc.set.controls=finiteDoc.set.controls.filter(c=>c.type!=='button'||c.action.type!=='value.set');
  const finiteButtons=[defaultTopic,'Workers','D1'].map((value,i)=>({id:'finite-'+i,type:'button',label:value,action:{type:'value.set',key:'topic',value}}));
  finiteDoc.set.controls.push(...finiteButtons,{id:'invisible-finite',type:'button',label:'Hidden choice',when:false,action:{type:'value.set',key:'topic',value:'Hidden'}});
  const finiteSession=new RehearsalSession(finiteDoc,undefined,'prepare'),finiteBefore=JSON.stringify([finiteSession.snapshot(),finiteSession.moduleSnapshot()]);
  const finiteVariants=valueControlProjections(finiteSession);
  if(finiteVariants.length!==3||finiteVariants.some(v=>v.controlId==='invisible-finite'))throw Error('Finite controls include hidden or missing choices');
  if(JSON.stringify([finiteSession.snapshot(),finiteSession.moduleSnapshot()])!==finiteBefore)throw Error('Literal prewarming mutated authority');
  const finiteSpecs=()=>[...layoutProjections(finiteSession),...valueControlProjections(finiteSession)].map(item=>({...specs[0],definition:'finite',layout:item.layout,projection:item.projection,phase:item.phase,speculative:item.variant,controlId:item.controlId,targets:[]}));
  const familyBefore=warmInventory(finiteSpecs(),new Set([finiteSession.snapshot().layoutId]));
  if(familyBefore.filter(s=>s.layout===finiteSession.snapshot().layoutId).length!==3||familyBefore.length>8)throw Error('Control residency did not prioritize a bounded finite family');
  finiteSession.send({type:'control',action:finiteButtons[1].action});
  const familyAfter=warmInventory(finiteSpecs(),new Set([finiteSession.snapshot().layoutId]));
  if(JSON.stringify(familyBefore.filter(s=>s.layout===finiteSession.snapshot().layoutId).map(sceneIdentity).sort())!==JSON.stringify(familyAfter.filter(s=>s.layout===finiteSession.snapshot().layoutId).map(sceneIdentity).sort()))throw Error('Changing a finite selection invalidated its prepared family');
  const multiDoc=structuredClone(finiteDoc);multiDoc.set.controls.push(...['Host A','Host B'].map((value,i)=>({id:'independent-'+i,type:'button',label:value,action:{type:'value.set',key:'hostName',value}})));
  const multi=new RehearsalSession(multiDoc,undefined,'prepare'),multiBefore=multi.snapshot();
  if(valueControlProjections(multi).some(v=>v.entry.values.hostName!==multiBefore.values.hostName))throw Error('Independent setup toggle polluted the dominant finite family');
  for(const variant of valueControlProjections(multi))if(Object.keys(multiBefore.values).filter(k=>multiBefore.values[k]!==variant.entry.values[k]).length>1)throw Error('Independent control fields were multiplied');
  // Exhaustion of the aggregate cache is eviction pressure, not a failed
  // layout. Background warming stops; an actual take frees cold snapshots.
  const boundedKeys=new Set();let boundedRevision=0,boundedLoads=0,boundedRetains=0;
  const bounded=new PreparedScenes(async request=>{
   if(request.op==='retain'){boundedRetains++;for(const key of boundedKeys)if(!request.keys.includes(key))boundedKeys.delete(key);}
   if(request.op==='preload'){boundedLoads++;if(!boundedKeys.has(request.key)&&boundedKeys.size>=2)throw Error('Loaded set texture budget reached');boundedKeys.add(request.key);boundedRevision=request.revision;}
   return {preparedRevision:boundedRevision,renderedRevision:boundedRevision,cachedKeys:[...boundedKeys],ready:true,warmed:true};
  },()=>{},async()=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:{}}));
  await bounded.retain(specs);const firstRetains=boundedRetains;await bounded.retain(specs);
  if(boundedRetains!==firstRetains)throw Error('Identical retained inventory sent repeated native work');
  await bounded.preload(specs,()=>false);if(bounded.readiness(specs[2]).state!=='queued')throw Error('Cache exhaustion surfaced as a broken layout');
  const fullLoads=boundedLoads;await bounded.preload(specs,()=>false);if(boundedLoads!==fullLoads)throw Error('Full-cache speculative preparation churned');
  let boundedTakes=0;await bounded.take(specs[2],async entry=>{if(!boundedKeys.has(entry.key))throw Error('Took an unprepared view');boundedTakes++;});
  if(boundedTakes!==1||boundedKeys.size>2||bounded.debug().entries.some(e=>e.state.state==='error'))throw Error('Requested view did not recover within the cache bound');
  bounded.dispose();
  const readyKeys=new Set();let readyRevision=0;
  const readyTrim=new PreparedScenes(async request=>{if(request.op==='preload'){readyKeys.add(request.key);readyRevision=request.revision;}if(request.op==='retain')for(const key of readyKeys)if(!request.keys.includes(key))readyKeys.delete(key);return {preparedRevision:readyRevision,renderedRevision:readyRevision,cachedKeys:[...readyKeys],ready:true,warmed:true};},()=>{},async()=>({root:{id:'root',kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:{}}));
  await readyTrim.retain(specs);await readyTrim.preload(specs,()=>false);readyTrim.setInventory([specs[0]]);
  await readyTrim.take(specs[0],async()=>{if(readyKeys.size!==3)throw Error('Cold eviction blocked a ready presentation');});
  if(readyKeys.size!==1)throw Error('Post-presentation eviction did not reconcile ownership');readyTrim.dispose();
  bank.dispose();
  return {layouts:specs.length,loaded,repeatCompiles,edited,updates,preloads:calls.filter(c=>c==='preload').length,hasPlan:!!plan.root,churnPeak:peak,churnFinal:churnCache.size};
 });
 assert.equal(result.loaded,result.layouts+1);assert.equal(result.repeatCompiles,result.loaded);assert.equal(result.edited,result.loaded+1);assert(result.updates>=result.layouts*2);assert(result.hasPlan);assert(result.churnPeak<=5);assert(result.churnFinal<=4);
 console.log('PASS: all layouts compile/prepare once, ready repeat takes skip rebuild, edited design invalidates only its scene, 80 live variants remain bounded, and speculative module views take without rebuild or state mutation',result);
}finally{await browser.close();}
