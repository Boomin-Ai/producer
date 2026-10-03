import { sharedProgramCapture, type ProgramLease } from './programCapture';
export interface MediaSignal { kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
/** One viewer leg, sharing capture with every guest and monitor. */
export class AudienceSender {
  private readonly pc = new RTCPeerConnection({ iceServers: [{urls:'stun:stun.cloudflare.com:3478'}] });
  private lease: ProgramLease | null = null;
  private closed = false;
  private makingOffer = false;
  private ice: RTCIceCandidateInit[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly send: (payload: MediaSignal) => void, private readonly fail: () => void) {
    this.pc.onicecandidate = (e) => { if(e.candidate)this.send({kind:'ice',candidate:e.candidate.toJSON()}); };
    this.pc.onnegotiationneeded = async()=>{try{this.makingOffer=true;await this.pc.setLocalDescription();this.send({kind:'sdp',description:this.pc.localDescription!});}catch{if(!this.closed)this.fail();}finally{this.makingOffer=false;}};
    this.pc.onconnectionstatechange = ()=>{if(this.pc.connectionState==='failed'){this.fail();this.stop();}};
    void this.start();
  }
  private async start(): Promise<void> {
    try{const lease=await sharedProgramCapture.acquire(0);if(this.closed){lease.release();return;}this.lease=lease;const stream=new MediaStream([lease.video,lease.audio]);stream.getTracks().forEach(t=>this.pc.addTrack(t,stream));
      for(const sender of this.pc.getSenders()){const p=sender.getParameters();if(p.encodings?.length){p.encodings[0].maxBitrate=sender.track?.kind==='video'?800000:64000;await sender.setParameters(p);}}
    }catch{if(!this.closed){this.fail();this.stop();}}
  }
  signal(payload: MediaSignal): void { this.queue=this.queue.catch(()=>{}).then(async()=>{
    if(this.closed)return;
    if(payload.description){if(payload.description.type==='offer'&&(this.makingOffer||this.pc.signalingState!=='stable'))return;await this.pc.setRemoteDescription(payload.description);for(const c of this.ice.splice(0))await this.pc.addIceCandidate(c);if(payload.description.type==='offer'){await this.pc.setLocalDescription();this.send({kind:'sdp',description:this.pc.localDescription!});}}
    else if(payload.candidate){if(this.pc.remoteDescription)await this.pc.addIceCandidate(payload.candidate);else if(this.ice.length<64)this.ice.push(payload.candidate);}
  }).catch(()=>{}); }
  stop():void{this.closed=true;this.pc.onconnectionstatechange=null;this.pc.close();this.lease?.release();this.lease=null;}
}
