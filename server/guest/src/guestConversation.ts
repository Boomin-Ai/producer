import { GuestMesh, type StageUpdate } from "./guestMesh";

/** Participant voices travel directly between participants. Program return
 * contains host/local media only, so it cannot return someone's own voice. */
export class GuestConversation {
  private mesh: GuestMesh | null = null;
  private socket: WebSocket | null = null;
  private timer = 0;
  private generation = 0;
  private running = false;
  private enabled = true;
  private stage: StageUpdate | null = null;
  private readonly players = new Map<string, HTMLAudioElement>();
  constructor(private readonly options: {
    api: string; code: string; localStream: () => MediaStream | null; onFrame?: (raw: unknown) => void; onSession?: (peerId: string, stage: StageUpdate) => void; interactionChannel?: string;
  }) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }
  setMicrophoneEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh?.setMicrophoneEnabled(enabled);
  }
  refreshMicrophone(): void { this.mesh?.refreshMicrophone(); }
  applyStage(update: StageUpdate, _source?: "host"): void {
    if (this.stage && update.version < this.stage.version) return;
    this.stage = update;
    this.mesh?.applyStage(update, "host");
  }
  suspend(): void { this.stage = null; this.mesh?.suspend(); }
  stop(): void {
    this.running = false;
    this.generation++;
    window.clearTimeout(this.timer);
    this.socket?.close(); this.socket = null;
    this.mesh?.close(); this.mesh = null;
    this.stage = null;
    for (const player of this.players.values()) { player.pause(); player.srcObject = null; player.remove(); }
    this.players.clear();
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const current = () => this.running && generation === this.generation;
    try {
      const response = await fetch(`${this.options.api}/guest/${encodeURIComponent(this.options.code)}/room-session`, { method: "POST" });
      if (!response.ok) throw new Error(`Room conversation ${response.status}`);
      const session = await response.json() as {
        signaling_url: string; peer_id: string; stage: StageUpdate; ice_servers?: RTCIceServer[];
      };
      if (!current()) return;
      const url = new URL(session.signaling_url, this.options.api);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      this.options.onSession?.(session.peer_id, session.stage);
      const socket = new WebSocket(url.toString());
      const old = this.socket;
      this.socket = socket;
      old?.close();
      if (!this.mesh) this.mesh = new GuestMesh({
        selfId: session.peer_id, iceServers: session.ice_servers ?? [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }], localStream: this.options.localStream,
        send: (to, payload) => {
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "signal", to, payload }));
        },
        onPeerAudio: (id, stream) => {
          let player = this.players.get(id);
          if (!stream) {
            if (player) { player.pause(); player.srcObject = null; player.remove(); this.players.delete(id); }
            return;
          }
          if (!player) { player = document.createElement("audio"); player.autoplay = true; this.players.set(id, player); }
          if (player.srcObject !== stream) player.srcObject = stream;
          void player.play().catch(() => {});
        },
      });
      this.mesh.setMicrophoneEnabled(this.enabled);
      this.mesh.applyStage(session.stage, "server");
      if (this.stage) this.mesh.applyStage(this.stage, "host");
      socket.onmessage = (event) => {
        if (!current() || this.socket !== socket) return;
        this.options.onFrame?.(event.data);
        try {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "signal" && typeof frame.from === "string" && frame.payload) void this.mesh?.onSignal(frame.from, frame.payload);
        } catch { /* Ignore malformed signaling. */ }
      };
      socket.onclose = () => {
        if (!current() || this.socket !== socket) return;
        this.socket = null;
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.connect(), 1000);
      };
      socket.onopen = () => {
        if (!current() || this.socket !== socket) return;
        if (this.options.onFrame) socket.send(JSON.stringify({ type: "subscribe", channel: this.options.interactionChannel ?? "interactions" }));
        window.clearTimeout(this.timer);
        // Room guest tickets expire after 120 seconds; renew introductions
        // without replacing the media capture or the established peer legs.
        this.timer = window.setTimeout(() => void this.connect(), 90_000);
      };
    } catch {
      if (current()) this.timer = window.setTimeout(() => void this.connect(), 2000);
    }
  }
}
