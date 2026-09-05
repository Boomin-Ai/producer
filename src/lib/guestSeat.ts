/** A guest SEAT, native to Producer.
 *
 * When this Producer is the GUEST — a beneficiary entering a deal's show, or
 * a brand knocking on an open Network stage — the seat is the guest half of
 * the call, run from Producer's own webview: the same wire protocol as the
 * guest page (server/guest/src/GuestJoinPage.tsx), without the page. Status
 * is polled by invite code, a session is minted once the host admits, media
 * goes peer-to-peer to the host's machine, and the host's return (program
 * video + voice) comes back the same way.
 *
 * The camera is Producer itself: with the virtual camera running the seat
 * opens the "Producer Virtual Camera" device, so the guest's own scene —
 * whatever is on their stage — is what the host receives. No driver, or no
 * engine, and a real webcam is used instead.
 *
 * Reconnects on its own. The host closing and reopening the room, a dropped
 * socket, an ICE failure: the seat re-polls its status, re-mints a session
 * and renegotiates, for as long as the seat exists. Leaving is explicit.
 */

export type SeatPhase =
  /** Producer knocked; the invite row exists, we are opening the camera. */
  | "starting"
  /** In the host's waiting room — the host has to admit us. */
  | "waiting"
  /** Admitted; minting a session and negotiating the peer connection. */
  | "connecting"
  /** Media flows to the host. On air whenever the host puts us on stage. */
  | "live"
  /** Revoked, declined, ended, or the host never answered. Terminal. */
  | "gone"
  | "error";

export interface GuestSeatSpec {
  /** The guest join URL exactly as the endpoint minted it; the invite code
   * is its last path segment. Never rewritten. */
  joinUrl: string;
  /** The endpoint's base URL — the API the invite code is a credential for
   * (`<origin>/v1/connect/...`). A self-hosted server is its own API. */
  apiBase: string;
  hostName: string;
  title: string;
  /** Rust started the virtual camera: prefer it as the seat's camera. */
  producerCam: boolean;
  /** The virtual camera's device label, per platform. */
  camLabel?: string | null;
  endpointId: string;
  dealId?: string;
  networkRoomId?: string;
}

export interface SeatState {
  phase: SeatPhase;
  message: string;
  muted: boolean;
  cameraOff: boolean;
  /** The host's program return has arrived (at least one video frame). */
  hasProgram: boolean;
  /** The seat's camera is the Producer virtual camera. */
  producerCam: boolean;
  /** Raw status word from the server (`waiting`, `accepted`, …). */
  guestStatus: string | null;
}

type Session = { signaling_ticket: string; signaling_url: string; ice_servers: RTCIceServer[] };
type Guest = { id: string; display_name: string; status: string };

/** `/connect/guest/<code>` → code. Tolerant of a trailing slash or query. */
export function inviteCodeFromJoinUrl(joinUrl: string): string | null {
  try {
    const u = new URL(joinUrl);
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const code = parts[parts.length - 1];
    return code ? decodeURIComponent(code) : null;
  } catch {
    return null;
  }
}

/** `<base>` (with or without a `/v1/...` tail) → `<origin>/v1/connect`. */
export function connectApiBase(apiBase: string): string {
  const i = apiBase.indexOf("/v1/");
  const origin = (i >= 0 ? apiBase.slice(0, i) : apiBase).replace(/\/+$/, "");
  return `${origin}/v1/connect`;
}

const POLL_MS = 2500;
const RECONNECT_MS = 2000;

export class GuestSeat {
  readonly spec: GuestSeatSpec;
  private readonly api: string;
  private readonly code: string | null;
  private state: SeatState;
  private listeners = new Set<() => void>();
  private alive = true;
  private local: MediaStream | null = null;
  private program: MediaStream | null = null;
  private hostAudio: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private timer = 0;
  private generation = 0;

