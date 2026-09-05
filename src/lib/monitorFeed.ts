/** The PROGRAM MONITOR — a seat sees the host's program on its stage.
 *
 * A mod / manager / viewer seat on a Boomin room runs no set of its own
 * (lib/participants.ts `localSetDecision`): the picture is the host's. The
 * host's program reaches every guest as the RETURN FEED over the guest's own
 * signaling channel, so a seat that wants to see it needs a participant row
 * of its own to receive on. `POST /v1/app/live/rooms/:id/monitor` mints one:
 * kind producer, grants = exactly `media.return_feed`, flagged `monitor:
 * true` on the roster so the host's reconcile never turns it into a guest
 * source (server/guest/src/participants.ts `wantedSourceIds`).
 *
 * Both halves of that leg live HERE, in Producer's own webview — no CEF
 * page, no engine item, nothing on the set:
 *
 *   ProgramMonitor  (the seat)  — the guest half of the call, receive-only:
 *                                 the same wire protocol as lib/guestSeat.ts
 *                                 without a camera. Polls its own status by
 *                                 invite code, mints a session, asks for the
 *                                 program (`program-ready`), renders it.
 *   MonitorSender   (the host)  — the host half, one per monitor row on the
 *                                 roster: the render page's return leg
 *                                 (server/guest/src/GuestRenderPage.tsx)
 *                                 without the page. Captures the Producer
 *                                 virtual camera at 640×360 / 15 fps and
 *                                 sends video only — never program audio
 *                                 (echo), never the host mic (a monitor has
 *                                 no one to talk to).
 *
 * Reconnects on their own, as the seat does. Leaving is explicit.
 */

import { connectApiBase, inviteCodeFromJoinUrl } from "./guestSeat";

type Session = { signaling_ticket: string; signaling_url: string; ice_servers: RTCIceServer[] };

