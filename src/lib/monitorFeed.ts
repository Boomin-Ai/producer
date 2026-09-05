/** The PROGRAM MONITOR — a seat sees the host's output on its stage.
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
 * TWO PICTURES, so the monitor can never go black (v0.4.30):
 *
 *   1. The video leg — the virtual camera captured as a device. It exists
 *      only while the virtual camera RUNS; the host's Producer starts it the
 *      moment a monitor row appears (Live.tsx) and the sender keeps looking
 *      for the device until it does.
 *   2. The thumb leg — the host's PROGRAM THUMB (the engine's `program`
 *      target, 512×288 JPEG at 8 fps) over a DATA CHANNEL on the same peer
 *      connection. The seat asks for it (`thumb-on`) after 5 s without a
 *      decoded video frame and drops it (`thumb-off`) the moment frames
 *      flow. A data channel crosses machines; the host's loopback bridge
 *      does not.
 *
 * The same data channel carries ROOM INFO the room owns and every seat may
 * read — today the host's chat handles (`chat_channels`), which the seat's
 * read-only chat ingest needs and cannot otherwise learn on Boomin (the
 * room config schema there is strict).
 *
 * Every stage of both halves logs under `[monitor]` to the debug log
 * (lib/ipc.ts `uiLog` → producer-ui.log), so a two-machine test is
 * diagnosable after the fact. Reconnects on their own, as the seat does.
 * Leaving is explicit.
 */

import { connectApiBase, inviteCodeFromJoinUrl } from "./guestSeat";
import { uiLog } from "./ipc";

type Session = { signaling_ticket: string; signaling_url: string; ice_servers: RTCIceServer[] };

type SignalFrame = {
  type?: string;
  payload?: { kind?: string; peer?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
};

const POLL_MS = 5000;
const RECONNECT_MS = 2000;
/** No decoded video frame for this long after the call connects → thumbs. */
export const VIDEO_STALL_MS = 5000;
/** A thumb older than this is not a picture any more. */
export const THUMB_STALE_MS = 4000;
/** How long the host keeps looking for the virtual camera device. */
const PROGRAM_RETRY_MS = 2000;
const PROGRAM_RETRY_MAX = 90;
/** The thumb leg's ceiling — the engine produces at 8; never send faster. */
const THUMB_MIN_INTERVAL_MS = 110;
const DATA_CHANNEL = "monitor";

export function monitorLog(msg: string): void {
  const line = `[monitor] ${msg}`;
  // eslint-disable-next-line no-console
  console.info(line);
  uiLog(line);
}

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

// ── What rides the data channel ──────────────────────────────────────────────

/** Chat channels the ROOM reads: public handles, never credentials. */
export interface RoomChatChannels {
  twitch?: string;
  kick?: string;
  youtube?: string;
}

/** Room-owned facts the host publishes to every monitor seat. */
export interface MonitorRoomInfo {
  chat_channels?: RoomChatChannels;
}

/** What the host's program capture is doing — the seat shows the cause. */
export type ProgramCaptureState = "searching" | "no-device" | "denied" | "capturing";

type DataMsg =
  | { kind: "thumb-on" }
  | { kind: "thumb-off" }
  | { kind: "room-info"; info: MonitorRoomInfo }
  | { kind: "program-state"; state: ProgramCaptureState; detail?: string };

function parseData(raw: unknown): DataMsg | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as { kind?: unknown };
    if (!v || typeof v !== "object" || typeof v.kind !== "string") return null;
    return v as DataMsg;
  } catch {
    return null;
  }
}

/** The seat's placeholder line: one sentence naming the real cause when the
 *  host said what it is. Pure, so the copy is testable. */
export function monitorPlaceholder(input: {
  phase: MonitorPhase;
  message: string;
  connected: boolean;
  programState: ProgramCaptureState | null;
  stalled: boolean;
}): string {
  if (input.phase === "gone") return input.message || "The host's room closed this monitor.";
  if (input.phase === "error") return input.message;
  if (!input.connected) return input.message || "Host's output — connecting…";
  if (!input.stalled) return "Host's output — waiting for the first frame…";
  switch (input.programState) {
    case "no-device":
      return "Host's output — no frames yet (the host's virtual camera isn't running)";
    case "denied":
      return "Host's output — no frames yet (host's camera permission?)";
    case "searching":
      return "Host's output — no frames yet (the host is starting its camera…)";
    case "capturing":
      return "Host's output — no frames yet (the host is sending; nothing decoded here yet)";
    default:
      return "Host's output — no frames yet (host's camera permission?)";
  }
}

