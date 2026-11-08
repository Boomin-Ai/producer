/** Requested, local-only observations of existing receivers. This module owns
 * no media, recording, trace writer, network request or background polling. */
export type ReceiverKind = 'video' | 'audio';
export type ReceiverStatus = 'absent' | 'available' | 'unsupported' | 'failed' | 'timed_out' | 'busy';
export interface ReceiverCounters {
 timestampMs:number|null;bytesReceived:number|null;packetsReceived:number|null;packetsLost:number|null;jitterSeconds:number|null;
 framesReceived:number|null;framesDecoded:number|null;framesDropped:number|null;width:number|null;height:number|null;
 totalAudioEnergy:number|null;totalSamplesDuration:number|null;totalSamplesReceived:number|null;
 concealedSamples:number|null;concealmentEvents:number|null;silentConcealedSamples:number|null;
}
export interface ReceiverDelta {
 windowMs:number;statsIntervalMs:number|null;bytesReceived:number|null;packetsReceived:number|null;packetsLost:number|null;
 framesReceived:number|null;framesDecoded:number|null;framesDropped:number|null;
 totalAudioEnergy:number|null;totalSamplesDuration:number|null;totalSamplesReceived:number|null;
 concealedSamples:number|null;concealmentEvents:number|null;silentConcealedSamples:number|null;
 /** Derived from the energy/duration deltas, not proof of a known sound. */
 audioRms:number|null;
}
export interface ReceiverObservation {
 kind:ReceiverKind;status:ReceiverStatus;trackLive:boolean|null;enabled:boolean|null;muted:boolean|null;
 counters:ReceiverCounters|null;delta:ReceiverDelta|null;
 /** Decoder progress between observations; never means pixels were presented
  * or that a physical speaker was audible. First sample is always unknown. */
 decodeProgress:'unknown'|'advancing'|'unchanged'|'reset';
 lastDecodeAdvanceAgeMs:number|null;
}
export interface ProducerMediaSnapshot {
 status:'disabled'|'unavailable'|'retired'|'sampled';sampledAtMs:number;
 video:ReceiverObservation;audio:ReceiverObservation;
}
export interface MediaDiagnosticsOptions {enabled:boolean;timeoutMs?:number;}
/** Public LiveKit RemoteTrack surface only. No RTCPeerConnection internals. */
export interface DiagnosticReceiver {
 mediaStreamTrack:{readyState:string;enabled:boolean;muted:boolean};
 getRTCStatsReport():Promise<RTCStatsReport|undefined>;
}
type Row=Record<string,unknown>;
const monotonic=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const lost=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null;
/** Explicit whitelist: provider strings, track/stream IDs, addresses and codec
 * details cannot enter the result, even when present in the SDK report. */
export function receiverCounters(kind:ReceiverKind,row:Row):ReceiverCounters {
 const n=(key:string)=>monotonic(row[key]);
 return {timestampMs:n('timestamp'),bytesReceived:n('bytesReceived'),packetsReceived:n('packetsReceived'),
  packetsLost:lost(row.packetsLost),jitterSeconds:n('jitter'),
  framesReceived:kind==='video'?n('framesReceived'):null,framesDecoded:kind==='video'?n('framesDecoded'):null,
  framesDropped:kind==='video'?n('framesDropped'):null,width:kind==='video'?n('frameWidth'):null,height:kind==='video'?n('frameHeight'):null,
  totalAudioEnergy:kind==='audio'?n('totalAudioEnergy'):null,totalSamplesDuration:kind==='audio'?n('totalSamplesDuration'):null,
  totalSamplesReceived:kind==='audio'?n('totalSamplesReceived'):null,concealedSamples:kind==='audio'?n('concealedSamples'):null,
  concealmentEvents:kind==='audio'?n('concealmentEvents'):null,silentConcealedSamples:kind==='audio'?n('silentConcealedSamples'):null};
}
const counterKeys=['bytesReceived','packetsReceived','framesReceived','framesDecoded','framesDropped','totalAudioEnergy',
 'totalSamplesDuration','totalSamplesReceived','concealedSamples','concealmentEvents','silentConcealedSamples'] as const;
