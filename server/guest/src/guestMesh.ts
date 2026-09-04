// Guest↔guest mesh, with receiver-side enforcement of the stage list.
//
// ── The rule ─────────────────────────────────────────────────────────────────
//   Everyone hears the host plus every ON-STAGE guest; only on-stage guests are
//   heard. Nobody ever receives a mix containing themselves.
//
// ── Why enforcement lives HERE and not on the server ─────────────────────────
// Once two peers hold a direct connection the server is out of the media path.
// No amount of authority over signalling stops a client calling addTrack. So the
// server is AUTHORITATIVE about who is on stage, and RECEIVERS enforce it: a
// transceiver aimed at a docked peer is set `inactive`, which is negotiated at
// SDP level rather than being a "please don't play it" convention.
//
// That kills the failure that actually matters — a BUG where a docked guest
// keeps sending and everyone hears someone the host believes is silent — because
// it does not depend on the sender behaving. The malicious case needs a modified
// sender AND a modified receiver, and two people who both patched this client
// could simply use any other app.
//
// ── Fail closed ──────────────────────────────────────────────────────────────
// On any ambiguity — unknown peer, stale version, missing stage list — we do NOT
// play. Silence is recoverable and someone says "you're muted". Unexpected audio
// on air is not.

export type StageUpdate = { on_stage: string[]; version: number };

type Peer = {
  pc: RTCPeerConnection;
  audio: RTCRtpTransceiver | null;
  stream: MediaStream;
  makingOffer: boolean;
};

export type MeshOptions = {
  selfId: string;
  iceServers: RTCIceServer[];
  /** Our own microphone, published ONLY while we are on stage. */
  localStream: () => MediaStream | null;
  send: (to: string, payload: unknown) => void;
  /** Called when a peer's audio should start or stop being audible. */
  onPeerAudio: (peerId: string, stream: MediaStream | null) => void;
};

export class GuestMesh {
  private peers = new Map<string, Peer>();
  private onStage = new Set<string>();
  private version = -1;
  private selfOnStage = false;
  /** Has the HOST confirmed this stage list, or is it only the server's cached
   *  copy? See applyStage — we may listen on an unconfirmed list, never speak. */
  private confirmed = false;

  constructor(private readonly opts: MeshOptions) {}

  /** Apply a stage update. Ignores anything not strictly newer, which is what
   *  makes concurrent promote/demote deterministic rather than a race. */
  applyStage(update: StageUpdate, source: "host" | "server" = "host"): void {
    if (!update || typeof update.version !== "number") return;
    if (update.version <= this.version) return;
    this.version = update.version;
    // The server copy is a CACHE that Producer writes fire-and-forget; the host
    // channel is live truth. Only the latter confirms.
    if (source === "host") this.confirmed = true;
    this.onStage = new Set(Array.isArray(update.on_stage) ? update.on_stage : []);
    this.selfOnStage = this.onStage.has(this.opts.selfId);

    // Connect to on-stage peers we don't have yet.
    for (const id of this.onStage) {
      if (id !== this.opts.selfId && !this.peers.has(id)) this.connect(id);
    }
    // Re-aim every existing peer against the new list.
    for (const [id, peer] of this.peers) this.applyDirection(id, peer);
  }

  /** THE enforcement point. Direction is derived from the SERVER's stage list,
   *  never from what a peer claims about itself. */
  private applyDirection(peerId: string, peer: Peer): void {
    if (!peer.audio) return;
    const theyAreOnStage = this.onStage.has(peerId);
    // MAY LISTEN ON AN UNCONFIRMED LIST, MAY NOT SPEAK ON ONE.
    //
    // The cold-start list comes from the server's cached copy, which Producer
    // writes fire-and-forget and can therefore be stale. Stale-too-SMALL is
    // merely degraded — you mesh with fewer people and correct on the next push.
    // Stale-too-LARGE is the dangerous direction, and the worst case is two
    // guests BOTH cold-starting on the same stale list, both believing they are
    // on stage, and publishing to each other. Neither is on air, so it never
    // reaches the broadcast — but it is exactly the green-room privacy the host
    // believes they have.
    //
    // So publishing additionally requires the HOST to have confirmed the list on
    // the live channel. Listening does not: hearing someone who has just left the
    // stage for a moment is recoverable, being heard when you believe you are
    // private is not.
    const mayPublish = this.selfOnStage && this.confirmed;
    const direction: RTCRtpTransceiverDirection = mayPublish
      ? (theyAreOnStage ? "sendrecv" : "sendonly")
      : (theyAreOnStage ? "recvonly" : "inactive");

    if (peer.audio.direction !== direction) peer.audio.direction = direction;

    // Belt and braces: even if a track arrives from a docked peer, it is never
    // made audible. Direction should have prevented it; this makes sure a
    // renegotiation race cannot put someone on air for a few hundred ms.
    this.opts.onPeerAudio(peerId, theyAreOnStage ? peer.stream : null);

    // Publishing is a consequence of OUR stage state, and we stop sending the
    // moment we are demoted rather than waiting for peers to stop receiving.
    const sender = peer.pc.getSenders().find((s) => s.track?.kind === "audio");
    if (sender?.track) sender.track.enabled = mayPublish;
  }

