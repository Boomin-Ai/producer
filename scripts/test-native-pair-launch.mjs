/** No native app, invitation, media or provider connection is started here. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';
import {transformSync} from 'esbuild';

const read=name=>readFileSync(new URL(`../src/features/network/${name}.ts`,import.meta.url),'utf8');
function compile(source){return ts.transpileModule(source.replaceAll('import.meta.env','__env').replaceAll('import.meta.hot','__hot'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;}
const pairExports={};
vm.runInNewContext(compile(read('nativePairProof')),{exports:pairExports,__env:{DEV:false},__hot:null,require:()=>({})});
const fixture={version:1,workspace:{endpointId:'11111111-1111-4111-8111-111111111111',brandSlug:'kleveland'},
 localRoomId:'22222222-2222-4222-8222-222222222222',remoteRoomId:'33333333-3333-4333-8333-333333333333'};
const raw=JSON.stringify({version:1,runId:'44444444-4444-4444-8444-444444444444',fixture});
function harness({env={DEV:true,VITE_PRODUCER_NATIVE_PAIR_PROOF:'1',VITE_PRODUCER_NETWORK_DIAGNOSTICS:'1',VITE_PRODUCER_NATIVE_PAIR_RUN:raw},appId='ai.boomin.producer.sets-v2-dev',native=true}={}){
 let now=0,ready=true,current=true,visible=true,calls=0,identifierCalls=0,cancelled=0,disposer;
 const saved=new Map(),reports=[],storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
 const driver={status:()=>({phase:'idle',attempted:false}),run:async value=>{assert.deepEqual(JSON.parse(JSON.stringify(value)),fixture);calls++;return {reason:'completed',diagnostics:{samples:Array.from({length:60},(_,i)=>({elapsedMs:i*1000})),sampleCount:60}};},cancel:()=>{cancelled++;}};
 const document={get visibilityState(){return visible?'visible':'hidden';},querySelector:()=>ready?{}:null};
 const window={...native?{__TAURI_INTERNALS__:{}}:{},localStorage:storage,__producerNativePairProof:driver,__producerNetworkDiagnostics:{}};
 const deps={document,storage,now:()=>now,driver:()=>driver,diagnosticsReady:()=>ready,delay:async ms=>{now+=ms;},current:()=>current,report:async value=>reports.push(value)};
 const exports={};
 vm.runInNewContext(compile(read('nativePairLaunch')),{exports,__env:env,__hot:{dispose:fn=>{disposer=fn;}},window,document,performance:{now:()=>now},setTimeout:fn=>{now+=200;queueMicrotask(fn);},
  require:name=>{
   if(name==='@tauri-apps/api/app')return {getIdentifier:async()=>{identifierCalls++;return appId;}};
   if(name.endsWith('/nativePairProof'))return pairExports;
   if(name.endsWith('/nativeInvoke'))return {invoke:async(command,args)=>{assert.equal(command,'live_set_v2_report');reports.push(args.result);}};
   throw Error('Unexpected import '+name);
  }});
 return {exports,deps,window,driver,storage,saved,reports,get calls(){return calls;},get identifierCalls(){return identifierCalls;},get cancelled(){return cancelled;},
  ready(value){ready=value;},current(value){current=value;},visible(value){visible=value;},dispose:()=>disposer(),advance:ms=>{now+=ms;}};
}
test('only the bounded versioned launch and real fixture are accepted',()=>{
 const h=harness();assert.ok(h.exports.parseNativePairLaunch(raw));
 for(const value of [null,'','{',raw.repeat(100),JSON.stringify({version:2,runId:'x',fixture}),JSON.stringify({version:1,runId:'x',fixture}),
  JSON.stringify({version:1,runId:'44444444-4444-4444-8444-444444444444',fixture:{...fixture,localRoomId:'https://example.com'}}),
  JSON.stringify({...JSON.parse(raw),command:'start recording'})])assert.equal(h.exports.parseNativePairLaunch(value),null);
});
test('one explicitly configured run consumes its nonce before invoking the normal UI driver',async()=>{
 const h=harness();h.driver.run=async value=>{assert.ok(JSON.parse([...h.saved.values()][0]).includes(JSON.parse(raw).runId));h.driver.status=()=>({phase:'idle',attempted:true});return {reason:'completed',diagnostics:{sampleCount:60,samples:Array.from({length:60},(_,i)=>({elapsedMs:i*1000}))}};};
 assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'completed');assert.equal(h.reports.length,1);assert.equal(h.reports[0].diagnostics.samples.length,8);
 assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'already_consumed');assert.equal(h.reports.length,1);
});
test('an older nonce cannot replay after a different explicitly configured run',async()=>{
 const h=harness(),second=JSON.stringify({...JSON.parse(raw),runId:'55555555-5555-4555-8555-555555555555'});
 assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'completed');assert.equal(await h.exports.runConfiguredNativePair(second,h.deps),'completed');
 assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'already_consumed');assert.equal(h.calls,2);
});
test('a corrupt or full replay ledger fails closed and retains prior entries',async()=>{
 for(const ledger of ['{','x'.repeat(5000),JSON.stringify(Array(64).fill('55555555-5555-4555-8555-555555555555'))]){
  const h=harness();h.storage.getItem=()=>ledger;
  assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'storage_unavailable');assert.equal(h.calls,0);assert.equal(h.saved.size,0);
 }
});
test('a driver rejection stays fixed, private and consumed',async()=>{
 const h=harness();h.driver.run=async()=>{throw Error('SECRET provider payload');};
 assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'refused');assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'already_consumed');
 assert.ok(!JSON.stringify(h.reports).includes('SECRET'));
});
test('failed, cancelled and not-ready starts cannot retry the same nonce',async()=>{
 for(const mode of ['not-ready','cancelled','refused']){
  const h=harness();if(mode==='not-ready')h.ready(false);if(mode==='cancelled')h.current(false);if(mode==='refused')h.driver.run=async()=>({reason:'output_active',diagnostics:null});
  assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),mode==='not-ready'?'not_ready':mode);
  assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'already_consumed');assert.equal(h.calls,0);
 }
});
test('unavailable storage fails closed without UI actions',async()=>{
 const h=harness();h.deps.storage={getItem(){throw Error('private browser storage');},setItem(){throw Error('private browser storage');}};
 assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'storage_unavailable');assert.equal(h.calls,0);
});
test('a running or previously attempted driver is left untouched',async()=>{
 for(const status of [{phase:'measuring',attempted:true},{phase:'idle',attempted:true}]){
  const h=harness();h.driver.status=()=>status;assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'not_ready');assert.equal(h.calls,0);assert.equal(h.cancelled,0);
 }
});
test('hidden UI waits, then times out without starting a driver',async()=>{
 const h=harness();h.visible(false);assert.equal(await h.exports.runConfiguredNativePair(raw,h.deps),'not_ready');assert.equal(h.calls,0);
});
for(const options of [{env:{DEV:false}},{env:{DEV:true,VITE_PRODUCER_NATIVE_PAIR_PROOF:'1'}},{appId:'ai.boomin.producer'},{native:false}]){
 test('production, missing opt-in, wrong identity and browser cannot launch: '+JSON.stringify(options),async()=>{
  const h=harness(options);await h.exports.launchNativePairFromEnvironment();assert.equal(h.calls,0);assert.equal(h.saved.size,0);assert.equal(h.reports.length,0);
 });
}
test('the environment adapter launches once and HMR cancels only its owned driver',async()=>{
 const h=harness();await h.exports.launchNativePairFromEnvironment();assert.equal(h.calls,1);await h.exports.launchNativePairFromEnvironment();assert.equal(h.calls,1);h.dispose();assert.equal(h.cancelled,1);
 assert.ok(!JSON.stringify(h.reports).includes(fixture.workspace.endpointId));
});
test('production bundle eliminates the complete launch entry',()=>{
 const main=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
 const production=transformSync(main,{loader:'tsx',minifySyntax:true,define:{'import.meta.env.DEV':'false'}}).code;
 assert.doesNotMatch(production,/nativePairLaunch|nativePairProof|networkDiagnosticsProof/);
});