/** Counter resets, clock regressions and stale (unchanged) report timestamps
 * never create rates or false decoder-progress evidence. */
export function receiverDelta(current:ReceiverCounters,previous:ReceiverCounters,windowMs:number):ReceiverDelta|null {
 if(!Number.isFinite(windowMs)||windowMs<=0)return null;
 if(current.timestampMs!==null&&previous.timestampMs!==null&&current.timestampMs<=previous.timestampMs)return null;
 if(counterKeys.some(key=>current[key]!==null&&previous[key]!==null&&current[key]!<previous[key]!))return null;
 const d=(key:typeof counterKeys[number])=>current[key]!==null&&previous[key]!==null?current[key]!-previous[key]!:null;
 const duration=d('totalSamplesDuration'),energy=d('totalAudioEnergy');
 return {windowMs,statsIntervalMs:current.timestampMs!==null&&previous.timestampMs!==null?current.timestampMs-previous.timestampMs:null,
  bytesReceived:d('bytesReceived'),packetsReceived:d('packetsReceived'),
  // RFC packet loss can decrease as late packets arrive; keep the signed delta.
  packetsLost:current.packetsLost!==null&&previous.packetsLost!==null?current.packetsLost-previous.packetsLost:null,
  framesReceived:d('framesReceived'),framesDecoded:d('framesDecoded'),framesDropped:d('framesDropped'),
  totalAudioEnergy:energy,totalSamplesDuration:duration,totalSamplesReceived:d('totalSamplesReceived'),
  concealedSamples:d('concealedSamples'),concealmentEvents:d('concealmentEvents'),silentConcealedSamples:d('silentConcealedSamples'),
  audioRms:duration!==null&&duration>0&&energy!==null?monotonic(Math.sqrt(energy/duration)):null};
}
function emptyReceiver(kind:ReceiverKind,status:ReceiverStatus='absent',track?:DiagnosticReceiver|null):ReceiverObservation {
 return {kind,status,trackLive:track?track.mediaStreamTrack.readyState==='live':null,
  enabled:track?track.mediaStreamTrack.enabled:null,muted:track?track.mediaStreamTrack.muted:null,
  counters:null,delta:null,decodeProgress:'unknown',lastDecodeAdvanceAgeMs:null};
}
export function emptyMediaSnapshot(status:ProducerMediaSnapshot['status'],sampledAtMs:number):ProducerMediaSnapshot {
 return {status,sampledAtMs,video:emptyReceiver('video'),audio:emptyReceiver('audio')};
}
type ReadResult={status:'available';counters:ReceiverCounters;binding:string|null}|{status:Exclude<ReceiverStatus,'available'|'absent'>};
type History={track:DiagnosticReceiver;binding:string|null;counters:ReceiverCounters;at:number;lastAdvance:number|null};
function selectReport(kind:ReceiverKind,report:RTCStatsReport|undefined):ReadResult {
 if(!report)return {status:'unsupported'};
 let row:Row|undefined,entries=0;
 for(const value of report.values()){
  if(++entries>128)return {status:'unsupported'};
  const candidate=value as Row;
  if(candidate.type!=='inbound-rtp'||candidate.isRemote===true)continue;
  const media=candidate.kind??candidate.mediaType;
  if(media!==undefined&&media!==kind)continue;
  // A per-track receiver should identify one inbound stream. Do not combine
  // ambiguous SSRC counters or guess which stream was decoded.
  if(row)return {status:'unsupported'};
  row=candidate;
 }
 if(!row)return {status:'unsupported'};
 return {status:'available',counters:receiverCounters(kind,row),binding:typeof row.id==='string'?row.id:null};
}
/** One requested sample at a time, at most two outstanding SDK reads even if
 * a browser never settles getStats(). reset() fences late work immediately. */
