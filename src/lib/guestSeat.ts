/** A Producer guest uses the host's existing guest authority and media plane.
 * Program mode leases the shared bounded program capture, including the local
 * processed mix-minus bus. It never silently substitutes a physical webcam.
 * Native-selected rooms use the same authority-fenced LiveKit owner as guest
 * web; other servers retain the maintained HostLink/GuestConversation adapter.
 */
import {HostLink,signalingWsUrl,type Session} from '../../server/guest/src/hostLink';
import {GuestConversation} from '../../server/guest/src/guestConversation';
import {resolveGrants,type ParticipantLike} from '../../server/guest/src/participants';
import type {StageUpdate} from '../../server/guest/src/guestMesh';
import {sharedProgramCapture,type ProgramLease} from './programCapture';
import type {ProducerGuestRtc} from './producerGuestRtc';
import type {MediaDiagnosticsOptions,ProducerMediaSnapshot} from './producerMediaDiagnostics';
import {GuestSeatTrace} from './guestSeatTrace';
import type {NativeAppearance} from './nativeAppearance';

export type SeatPhase='starting'|'waiting'|'connecting'|'live'|'gone'|'error';
export type GuestVideoSource='program'|'webcam';
export interface GuestSeatSpec {
 joinUrl:string;apiBase:string;hostName:string;title:string;producerCam:boolean;
 camLabel?:string|null;endpointId:string;dealId?:string;networkRoomId?:string;
 /** Local engine room, distinct from the remote room's endpoint/authority. */
 localRoomId?:string;
 /** Existing callers retain their explicit Producer-camera selection. */
 videoSource?:GuestVideoSource;
 /** Candidate native publication, enabled only by a matching native build. */
 nativeProgram?:boolean;portrait?:boolean;quality?:720|1080;
 /** Runtime-only local output ownership; never sent to the remote server. */
 prepareProgram?:()=>Promise<void>;
 releaseProgram?:()=>void;
 /** Local UI lifecycle only. The exact owner stays reachable until retirement
  * is acknowledged, including a collapsed room or failed native stop. */
 onRuntime?:(owner:GuestSeat|null,retiredOwner?:GuestSeat)=>boolean|void;
}
export interface SeatState {
 phase:SeatPhase;message:string;muted:boolean;cameraOff:boolean;hasProgram:boolean;
 producerCam:boolean;guestStatus:string|null;
 mediaMode:GuestVideoSource;transport:'legacy'|'livekit'|null;onStage:boolean;
 nativeProgram?:boolean;programPreview?:string|null;nativeAudioAvailable?:boolean;nativePlayback?:boolean;
}
type Guest=ParticipantLike&{id:string;display_name?:string;status:string};
type GuestReply={guest:Guest;transport?:unknown};
const POLL_MS=2500,RECONNECT_MS=2000,BOOMIN_RTC='wss://producer-boomin-6h2iz2sq.livekit.cloud';
/** Local runtime handles only; no identity, endpoint, invitation or capture
 * authority is exposed to a passive diagnostic consumer. */
export interface GuestSeatDiagnosticSession {
 current():boolean;
 sample(options:MediaDiagnosticsOptions):Promise<ProducerMediaSnapshot|null>;
}
const diagnosticSessions=new Set<GuestSeatDiagnosticSession>(),diagnosticListeners=new Set<()=>void>();
function notifyDiagnosticSessions(){for(const fn of diagnosticListeners)try{fn();}catch{/* Observation cannot affect the seat. */}}
export function activeGuestSeatDiagnosticSession():GuestSeatDiagnosticSession|null {
 const active=[...diagnosticSessions].filter(session=>session.current());return active.length===1?active[0]:null;
}
export function subscribeGuestSeatDiagnosticSessions(fn:()=>void):()=>void {diagnosticListeners.add(fn);return()=>{diagnosticListeners.delete(fn);};}

