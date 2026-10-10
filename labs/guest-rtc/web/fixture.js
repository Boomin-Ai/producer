import { Room, RoomEvent, LocalAudioTrack, LocalVideoTrack, Track } from 'livekit-client';

let room, context, timer, analyser, returnAudio, synthetic, silentOutput;
const state = { identity: new URLSearchParams(location.search).get('identity') ?? 'guest-1',
  connected: false, published: false, returnAudioBlocks: 0, returnAudioPulses: 0, returnVideoFrames: 0,
  events: [], audioMaxRms: 0, error: null };
window.labState = state;
function display() { document.querySelector('#status').textContent = JSON.stringify(state, null, 2); }
export async function start() {
  if (room) return;
  try {
    const credentials = await (await fetch(`/token?identity=${encodeURIComponent(state.identity)}`)).json();
    state.syncStreams = credentials.syncStreams;
    const stream = credentials.syncStreams ? 'camera-av' : undefined;
    room = new Room({ adaptiveStream: false, dynacast: false });
    context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule('/pulse-worklet.js');
    await context.resume();
    const subscribe = (publication, participant) => {
      if (participant.identity === 'native-host') publication.setSubscribed(true);
    };
    room.on(RoomEvent.TrackPublished, subscribe);
    room.on(RoomEvent.Reconnecting, () => { state.events.push('reconnecting'); display(); });
    room.on(RoomEvent.Reconnected, () => { state.events.push('reconnected'); display(); });
    room.on(RoomEvent.Disconnected, () => { state.connected = false; state.events.push('disconnected'); display(); });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (participant.identity !== 'native-host') return;
      state.events.push(`return-${track.kind}`);
      if (track.kind === Track.Kind.Video) {
        const element = document.querySelector('#return');
        track.attach(element);
        const frame = () => { state.returnVideoFrames++; element.requestVideoFrameCallback(frame); };
        element.requestVideoFrameCallback(frame);
      } else {
        window.returnAudioTrack = track;
        const element = track.attach(); element.volume = 0; element.autoplay = true;
        document.body.append(element); element.play().catch(error => { state.error = String(error); });
        // Analyse the remote PCM without audibly playing it or a self preview.
        returnAudio = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        analyser = context.createAnalyser(); analyser.fftSize = 1024;
        returnAudio.connect(analyser);
        // Keep the Web Audio graph running while output remains exactly silent.
        silentOutput = context.createGain(); silentOutput.gain.value = 0;
        analyser.connect(silentOutput); silentOutput.connect(context.destination);
      }
      display();
    });
    await room.connect(credentials.url, credentials.token, { autoSubscribe: false });
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
    }
    state.connected = true;
    const canvas = document.querySelector('#fixture'), paint = canvas.getContext('2d');
    let active = false;
    timer = setInterval(() => {
      const phase = context.currentTime % 2;
      paint.fillStyle = phase >= 0.5 && phase < 0.62 ? '#fff' : '#000';
      paint.fillRect(0, 0, canvas.width, canvas.height);
      if (analyser) {
        const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        state.audioMaxRms = Math.max(state.audioMaxRms, rms);
        const next = rms > 0.08;
        if (next && !active) state.returnAudioPulses++;
        active = next; state.returnAudioBlocks++;
      }
      display();
    }, 1000 / 30);
    synthetic = new AudioWorkletNode(context, 'pulse');
    const destination = context.createMediaStreamDestination(); synthetic.connect(destination);
    const video = new LocalVideoTrack(canvas.captureStream(30).getVideoTracks()[0]);
    const audio = new LocalAudioTrack(destination.stream.getAudioTracks()[0]);
    await room.localParticipant.publishTrack(video, { stream, source: Track.Source.Camera, simulcast: false,
      videoCodec: 'vp8', videoEncoding: { maxBitrate: 250000, maxFramerate: 30 } });
    await room.localParticipant.publishTrack(audio, { stream, source: Track.Source.Microphone, dtx: false,
      red: false, audioPreset: { maxBitrate: 64000 }, forceStereo: false });
    state.published = true; display();
  } catch (error) { state.error = String(error); display(); throw error; }
}
export async function stop() {
  clearInterval(timer); synthetic?.disconnect(); returnAudio?.disconnect();
  await room?.disconnect(); await context?.close(); room = null;
  state.published = false; display();
}
window.startLab = start; window.stopLab = stop;
document.querySelector('#start').onclick = start;
document.querySelector('#stop').onclick = stop;
display();
