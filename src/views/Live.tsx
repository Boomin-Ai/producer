import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ipc,
  listenLiveEvents,
  type LiveDestination,
  type LiveDestStatus,
  type LivePermissions,
  type LivePreset,
  type LiveSnapshot,
  type LiveSources,
} from "../lib/ipc";

// Transport-truthful copy (M-L4 finding: an RTMP session can look healthy
// while the platform discards it — only the dashboard confirms LIVE).
const PHASE_COPY: Record<string, { label: string; tone: string }> = {
  idle: { label: "Idle", tone: "muted" },
  connecting: { label: "Connecting…", tone: "warn" },
  live: { label: "Sending", tone: "ok" },
  reconnecting: { label: "Reconnecting…", tone: "warn" },
  stopped: { label: "Stopped", tone: "muted" },
};

const PRESETS: { value: LivePreset; label: string; needsServer: boolean }[] = [
  { value: "twitch", label: "Twitch", needsServer: false },
  { value: "kick", label: "Kick", needsServer: true },
  { value: "youtube", label: "YouTube", needsServer: false },
  { value: "custom", label: "Custom RTMP", needsServer: true },
];

function fmtBitrate(bytes: number, secs: number): string {
  if (secs <= 0) return "—";
  const kbps = (bytes * 8) / secs / 1000;
  return kbps > 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

/** Native OBS preview (A6): reserves layout space; the engine overlays an
 * NSView at exactly this rect and keeps it in sync on resize/scroll. */
function PreviewPanel() {
  const ref = useRef<HTMLDivElement | null>(null);
  const attached = useRef(false);

  useEffect(() => {
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(async () => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return;
        try {
          if (!attached.current) {
            await ipc.liveAttachPreview(r.x, r.y, r.width, r.height);
            attached.current = true;
          } else {
            await ipc.liveMovePreview(r.x, r.y, r.width, r.height);
          }
        } catch {
          // engine not ready yet; retry on next layout change
        }
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      if (attached.current) {
        attached.current = false;
        ipc.liveDetachPreview().catch(() => {});
      }
    };
  }, []);

  return <div ref={ref} className="live-preview" />;
}

const PERM_LABEL: Record<string, string> = {
  granted: "Granted",
  denied: "Denied",
  restricted: "Restricted",
  not_determined: "Not asked yet",
  denied_or_not_determined: "Not granted",
  unknown: "Unknown",
};

/** First-run TCC coach (§5.4): explains each permission, fires the prompts,
 * and spells out the Screen Recording toggle + relaunch dance. */
function PermissionsCoach({ sources }: { sources: LiveSources }) {
  const [perms, setPerms] = useState<LivePermissions | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const p = await ipc.livePermissions();
        if (alive) setPerms(p);
      } catch {
        /* engine absent */
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!perms) return null;
  const rows: { kind: "screen" | "camera" | "mic"; label: string; status: string; needed: boolean; hint?: string }[] = [
    {
      kind: "screen",
      label: "Screen Recording",
      status: perms.screen,
      needed: sources.screen,
      hint: "macOS grants this in System Settings › Privacy & Security › Screen & System Audio Recording (add Producer with +, toggle on), then relaunch Producer.",
    },
    { kind: "camera", label: "Camera", status: perms.camera, needed: sources.camera },
    { kind: "mic", label: "Microphone", status: perms.mic, needed: sources.mic },
  ];
  const pending = rows.filter((r) => r.needed && r.status !== "granted");
  if (pending.length === 0) return null;

  return (
    <div className="live-coach">
      <div className="live-coach-title">Permissions needed</div>
      {pending.map((r) => (
        <div key={r.kind} className="live-coach-row">
          <div>
            <strong>{r.label}</strong> · {PERM_LABEL[r.status] ?? r.status}
            {r.hint && <div className="live-coach-hint">{r.hint}</div>}
          </div>
          <button onClick={() => ipc.liveRequestPermission(r.kind)}>
            {r.kind === "screen" ? "Request" : "Allow…"}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Overlay via window capture — D1's sanctioned v1 escape hatch while CEF
 * overlays (M-L7.1) are built. Run the overlay page in a browser window; a
 * green background + the color-key option composites it like a real overlay. */
function OverlayPicker({ activeWindow, activeUrl }: { activeWindow: number | null; activeUrl: string | null }) {
  const [mode, setMode] = useState<"window" | "browser">(activeUrl ? "browser" : "window");
  const [url, setUrl] = useState(activeUrl ?? "");
  const [windows, setWindows] = useState<{ id: number; owner: string; title: string }[]>([]);
  const [selected, setSelected] = useState<number | "">("");
  const [colorKey, setColorKey] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWindows(await ipc.liveListWindows());
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const active = activeWindow != null || activeUrl != null;
  return (
    <div className="live-overlay">
      <div className="live-overlay-row">
        <button className={mode === "window" ? "primary" : ""} onClick={() => setMode("window")}>
          Window capture
        </button>
        <button className={mode === "browser" ? "primary" : ""} onClick={() => setMode("browser")}>
          Browser (URL)
        </button>
      </div>
      {mode === "window" ? (
        <>
          <div className="live-overlay-row">
            <select value={selected} onChange={(e) => setSelected(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">Choose a window…</option>
              {windows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.owner}
                  {w.title ? ` — ${w.title}` : ""}
                </option>
              ))}
            </select>
            <button onClick={load} title="Refresh window list">
              ↻
            </button>
          </div>
          <label className="live-overlay-key">
            <input type="checkbox" checked={colorKey} onChange={(e) => setColorKey(e.target.checked)} />
            Green-screen it (key out a green page background)
          </label>
        </>
      ) : (
        <input
          placeholder="Overlay URL (https://… — needs the CEF-capable engine)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      )}
      <div className="live-editor-row">
        <button
          className="primary"
          disabled={mode === "window" ? selected === "" : url.trim() === ""}
          onClick={async () => {
            setError(null);
            try {
              if (mode === "window") {
                await ipc.liveSetOverlay(selected as number, colorKey);
              } else {
                await ipc.liveSetOverlay(null, false, url.trim());
              }
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          {active ? "Replace overlay" : "Set overlay"}
        </button>
        {active && <button onClick={() => ipc.liveSetOverlay(null, false).catch(() => {})}>Clear overlay</button>}
      </div>
      {error && <div className="live-error">{error}</div>}
    </div>
  );
}

/* Icon set lifted from the Boomin Live room mocks. */
const ic = {
  mic: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </svg>
  ),
  cam: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10l5-3v10l-5-3" />
      <rect x="2" y="6" width="13" height="12" rx="2" />
    </svg>
  ),
  screen: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M12 11V8M10 9.5l2-1.5 2 1.5M8 21h8" />
    </svg>
  ),
  link: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  ),
  invite: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  ),
  plus: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  gear: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  eye: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  chev: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  onair: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" />
      <path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8" />
    </svg>
  ),
  cast: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <path d="M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01" />
    </svg>
  ),
  x: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  chat: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
};

/** Mock-faithful slim fader: 4px track, white 26×14 thumb, pointer drag. */
function Fader({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (ui: number) => void }) {
  const track = useRef<HTMLDivElement | null>(null);

  function fromEvent(e: { clientY: number }) {
    const el = track.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ui = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    onChange(ui);
  }

  return (
    <div
      ref={track}
      className={`rm-fader${disabled ? " disabled" : ""}`}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        fromEvent(e);
      }}
      onPointerMove={(e) => {
        if (disabled || e.buttons !== 1) return;
        fromEvent(e);
      }}
    >
      <div className="rm-fader-track" />
      <div className="rm-fader-thumb" style={{ top: `calc(${(1 - value) * 100}% - 7px)` }} />
    </div>
  );
}

