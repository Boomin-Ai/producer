/** Passive local developer measurement. Never joins, captures, plays sound,
 * changes mixer controls, shares traces or consumes the program PCM queue. */
import {getIdentifier} from '@tauri-apps/api/app';
import {ipc,uiLog,type LiveSnapshot} from '../../lib/ipc';
import {invoke} from '../../lib/nativeInvoke';
import {activeGuestSeatDiagnosticSession,subscribeGuestSeatDiagnosticSessions,type GuestSeatDiagnosticSession} from '../../lib/guestSeat';
import type {ProducerMediaSnapshot,ReceiverObservation} from '../../lib/producerMediaDiagnostics';

const ALLOWED_APPS=new Set(['ai.boomin.producer.sets-v2-dev','ai.boomin.producer.windows-network-dev']);
type EndReason='completed'|'no_active_seat'|'cancelled'|'session_changed'|'disposed'|'failed';
type Sample={elapsedMs:number;receiverStatus:ProducerMediaSnapshot['status']|'unavailable';
 video:ReturnType<typeof receiverFields>;audio:ReturnType<typeof receiverFields>;engine:ReturnType<typeof engineFields>};
type Report={kind:'producer-network-passive';version:1;run:number;reason:EndReason;durationMs:number;waitMs:number;measurementMs:number;sampleCount:number;
 coverage:typeof COVERAGE;summary:ReturnType<typeof summarize>;samples:Sample[]};
type Progress={state:'idle'|'waiting'|'running'|'disposed';run:number;sampleCount:number};
export interface NetworkDiagnosticsProof {
 run():Promise<Report>;
 cancel():void;
 status():Progress;
 dispose():void;
}
type Dependencies={now:()=>number;setTimer:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;clearTimer:(timer:ReturnType<typeof setTimeout>)=>void;
 getSession:()=>GuestSeatDiagnosticSession|null;subscribeSession:(fn:()=>void)=>()=>void;
 readEngine:()=>Promise<LiveSnapshot>;log:(line:string)=>void;report?:(result:unknown)=>Promise<unknown>};
const COVERAGE={receiver:'decoded_stats_only',sourceFreshness:'dimensions_only',nativeIngest:'unavailable',nativeMixer:'unavailable',
 presentedVideo:'unavailable',speakerAudibility:'unavailable',outboundPublishing:'unavailable'} as const;
const n=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function receiverFields(receiver?:ReceiverObservation){
 return {status:receiver?.status??'absent',trackLive:receiver?.trackLive??null,enabled:receiver?.enabled??null,muted:receiver?.muted??null,
  decodeProgress:receiver?.decodeProgress??'unknown',decodeAgeMs:n(receiver?.lastDecodeAdvanceAgeMs),
  width:n(receiver?.counters?.width),height:n(receiver?.counters?.height),windowMs:n(receiver?.delta?.windowMs),
  framesDecoded:n(receiver?.delta?.framesDecoded),framesReceived:n(receiver?.delta?.framesReceived),bytesReceived:n(receiver?.delta?.bytesReceived),
  audioDuration:n(receiver?.delta?.totalSamplesDuration),audioEnergy:n(receiver?.delta?.totalAudioEnergy),audioRms:n(receiver?.delta?.audioRms),
  concealedSamples:n(receiver?.delta?.concealedSamples)};
}
function engineFields(engine:LiveSnapshot|null){
 const items=engine?.sources?.items??[];
 const count=(predicate:(item:typeof items[number])=>boolean)=>engine?.sources?.items?items.filter(predicate).length:null;
 const hasDimensions=(item:typeof items[number])=>n(item.src_w)!>0&&n(item.src_h)!>0;
 return {available:engine!==null,ready:engine?.engine_ready??false,cpuMachinePercent:n(engine?.cpu),fps:n(engine?.fps),
  renderTimeUs:n(engine?.render_time_us),skippedFrames:n(engine?.skipped_frames),totalFrames:n(engine?.total_frames),
  videoHeight:n(engine?.video_height),videoFps:n(engine?.video_fps),sourceCount:engine?.sources?.items?items.length:null,
  cameras:count(item=>item.kind==='camera'),camerasWithDimensions:count(item=>item.kind==='camera'&&hasDimensions(item)),
  guestSources:count(item=>item.kind==='guest'),guestSourcesWithDimensions:count(item=>item.kind==='guest'&&hasDimensions(item)),
  audioSources:count(item=>item.has_audio),mutedAudioSources:count(item=>item.has_audio&&item.muted)};
}
function distribution(values:(number|null)[]){
 const sorted=values.filter((value):value is number=>value!==null).sort((a,b)=>a-b);
 return {count:sorted.length,minimum:sorted[0]??null,median:sorted.length?(sorted[Math.floor((sorted.length-1)/2)]/2+sorted[Math.floor(sorted.length/2)]/2):null,
  p95:sorted.length?sorted[Math.ceil(sorted.length*0.95)-1]:null,maximum:sorted[sorted.length-1]??null};
}
function summarize(samples:Sample[]){
 const sum=(values:(number|null)[])=>{const observed=values.filter((value):value is number=>value!==null);return observed.length?observed.reduce((total,value)=>total+value,0):null;};
 const increase=(values:(number|null)[])=>{const counters=values.filter((value):value is number=>value!==null);return counters.length>1&&counters.every((value,i)=>!i||value>=counters[i-1])?counters[counters.length-1]-counters[0]:null;};
 return {cpuMachinePercent:distribution(samples.map(s=>s.engine.cpuMachinePercent)),fps:distribution(samples.map(s=>s.engine.fps)),
  renderTimeUs:distribution(samples.map(s=>s.engine.renderTimeUs)),
  engineSamples:samples.filter(s=>s.engine.available).length,videoStatsSamples:samples.filter(s=>s.video.status==='available').length,
  audioStatsSamples:samples.filter(s=>s.audio.status==='available').length,videoDeltaSamples:samples.filter(s=>s.video.framesDecoded!==null).length,
  audioDeltaSamples:samples.filter(s=>s.audio.audioDuration!==null).length,
  decodedFrames:sum(samples.map(s=>s.video.framesDecoded)),decodedAudioSeconds:sum(samples.map(s=>s.audio.audioDuration)),
  engineTotalFramesIncrease:increase(samples.map(s=>s.engine.totalFrames)),engineSkippedFramesIncrease:increase(samples.map(s=>s.engine.skippedFrames)),
  missingCadenceSlots:Math.max(0,60-samples.length)};
}

