import type { RoomSource } from "../../server/src/roomActions";
/** Moderator workspace shared by authenticated seats and self-hosted control
 * links. Program and Scenes show the host's confirmed output. My Sources
 * separates local capture from placement and mixing in that output. Guests
 * and Audience tabs hold show controls according to the seat's permissions. */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { type RoomAccessInfo, roleTitle } from "../lib/participants";
import { monitorPlaceholder, type MonitorState, type ProgramSource } from "../lib/monitorFeed";
import { type ModBoardLayout, type SeatFeeds, type ThrowUpState } from "../lib/modBoard";
import type { SeatMediaLeg, SeatMediaState } from "../lib/seatMedia";

// ── Small icons (the room's line weight, 1.8) ───────────────────────────────
const bi = {
  cam: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="12" rx="3" />
      <path d="M16 10.5 21 8v8l-5-2.5z" />
    </svg>
  ),
  mic: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  ),
  screen: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="2.5" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  up: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
  vote: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16M6 16V9M12 16V4M18 16v-6" />
    </svg>
  ),
  link: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </svg>
  ),
};

function useProgramState(src: ProgramSource | null): MonitorState | null {
  return useSyncExternalStore(
    (fn) => (src ? src.subscribe(fn) : () => {}),
    () => (src ? src.snapshot() : null),
    () => null,
  );
}

function Stream({ stream, className, muted, mirror }: { stream: MediaStream | null; className: string; muted?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} className={`${className}${mirror ? " mirror" : ""}`} autoPlay playsInline muted={muted} />;
}

function HostAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (a.srcObject !== stream) a.srcObject = stream;
    if (stream) void a.play().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

/** The clock: wall time, and the time on air since the program first drew. */
function useClock(onAirSince: number | null): { wall: string; onAir: string | null } {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const now = Date.now();
  const wall = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (!onAirSince) return { wall, onAir: null };
  const s = Math.max(0, Math.floor((now - onAirSince) / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return { wall, onAir: `${hh}:${mm}:${ss}` };
}

// ── HOST OUTPUT ─────────────────────────────────────────────────────────────

function HostOutput({ program, pending, boomin, title, online }: { program: ProgramSource | null; pending: boolean; boomin: boolean; title: string; online: boolean }) {
  const st = useProgramState(program);
  const ref = useRef<HTMLVideoElement>(null);
  const stream = st?.hasProgram ? program?.programStream() ?? null : null;
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !program) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (!stream) return;
    void v.play().catch(() => {});
    let alive = true;
    let handle = 0;
    const vv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
    const onFrame = () => {
      if (!alive) return;
      program.noteFrame();
      if (vv.requestVideoFrameCallback) handle = vv.requestVideoFrameCallback(onFrame);
    };
    if (vv.requestVideoFrameCallback) handle = vv.requestVideoFrameCallback(onFrame);
    else v.addEventListener("timeupdate", onFrame);
    return () => {
      alive = false;
      if (vv.cancelVideoFrameCallback && handle) vv.cancelVideoFrameCallback(handle);
      v.removeEventListener("timeupdate", onFrame);
    };
  }, [stream, program]);
  const showVideo = !!stream && !!st?.hasFrames;
  const showThumb = !showVideo && !!st?.onThumbs && !!st?.thumbUrl;
  const has = showVideo || showThumb;
  useEffect(() => {
    if (has && since === null) setSince(Date.now());
    if (!has && since !== null) setSince(null);
  }, [has, since]);
  const clock = useClock(since);
  const line = pending
    ? "Checking your seat…"
    : !boomin
      ? "A mod link on an open server carries no return feed — the host's output stays on the host"
      : !program || !st
        ? "Connecting to the host's output…"
        : monitorPlaceholder({ phase: st.phase, message: st.message, connected: st.phase === "live", programState: st.programState, stalled: st.stalled });
  return (
    <section className="mb-output" aria-label="Program">
      <header className="mb-output-head">
        <span className="mb-output-title">{title}</span>
        <span className={`mb-pill${has ? " live" : online ? " on" : ""}`}>{has ? "RECEIVING" : online ? "CONNECTING" : "OFFLINE"}</span>
        <span className="mb-clock">
          {clock.onAir && <span className="mb-clock-air">{clock.onAir}</span>}
          <span className="mb-clock-wall">{clock.wall}</span>
        </span>
      </header>
      <div className={`mb-monitor${has ? " has-program" : ""}`}>
        <video ref={ref} className="mb-monitor-video" autoPlay playsInline muted hidden={!showVideo} />
        {showThumb && <img className="mb-monitor-video" src={st!.thumbUrl!} alt="" />}
        {!has && <span className="mb-monitor-line">{line}</span>}
        {has && <span className="mb-tag">PROGRAM</span>}
        {showThumb && <span className="mb-tag mb-tag-right">8 fps preview</span>}
      </div>
    </section>
  );
}

