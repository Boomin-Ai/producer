// Exercise production instrumentation against a controlled DOM/timer/IPC host.
// No browser/native app is launched, avoiding pollution of a live CPU baseline.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,readdir} from 'node:fs/promises';
import {transform} from 'esbuild';
import {performance} from 'node:perf_hooks';
const source=await readFile(new URL('../src/lib/performanceTrace.ts',import.meta.url),'utf8');
const {code}=await transform(source,{loader:'ts',format:'cjs',target:'es2022'});
const adapterSource=await readFile(new URL('../src/lib/nativeInvoke.ts',import.meta.url),'utf8');
const {code:adapterCode}=await transform(adapterSource,{loader:'ts',format:'cjs',target:'es2022'});
async function checkApplicationBoundary(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
  if(entry.isDirectory())await checkApplicationBoundary(path);
  else if(/\.[cm]?[jt]sx?$/.test(entry.name)&&path.pathname.endsWith('/lib/nativeInvoke.ts')===false){
   const text=await readFile(path,'utf8');assert(!/(?:from\s*|import\s*\()\s*['"]@tauri-apps\/api\/core['"]/.test(text),'application bypasses instrumented invoke boundary: '+path.pathname);
  }
 }
}
await checkApplicationBoundary(new URL('../src/',import.meta.url));
function environment(enabled=false,options={}){
 let clock=100,local=enabled,sharing=false,session=1,nextHandle=0,writeFailure=false,writeReceipt,configReads=0;
 const pendingConfigs=new Map();
 const writes=[],calls=[],extraListeners=new Map(),timeouts=new Map(),intervals=new Map(),frames=new Map(),clicks=new Set(),storage=new Map(),observerCallbacks=[];
 class Element {
  constructor(tag='BUTTON',attributes={},parentElement=null){this.tagName=tag;this.attributes=attributes;this.parentElement=parentElement;this.previousElementSibling=null;this.id='private-room-id';this.className='private-user-email@example.com';this.textContent='secret invite URL';this.value='secret entered password';}
  getAttribute(name){return this.attributes[name]??null;}
 }
 const document={visibilityState:'visible',addEventListener(type,callback){if(type==='click')clicks.add(callback);else extraListeners.set(type,callback);},removeEventListener(type,callback){if(type==='click')clicks.delete(callback);else if(extraListeners.get(type)===callback)extraListeners.delete(type);}};
 const bridge={invoke:function(command,...args){
  if(options.recordCalls!==false)calls.push({command,args,self:this});
  if(command==='performance_trace_config'){const step=options.configSamples?.[configReads++]??{};clock+=step.rtt??options.configRoundTripMs??0;if(step.error)return Promise.reject(Error('secret config failure'));const value={enabled:local,sharing,sessionId:'trace-session-'+session,version:'0.4.83',logicalCores:8,sessionElapsedMs:options.anchors===false?undefined:250,wallClockMs:options.anchors===false?undefined:1793798000000,...step.config};return step.defer?new Promise(resolve=>pendingConfigs.set(configReads,()=>resolve(value))):Promise.resolve(value);}
  if(command==='performance_trace_set_consent'){const next=args[0];if(next.local&&!local&&!options.sameNativeSession)session++;local=next.local;sharing=next.sharing;return Promise.resolve();}
  if(command==='performance_trace_write'){if(writeFailure)return Promise.reject(Error('secret native log error'));writes.push(structuredClone(args[0].batch));return Promise.resolve(writeReceipt===undefined?{accepted:args[0].batch.events.length,dropped:0,enabled:local}:writeReceipt);}
  if(command==='sync_failure')throw fixtureError;
  if(command==='reject_room')return Promise.reject(fixtureError);
  if(command==='sync_result')return 42;
  return fixturePromise;
 }};
 let resolveFixture;const fixturePromise=options.settledPromise?Promise.resolve(42):new Promise(r=>resolveFixture=r),fixtureError=Error('secret native rejection text');
 class Observer {static supportedEntryTypes=options.observers===false?[]:['event','longtask'];constructor(callback){observerCallbacks.push(callback);}observe(){}disconnect(){}}
 // Match the real framework property descriptor, rather than a writable mock.
 Object.defineProperty(bridge,'invoke',{value:bridge.invoke,writable:false,configurable:false});
 const core={invoke:function(...args){return Reflect.apply(bridge.invoke,this,args);},convertFileSrc:function(path){return 'unchanged:'+path;},isTauri:()=>true};
 const sandbox={module:{exports:{}},exports:{},window:{__TAURI_INTERNALS__:bridge},document,Element,PerformanceObserver:Observer,performance:{now:()=>options.realClock?performance.now():clock},localStorage:{setItem:(k,v)=>storage.set(k,v)},
  setTimeout:(f,ms)=>{const id=++nextHandle;timeouts.set(id,{f,ms});return id;},clearTimeout:id=>timeouts.delete(id),setInterval:f=>{const id=++nextHandle;intervals.set(id,f);return id;},clearInterval:id=>intervals.delete(id),
  requestAnimationFrame:f=>{const id=++nextHandle;frames.set(id,f);return id;},cancelAnimationFrame:id=>frames.delete(id),console};
 const adapterSandbox={...sandbox,module:{exports:{}},require:name=>{assert.equal(name,'@tauri-apps/api/core');return core;}};adapterSandbox.exports=adapterSandbox.module.exports;vm.runInNewContext(adapterCode,adapterSandbox,{filename:'nativeInvoke.cjs'});
 const app=adapterSandbox.module.exports;
 sandbox.require=name=>{assert.equal(name,'./nativeInvoke');return app;};sandbox.exports=sandbox.module.exports;vm.runInNewContext(code,sandbox,{filename:'performanceTrace.cjs'});
 return {api:sandbox.module.exports,app,core,bridge,writes,calls,original:bridge.invoke,document,Element,clicks,intervals,frames,fixturePromise,fixtureError,resolveFixture,
  click(target,trusted=true){for(const callback of [...clicks])callback({isTrusted:trusted,target});},
  advance(ms){clock+=ms;},runFrames(){const list=[...frames.values()];frames.clear();list.forEach(f=>f(clock));},
  runTimeouts(){const list=[...timeouts.values()];timeouts.clear();list.forEach(({f})=>f());},tick(){for(const callback of [...intervals.values()])callback();},
  setWriteFailure(value){writeFailure=value;},setWriteReceipt(value){writeReceipt=value;},resolveConfig(index){pendingConfigs.get(index)?.();pendingConfigs.delete(index);},pendingConfigs,dispatch(type,target){extraListeners.get(type)?.({isTrusted:true,target});},extraListeners,observerCallbacks};
}
const events=env=>env.writes.flatMap(batch=>batch.events);
const drain=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
{
 const env=environment(true);await env.api.initializePerformanceTrace();env.api.recordTraceEvent('room.acknowledgement',{},'room');
 env.setWriteReceipt({accepted:1,dropped:1,enabled:true});await env.api.flushPerformanceTrace();assert.equal(env.writes.length,1,'partially accepted batches are never retried');
 env.setWriteReceipt(undefined);await env.api.flushPerformanceTrace();const loss=events(env).find(e=>e.name==='diagnostics.native_batch_loss');assert.equal(loss.fields.submittedCount,2);assert.equal(loss.fields.nativeDroppedCount,1);assert.equal(loss.fields.acceptedCount,1);assert(env.writes.every(batch=>batch.droppedEvents===0),'native-acknowledged losses are not counted again as frontend drops');
 env.api.recordTraceEvent('room.uncertain',{},'room');env.setWriteReceipt(null);await env.api.flushPerformanceTrace();env.setWriteReceipt(undefined);await env.api.flushPerformanceTrace();const uncertain=events(env).find(e=>e.name==='diagnostics.native_batch_uncertain');assert.equal(uncertain.fields.unacknowledgedCount,1);assert.equal(uncertain.fields.receiptUncertain,true);assert(env.writes.every(batch=>batch.droppedEvents===0),'unknown receipts are uncertainty, not fabricated exact losses');
 env.api.recordTraceEvent('room.invalid_receipt',{},'room');env.setWriteReceipt({accepted:2,dropped:1,enabled:true});await env.api.flushPerformanceTrace();env.setWriteReceipt(undefined);await env.api.flushPerformanceTrace();assert.equal(events(env).filter(e=>e.name==='diagnostics.native_batch_uncertain').length,2,'contradictory receipt counts are uncertain');
 env.api.recordTraceEvent('room.disabled_receipt',{},'room');env.setWriteReceipt({accepted:0,dropped:1,enabled:false});await env.api.flushPerformanceTrace();env.setWriteReceipt(undefined);await env.api.flushPerformanceTrace();assert(events(env).some(e=>e.name==='diagnostics.native_batch_loss'&&e.fields.nativeEnabled===false));
}
{
 const env=environment();await env.api.initializePerformanceTrace();
 assert.equal(env.bridge.invoke,env.original,'disabled capture never patches native invoke');assert.equal(env.clicks.size,0);assert.equal(env.intervals.size,0);
 assert.equal(env.calls.filter(call=>call.command==='performance_trace_config').length,1,'disabled startup does not resample config');
 assert.equal(env.app.convertFileSrc,env.core.convertFileSrc);assert.equal(env.app.isTauri,env.core.isTauri,'unchanged SDK helpers are re-exported by identity');
 const owner={};assert.equal(env.app.invoke.call(owner,'sync_result'),42);assert.equal(env.calls.at(-1).self,owner);assert.equal(env.calls.at(-1).args.length,0,'omitted optional arguments stay omitted');
 env.api.recordTraceEvent('room.open',{elapsedMs:1},'room');await env.api.flushPerformanceTrace();assert.equal(env.writes.length,0);
 assert.deepEqual({...env.api.getPerformanceTraceConsent()},{local:false,sharing:false});
}
{
 const env=environment(true);const stop=await env.api.initializePerformanceTrace();
 assert.equal(env.bridge.invoke,env.original,'enabled tracing leaves the framework bridge unchanged');assert.equal(env.clicks.size,1);assert.equal(env.intervals.size,1);
 env.api.setTraceContext({roomVisit:7});
 const target=new env.Element('BUTTON',{},new env.Element('SECTION'));
 env.click(target,false);assert.equal(events(env).filter(e=>e.kind==='action').length,0,'synthetic clicks are not user actions');
 env.click(target);const payload={password:'secret IPC argument',url:'https://private.example/invite/secret'},options={headers:{Authorization:'secret header'}};
 const promise=env.app.invoke('get_room',payload,options);assert.equal(promise,env.fixturePromise,'original promise identity survives');
 const call=env.calls.at(-1);assert.equal(call.self,env.app);assert.equal(call.args[0],payload);assert.equal(call.args[1],options);
 const span=env.api.startTraceSpan('room.output',{sourceCount:3});env.api.setTraceContext({roomVisit:8});env.advance(18);env.runFrames();
 env.resolveFixture({password:'secret IPC response'});assert.equal((await promise).password,'secret IPC response');await drain();
 env.api.endTraceSpan(span,'ok',{durationMs:18});env.api.endTraceSpan(span,'ok');
 let rejected;await env.app.invoke('reject_room',{streamKey:'secret key'}).catch(error=>rejected=error);assert.equal(rejected,env.fixtureError);
 assert.throws(()=>env.app.invoke('sync_failure'),error=>error===env.fixtureError);assert.equal(env.app.invoke('sync_result'),42);
 env.api.recordTraceEvent('safe.metadata',{durationMs:3,email:'private@example.com',token:123,result:123,secretKey:123,videoHeight:1080});
 env.observerCallbacks[0]({getEntries:()=>[{name:'secret event name',duration:24,processingStart:110,startTime:100,processingEnd:122,target}]});
 await env.api.flushPerformanceTrace();
 const trace=events(env),text=JSON.stringify(env.writes);
 for(const secret of ['private-room-id','private-user-email','secret','password','https://','Authorization','streamKey','secretKey'])assert(!text.includes(secret),secret+' leaked');
 const ipc=trace.find(e=>e.kind==='ipc'&&e.name==='get_room');assert.equal(ipc.fields.roomVisit,7);assert.equal(ipc.actionId,trace.find(e=>e.kind==='action').actionId);assert.equal(ipc.durationMs,18);
 assert.equal(trace.filter(e=>e.kind==='span_end').length,1);assert.equal(trace.find(e=>e.kind==='span_end').fields.roomVisit,7);
 assert(trace.some(e=>e.kind==='presentation_opportunity'&&e.name==='ui.next_animation_frame'&&e.status==='observed'));
 assert.equal(trace.find(e=>e.name==='safe.metadata').fields.videoHeight,1080);
 const input=new env.Element('INPUT');for(let i=0;i<10;i++)env.dispatch('input',input);env.dispatch('change',input);
 env.dispatch('dragstart',target);env.advance(20);env.dispatch('drop',target);env.dispatch('dragend',target);
 env.click(new env.Element('BUTTON',{'data-perf-action':'settings.performance.local'}));env.advance(2101);env.tick();await drain();await env.api.flushPerformanceTrace();
 assert(events(env).some(e=>e.kind==='action'&&e.name==='ui.click:action:settings.performance.local'));
 assert(events(env).some(e=>e.kind==='presentation_opportunity'&&e.status==='unobserved'),'occluded rAF must not be called a completed action');
 assert(events(env).some(e=>e.name==='ui.timer_lag'));
 assert(events(env).some(e=>e.name.startsWith('ui.input:')&&e.fields.count===10));
 assert.equal(events(env).filter(e=>e.kind==='span_end'&&e.name.startsWith('ui.drag:')).length,1,'drop plus dragend ends gesture only once');
 assert(events(env).some(e=>e.name==='session.start'&&e.fields.nativeClockAligned===true));
 assert(events(env)[0].atMs>=250,'native session clock is the event time origin');
 assert(!JSON.stringify(env.writes).includes('secret entered password'));
 stop();assert.equal(env.bridge.invoke,env.original);assert.equal(env.clicks.size,0);assert.equal(env.intervals.size,0);assert.equal(env.frames.size,0);assert.equal(env.extraListeners.size,0);
}
{
 const env=environment(true,{sameNativeSession:true});await env.api.initializePerformanceTrace();env.api.setTraceContext({roomVisit:7});
 const explicit=env.api.startTraceSpan('room.close',{}, {roomVisit:3}),unassigned=env.api.startTraceSpan('room.unassigned',{},{}),current=env.api.startTraceSpan('room.current'),savedContext=env.api.snapshotTraceContext();assert(Object.isFrozen(savedContext));
 env.api.setTraceContext({roomVisit:8});env.click(new env.Element('BUTTON'));env.api.recordTraceEvent('set.delayed',{elapsedMs:12},'set',savedContext);env.api.recordTraceEvent('set.unassigned',{},'set',{});env.api.endTraceSpan(explicit);env.api.endTraceSpan(unassigned);env.api.endTraceSpan(current);env.click(new env.Element('BUTTON'));
 await env.api.flushPerformanceTrace();const first=events(env),firstAction=first.find(e=>e.kind==='action').actionId,firstSpan=explicit.id;
 assert.equal(first.find(e=>e.name==='room.close'&&e.kind==='span_end').fields.roomVisit,3);assert.equal(first.find(e=>e.name==='room.current'&&e.kind==='span_end').fields.roomVisit,7);assert(!('roomVisit' in first.find(e=>e.name==='room.unassigned'&&e.kind==='span_end').fields),'explicit empty span context stays outside a later room');assert.equal(first.find(e=>e.name==='set.delayed').fields.roomVisit,7,'delayed semantic events keep their originating visit');assert.equal(first.find(e=>e.name==='set.delayed').actionId,undefined,'delayed semantic work cannot inherit a new unrelated click');assert(!('roomVisit' in first.find(e=>e.name==='set.unassigned').fields));
 await env.api.setPerformanceTraceConsent({local:false,sharing:false});await env.api.setPerformanceTraceConsent({local:true,sharing:false});env.click(new env.Element('BUTTON'));const nextSpan=env.api.startTraceSpan('room.next');await env.api.flushPerformanceTrace();
 assert.notEqual(nextSpan.id,firstSpan,'span IDs cannot repeat within a persistent native session');assert.notEqual(events(env).filter(e=>e.kind==='action').at(-1).actionId,firstAction,'action IDs cannot repeat within a persistent native session');assert(env.writes.every(batch=>batch.sessionId==='trace-session-1'));
}
{
 const env=environment(true);await env.api.initializePerformanceTrace();
 for(let index=0;index<1000;index++)env.api.recordTraceEvent('sample.metric',{index});
 await env.api.flushPerformanceTrace();
 assert.equal(events(env).length,512,'event buffer is bounded including session-start');assert(env.writes.every(batch=>batch.events.length<=64));
 assert.equal(env.writes.reduce((sum,batch)=>sum+batch.droppedEvents,0),489,'overflow is explicit');
 assert(!events(env).some(e=>e.kind==='ipc'&&e.name.startsWith('performance_trace_')),'trace writes cannot trace themselves');
 env.setWriteFailure(true);env.api.recordTraceEvent('sample.failed');await env.api.flushPerformanceTrace();
 env.setWriteFailure(false);env.advance(1000);env.tick();await drain();
 assert(events(env).some(e=>e.name==='diagnostics.native_batch_uncertain'&&e.fields.writeFailed===true&&e.fields.unacknowledgedCount===1),'write/ACK failures are explicitly uncertain');
 assert.equal(env.writes.at(-1).droppedEvents,0,'write/ACK failures do not fabricate an exact event-loss count');
 await env.api.setPerformanceTraceConsent({local:false,sharing:true});assert.equal(env.bridge.invoke,env.original);assert.equal(env.clicks.size,0);
 assert.deepEqual({...env.api.getPerformanceTraceConsent()},{local:false,sharing:false},'sharing requires local consent');
 await env.api.setPerformanceTraceConsent({local:true,sharing:true});assert.equal(env.bridge.invoke,env.original,'enabled tracing leaves the framework bridge unchanged');assert.deepEqual({...env.api.getPerformanceTraceConsent()},{local:true,sharing:true});
 const stale=env.api.startTraceSpan('room.old');await env.api.setPerformanceTraceConsent({local:false,sharing:false});await env.api.setPerformanceTraceConsent({local:true,sharing:false});
 env.api.endTraceSpan(stale);await env.api.flushPerformanceTrace();assert(!events(env).some(e=>e.kind==='span_end'&&e.name==='room.old'),'old spans do not cross consent sessions');
}
{
 const env=environment(true);await env.api.initializePerformanceTrace();
 let observations=0;const restoreOther=env.app.observeNativeInvoke(()=>{observations++;return()=>{};});
 await env.api.setPerformanceTraceConsent({local:false,sharing:false});const before=env.writes.length;assert.equal(env.app.invoke('sync_result'),42);assert.equal(observations,1,'stopping tracing does not remove a later observer');restoreOther();
 assert.equal(env.app.invoke('sync_result'),42);await env.api.flushPerformanceTrace();assert.equal(env.writes.length,before,'restored stopped collectors are inert');assert.equal(env.bridge.invoke,env.original);
}
{
 const env=environment(true);await env.api.initializePerformanceTrace();
 for(let i=0;i<5;i++)env.app.invoke('live_status');env.advance(7);env.resolveFixture(1);await drain();env.dispatch('input',new env.Element('INPUT'));
 env.advance(993);env.tick();await drain();assert(!events(env).some(e=>e.kind==='ipc'),'fast IPC summaries remain buffered at 1s');assert(events(env).some(e=>e.name.startsWith('ui.input:')),'input summaries still flush at 1s');
 for(let i=0;i<3;i++){env.advance(1000);env.tick();await drain();}assert(!events(env).some(e=>e.kind==='ipc'),'fast IPC summaries remain buffered before 5s');
 env.advance(1000);env.tick();await drain();let summaries=events(env).filter(e=>e.kind==='ipc');assert.equal(summaries.length,1);assert.equal(summaries[0].fields.count,5);assert.equal(summaries[0].fields.sumDurationMs,35);assert.equal(summaries[0].fields.maxDurationMs,7);assert.equal(summaries[0].fields.windowMs,5000);
 for(let i=0;i<3;i++)env.app.invoke('sync_result');env.advance(2000);await env.api.flushPerformanceTrace();summaries=events(env).filter(e=>e.kind==='ipc');assert.equal(summaries.length,2,'user export forces a partial background window');assert.equal(summaries[1].fields.windowMs,2000);assert.equal(summaries.reduce((sum,e)=>sum+e.fields.count,0),8);assert.equal(summaries.reduce((sum,e)=>sum+e.fields.sumDurationMs,0),35,'aggregation preserves count and total duration');
 const beforeGrant=env.calls.length;env.app.invoke('sync_result');await env.api.setPerformanceTraceConsent({local:true,sharing:true});const grant=env.calls.findIndex(call=>call.command==='performance_trace_set_consent');assert(grant>beforeGrant&&env.calls.slice(beforeGrant,grant).some(call=>call.command==='performance_trace_write'&&call.args[0].batch.events.some(event=>event.kind==='ipc'&&event.fields.count===1)),'pre-grant local background aggregates flush before native sharing consent');
}
{
 const env=environment(true);await env.api.initializePerformanceTrace();
 for(let i=0;i<1000;i++)assert.equal(env.app.invoke('sync_result'),42);
 await env.api.flushPerformanceTrace();const summaries=events(env).filter(e=>e.kind==='ipc');
 assert.equal(summaries.length,1,'fast background IPC calls coalesce by command');assert.equal(summaries[0].fields.count,1000);assert.equal(summaries[0].fields.aggregated,true);
 for(let i=0;i<1000;i++)env.api.recordTraceEvent('sample.background',{index:i});
 env.click(new env.Element('BUTTON'));env.runFrames();env.api.recordTraceEvent('room.ready',{elapsedMs:18},'room');await env.api.flushPerformanceTrace();
 assert(events(env).some(e=>e.kind==='action'&&e.name.startsWith('ui.click:')),'background pressure must not evict clicks');
 assert(events(env).some(e=>e.kind==='room'&&e.name==='room.ready'),'background pressure must not evict room milestones');
}
{
 const env=environment(true);await env.api.initializePerformanceTrace();
 const pending=env.app.invoke('slow_room');env.advance(70);env.resolveFixture(1);await pending;await drain();await env.api.flushPerformanceTrace();
 assert(events(env).some(e=>e.kind==='ipc'&&e.name==='slow_room'&&e.durationMs===70&&!e.fields.aggregated),'slow background IPC keeps its individual timing');
}
{
 const env=environment(true,{observers:false,anchors:false});await env.api.initializePerformanceTrace();await env.api.flushPerformanceTrace();
 const start=events(env).find(e=>e.name==='session.start');assert.equal(start.fields.eventTiming,false);assert.equal(start.fields.longTasks,false);assert.equal(start.fields.nativeClockAligned,false);assert(!('nativeSessionAnchorMs' in start.fields));env.api.recordTraceEvent('room.unaligned',{},'room');await env.api.flushPerformanceTrace();assert(events(env).every(event=>event.fields.nativeClockAligned===false&&event.fields.clockUncertaintyMs===0),'each unaligned frontend record is marked for conservative sharing');
}
{
 const env=environment(true,{configSamples:[{rtt:3000,config:{sessionElapsedMs:0}},{rtt:2,config:{sessionElapsedMs:1}}]});await env.api.initializePerformanceTrace();await env.api.flushPerformanceTrace();
 const start=events(env).find(e=>e.name==='session.start');assert.equal(start.fields.configRoundTripMs,2);assert.equal(start.fields.clockUncertaintyMs,1);assert.equal(start.fields.frontendAnchorMs,3101);assert.equal(start.fields.nativeSessionAnchorMs,1);assert.equal(start.atMs,2);assert.equal(env.calls.filter(call=>call.command==='performance_trace_config').length,2,'enabled cold startup gets exactly one ready-state resample');
}
{
 const env=environment(true,{configSamples:[{rtt:2,config:{sessionElapsedMs:1}},{rtt:20,config:{sessionElapsedMs:12,logicalCores:16,debugBuild:true}}]});await env.api.initializePerformanceTrace();await env.api.flushPerformanceTrace();
 const start=events(env).find(e=>e.name==='session.start');assert.equal(start.fields.configRoundTripMs,2);assert.equal(start.fields.clockUncertaintyMs,1);assert.equal(start.fields.nativeSessionAnchorMs,1);assert.equal(start.fields.logicalCores,16,'latest metadata remains authoritative when an earlier clock sample wins');assert.equal(start.fields.debugBuild,true);
}
{
 const env=environment(true,{configSamples:[{rtt:2},{rtt:20,config:{sessionId:'trace-new-session',sessionElapsedMs:12}}]});await env.api.initializePerformanceTrace();await env.api.flushPerformanceTrace();
 assert(env.writes.every(batch=>batch.sessionId==='trace-new-session'));assert.equal(events(env)[0].fields.clockUncertaintyMs,10,'clock anchors cannot cross native sessions');
}
{
 const env=environment(true,{configSamples:[{rtt:2},{rtt:20,config:{sharing:true}}]});await env.api.initializePerformanceTrace();await env.api.flushPerformanceTrace();
 assert.equal(env.api.getPerformanceTraceConsent().sharing,true);assert.equal(events(env)[0].fields.clockUncertaintyMs,10,'clock anchors cannot cross native consent scopes');
 const disabled=environment(true,{configSamples:[{rtt:2},{rtt:20,config:{enabled:false}}]});await disabled.api.initializePerformanceTrace();assert.equal(disabled.bridge.invoke,disabled.original);assert.equal(disabled.api.getPerformanceTraceConsent().local,false,'a later disabled response wins over a faster enabled response');
}
{
 const env=environment(true,{configSamples:[{rtt:3000},{rtt:2,error:true}]});await env.api.initializePerformanceTrace();await env.api.flushPerformanceTrace();
 const start=events(env).find(e=>e.name==='session.start');assert.equal(start.fields.clockUncertaintyMs,1500,'failed resamples retain first-read uncertainty');assert.equal(start.fields.configRoundTripMs,3000);
}
{
 const env=environment(false,{configSamples:[{}, {rtt:800}, {rtt:2}]});await env.api.initializePerformanceTrace();await env.api.setPerformanceTraceConsent({local:true,sharing:false});await env.api.flushPerformanceTrace();assert.equal(events(env)[0].fields.clockUncertaintyMs,1,'consent enable uses the same ready-state sampling helper');
}
{
 const env=environment(true,{configSamples:[{}, {defer:true},{}]});const initialization=env.api.initializePerformanceTrace();await drain();assert(env.pendingConfigs.has(2),'second config request is pending');await env.api.setPerformanceTraceConsent({local:false,sharing:false});env.resolveConfig(2);await initialization;assert.equal(env.bridge.invoke,env.original);assert.equal(env.api.getPerformanceTraceConsent().local,false,'a resample cannot override a newer explicit opt-out');
}
{
 const env=environment(true,{configRoundTripMs:20});await env.api.initializePerformanceTrace();await env.api.flushPerformanceTrace();
 const start=events(env).find(e=>e.name==='session.start');assert.equal(start.atMs,260);assert.equal(start.fields.frontendAnchorMs,130);assert.equal(start.fields.clockAnchorUncertaintyMs,10);assert.equal(start.fields.configRoundTripMs,20);env.api.recordTraceEvent('room.aligned',{},'room');await env.api.flushPerformanceTrace();assert(events(env).every(event=>event.fields.nativeClockAligned===true&&event.fields.clockUncertaintyMs===10),'each aligned frontend record carries its native-clock uncertainty');
}
{
 const env=environment();await env.api.initializePerformanceTrace();await Promise.all([env.api.setPerformanceTraceConsent({local:true,sharing:true}),env.api.setPerformanceTraceConsent({local:false,sharing:false})]);
 assert.equal(env.bridge.invoke,env.original);assert.deepEqual({...env.api.getPerformanceTraceConsent()},{local:false,sharing:false},'last authoritative consent wins concurrent toggles');
}
{
 const env=environment(true),descriptor=Object.getOwnPropertyDescriptor(env.bridge,'invoke');assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);const stop=await env.api.initializePerformanceTrace();
 assert.equal(env.bridge.invoke,env.original,'immutable framework bridge remains untouched');env.click(new env.Element('BUTTON'));const originalPromise=env.app.invoke('live_restore_room');env.core.invoke('plugin_internal_call');env.advance(60);env.resolveFixture(42);assert.equal(await originalPromise,42);await drain();await env.api.flushPerformanceTrace();
 const start=events(env).find(e=>e.name==='session.start');assert.equal(start.fields.ipcTiming,true,'application IPC is timed with an immutable Tauri bridge');assert.equal(start.fields.ipcApplicationBoundary,true);assert.equal(start.fields.ipcPluginInternal,false,'plugin-internal coverage is explicitly unavailable');assert(events(env).some(e=>e.kind==='ipc'&&e.name==='live_restore_room'&&e.durationMs===60));assert(!events(env).some(e=>e.name==='plugin_internal_call'),'SDK/plugin calls outside the application adapter are not claimed');stop();
 const before=env.writes.length;env.app.invoke('sync_result');await env.api.flushPerformanceTrace();assert.equal(env.writes.length,before,'disabled adapter records no IPC');
}
{
 const env=environment();const remove=env.app.observeNativeInvoke(()=>()=>{throw Error('diagnostic callback failure');});assert.equal(env.app.invoke('sync_result'),42);let rejected;await env.app.invoke('reject_room').catch(error=>rejected=error);assert.equal(rejected,env.fixtureError);remove();
 const removeFactory=env.app.observeNativeInvoke(()=>{throw Error('diagnostic observer failure');});assert.throws(()=>env.app.invoke('sync_failure'),error=>error===env.fixtureError);removeFactory();
}
console.log('PASS: immutable Tauri bridge; application invoke coverage; exact promise/value/this/rejection semantics; unchanged core helpers; opt-in privacy; bounded batching/aggregation/drop counts; no recursion; room/clock correlation; cleanup; explicit plugin-internal coverage limit');
if(process.argv.includes('--benchmark')){
 const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const results=[];
 for(const mode of ['sync','promise']){
  const count=mode==='sync'?100000:10000,trials={disabled:[],enabled:[]};
  const disabled=environment(false,{recordCalls:false,realClock:true,settledPromise:true}),enabled=environment(true,{recordCalls:false,realClock:true,settledPromise:true});
  await disabled.api.initializePerformanceTrace();await enabled.api.initializePerformanceTrace();
  for(let trial=-1;trial<7;trial++)for(const key of trial%2?['enabled','disabled']:['disabled','enabled']){
   const env=key==='enabled'?enabled:disabled,command=mode==='sync'?'sync_result':'get_status';
   const start=performance.now();for(let i=0;i<count;i++){const value=env.app.invoke(command);if(mode==='promise')await value;}const elapsedMs=performance.now()-start;
   if(trial>=0)trials[key].push(elapsedMs);await env.api.flushPerformanceTrace();
  }
  const disabledMedianMs=median(trials.disabled),enabledMedianMs=median(trials.enabled);
  results.push({mode,callsPerTrial:count,trials:7,disabledMedianMs,enabledMedianMs,addedMicrosecondsPerCall:(enabledMedianMs-disabledMedianMs)*1000/count,enabledEventCount:events(enabled).length,notes:'Synthetic Node VM with mocked native bridge; no rendering, native roundtrip, GPU or production CPU measurement.'});
 }
 console.log(JSON.stringify({benchmark:'performance-trace-synthetic',results},null,2));
}
