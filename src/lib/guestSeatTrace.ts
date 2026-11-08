/** Fixed-stage diagnostics only. Never owns media, timers, network calls or
 * credentials. Native performanceTrace consent remains authoritative. */
import {startTraceSpan,endTraceSpan,recordTraceEvent,snapshotTraceContext,type TraceSpan,type TraceFields} from './performanceTrace';

type Stage='peer.attempt'|'peer.admission_wait'|'peer.capture.program'|'peer.capture.webcam'|
 'peer.program.prepare'|'peer.sdk.load'|'peer.legacy.session'|'peer.rtc.connect'|
 'peer.rtc.publish'|'peer.rtc.retire'|'peer.reconnect'|'peer.leave';
type Diagnostic='poll'|'retire_start'|'retire_end'|'connect_start'|'connect_end'|'publish_start'|'publish_end'|'poll_failed';
type Status='ok'|'error'|'cancelled';
let nextVisit=0;
export class GuestSeatTrace {
 private context:ReturnType<typeof snapshotTraceContext>={};
 private readonly visit=++nextVisit;
 private spans=new Map<Stage,TraceSpan|undefined>();
 private live=false;private closed=false;private publications=0;
 start(programMode:boolean):void {
  try{this.context=snapshotTraceContext();}catch{/* Diagnostics cannot affect joining. */}
  this.begin('peer.attempt',{programMode,includesAdmissionWait:true});
 }
 begin(stage:Stage,fields:TraceFields={}):void {
  if(this.closed||this.spans.has(stage))return;
  try{this.spans.set(stage,startTraceSpan(stage,{seatVisit:this.visit,...fields},this.context));}catch{/* Never affect media. */}
 }
 end(stage:Stage,status:Status='ok',fields:TraceFields={}):void {
  if(!this.spans.has(stage))return;
  const span=this.spans.get(stage);this.spans.delete(stage);
  try{endTraceSpan(span,status,fields);}catch{/* Never affect media. */}
 }
 async measure<T>(stage:Stage,work:()=>Promise<T>,fields:TraceFields={}):Promise<T> {
  this.begin(stage,fields);
  try{const result=await work();this.end(stage);return result;}
  catch(error){this.end(stage,'error');throw error;}
 }
 waiting():void {this.begin('peer.admission_wait');}
 admitted():void {this.end('peer.admission_wait');}
 phase(phase:'starting'|'waiting'|'connecting'|'live'|'gone'|'error'):void {
  if(phase==='live'){
   this.end('peer.attempt');this.end('peer.reconnect');this.live=true;
  }else if(this.live&&(phase==='waiting'||phase==='connecting'))this.begin('peer.reconnect');
 }
 diagnostic(phase:Diagnostic):void {
  // Ordinary polling and repeated failures are deliberately not events.
  if(phase==='connect_start')this.begin('peer.rtc.connect');
  else if(phase==='connect_end')this.end('peer.rtc.connect');
  else if(phase==='publish_start')this.begin('peer.rtc.publish',{publicationSequence:++this.publications});
  else if(phase==='publish_end')this.end('peer.rtc.publish');
  else if(phase==='retire_start'){
   this.end('peer.rtc.connect','cancelled');this.end('peer.rtc.publish','cancelled');this.begin('peer.rtc.retire');
  }else if(phase==='retire_end')this.end('peer.rtc.retire');
  else if(phase==='poll_failed'){
   this.end('peer.rtc.connect','error');this.end('peer.rtc.publish','error');
  }
 }
 trackAvailable(video:boolean):void {
  if(this.closed)return;
  // This is track availability, not proof of a decoded/presented frame.
  try{recordTraceEvent('peer.return.track_available',{seatVisit:this.visit,video,audio:!video},'native_metric',this.context);}catch{/* Never affect playback. */}
 }
 cancel(status:Status='cancelled'):void {for(const stage of [...this.spans.keys()])this.end(stage,status);}
 leave(retiring:Promise<void>):void {
  void retiring.then(()=>{this.end('peer.leave');this.closed=true;},()=>{this.end('peer.leave','error');this.closed=true;});
 }
}