// ── The strip: scene pads, the Vote pad, the Audience link ──────────────────

export interface SceneDirectory {
  scenes: { id: string; name: string }[];
  active_scene_id: string | null;
}

function ScenePads({
  scenes,
  canCut,
  onCut,
  pending,
  vote,
  voteLive,
  canVote,
  onAudienceLink,
  audienceLink,
}: {
  scenes: SceneDirectory | null;
  canCut: boolean;
  onCut: (id: string) => void;
  pending: boolean;
  vote?: ReactNode;
  voteLive: boolean;
  canVote: boolean;
  onAudienceLink?: () => void;
  audienceLink?: string | null;
}) {
  const [voteOpen, setVoteOpen] = useState(false);
  useEffect(() => {
    if (voteLive) setVoteOpen(true);
  }, [voteLive]);
  return (
    <section className="mb-strip" aria-label="Scenes">
      <div className="mb-pads">
        {!scenes ? (
          <div className="mb-pads-empty">{pending ? "Checking your seat…" : "The host's scenes land here once their Producer opens the room."}</div>
        ) : scenes.scenes.length === 0 ? (
          <div className="mb-pads-empty">The host hasn't published scenes yet.</div>
        ) : (
          scenes.scenes.map((sc, i) => {
            const active = scenes.active_scene_id === sc.id;
            return (
              <button
                key={sc.id}
                className={`mb-pad${active ? " lit" : ""}${canCut ? "" : " readonly"}`}
                disabled={!canCut}
                title={canCut ? `Cut to ${sc.name}${i < 9 ? ` (⌘${i + 1})` : ""}` : "This seat can't cut scenes"}
                onClick={() => canCut && onCut(sc.id)}
              >
                <span className="mb-pad-key">{i < 9 ? `⌘${i + 1}` : ""}</span>
                <span className="mb-pad-name">{sc.name}</span>
                <span className="mb-pad-state">{active ? "ON AIR" : ""}</span>
              </button>
            );
          })
        )}
        {canVote && vote && (
          <button className={`mb-pad mb-pad-vote${voteLive ? " lit" : ""}${voteOpen ? " open" : ""}`} onClick={() => setVoteOpen((o) => !o)} title="The vote — open it here, the tally on the set">
            <span className="mb-pad-key">{bi.vote}</span>
            <span className="mb-pad-name">Vote</span>
            <span className="mb-pad-state">{voteLive ? "LIVE" : voteOpen ? "▾" : "▸"}</span>
          </button>
        )}
        {onAudienceLink && (
          <button className="mb-pad mb-pad-link" onClick={onAudienceLink} title={audienceLink ?? "Copy the link the audience opens on their phones"}>
            <span className="mb-pad-key">{bi.link}</span>
            <span className="mb-pad-name">Audience</span>
            <span className="mb-pad-state">link</span>
          </button>
        )}
      </div>
      {canVote && vote && voteOpen && <div className="mb-vote">{vote}</div>}
    </section>
  );
}

// ── MY FEEDS ────────────────────────────────────────────────────────────────

function useSeatMedia(media: SeatMediaLeg | null): SeatMediaState | null {
  return useSyncExternalStore(
    (fn) => (media ? media.subscribe(fn) : () => {}),
    () => (media ? media.snapshot() : null),
    () => null,
  );
}