// ── The seat: receive the program ────────────────────────────────────────────

export type MonitorPhase = "connecting" | "live" | "gone" | "error";

export interface MonitorState {
  phase: MonitorPhase;
  message: string;
  /** The program's video track is live and unmuted. */
  hasProgram: boolean;
  /** A decoded video frame reached the element (rVFC) recently. */
  hasFrames: boolean;
  /** The thumb leg is on and a fresh thumb is showing. */
  onThumbs: boolean;
  /** The current thumb as an object URL, when on thumbs. */
  thumbUrl: string | null;
  /** What the host said its capture is doing. */
  programState: ProgramCaptureState | null;
  /** Room-owned info the host published (chat handles). */
  roomInfo: MonitorRoomInfo | null;
  /** The call is up and no frame has decoded for VIDEO_STALL_MS. */
  stalled: boolean;
}

export interface ProgramMonitorSpec {
  /** The join URL the monitor route answered; the invite code is its last
   * path segment — the seat's credential for the status poll and re-mints. */
  joinUrl: string;
  /** The endpoint's base URL (`<origin>/v1/...` or the origin). */
  apiBase: string;
  hostName?: string | null;
}

const INITIAL: MonitorState = {
  phase: "connecting",
  message: "",
  hasProgram: false,
  hasFrames: false,
  onThumbs: false,
  thumbUrl: null,
  programState: null,
  roomInfo: null,
  stalled: false,
};

export class ProgramMonitor {
  readonly spec: ProgramMonitorSpec;
  private readonly api: string;
  private readonly code: string | null;
  private state: MonitorState = INITIAL;
  private listeners = new Set<() => void>();
  private alive = true;
  private program: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private dc: RTCDataChannel | null = null;
  private timer = 0;
  private generation = 0;
  /** Frame accounting for the fallback: when the call connected, when the
   * last decoded frame landed (the stage reports via `noteFrame`). */
  private connectedAt = 0;
  private lastFrameAt = 0;
  private lastThumbAt = 0;
  private watchdog = 0;
  private thumbsAsked = false;
  private thumbUrl: string | null = null;

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

  /** The stage decoded a frame (requestVideoFrameCallback). */
  noteFrame(): void {
    this.lastFrameAt = Date.now();
    if (!this.state.hasFrames) {
      monitorLog("seat: first decoded video frame");
      this.set({ hasFrames: true, stalled: false });
    }
    if (this.thumbsAsked) this.askThumbs(false);
  }

  start(): void {
    if (!this.code) {
      this.set({ phase: "error", message: "The monitor link has no invite code." });
      monitorLog("seat: no invite code in the monitor join URL");
      return;
    }
    monitorLog(`seat: start api=${this.api}`);
    void this.run();
    this.watchdog = window.setInterval(() => this.tick(), 1000);
  }

  /** Leave: close the call. The server row is ended by the caller (DELETE
   * …/monitor) — this only drops the leg. */
  leave(): void {
    monitorLog("seat: leave");
    this.alive = false;
    this.generation += 1;
    window.clearTimeout(this.timer);
    window.clearInterval(this.watchdog);
    this.teardownCall();
    this.dropThumb();
    this.listeners.clear();
  }

