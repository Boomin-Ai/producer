/** Receive-only program peer; it cannot acquire a microphone or camera. */
export interface ProgramSignal { peer?: unknown; kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
export class ProgramReceiver {
  private closed=false;
  private pc:RTCPeerConnection|null=null;
  private queue:Promise<unknown>=Promise.resolve();
  private ice:RTCIceCandidateInit[]=[];
  constructor(private readonly iceServers:RTCIceServer[],private readonly send:(payload:ProgramSignal)=>void,private readonly receive:(event:RTCTrackEvent)=>void){}
  handle(payload:ProgramSignal):void{this.queue=this.queue.catch(()=>{}).then(async()=>{
    if(this.closed)return;
    if(!this.pc){const pc=new RTCPeerConnection({iceServers:this.iceServers});this.pc=pc;pc.ontrack=this.receive;pc.onicecandidate=e=>{if(e.candidate)this.send({peer:'program',kind:'ice',candidate:e.candidate.toJSON()});};pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed')pc.restartIce();};}
    const pc=this.pc;
    if(payload.description){if(payload.description.type==='offer'&&pc.signalingState!=='stable')await pc.setLocalDescription({type:'rollback'});await pc.setRemoteDescription(payload.description);for(const ice of this.ice.splice(0))await pc.addIceCandidate(ice);if(payload.description.type==='offer'){await pc.setLocalDescription();this.send({peer:'program',kind:'sdp',description:pc.localDescription!});}}
    else if(payload.candidate){if(pc.remoteDescription)await pc.addIceCandidate(payload.candidate);else if(this.ice.length<64)this.ice.push(payload.candidate);}
  }).catch(()=>{});}
  async getStats():Promise<RTCStatsReport>{return this.pc ? this.pc.getStats() : new Map() as RTCStatsReport;}
  close():void{this.closed=true;this.pc?.close();this.pc=null;this.ice=[];}
}