function MyFeeds({ feeds, media, sourceStates, pendingSources, onThrowUp, onSourceMute, boomin }: {
  feeds: SeatFeeds; media: SeatMediaLeg | null; sourceStates: RoomSource[]; pendingSources: ReadonlySet<string>;
  onThrowUp: (kind: "camera" | "screen") => void; onSourceMute?: (id: string, muted: boolean) => void; boomin: boolean;
}) {
  const st = useSeatMedia(media);
  return <section className="mb-source-list" aria-label="My sources">
    {(["camera", "screen"] as const).map(kind => {
      const granted = feeds[kind];
      const source = sourceStates.find(s => s.kind === kind);
      const capturing = kind === "camera" ? !!media && !st?.cameraOff : !!st?.sharing;
      const busy = !!source && pendingSources.has(source.id);
      return <div className="mb-source" key={kind}>
        <div className="mb-source-head"><strong>{kind === "camera" ? bi.cam : bi.screen} {kind === "camera" ? "Camera" : "Screen"}</strong><span>{source?.visible ? "In program" : capturing ? "Ready" : "Off"}</span></div>
        <div className="mb-source-preview">{granted && capturing ? <Stream stream={kind === "camera" ? media?.localStream() ?? null : media?.screenStream() ?? null} className="mb-feed-video" muted mirror={kind === "camera"} /> : <span>{!granted ? `The host can allow your ${kind}.` : st?.mediaError ?? (kind === "screen" ? "Choose a screen or window to share." : "Your camera is off.")}</span>}</div>
        <div className="mb-source-actions">
          <button disabled={!granted || !media} onClick={() => kind === "camera" ? media?.toggleCamera() : void media?.toggleShare()}>{kind === "camera" ? (capturing ? "Stop camera" : "Start camera") : (capturing ? "Stop sharing" : "Share screen")}</button>
          <button disabled={!granted || !source || busy || (!capturing && !source.visible)} onClick={() => onThrowUp(kind)}>{busy ? "Waiting for host…" : source?.visible ? "Remove from scene" : "Add to scene"}</button>
        </div>
      </div>;
    })}
    {feeds.mic && <div className="mb-source mb-source-mic">
      <div className="mb-source-head"><strong>{bi.mic} Microphone</strong><span>{st?.sending !== "live" ? "Not sending" : st.muted ? "Muted locally" : "Sending to host"}</span></div>
      <div className="mb-source-actions"><button disabled={!media} onClick={() => media?.toggleMute()}>{st?.muted ? "Unmute microphone" : "Mute microphone"}</button>
        {sourceStates.filter(s => s.kind === "microphone").map(source => <button key={source.id} disabled={!onSourceMute} onClick={() => onSourceMute?.(source.id, !source.muted)}>{source.muted ? "Enable in program" : "Mute in program"}</button>)}
      </div><span className="mb-meter-track"><span className="mb-meter-fill" style={{ width: `${Math.round((st?.micLevel ?? 0) * 100)}%` }} /></span>
    </div>}
    {!feeds.any && <p className="mb-feeds-note">{boomin ? "The host can allow your camera, microphone and screen. Your controls work without those permissions." : "This moderator link provides room controls. Media permissions are managed by the host."}</p>}
    <HostAudio stream={media?.hostAudioStream() ?? null} />
  </section>;
}

// ── The row of switches ─────────────────────────────────────────────────────

// ── The board ───────────────────────────────────────────────────────────────

export interface ModBoardProps {
  title: string;
  access: RoomAccessInfo;
  /** The open server's host, for the role line. */
  host?: string | null;
  pending: boolean;
  boomin: boolean;
  /** The control channel is up (open server) / the seat is connected. */
  online: boolean;
  program: ProgramSource | null;
  scenes: SceneDirectory | null;
  onCut: (sceneId: string) => void;
  /** The vote card (VoteHostCard) — passed only when the seat may run votes. */
  vote?: ReactNode;
  voteLive?: boolean;
  onAudienceLink?: () => void;
  audienceLink?: string | null;
  /** PEOPLE — the GuestPanel element, built by the caller with its own handlers. */
  people: ReactNode;
  /** MY FEEDS */
  grants: ReadonlySet<string>;
  feeds: SeatFeeds;
  media: SeatMediaLeg | null;
  throwUp: ThrowUpState;
  onThrowUp: (kind: "camera" | "screen") => void;
  sourceStates?: RoomSource[];
  pendingSources?: ReadonlySet<string>;
  onSourceMute?: (id: string, muted: boolean) => void;
  layout: ModBoardLayout;
  error?: string | null;
}

export function ModBoard(p: ModBoardProps) {
  const [tab, setTab] = useState<"people" | "audience">("people");
  return <div className="modboard mb-workspace">
    <main className="mb-production">
      <HostOutput program={p.program} pending={p.pending} boomin={p.boomin} title={p.title} online={p.online} />
      <section className="mb-scene-section"><h3 className="mb-h">Scenes</h3><ScenePads scenes={p.scenes} canCut={p.access.can.scene && !p.pending} onCut={p.onCut} pending={p.pending} voteLive={false} canVote={false} /></section>
      <section className="mb-operations">
        <nav className="mb-tabs" aria-label="Room controls"><button className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>Guests</button>{p.vote && <button className={tab === "audience" ? "active" : ""} onClick={() => setTab("audience")}>Audience & votes{p.voteLive ? " · active" : ""}</button>}{p.onAudienceLink && <button className="mb-copy-audience" onClick={p.onAudienceLink}>Copy audience link</button>}</nav>
        <div className="mb-operation-content">{tab === "people" ? p.people : p.vote}</div>
      </section>
    </main>
    <aside className="mb-source-sidebar"><h3 className="mb-h">My Sources</h3><p className="mb-source-explanation">Choose what to send. Add camera and screen sources to the host’s current scene.</p><MyFeeds feeds={p.feeds} media={p.media} sourceStates={p.sourceStates ?? []} pendingSources={p.pendingSources ?? new Set()} onThrowUp={p.onThrowUp} onSourceMute={p.onSourceMute} boomin={p.boomin} /></aside>
    <footer className="mb-role-status"><span>{roleTitle(p.access, p.host)}</span><span>{p.pending ? "Checking permissions…" : p.online ? "Connected to host" : "Waiting for host"}</span></footer>
    {p.error && <div className="mb-error" role="alert">{p.error}</div>}
  </div>;
}
