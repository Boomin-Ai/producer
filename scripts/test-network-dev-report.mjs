/** Actual network report writer and both callers. Native file writes, clocks,
 * seat observations and UI-driver completion are simulated; no app/profile,
 * network, devices or media output are touched. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';

const read=name=>readFileSync(new URL(`../src/features/network/${name}.ts`,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source.replaceAll('import.meta.env','__env').replaceAll('import.meta.hot','__hot'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function writer(invoke=()=>{throw Error('Unexpected native invocation');}){
 const exports={};vm.runInNewContext(compile(read('networkDevReport')),{exports,require:name=>{
  assert.equal(name,'../../lib/nativeInvoke');return {invoke};
 }});return exports;
}

test('loading the network writer does not invoke native IPC',()=>{writer();});
test('concurrent reports start one at a time and preserve payload, order and each result',async()=>{
 const {createNetworkDevReportWriter}=writer(),gates=[deferred(),deferred(),deferred()],started=[];
 let active=0,maximum=0;
 const report=createNetworkDevReportWriter(async value=>{
  maximum=Math.max(maximum,++active);const index=started.push(value)-1;
  try{return await gates[index].promise;}finally{active--;}
 });
 const values=[{kind:'passive',samples:[{n:1}]},{kind:'pair',diagnostics:{samples:[{n:2}]}},{kind:'launch',outcome:'not_ready'}];
 const pending=values.map(report);await flush();assert.deepEqual(started,[values[0]]);
 for(let index=0;index<3;index++){
  gates[index].resolve('receipt-'+index);assert.equal(await pending[index],'receipt-'+index);await flush();
  assert.equal(started.length,Math.min(index+2,3));
 }
 assert.deepEqual(started,values);assert.equal(maximum,1);assert.equal(active,0);
});
for(const synchronous of [false,true])test(`a ${synchronous?'synchronously throwing':'rejected'} write cannot poison queued or later reports`,async()=>{
 const {createNetworkDevReportWriter}=writer(),failure=Error('synthetic write failure'),gate=deferred(),started=[];
 const report=createNetworkDevReportWriter(value=>{
  started.push(value);
  if(value==='first'){if(synchronous)throw failure;return gate.promise;}
  return Promise.resolve('saved '+value);
 });
 const first=report('first'),rejection=assert.rejects(first,error=>error===failure),second=report('second');
 await flush();if(!synchronous){assert.deepEqual(started,['first']);gate.reject(failure);}
 await rejection;assert.equal(await second,'saved second');assert.equal(await report('third'),'saved third');
 assert.deepEqual(started,['first','second','third']);
});
test('the singleton invokes only the existing dev-report command with its unchanged result envelope',async()=>{
 const calls=[],{reportNetworkDevResult}=writer(async(command,args)=>{calls.push({command,args});return 'saved';});
 const result={kind:'producer-network-passive',samples:[{elapsedMs:1}]};
 assert.equal(await reportNetworkDevResult(result),'saved');assert.equal(calls.length,1);
 assert.equal(calls[0].command,'live_set_v2_report');assert.equal(calls[0].args.result,result);
 assert.deepEqual(Object.keys(calls[0].args),['result']);
});

function actualCallers({failFirst=false}={}){
 let now=0,sequence=0,active=0,maximum=0,file='',identifierCalls=0;
 const timers=new Map(),native=[],firstWrite=deferred(),modules=new Map(),logs=[];
 const clock={setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);}};
 const fixture={version:1,workspace:{endpointId:'11111111-1111-4111-8111-111111111111',brandSlug:'synthetic'},
  localRoomId:'22222222-2222-4222-8222-222222222222',remoteRoomId:'33333333-3333-4333-8333-333333333333'};
 const env={DEV:true,VITE_PRODUCER_NETWORK_DIAGNOSTICS:'1',VITE_PRODUCER_NATIVE_PAIR_PROOF:'1',
  VITE_PRODUCER_NATIVE_PAIR_RUN:JSON.stringify({version:1,runId:'44444444-4444-4444-8444-444444444444',fixture})};
 const saved=new Map(),window={__TAURI_INTERNALS__:{},localStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)}};
 const document={visibilityState:'visible',querySelector:()=>({})};
 const session={current:()=>true,sample:async options=>options.enabled?{status:'sampled'}:null};
 const invoke=async(command,args)=>{
  assert.equal(command,'live_set_v2_report');maximum=Math.max(maximum,++active);native.push(args.result);
  try{
   // Hold the first native write open while both real frontend callers finish.
   if(native.length===1){await firstWrite.promise;if(failFirst)throw Error('synthetic file write failure');}
   assert.equal(active,1,'the simulated native output file must have only one writer');
   file=JSON.stringify(args.result,null,2);return 'saved';
  }finally{active--;}
 };
 function load(name){
  if(modules.has(name))return modules.get(name);
  const exports={};modules.set(name,exports);
  vm.runInNewContext(compile(read(name)),{exports,window,document,performance:{now:()=>now},...clock,__env:env,__hot:null,
   require:specifier=>{
    if(specifier==='@tauri-apps/api/app')return {getIdentifier:async()=>{identifierCalls++;return 'ai.boomin.producer.sets-v2-dev';}};
    if(specifier==='../../lib/nativeInvoke')return {invoke};
    if(specifier==='../../lib/ipc')return {ipc:{liveEngineStatus:async()=>({engine_ready:true})},uiLog:line=>logs.push(line)};
    if(specifier==='../../lib/guestSeat')return {activeGuestSeatDiagnosticSession:()=>session,subscribeGuestSeatDiagnosticSessions:()=>()=>{}};
    if(specifier==='../../lib/workspace')return {};
    if(specifier.startsWith('./'))return load(specifier.slice(2));
    throw Error('Unexpected import '+specifier);
   }});return exports;
 }
 window.__producerNativePairProof={status:()=>({phase:'idle',attempted:false}),cancel(){throw Error('Unexpected driver cancellation');},
  run:async()=>({kind:'producer-native-pair',version:1,reason:'completed',diagnostics:await window.__producerNetworkDiagnostics.run()})};
 return {load,native,logs,firstWrite,get file(){return file;},get maximum(){return maximum;},get identifierCalls(){return identifierCalls;},
  async advance(ms){await flush();const end=now+ms;for(;;){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
   if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].fn();await flush();}now=end;await flush();},
 };
}
for(const failFirst of [false,true])test(`actual passive completion and awaited launcher share one writer${failFirst?' after a native failure':''}`,async()=>{
 const h=actualCallers({failFirst});await h.load('networkDiagnosticsProof').installNetworkDiagnosticsProof();
 let finished=false;const launch=h.load('nativePairLaunch').launchNativePairFromEnvironment().then(()=>{finished=true;});
 await h.advance(60000);
 assert.equal(h.native.length,1);assert.equal(h.native[0].kind,'producer-network-passive');assert.equal(finished,false);
 assert.equal(h.native[0].sampleCount,60);assert.equal(h.native[0].samples.length,8);
 h.firstWrite.resolve();await launch;
 assert.equal(h.native.length,2);assert.equal(h.native[1].kind,'producer-native-pair');assert.equal(h.maximum,1);
 assert.equal(h.identifierCalls,2);assert.equal(h.native[1].diagnostics.samples.length,8);
 const parsed=JSON.parse(h.file);assert.equal(parsed.kind,'producer-native-pair');assert.equal(parsed.diagnostics.sampleCount,60);
 assert(Buffer.byteLength(h.file)<64*1024,'existing compact report remains within the native report budget');
 assert.doesNotMatch(h.file,/11111111|22222222|33333333|44444444|synthetic write failure/);
 assert.equal(h.logs.length,62,'all 60 sample records plus start/end remain independently logged');
});
