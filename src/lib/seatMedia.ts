/** A SEAT WITH MEDIA — the sending half, native to Producer.
 *
 * When the host hands a seat camera / mic / screen (the Jamie pattern:
 * api `POST /live/guests/:id/grants` on the seat's monitor row, host-only),
 * the seat's Producer opens the same leg the guest page opens
 * (server/guest/src/hostLink.ts): camera + mic on the MAIN peer, the screen
 * on the SCREEN peer, and the host's program back on main as the return
 * feed. It runs on the seat's OWN participant row — the monitor row — so
 * the host sees one participant, "<name> · mod", framed like any guest.
 *
 * This REPLACES the receive-only ProgramMonitor while media is held: two
 * host peers on one channel would collide (the render page and the
 * MonitorSender both answer the main peer), so the host stops its sender
 * for a media seat and the render page's return leg carries the program.
 * The snapshot keeps ProgramMonitor's shape (lib/monitorFeed.ts
 * MonitorState) so the stage draws either without knowing which.
 *
 * Reconnects on its own: the status poll (5 s) ends the leg on 404/410;
 * a main peer failed/closed for RECONNECT_AFTER_MS mints a fresh session.
 * Leaving is explicit.
 */

import { HostLink, signalingWsUrl, type Session } from "../../server/guest/src/hostLink";
import { connectApiBase, inviteCodeFromJoinUrl } from "./guestSeat";
import { monitorLog, type MonitorPhase, type MonitorRoomInfo, type MonitorState, type ProgramSource } from "./monitorFeed";

const POLL_MS = 5000;
const RECONNECT_MS = 2000;
const RECONNECT_AFTER_MS = 8000;
const LEVEL_MS = 100;

export interface SeatMediaSpec {
  /** The seat's monitor join URL (invite code = last path segment). */
  joinUrl: string;
  apiBase: string;
  hostName?: string | null;
  /** What the host granted — decides which tracks are opened. */
  camera: boolean;
  mic: boolean;
  screen: boolean;
  /** Prefer the Producer virtual camera (the seat's own stage) by label. */
  camLabel?: string | null;
}

export interface SeatMediaState extends MonitorState {
  /** The main peer's state, as the host sees it. */
  sending: "starting" | "connecting" | "live" | "gone" | "error";
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  /** 0..1, RMS of the mic, sampled every LEVEL_MS while media.mic. */
  micLevel: number;
  /** Camera/mic could not be opened (permission, no device). */
  mediaError: string | null;
}

const INITIAL: SeatMediaState = {
  phase: "connecting",
  message: "",
  hasProgram: false,
  hasFrames: false,
  onThumbs: false,
  thumbUrl: null,
  programState: null,
  roomInfo: null,
  stalled: false,
  sending: "starting",
  muted: false,
  cameraOff: false,
  sharing: false,
  micLevel: 0,
  mediaError: null,
};

export class SeatMediaLeg implements ProgramSource {
  readonly spec: SeatMediaSpec;
  private readonly api: string;
  private readonly code: string | null;
  private state: SeatMediaState = INITIAL;
  private listeners = new Set<() => void>();
  private alive = true;
  private generation = 0;
  private local: MediaStream | null = null;
  private program: MediaStream | null = null;
  private hostAudio: MediaStream | null = null;
  private link: HostLink | null = null;
  private timer = 0;
  private watch = 0;
  private downSince = 0;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer = 0;
  private lastFrameAt = 0;

  constructor(spec: SeatMediaSpec) {
    this.spec = spec;
    this.api = connectApiBase(spec.apiBase);
    this.code = inviteCodeFromJoinUrl(spec.joinUrl);
  }