  constructor(spec: GuestSeatSpec) {
    this.spec = spec;
    this.api = connectApiBase(spec.apiBase);
    this.code = inviteCodeFromJoinUrl(spec.joinUrl);
    this.state = {
      phase: "starting",
      message: "",
      muted: false,
      cameraOff: false,
      hasProgram: false,
      producerCam: false,
      guestStatus: null,
    };
  }

  // ── Observation ────────────────────────────────────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  snapshot(): SeatState {
    return this.state;
  }
  localStream(): MediaStream | null {
    return this.local;
  }
  programStream(): MediaStream | null {
    return this.program;
  }
  hostAudioStream(): MediaStream | null {
    return this.hostAudio;
  }
  private set(patch: Partial<SeatState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (!this.code) {
      this.set({ phase: "error", message: "The join link has no invite code." });
      return;
    }
    try {
      await this.openCamera();
    } catch {
      this.set({ phase: "error", message: "Producer needs camera and microphone access to put you on the show." });
      return;
    }
    void this.run();
  }

  /** Leave the seat: stop media, close the call. The server row is left to
   * the host (the deal's delivery is theirs to settle). */
  leave(): void {
    this.alive = false;
    this.generation += 1;
    window.clearTimeout(this.timer);
    this.teardownCall();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.listeners.clear();
  }

  toggleMute(): void {
    const t = this.local?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    this.set({ muted: !t.enabled });
  }
  toggleCamera(): void {
    const t = this.local?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    this.set({ cameraOff: !t.enabled });
  }

  // ── Camera ─────────────────────────────────────────────────────────────
  private async openCamera(): Promise<void> {
    // Any camera first: labels are only readable after one grant.
    let stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (this.spec.producerCam) {
      const want = (this.spec.camLabel || "Producer Virtual Camera").toLowerCase();
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      const vcam = devices.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes(want));
      const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (vcam && vcam.deviceId !== current) {
        try {
          const swapped = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: vcam.deviceId } },
            audio: true,
          });
          stream.getTracks().forEach((t) => t.stop());
          stream = swapped;
          this.set({ producerCam: true });
        } catch {
          // The virtual camera refused (not yet approved, no frames): the
          // real webcam stays. Honest, not silent — producerCam stays false.
        }
      } else if (vcam) {
        this.set({ producerCam: true });
      }
    }
    if (!this.alive) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.local = stream;
  }

  // ── The call ───────────────────────────────────────────────────────────
  private async run(): Promise<void> {
    const gen = ++this.generation;
    const mine = () => this.alive && gen === this.generation;
    // Hold in the waiting room until the host admits. The invite code is
    // the credential, so no session is needed to ask. One failed request is
    // an offline blip, not a denial. No deadline: a native seat is a place
    // you can stay in.
    for (;;) {
      if (!mine()) return;
      const status = await this.pollStatus();
      if (!mine()) return;
      if (status === "accepted") break;
      if (status === "gone") return;
      if (status === "invited") await this.acceptQuietly();
      else if (status === "waiting") this.set({ phase: "waiting", message: "" });
      await this.sleep(POLL_MS);
    }
    this.set({ phase: "connecting", message: "" });
    let session: Session;
    try {
      const res = await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}/session`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      session = (await res.json()) as Session;
    } catch {
      if (!mine()) return;
      this.set({ phase: "waiting", message: "Could not join yet — retrying." });
      this.timer = window.setTimeout(() => void this.run(), RECONNECT_MS);
      return;
    }
    if (!mine() || !this.local) return;

    const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
    this.pc = pc;
    this.local.getTracks().forEach((t) => pc.addTrack(t, this.local!));
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      if (event.track.kind === "video") {
        this.program = stream;
        this.set({ hasProgram: true });
      } else {
        this.hostAudio = stream;
        this.set({});
      }
    };

    const api = new URL(this.api);
    const wsUrl = new URL(session.signaling_url, api.origin);
    wsUrl.protocol = api.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl.toString());
    this.ws = ws;
    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", payload }));
    };

    let makingOffer = false;
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        send({ kind: "sdp", description: pc.localDescription });
      } catch {
        /* retried on reconnect */
      } finally {
        makingOffer = false;
      }
    };
    let downSince = 0;
    pc.onconnectionstatechange = () => {
      if (!mine()) return;
      const st = pc.connectionState;
      if (st === "connected") {
        downSince = 0;
        this.set({ phase: "live", message: "" });
      } else if (st === "failed") {
        pc.restartIce();
        this.set({ phase: "connecting", message: "Reconnecting…" });
      } else if (st === "disconnected") {
        // A brief blip heals by itself; a long one gets a fresh session.
        downSince = downSince || Date.now();
        this.set({ phase: "connecting", message: "Reconnecting…" });
        window.setTimeout(() => {
          if (mine() && pc.connectionState === "disconnected" && downSince && Date.now() - downSince > 8000) {
            this.reconnect(gen);
          }
        }, 8500);
      }
    };

    ws.onopen = () => send({ kind: "hello" });
    ws.onmessage = async (event) => {
      let frame: {
        type?: string;
        payload?: { kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
      };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type !== "signal" || !frame.payload) return;
      const msg = frame.payload;
      try {
        if (msg.kind === "sdp" && msg.description) {
          const collision = msg.description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
          // POLITE peer: on a collision we roll back and accept theirs.
          if (collision) await pc.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
          await pc.setRemoteDescription(msg.description);
          if (msg.description.type === "offer") {
            await pc.setLocalDescription();
            send({ kind: "sdp", description: pc.localDescription });
          }
        } else if (msg.kind === "ice" && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        }
      } catch {
        /* never let one frame kill the call */
      }
    };
    // The socket is the host's side of the introduction; losing it (host
    // reopened, server hiccup) means a fresh session. The media path may
    // well survive in between — the reconnect only replaces what is gone.
    ws.onclose = () => {
      if (mine()) this.timer = window.setTimeout(() => this.reconnect(gen), RECONNECT_MS);
    };
    ws.onerror = () => {
      /* onclose follows */
    };

    // Keep watching our own status while live: a revoke shows up here.
    const watch = async () => {
      while (mine()) {
        await this.sleep(5000);
        if (!mine()) return;
        const status = await this.pollStatus();
        if (status === "gone") {
          this.teardownCall();
          return;
        }
      }
    };
    void watch();
  }

  private reconnect(gen: number) {
    if (!this.alive || gen !== this.generation) return;
    this.teardownCall();
    this.set({ phase: "connecting", message: "Reconnecting…", hasProgram: false });
    void this.run();
  }

  private teardownCall() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.pc = null;
    this.program = null;
    this.hostAudio = null;
  }

  /** "accepted" | "waiting" | "invited" | "gone" | "blip" — the server's
   * word for us, with terminal states folded to gone (and announced). */
  private async pollStatus(): Promise<string> {
    try {
      const res = await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}`);
      if (res.status === 404 || res.status === 410) {
        this.set({ phase: "gone", message: `${this.spec.hostName} ended your seat.` , guestStatus: null });
        return "gone";
      }
      if (!res.ok) return "blip";
      const body = (await res.json()) as { guest: Guest };
      const status = body.guest.status;
      this.set({ guestStatus: status });
      if (status === "accepted" || status === "waiting" || status === "invited") return status;
      this.set({ phase: "gone", message: `${this.spec.hostName} didn't let you in this time.` });
      return "gone";
    } catch {
      return "blip";
    }
  }

  /** Only an `invited` row has anything to accept; 409 = already past it. */
  private async acceptQuietly(): Promise<void> {
    try {
      await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}/accept`, { method: "POST" });
    } catch {
      /* the status poll retries */
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => {
      this.timer = window.setTimeout(r, ms);
    });
  }
}
