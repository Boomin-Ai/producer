// Generated input for the isolated native-ingress proof. Never opens hardware.
// Audio samples and canvas phase use the same AudioContext clock. Canvas paint
// remains frame-quantized, so this proves generated-media alignment, not camera
// or microphone capture timing. Stop/close is owned by the browser context.
export function installNumberedGuestInput() {
  let setup;
  const trace = {audio: [], video: [], errors: [], capacity: 128};
  window.numberedGuestInput = trace;
  navigator.mediaDevices.getUserMedia = async constraints => {
    setup ??= (async () => {
      trace.phase = "context";
      const context = new AudioContext({sampleRate: 48000});
      await context.resume();
      trace.phase = "buffer";
      const seconds = 128, rate = context.sampleRate;
      const buffer = context.createBuffer(1, rate * seconds, rate);
      const pcm = buffer.getChannelData(0);
      for (let n = 0; n < pcm.length; n++) {
        const t = n / rate, phase = t % 2, id = Math.floor(t / 2) % 16;
        pcm[n] = phase >= 0.5 && phase < 0.62
          ? 0.4 * Math.sin(2 * Math.PI * (997 + 128 * id) * t) : 0;
      }
      const pulse = context.createBufferSource(); pulse.buffer = buffer;
      const destination = context.createMediaStreamDestination();
      pulse.connect(destination);
      const start = context.currentTime + 0.1;
      pulse.start(start);
      trace.audio_reference = "scheduled PCM buffer samples; not a receiver observation";
      for (let id = 0; id < seconds / 2; id++)
        trace.audio.push({id, context_time_seconds: start + id * 2 + 0.5});
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const paint = canvas.getContext('2d');
      let active = false;
      function draw() {
        const time = Math.max(0, context.currentTime - start), id = Math.floor(time / 2) % 256;
        const next = time % 2 >= 0.5 && time % 2 < 0.62;
        paint.fillStyle = next ? '#fff' : '#008000';
        paint.fillRect(0, 0, 320, 180);
        for (let bit = 0; bit < 8; bit++) {
          paint.fillStyle = id & (1 << bit) ? '#fff' : '#000';
          paint.fillRect(bit * 40, 0, 40, 16);
        }
        if (next && !active) {
          if (trace.video.length < trace.capacity) trace.video.push({id, context_time_seconds: context.currentTime});
          else if (!trace.errors.length) trace.errors.push('video-marker-capacity');
        }
        active = next;
      }
      draw();
      const timer = setInterval(draw, 1000 / 30);
      const video = canvas.captureStream(30);
      window.addEventListener('pagehide', () => {
        clearInterval(timer); pulse.disconnect();
        for (const track of [...video.getTracks(), ...destination.stream.getTracks()]) track.stop();
        void context.close();
      }, {once: true});
      trace.phase = "ready";
      return {video, audio: destination.stream};
    })();
    const streams = await setup;
    return new MediaStream([
      ...(constraints.video ? streams.video.getVideoTracks().map(track => track.clone()) : []),
      ...(constraints.audio ? streams.audio.getAudioTracks().map(track => track.clone()) : []),
    ]);
  };
}
