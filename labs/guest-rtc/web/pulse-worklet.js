class Pulse extends AudioWorkletProcessor {
  constructor(options){super();this.numbered=options.processorOptions?.numbered===true;this.sourcePhase=options.processorOptions?.sourcePhase??0;this.active=false;}
  process(inputs, outputs) {
    const channel = outputs[0][0];
    for (let n = 0; n < channel.length; n++) {
      const contextTime = currentTime + n / sampleRate;
      const t = contextTime + this.sourcePhase;
      const phase = t % 2;
      const active=phase>=0.5&&phase<0.62;
      if(this.numbered&&active&&!this.active)this.port.postMessage({kind:'source-marker',id:Math.floor(t/2)%256,context_time_seconds:contextTime});
      this.active=active;
      channel[n] = phase >= 0.5 && phase < 0.62 ? 0.4 * Math.sin(2 * Math.PI * (997+(this.numbered?128*(Math.floor(t/2)%16):0)) * t) : 0;
    }
    return true;
  }
}
registerProcessor('pulse', Pulse);