export class ProducerMediaDiagnostics {
 private epoch=0;
 private history:Partial<Record<ReceiverKind,History>>={};
 private reads=new Map<DiagnosticReceiver,Promise<ReadResult>>();
 private inFlight:{promise:Promise<ProducerMediaSnapshot>;cancel:()=>void}|null=null;
 constructor(private readonly now:()=>number=()=>performance.now()){}
 reset():void {this.epoch++;this.history={};this.inFlight?.cancel();this.inFlight=null;}
 private read(kind:ReceiverKind,track:DiagnosticReceiver):Promise<ReadResult> {
  const existing=this.reads.get(track);if(existing)return existing;
  if(this.reads.size>=2)return Promise.resolve({status:'busy'});
  const pending=Promise.resolve().then(()=>track.getRTCStatsReport()).then(report=>selectReport(kind,report),()=>({status:'failed'} as const))
   .catch(()=>({status:'failed'} as const));
  this.reads.set(track,pending);
  void pending.then(()=>{if(this.reads.get(track)===pending)this.reads.delete(track);});
  return pending;
 }
 sample(options:MediaDiagnosticsOptions,tracks:{video:DiagnosticReceiver|null;audio:DiagnosticReceiver|null},current:()=>boolean):Promise<ProducerMediaSnapshot> {
  if(!options.enabled){this.reset();return Promise.resolve(emptyMediaSnapshot('disabled',this.now()));}
  if(this.inFlight)return this.inFlight.promise;
  if(!current()){this.reset();return Promise.resolve(emptyMediaSnapshot('unavailable',this.now()));}
  const epoch=this.epoch,timeoutMs=Number.isFinite(options.timeoutMs)?Math.max(50,Math.min(2000,options.timeoutMs!)):750;
  let cancel!:()=>void,timer:ReturnType<typeof setTimeout>;
  const stopped=new Promise<ReadResult>(resolve=>{cancel=()=>resolve({status:'timed_out'});timer=setTimeout(cancel,timeoutMs);});
  const work=(kind:ReceiverKind)=>tracks[kind]?Promise.race([this.read(kind,tracks[kind]!),stopped]):Promise.resolve(null);
  const promise=Promise.all([work('video'),work('audio')]).then(([video,audio])=>{
   const at=this.now();
   if(epoch!==this.epoch||!current())return emptyMediaSnapshot('retired',at);
   return {status:'sampled' as const,sampledAtMs:at,video:this.observe('video',tracks.video,video,at),audio:this.observe('audio',tracks.audio,audio,at)};
  }).finally(()=>{clearTimeout(timer);if(this.inFlight?.promise===promise)this.inFlight=null;});
  this.inFlight={promise,cancel};return promise;
 }
 private observe(kind:ReceiverKind,track:DiagnosticReceiver|null,read:ReadResult|null,at:number):ReceiverObservation {
  const result=emptyReceiver(kind,read?.status??'absent',track);
  if(!track||read?.status!=='available'){delete this.history[kind];return result;}
  // The consumer cannot mutate the private baseline used by later requests.
  result.counters={...read.counters};
  const old=this.history[kind],same=old?.track===track&&old.binding===read.binding;
  if(same&&read.counters.timestampMs!==null&&read.counters.timestampMs===old.counters.timestampMs){
   // Cached browser reports do not shorten the next real observation window.
   result.lastDecodeAdvanceAgeMs=old.lastAdvance!==null?Math.max(0,at-old.lastAdvance):null;return result;
  }
  const delta=same?receiverDelta(read.counters,old.counters,at-old.at):null;
  let lastAdvance=same?old.lastAdvance:null;
  if(delta){
   const progress=kind==='video'?delta.framesDecoded:delta.totalSamplesDuration??delta.totalSamplesReceived;
   result.decodeProgress=progress===null?'unknown':progress>0?'advancing':'unchanged';
   if(progress!==null&&progress>0)lastAdvance=at;
  }else if(same&&(read.counters.timestampMs!==null&&old.counters.timestampMs!==null&&read.counters.timestampMs<old.counters.timestampMs||
   counterKeys.some(key=>read.counters[key]!==null&&old.counters[key]!==null&&read.counters[key]!<old.counters[key]!))){
   result.decodeProgress='reset';lastAdvance=null;
  }
  result.delta=delta;result.lastDecodeAdvanceAgeMs=lastAdvance!==null?Math.max(0,at-lastAdvance):null;
  this.history[kind]={track,binding:read.binding,counters:read.counters,at,lastAdvance};return result;
 }
}

