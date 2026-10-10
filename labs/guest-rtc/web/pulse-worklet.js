class Pulse extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const channel = outputs[0][0];
    for (let n = 0; n < channel.length; n++) {
      const t = currentTime + n / sampleRate;
      const phase = t % 2;
      channel[n] = phase >= 0.5 && phase < 0.62 ? 0.4 * Math.sin(2 * Math.PI * 997 * t) : 0;
    }
    return true;
  }
}
registerProcessor('pulse', Pulse);