  private connect(peerId: string): void {
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers });
    const stream = new MediaStream();
    const peer: Peer = { pc, audio: null, stream, makingOffer: false };
    this.peers.set(peerId, peer);

    // Audio only. Guests see each other through the host's program feed, so a
    // mesh of video would multiply uplink for something already on screen.
    const local = this.opts.localStream();
    const track = local?.getAudioTracks()[0];
    peer.audio = pc.addTransceiver(track ?? "audio", { direction: "inactive" });

    pc.ontrack = (event) => {
      event.streams[0]?.getAudioTracks().forEach((t) => stream.addTrack(t));
      // Re-evaluate rather than playing on arrival: a track showing up does not
      // by itself mean its owner is allowed to be heard.
      this.applyDirection(peerId, peer);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.opts.send(peerId, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.opts.send(peerId, { kind: "sdp", description: pc.localDescription });
      } catch {
        /* the next stage update re-drives this */
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
    };

    this.applyDirection(peerId, peer);
  }

  /** Perfect negotiation with roles fixed by id comparison, so two guests never
   *  both act polite (deadlock) or both act impolite (glare). */
  async onSignal(from: string, msg: { kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): Promise<void> {
    // Only ever mesh with peers the SERVER says are on stage. An offer from a
    // docked guest is dropped rather than answered.
    if (!this.onStage.has(from)) return;
    if (!this.peers.has(from)) this.connect(from);
    const peer = this.peers.get(from);
    if (!peer) return;
    const polite = this.opts.selfId > from;

    try {
      if (msg.kind === "sdp" && msg.description) {
        const collision = msg.description.type === "offer" && (peer.makingOffer || peer.pc.signalingState !== "stable");
        if (collision && !polite) return;
        if (collision) await peer.pc.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
        await peer.pc.setRemoteDescription(msg.description);
        if (msg.description.type === "offer") {
          await peer.pc.setLocalDescription();
          this.opts.send(from, { kind: "sdp", description: peer.pc.localDescription });
        }
        this.applyDirection(from, peer);
      } else if (msg.kind === "ice" && msg.candidate) {
        await peer.pc.addIceCandidate(msg.candidate).catch(() => {});
      }
    } catch {
      /* one bad frame must never take the mesh down */
    }
  }

  /** Go silent WITHOUT losing our place in the version sequence.
   *
   *  Used when the host connection drops: guests must stop believing they are on
   *  air, but the mesh has to be able to come BACK when the host returns.
   *
   *  Deliberately does NOT fake a version. Clearing via a synthetic high version
   *  would mean no genuine update could ever exceed it and the mesh would stay
   *  empty forever — a silent permanent failure that looks exactly like "guests
   *  can't hear each other". The version is left untouched, so the host's next
   *  real push applies normally. */
  suspend(): void {
    this.onStage.clear();
    this.selfOnStage = false;
    // The host is gone, so nothing it previously said is still confirmed. A
    // reconnect must be re-confirmed before this guest speaks again.
    this.confirmed = false;
    for (const [id, peer] of this.peers) this.applyDirection(id, peer);
  }

  close(): void {
    for (const [id, peer] of this.peers) {
      try { peer.pc.close(); } catch { /* already closed */ }
      this.opts.onPeerAudio(id, null);
    }
    this.peers.clear();
  }
}