  // ── Observation (ProgramSource) ─────────────────────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  snapshot(): SeatMediaState {
    return this.state;
  }
  programStream(): MediaStream | null {
    return this.program;
  }
  localStream(): MediaStream | null {
    return this.local;
  }
  screenStream(): MediaStream | null {
    return this.link?.screenStream() ?? null;
  }
  hostAudioStream(): MediaStream | null {
    return this.hostAudio;
  }
  noteFrame(): void {
    this.lastFrameAt = Date.now();
    if (!this.state.hasFrames) this.set({ hasFrames: true, stalled: false });
  }
  private set(patch: Partial<SeatMediaState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (!this.code) {
      this.set({ phase: "error", sending: "error", message: "The seat's row has no invite code." });
      return;
    }
    monitorLog(`seat-media: start cam=${this.spec.camera} mic=${this.spec.mic} screen=${this.spec.screen}`);
    try {
      await this.openMedia();
    } catch (e) {
      // No camera is not the end of the seat: it can still receive the
      // program and share a screen. Say so on the feed window.
      monitorLog(`seat-media: media open failed: ${String(e)}`);
      this.set({ mediaError: "Producer needs camera and microphone access to send your feed." });
    }
    if (!this.alive) return;
    void this.run();
    this.watch = window.setInterval(() => void this.tick(), POLL_MS);
  }

  leave(): void {
    monitorLog("seat-media: leave");
    this.alive = false;
    this.generation += 1;
    window.clearTimeout(this.timer);
    window.clearInterval(this.watch);
    window.clearInterval(this.levelTimer);
    this.teardownCall();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;
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
  /** Screen share rides the SCREEN peer (media.screen). Resolves false when
   *  the pick was cancelled or the webview cannot capture. */
  async toggleShare(): Promise<boolean> {
    const link = this.link;
    if (!link || !this.spec.screen) return false;
    if (link.sharing) {
      link.stopShare();
      this.set({ sharing: false });
      void this.announceShare(false);
      return false;
    }
    const ok = await link.startShare();
    this.set({ sharing: ok });
    if (ok) void this.announceShare(true);
    return ok;
  }

  /** The share as SERVER TRUTH: `POST /guest/:code/screen {sharing}` opens
   *  (closes) the seat's `media.screen` contribution interval — the same
   *  door the guest page uses. The host's Producer hears the interval on
   *  the room channel and places (removes) the seat's MOD SCREEN feed from
   *  it (v0.4.32), so "on set" for a screen is never a guess. Best effort:
   *  a server without the route still gets the share over the peer. */
  private async announceShare(sharing: boolean): Promise<void> {
    if (!this.code) return;
    try {
      const res = await fetch(`${this.api}/guest/${encodeURIComponent(this.code)}/screen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sharing, binding: { track: "share", kind: "mod" } }),
      });
      monitorLog(`seat-media: share ${sharing ? "start" : "stop"} announced → ${res.status}`);
    } catch (e) {
      monitorLog(`seat-media: share announce failed: ${String(e)}`);
    }
  }

  // ── Media ──────────────────────────────────────────────────────────────
  private async openMedia(): Promise<void> {
    if (!this.spec.camera && !this.spec.mic) return;
    let stream = await navigator.mediaDevices.getUserMedia({ video: this.spec.camera, audio: this.spec.mic });
    if (this.spec.camera && this.spec.camLabel) {
      // The seat's own Producer stage as its camera, when the virtual camera runs.
      const want = this.spec.camLabel.toLowerCase();
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      const vcam = devices.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes(want));
      const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (vcam && vcam.deviceId !== current) {
        try {
          const swapped = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: vcam.deviceId } }, audio: this.spec.mic });
          stream.getTracks().forEach((t) => t.stop());
          stream = swapped;
        } catch {
          /* the real webcam stays */
        }
      }
    }
    if (!this.alive) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.local = stream;
    this.set({});
    if (this.spec.mic) this.meter(stream);
  }

  /** A quiet RMS meter on the mic track for the feed window. */
  private meter(stream: MediaStream) {
    if (!stream.getAudioTracks().length) return;
    try {
      const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctx) return;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.audioCtx = ctx;
      this.analyser = an;
      const buf = new Uint8Array(an.fftSize);
      this.levelTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const level = this.state.muted ? 0 : Math.min(1, rms * 3);
        if (Math.abs(level - this.state.micLevel) > 0.02) this.set({ micLevel: level });
      }, LEVEL_MS);
    } catch {
      /* no meter — the feed still sends */
    }
  }

  // ── The call ───────────────────────────────────────────────────────────
  private async run(): Promise<void> {
    const gen = ++this.generation;
    const mine = () => this.alive && gen === this.generation;
    this.set({ phase: "connecting", sending: "connecting", message: "" });
    let session: Session;
    try {
      const res = await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}/session`, { method: "POST" });
      if (res.status === 404 || res.status === 410) {
        monitorLog(`seat-media: session ${res.status} — the row is gone`);
        this.set({ phase: "gone", sending: "gone", message: "The host's room closed this seat.", hasProgram: false, hasFrames: false });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      session = (await res.json()) as Session;
    } catch (e) {
      if (!mine()) return;
      monitorLog(`seat-media: session mint failed (${String(e)}); retrying`);
      this.set({ message: "Waiting for the host…" });
      this.timer = window.setTimeout(() => void this.run(), RECONNECT_MS);
      return;
    }
    if (!mine()) return;
    this.teardownCall();
    this.downSince = 0;
    this.link = new HostLink({
      session,
      wsUrl: signalingWsUrl(this.api, session),
      localStream: () => this.local,
      // The return feed is pinned on the seat's row (api monitor.ts).
      returnFeed: true,
      delayReturnFeedMs: 0,
      onProgram: (stream) => {
        if (!mine()) return;
        this.program = stream;
        const track = stream?.getVideoTracks()[0] ?? null;
        const sync = () => {
          if (this.program !== stream) return;
          const has = !!track && !track.muted && track.readyState === "live";
          this.set({ hasProgram: has, ...(has ? {} : { hasFrames: false }) });
        };
        if (track) {
          track.onunmute = sync;
          track.onmute = sync;
          track.onended = () => {
            if (this.program === stream) {
              this.program = null;
              this.set({ hasProgram: false, hasFrames: false });
            }
          };
        }
        sync();
      },
      onHostAudio: (stream) => {
        if (!mine()) return;
        this.hostAudio = stream;
        this.set({});
      },
      onData: (msg) => {
        // The render page forwards the host's stage / cue frames; the
        // room-info frame names the chat handles like the monitor leg does.
        const m = msg as { kind?: unknown; info?: MonitorRoomInfo };
        if (m && m.kind === "room-info" && m.info) this.set({ roomInfo: m.info });
      },
      onShareEnded: () => {
        this.set({ sharing: false });
        void this.announceShare(false);
      },
      onMainState: (st) => {
        if (!mine()) return;
        monitorLog(`seat-media: main ${st}`);
        if (st === "connected") {
          this.downSince = 0;
          this.set({ phase: "live", sending: "live", message: "" });
        } else if (st === "failed" || st === "disconnected" || st === "closed") {
          this.downSince = this.downSince || Date.now();
          this.set({ phase: "connecting", sending: "connecting", message: "Reconnecting…" });
        }
      },
    });
  }

  /** Status poll + the reconnect clock. */
  private async tick(): Promise<void> {
    if (!this.alive) return;
    const gen = this.generation;
    try {
      const res = await fetch(`${this.api}/guest/${encodeURIComponent(this.code!)}`);
      if (res.status === 404 || res.status === 410) {
        monitorLog(`seat-media: status ${res.status} — the row is gone`);
        this.teardownCall();
        this.set({ phase: "gone", sending: "gone", message: "The host's room closed this seat.", hasProgram: false, hasFrames: false });
        return;
      }
    } catch {
      /* a blip */
    }
    if (gen !== this.generation || this.state.sending === "gone") return;
    const st = this.link?.mainConnectionState();
    if ((st === "failed" || st === "closed" || st === "disconnected") && this.downSince && Date.now() - this.downSince > RECONNECT_AFTER_MS) {
      monitorLog("seat-media: reconnect");
      void this.run();
    }
    // The program leg stalls the same way the monitor's does: no frame for
    // a while on a live track → say so rather than freeze a picture.
    if (this.state.hasFrames && Date.now() - this.lastFrameAt > 5000) this.set({ hasFrames: false, stalled: true });
  }

  private teardownCall() {
    try {
      this.link?.close();
    } catch {
      /* already closed */
    }
    this.link = null;
    this.program = null;
    this.hostAudio = null;
    if (this.state.sharing) this.set({ sharing: false });
  }
}

export type { MonitorPhase };
