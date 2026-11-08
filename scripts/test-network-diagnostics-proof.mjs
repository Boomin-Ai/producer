/** Actual passive driver, isolated clock/seat/native IPC. No app, devices,
 * active invitations, recording, tones or provider network traffic. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';
import {transformSync} from 'esbuild';
const source=readFileSync(new URL('../src/features/network/networkDiagnosticsProof.ts',import.meta.url),'utf8')
 .replaceAll('import.meta.env','__env').replaceAll('import.meta.hot','__hot');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const receiver=kind=>({kind,status:'available',trackLive:true,enabled:true,muted:false,decodeProgress:'advancing',lastDecodeAdvanceAgeMs:0,
 counters:{width:kind==='video'?960:null,height:kind==='video'?540:null,id:'SECRET'},
 delta:{windowMs:1000,framesDecoded:kind==='video'?20:null,framesReceived:kind==='video'?20:null,bytesReceived:2000,
  totalSamplesDuration:kind==='audio'?1:null,totalAudioEnergy:kind==='audio'?0.01:null,audioRms:kind==='audio'?0.1:null,concealedSamples:0}});
function fixture({active=true,env={DEV:true,VITE_PRODUCER_NETWORK_DIAGNOSTICS:'1'},appId='ai.boomin.producer.sets-v2-dev',native=true}={}){
 let now=0,seq=0,live=active,disposed=false,engineCalls=0,seatCalls=0,identifierCalls=0,readEngine=async()=>({engine_ready:true,cpu:2,fps:60,render_time_us:100,skipped_frames:0,total_frames:100,video_height:1080,video_fps:60,
  sources:{items:[{id:'SECRET-ID',label:'SECRET-LABEL',device:'SECRET-DEVICE',kind:'camera',src_w:960,src_h:540,has_audio:false},{kind:'guest',src_w:960,src_h:540,has_audio:true,muted:false}]}});
 let sample=async options=>{seatCalls++;return options.enabled?{status:'sampled',sampledAtMs:now,video:receiver('video'),audio:receiver('audio')}:null;};
 const timers=new Map(),listeners=new Set(),logs=[],reports=[],window=native?{__TAURI_INTERNALS__:{}}:{};let disposeModule;
 const session={current:()=>live&&!disposed,sample:options=>sample(options)};
 let current=session;
 const getSession=()=>live?current:null;
 const clock={setTimer(fn,ms){const id=++seq;timers.set(id,{fn,at:now+ms});return id;},clearTimer(id){timers.delete(id);}};
 const deps={now:()=>now,...clock,getSession,subscribeSession(fn){listeners.add(fn);return()=>listeners.delete(fn);},readEngine:()=>{engineCalls++;return readEngine();},log:line=>logs.push(line),report:async value=>{reports.push(value);}};
 const exports={};vm.runInNewContext(compiled,{exports,Map,Set,Promise,JSON,Number,Math,performance:{now:()=>now},window,setTimeout:clock.setTimer,clearTimeout:clock.clearTimer,
  __env:env,__hot:{dispose(fn){disposeModule=fn;}},require:name=>{
   if(name==='@tauri-apps/api/app')return {async getIdentifier(){identifierCalls++;return typeof appId==='function'?await appId():appId;}};
   if(name.endsWith('/ipc'))return {ipc:{liveEngineStatus:deps.readEngine},uiLog:deps.log};
   if(name.endsWith('/networkDevReport'))return {reportNetworkDevResult:async result=>{reports.push(result);}};
   if(name.endsWith('/guestSeat'))return {activeGuestSeatDiagnosticSession:getSession,subscribeGuestSeatDiagnosticSessions:deps.subscribeSession};
   throw Error('Unexpected import '+name);
  }});
 return {exports,deps,window,timers,listeners,logs,reports,session,
  get engineCalls(){return engineCalls;},get seatCalls(){return seatCalls;},get identifierCalls(){return identifierCalls;},
  engine(fn){readEngine=fn;},sample(fn){sample=fn;},
  change(value){live=value;for(const fn of listeners)fn();},replace(){current={...session};for(const fn of listeners)fn();},
  disposeModule(){disposed=true;disposeModule();},
  async advance(ms){await flush();const end=now+ms;for(;;){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].fn();await flush();}now=end;await flush();},
 };
}
test('installation and construction never auto-start diagnostics or media work',async()=>{
 const h=fixture();await h.exports.installNetworkDiagnosticsProof();assert.ok(h.window.__producerNetworkDiagnostics);assert.equal(h.engineCalls,0);assert.equal(h.seatCalls,0);assert.equal(h.timers.size,0);assert.equal(h.window.__producerNetworkDiagnostics.status().state,'idle');
});
for(const options of [{env:{DEV:false,VITE_PRODUCER_NETWORK_DIAGNOSTICS:'1'}},{env:{DEV:true,VITE_PRODUCER_NETWORK_DIAGNOSTICS:'0'}},{native:false},{appId:'ai.boomin.producer'},{appId:'ai.boomin.producer.sets-v2-dev.evil'}]){
 test('installer rejects production, browser, disabled or nonallowlisted application: '+JSON.stringify(options),async()=>{
  const h=fixture(options);await h.exports.installNetworkDiagnosticsProof();assert.equal(h.window.__producerNetworkDiagnostics,undefined);assert.equal(h.engineCalls,0);assert.equal(h.seatCalls,0);assert.equal(h.timers.size,0);
 });
}
test('Windows dev bundle is allowed and never invokes Mac-only report persistence',async()=>{
 const h=fixture({active:false,appId:'ai.boomin.producer.windows-network-dev'});await h.exports.installNetworkDiagnosticsProof();const running=h.window.__producerNetworkDiagnostics.run();await h.advance(15000);assert.equal((await running).reason,'no_active_seat');assert.equal(h.reports.length,0);assert.equal(h.logs.length,1);
});
test('a single explicit run records at most 60 sanitized 1Hz samples then releases all timers/listeners',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);const run=driver.run();assert.equal(driver.run(),run);await h.advance(60000);const report=await run;
 assert.equal(report.reason,'completed');assert.equal(report.sampleCount,60);assert.equal(report.measurementMs,60000);assert.equal(report.waitMs,0);assert.equal(report.summary.decodedFrames,1200);assert.equal(report.summary.cpuMachinePercent.median,2);
 assert.equal(report.coverage.nativeMixer,'unavailable');assert.equal(report.coverage.presentedVideo,'unavailable');assert.equal(report.coverage.speakerAudibility,'unavailable');assert.equal(report.coverage.sourceFreshness,'dimensions_only');
 assert.equal(h.logs.length,62);assert.equal(h.reports[0].samples.length,8);assert.ok(!JSON.stringify(report).includes('SECRET'));assert.ok(!h.logs.join('').includes('SECRET'));assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);assert.equal(driver.status().state,'idle');
 const before=h.engineCalls;await h.advance(60000);assert.equal(h.engineCalls,before);
});
test('missing active modern seat times out without engine or receiver calls',async()=>{
 const h=fixture({active:false}),driver=h.exports.createNetworkDiagnosticsProof(h.deps),run=driver.run();await h.advance(15000);const result=await run;
 assert.equal(result.reason,'no_active_seat');assert.equal(result.sampleCount,0);assert.equal(result.waitMs,15000);assert.equal(result.measurementMs,0);assert.equal(h.engineCalls,0);assert.equal(h.seatCalls,0);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});
test('an already-created seat becoming active starts measurement without any join operation',async()=>{
 const h=fixture({active:false}),driver=h.exports.createNetworkDiagnosticsProof(h.deps),run=driver.run();await h.advance(5000);assert.equal(h.seatCalls,0);h.change(true);await h.advance(60000);const result=await run;assert.equal(result.reason,'completed');assert.equal(result.waitMs,5000);assert.equal(result.measurementMs,60000);assert.equal(result.sampleCount,60);
});
for(const replacement of [false,true])test('session removal or replacement ends the run without following a new connection: '+replacement,async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps),run=driver.run();await h.advance(2100);if(replacement)h.replace();else h.change(false);await flush();await h.advance(1000);const result=await run;assert.equal(result.reason,'session_changed');assert.ok(result.sampleCount<60);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});
test('cancellation and disposal wake waiting or blocked work immediately and discard late results',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);let resolve;h.engine(()=>new Promise(done=>{resolve=done;}));const run=driver.run();await flush();driver.dispose();await flush();const result=await run;assert.equal(result.reason,'disposed');assert.equal(result.sampleCount,0);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);resolve({engine_ready:true,cpu:900});await flush();assert.equal(result.sampleCount,0);assert.equal(driver.status().state,'disposed');
 const next=await driver.run();assert.equal(next.reason,'disposed');assert.equal(h.engineCalls,1);
 const waiting=fixture({active:false}),other=waiting.exports.createNetworkDiagnosticsProof(waiting.deps),pending=other.run();await flush();other.cancel();assert.equal((await pending).reason,'cancelled');assert.equal(waiting.timers.size,0);
});
test('hung engine IPC remains one in-flight read across the entire bounded run',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);h.engine(()=>new Promise(()=>{}));const run=driver.run();await h.advance(60000);const result=await run;assert.equal(result.reason,'completed');assert.equal(h.engineCalls,1);assert.equal(result.summary.engineSamples,0);assert.equal(result.sampleCount,60);assert.equal(h.timers.size,0);
});
test('authority expiry reported by the actual receiver ends measurement immediately',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);h.sample(async options=>options.enabled?{status:'unavailable'}:null);const run=driver.run();await flush();const result=await run;assert.equal(result.reason,'session_changed');assert.equal(result.sampleCount,0);assert.equal(h.timers.size,0);
});
test('a synchronous diagnostic failure remains bounded and cannot leak provider text',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);h.sample(()=>{throw Error('SECRET-DIAGNOSTIC');});const result=await driver.run();await flush();assert.equal(result.reason,'failed');assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!h.logs.join('').includes('SECRET'));
});
test('unsupported receiver and native failures report coverage without error/provider strings',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);h.engine(async()=>{throw Error('SECRET-PROVIDER');});h.sample(async()=>null);const run=driver.run();await h.advance(60000);const result=await run;assert.equal(result.summary.engineSamples,0);assert.equal(result.summary.videoStatsSamples,0);assert.equal(result.summary.decodedFrames,null);assert.equal(result.summary.decodedAudioSeconds,null);assert.equal(result.summary.videoDeltaSamples,0);assert.equal(result.summary.audioDeltaSamples,0);assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!h.logs.join('').includes('SECRET'));
});
test('even-sized distributions average both middle values across varied 60-sample baseline',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);let sample=0;h.engine(async()=>({engine_ready:true,cpu:sample++,fps:60,render_time_us:100}));
 const run=driver.run();await h.advance(60000);const result=await run;assert.equal(result.summary.cpuMachinePercent.count,60);assert.equal(result.summary.cpuMachinePercent.minimum,0);assert.equal(result.summary.cpuMachinePercent.median,29.5);assert.equal(result.summary.cpuMachinePercent.p95,56);assert.equal(result.summary.cpuMachinePercent.maximum,59);
});
test('observed zero frame/audio deltas remain zero with valid coverage rather than missing',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);h.sample(async options=>{
  if(!options.enabled)return null;const video=receiver('video'),audio=receiver('audio');video.delta.framesDecoded=0;audio.delta.totalSamplesDuration=0;
  return {status:'sampled',sampledAtMs:0,video,audio};
 });
 const run=driver.run();await h.advance(60000);const result=await run;assert.equal(result.summary.decodedFrames,0);assert.equal(result.summary.decodedAudioSeconds,0);assert.equal(result.summary.videoDeltaSamples,60);assert.equal(result.summary.audioDeltaSamples,60);
});
test('passive reports preserve numeric receiver timing distributions, privacy, compact budget and overlapping coverage',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);let index=0;
 h.sample(async options=>{
  if(!options.enabled)return null;
  const value=index++,video=receiver('video'),audio=receiver('audio');
  Object.assign(video.delta,{jitterBufferAverageMs:value,jitterBufferTargetAverageMs:value+10,jitterBufferMinimumAverageMs:value/2,decodeAverageMs:value/10,processingAverageMs:value+20});
  Object.assign(audio.delta,{jitterBufferAverageMs:value*2,jitterBufferTargetAverageMs:value*2+10,jitterBufferMinimumAverageMs:0,decodeAverageMs:999,processingAverageMs:999});
  return {status:'sampled',video,audio};
 });
 const run=driver.run();await h.advance(60000);const result=await run,timing=result.summary.receiverTimingMs;
 assert.equal(result.coverage.receiverTiming,'overlapping_receiver_components_ms_not_end_to_end');
 assert.equal(timing.video.jitterBufferAverageMs.count,60);assert.equal(timing.video.jitterBufferAverageMs.minimum,0);
 assert.equal(timing.video.jitterBufferAverageMs.median,29.5);assert.equal(timing.video.jitterBufferAverageMs.p95,56);assert.equal(timing.video.jitterBufferAverageMs.maximum,59);
 assert.equal(timing.video.jitterBufferTargetAverageMs.median,39.5);assert.equal(timing.video.jitterBufferMinimumAverageMs.median,14.75);
 assert.equal(timing.video.decodeAverageMs.median,2.95);assert.equal(timing.video.processingAverageMs.median,49.5);
 assert.equal(timing.audio.jitterBufferAverageMs.median,59);assert.equal(timing.audio.jitterBufferMinimumAverageMs.count,60);assert.equal(timing.audio.jitterBufferMinimumAverageMs.median,0);
 assert.equal(timing.audio.decodeAverageMs.count,0);assert.equal(timing.audio.decodeAverageMs.median,null);assert.equal(timing.audio.processingAverageMs.count,0);
 assert.equal(result.samples[59].audio.processingAverageMs,null);assert.equal(h.reports[0].samples.length,8);
 assert(Buffer.byteLength(JSON.stringify(h.reports[0],null,2))<64*1024);
 assert.equal(h.logs.length,62);assert.ok(h.logs.every(line=>line.length<=2000));
 for(const line of h.logs)assert.doesNotThrow(()=>JSON.parse(line.slice('[network-diagnostics] '.length)));
 const end=JSON.parse(h.logs.at(-1).slice('[network-diagnostics] '.length));assert.equal(end.value.summary.receiverTimingMs,undefined);
 assert.doesNotMatch(JSON.stringify(result),/SECRET|receiverId|candidate|address/);assert.doesNotMatch(h.logs.join(''),/SECRET/);
});
test('long numeric sample and summary fields stay valid JSON within the native per-line log budget',async t=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);
 h.engine(async()=>({engine_ready:true,cpu:123.12345678901234,fps:59.98765432109876,render_time_us:123456.12345678901,
  skipped_frames:Number.MAX_SAFE_INTEGER,total_frames:Number.MAX_SAFE_INTEGER,video_height:7680,video_fps:120,sources:{items:[]}}));
 h.sample(async options=>{
  if(!options.enabled)return null;
  const video=receiver('video'),audio=receiver('audio');
  for(const item of [video,audio]){
   item.lastDecodeAdvanceAgeMs=123456.12345678901;
   Object.assign(item.delta,{windowMs:1234.1234567890123,framesDecoded:Number.MAX_SAFE_INTEGER,framesReceived:Number.MAX_SAFE_INTEGER,
    bytesReceived:Number.MAX_SAFE_INTEGER,totalSamplesDuration:1234.1234567890123,totalAudioEnergy:1234.1234567890123,audioRms:0.12345678901234567,
    concealedSamples:Number.MAX_SAFE_INTEGER,jitterBufferAverageMs:1234.1234567890123,jitterBufferTargetAverageMs:1234.1234567890123,
    jitterBufferMinimumAverageMs:1234.1234567890123,decodeAverageMs:1234.1234567890123,processingAverageMs:1234.1234567890123});
  }
  return {status:'sampled',video,audio};
 });
 const run=driver.run();await h.advance(60000);await run;
 const longest=Math.max(...h.logs.map(line=>line.length));assert.ok(longest<=2000,`longest native log line: ${longest}`);
 for(const line of h.logs)assert.doesNotThrow(()=>JSON.parse(line.slice('[network-diagnostics] '.length)));
 const bytes=Buffer.byteLength(JSON.stringify(h.reports[0],null,2));assert(bytes<64*1024);
 t.diagnostic(`longest sample/end log line ${longest}/2000 characters; compact report ${bytes}/65536 bytes`);
});
test('missing or invalid receiver timings remain null with zero observed coverage, not zero latency',async()=>{
 const h=fixture(),driver=h.exports.createNetworkDiagnosticsProof(h.deps);
 h.sample(async options=>{if(!options.enabled)return null;const video=receiver('video');Object.assign(video.delta,{jitterBufferAverageMs:NaN,jitterBufferTargetAverageMs:Infinity,jitterBufferMinimumAverageMs:-1,decodeAverageMs:'SECRET'});return {status:'sampled',video};});
 const run=driver.run();await h.advance(60000);const result=await run;
 for(const kind of ['video','audio'])for(const value of Object.values(result.summary.receiverTimingMs[kind])){
  assert.equal(value.count,0);assert.equal(value.minimum,null);assert.equal(value.median,null);assert.equal(value.p95,null);assert.equal(value.maximum,null);
 }
 assert.equal(result.samples[0].video.jitterBufferAverageMs,null);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});
test('HMR disposes an installed running driver and cannot install after late bundle-ID resolution',async()=>{
 const h=fixture();await h.exports.installNetworkDiagnosticsProof();const run=h.window.__producerNetworkDiagnostics.run();await flush();h.disposeModule();await flush();assert.equal((await run).reason,'disposed');assert.equal(h.window.__producerNetworkDiagnostics,undefined);assert.equal(h.timers.size,0);
 let resolve;const late=fixture({appId:()=>new Promise(done=>{resolve=done;})});const pending=late.exports.installNetworkDiagnosticsProof();await flush();late.disposeModule();resolve('ai.boomin.producer.sets-v2-dev');await pending;assert.equal(late.window.__producerNetworkDiagnostics,undefined);
});
test('main entry imports this tool only behind DEV and the exact explicit flag',()=>{
 const main=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');assert.match(main,/if\(import\.meta\.env\.DEV&&import\.meta\.env\.VITE_PRODUCER_NETWORK_DIAGNOSTICS==='1'\)/);assert.match(main,/networkDiagnosticsProof.*then\(m=>m\.installNetworkDiagnosticsProof\(\)\)/);
 const production=transformSync(main,{loader:'tsx',minifySyntax:true,define:{'import.meta.env.DEV':'false','import.meta.env.VITE_PRODUCER_NETWORK_DIAGNOSTICS':'"1"'}}).code;assert.doesNotMatch(production,/networkDiagnosticsProof/);
});
