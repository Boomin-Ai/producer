/** THE MOD VIEW — a board, not the host's dock layout.
 *
 * Rendered for any non-host seat on a Boomin room (views/Live.tsx) and for a
 * mod seat on an open server (views/ModSeat.tsx) — one component, two data
 * sources. Its pure half (layout + throw-up) is lib/modBoard.ts.
 *
 *   top      HOST OUTPUT — the program monitor, large, with the room name,
 *            the live pill and the clock.
 *   strip    scene PADS across (one tap cuts, the active pad lit, ⌘1–9),
 *            then the Vote as one pad that expands into the vote card, and
 *            the Audience link.
 *   left     PEOPLE — waiting guests (Admit / Decline), staged guests
 *            (Stage / order / remove) with the honest pending states.
 *   right    MY FEEDS — CAMERA and SCREEN: live self-preview when the seat
 *            holds the grant, greyed "Ask the host…" when not; one button
 *            each, Throw up, that asks the host's set for a slot through
 *            the honest-staging path. Mic meter + mute by the camera.
 *   bottom   the row of switches — what the seat holds (chips) and what it
 *            is sending (cam / mic / screen), the capabilities quietly.
 *
 * The board is a layout of its own, saved per seat (`producer.modboard.v1`);
 * panels render from their region, so a future "sound board" strip is one
 * more panel id. Glass tokens throughout; no blue backgrounds.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { type RoomAccessInfo, roleTitle } from "../lib/participants";
import { monitorPlaceholder, type MonitorState, type ProgramSource } from "../lib/monitorFeed";
import { type ModBoardLayout, type ModBoardPanel, type SeatFeeds, type ThrowUpState, ASK_HOST, MOD_BOARD_META, heldChips } from "../lib/modBoard";
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
    <section className="mb-output" aria-label="Host output">
      <header className="mb-output-head">
        <span className="mb-output-title">{title}</span>
        <span className={`mb-pill${has ? " live" : online ? " on" : ""}`}>{has ? "LIVE" : online ? "ROOM OPEN" : "OFF"}</span>
        <span className="mb-clock">
          {clock.onAir && <span className="mb-clock-air">{clock.onAir}</span>}
          <span className="mb-clock-wall">{clock.wall}</span>
        </span>
      </header>
      <div className={`mb-monitor${has ? " has-program" : ""}`}>
        <video ref={ref} className="mb-monitor-video" autoPlay playsInline muted hidden={!showVideo} />
        {showThumb && <img className="mb-monitor-video" src={st!.thumbUrl!} alt="" />}
        {!has && <span className="mb-monitor-line">{line}</span>}
        {has && <span className="mb-tag">HOST OUTPUT</span>}
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

function FeedWindow({
  kind,
  granted,
  stream,
  off,
  note,
  children,
  throwUp,
  onThrowUp,
  mirror,
}: {
  kind: "camera" | "screen";
  granted: boolean;
  stream: MediaStream | null;
  off?: boolean;
  note?: string | null;
  children?: ReactNode;
  throwUp: ThrowUpState;
  onThrowUp: () => void;
  mirror?: boolean;
}) {
  const label = kind === "camera" ? "CAMERA" : "SCREEN";
  return (
    <div className={`mb-feed${granted ? "" : " off"}${throwUp.row === "on" ? " onset" : ""}`}>
      <div className="mb-feed-head">
        <span className="mb-feed-label">
          {kind === "camera" ? bi.cam : bi.screen} {label}
        </span>
        {throwUp.row === "on" && <span className="mb-feed-live">ON SET</span>}
        {throwUp.row.startsWith("pending") && <span className="mb-feed-pending">asking…</span>}
      </div>
      <div className="mb-feed-window">
        {granted && stream && !off ? (
          <Stream stream={stream} className="mb-feed-video" muted mirror={mirror} />
        ) : (
          <span className="mb-feed-note">{granted ? note ?? (off ? "Off" : "Starting…") : ASK_HOST[kind]}</span>
        )}
      </div>
      <div className="mb-feed-ctl">
        {children}
        <button
          className={`mb-throw${throwUp.row === "on" ? " on" : ""}`}
          disabled={throwUp.disabled || !granted}
          title={
            !granted
              ? ASK_HOST[kind]
              : throwUp.row === "unavailable"
                ? "Your seat can't ask the host's set for a slot"
                : throwUp.row === "on"
                  ? "Ask the host's set to take you down"
                  : "Ask the host's set for a slot — pending until their set confirms"
          }
          onClick={onThrowUp}
        >
          {bi.up} {throwUp.label}
        </button>
      </div>
      {throwUp.notice && granted && <div className="mb-feed-notice">{throwUp.notice}</div>}
    </div>
  );
}

function MyFeeds({ feeds, media, throwUp, onThrowUp, boomin }: { feeds: SeatFeeds; media: SeatMediaLeg | null; throwUp: ThrowUpState; onThrowUp: (kind: "camera" | "screen") => void; boomin: boolean }) {
  const st = useSeatMedia(media);
  const level = st?.micLevel ?? 0;
  // One row, two windows: the seat is on the set as a whole, but the screen
  // window only reads ON SET while a share is actually going out.
  const screenThrow: ThrowUpState = st?.sharing || throwUp.row !== "on" ? throwUp : { ...throwUp, row: "off", label: "Share + throw up", disabled: false };
  return (
    <section className="mb-feeds" aria-label="My feeds">
      <FeedWindow
        kind="camera"
        granted={feeds.camera}
        stream={media?.localStream() ?? null}
        off={!!st?.cameraOff}
        note={st?.mediaError ?? (st?.sending === "gone" ? "The host's room closed this seat." : null)}
        throwUp={throwUp}
        onThrowUp={() => onThrowUp("camera")}
        mirror
      >
        {feeds.mic && (
          <span className="mb-meter" title={st?.muted ? "Muted" : "Mic level"}>
            <button className={`mb-sw${st?.muted ? " off" : ""}`} onClick={() => media?.toggleMute()} disabled={!media} title={st?.muted ? "Unmute" : "Mute"}>
              {bi.mic}
            </button>
            <span className="mb-meter-track">
              <span className="mb-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </span>
          </span>
        )}
      </FeedWindow>
      <FeedWindow
        kind="screen"
        granted={feeds.screen}
        stream={media?.screenStream() ?? null}
        note={st?.sharing ? null : "Not sharing"}
        throwUp={screenThrow}
        onThrowUp={() => onThrowUp("screen")}
      >
        {feeds.screen && (
          <button className={`mb-sw${st?.sharing ? " on" : ""}`} onClick={() => void media?.toggleShare()} disabled={!media || st?.sending !== "live"} title={st?.sharing ? "Stop sharing" : "Share a screen or window"}>
            {bi.screen} {st?.sharing ? "Stop" : "Share"}
          </button>
        )}
      </FeedWindow>
      {!feeds.any && (
        <div className="mb-feeds-note">
          {boomin ? "The host can give this seat a camera, mic or screen from their Mods panel." : "A mod link on an open server carries no media."}
        </div>
      )}
      <HostAudio stream={media?.hostAudioStream() ?? null} />
    </section>
  );
}

// ── The row of switches ─────────────────────────────────────────────────────

function Switches({ access, host, grants, feeds, media }: { access: RoomAccessInfo; host?: string | null; grants: ReadonlySet<string>; feeds: SeatFeeds; media: SeatMediaLeg | null }) {
  const st = useSeatMedia(media);
  const chips = heldChips({ grants, can: access.can });
  const camOn = feeds.camera && !!media && !st?.cameraOff;
  const micOn = feeds.mic && !!media && !st?.muted;
  const scrOn = feeds.screen && !!st?.sharing;
  return (
    <section className="mb-switches" aria-label="Switches">
      <div className="mb-holds">
        <span className="mb-holds-label">{roleTitle(access, host)}</span>
        {chips.map((c) => (
          <span key={c} className="mb-chip">
            {c}
          </span>
        ))}
        {chips.length === 0 && <span className="mb-chip dim">watches the roster</span>}
      </div>
      <div className="mb-sends">
        <span className="mb-sends-label">sending</span>
        <button className={`mb-sw${camOn ? " on" : ""}`} disabled={!feeds.camera || !media} onClick={() => media?.toggleCamera()} title={!feeds.camera ? ASK_HOST.camera : camOn ? "Stop camera" : "Start camera"}>
          {bi.cam} cam
        </button>
        <button className={`mb-sw${micOn ? " on" : ""}`} disabled={!feeds.mic || !media} onClick={() => media?.toggleMute()} title={!feeds.mic ? "Ask the host for mic" : micOn ? "Mute" : "Unmute"}>
          {bi.mic} mic
        </button>
        <button className={`mb-sw${scrOn ? " on" : ""}`} disabled={!feeds.screen || !media || st?.sending !== "live"} onClick={() => void media?.toggleShare()} title={!feeds.screen ? ASK_HOST.screen : scrOn ? "Stop sharing" : "Share a screen"}>
          {bi.screen} screen
        </button>
        {media && <span className={`mb-send-dot ${st?.sending ?? "starting"}`} title={`Your feed: ${st?.sending ?? "starting"}`} />}
      </div>
    </section>
  );
}

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
  layout: ModBoardLayout;
  error?: string | null;
}

export function ModBoard(p: ModBoardProps) {
  const panel = (id: ModBoardPanel): ReactNode => {
    switch (id) {
      case "monitor":
        return <HostOutput key={id} program={p.program} pending={p.pending} boomin={p.boomin} title={p.title} online={p.online} />;
      case "scenes":
        return (
          <ScenePads
            key={id}
            scenes={p.scenes}
            canCut={p.access.can.scene && !p.pending}
            onCut={p.onCut}
            pending={p.pending}
            vote={p.vote}
            voteLive={!!p.voteLive}
            canVote={p.access.can.interactions}
            onAudienceLink={p.onAudienceLink}
            audienceLink={p.audienceLink}
          />
        );
      case "people":
        return (
          <section key={id} className="mb-people" aria-label="People">
            <h3 className="mb-h">{MOD_BOARD_META.people.title}</h3>
            {p.people}
          </section>
        );
      case "feeds":
        return (
          <section key={id} className="mb-feeds-wrap">
            <h3 className="mb-h">{MOD_BOARD_META.feeds.title}</h3>
            <MyFeeds feeds={p.feeds} media={p.media} throwUp={p.throwUp} onThrowUp={p.onThrowUp} boomin={p.boomin} />
          </section>
        );
      case "switches":
        return <Switches key={id} access={p.access} host={p.host} grants={p.grants} feeds={p.feeds} media={p.media} />;
    }
  };
  const region = (name: keyof ModBoardLayout, cls: string) => {
    const ids = p.layout[name];
    if (name === "hidden" || ids.length === 0) return null;
    return <div className={`mb-region ${cls}`}>{ids.map(panel)}</div>;
  };
  return (
    <div className="modboard" data-region-layout>
      {region("top", "mb-r-top")}
      {region("strip", "mb-r-strip")}
      <div className="mb-columns">
        {region("left", "mb-r-left")}
        {region("right", "mb-r-right")}
      </div>
      {region("bottom", "mb-r-bottom")}
      {p.error && <div className="mb-error">{p.error}</div>}
    </div>
  );
}
