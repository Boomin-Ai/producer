// Numeric generated marker observations only. No camera/mic or media recording.
export class RecoveryProbe {
 constructor(){this.video=[];this.audio=[];this.epochs=[];this.errors=[];this.audioEpoch=0;this.videoEpoch=0;this.audioActive=false;this.videoActive=false;this.canvas=document.createElement('canvas');this.canvas.width=320;this.canvas.height=180;this.paint=this.canvas.getContext('2d',{willReadFrequently:true});}
 push(kind,value){if(this[kind].length>=2048){if(!this.errors.includes('marker-cap'))this.errors.push('marker-cap');return;}this[kind].push(value);}
 attachVideo(track,publication,element){
  const epoch=++this.videoEpoch;this.videoActive=false;this.epochs.push({kind:'video',epoch,sid:publication.trackSid,trackId:track.mediaStreamTrack.id,at_ms:performance.now()});
  const frame=()=>{
   if(epoch!==this.videoEpoch || track.mediaStreamTrack.readyState==='ended')return;
   try {
    this.paint.drawImage(element,0,0,320,180);const bright=this.paint.getImageData(160,90,1,1).data[0]>180;
    if(bright&&!this.videoActive){let id=0;for(let bit=0;bit<8;bit++)if(this.paint.getImageData(bit*40+20,8,1,1).data[0]>180)id|=1<<bit;this.push('video',{id,epoch,at_ms:performance.now()});}
    this.videoActive=bright;
   }catch(error){if(this.errors.length<16)this.errors.push(String(error));}
   element.requestVideoFrameCallback(frame);
  };element.requestVideoFrameCallback(frame);
 }
 attachAudio(track,publication,context,source){
  clearInterval(this.timer);this.source?.disconnect();this.analyser?.disconnect();
  const epoch=++this.audioEpoch;this.audioActive=false;this.epochs.push({kind:'audio',epoch,sid:publication.trackSid,trackId:track.mediaStreamTrack.id,at_ms:performance.now()});
  const analyser=context.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=0;this.analyser=analyser;this.source=source;source.connect(analyser);
  const pcm=new Float32Array(2048),frequencies=new Float32Array(analyser.frequencyBinCount);
  this.timer=setInterval(()=>{
   if(epoch!==this.audioEpoch)return;
   analyser.getFloatTimeDomainData(pcm);const rms=Math.sqrt(pcm.reduce((sum,n)=>sum+n*n,0)/pcm.length);const active=rms>0.12;
   if(active&&!this.audioActive){analyser.getFloatFrequencyData(frequencies);let best=0;for(let i=1;i<frequencies.length;i++)if(frequencies[i]>frequencies[best])best=i;const hz=best*context.sampleRate/analyser.fftSize;const id=Math.round((hz-997)/128);if(id>=0&&id<16)this.push('audio',{id,epoch,at_ms:performance.now(),dominant_hz:hz});else if(this.errors.length<16)this.errors.push('unrecognized generated frequency');}
   this.audioActive=active;
  },10);
 }
 snapshot(){return {video:this.video,audio:this.audio,epochs:this.epochs,errors:this.errors,clock:'browser performance.now observation; includes video paint and analyser window uncertainty',capture_to_playout_qualified:false};}
 stop(){clearInterval(this.timer);this.videoEpoch++;this.audioEpoch++;this.source?.disconnect();this.analyser?.disconnect();}
}
