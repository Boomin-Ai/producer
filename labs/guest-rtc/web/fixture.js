import {RecoveryProbe} from './generated-recovery-probe.js';
import {SourceMarkerTrace} from './source-marker-trace.mjs';
import { Room, RoomEvent, LocalAudioTrack, LocalVideoTrack, Track } from 'livekit-client';

const recoveryProbe=new URLSearchParams(location.search).get("recoveryProbe")==="1"?new RecoveryProbe():null;
window.recoveryProbe=recoveryProbe;
const sourceMarkers=recoveryProbe?new SourceMarkerTrace():null;
window.sourceMarkers=sourceMarkers;
const sourcePhase=Number(new URLSearchParams(location.search).get('sourcePhase')??0);
if(!Number.isFinite(sourcePhase)||sourcePhase<0||sourcePhase>=2)throw new Error('Invalid source phase');
let room, context, timer, analyser, returnAudio, synthetic, silentOutput, guestGain, voiceRecorder;
const voiceReview=new URLSearchParams(location.search).get("voiceReview")==="1";
const cameraSync=new URLSearchParams(location.search).get("cameraSync")==="1";
let returnVideoTrack,avRecorder,avChunks=[],avBytes=0,avError=null,avFinished;
window.finishAvReview=async()=>{
 if(!avRecorder)throw new Error("AV recorder never attached");
 if(avRecorder.state!=="inactive")avRecorder.stop();
 await Promise.race([avFinished,new Promise((_,reject)=>setTimeout(()=>reject(new Error("AV recorder finish timeout")),3000))]);
 if(avError)throw new Error(avError);
 const blob=new Blob(avChunks,{type:avRecorder.mimeType});
 const bytes=new Uint8Array(await blob.arrayBuffer());let text="";for(let at=0;at<bytes.length;at+=16384)text+=String.fromCharCode(...bytes.subarray(at,at+16384));
 avChunks=[];return {base64:btoa(text),bytes:bytes.length,mime:avRecorder.mimeType};
};
function beginAvReview(){
 if(!cameraSync || avRecorder || !returnVideoTrack || !window.returnAudioTrack)return;
 const mime="video/webm;codecs=vp8,opus";if(!MediaRecorder.isTypeSupported(mime))throw new Error("AV review codec unsupported");
 avRecorder=new MediaRecorder(new MediaStream([returnVideoTrack.mediaStreamTrack,window.returnAudioTrack.mediaStreamTrack]),{mimeType:mime,videoBitsPerSecond:750000,audioBitsPerSecond:64000});
 avFinished=new Promise((resolve,reject)=>{avRecorder.onstop=resolve;avRecorder.onerror=reject;});
 avRecorder.ondataavailable=event=>{avBytes+=event.data.size;if(avBytes>20000000 || avChunks.length>=70){avError="AV review exceeded recording limit";if(avRecorder.state!=="inactive")avRecorder.stop();return;}if(event.data.size)avChunks.push(event.data);};
 avRecorder.start(1000);
}
let voiceChunks=[],voiceSamples=0,voiceFinished,voiceResolve;
window.finishVoiceReview=async()=>{
 if(!voiceRecorder)throw new Error("No decoded voice recorder attached");
 voiceRecorder.port.postMessage("finish");
 const result=await Promise.race([voiceFinished,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Decoded recorder finish timeout")),2000))]);
 voiceRecorder.disconnect();
 const chunks=voiceChunks.map(pcm=>{const bytes=new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength);let text="";for(let at=0;at<bytes.length;at+=16384)text+=String.fromCharCode(...bytes.subarray(at,at+16384));return btoa(text);});
 voiceChunks=[];return {...result,chunks};
};
window.setGuestSpeechEnabled=enabled=>{if(guestGain)guestGain.gain.value=enabled?1:0;};
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
    if(voiceReview)await context.audioWorklet.addModule('/voice-review-worklet.js');
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
        returnVideoTrack=track;window.returnVideoTrack=track;beginAvReview();recoveryProbe?.attachVideo(track,publication,element);
        const frame = () => { if(returnVideoTrack!==track)return;state.returnVideoFrames++; element.requestVideoFrameCallback(frame); };
        element.requestVideoFrameCallback(frame);
      } else {
        returnAudio?.disconnect();analyser?.disconnect();silentOutput?.disconnect();
        window.returnAudioTrack?.detach().forEach(element=>element.remove());
        window.returnAudioTrack = track;beginAvReview();
        const element = track.attach(); element.volume = 0; element.autoplay = true;
        document.body.append(element); element.play().catch(error => { state.error = String(error); });
        // Analyse the remote PCM without audibly playing it or a self preview.
        returnAudio = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        analyser = context.createAnalyser(); analyser.fftSize = 1024;
        returnAudio.connect(analyser);recoveryProbe?.attachAudio(track,publication,context,returnAudio);
        // Keep the Web Audio graph running while output remains exactly silent.
        silentOutput = context.createGain(); silentOutput.gain.value = 0;
        analyser.connect(silentOutput); silentOutput.connect(context.destination);
        if(voiceReview) {
          if(voiceRecorder)throw new Error('Voice review does not support track replacement');
          voiceFinished=new Promise(resolve=>{voiceResolve=resolve;});
          voiceRecorder=new AudioWorkletNode(context,'voice-review',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit',processorOptions:{limitSamples:48000*65}});
          voiceRecorder.port.onmessage=event=>{
            const message=event.data;
            if(message.kind==='pcm') {
              if(message.sequence!==voiceChunks.length || voiceChunks.length>=66 || voiceSamples+message.pcm.length>48000*65) {voiceResolve({error:'Decoded recorder chunk limit/sequence fault'});voiceRecorder.port.postMessage('finish');return;}
              voiceSamples+=message.pcm.length;voiceChunks.push(message.pcm);
            } else if(message.kind==='finished')voiceResolve(message);
          };
          returnAudio.connect(voiceRecorder);voiceRecorder.connect(silentOutput);
        }

      }
      display();
    });
    await room.connect(credentials.url, credentials.token, { autoSubscribe: false });
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
    }
    state.connected = true;
    const canvas = document.querySelector('#fixture'), paint = canvas.getContext('2d');
    let active = false, sourceVideoActive = false;
    timer = setInterval(() => {
      const markerTime=context.currentTime+sourcePhase;
      const phase = markerTime % 2;
      paint.fillStyle = phase >= 0.5 && phase < 0.62 ? '#fff' : '#000';
      paint.fillRect(0, 0, canvas.width, canvas.height);
      const sourcePulse=phase>=0.5&&phase<0.62;
      if(sourceMarkers&&sourcePulse&&!sourceVideoActive)sourceMarkers.push('video',Math.floor(markerTime/2)%256,context.currentTime);
      sourceVideoActive=sourcePulse;
      if(recoveryProbe){const id=Math.floor(markerTime/2)%256;for(let bit=0;bit<8;bit++){paint.fillStyle=id&(1<<bit)?'#fff':'#000';paint.fillRect(bit*40,0,40,16);}}
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
    if (new URLSearchParams(location.search).get('monitorSpeech') === '1') {
      const pcm=await context.decodeAudioData(await (await fetch('/monitor-speech.wav')).arrayBuffer());
      synthetic=context.createBufferSource();synthetic.buffer=pcm;synthetic.loop=true;synthetic.start();
      state.guestFixture='remote speech only; no browser microphone';
    } else synthetic = new AudioWorkletNode(context, 'pulse',{processorOptions:{numbered:recoveryProbe!==null,sourcePhase}});
    if(sourceMarkers&&synthetic.port)synthetic.port.onmessage=event=>{
      if(event.data?.kind==='source-marker')sourceMarkers.push('audio',event.data.id,event.data.context_time_seconds);
    };
    const destination = context.createMediaStreamDestination(); guestGain=context.createGain();synthetic.connect(guestGain);guestGain.connect(destination);
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
  recoveryProbe?.stop();
  if(avRecorder?.state!==undefined && avRecorder.state!=="inactive")avRecorder.stop();
  clearInterval(timer); synthetic?.disconnect(); guestGain?.disconnect(); voiceRecorder?.disconnect(); returnAudio?.disconnect();
  await room?.disconnect(); await context?.close(); room = null;
  state.published = false; display();
}
window.startLab = start; window.stopLab = stop;
document.querySelector('#start').onclick = start;
document.querySelector('#stop').onclick = stop;
display();
