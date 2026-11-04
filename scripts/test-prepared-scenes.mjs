import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const temp=await mkdtemp(join(tmpdir(),'producer-preparation-'));
try {
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:"export {PreparedScenes,sceneTransport} from './src/features/sets-v2/preparedScenes';"},bundle:true,platform:'node',format:'esm',write:false});
 const file=join(temp,'preparation.mjs');await writeFile(file,bundle.outputFiles[0].text);
 const {PreparedScenes,sceneTransport}=await import(pathToFileURL(file));
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
 const spec=(layout='selected',output='program')=>({definition:'fixture',instance:'room',layout,phase:'',bindings:{host:'camera'},target:{id:output,orientation:output==='portrait'?'portrait':'landscape',width:output==='portrait'?720:1280,height:output==='portrait'?1280:720,scaling:'contain'},targets:[],assetVersion:'v1',projection:{width:1280,height:720,root:{id:layout,type:'box',styles:{},children:[]},assets:{art:{name:'art',mime:'image/png',data:'data:image/png;base64,AA=='}}}});
 const plan=async projection=>({root:{id:projection.root.id,kind:'group',bounds:{x:0,y:0,width:100,height:100},children:[]},assets:projection.assets});
 const status=(keys=[],generation=1)=>({generation,preparedRevision:0,renderedRevision:0,renderSerial:1,cachedKeys:keys,ready:true,warmed:true,queued:false,transitioning:false});
 let passed=0;
 const test=async(name,run)=>{await run();console.log('PASS',name);passed++;};

 await test('one generation discovery serves repeated native readiness calls',async()=>{
  let reads=0,calls=0;const transport=sceneTransport(async r=>{calls++;assert.equal(r.generation,7);return status([],7);},async()=>{reads++;return 7;},()=>{});
  await Promise.all(Array.from({length:64},()=>transport.send({op:'status'})));
  assert.equal(reads,1);assert.equal(calls,64);
  await transport.send({op:'retain',generation:99});assert.equal(reads,1);
 });
 await test('a delayed discovery cannot roll back a newer observed generation',async()=>{
  const pending=deferred();let requested;
  const transport=sceneTransport(async r=>{requested=r.generation;return status([],r.generation);},()=>pending.promise,()=>{});
  const request=transport.send({op:'status'});transport.observeGeneration(2);pending.resolve(1);await request;assert.equal(requested,2);
  const refresh=transport.refreshGeneration();transport.observeGeneration(3);assert.equal(await refresh,3);
 });
 await test('native generation rejection refreshes once without replaying the action',async()=>{
  let nativeGeneration=1,reads=0,actions=0;const transport=sceneTransport(async r=>{actions++;if(r.generation!==nativeGeneration)throw Error('Room generation changed; prepare the set again');return status([],nativeGeneration);},async()=>{reads++;return nativeGeneration;},()=>{});
  await transport.send({op:'status'});nativeGeneration=2;
  await assert.rejects(transport.send({op:'preload'}),/Room generation changed/);
  assert.equal(actions,2);assert.equal(reads,2);
  await transport.send({op:'status'});assert.equal(actions,3);assert.equal(reads,2);
  const rejected=Error('Cached scene source was replaced');let checks=0;
  const invalid=sceneTransport(async()=>{throw rejected;},async()=>{checks++;return 1;},()=>{});
  await assert.rejects(invalid.send({op:'activate'}),e=>e===rejected);assert.equal(checks,1);
 });
 const generationBank=()=>{
  let nativeGeneration=1,readinessHold,validationHold,bank,known;
  const keys=new Set(),requests=[];
  const transport=sceneTransport(async request=>{
   requests.push({...request});assert.equal(request.generation,nativeGeneration,'native rejected a stale request before work');
   if(request.op==='preload')keys.add(request.key);
   const reply=status([...keys],nativeGeneration);
   if(request.op==='status'&&keys.size&&readinessHold){const hold=readinessHold;readinessHold=undefined;hold.enter.resolve();await hold.exit.promise;}
   if(request.op==='status'&&keys.size&&validationHold){const hold=validationHold;validationHold=undefined;hold.enter.resolve();await hold.exit.promise;}
   return reply;
  },async()=>nativeGeneration,next=>{if(known!==undefined&&known!==next)bank.reset();known=next;});
  bank=new PreparedScenes(r=>transport.send(r),()=>{},plan);
  return {bank,transport,requests,holdReadiness(){readinessHold={enter:deferred(),exit:deferred()};return readinessHold;},holdValidation(){validationHold={enter:deferred(),exit:deferred()};return validationHold;},change(){nativeGeneration++;keys.clear();transport.observeGeneration(nativeGeneration);}};
 };
 await test('room changes during first-paint wait cannot restore stale ready state or cancel the new room',async()=>{
  const h=generationBank(),hold=h.holdReadiness(),selected=spec();
  try{
   const loading=h.bank.ensure(selected);await hold.enter.promise;h.change();hold.exit.resolve();await loading;
   assert.equal(h.bank.readiness(selected).state,'queued');assert.ok(!h.requests.some(r=>r.op==='cancel'&&r.generation===2));
   await h.bank.ensure(selected,100);assert.equal(h.bank.readiness(selected).state,'ready');
   assert.deepEqual(h.requests.filter(r=>r.op==='preload').map(r=>r.generation),[1,2]);
  }finally{h.bank.dispose();}
 });
 await test('generation changes during cached-take validation cannot activate either old output',async()=>{
  const h=generationBank(),selected=spec();
  try{
   await h.bank.ensure(selected);const hold=h.holdValidation();let activated=0;
   const taking=h.bank.take(selected,async()=>{activated++;});const rejection=assert.rejects(taking,/Room generation changed/);
   await hold.enter.promise;h.change();hold.exit.resolve();await rejection;assert.equal(activated,0);
   await h.bank.take(selected,async()=>{activated++;});assert.equal(activated,1);
  }finally{h.bank.dispose();}
 });
 await test('an old take cannot reprepare its stale selection after room reset during readiness',async()=>{
  const h=generationBank(),hold=h.holdReadiness();let activated=0;
  try{
   const taking=h.bank.take(spec('old-canvas'),async()=>{activated++;});const rejection=assert.rejects(taking,/Room generation changed/);
   await hold.enter.promise;h.change();hold.exit.resolve();await rejection;
   assert.equal(activated,0);assert.ok(!h.requests.some(r=>r.op==='preload'&&r.generation===2));
   await h.bank.take(spec('new-canvas'),async()=>{activated++;});assert.equal(activated,1);
   assert.ok(!h.requests.some(r=>r.op==='preload'&&r.generation===2&&r.plan.root.id==='old-canvas'));
  }finally{h.bank.dispose();}
 });
 await test('reset during presentation cannot restore old active ownership after the native reply',async()=>{
  const keys=new Set(),entered=deferred(),release=deferred();
  const bank=new PreparedScenes(async r=>{if(r.op==='preload')keys.add(r.key);return status([...keys]);},()=>{},plan);
  try{
   const taking=bank.take(spec(),async()=>{entered.resolve();await release.promise;});const rejection=assert.rejects(taking,/Room generation changed/);
   await entered.promise;bank.reset();release.resolve();await rejection;assert.deepEqual(bank.debug().active,[]);
  }finally{bank.dispose();}
 });
 await test('paired foreground take reserves the queue across preparation and presentation awaits',async()=>{
  const entered=deferred(),unblock=deferred(),presented=deferred(),finish=deferred(),keys=new Set(),events=[];
  const selected=spec(),portrait=spec('selected-portrait','portrait'),background=spec('background'),later=spec('later');
  let held=true,completed=false;
  const bank=new PreparedScenes(async r=>{events.push({op:r.op,id:r.plan?.root.id,completed});if(r.op==='preload')keys.add(r.key);return status([...keys]);},()=>{},async projection=>{
   if(projection.root.id==='background'&&held){held=false;entered.resolve();await unblock.promise;}
   return plan(projection);
  });
  try{
   bank.setInventory([selected,portrait,background,later]);
   const warming=bank.ensure(background);await entered.promise;const queued=bank.ensure(later);
   const taking=bank.takeGroup([selected,portrait],async entries=>{assert.equal(entries.length,2);assert.ok(entries.every(({entry})=>keys.has(entry.key)));presented.resolve();await finish.promise;completed=true;});
   unblock.resolve();await presented.promise;
   assert.ok(!events.some(e=>e.op==='preload'&&['background','later'].includes(e.id)),'unrelated decoder work ran before paired presentation');
   finish.resolve();await taking;await warming;await queued;
   assert.ok(events.some(e=>e.op==='preload'&&e.id==='later'&&e.completed),'background warming did not resume after presentation');
  }finally{bank.dispose();}
 });
 await test('a room reset retires queued old work without leaving a settled promise stuck on the entry',async()=>{
  const entered=deferred(),release=deferred(),keys=new Set(),selected=spec(),other=spec('other');let held=true;
  const bank=new PreparedScenes(async r=>{if(r.op==='preload')keys.add(r.key);return status([...keys]);},()=>{},async p=>{if(p.root.id==='other'&&held){held=false;entered.resolve();await release.promise;}return plan(p);});
  try{
   const running=bank.ensure(other);await entered.promise;const queued=bank.ensure(selected);bank.reset();release.resolve();
   await Promise.all([running,queued]);assert.equal(bank.readiness(selected).state,'queued');
   await bank.take(selected,async entry=>assert.ok(keys.has(entry.key)));assert.equal(bank.readiness(selected).state,'ready');
  }finally{bank.dispose();}
 });
 await test('preemption during readiness status cancels the same-room candidate before foreground preload',async()=>{
  const entered=deferred(),release=deferred(),keys=new Set(),calls=[];let holding=true,prepared=false;
  const bank=new PreparedScenes(async r=>{
   calls.push(r);if(r.op==='preload'){keys.add(r.key);prepared=true;}
   if(r.op==='status'&&prepared&&holding){holding=false;entered.resolve();await release.promise;}
   return status([...keys]);
  },()=>{},plan);
  try{
   const warming=bank.ensure(spec('background'));await entered.promise;const taking=bank.take(spec(),async()=>{});release.resolve();await taking;await warming;
   const cancel=calls.findIndex(r=>r.op==='cancel'),foreground=calls.findIndex(r=>r.op==='preload'&&r.plan.root.id==='selected');
   assert.ok(cancel>=0&&cancel<foreground,'same-room preload was not retired before selected preparation');
  }finally{bank.dispose();}
 });
 await test('reset during the initial status does not preload an old plan into the new room',async()=>{
  const entered=deferred(),release=deferred(),calls=[];let holding=true;
  const bank=new PreparedScenes(async r=>{calls.push(r);if(r.op==='status'&&holding){holding=false;entered.resolve();await release.promise;}return status([]);},()=>{},plan);
  try{
   const warming=bank.ensure(spec());await entered.promise;bank.reset();release.resolve();await warming;
   assert.ok(!calls.some(r=>r.op==='preload'||r.op==='cancel'));assert.equal(bank.readiness(spec()).state,'queued');
  }finally{bank.dispose();}
 });
 await test('late first-frame, budget and resource errors cannot cancel or retry work in a new generation',async()=>{
  for(const message of ['Media did not decode its first frame','Loaded set texture budget reached','Resource unavailable']){
   const entered=deferred(),release=deferred(),calls=[];let prepared=false,holding=true,generation=1;
   const bank=new PreparedScenes(async r=>{calls.push({...r,generation});if(r.op==='preload')prepared=true;if(r.op==='status'&&prepared&&holding){holding=false;entered.resolve();await release.promise;}return status([],generation);},()=>{},plan);
   try{
    const warming=bank.ensure(spec());await entered.promise;generation=2;bank.reset();release.reject(Error(message));await warming;
    assert.ok(!calls.some(r=>r.generation===2&&['cancel','retain','preload'].includes(r.op)),message);assert.equal(bank.readiness(spec()).state,'queued');
   }finally{bank.dispose();}
  }
 });
 await test('foreground program preparation defers unrelated portrait eviction until after confirmation',async()=>{
  const selected=spec(),portrait=spec('portrait','portrait'),keys=new Set(),calls=[];let confirmed=false;
  const bank=new PreparedScenes(async r=>{calls.push({...r,confirmed});if(r.op==='preload')keys.add(r.key);return status([...keys]);},()=>{},plan);
  try{
   bank.setInventory([selected,portrait]);await bank.take(selected,async()=>{confirmed=true;});
   assert.ok(!calls.some(r=>r.op==='retain'&&r.outputId==='portrait'&&!r.confirmed));
   await tick();assert.ok(calls.some(r=>r.op==='retain'&&r.outputId==='portrait'&&r.confirmed));
  }finally{bank.dispose();}
 });
 await test('cached takes compile and upload once; expired native scenes recover once with first-paint validation',async()=>{
  const selected=spec(),keys=new Set(),uploads=[];let compiles=0,takes=0;
  const bank=new PreparedScenes(async r=>{if(r.op==='preload'){keys.add(r.key);uploads.push(Object.keys(r.plan.assets));}return status([...keys]);},()=>{},async p=>{compiles++;return plan(p);});
  try{
   await bank.ensure(selected);await bank.take(selected,async()=>{takes++;});assert.equal(compiles,1);assert.equal(uploads.length,1);
   keys.clear();await bank.take(selected,async()=>{assert.ok(keys.has(bank.get(selected).key));takes++;});
   assert.equal(compiles,1);assert.equal(takes,2);assert.deepEqual(uploads,[['art'],[]]);
  }finally{bank.dispose();}
 });
 await test('persistent cache loss is bounded and activation failures are never silently retried',async()=>{
  let key='',polls=0,preloads=0,activated=0;
  const bank=new PreparedScenes(async r=>{if(r.op==='preload'){key=r.key;polls=0;preloads++;}if(r.op==='status'&&key)polls++;return status(polls===1?[key]:[]);},()=>{},plan);
  try{await bank.ensure(spec());await assert.rejects(bank.take(spec(),async()=>{activated++;}),/Prepared scene expired/);assert.equal(preloads,2);assert.equal(activated,0);}finally{bank.dispose();}
  const keys=new Set();let attempts=0;
  const capture=new PreparedScenes(async r=>{if(r.op==='preload')keys.add(r.key);return status([...keys]);},()=>{},plan);
  try{await assert.rejects(capture.take(spec(),async()=>{attempts++;throw Error('Cached scene source was replaced');}),/source was replaced/);assert.equal(attempts,1);}finally{capture.dispose();}
 });
 await test('selected scenes wait for native first-paint and emit bounded metadata phase durations',async()=>{
  const selected=spec(),keys=new Set(),stages=[];let ready=false,preloaded=deferred(),takes=0;
  const bank=new PreparedScenes(async r=>{if(r.op==='preload'){keys.add(r.key);preloaded.resolve();}return status(ready?[...keys]:[]);},()=>{},plan,()=>((stage,fields)=>stages.push({stage,fields})));
  try{
   const taking=bank.take(selected,async()=>{takes++;});await preloaded.promise;await tick();assert.equal(takes,0);ready=true;await taking;
   assert.equal(takes,1);for(const stage of ['queue','compile','preload','ready'])assert.ok(stages.some(s=>s.stage===stage));
   for(const {fields}of stages)assert.ok(Object.values(fields).every(value=>typeof value==='boolean'||typeof value==='number'));
   assert.ok(stages.find(s=>s.stage==='ready').fields.polls>=2);
  }finally{bank.dispose();}
 });
 console.log(`PASS ${passed} preparation/cache/generation regression cases`);
} finally {await rm(temp,{recursive:true,force:true});}