  /** The fallback clock: a connected call with no decoded frame for
   * VIDEO_STALL_MS asks the host for thumbs; a thumb older than
   * THUMB_STALE_MS stops counting as a picture. */
  private tick() {
    if (!this.alive) return;
    const now = Date.now();
    const connected = this.state.phase === "live" && this.connectedAt > 0;
    const since = Math.max(this.connectedAt, this.lastFrameAt);
    const stalled = connected && now - since > VIDEO_STALL_MS;
    if (stalled && this.state.hasFrames) {
      monitorLog(`seat: video stalled (${now - this.lastFrameAt} ms without a frame)`);
      this.set({ hasFrames: false });
    }
    if (stalled !== this.state.stalled) this.set({ stalled });
    if (stalled && !this.thumbsAsked) this.askThumbs(true);
    const fresh = this.lastThumbAt > 0 && now - this.lastThumbAt < THUMB_STALE_MS;
    const onThumbs = this.thumbsAsked && fresh && !this.state.hasFrames;
    if (onThumbs !== this.state.onThumbs) {
      monitorLog(onThumbs ? "seat: showing the host's 8 fps preview" : "seat: preview off");
      this.set({ onThumbs });
    }
  }

  private askThumbs(on: boolean) {
    this.thumbsAsked = on;
    if (!on) this.set({ onThumbs: false });
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify({ kind: on ? "thumb-on" : "thumb-off" }));
      monitorLog(`seat: sent ${on ? "thumb-on" : "thumb-off"}`);
    } else {
      monitorLog(`seat: wanted ${on ? "thumb-on" : "thumb-off"} but the data channel is ${this.dc?.readyState ?? "absent"}`);
    }
  }

  private dropThumb() {
    if (this.thumbUrl) URL.revokeObjectURL(this.thumbUrl);
    this.thumbUrl = null;
  }

  private onData(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer || ev.data instanceof Blob) {
      // A program thumb: JPEG bytes, latest wins.
      const blob = ev.data instanceof Blob ? ev.data : new Blob([ev.data], { type: "image/jpeg" });
      const first = this.lastThumbAt === 0;
      this.lastThumbAt = Date.now();
      const url = URL.createObjectURL(blob);
      this.dropThumb();
      this.thumbUrl = url;
      if (first) monitorLog(`seat: first thumb (${blob.size} bytes)`);
      this.set({ thumbUrl: url, onThumbs: this.thumbsAsked && !this.state.hasFrames });
      return;
    }
    const msg = parseData(ev.data);
    if (!msg) return;
    if (msg.kind === "room-info") {
      monitorLog(`seat: room-info ${JSON.stringify(msg.info)}`);
      this.set({ roomInfo: msg.info ?? null });
    } else if (msg.kind === "program-state") {
      monitorLog(`seat: host program-state=${msg.state}${msg.detail ? ` (${msg.detail})` : ""}`);
      this.set({ programState: msg.state });
    }
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
        monitorLog(`seat: session ${res.status} — the row is gone`);
        this.set({ phase: "gone", message: "The host's room closed this monitor.", hasProgram: false, hasFrames: false, onThumbs: false });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      session = (await res.json()) as Session;
    } catch (e) {
      if (!mine()) return;
      monitorLog(`seat: session mint failed (${String(e)}); retrying in ${RECONNECT_MS} ms`);
      this.set({ phase: "connecting", message: "Waiting for the host…" });
      this.timer = window.setTimeout(() => void this.run(), RECONNECT_MS);
      return;
    }
    if (!mine()) return;
    monitorLog(`seat: session minted, ${session.ice_servers?.length ?? 0} ice servers`);

    const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
    this.pc = pc;
    // Receive-only: a monitor supplies nothing. The transceiver gives the
    // host's first offer something to answer to before the program attaches.
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ondatachannel = (ev) => {
      monitorLog(`seat: data channel "${ev.channel.label}" arrived`);
      this.dc = ev.channel;
      ev.channel.binaryType = "arraybuffer";
      ev.channel.onmessage = (m) => this.onData(m);
      ev.channel.onopen = () => {
        monitorLog("seat: data channel open");
        // A fresh host peer holds no memory of what we asked.
        if (this.thumbsAsked) this.askThumbs(true);
      };
      ev.channel.onclose = () => monitorLog("seat: data channel closed");
    };
    pc.ontrack = (event) => {
      if (event.track.kind !== "video") return;
      monitorLog(`seat: video track arrived (muted=${event.track.muted}, state=${event.track.readyState})`);
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.program = stream;
      // The host's first offer carries an EMPTY sendonly transceiver (the
      // program attaches on demand); its track arrives muted. "Has program"
      // means frames, so it follows the track's mute state, not its arrival.
      const track = event.track;
      const sync = () => {
        if (this.program === stream) {
          const has = !track.muted && track.readyState === "live";
          if (has !== this.state.hasProgram) monitorLog(`seat: track ${has ? "unmuted — expecting frames" : "muted — no frames coming"}`);
          this.set({ hasProgram: has });
        }
      };
      track.onunmute = sync;
      track.onmute = sync;
      track.onended = () => {
        if (this.program === stream) {
          monitorLog("seat: video track ended");
          this.program = null;
          this.set({ hasProgram: false, hasFrames: false });
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
      monitorLog(`seat: connection ${st}`);
      if (st === "connected") {
        downSince = 0;
        this.connectedAt = Date.now();
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
      monitorLog("seat: signaling open — hello + program-ready");
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
          monitorLog("seat: host hello — program-ready again");
          send({ kind: "program-ready" });
        }
      } catch (e) {
        monitorLog(`seat: signal frame failed: ${String(e)}`);
      }
    };
    ws.onclose = () => {
      monitorLog("seat: signaling closed");
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
            monitorLog(`seat: status ${res.status} — the row is gone`);
            this.teardownCall();
            this.set({ phase: "gone", message: "The host's room closed this monitor.", hasProgram: false, hasFrames: false, onThumbs: false });
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
    monitorLog("seat: reconnect");
    this.teardownCall();
    this.set({ phase: "connecting", message: "Reconnecting…", hasProgram: false, hasFrames: false, onThumbs: false, stalled: false });
    void this.run();
  }

  private teardownCall() {
    try {
      this.dc?.close();
    } catch {
      /* already closed */
    }
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
    this.dc = null;
    this.ws = null;
    this.pc = null;
    this.program = null;
    this.connectedAt = 0;
    this.lastFrameAt = 0;
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
  /** Something to log this leg as (the seat's name or row id). */
  tag?: string;
  /** The seat asked for (or dropped) the thumb leg — the host turns the
   * engine's program thumb on while any sender wants it. */
  onThumbDemand?: (wanted: boolean) => void;
}

export class MonitorSender {
  readonly spec: MonitorSenderSpec;
  private readonly api: string;
  private readonly target: { id: string; key: string } | null;
  private readonly tag: string;
  private alive = true;
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private dc: RTCDataChannel | null = null;
  private program: MediaStream | null = null;
  private attaching = false;
  private timer = 0;
  private generation = 0;
  private attempt = 0;
  private retryTimer = 0;
  private roomInfo: MonitorRoomInfo | null = null;
  private thumbsWanted = false;
  private lastThumbSent = 0;
  private thumbsSent = 0;
  private lastState: ProgramCaptureState | null = null;

  constructor(spec: MonitorSenderSpec) {
    this.spec = spec;
    this.api = connectApiBase(spec.apiBase);
    this.target = renderSessionFromUrl(spec.renderUrl);
    this.tag = spec.tag ?? this.target?.id.slice(0, 8) ?? "?";
  }

  /** Does this seat currently want the thumb leg? */
  wantsThumbs(): boolean {
    return this.thumbsWanted;
  }

  start(): void {
    if (!this.target) {
      monitorLog(`host[${this.tag}]: render URL has no session id/key — cannot send`);
      return;
    }
    monitorLog(`host[${this.tag}]: start (label="${this.spec.programLabel ?? ""}")`);
    void this.connect();
  }

  stop(): void {
    monitorLog(`host[${this.tag}]: stop`);
    this.alive = false;
    this.generation += 1;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.retryTimer);
    if (this.thumbsWanted) {
      this.thumbsWanted = false;
      this.spec.onThumbDemand?.(false);
    }
    this.teardown();
  }

  /** Room-owned facts for the seat (chat handles). Sent now if the channel
   * is open, and again on every (re)open. */
  setRoomInfo(info: MonitorRoomInfo): void {
    this.roomInfo = info;
    this.sendData({ kind: "room-info", info });
  }

  /** One program thumb (JPEG bytes). Dropped unless the seat asked, and
   * rate-limited to the engine's own cadence. */
  pushThumb(jpeg: ArrayBuffer): void {
    if (!this.thumbsWanted || !this.dc || this.dc.readyState !== "open") return;
    const now = Date.now();
    if (now - this.lastThumbSent < THUMB_MIN_INTERVAL_MS) return;
    // Back-pressure: a seat that cannot drain gets the next one, not a queue.
    if (this.dc.bufferedAmount > 256 * 1024) return;
    try {
      this.dc.send(jpeg);
      this.lastThumbSent = now;
      this.thumbsSent += 1;
      if (this.thumbsSent === 1 || this.thumbsSent % 200 === 0) monitorLog(`host[${this.tag}]: thumbs sent=${this.thumbsSent} (${jpeg.byteLength} bytes)`);
    } catch (e) {
      monitorLog(`host[${this.tag}]: thumb send failed: ${String(e)}`);
    }
  }

  private sendData(msg: DataMsg): boolean {
    if (!this.dc || this.dc.readyState !== "open") return false;
    try {
      this.dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private setState(state: ProgramCaptureState, detail?: string) {
    if (state !== this.lastState) monitorLog(`host[${this.tag}]: program ${state}${detail ? ` — ${detail}` : ""}`);
    this.lastState = state;
    this.sendData({ kind: "program-state", state, ...(detail ? { detail } : {}) });
  }

  private teardown() {
    try {
      this.dc?.close();
    } catch {
      /* closed */
    }
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
    this.dc = null;
    this.ws = null;
    this.pc = null;
    this.program?.getTracks().forEach((t) => t.stop());
    this.program = null;
    this.attaching = false;
    this.lastState = null;
  }

  private retry(gen: number) {
    if (!this.alive || gen !== this.generation) return;
    this.teardown();
    const delay = Math.min(15000, RECONNECT_MS * 2 ** Math.min(this.attempt++, 3));
    monitorLog(`host[${this.tag}]: retry in ${delay} ms`);
    this.timer = window.setTimeout(() => void this.connect(), delay);
  }

  /** The program leg: capture the virtual camera, small on purpose (a
   *  monitor needs to see what is on air and stay in sync, not broadcast
   *  quality), and add it — onnegotiationneeded carries it across.
   *
   *  The device exists only while the virtual camera RUNS. Live.tsx starts
   *  it when a monitor row appears, but that takes a moment (and on a Mac
   *  the extension may still need its one-time approval), so this keeps
   *  looking every PROGRAM_RETRY_MS and tells the seat what it found. */
  private async attachProgram(pc: RTCPeerConnection, gen: number, tries = 0): Promise<void> {
    if (this.program || this.attaching) return;
    if (gen !== this.generation || this.pc !== pc) return;
    this.attaching = true;
    try {
      this.setState("searching");
      // Any camera grant first, or labels are unreadable.
      let devices = await navigator.mediaDevices.enumerateDevices();
      let cam = pickProgramDevice(devices, this.spec.programLabel);
      if (!cam || !cam.label) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch((e: unknown) => {
          monitorLog(`host[${this.tag}]: camera grant probe failed: ${String(e)}`);
          return null;
        });
        probe?.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        cam = pickProgramDevice(devices, this.spec.programLabel);
      }
      if (gen !== this.generation || this.pc !== pc) return;
      if (!cam) {
        const labels = devices.filter((d) => d.kind === "videoinput").map((d) => d.label || "(no label)");
        this.setState("no-device", `video inputs: ${labels.join(", ") || "none"}`);
        this.scheduleAttach(pc, gen, tries);
        return;
      }
      let prog: MediaStream | null = null;
      let err: string | null = null;
      try {
        prog = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cam.deviceId }, width: 640, height: 360, frameRate: 15 },
          audio: false,
        });
      } catch (e) {
        err = String(e);
      }
      if (gen !== this.generation || this.pc !== pc) {
        prog?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!prog) {
        this.setState("denied", err ?? "getUserMedia returned nothing");
        this.scheduleAttach(pc, gen, tries);
        return;
      }
      this.program = prog;
      const track = prog.getVideoTracks()[0];
      const settings = track?.getSettings() ?? {};
      prog.getVideoTracks().forEach((t) => pc.addTrack(t, prog));
      this.setState("capturing", `${cam.label} ${settings.width ?? "?"}×${settings.height ?? "?"}@${settings.frameRate ?? "?"}`);
      track?.addEventListener("ended", () => {
        if (this.program !== prog) return;
        monitorLog(`host[${this.tag}]: program track ended — looking again`);
        this.program = null;
        this.scheduleAttach(pc, gen, 0);
      });
    } catch (e) {
      // No program is degraded, not broken: keep looking.
      this.setState("no-device", String(e));
      this.scheduleAttach(pc, gen, tries);
    } finally {
      this.attaching = false;
    }
  }

  private scheduleAttach(pc: RTCPeerConnection, gen: number, tries: number) {
    if (tries >= PROGRAM_RETRY_MAX) {
      monitorLog(`host[${this.tag}]: gave up looking for the virtual camera after ${tries} tries`);
      return;
    }
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      if (this.alive && gen === this.generation && this.pc === pc) void this.attachProgram(pc, gen, tries + 1);
    }, PROGRAM_RETRY_MS);
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    if (!this.alive || !this.target) return;
    let session: Session;
    try {
      const res = await fetch(`${this.api}/guest/render/${this.target.id}/session?k=${encodeURIComponent(this.target.key)}`, { method: "POST" });
      // 410: ended / revoked — the roster tick drops this sender for good.
      if (res.status === 410 || res.status === 404) {
        monitorLog(`host[${this.tag}]: render session ${res.status} — row gone`);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      session = (await res.json()) as Session;
    } catch (e) {
      monitorLog(`host[${this.tag}]: render session mint failed: ${String(e)}`);
      this.retry(gen);
      return;
    }
    if (gen !== this.generation) return;
    monitorLog(`host[${this.tag}]: session minted`);

    const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
    this.pc = pc;
    // The data channel rides the first offer: thumbs, room info, state.
    const dc = pc.createDataChannel(DATA_CHANNEL, { ordered: true });
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      monitorLog(`host[${this.tag}]: data channel open`);
      if (this.roomInfo) this.sendData({ kind: "room-info", info: this.roomInfo });
      if (this.lastState) this.sendData({ kind: "program-state", state: this.lastState });
    };
    dc.onclose = () => monitorLog(`host[${this.tag}]: data channel closed`);
    dc.onmessage = (m) => {
      const msg = parseData(m.data);
      if (!msg) return;
      if (msg.kind === "thumb-on" || msg.kind === "thumb-off") {
        const want = msg.kind === "thumb-on";
        monitorLog(`host[${this.tag}]: seat asked ${msg.kind}`);
        if (want !== this.thumbsWanted) {
          this.thumbsWanted = want;
          this.spec.onThumbDemand?.(want);
        }
      }
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
        /* the next negotiation retries */
      } finally {
        makingOffer = false;
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") pc.restartIce();
    };
    pc.onconnectionstatechange = () => {
      monitorLog(`host[${this.tag}]: connection ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.retry(gen);
    };
    ws.onopen = () => {
      this.attempt = 0;
      monitorLog(`host[${this.tag}]: signaling open — hello`);
      send({ kind: "hello" });
      if (pc.localDescription) send({ kind: "sdp", description: pc.localDescription });
    };
    ws.onclose = () => {
      monitorLog(`host[${this.tag}]: signaling closed`);
      this.retry(gen);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onmessage = async (event) => {
      const msg = parseFrame(event.data);
      if (!msg || gen !== this.generation) return;
      try {
        if (msg.kind === "hello") {
          // The seat arrived. Kick negotiation the way the render page does.
          monitorLog(`host[${this.tag}]: seat hello`);
          if (pc.getTransceivers().length === 0) pc.addTransceiver("video", { direction: "sendonly" });
          else await pc.setLocalDescription().then(() => send({ kind: "sdp", description: pc.localDescription }));
          return;
        }
        if (msg.kind === "program-ready") {
          monitorLog(`host[${this.tag}]: seat program-ready`);
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
      } catch (e) {
        monitorLog(`host[${this.tag}]: signal frame failed: ${String(e)}`);
      }
    };
    // Something to negotiate over before the program attaches.
    pc.addTransceiver("video", { direction: "sendonly" });
  }
}
