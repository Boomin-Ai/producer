// Optional local listening capture of decoded native-host audio. Never monitor it.
class VoiceReview extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.limit=options.processorOptions.limitSamples;
    this.total=0;this.fill=0;this.sequence=0;this.finished=false;
    this.pcm=new Int16Array(48000);
    this.port.onmessage=event=>{if(event.data==='finish')this.finish();};
  }
  flush() {
    if(!this.fill)return;
    const pcm=this.pcm.slice(0,this.fill);
    this.port.postMessage({kind:'pcm',sequence:this.sequence++,pcm},[pcm.buffer]);
    this.fill=0;
  }
  finish(error=null) {
    if(this.finished)return;
    this.flush();this.finished=true;
    this.port.postMessage({kind:'finished',samples:this.total,rate:sampleRate,error});
  }
  process(inputs,outputs) {
    // Outputs are always silent, independently of the browser's gain node.
    for(const output of outputs)for(const channel of output)channel.fill(0);
    if(this.finished)return true;
    const channels=inputs[0];
    if(!channels?.length)return true;
    if(sampleRate!==48000 || channels.length!==1) {this.finish('Unexpected decoded recording format');return true;}
    for(const sample of channels[0]) {
      if(!Number.isFinite(sample)){this.finish('Nonfinite decoded audio');return true;}
      if(this.total>=this.limit){this.finish();break;}
      this.pcm[this.fill++]=Math.round(Math.max(-1,Math.min(1,sample))*32767);this.total++;
      if(this.fill===this.pcm.length)this.flush();
    }
    return true;
  }
}
registerProcessor('voice-review',VoiceReview);