type SignalFrame = {
  type?: string;
  payload?: { kind?: string; peer?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
};

const POLL_MS = 5000;
const RECONNECT_MS = 2000;

function signalingSocket(api: string, session: Session): WebSocket {
  const origin = new URL(api);
  const wsUrl = new URL(session.signaling_url, origin.origin);
  wsUrl.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(wsUrl.toString());
}

function parseFrame(data: unknown): SignalFrame["payload"] | null {
  let frame: SignalFrame;
  try {
    frame = JSON.parse(String(data));
  } catch {
    return null;
  }
  if (frame.type !== "signal" || !frame.payload) return null;
  return frame.payload;
}

// ── The seat: receive the program ────────────────────────────────────────────

export type MonitorPhase = "connecting" | "live" | "gone" | "error";

export interface MonitorState {
  phase: MonitorPhase;
  message: string;
  /** The program's first frame has arrived. */
  hasProgram: boolean;
}

export interface ProgramMonitorSpec {
  /** The join URL the monitor route answered; the invite code is its last
   * path segment — the seat's credential for the status poll and re-mints. */
  joinUrl: string;
  /** The endpoint's base URL (`<origin>/v1/...` or the origin). */
  apiBase: string;
  hostName?: string | null;
}

export class ProgramMonitor {
  readonly spec: ProgramMonitorSpec;
  private readonly api: string;
  private readonly code: string | null;
  private state: MonitorState = { phase: "connecting", message: "", hasProgram: false };
  private listeners = new Set<() => void>();
  private alive = true;
  private program: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private timer = 0;
  private generation = 0;

  constructor(spec: ProgramMonitorSpec) {
    this.spec = spec;
    this.api = connectApiBase(spec.apiBase);
    this.code = inviteCodeFromJoinUrl(spec.joinUrl);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  snapshot(): MonitorState {
    return this.state;
  }
  programStream(): MediaStream | null {
    return this.program;
  }
  private set(patch: Partial<MonitorState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  start(): void {
    if (!this.code) {
      this.set({ phase: "error", message: "The monitor link has no invite code." });
      return;
    }
    void this.run();
  }

  /** Leave: close the call. The server row is ended by the caller (DELETE
   * …/monitor) — this only drops the leg. */
  leave(): void {
    this.alive = false;
    this.generation += 1;
    window.clearTimeout(this.timer);
    this.teardownCall();
    this.listeners.clear();
  }

  private async run(): Promise<void> {
    const gen = ++this.generation;
    const mine = () => this.alive && gen === this.generation;
    this.set({ phase: "connecting", message: "" });
    let session: Session;
    try {
      const res = await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}/session`, { method: "POST" });
      if (res.status === 404 || res.status === 410) {
        // Ended, revoked, or the run closed: terminal until the seat re-mints.
        this.set({ phase: "gone", message: "The host's room closed this monitor.", hasProgram: false });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      session = (await res.json()) as Session;
    } catch {
      if (!mine()) return;
      this.set({ phase: "connecting", message: "Waiting for the host…" });
      this.timer = window.setTimeout(() => void this.run(), RECONNECT_MS);
      return;
    }
    if (!mine()) return;

    const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
    this.pc = pc;
    // Receive-only: a monitor supplies nothing. The transceiver gives the
    // host's first offer something to answer to before the program attaches.
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      if (event.track.kind !== "video") return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.program = stream;
      // The host's first offer carries an EMPTY sendonly transceiver (the
      // program attaches on demand); its track arrives muted. "Has program"
      // means frames, so it follows the track's mute state, not its arrival.
      const track = event.track;
      const sync = () => {
        if (this.program === stream) this.set({ hasProgram: !track.muted && track.readyState === "live" });
      };
      track.onunmute = sync;
      track.onmute = sync;
      track.onended = () => {
        if (this.program === stream) {
          this.program = null;
          this.set({ hasProgram: false });
        }
      };
      sync();
    };

    const ws = signalingSocket(this.api, session);
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
        downSince = downSince || Date.now();
        this.set({ phase: "connecting", message: "Reconnecting…" });
        window.setTimeout(() => {
          if (mine() && pc.connectionState === "disconnected" && downSince && Date.now() - downSince > 8000) this.reconnect(gen);
        }, 8500);
      }
    };

    ws.onopen = () => {
      send({ kind: "hello" });
      // The program attaches ON DEMAND on the host (GuestRenderPage: the
      // guest says when it can afford to decode it). A desktop seat can
      // always afford it: ask at once.
      send({ kind: "program-ready" });
      if (pc.localDescription) send({ kind: "sdp", description: pc.localDescription });
    };
    ws.onmessage = async (event) => {
      const msg = parseFrame(event.data);
      if (!msg) return;
      try {
        if (msg.kind === "sdp" && msg.description) {
          const collision = msg.description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
          // POLITE peer (as the seat is): on a collision roll back, take theirs.
          if (collision) await pc.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
          await pc.setRemoteDescription(msg.description);
          if (msg.description.type === "offer") {
            await pc.setLocalDescription();
            send({ kind: "sdp", description: pc.localDescription });
          }
        } else if (msg.kind === "ice" && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        } else if (msg.kind === "hello") {
          // The host (re)arrived: ask for the program again — a fresh host
          // peer holds no memory of the last request.
          send({ kind: "program-ready" });
        }
      } catch {
        /* never let one frame kill the call */
      }
    };
    ws.onclose = () => {
      if (mine()) this.timer = window.setTimeout(() => this.reconnect(gen), RECONNECT_MS);
    };
    ws.onerror = () => {
      /* onclose follows */
    };

    // Keep watching our own status: a revoke (seat lost, run ended) shows
    // up here as 404/410 and ends the leg for good.
    const watch = async () => {
      while (mine()) {
        await this.sleep(POLL_MS);
        if (!mine()) return;
        try {
          const res = await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}`);
          if (res.status === 404 || res.status === 410) {
            this.teardownCall();
            this.set({ phase: "gone", message: "The host's room closed this monitor.", hasProgram: false });
            return;
          }
        } catch {
          /* a blip; the socket's own close handles a real outage */
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
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => {
      this.timer = window.setTimeout(r, ms);
    });
  }
}

// ── The host: send the program to one monitor ────────────────────────────────

/** `<webBase>/connect/guest/render/<id>?k=<key>` → the render session's
 *  address. The key is the host's credential for the HOST side of the
 *  channel (`/guest/render/:id/session?k=`). */
export function renderSessionFromUrl(renderUrl: string): { id: string; key: string } | null {
  try {
    const u = new URL(renderUrl);
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const id = parts[parts.length - 1];
    const key = u.searchParams.get("k") ?? "";
    return id && key ? { id, key } : null;
  } catch {
    return null;
  }
}

/** Find the Producer virtual camera among the video inputs. Matched by
 *  LABEL, by prefix: deviceIds are salted per origin and a label can gain a
 *  suffix when macOS disambiguates duplicates. */
export function pickProgramDevice(devices: readonly MediaDeviceInfo[], label?: string | null): MediaDeviceInfo | null {
  const want = (label || "Producer Virtual Camera").toLowerCase();
  return (
    devices.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes(want)) ??
    devices.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes("producer") && d.label.toLowerCase().includes("virtual camera")) ??
    null
  );
}

export interface MonitorSenderSpec {
  /** The monitor row's `render_url` from the roster. */
  renderUrl: string;
  apiBase: string;
  /** The virtual camera's device label (platform-specific). */
  programLabel?: string | null;
}

