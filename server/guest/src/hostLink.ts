// The guest's link to the host — every peer connection that ends in Producer.
//
// ── One channel, two host pages ──────────────────────────────────────────────
// Producer renders a guest as browser sources, one page per SOURCE: the camera
// page (`/render/:id`) and, for a guest who may share, the screen page
// (`/render/:id?track=screen`). Both pages hold a render ticket for the same
// guest session, so both land on the same signaling channel and every frame
// the guest sends reaches BOTH. Each frame therefore names its peer
// (`peer: "main" | "screen"`), each host page answers only its own, and the
// guest keeps one RTCPeerConnection per peer. A frame with no `peer` is from a
// page older than screen share and belongs to the camera peer.
//
// The camera and mic ride the MAIN peer, as they always have. The screen ride
// the SCREEN peer: a separate connection, which is what lets libobs treat it
// as a separate source the host can frame independently of the person.
//
// ── Roles ────────────────────────────────────────────────────────────────────
// The guest is the POLITE peer in perfect negotiation on every connection: on
// a collision it rolls back and takes the host's offer. Deterministic because
// the roles are fixed by which page you loaded.
//
// ── Labels ───────────────────────────────────────────────────────────────────
// Every MediaStream the guest publishes is announced with a label
// ({kind:"track", stream_id, label}) BEFORE the offer that carries it, so the
// receiving page knows which track is which by msid rather than by guessing.

import { announceTrack, peerOf, type HostPeer } from "./participants";

export type Session = { signaling_ticket: string; signaling_url: string; ice_servers: RTCIceServer[] };

