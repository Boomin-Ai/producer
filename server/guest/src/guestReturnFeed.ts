/** Host-side return capture. Owns its captures; never plays them locally. */
export class GuestReturnFeed {
  private closed = false;
  private wanted = false;
  private attaching = false;
  private retries = 0;
  private timer = 0;
  private streams = new Set<MediaStream>();
  private videoSender: RTCRtpSender | null = null;
  private program: MediaStream | null = null;
  private readonly deviceChange = () => { if (this.wanted) void this.attachVideo(); };

  constructor(private readonly opts: {
    pc: RTCPeerConnection;
    programLabel: string | null;
    micLabel: string | null;
    enabled: boolean;
  }) {
    if (!opts.enabled) return;
    navigator.mediaDevices.addEventListener?.("devicechange", this.deviceChange);
    // Audio failure must never prevent program video setup or signaling.
    void this.attachAudio();
  }

  request(): void {
    if (this.closed || !this.opts.enabled || !this.opts.programLabel) return;
    if (!this.wanted) this.retries = 0;
    this.wanted = true;
    void this.attachVideo();
  }

  private alive(): boolean {
    return !this.closed && this.opts.pc.signalingState !== "closed";
  }

  /** A timeout cannot cancel getUserMedia. Stop any late stream explicitly. */
  private capture(constraints: MediaStreamConstraints): Promise<MediaStream | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (stream: MediaStream | null) => {
        if (settled || !this.alive()) {
          stream?.getTracks().forEach((track) => track.stop());
          if (settled) return;
          stream = null;
        }
        settled = true;
        window.clearTimeout(timeout);
        if (stream) this.streams.add(stream);
        resolve(stream);
      };
      const timeout = window.setTimeout(() => finish(null), 5000);
      void navigator.mediaDevices.getUserMedia(constraints).then(finish, () => finish(null));
    });
  }

  private release(stream: MediaStream): void {
    this.streams.delete(stream);
    stream.getTracks().forEach((track) => track.stop());
  }

  private async attachAudio(): Promise<void> {
    try {
      let stream = await this.capture({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!stream || !this.alive()) return;
      if (this.opts.micLabel) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!this.alive()) return;
        const device = devices.find((d) => d.kind === "audioinput" && d.label === this.opts.micLabel);
        if (device) {
          const exact = await this.capture({ audio: { deviceId: { exact: device.deviceId }, echoCancellation: true, noiseSuppression: true }, video: false });
          if (exact) { this.release(stream); stream = exact; }
        }
      }
      if (!this.alive()) return;
      stream.getAudioTracks().forEach((track) => this.opts.pc.addTrack(track, stream));
    } catch (error) {
      console.warn("[guest-return] host audio unavailable", error instanceof Error ? error.name : "capture-error");
    }
  }

  private schedule(): void {
    if (!this.alive() || !this.wanted || this.retries >= 90) return;
    window.clearTimeout(this.timer);
    this.retries += 1;
    this.timer = window.setTimeout(() => void this.attachVideo(), 2000);
  }

  private async attachVideo(): Promise<void> {
    if (!this.alive() || !this.wanted || this.attaching || this.program) return;
    this.attaching = true;
    try {
      const pick = (devices: MediaDeviceInfo[]) => devices.find((d) => d.kind === "videoinput" &&
        (d.label.toLowerCase().includes(this.opts.programLabel!.toLowerCase()) ||
          (d.label.toLowerCase().includes("producer") && d.label.toLowerCase().includes("virtual camera"))));
      let devices = await navigator.mediaDevices.enumerateDevices();
      if (!this.alive()) return;
      // Probe only when labels are hidden. A missing virtual camera with known
      // labels needs a retry, not repeated activation of the physical camera.
      if (devices.some((d) => d.kind === "videoinput" && !d.label) && !pick(devices)) {
        const probe = await this.capture({ video: true, audio: false });
        if (probe) this.release(probe);
        if (!this.alive()) return;
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      if (!this.alive()) return;
      const device = pick(devices);
      if (!device) { this.schedule(); return; }
      const stream = await this.capture({ video: { deviceId: { exact: device.deviceId }, width: 640, height: 360, frameRate: 15 }, audio: false });
      if (!stream || !this.alive()) { this.schedule(); return; }
      const track = stream.getVideoTracks()[0];
      if (!track) { this.release(stream); this.schedule(); return; }
      // Reuse the sender after virtual-camera restarts, rather than accumulating
      // ended senders/transceivers and renegotiating every restart.
      if (this.videoSender) await this.videoSender.replaceTrack(track);
      else this.videoSender = this.opts.pc.addTrack(track, stream);
      if (!this.alive()) { this.release(stream); return; }
      this.program = stream;
      this.retries = 0;
      window.clearTimeout(this.timer);
      track.addEventListener("ended", () => {
        if (this.program !== stream) return;
        this.program = null;
        this.release(stream);
        this.retries = 0;
        this.schedule();
      });
    } catch (error) {
      console.warn("[guest-return] program capture retry", error instanceof Error ? error.name : "capture-error");
      this.schedule();
    } finally {
      this.attaching = false;
    }
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.timer);
    navigator.mediaDevices.removeEventListener?.("devicechange", this.deviceChange);
    this.program = null;
    for (const stream of this.streams) this.release(stream);
  }
}

/** Guest-side request loop. Connection/track arrival does not prove decoding. */
export class ProgramRequest {
  private closed = false;
  private timer = 0;
  private asks = 0;
  private startedAt = 0;
  private generation = 0;
  private lastFrames: number | null = null;
  private readonly visible = () => {
    if (document.visibilityState === "visible") this.connected();
  };

  constructor(private readonly pc: RTCPeerConnection, private readonly send: () => void, private readonly delayMs = 0, private readonly readStats: () => Promise<RTCStatsReport> = () => pc.getStats()) {
    document.addEventListener("visibilitychange", this.visible);
  }

  connected(): void {
    if (this.closed || this.timer || this.pc.connectionState !== "connected") return;
    this.asks = 0;
    this.lastFrames = null;
    this.startedAt = Date.now();
    const generation = ++this.generation;
    this.timer = window.setTimeout(() => void this.tick(generation), this.delayMs);
  }

  restart(): void {
    this.generation += 1;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.connected();
  }

  private async tick(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (this.closed || this.pc.connectionState !== "connected") { this.timer = 0; return; }
    if (document.visibilityState !== "visible") { this.timer = 0; return; }
    let decoded = false;
    try {
      const stats = await this.readStats();
      let frames = 0;
      stats.forEach((stat) => {
        if (stat.type === "inbound-rtp" && !stat.isRemote && (stat.kind === "video" || stat.mediaType === "video")) frames += Number(stat.framesDecoded ?? 0);
      });
      if (generation !== this.generation) return;
      decoded = this.lastFrames !== null && frames > this.lastFrames;
      this.lastFrames = frames;
    } catch { /* Requesting again is safe if statistics are unavailable. */ }
    if (this.closed || generation !== this.generation) return;
    if (decoded || this.asks >= 30 || Date.now() - this.startedAt > 120000) { this.timer = 0; return; }
    this.send();
    this.asks += 1;
    this.timer = window.setTimeout(() => void this.tick(generation), 3000);
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    window.clearTimeout(this.timer);
    document.removeEventListener("visibilitychange", this.visible);
  }
}