export class MonitorSender {
  readonly spec: MonitorSenderSpec;
  private readonly api: string;
  private readonly target: { id: string; key: string } | null;
  private alive = true;
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private program: MediaStream | null = null;
  private attached = false;
  private timer = 0;
  private generation = 0;
  private attempt = 0;

  constructor(spec: MonitorSenderSpec) {
    this.spec = spec;
    this.api = connectApiBase(spec.apiBase);
    this.target = renderSessionFromUrl(spec.renderUrl);
  }

  start(): void {
    if (!this.target) return;
    void this.connect();
  }

  stop(): void {
    this.alive = false;
    this.generation += 1;
    window.clearTimeout(this.timer);
    this.teardown();
  }

  private teardown() {
    try {
      this.ws?.close();
    } catch {
      /* closed */
    }
    try {
      this.pc?.close();
    } catch {
      /* closed */
    }
    this.ws = null;
    this.pc = null;
    this.program?.getTracks().forEach((t) => t.stop());
    this.program = null;
    this.attached = false;
  }

  private retry(gen: number) {
    if (!this.alive || gen !== this.generation) return;
    this.teardown();
    const delay = Math.min(15000, RECONNECT_MS * 2 ** Math.min(this.attempt++, 3));
    this.timer = window.setTimeout(() => void this.connect(), delay);
  }

  /** The program leg: capture the virtual camera, small on purpose (a
   *  monitor needs to see what is on air and stay in sync, not broadcast
   *  quality), and add it — onnegotiationneeded carries it across. */
  private async attachProgram(pc: RTCPeerConnection, gen: number) {
    if (this.attached) return;
    this.attached = true;
    try {
      // Any camera grant first, or labels are unreadable.
      const devices = await navigator.mediaDevices.enumerateDevices();
      let cam = pickProgramDevice(devices, this.spec.programLabel);
      if (!cam || !cam.label) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
        probe?.getTracks().forEach((t) => t.stop());
        cam = pickProgramDevice(await navigator.mediaDevices.enumerateDevices(), this.spec.programLabel);
      }
      if (!cam || gen !== this.generation) {
        this.attached = false;
        return;
      }
      const prog = await navigator.mediaDevices
        .getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: 640, height: 360, frameRate: 15 }, audio: false })
        .catch(() => null);
      if (!prog || gen !== this.generation || this.pc !== pc) {
        prog?.getTracks().forEach((t) => t.stop());
        this.attached = false;
        return;
      }
      this.program = prog;
      prog.getVideoTracks().forEach((t) => pc.addTrack(t, prog));
    } catch {
      // No program is degraded, not broken; the next hello asks again.
      this.attached = false;
    }
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    if (!this.alive || !this.target) return;
    let session: Session;
    try {
      const res = await fetch(`${this.api}/guest/render/${this.target.id}/session?k=${encodeURIComponent(this.target.key)}`, { method: "POST" });
      // 410: ended / revoked — the roster tick drops this sender for good.
      if (res.status === 410 || res.status === 404) return;
      if (!res.ok) throw new Error(String(res.status));
      session = (await res.json()) as Session;
    } catch {
      this.retry(gen);
      return;
    }
    if (gen !== this.generation) return;

    const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
    this.pc = pc;
    const ws = signalingSocket(this.api, session);
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
        /* the next negotiation retries */
      } finally {
        makingOffer = false;
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") pc.restartIce();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.retry(gen);
    };
    ws.onopen = () => {
      this.attempt = 0;
      send({ kind: "hello" });
      if (pc.localDescription) send({ kind: "sdp", description: pc.localDescription });
    };
    ws.onclose = () => this.retry(gen);
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onmessage = async (event) => {
      const msg = parseFrame(event.data);
      if (!msg || gen !== this.generation) return;
      try {
        if (msg.kind === "hello") {
          // The seat arrived. Kick negotiation the way the render page does.
          if (pc.getTransceivers().length === 0) pc.addTransceiver("video", { direction: "sendonly" });
          else await pc.setLocalDescription().then(() => send({ kind: "sdp", description: pc.localDescription }));
          return;
        }
        if (msg.kind === "program-ready") {
          void this.attachProgram(pc, gen);
          return;
        }
        if (msg.kind === "sdp" && msg.description) {
          const collision = msg.description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
          // IMPOLITE peer (as the render page is): keep our own offer.
          if (collision) return;
          await pc.setRemoteDescription(msg.description);
          if (msg.description.type === "offer") {
            await pc.setLocalDescription();
            send({ kind: "sdp", description: pc.localDescription });
          }
          return;
        }
        if (msg.kind === "ice" && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
      } catch {
        /* a malformed frame must never take the leg down */
      }
    };
    // Something to negotiate over before the program attaches.
    pc.addTransceiver("video", { direction: "sendonly" });
  }
}