/** Dependency seam for clock/IPC tests. Installation below is the only app
 * entrypoint and independently checks DEV, explicit flag and exact bundle ID. */
export function createNetworkDiagnosticsProof(deps:Dependencies):NetworkDiagnosticsProof {
 let disposed=false,sequence=0,progress:Progress={state:'idle',run:0,sampleCount:0};
 let operation:{promise:Promise<Report>;stop:(reason:EndReason)=>void}|null=null;
 let enginePending:Promise<LiveSnapshot|null>|null=null;
 const log=(event:'start'|'sample'|'end',run:number,value:unknown)=>{try{deps.log('[network-diagnostics] '+JSON.stringify({event,run,value}));}catch{/* Local logging cannot affect media. */}};
 function run():Promise<Report>{
  if(operation)return operation.promise;
  const run=++sequence,samples:Sample[]=[],started=deps.now();let reason:EndReason|null=disposed?'disposed':null,measurementStarted:number|null=null;
  let cancelWork:()=>void=()=>{};const cancelled=new Promise<null>(resolve=>{cancelWork=()=>resolve(null);});
  const timers=new Set<ReturnType<typeof setTimeout>>();let wake:()=>void=()=>{};
  const stop=(next:EndReason)=>{if(!reason){reason=next;wake();cancelWork();}};
  const delay=(ms:number)=>new Promise<void>(resolve=>{
   if(reason||ms<=0){resolve();return;}
   let timer:ReturnType<typeof setTimeout>;
   const done=()=>{deps.clearTimer(timer);timers.delete(timer);if(wake===done)wake=()=>{};resolve();};
   timer=deps.setTimer(done,ms);timers.add(timer);wake=done;
  });
  async function bounded<T>(work:Promise<T>,ms:number):Promise<T|null>{
   let timer:ReturnType<typeof setTimeout>;
   const deadline=new Promise<null>(resolve=>{timer=deps.setTimer(()=>{timers.delete(timer);resolve(null);},Math.max(0,ms));timers.add(timer);});
   try{return await Promise.race([work.catch(()=>null),deadline,cancelled]);}finally{deps.clearTimer(timer!);timers.delete(timer!);}
  }
  async function engine(ms:number){
   if(!enginePending){const pending=Promise.resolve().then(deps.readEngine).catch(()=>null);enginePending=pending;void pending.then(()=>{if(enginePending===pending)enginePending=null;});}
   return bounded(enginePending,ms);
  }
  let session:GuestSeatDiagnosticSession|null=null,unsubscribe=()=>{};
  const promise=(async()=>{
   try{
    progress={state:disposed?'disposed':'waiting',run,sampleCount:0};
    if(!reason){
     // An active connection must already exist. No invitation lookup, room
     // creation, auth, capture or SDK connection is initiated here.
     const waitUntil=started+15000;
     unsubscribe=deps.subscribeSession(()=>{if(session&&(!session.current()||deps.getSession()!==session))stop('session_changed');else wake();});
     while(!reason&&!(session=deps.getSession())&&deps.now()<waitUntil)await delay(waitUntil-deps.now());
     if(!reason&&!session)reason='no_active_seat';
    }
    // Every explicit run starts a new comparison baseline, including a run
    // following a stage/authority change on the same underlying SDK owner.
    if(!reason&&session)await bounded(session.sample({enabled:false}),750);
    const measuringAt=deps.now(),endAt=measuringAt+60000;
    if(!reason&&session){
     measurementStarted=measuringAt;
     progress={state:'running',run,sampleCount:0};log('start',run,{durationMs:60000});
     for(let slot=0;slot<60&&!reason;slot++){
      await delay(measuringAt+slot*1000-deps.now());if(reason)break;
      if(!session.current()||deps.getSession()!==session){reason='session_changed';break;}
      if(deps.now()>=endAt)break;
      const budget=Math.min(1000,endAt-deps.now());
      const [media,native]=await Promise.all([bounded(session.sample({enabled:true,timeoutMs:Math.min(750,budget)}),budget),engine(budget)]);
      if(reason)break;
      if(!session.current()||deps.getSession()!==session||media?.status==='retired'||media?.status==='unavailable'){reason='session_changed';break;}
      samples.push({elapsedMs:Math.max(0,deps.now()-measuringAt),receiverStatus:media?.status??'unavailable',
       video:receiverFields(media?.video),audio:receiverFields(media?.audio),engine:engineFields(native)});
      progress={state:'running',run,sampleCount:samples.length};log('sample',run,samples[samples.length-1]);
      // Background throttling cannot cause a burst of catch-up samples.
      slot=Math.max(slot,Math.ceil((deps.now()-measuringAt)/1000)-1);
     }
     if(!reason)await delay(endAt-deps.now());
     reason??='completed';
    }
   }catch{reason??='failed';}
   finally{
    try{unsubscribe();}catch{/* A listener failure cannot retain the run. */}
    for(const timer of timers)deps.clearTimer(timer);timers.clear();
    // This disables only the observer; it never tears down the actual seat.
    if(session)void Promise.resolve().then(()=>session!.sample({enabled:false})).catch(()=>{});
   }
   const ended=deps.now();
   const report:Report={kind:'producer-network-passive',version:1,run,reason:reason??'failed',durationMs:Math.max(0,ended-started),
    waitMs:Math.max(0,(measurementStarted??ended)-started),measurementMs:measurementStarted===null?0:Math.max(0,ended-measurementStarted),
    sampleCount:samples.length,coverage:COVERAGE,summary:summarize(samples),samples};
   log('end',run,{...report,samples:undefined});
   // Existing dev report has a 64KiB budget. Every sample is in uiLog; the
   // optional convenience report stores summary and only the last 8 samples.
   if(deps.report)void Promise.resolve().then(()=>deps.report!({...report,samples:samples.slice(-8)})).catch(()=>{});
   progress={state:disposed?'disposed':'idle',run,sampleCount:samples.length};return report;
  })().finally(()=>{if(operation?.promise===promise)operation=null;});
  operation={promise,stop};return promise;
 }
 return {run,cancel(){operation?.stop('cancelled');},status(){return {...progress};},dispose(){disposed=true;operation?.stop('disposed');progress={...progress,state:'disposed'};}};
}