export type TonePatternSegment={kind:'tone';durationMs:number;frequencyHz:number}|{kind:'silence';durationMs:number};
export interface TonePatternResult {matched:boolean;segments:{kind:'tone'|'silence';rms:number;toneFraction:number|null;matched:boolean}[];}
/** Pure offline analysis of supplied interleaved normalized PCM. Never opens a
 * device, plays sound, records, changes mute, or exports PCM. Caller supplies
 * aligned windows; this is not a network latency or speaker-audibility test. */
export function analyzeKnownTonePattern(pcm:ArrayLike<number>,sampleRate:number,pattern:readonly TonePatternSegment[],options:{channels?:1|2;offsetMs?:number;minimumToneRms?:number;minimumToneFraction?:number;maximumSilenceRms?:number}={}):TonePatternResult {
 const channels=options.channels??1,offset=options.offsetMs??0,minRms=options.minimumToneRms??0.005,
  minFraction=options.minimumToneFraction??0.7,maxSilence=options.maximumSilenceRms??0.001;
 if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000||![1,2].includes(channels)||!Number.isFinite(offset)||offset<0||
  !Number.isFinite(minRms)||minRms<=0||!Number.isFinite(minFraction)||minFraction<=0||minFraction>1||!Number.isFinite(maxSilence)||maxSilence<0||
  !Number.isSafeInteger(pcm.length)||pcm.length>sampleRate*channels*10||pcm.length%channels||!pattern.length||pattern.length>16)
  throw new RangeError('Invalid bounded PCM pattern');
 let elapsed=offset;
 const windows=pattern.map(segment=>{
  if(!Number.isFinite(segment.durationMs)||segment.durationMs<40||!['tone','silence'].includes(segment.kind)||
   segment.kind==='tone'&&(!Number.isFinite(segment.frequencyHz)||segment.frequencyHz<40||segment.frequencyHz>=sampleRate/2))
   throw new RangeError('Invalid bounded PCM pattern');
  const start=Math.round(elapsed*sampleRate/1000);elapsed+=segment.durationMs;
  const end=Math.round(elapsed*sampleRate/1000);
  if(elapsed>10000||end*channels>pcm.length)throw new RangeError('PCM pattern window unavailable');
  return {segment,start,end};
 });
 const segments=windows.map(({segment,start,end})=>{
  let energy=0,tonePower=0;const frames=end-start;
  const coefficient=segment.kind==='tone'?2*Math.cos(2*Math.PI*segment.frequencyHz/sampleRate):0;
  for(let channel=0;channel<channels;channel++){
   let q1=0,q2=0;
   for(let frame=start;frame<end;frame++){
    const value=pcm[frame*channels+channel];
    if(!Number.isFinite(value)||Math.abs(value)>16)throw new RangeError('Invalid normalized PCM');
    energy+=value*value;
    if(segment.kind==='tone'){const q=value+coefficient*q1-q2;q2=q1;q1=q;}
   }
   if(segment.kind==='tone')tonePower+=Math.max(0,q1*q1+q2*q2-coefficient*q1*q2)*2/(frames*frames);
  }
  const meanEnergy=energy/(frames*channels),rms=Math.sqrt(meanEnergy);
  const toneFraction=segment.kind==='tone'?Math.min(1,meanEnergy>0?tonePower/(channels*meanEnergy):0):null;
  const matched=segment.kind==='tone'?rms>=minRms&&toneFraction!>=minFraction:rms<=maxSilence;
  return {kind:segment.kind,rms,toneFraction,matched};
 });
 return {matched:segments.every(segment=>segment.matched),segments};
}