/** Vertical meter + fader strip, straight from the sources-sheet mock. */
function MeterStrip({
  label,
  icon,
  level,
  volume,
  muted,
  disabled,
  soon,
  onVolume,
  onMute,
}: {
  label: string;
  icon: ReactNode;
  level: number;
  volume: number;
  muted: boolean;
  disabled?: boolean;
  soon?: boolean;
  onVolume?: (mul: number) => void;
  onMute?: () => void;
}) {
  const ui = Math.cbrt(Math.max(0, Math.min(1, volume)));
  const db = volume > 0.001 ? Math.round(20 * Math.log10(volume)) : -60;
  const dead = disabled || soon;
  return (
    <div className={`rm-strip${dead ? " dead" : ""}`} title={soon ? "Desktop audio arrives soon" : undefined}>
      <div className="rm-strip-cols">
        <div className="rm-meter">
          <div className="rm-meter-fill" style={{ height: `${Math.round((dead || muted ? 0 : level) * 100)}%` }} />
        </div>
        <Fader value={dead ? 0.35 : ui} disabled={dead} onChange={(u) => onVolume?.(u * u * u)} />
      </div>
      <span className="rm-strip-db">{soon ? "soon" : muted ? "muted" : `${db <= -60 ? "-∞" : db} dB`}</span>
      <button className={`rm-strip-icon${muted ? " muted" : ""}`} disabled={dead} onClick={onMute} title={muted ? "Unmute" : "Mute"}>
        {icon}
      </button>
      <span className="rm-strip-name">{label}</span>
    </div>
  );
}

