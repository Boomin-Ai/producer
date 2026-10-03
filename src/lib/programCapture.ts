/** One capture owner for every interactive return connection in this webview.
 * Peers share tracks, but each WebRTC connection can still require an encoder.
 * The audio comes from processed native buses, never a second raw microphone.
 */
import { invoke } from "@tauri-apps/api/core";
const WORKLET = `
class ProgramPCM extends AudioWorkletProcessor {
  constructor() { super(); this.q=[]; this.read=0; this.frames=0; this.port.onmessage=(e)=>{
    const a=e.data; if (!(a instanceof Float32Array)) return;
    this.q.push(a); this.frames+=a.length/2;
    while(this.frames>9600 && this.q.length>1){const old=this.q.shift();this.frames-=old.length/2-this.read;this.read=0;}
  }; }
  process(_, outputs) {
    const out=outputs[0]; if(!out||!out[0])return true;
    for(let i=0;i<out[0].length;i++){
      const a=this.q[0];
      if(!a){out[0][i]=0;if(out[1])out[1][i]=0;continue;}
      const at=Math.floor(this.read)*2;out[0][i]=a[at]||0;if(out[1])out[1][i]=a[at+1]||0;
      this.read+=48000/sampleRate; this.frames-=48000/sampleRate;
      if(this.read>=a.length/2){this.read-=a.length/2;this.q.shift();}
    } return true;
  }
}
registerProcessor('program-pcm',ProgramPCM);`;
export type ProgramLease = { video: MediaStreamTrack; audio: MediaStreamTrack; release(): void };
async function boundedCapture(constraints: MediaStreamConstraints): Promise<MediaStream> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const capture = navigator.mediaDevices.getUserMedia(constraints).then(stream => {
    if (expired) { stream.getTracks().forEach(track => track.stop()); throw new Error('Capture request expired'); }
    return stream;
  });
  try {
    return await Promise.race([capture, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Authorize Producer Virtual Camera and try again')); }, 5000);
    })]);
  } finally { clearTimeout(timer!); }
}
export class ProgramCapture {
  private video: MediaStream | null = null;
  private context: AudioContext | null = null;
  private buses: MediaStreamAudioDestinationNode[] = [];
  private nodes: AudioWorkletNode[] = [];
  private refs = 0;
  private starting: Promise<void> | null = null;
  private running = false;
  private generation = 0;
  async acquire(bus: 0 | 1, label = 'Producer Virtual Camera'): Promise<ProgramLease> {
    this.refs++;
    try {
      if (!this.starting) {
        const attempt = this.start(label).catch((error) => {
          if (this.starting === attempt) this.stop();
          throw error;
        });
        this.starting = attempt;
      }
      await this.starting;
      const video = this.video?.getVideoTracks()[0];
      const audio = this.buses[bus]?.stream.getAudioTracks()[0];
      if (!video || video.readyState !== 'live' || !audio || audio.readyState !== 'live') throw new Error('Program capture unavailable');
      let released = false;
      return { video, audio, release: () => { if (released) return; released = true; if (--this.refs === 0) this.stop(); } };
    } catch (error) { if (--this.refs === 0) this.stop(); throw error; }
  }
  private async start(label: string): Promise<void> {
    const generation = ++this.generation;
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some(d => d.kind === 'videoinput') && !devices.some(d => d.kind === 'videoinput' && d.label)) {
      // Permission unlocks device labels. This probe never requests audio and
      // releases its tracks before selecting the program camera.
      const probe = await boundedCapture({ video: true, audio: false });
      probe.getTracks().forEach(track => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    if (generation !== this.generation) throw new Error('Publisher closed');
    const camera = devices.find((d) => d.kind === 'videoinput' && d.label.toLowerCase().includes(label.toLowerCase()));
    if (!camera) throw new Error('Start and authorize Producer Virtual Camera first');
    const video = await boundedCapture({ video: { deviceId: { exact: camera.deviceId }, width: 640, height: 360, frameRate: 15 }, audio: false });
    if (generation !== this.generation) { video.getTracks().forEach((t)=>t.stop()); throw new Error('Publisher closed'); }
    this.video = video;
    video.getVideoTracks()[0]?.addEventListener('ended', () => { if (generation === this.generation) this.stop(); }, { once: true });
    this.context = new AudioContext({ sampleRate: 48000 });
    const module = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await this.context.audioWorklet.addModule(module); } finally { URL.revokeObjectURL(module); }
    if (generation !== this.generation) throw new Error('Publisher closed');
    this.buses = [this.context.createMediaStreamDestination(), this.context.createMediaStreamDestination()];
    this.nodes = this.buses.map((bus) => { const node = new AudioWorkletNode(this.context!, 'program-pcm', { outputChannelCount: [2] }); node.connect(bus); return node; });
    await invoke('live_program_audio_start');
    if (generation !== this.generation) throw new Error('Publisher closed');
    // Resuming may wait for a user gesture in WebKit. Video negotiation must
    // remain available while the host enables audio.
    void this.context.resume().catch(() => {});
    if (generation !== this.generation) throw new Error('Publisher closed');
    this.running = true;
    void this.pump(generation);
  }
  private async pump(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      try {
        const data = await invoke<ArrayBuffer>('live_program_audio_read');
        if (!this.running || generation !== this.generation) return;
        const view = new DataView(data);
        for (let pos = 0; pos + 16 <= data.byteLength;) {
          const bus = view.getUint32(pos, true), frames = view.getUint32(pos + 4, true);
          const length = frames * 8;
          if (bus > 1 || frames > 4096 || pos + 16 + length > data.byteLength) break;
          const samples = new Float32Array(frames * 2);
          for (let i=0; i<samples.length; i++) samples[i] = view.getFloat32(pos + 16 + i*4, true);
          this.nodes[bus]?.port.postMessage(samples, [samples.buffer]);
          pos += 16 + length;
        }
      } catch { if (generation === this.generation) this.stop(); return; }
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
  }
  stop(): void {
    this.running = false; this.generation++; this.starting = null;
    this.video?.getTracks().forEach((t)=>t.stop()); this.video = null;
    this.nodes.forEach((n)=>n.disconnect()); this.nodes = [];
    this.buses.forEach((b)=>b.stream.getTracks().forEach((t)=>t.stop())); this.buses = [];
    void this.context?.close(); this.context = null;
    void invoke('live_program_audio_stop');
  }
}
export const sharedProgramCapture = new ProgramCapture();