/** Decode only the final credential segment; never rewrite the minted link. */
export function inviteCodeFromJoinUrl(joinUrl:string):string|null {
 try{const u=new URL(joinUrl);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return null;
  const code=decodeURIComponent(u.pathname.replace(/\/+$/,'').split('/').pop()??'');
  return code&&code.length<=512&&!/[\s/\\\u0000-\u001f]/.test(code)?code:null;
 }catch{return null;}
}
/** Preserve reverse-proxy prefixes on independent Producer servers. */
export function connectApiBase(apiBase:string):string {
 const u=new URL(apiBase);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('Use an HTTP or HTTPS Producer server URL.');
 const version=/\/v1(?:\/|$)/.exec(u.pathname);u.pathname=(version?u.pathname.slice(0,version.index):u.pathname.replace(/\/+$/,''))+'/v1/connect';u.search='';u.hash='';
 return u.toString().replace(/\/$/,'');
}

export class GuestSeat {
 readonly spec:GuestSeatSpec;
 private readonly api:string;private readonly code:string|null;
 private state:SeatState;private listeners=new Set<()=>void>();
 private readonly trace=new GuestSeatTrace();
 private alive=true;private started=false;private terminal=false;private polling=false;
 private request=new AbortController();private timer=0;private callGeneration=0;
 private local:MediaStream|null=null;private program:MediaStream|null=null;private hostAudio:MediaStream|null=null;
 private lease:ProgramLease|null=null;private programPrepared=false;private link:HostLink|null=null;private conversation:GuestConversation|null=null;
 private rtc:ProducerGuestRtc|null=null;private peerId='';private mediaKey='';private downSince=0;
 private native:NativeAppearance|null=null;
 private retiringOwners=new Set<{close:(retry?:boolean)=>Promise<void>}>();
 private retirementFlight:Promise<void>|null=null;
 private diagnosticSession:GuestSeatDiagnosticSession|null=null;
 constructor(spec:GuestSeatSpec){
  this.spec=spec;this.api=connectApiBase(spec.apiBase);this.code=inviteCodeFromJoinUrl(spec.joinUrl);
  const mediaMode=spec.videoSource??(spec.producerCam?'program':'webcam');
  this.state={phase:'starting',message:'',muted:false,cameraOff:false,hasProgram:false,producerCam:mediaMode==='program',guestStatus:null,mediaMode,transport:null,onStage:false};
 }
 subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 snapshot():SeatState{return this.state;}
 localStream():MediaStream|null{return this.local;}
 programStream():MediaStream|null{return this.program;}
 hostAudioStream():MediaStream|null{return this.hostAudio;}
 /** Null means this seat has no active modern receiver; legacy/native host
  * ingest and local speaker audibility are deliberately not inferred. */
 async mediaDiagnostics(options:MediaDiagnosticsOptions):Promise<ProducerMediaSnapshot|null>{
  const rtc=this.rtc,gen=this.callGeneration;if(!rtc||!this.alive||this.terminal)return null;
  const result=await rtc.mediaDiagnostics(options);
  return this.alive&&!this.terminal&&this.rtc===rtc&&this.callGeneration===gen?result:null;
 }
 private syncDiagnosticSession(){
  const eligible=this.alive&&!this.terminal&&!!this.rtc&&this.state.transport==='livekit'&&this.state.phase==='live';
  if(this.diagnosticSession&&(!eligible||!this.diagnosticSession.current())){diagnosticSessions.delete(this.diagnosticSession);this.diagnosticSession=null;notifyDiagnosticSessions();}
  if(eligible&&!this.diagnosticSession){
   const gen=this.callGeneration,rtc=this.rtc,onStage=this.state.onStage;
   const session:GuestSeatDiagnosticSession={current:()=>this.alive&&!this.terminal&&this.diagnosticSession===session&&this.rtc===rtc&&this.callGeneration===gen&&this.state.phase==='live'&&this.state.onStage===onStage,sample:options=>session.current()?this.mediaDiagnostics(options):Promise.resolve(null)};
   this.diagnosticSession=session;diagnosticSessions.add(session);notifyDiagnosticSessions();
  }
 }
 private set(patch:Partial<SeatState>){if(!this.alive)return;if(patch.phase)this.trace.phase(patch.phase);this.state={...this.state,...patch};this.syncDiagnosticSession();for(const fn of this.listeners)fn();}
 async start():Promise<void>{
  if(this.started||!this.alive)return;this.started=true;this.trace.start(this.state.mediaMode==='program');
  if(!this.code){this.fail('The join link has no valid invite code.');return;}
  await this.poll();
 }
 leave(retry=false):Promise<void>{
  const first=this.alive;
  if(first){this.alive=false;this.terminal=true;this.syncDiagnosticSession();this.request.abort();window.clearTimeout(this.timer);
   this.trace.cancel();this.trace.begin('peer.leave');}
  const retiring=this.teardownCall(retry);this.releaseMedia();this.listeners.clear();if(first)this.trace.leave(retiring);
  return retiring;
 }
 toggleMute():void{const muted=!this.state.muted;this.local?.getAudioTracks().forEach(t=>{t.enabled=!muted;});this.conversation?.setMicrophoneEnabled(!muted);this.set({muted});const owner=this.native,gen=this.callGeneration;if(owner)void owner.controls(muted,this.state.cameraOff).catch(()=>{if(this.alive&&this.native===owner&&this.callGeneration===gen)this.fail('Appearance audio controls became unavailable. Join again.');});}
 toggleCamera():void{const cameraOff=!this.state.cameraOff;this.local?.getVideoTracks().forEach(t=>{t.enabled=!cameraOff;});this.set({cameraOff});const owner=this.native,gen=this.callGeneration;if(owner)void owner.controls(this.state.muted,cameraOff).catch(()=>{if(this.alive&&this.native===owner&&this.callGeneration===gen)this.fail('Appearance video controls became unavailable. Join again.');});}
 /** Every audio owner is resumed within the same explicit user gesture. */
 async resumeAudio():Promise<void>{if(this.native){const owner=this.native,gen=this.callGeneration;await owner.enableAudio();if(this.alive&&this.native===owner&&this.callGeneration===gen)this.set({nativePlayback:true});return;}await Promise.all([
  this.rtc?.resumeAudio(),this.conversation?.resumeAudio(),this.lease?sharedProgramCapture.resumeAudio():undefined,
 ]);}
 private fail(message:string){this.trace.cancel('error');this.teardownCall();this.releaseMedia();this.terminal=true;this.set({phase:'error',message,onStage:false,hasProgram:false});}
 private gone(message:string){this.trace.cancel();this.teardownCall();this.releaseMedia();this.terminal=true;this.set({phase:'gone',message,onStage:false,hasProgram:false});}
 private async json(suffix:string,method:'GET'|'POST'='GET'):Promise<{status:number;body:unknown}>{
  const res=await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}${suffix}`,{method,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:AbortSignal.any([this.request.signal,AbortSignal.timeout(8000)])});
  if(!res.ok){await res.body?.cancel();return {status:res.status,body:null};}
  const reader=res.body?.getReader();if(!reader)throw Error('Guest response unavailable');
  const chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const r=await reader.read();if(r.done)break;length+=r.value.byteLength;if(length>65536){await reader.cancel();throw Error('Guest response too large');}chunks.push(r.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  return {status:res.status,body:JSON.parse(new TextDecoder().decode(bytes))};
 }
 private async poll():Promise<void>{
  if(!this.alive||this.terminal||this.polling)return;this.polling=true;
  try{
   const res=await this.json('');if(!this.alive)return;
   if(res.status===404||res.status===410){this.gone(`${this.spec.hostName} ended your seat.`);return;}
   if(res.status!==200)throw Error('Guest status unavailable');
   const reply=res.body as GuestReply,guest=reply?.guest;
   if(!guest||typeof guest.id!=='string'||typeof guest.status!=='string')throw Error('Guest status unavailable');
   if(reply.transport!==undefined&&reply.transport!=='legacy'&&reply.transport!=='livekit'){this.fail('This server uses an unsupported guest transport.');return;}
   const transport=reply.transport==='livekit'?'livekit':'legacy';
   this.set({guestStatus:guest.status,transport});
   if(!['accepted','waiting','invited'].includes(guest.status)){this.gone(`${this.spec.hostName} closed your seat.`);return;}
   if(guest.status!=='accepted'){
    this.trace.waiting();
    this.teardownCall();this.releaseMedia();this.set({phase:'waiting',message:'',onStage:false});
    if(guest.status==='invited')await this.json('/accept','POST');return;
   }
   this.trace.admitted();
   const grants=resolveGrants(guest),key=[...grants].sort().join('|');
   if(this.peerId!==guest.id||this.mediaKey!==key){await this.teardownCall();if(!this.alive)return;this.releaseMedia();this.peerId=guest.id;this.mediaKey=key;}
   const actual=this.rtc||this.native?'livekit':this.link?'legacy':null;
   if(actual&&actual!==transport)this.teardownCall();
   if(this.spec.nativeProgram&&this.state.mediaMode==='program'){
    if(transport!=='livekit'){this.fail('Native Set sharing requires a Boomin LiveKit room. Choose the compatibility path when joining this server.');return;}
    if(!this.native)await this.connectNativeProgram(guest.id);
    return;
   }
   if(!this.local){
    this.set({phase:'starting',message:''});
    try{await this.trace.measure(this.state.mediaMode==='program'?'peer.capture.program':'peer.capture.webcam',()=>this.openMedia(grants));}catch{if(this.alive)this.fail(this.state.mediaMode==='program'?'Your program output is unavailable. Start and authorize Producer Virtual Camera, or explicitly choose Webcam when joining.':'Camera or microphone access is unavailable. Check your selected devices and join again.');return;}
   }
   if(!this.alive)return;
   if(transport==='livekit'){if(!this.rtc)await this.connectNative(guest.id);}
   else if(!this.link)await this.connectLegacy(grants);
   else if(this.downSince&&Date.now()-this.downSince>8000){this.teardownCall();await this.connectLegacy(grants);}
  }catch{if(this.alive&&!this.terminal)this.set({message:'Waiting for the host connection…'});}
  finally{this.polling=false;if(this.alive&&!this.terminal)this.timer=window.setTimeout(()=>void this.poll(),this.state.phase==='connecting'?RECONNECT_MS:POLL_MS);}
 }
 private async capture(constraints:MediaStreamConstraints):Promise<MediaStream>{
  let expired=false,timer=0;
  const pending=navigator.mediaDevices.getUserMedia(constraints).then(stream=>{if(expired||!this.alive){stream.getTracks().forEach(t=>t.stop());throw Error('Capture closed');}return stream;});
  try{return await Promise.race([pending,new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>{expired=true;reject(Error('Capture timed out'));},8000);})]);}finally{window.clearTimeout(timer);}
 }
 private async openMedia(grants:ReadonlySet<string>):Promise<void>{
  const video=grants.has('media.camera'),audio=grants.has('media.mic');
  if(!video&&!audio){this.local=new MediaStream();return;}
  if(this.state.mediaMode==='program'){
   if(this.spec.prepareProgram){this.programPrepared=true;await this.trace.measure('peer.program.prepare',()=>this.spec.prepareProgram!());if(!this.alive)return;}
   const lease=await sharedProgramCapture.acquire(1,this.spec.camLabel||'Producer Virtual Camera');
   if(!this.alive){lease.release();return;}this.lease=lease;
   this.local=new MediaStream([...(video?[lease.video.clone()]:[]),...(audio?[lease.audio.clone()]:[])]);
   lease.onVideo(async track=>{
    if(!this.alive||this.lease!==lease||!video||!this.local)return;
    const previous=this.local.getVideoTracks()[0],next=track.clone();next.enabled=!this.state.cameraOff;
    const stream=new MediaStream([next,...this.local.getAudioTracks()]);this.local=stream;
    try{if(this.rtc)await this.rtc.replaceLocalTracks();else await this.link?.replaceLocalTracks(stream);}
    finally{previous?.stop();this.set({});}
   });
  }else this.local=await this.capture({video:video?{width:{ideal:960,max:1280},height:{ideal:540,max:720},frameRate:{ideal:20,max:30}}:false,audio:audio?{echoCancellation:true,noiseSuppression:true,autoGainControl:true}:false});
  if(!this.alive){this.releaseMedia();return;}
  this.local?.getAudioTracks().forEach(t=>{t.enabled=!this.state.muted;});this.local?.getVideoTracks().forEach(t=>{t.enabled=!this.state.cameraOff;});this.set({});
 }
 private async connectNative(participantId:string):Promise<void>{
  const gen=++this.callGeneration;this.set({phase:'connecting',message:''});
  const {ProducerGuestRtc}=await this.trace.measure('peer.sdk.load',()=>import('./producerGuestRtc'));if(!this.alive||gen!==this.callGeneration)return;
  const current=()=>this.alive&&gen===this.callGeneration;
  const rtc=new ProducerGuestRtc({api:this.api,invite:this.code!,participantId,endpoint:BOOMIN_RTC,localStream:()=>this.local,
   onDiagnostic:phase=>{if(current())this.trace.diagnostic(phase);},
   onState:phase=>{if(!current())return;if(phase==='gone'){this.gone(`${this.spec.hostName} ended your seat.`);return;}this.set({phase:phase==='reconnecting'?'connecting':phase,message:phase==='reconnecting'?'Reconnecting…':'',...(phase==='live'?{}:{onStage:false})});},
   onStage:onStage=>{if(current())this.set({onStage});},
   onProgram:stream=>{if(current())this.setProgram(stream,gen);},
   onAudio:stream=>{if(current()){this.hostAudio=stream;this.set({});}}
  });this.rtc=rtc;rtc.start();
 }
 private async connectNativeProgram(participantId:string):Promise<void>{
  if(!this.spec.localRoomId){this.fail('Choose a local room for the appearance.');return;}
  const gen=++this.callGeneration,current=()=>this.alive&&!this.terminal&&gen===this.callGeneration;
  this.set({phase:'connecting',message:'',nativeProgram:true});
  const {NativeAppearance}=await import('./nativeAppearance');if(!current())return;
  const owner=new NativeAppearance({localRoomId:this.spec.localRoomId,api:this.api,invite:this.code!,participantId,
   portrait:!!this.spec.portrait,quality:this.spec.quality??720},(status,preview,playback)=>{
    if(!current())return;
    if(status.phase==='gone'){this.gone(`${this.spec.hostName} ended your seat.`);return;}
    if(status.phase==='error'){this.fail('Native appearance could not continue. Your local show has been retained.');return;}
    this.set({phase:status.phase==='reconnecting'?'connecting':status.phase,message:status.phase==='reconnecting'?'Reconnecting…':'',
     onStage:status.onStage,hasProgram:status.hasProgram,programPreview:preview,nativeAudioAvailable:status.hasAudio,nativePlayback:playback});
   },()=>{if(current())this.fail('Native appearance became unavailable. Your local show has been retained.');});
  this.native=owner;
  try{await owner.start(this.state.muted,this.state.cameraOff);if(current())await owner.controls(this.state.muted,this.state.cameraOff);}
  catch{if(current())this.fail('Native appearance could not start. Your local show has been retained.');}
 }
 private async legacySession():Promise<Session>{
  const res=await this.trace.measure('peer.legacy.session',()=>this.json('/session','POST')),s=res.body as Session;
  if(res.status!==200||!s||typeof s.signaling_url!=='string'||!Array.isArray(s.ice_servers))throw Error('Guest session unavailable');
  return s;
 }
 private async connectLegacy(grants:ReadonlySet<string>):Promise<void>{
  const gen=++this.callGeneration,current=()=>this.alive&&gen===this.callGeneration;
  this.set({phase:'connecting',message:''});const session=await this.legacySession();if(!current())return;this.downSince=0;
  this.conversation=new GuestConversation({api:this.api,code:this.code!,localStream:()=>this.local});
  this.conversation.setMicrophoneEnabled(!this.state.muted);this.conversation.start();
  this.link=new HostLink({session,wsUrl:signalingWsUrl(this.api,session),localStream:()=>this.local,
   refreshSession:async()=>{if(!current())throw Error('Seat closed');const fresh=await this.legacySession();if(!current())throw Error('Seat closed');return {session:fresh,wsUrl:signalingWsUrl(this.api,fresh)};},
   returnFeed:grants.has('media.return_feed'),delayReturnFeedMs:0,
   onProgram:stream=>{if(current())this.setProgram(stream,gen);},
   onHostAudio:stream=>{if(current()){this.hostAudio=stream;this.set({});}},
   onData:raw=>{if(!current())return;const m=raw as Partial<StageUpdate>&{kind?:string};if(m?.kind==='stage'&&Array.isArray(m.on_stage)&&typeof m.version==='number'){this.conversation?.applyStage(m as StageUpdate);this.set({onStage:m.on_stage.includes(this.peerId)});}},
   onMainState:state=>{if(!current())return;if(state==='connected'){this.downSince=0;this.set({phase:'live',message:''});}else if(['failed','closed','disconnected'].includes(state)){this.conversation?.suspend();this.downSince ||= Date.now();this.set({phase:'connecting',message:'Reconnecting…',onStage:false});}}
  });
 }
 private setProgram(stream:MediaStream|null,gen:number){
  if(stream&&this.program!==stream)this.trace.trackAvailable(true);
  this.program=stream;const track=stream?.getVideoTracks()[0];
  const sync=()=>{if(this.alive&&gen===this.callGeneration&&this.program===stream)this.set({hasProgram:!!track&&track.readyState==='live'&&!track.muted});};
  track?.addEventListener('unmute',sync,{once:true});track?.addEventListener('ended',sync,{once:true});sync();
 }
 private teardownCall(retry=false){
  this.callGeneration++;const rtc=this.rtc;this.rtc=null;const native=this.native;this.native=null;
  if(rtc)this.retiringOwners.add(rtc);if(native)this.retiringOwners.add(native);
  const retiring=this.retireOwners(retry);void retiring.catch(()=>{});
  const link=this.link;this.link=null;link?.close();this.conversation?.stop();this.conversation=null;
  this.program=null;this.hostAudio=null;this.downSince=0;this.set({hasProgram:false,onStage:false,programPreview:null,nativeAudioAvailable:false,nativePlayback:false});
  return retiring;
 }
 private async retireOwners(retry=false):Promise<void>{
  if(this.retirementFlight&&!retry){await this.retirementFlight;if(this.retiringOwners.size)return this.retireOwners();return;}
  const owners=[...this.retiringOwners];
  const attempt=Promise.all(owners.map(async owner=>{await owner.close(retry);this.retiringOwners.delete(owner);})).then(()=>{});
  this.retirementFlight=attempt;
  try{await attempt;}finally{if(this.retirementFlight===attempt)this.retirementFlight=null;}
  if(this.retiringOwners.size)await this.retireOwners();
 }
 private releaseMedia(){this.local?.getTracks().forEach(t=>t.stop());this.local=null;this.lease?.release();this.lease=null;if(this.programPrepared){this.programPrepared=false;this.spec.releaseProgram?.();}}
}