/** Day-one chat: platform popout chat in a compact companion window.
 * Channel names are remembered locally — no OAuth involved. */
function ChatPopover({ onClose }: { onClose: () => void }) {
  const [twitch, setTwitch] = useState(() => localStorage.getItem("producer.chat.twitch") ?? "");
  const [kick, setKick] = useState(() => localStorage.getItem("producer.chat.kick") ?? "");
  const [error, setError] = useState<string | null>(null);

  async function open(url: string, storeKey: string, value: string) {
    try {
      localStorage.setItem(storeKey, value.trim());
      await ipc.liveOpenChat(url);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="st-chat-pop">
      <div className="st-chat-row">
        <span className="st-chat-label">Twitch</span>
        <input
          value={twitch}
          onChange={(e) => setTwitch(e.target.value)}
          placeholder="channel name"
        />
        <button
          disabled={!twitch.trim()}
          onClick={() =>
            open(
              `https://www.twitch.tv/popout/${encodeURIComponent(twitch.trim().toLowerCase())}/chat`,
              "producer.chat.twitch",
              twitch,
            )
          }
        >
          Open
        </button>
      </div>
      <div className="st-chat-row">
        <span className="st-chat-label">Kick</span>
        <input value={kick} onChange={(e) => setKick(e.target.value)} placeholder="channel name" />
        <button
          disabled={!kick.trim()}
          onClick={() =>
            open(
              `https://kick.com/popout/${encodeURIComponent(kick.trim().toLowerCase())}/chat`,
              "producer.chat.kick",
              kick,
            )
          }
        >
          Open
        </button>
      </div>
      <div className="st-chat-hint">
        Opens the platform&rsquo;s own chat in a small window — sign in once, it remembers you.
      </div>
      {error && <div className="live-error">{error}</div>}
    </div>
  );
}

export function DestinationEditor({
  existing,
  onSaved,
  onCancel,
}: {
  existing: LiveDestination | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [preset, setPreset] = useState<LivePreset>(existing?.preset ?? "twitch");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [server, setServer] = useState(existing?.server ?? "");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const needsServer = PRESETS.find((p) => p.value === preset)?.needsServer ?? false;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await ipc.liveUpsertDestination({
        id: existing?.id,
        preset,
        label: label.trim() || PRESETS.find((p) => p.value === preset)!.label,
        server: needsServer ? server.trim() : undefined,
        // The key leaves this component exactly once, straight to the
        // keychain. It is never readable back.
        key: key.trim() ? key.trim() : undefined,
      });
      setKey("");
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="live-editor">
      <div className="live-editor-row">
        <select value={preset} onChange={(e) => setPreset(e.target.value as LivePreset)} disabled={!!existing}>
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {needsServer && (
        <input
          placeholder={preset === "kick" ? "Kick ingest URL (rtmps://…live-video.net/)" : "rtmp(s)://server/app"}
          value={server ?? ""}
          onChange={(e) => setServer(e.target.value)}
        />
      )}
      <input
        type="password"
        placeholder={existing ? "Stream key (stored — paste to replace)" : "Stream key"}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
      />
      {error && <div className="live-error">{error}</div>}
      <div className="live-editor-row">
        <button className="primary" onClick={save} disabled={saving}>
          {existing ? "Save" : "Add destination"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export interface RoomInfo {
  id: string;
  name: string;
  config: string;
}

export function LiveView({
  room,
  rooms = [],
  onLeave,
  onSwitchRoom,
}: {
  room?: RoomInfo;
  rooms?: RoomInfo[];
  onLeave?: () => void;
  onSwitchRoom?: (room: RoomInfo) => void;
}) {
  const [destinations, setDestinations] = useState<LiveDestination[]>([]);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [statuses, setStatuses] = useState<Map<string, LiveDestStatus>>(new Map());
  const [elapsed, setElapsed] = useState(0);
  const [editing, setEditing] = useState<LiveDestination | null>(null);
  const [adding, setAdding] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [sources, setSources] = useState<LiveSources>({ screen: false, camera: false, mic: false });
  const [micLevel, setMicLevel] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [destsOpen, setDestsOpen] = useState(false);
  const [micPopOpen, setMicPopOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const sheetAutoOpened = useRef(false);
  const unlisten = useRef<(() => void) | null>(null);
  const roomApplied = useRef(false);
  const roomId = room?.id ?? null;

  const refresh = useCallback(async () => {
    setDestinations(await ipc.liveListDestinations());
    const snap = await ipc.liveEngineStatus();
    setSnapshot(snap);
    if (snap.sources) setSources(snap.sources);
    // Opening a room applies its saved scene — but never over a live
    // session (switching rooms mid-stream adopts the running scene).
    if (room && !roomApplied.current && snap.engine_ready && snap.session_state === "idle") {
      roomApplied.current = true;
      try {
        const cfg = JSON.parse(room.config || "{}") as Partial<LiveSources>;
        if (typeof cfg.screen === "boolean") {
          await ipc.liveSetSources(cfg.screen, cfg.camera ?? false, cfg.mic ?? false);
          if (cfg.mic_volume != null || cfg.mic_muted != null) {
            await ipc.liveSetMicAudio({ volume: cfg.mic_volume, muted: cfg.mic_muted });
          }
          if (cfg.overlay_window != null || cfg.overlay_url) {
            await ipc.liveSetOverlay(cfg.overlay_window ?? null, true, cfg.overlay_url ?? null);
          }
          setSources((s) => ({ ...s, ...cfg }));
        }
      } catch {
        /* malformed config — start clean */
      }
    }
    // A room with nothing configured greets you with the sources sheet.
    if (!sheetAutoOpened.current) {
      sheetAutoOpened.current = true;
      const s = snap.sources;
      if (snap.engine_ready && s && !s.screen && !s.camera && !s.mic) setSheetOpen(true);
    }
  }, [room]);

  useEffect(() => {
    refresh();
    listenLiveEvents((ev) => {
      if (ev.type === "status") {
        setElapsed(ev.elapsed_secs);
        setStatuses(new Map(ev.destinations.map((d) => [d.id, d])));
      } else if (ev.type === "session_state") {
        setSnapshot((s) => (s ? { ...s, session_state: ev.state } : s));
        if (ev.state === "idle") setBanner(null);
      } else if (ev.type === "session_ended") {
        setStatuses(new Map(ev.report.destinations.map((d) => [d.id, d])));
        if (!ev.report.ok && ev.report.notes.length > 0) setBanner(ev.report.notes.join(" · "));
      } else if (ev.type === "sources_changed") {
        setSources(ev.sources);
        // The room document follows the scene: every source/overlay change
        // is persisted so reopening the room restores it.
        if (roomId) {
          ipc.liveUpdateRoom(roomId, { config: JSON.stringify(ev.sources) }).catch(() => {});
        }
      } else if (ev.type === "levels") {
        // peak → dB → 0..1 over a 50dB window, with a falling ballistic.
        const db = ev.mic_peak > 0.00001 ? 20 * Math.log10(ev.mic_peak) : -60;
        const pct = Math.max(0, Math.min(1, (db + 50) / 50));
        setMicLevel((prev) => Math.max(pct, prev * 0.78));
      } else if (ev.type === "engine_error") {
        setBanner(ev.message);
      } else if (ev.type === "engine_ready" && !ev.ok) {
        setBanner("Live engine failed to initialize — see engine report.");
      }
    }).then((un) => {
      unlisten.current = un;
    });
    return () => {
      unlisten.current?.();
    };
  }, [refresh, roomId]);

  const state = snapshot?.session_state ?? "idle";
  const streaming = state === "streaming" || state === "starting" || state === "stopping";
  const engineOk = snapshot?.engine_ready && snapshot?.bootstrap_ok;

  async function toggleEnabled(d: LiveDestination) {
    await ipc.liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, enabled: !d.enabled });
    refresh();
  }

  async function goLive() {
    setBanner(null);
    try {
      await ipc.liveGoLive();
      if (roomId) ipc.liveUpdateRoom(roomId, { touchLive: true }).catch(() => {});
    } catch (e) {
      setBanner(String(e));
    }
  }

  async function setSrc(patch: Partial<Pick<LiveSources, "screen" | "camera" | "mic">>) {
    const next = { ...sources, ...patch };
    setSources(next);
    try {
      await ipc.liveSetSources(next.screen, next.camera, next.mic);
    } catch (e) {
      setBanner(String(e));
    }
  }

  const overlayActive = sources.overlay_window != null || !!sources.overlay_url;
  const enabledDests = destinations.filter((d) => d.enabled);
  const destChip =
    enabledDests.length > 0 ? enabledDests.map((d) => d.label).join(" + ") : "Add channels";

  // The mock's scenes are real presets over the implicit scene.
  const scenePresets: { key: string; label: string; screen: boolean; camera: boolean }[] = [
    { key: "pip", label: "PiP", screen: true, camera: true },
    { key: "cam", label: "Full cam", screen: false, camera: true },
    { key: "screen", label: "Screen", screen: true, camera: false },
  ];
  const activeScene = scenePresets.find(
    (p) => p.screen === sources.screen && p.camera === sources.camera,
  )?.key;

  const setVolume = (v: number) => {
    setSources((s) => ({ ...s, mic_volume: v }));
    ipc.liveSetMicAudio({ volume: v }).catch((e) => setBanner(String(e)));
  };
  const toggleMute = () => {
    const m = !(sources.mic_muted ?? false);
    setSources((s) => ({ ...s, mic_muted: m }));
    ipc.liveSetMicAudio({ muted: m }).catch((e) => setBanner(String(e)));
  };

  const closePops = () => {
    setRoomsOpen(false);
    setDestsOpen(false);
    setMicPopOpen(false);
    setOverlayOpen(false);
    setChatOpen(false);
  };
  const anyPop = roomsOpen || destsOpen || micPopOpen || overlayOpen || chatOpen;

  const micStrip = (
    <MeterStrip
      label="Mic"
      icon={ic.mic}
      level={micLevel}
      volume={sources.mic_volume ?? 1}
      muted={sources.mic_muted ?? false}
      disabled={!sources.mic}
      onVolume={setVolume}
      onMute={toggleMute}
    />
  );

  return (
    <div className="room">
      {anyPop && <div className="rm-pop-backdrop" onClick={closePops} />}

      <header className="rm-top" data-tauri-drag-region>
        <div className="rm-top-left" data-tauri-drag-region>
          <span className="rm-brand" data-tauri-drag-region>
            PRODUCER
          </span>
          <div className="rm-pop-anchor">
            <button className="rm-room-chip" onClick={() => setRoomsOpen((o) => !o)}>
              {room?.name ?? "Live"}
              {ic.chev}
            </button>
            {roomsOpen && (
              <div className="rm-pop rm-pop-left">
                {rooms
                  .filter((r) => r.id !== room?.id)
                  .map((r) => (
                    <button
                      key={r.id}
                      className="rm-pop-row"
                      onClick={() => {
                        closePops();
                        onSwitchRoom?.(r);
                      }}
                    >
                      {r.name}
                    </button>
                  ))}
                <button className="rm-pop-row dim" onClick={() => onLeave?.()}>
                  ← Control room
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="rm-top-right">
          <div className="rm-pop-anchor">
            <button className="rm-chip" onClick={() => setDestsOpen((o) => !o)} title="Live channels">
              {ic.cast}
              <span>{destChip}</span>
            </button>
            {destsOpen && (
              <div className="rm-pop rm-pop-right rm-pop-dests">
                {destinations.map((d) => {
                  const st = statuses.get(d.id);
                  const phase = st ? PHASE_COPY[st.phase] ?? PHASE_COPY.idle : PHASE_COPY.idle;
                  return (
                    <div key={d.id} className={`rm-dest-row${d.enabled ? "" : " off"}`}>
                      <span className={`live-dot ${streaming && st ? phase.tone : d.enabled ? "ready" : "muted"}`} />
                      <span className="rm-dest-name">{d.label}</span>
                      <span className="rm-dest-sub">
                        {streaming && st
                          ? `${phase.label}${st.phase === "live" ? ` · ${fmtBitrate(st.bytes_sent, elapsed)}` : ""}${st.dropped_frames > 0 ? ` · ${st.dropped_frames} drop` : ""}`
                          : d.preset}
                      </span>
                      {!streaming && (
                        <>
                          <button className="rm-mini" onClick={() => toggleEnabled(d)}>
                            {d.enabled ? "On" : "Off"}
                          </button>
                          <button className="rm-mini" onClick={() => setEditing(d)}>
                            Edit
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
                {!streaming && (
                  <button className="rm-pop-row dim" onClick={() => setAdding(true)}>
                    + Add channel
                  </button>
                )}
              </div>
            )}
          </div>

          <span className="rm-chip rm-chip-static" title="Encoder controls arrive with custom encoding">
            LIVE STREAM · 720P
          </span>

          {streaming ? (
            <button className="rm-golive stop" onClick={() => ipc.liveStop()} disabled={state === "stopping"}>
              {ic.onair}
              {state === "stopping"
                ? "Stopping…"
                : `Stop · ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}
            </button>
          ) : (
            <button className="rm-golive" onClick={goLive} disabled={!engineOk || enabledDests.length === 0}>
              {ic.onair}
              Go Live
            </button>
          )}

          <button className="rm-leave" onClick={() => onLeave?.()} title="Leave room">
            {ic.x}
          </button>
        </div>
      </header>

      <div className="rm-body">
        <aside className="rm-scenes">
          <button className="rm-addscene" title="Custom scenes arrive with the scene editor" disabled>
            + Add scene
          </button>
          {scenePresets.map((p) => (
            <button
              key={p.key}
              className={`rm-scene${activeScene === p.key ? " active" : ""}`}
              disabled={!engineOk}
              onClick={() => setSrc({ screen: p.screen, camera: p.camera })}
            >
              <span className={`rm-scene-thumb ${p.key}`}>
                {p.key !== "cam" && <span className="rm-scene-main" />}
                {p.key !== "screen" && <span className={`rm-scene-cam${p.key === "cam" ? " full" : ""}`} />}
              </span>
              <span className="rm-scene-name">{p.label}</span>
            </button>
          ))}
          <span className="rm-scenes-note">Cuts hit the broadcast instantly.</span>
        </aside>

        <div className="rm-center">
          <div className="rm-canvas">
            {engineOk && <PreviewPanel />}
            {!engineOk && snapshot && (
              <div className="rm-canvas-msg">
                {snapshot.disabled ? "Live engine not bundled in this build." : "Warming up the engine…"}
              </div>
            )}
          </div>

          <div className="rm-float">
            <PermissionsCoach sources={sources} />
            {banner && <div className="live-error">{banner}</div>}
          </div>

          <div className="rm-pills">
            <div className="rm-pop-anchor">
              <div className={`rm-pill${sources.mic ? "" : " off"}`}>
                <button
                  className="rm-pill-main"
                  disabled={!engineOk}
                  onClick={() => setSrc({ mic: !sources.mic })}
                  title={sources.mic ? "Mic on — click to turn off" : "Mic off — click to turn on"}
                >
                  {ic.mic}
                </button>
                <button className="rm-pill-chev" onClick={() => setMicPopOpen((o) => !o)}>
                  {ic.chev}
                </button>
              </div>
              {micPopOpen && <div className="rm-pop rm-pop-up rm-pop-mixer">{micStrip}</div>}
            </div>

            <button
              className={`rm-circle${sources.camera ? "" : " off"}`}
              disabled={!engineOk}
              onClick={() => setSrc({ camera: !sources.camera })}
              title={sources.camera ? "Camera on" : "Camera off"}
            >
              {ic.cam}
            </button>

            <button
              className={`rm-circle${sources.screen ? "" : " off"}`}
              disabled={!engineOk}
              onClick={() => setSrc({ screen: !sources.screen })}
              title={sources.screen ? "Screen share on" : "Share your screen"}
            >
              {ic.screen}
            </button>

            <button className="rm-circle off soon" title="Guests arrive with the Producer network" disabled>
              {ic.invite}
            </button>

            <div className="rm-pop-anchor">
              <button
                className={`rm-circle${overlayActive ? "" : " off"}`}
                onClick={() => setOverlayOpen((o) => !o)}
                title="Overlay — alerts, browser, window"
              >
                {ic.plus}
              </button>
              {overlayOpen && (
                <div className="rm-pop rm-pop-up rm-pop-overlay">
                  <OverlayPicker
                    activeWindow={sources.overlay_window ?? null}
                    activeUrl={sources.overlay_url ?? null}
                  />
                </div>
              )}
            </div>

            <div className="rm-pop-anchor">
              <button className={`rm-circle${chatOpen ? "" : " off"}`} onClick={() => setChatOpen((o) => !o)} title="Chat">
                {ic.chat}
              </button>
              {chatOpen && (
                <div className="rm-pop rm-pop-up">
                  <ChatPopover onClose={() => setChatOpen(false)} />
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="rm-rail">
          <button className={`rm-rail-item${sheetOpen ? " active" : ""}`} onClick={() => setSheetOpen((o) => !o)}>
            {ic.invite}
            <span>Sources</span>
          </button>
          <button className={`rm-rail-item${overlayActive ? " active" : ""}`} onClick={() => setOverlayOpen(true)}>
            {ic.link}
            <span>Graphics</span>
          </button>
          <div className="rm-rail-item soon">
            <span className="rm-soon">SOON</span>
            {ic.plus}
            <span>Widgets</span>
          </div>
          <div className="rm-rail-item soon">
            <span className="rm-soon">SOON</span>
            {ic.chat}
            <span>Music</span>
          </div>
        </aside>
      </div>

      {(adding || editing) && (
        <>
          <div className="rm-pop-backdrop" onClick={() => (setAdding(false), setEditing(null))} />
          <div className="rm-editor">
            <DestinationEditor
              existing={editing}
              onSaved={() => {
                setAdding(false);
                setEditing(null);
                refresh();
              }}
              onCancel={() => {
                setAdding(false);
                setEditing(null);
              }}
            />
          </div>
        </>
      )}

      {sheetOpen && (
        <div className="rm-sheet">
          <div className="rm-sheet-head">
            <span className="rm-sheet-handle" />
            <button className="rm-sheet-label" onClick={() => setSheetOpen(false)}>
              SOURCES{activeScene ? ` · ${scenePresets.find((p) => p.key === activeScene)?.label.toUpperCase()} SCENE` : ""}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" transform="rotate(180 12 12)" />
              </svg>
            </button>
          </div>
          <div className="rm-sheet-body">
            <div className="rm-tiles">
              <button
                className={`rm-tile${sources.screen ? " on" : ""}`}
                disabled={!engineOk}
                onClick={() => setSrc({ screen: !sources.screen })}
              >
                <span className="rm-tile-canvas">{ic.screen}</span>
                <span className="rm-tile-row">
                  <span>Screen</span>
                  <span className="rm-eye">{ic.eye}</span>
                </span>
              </button>
              <button
                className={`rm-tile${sources.camera ? " on" : ""}`}
                disabled={!engineOk}
                onClick={() => setSrc({ camera: !sources.camera })}
              >
                <span className="rm-tile-canvas">{ic.cam}</span>
                <span className="rm-tile-row">
                  <span>Camera</span>
                  <span className="rm-eye">{ic.eye}</span>
                </span>
              </button>
              <button className={`rm-tile${overlayActive ? " on" : ""}`} onClick={() => setOverlayOpen(true)}>
                <span className="rm-tile-canvas">{ic.link}</span>
                <span className="rm-tile-row">
                  <span>Alerts</span>
                  <span className="rm-eye">{ic.eye}</span>
                </span>
              </button>
            </div>
            <div className="rm-sheet-div" />
            <div className="rm-strips">
              {micStrip}
              <MeterStrip label="Desktop" icon={ic.cast} level={0} volume={0.5} muted soon />
            </div>
            <div className="rm-sheet-div" />
            <button className="rm-addsource" title="More source types arrive with the scene editor" disabled>
              {ic.plus}
              <span>Add source</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