declare global {interface Window {__producerNetworkDiagnostics?:NetworkDiagnosticsProof;}}
let installed:NetworkDiagnosticsProof|undefined;
let moduleDisposed=false,installAttempt=0;
export async function installNetworkDiagnosticsProof():Promise<void>{
 if(!import.meta.env.DEV||import.meta.env.VITE_PRODUCER_NETWORK_DIAGNOSTICS!=='1'||!('__TAURI_INTERNALS__' in window))return;
 const attempt=++installAttempt,id=await getIdentifier().catch(()=>null);if(moduleDisposed||attempt!==installAttempt||!id||!ALLOWED_APPS.has(id))return;
 window.__producerNetworkDiagnostics?.dispose();
 installed=createNetworkDiagnosticsProof({now:()=>performance.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:timer=>clearTimeout(timer),
  getSession:activeGuestSeatDiagnosticSession,subscribeSession:subscribeGuestSeatDiagnosticSessions,readEngine:()=>ipc.liveEngineStatus(),log:uiLog,
  ...(id==='ai.boomin.producer.sets-v2-dev'?{report:(result:unknown)=>invoke('live_set_v2_report',{result})}:{})});
 window.__producerNetworkDiagnostics=installed;
}
import.meta.hot?.dispose(()=>{moduleDisposed=true;installed?.dispose();if(window.__producerNetworkDiagnostics===installed)delete window.__producerNetworkDiagnostics;installed=undefined;});