type SignalPayload = {
  kind?: string;
  peer?: unknown;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type PeerState = {
  pc: RTCPeerConnection;
  makingOffer: boolean;
};

export interface HostLinkOptions {
  session: Session;
  /** Absolute ws(s) URL of the signaling socket. */
  wsUrl: string;
  /** Camera + mic (already trimmed to the grants). May be null: a
   *  participant with no media grant connects to receive only. */
  localStream: () => MediaStream | null;
  /** Whether to ask for the program return leg at all (media.return_feed).
   *  Without it the host page sends nothing back. */
  returnFeed: boolean;
  /** Phones ask for the return leg only once the connection has settled and
   *  the page is visible — decoding the program while acquiring the camera
   *  and joining the mesh is what crashed iOS WebKit at admit. */
  delayReturnFeedMs: number;
  onProgram: (stream: MediaStream | null) => void;
  onHostAudio: (stream: MediaStream | null) => void;
  /** Messages from the host over its data channel (stage, cue). */
  onData?: (msg: unknown) => void;
  onMainState: (state: RTCPeerConnectionState) => void;
  /** The share ended — by the guest, or by the browser's own stop button. */
  onShareEnded?: () => void;
}

export class HostLink {
  private readonly ws: WebSocket;
  private readonly peers = new Map<HostPeer, PeerState>();
  private screen: MediaStream | null = null;
  private programAsked = false;
  private closed = false;

  constructor(private readonly opts: HostLinkOptions) {
    this.ws = new WebSocket(opts.wsUrl);
    this.ws.onopen = () => {
      // Labels are announced BEFORE any offer that could carry the stream.
      this.announceLocal();
      // Every peer says hello; a host page already waiting learns to negotiate.
      for (const [name, peer] of this.peers) {
        this.send(name, { kind: "hello" });
        // Flush an offer created before the socket opened — send() drops while
        // CONNECTING, and losing it leaves both peers waiting on each other.
        if (peer.pc.localDescription) this.send(name, { kind: "sdp", description: peer.pc.localDescription });
      }
    };
    this.ws.onmessage = (event) => void this.onFrame(event);
    // The camera peer exists from the start, publishing whatever we hold.
    this.ensurePeer("main");
  }

  get sharing(): boolean {
    return !!this.screen;
  }

  mainConnectionState(): RTCPeerConnectionState | null {
    return this.peers.get("main")?.pc.connectionState ?? null;
  }

  // ── Publishing ─────────────────────────────────────────────────────────────

  /** Fresh camera/mic after a phone comes back from the background: swap the
   *  tracks into the existing senders — no renegotiation needed. */
  replaceLocalTracks(fresh: MediaStream): void {
    const main = this.peers.get("main");
    if (!main) return;
    for (const sn of main.pc.getSenders()) {
      const t = fresh.getTracks().find((tr) => tr.kind === sn.track?.kind);
      if (t && sn.track !== t) void sn.replaceTrack(t).catch(() => {});
    }
  }

  /** Share the screen: getDisplayMedia → a video track on the SCREEN peer.
   *  Resolves false when the user cancelled or the browser cannot capture
   *  (a Tauri webview, an old phone). Never throws into the UI. */
  async startShare(): Promise<boolean> {
    if (this.screen || this.closed) return !!this.screen;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      return false;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); return false; }
    // Text and UI, not a face: hold resolution, let framerate go.
    track.contentHint = "detail";
    this.screen = stream;
    // Announce first, then add — the announcement must precede the offer.
    this.announceLocal();
    const peer = this.ensurePeer("screen");
    peer.pc.addTrack(track, stream);
    try {
      const sender = peer.pc.getSenders().find((sn) => sn.track === track);
      if (sender) {
        const params = sender.getParameters();
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = "maintain-resolution";
        await sender.setParameters(params);
      }
    } catch { /* best effort */ }
    // The browser's own "Stop sharing" button ends the track under us.
    track.onended = () => { if (this.screen === stream) this.stopShare(); };
    return true;
  }

  stopShare(): void {
    const stream = this.screen;
    if (!stream) return;
    this.screen = null;
    const peer = this.peers.get("screen");
    if (peer) {
      for (const sn of peer.pc.getSenders()) {
        if (sn.track && stream.getTracks().includes(sn.track)) {
          try { peer.pc.removeTrack(sn); } catch { /* already gone */ }
        }
      }
    }
    stream.getTracks().forEach((t) => t.stop());
    this.send("screen", announceTrack(stream.id, "screen", true));
    this.opts.onShareEnded?.();
  }

  /** Tell every host page which stream is which. Idempotent; sent on open,
   *  on share start, and on every hello (a reconnecting host page has no
   *  memory of earlier announcements). */
  private announceLocal(): void {
    const cam = this.opts.localStream();
    if (cam) this.send("main", announceTrack(cam.id, "camera"));
    if (this.screen) this.send("screen", announceTrack(this.screen.id, "screen"));
  }

  // ── Peers ──────────────────────────────────────────────────────────────────

  private ensurePeer(name: HostPeer): PeerState {
    const existing = this.peers.get(name);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.opts.session.ice_servers });
    const peer: PeerState = { pc, makingOffer: false };
    this.peers.set(name, peer);

    if (name === "main") {
      const local = this.opts.localStream();
      local?.getTracks().forEach((t) => pc.addTrack(t, local));
      // Under constraint, drop resolution before framerate — a sharp
      // stuttering face is worse than a slightly softer smooth one. Best
      // effort: a rejection must not stop the guest joining.
      void (async () => {
        try {
          const sender = pc.getSenders().find((sn) => sn.track?.kind === "video");
          if (!sender) return;
          const params = sender.getParameters();
          (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = "maintain-framerate";
          await sender.setParameters(params);
        } catch { /* contentHint still biases the encoder */ }
      })();

      // Producer pushes stage changes and cue state to the render page
      // natively, and the render page forwards them down this channel — the
      // host IS the authority and reaches us directly.
      pc.ondatachannel = (ev) => {
        ev.channel.onmessage = (m) => {
          let msg: unknown;
          try { msg = JSON.parse(String(m.data)); } catch { return; }
          this.opts.onData?.(msg);
        };
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        if (event.track.kind === "video") {
          // The SHOW. Arrives only after WE asked for it (program-ready).
          this.opts.onProgram(stream);
        } else {
          // Host mic. Deliberately NOT the program mix — that would carry the
          // guest's own delayed voice straight back into their ears and mic.
          this.opts.onHostAudio(stream);
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") this.maybeAskProgram(pc);
        if (pc.connectionState === "failed") pc.restartIce();
        this.opts.onMainState(pc.connectionState);
      };
    } else if (this.screen) {
      const track = this.screen.getVideoTracks()[0];
      if (track) pc.addTrack(track, this.screen);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") pc.restartIce();
      };
    }

    pc.onicecandidate = (e) => { if (e.candidate) this.send(name, { kind: "ice", candidate: e.candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.send(name, { kind: "sdp", description: pc.localDescription });
      } catch {
        /* the reconnect path retries */
      } finally {
        peer.makingOffer = false;
      }
    };
    if (this.ws.readyState === WebSocket.OPEN) this.send(name, { kind: "hello" });
    return peer;
  }

  /** Ask for the program return leg once, when this end can afford to decode
   *  it and holds the grant for it. */
  private maybeAskProgram(pc: RTCPeerConnection): void {
    if (!this.opts.returnFeed || this.programAsked) return;
    const ask = () => {
      if (this.programAsked || this.closed) return;
      this.programAsked = true;
      this.send("main", { kind: "program-ready" });
    };
    if (this.opts.delayReturnFeedMs <= 0) { ask(); return; }
    window.setTimeout(() => {
      if (pc.connectionState === "connected" && document.visibilityState === "visible") ask();
    }, this.opts.delayReturnFeedMs);
  }

  // ── Signaling ──────────────────────────────────────────────────────────────

  private send(peer: HostPeer, payload: object): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "signal", payload: { ...payload, peer } }));
  }

  private async onFrame(event: MessageEvent): Promise<void> {
    let frame: { type?: string; payload?: SignalPayload };
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    if (frame.type !== "signal" || !frame.payload) return;
    const msg = frame.payload;
    const name = peerOf(msg);
    try {
      if (msg.kind === "hello") {
        // A host page arrived (or came back). The screen page is created on
        // demand — it exists only because Producer loaded one for us.
        if (name === "screen") this.ensurePeer("screen");
        this.announceLocal();
        return;
      }
      const peer = this.peers.get(name) ?? (name === "screen" ? this.ensurePeer("screen") : null);
      if (!peer) return;
      const pc = peer.pc;
      if (msg.kind === "sdp" && msg.description) {
        const collision = msg.description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        // POLITE peer: on a collision we roll back and take theirs.
        if (collision) await pc.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
        await pc.setRemoteDescription(msg.description);
        if (msg.description.type === "offer") {
          await pc.setLocalDescription();
          this.send(name, { kind: "sdp", description: pc.localDescription });
        }
      } else if (msg.kind === "ice" && msg.candidate) {
        await pc.addIceCandidate(msg.candidate).catch(() => {});
      }
    } catch { /* one bad frame must never kill the call */ }
  }

  close(): void {
    this.closed = true;
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
    try { this.ws.close(); } catch { /* already closed */ }
    for (const [, peer] of this.peers) {
      try { peer.pc.close(); } catch { /* already closed */ }
    }
    this.peers.clear();
  }
}

/** The signaling endpoint as an absolute ws(s) URL, derived from the page's
 *  own origin — the API hands us a path so the page never hardcodes it. */
export function signalingWsUrl(apiBase: string, session: Session): string {
  const api = new URL(apiBase, window.location.origin);
  const url = new URL(session.signaling_url, api.origin);
  url.protocol = api.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
