import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { DEMO_ALERTS, DEMO_CHAT, DEMO_VIDEO_URL, demoOn, type DemoChatMsg, type DemoPlatform } from "../lib/demo";
import {
  PANEL_META,
  PANEL_ORDER,
  PRESETS as LAYOUT_PRESETS,
  dockOf,
  movePanel,
  movePanelTo,
  saveLayout,
  type Dock,
  type Layout,
  type PanelId,
} from "../lib/layout";
import {
  DEFAULT_SCENES,
  markLiveRoom,
  parseConfig,
  serializeConfig,
  type RoomConfig,
  type RoomScene,
} from "../lib/room";

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
            // The attach call itself reports whether the stage can be a
            // transparent hole (preview behind the webview) — no polling.
            const transparent = await ipc.liveAttachPreview(r.x, r.y, r.width, r.height);
            attached.current = true;
            document.documentElement.dataset.stage = transparent ? "transparent" : "opaque";
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

/** Permission state lives with the controls, not over the canvas: a slim
 * dark banner above the pills, one line per missing grant. Screen uses the
 * First Light machinery (Settings deep-link + native drag chip). */
function PermBanner({ sources }: { sources: LiveSources }) {
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
  const rows: { kind: "screen" | "camera" | "mic"; label: string; status: string; needed: boolean }[] = [
    { kind: "screen", label: "Screen recording", status: perms.screen, needed: sources.screen },
    { kind: "camera", label: "Camera", status: perms.camera, needed: sources.camera },
    { kind: "mic", label: "Microphone", status: perms.mic, needed: sources.mic },
  ];
  const pending = rows.filter((r) => r.needed && r.status !== "granted");
  if (pending.length === 0) return null;

  return (
    <div className="rm-perms">
      {pending.map((r) => (
        <div key={r.kind} className="rm-perm-row">
          <span className="rm-perm-dot" />
          <span className="rm-perm-text">
            {r.label} isn&rsquo;t granted{r.kind === "screen" ? " — drag the chip in, then relaunch" : ""}
          </span>
          <button
            className="rm-perm-fix"
            onClick={() => {
              if (r.kind === "screen") {
                ipc.liveScreenCoach("open_settings").catch(() => {});
                ipc.liveScreenCoach("chip_show").catch(() => {});
              } else {
                ipc.liveRequestPermission(r.kind).catch(() => {});
              }
            }}
          >
            {r.kind === "screen" ? "Fix in Settings" : "Allow"}
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
  collapseDown: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M8 11l4 4 4-4M12 15V9" />
    </svg>
  ),
  grip: (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
      <circle cx="3.5" cy="3" r="1.3" /><circle cx="8.5" cy="3" r="1.3" />
      <circle cx="3.5" cy="7" r="1.3" /><circle cx="8.5" cy="7" r="1.3" />
      <circle cx="3.5" cy="11" r="1.3" /><circle cx="8.5" cy="11" r="1.3" />
    </svg>
  ),
  dots: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
    </svg>
  ),
  layout: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M9 14h12" />
    </svg>
  ),
  chevRight: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  collapse: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  sliders: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </svg>
  ),
  ext: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  ),
};

const PLATFORM_TINT: Record<string, string> = {
  twitch: "#a970ff",
  kick: "#53fc18",
  youtube: "#ff4e45",
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
  onToggle,
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
  onToggle?: () => void;
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
      <span className="rm-strip-db">{soon ? "soon" : disabled ? "off" : muted ? "muted" : `${db <= -60 ? "-∞" : db} dB`}</span>
      <button className={`rm-strip-icon${muted ? " muted" : ""}`} disabled={dead} onClick={onMute} title={muted ? "Unmute" : "Mute"}>
        {icon}
      </button>
      {onToggle ? (
        <button
          className={`rm-strip-name as-toggle${disabled ? " off" : ""}`}
          onClick={onToggle}
          title={disabled ? `Turn ${label.toLowerCase()} on` : `Turn ${label.toLowerCase()} off`}
        >
          {label}
        </button>
      ) : (
        <span className="rm-strip-name">{label}</span>
      )}
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
  const [sheetOpen, setSheetOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [micPopOpen, setMicPopOpen] = useState(false);
  const [destsOpen, setDestsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [panelMenu, setPanelMenu] = useState<PanelId | null>(null);
  const [layoutMenu, setLayoutMenu] = useState(false);
  const [layoutEdit, setLayoutEdit] = useState(false);
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [dropHint, setDropHint] = useState<{ dock: Dock; index: number } | null>(null);
  const [addMenu, setAddMenu] = useState<Dock | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  // The room document: dock layout, scenes, channel selection, scene state.
  const [cfg, setCfgState] = useState<RoomConfig>(() => parseConfig(room?.config));
  // Event handlers registered once must not close over a stale document.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const layout = cfg.layout;
  const writeCfg = (next: RoomConfig) => {
    setCfgState(next);
    if (room) ipc.liveUpdateRoom(room.id, { config: serializeConfig(next) }).catch(() => {});
    else saveLayout(next.layout);
  };
  const setLayout = (l: Layout) => writeCfg({ ...cfg, layout: l });
  const scenes: RoomScene[] = cfg.scenes.length ? cfg.scenes : DEFAULT_SCENES;
  const [overlayOpen, setOverlayOpen] = useState(false);
  const videoApplied = useRef(false);
  const channelsApplied = useRef(false);
  const demoVideoSet = useRef(false);
  const demo = demoOn();
  const [chatFilter, setChatFilter] = useState<"all" | DemoPlatform>("all");
  const [chatMsgs, setChatMsgs] = useState<DemoChatMsg[]>(() => (demoOn() ? DEMO_CHAT.slice(0, 9) : []));
  const [chatDraft, setChatDraft] = useState("");
  const chatEnd = useRef<HTMLDivElement | null>(null);

  // Demo liveness: the chat keeps talking.
  useEffect(() => {
    if (!demo) return;
    let i = 0;
    const t = setInterval(
      () => {
        setChatMsgs((m) => [...m.slice(-59), DEMO_CHAT[(9 + i++) % DEMO_CHAT.length]]);
      },
      3800 + Math.random() * 2400,
    );
    return () => clearInterval(t);
  }, [demo]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMsgs]);
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
      const saved = parseConfig(room.config).sources;
      if (typeof saved.screen === "boolean") {
        await ipc.liveSetSources(saved.screen, saved.camera ?? false, saved.mic ?? false);
        if (saved.mic_volume != null || saved.mic_muted != null) {
          await ipc.liveSetMicAudio({ volume: saved.mic_volume, muted: saved.mic_muted });
        }
        if (saved.overlay_window != null || saved.overlay_url) {
          await ipc.liveSetOverlay(saved.overlay_window ?? null, true, saved.overlay_url ?? null);
        }
        setSources((s) => ({ ...s, ...saved }));
      }
    }
    // Stored video settings (global, OBS-style) re-apply when idle.
    if (!videoApplied.current && snap.engine_ready && snap.session_state === "idle") {
      videoApplied.current = true;
      try {
        const stored = JSON.parse(localStorage.getItem("producer.video") ?? "null") as {
          h: number;
          f: number;
        } | null;
        if (stored && (stored.h !== (snap.video_height || 720) || stored.f !== (snap.video_fps || 30))) {
          await ipc.liveSetVideo(stored.h, stored.f);
        }
      } catch {
        /* bad stored value — engine default stands */
      }
    }
    // Channel selection from the room document → engine flags.
    if (!channelsApplied.current && room) {
      channelsApplied.current = true;
      const want = parseConfig(room.config).channels;
      if (Object.keys(want).length) {
        for (const d of await ipc.liveListDestinations()) {
          const target = want[d.id];
          if (typeof target === "boolean" && target !== d.enabled) {
            await ipc
              .liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, enabled: target })
              .catch(() => {});
          }
        }
        setDestinations(await ipc.liveListDestinations());
      }
    }
    // Demo mode: put real gameplay footage on the canvas via the CEF
    // browser source, so the room never demos black.
    if (
      demo &&
      !demoVideoSet.current &&
      snap.engine_ready &&
      snap.bootstrap_ok &&
      snap.session_state === "idle" &&
      snap.sources &&
      snap.sources.overlay_window == null &&
      !snap.sources.overlay_url
    ) {
      demoVideoSet.current = true;
      ipc.liveSetOverlay(null, false, DEMO_VIDEO_URL).catch(() => {});
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
        markLiveRoom(null);
        setStatuses(new Map(ev.report.destinations.map((d) => [d.id, d])));
        if (!ev.report.ok && ev.report.notes.length > 0) setBanner(ev.report.notes.join(" · "));
      } else if (ev.type === "sources_changed") {
        setSources(ev.sources);
        // The room document follows the scene, without disturbing the rest
        // of the document (layout, scenes, channels).
        if (roomId) {
          const next = { ...cfgRef.current, sources: ev.sources };
          cfgRef.current = next;
          setCfgState(next);
          ipc.liveUpdateRoom(roomId, { config: serializeConfig(next) }).catch(() => {});
        }
      } else if (ev.type === "video_changed") {
        setSnapshot((s) => (s ? { ...s, video_height: ev.height, video_fps: ev.fps } : s));
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

  /** Channel selection is part of the room document; opening a room pushes
   * it to the engine's destination flags so go-live stays honest. */
  async function toggleEnabled(d: LiveDestination) {
    writeCfg({ ...cfg, channels: { ...cfg.channels, [d.id]: !d.enabled } });
    await ipc.liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, enabled: !d.enabled });
    refresh();
  }

  async function goLive() {
    setBanner(null);
    try {
      await ipc.liveGoLive();
      if (roomId) {
        ipc.liveUpdateRoom(roomId, { touchLive: true }).catch(() => {});
        markLiveRoom(roomId);
      }
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

  const activeScene = scenes.find((p) => p.screen === sources.screen && p.camera === sources.camera)?.id;

  const addScene = () => {
    const n = scenes.length + 1;
    const next: RoomScene = {
      id: `s${Date.now().toString(36)}`,
      name: `Scene ${n}`,
      screen: sources.screen,
      camera: sources.camera,
    };
    writeCfg({ ...cfg, scenes: [...scenes, next] });
  };

  const removeScene = (id: string) => writeCfg({ ...cfg, scenes: scenes.filter((s) => s.id !== id) });

  const destChip =
    enabledDests.length > 0 ? enabledDests.map((d) => d.label).join(" + ") : "Add channels";

  const setVolume = (v: number) => {
    setSources((s) => ({ ...s, mic_volume: v }));
    ipc.liveSetMicAudio({ volume: v }).catch((e) => setBanner(String(e)));
  };
  const toggleMute = () => {
    const m = !(sources.mic_muted ?? false);
    setSources((s) => ({ ...s, mic_muted: m }));
    ipc.liveSetMicAudio({ muted: m }).catch((e) => setBanner(String(e)));
  };

  const vh = snapshot?.video_height || 720;
  const vf = snapshot?.video_fps || 30;
  async function setVideoCfg(h: number, f: number) {
    try {
      await ipc.liveSetVideo(h, f);
      localStorage.setItem("producer.video", JSON.stringify({ h, f }));
    } catch (e) {
      setBanner(String(e));
    }
  }

  const closePops = () => {
    setRoomsOpen(false);
    setDestsOpen(false);
    setQualityOpen(false);
    setPanelMenu(null);
    setLayoutMenu(false);
    setAddMenu(null);
    setMicPopOpen(false);
    setOverlayOpen(false);
    setChatOpen(false);
  };
  const anyPop =
    roomsOpen || destsOpen || qualityOpen || micPopOpen || overlayOpen || chatOpen || panelMenu !== null || layoutMenu || addMenu !== null || adding || !!editing;

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
      onToggle={() => setSrc({ mic: !sources.mic })}
    />
  );


  // ── Panels: everything that isn't the stage is a dockable panel ────────
  const panelBody = (id: PanelId) => {
    switch (id) {
      case "scenes":
        return (
          <div className="rm-scenes">
            {scenes.map((p, i) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                className={`rm-scene-row${activeScene === p.id ? " active" : ""}${activeScene === p.id && streaming ? " onair" : ""}`}
                onClick={() => engineOk && setSrc({ screen: p.screen, camera: p.camera })}
                onKeyDown={(e) => e.key === "Enter" && engineOk && setSrc({ screen: p.screen, camera: p.camera })}
              >
                <span className="rm-scene-chev">{ic.chevRight}</span>
                <span className="rm-scene-icon">{ic.screen}</span>
                <span className="rm-scene-name">{p.name}</span>
                {activeScene === p.id ? (
                  <>
                    <span className="rm-scene-live">{streaming ? "Live" : "On"}</span>
                    <span className="rm-scene-rec" />
                  </>
                ) : (
                  <>
                    <span className="rm-scene-key">{i < 9 ? `⌘${i + 1}` : ""}</span>
                    {!DEFAULT_SCENES.some((d) => d.id === p.id) && (
                      <button
                        className="rm-scene-x"
                        title="Remove scene"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeScene(p.id);
                        }}
                      >
                        {ic.x}
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        );
      case "alerts":
        return (
          <div className="rm-alerts">
            {demo ? (
              <>
                {DEMO_ALERTS.map((a, i) => (
                  <div key={i} className="rm-alert">
                    <span className="rm-alert-dot" style={{ background: PLATFORM_TINT[a.platform] }} />
                    <div className="rm-alert-body">
                      <div className="rm-alert-line">
                        <strong>{a.user}</strong>
                        {a.detail && <span className="rm-alert-chip">{a.detail}</span>}
                      </div>
                      <div className="rm-alert-kind">
                        {a.kind === "follow" ? "followed" : a.kind === "sub" ? "subscribed" : a.kind === "tip" ? "tipped" : "raided"}
                        {a.message && <span className="rm-alert-msg"> — “{a.message}”</span>}
                      </div>
                    </div>
                    <span className="rm-alert-ago">{a.ago}</span>
                  </div>
                ))}
                <div className="rm-alert rm-alert-sys">
                  <span className="rm-alert-dot sys" />
                  <div className="rm-alert-body">
                    <div className="rm-alert-kind">Stream started</div>
                  </div>
                  <span className="rm-alert-ago">32m</span>
                </div>
              </>
            ) : (
              <div className="rm-alerts-empty">Follows, subs, and tips land here when you're live.</div>
            )}
          </div>
        );
      case "chat":
        return (
          <>
            <div className="rm-chat-chips">
              {(["all", "twitch", "kick", "youtube"] as const).map((p) => (
                <button
                  key={p}
                  className={`rm-chat-chip${chatFilter === p ? " on" : ""}`}
                  onClick={() => setChatFilter(p)}
                >
                  {p === "all" ? "All" : p === "youtube" ? "YouTube" : p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <div className="rm-chat-list">
              {chatMsgs
                .filter((m) => chatFilter === "all" || m.platform === chatFilter)
                .map((m, i) => (
                  <div key={i} className="rm-chat-msg">
                    <span className="rm-chat-user" style={{ color: PLATFORM_TINT[m.platform] }}>
                      {m.user}
                    </span>
                    <span className="rm-chat-text">{m.text}</span>
                  </div>
                ))}
              {chatMsgs.length === 0 && (
                <div className="rm-alerts-empty">
                  Chat flows in here live. Pop out the platform chat to talk back until native send lands.
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <form
              className="rm-chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                const text = chatDraft.trim();
                if (!text) return;
                setChatMsgs((m) => [...m.slice(-59), { platform: "twitch", user: "you", text }]);
                setChatDraft("");
              }}
            >
              <input
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                placeholder={demo ? "Say something…" : "Native chat send arrives with Connect"}
                disabled={!demo}
              />
            </form>
          </>
        );
      case "sources":
        return (
          <>
              <div className="rm-rows">
                {(
                  [
                    { key: "screen", label: "Screen", icon: ic.screen, on: sources.screen, act: () => setSrc({ screen: !sources.screen }) },
                    { key: "camera", label: "Camera", icon: ic.cam, on: sources.camera, act: () => setSrc({ camera: !sources.camera }) },
                    { key: "alerts", label: "Alerts & overlays", icon: ic.link, on: overlayActive, act: () => setOverlayOpen(true) },
                    { key: "guest", label: "Guest", icon: ic.invite, on: false, soon: true, act: () => {} },
                  ] as const
                ).map((t) => {
                  const soon = "soon" in t && t.soon;
                  return (
                    <div key={t.key} className={`rm-row${t.on ? "" : " off"}${soon ? " soon" : ""}`}>
                      <span className="rm-row-icon">{t.icon}</span>
                      <span className="rm-row-name">{t.label}</span>
                      {soon ? (
                        <span className="rm-soon">SOON</span>
                      ) : (
                        <>
                          {t.key === "alerts" && (
                            <button className="rm-row-edit" onClick={() => setOverlayOpen(true)} title="Configure">
                              {ic.gear}
                            </button>
                          )}
                          <button
                            className={`rm-switch${t.on ? " on" : ""}`}
                            disabled={!engineOk}
                            onClick={() => (t.key === "alerts" ? setOverlayOpen(true) : t.act())}
                          >
                            <span className="rm-switch-knob" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <button className="rm-addrow" disabled title="More source types arrive with the scene editor">
                {ic.plus} Add source <span className="rm-soon">SOON</span>
              </button>
          </>
        );
      case "mixer":
        return (
              <div className="rm-strips">
                {micStrip}
                <MeterStrip label="Desktop" icon={ic.cast} level={0} volume={0.5} muted soon />
                <MeterStrip label="Music" icon={ic.chat} level={0} volume={0.4} muted soon />
              </div>
        );
      case "channels":
        return (
          <div className="rm-rows">
            {destinations.map((d) => {
              const st = statuses.get(d.id);
              const phase = st ? PHASE_COPY[st.phase] ?? PHASE_COPY.idle : PHASE_COPY.idle;
              return (
                <div key={d.id} className={`rm-row${d.enabled ? "" : " off"}`}>
                  <span className="rm-row-dot" style={{ background: PLATFORM_TINT[d.preset] ?? "oklch(0.6 0.02 250)" }} />
                  <span className="rm-row-name">{d.label}</span>
                  <span className="rm-row-sub">
                    {streaming && st
                      ? `${phase.label}${st.phase === "live" ? ` · ${fmtBitrate(st.bytes_sent, elapsed)}` : ""}`
                      : d.preset}
                  </span>
                  <button className={`rm-switch${d.enabled ? " on" : ""}`} disabled={streaming} onClick={() => toggleEnabled(d)}>
                    <span className="rm-switch-knob" />
                  </button>
                </div>
              );
            })}
            {destinations.length === 0 && <div className="rm-rows-empty">No channels yet.</div>}
          </div>
        );
      case "stats": {
        const sent = [...statuses.values()].reduce((n, st) => n + st.bytes_sent, 0);
        const dropped = [...statuses.values()].reduce((n, st) => n + st.dropped_frames, 0);
        const recon = [...statuses.values()].reduce((n, st) => n + st.reconnects, 0);
        return (
          <div className="rm-stats">
            <div className="rm-stat-cell">
              <span className="rm-stat-num">{streaming ? fmtBitrate(sent, elapsed) : "—"}</span>
              <span className="rm-stat-label">upload</span>
            </div>
            <div className="rm-stat-cell">
              <span className="rm-stat-num">{`${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}</span>
              <span className="rm-stat-label">uptime</span>
            </div>
            <div className={`rm-stat-cell${dropped > 0 ? " warn" : ""}`}>
              <span className="rm-stat-num">{dropped}</span>
              <span className="rm-stat-label">dropped</span>
            </div>
            <div className={`rm-stat-cell${recon > 0 ? " warn" : ""}`}>
              <span className="rm-stat-num">{recon}</span>
              <span className="rm-stat-label">reconnects</span>
            </div>
            <div className="rm-stat-cell">
              <span className="rm-stat-num">{vh}p{vf === 60 ? "60" : ""}</span>
              <span className="rm-stat-label">output</span>
            </div>
          </div>
        );
      }
    }
  };

  const panelExtra = (id: PanelId) => {
    if (id === "scenes")
      return (
        <button className="rm-panel-plus" title="Save the current look as a scene" onClick={addScene}>
          {ic.plus}
        </button>
      );
    if (id === "chat")
      return (
        <div className="rm-pop-anchor">
          <button className="rm-panel-plus" title="Pop out platform chat" onClick={() => setChatOpen((o) => !o)}>
            {ic.ext}
          </button>
          {chatOpen && (
            <div className="rm-pop rm-pop-right">
              <ChatPopover onClose={() => setChatOpen(false)} />
            </div>
          )}
        </div>
      );
    if (id === "sources")
      return (
        <span className="rm-card-sub">
          {[sources.screen && "screen", sources.camera && "camera", overlayActive && "alerts"]
            .filter(Boolean)
            .join(" · ") || "nothing in the scene"}
        </span>
      );
    if (id === "mixer")
      return <span className="rm-card-sub">{sources.mic ? (sources.mic_muted ? "mic muted" : "mic open") : "mic off"}</span>;
    return null;
  };

  const slot = (dock: Dock, index: number) => (
    <div
      key={`${dock}-slot-${index}`}
      className={`rm-slot${layoutEdit ? " armed" : ""}${
        dropHint && dropHint.dock === dock && dropHint.index === index ? " hot" : ""
      }`}
    />
  );

  /** WKWebView's HTML5 drag-and-drop is unreliable, so panels drag on raw
   * pointer events (the dnd-kit / VS Code approach): capture the pointer,
   * follow it with a ghost, and work out the drop from geometry. */
  const dragRef = useRef<{ id: PanelId; x: number; y: number; moved: boolean } | null>(null);

  const hitTest = (x: number, y: number): { dock: Dock; index: number } | null => {
    const docks = Array.from(document.querySelectorAll<HTMLElement>("[data-dock]"));
    for (const el of docks) {
      const r = el.getBoundingClientRect();
      const pad = 16;
      if (x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad) continue;
      const dock = el.dataset.dock as Dock;
      const horizontal = dock === "bottom";
      const panels = Array.from(el.querySelectorAll<HTMLElement>("[data-panel]"));
      let index = panels.length;
      for (let i = 0; i < panels.length; i++) {
        const pr = panels[i].getBoundingClientRect();
        const mid = horizontal ? pr.left + pr.width / 2 : pr.top + pr.height / 2;
        if ((horizontal ? x : y) < mid) {
          index = i;
          break;
        }
      }
      return { dock, index };
    }
    return null;
  };

  const gripDown = (id: PanelId) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { id, x: e.clientX, y: e.clientY, moved: false };
  };

  const gripMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(d.id);
    }
    setGhost({ x: e.clientX, y: e.clientY });
    setDropHint(hitTest(e.clientX, e.clientY));
  };

  const gripUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) {
      const target = hitTest(e.clientX, e.clientY);
      if (target) setLayout(movePanelTo(layout, d.id, target.dock, target.index));
    }
    setDragging(null);
    setDropHint(null);
    setGhost(null);
  };

  const addButton = (dock: Dock) => {
    const available = PANEL_ORDER.filter((id) => dockOf(layout, id) !== dock);
    return (
      <div className="rm-pop-anchor rm-add-anchor" key={`${dock}-add`}>
        <button
          className="rm-add-panel"
          title="Add a panel here"
          onClick={() => setAddMenu((m) => (m === dock ? null : dock))}
        >
          {ic.plus}
        </button>
        {addMenu === dock && (
          <div className={`rm-pop rm-pop-add${dock === "bottom" ? " rm-pop-up" : " rm-pop-right"}`}>
            <div className="rm-pop-title">ADD PANEL</div>
            {available.map((id) => (
              <button
                key={id}
                className="rm-pop-row"
                onClick={() => {
                  setLayout(movePanelTo(layout, id, dock, layout[dock].length));
                  setAddMenu(null);
                }}
              >
                <span className="rm-add-name">{PANEL_META[id].title}</span>
                <span className="rm-add-where">
                  {dockOf(layout, id) === "hidden" ? "hidden" : `from ${dockOf(layout, id)}`}
                </span>
              </button>
            ))}
            {available.length === 0 && <div className="rm-rows-empty">Everything is already here.</div>}
          </div>
        )}
      </div>
    );
  };

  const renderDock = (dock: Dock) => {
    const ids = layout[dock];
    return (
      <>
        {ids.map((id, i) => (
          <Fragment key={id}>
            {slot(dock, i)}
            {renderPanel(id)}
          </Fragment>
        ))}
        {slot(dock, ids.length)}
        {addButton(dock)}
      </>
    );
  };

  const renderPanel = (id: PanelId) => (
    <section key={id} data-panel={id} className={`rm-panel rm-panel-${id}${dragging === id ? " dragging" : ""}`}>
      <div className="rm-panel-head">
        <span
          className="rm-grip"
          title="Drag to move this panel"
          onPointerDown={gripDown(id)}
          onPointerMove={gripMove}
          onPointerUp={gripUp}
          onPointerCancel={gripUp}
        >
          {ic.grip}
        </span>
        <span className="rm-group-label">{PANEL_META[id].title.toUpperCase()}</span>
        <div className="rm-panel-actions">
          {panelExtra(id)}
          <button
            className="rm-panel-plus rm-panel-hide"
            title="Hide this panel"
            onClick={() => setLayout(movePanel(layout, id, "hidden"))}
          >
            {ic.x}
          </button>
        </div>
      </div>
      <div className="rm-panel-body">{panelBody(id)}</div>
    </section>
  );

  return (
    <div className={`room${layoutEdit ? " layout-edit" : ""}`}>
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

        <div className="rm-top-drag" data-tauri-drag-region />

        <div className="rm-top-right">
          {streaming && (
            <span className="rm-live-pill">
              <span className="rm-live-dot" />
              {`${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}
            </span>
          )}

          <div className="rm-pop-anchor">
            <button className="rm-chip" onClick={() => setDestsOpen((o) => !o)} title="Channels this room goes out to">
              {ic.cast}
              <span>{destChip}</span>
              {ic.chev}
            </button>
            {destsOpen && (
              <div className="rm-pop rm-pop-right rm-pop-dests">
                <div className="rm-pop-title">CHANNELS</div>
                {destinations.map((d) => {
                  const st = statuses.get(d.id);
                  const phase = st ? PHASE_COPY[st.phase] ?? PHASE_COPY.idle : PHASE_COPY.idle;
                  return (
                    <div key={d.id} className={`rm-row${d.enabled ? "" : " off"}`}>
                      <span className="rm-row-dot" style={{ background: PLATFORM_TINT[d.preset] ?? "oklch(0.6 0.02 250)" }} />
                      <span className="rm-row-name">{d.label}</span>
                      <span className="rm-row-sub">
                        {streaming && st
                          ? `${phase.label}${st.phase === "live" ? ` · ${fmtBitrate(st.bytes_sent, elapsed)}` : ""}`
                          : d.preset}
                      </span>
                      {!streaming && (
                        <button className="rm-row-edit" onClick={() => setEditing(d)} title="Edit channel">
                          {ic.gear}
                        </button>
                      )}
                      <button
                        className={`rm-switch${d.enabled ? " on" : ""}`}
                        disabled={streaming}
                        onClick={() => toggleEnabled(d)}
                      >
                        <span className="rm-switch-knob" />
                      </button>
                    </div>
                  );
                })}
                {destinations.length === 0 && (
                  <div className="rm-rows-empty">No channels yet — add Twitch, Kick, or YouTube.</div>
                )}
                {!streaming && (
                  <button className="rm-pop-row dim" onClick={() => setAdding(true)}>
                    + Add channel
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="rm-pop-anchor">
            <button className="rm-chip" onClick={() => setQualityOpen((o) => !o)} title="Output video settings">
              {vh}p · {vf}
              {ic.chev}
            </button>
            {qualityOpen && (
              <div className="rm-pop rm-pop-right rm-pop-quality">
                <div className="rm-pop-title">VIDEO {streaming && <span className="rm-card-sub">locked while live</span>}</div>
                <div className="rm-ctrl-row">
                  <span className="rm-ctrl-label">Resolution</span>
                  <span className="rm-quality-set">
                    {[720, 1080].map((h) => (
                      <button key={h} className={`rm-q${vh === h ? " on" : ""}`} disabled={streaming || !engineOk} onClick={() => setVideoCfg(h, vf)}>
                        {h}p
                      </button>
                    ))}
                  </span>
                </div>
                <div className="rm-ctrl-row">
                  <span className="rm-ctrl-label">Frame rate</span>
                  <span className="rm-quality-set">
                    {[30, 60].map((f) => (
                      <button key={f} className={`rm-q${vf === f ? " on" : ""}`} disabled={streaming || !engineOk} onClick={() => setVideoCfg(vh, f)}>
                        {f}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="rm-ctrl-row">
                  <span className="rm-ctrl-label">Bitrate</span>
                  <span className="rm-ctrl-value" title="Producer negotiates the best rate every channel accepts">Auto</span>
                </div>
              </div>
            )}
          </div>

          {streaming ? (
            <button className="rm-golive stop" onClick={() => ipc.liveStop()} disabled={state === "stopping"}>
              <span className="rm-big-icon">■</span>
              {state === "stopping" ? "Stopping…" : "End stream"}
            </button>
          ) : (
            <button
              className="rm-golive"
              onClick={goLive}
              disabled={!engineOk || enabledDests.length === 0}
              title={enabledDests.length === 0 ? "Turn on a channel first" : undefined}
            >
              {ic.onair}
              Go Live
            </button>
          )}

          <button
            className={`rm-icon-chip${layoutEdit ? " on" : ""}`}
            onClick={() => {
              setLayoutEdit((e) => !e);
              setLayoutMenu(false);
            }}
            title={layoutEdit ? "Done editing layout" : "Edit layout"}
          >
            {ic.layout}
          </button>

          <button
            className="rm-leave"
            onClick={() => onLeave?.()}
            title={streaming ? "Collapse — the stream keeps running" : "Collapse room"}
          >
            {ic.collapseDown}
          </button>
        </div>
      </header>

      {layoutEdit && (
        <div className="rm-editbar">
          <span className="rm-editbar-dot" />
          <span className="rm-editbar-text">
            Editing layout — drag a panel by its grip, or use + to add one
          </span>
          <div className="rm-pop-anchor">
            <button className="rm-editbar-btn" onClick={() => setLayoutMenu((o) => !o)}>
              Presets
              {ic.chev}
            </button>
            {layoutMenu && (
              <div className="rm-pop rm-pop-layout">
                {LAYOUT_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    className="rm-preset"
                    onClick={() => {
                      setLayout({
                        left: [...p.layout.left],
                        right: [...p.layout.right],
                        bottom: [...p.layout.bottom],
                        hidden: [...p.layout.hidden],
                      });
                      setLayoutMenu(false);
                    }}
                  >
                    <span className="rm-preset-name">{p.label}</span>
                    <span className="rm-preset-note">{p.note}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="rm-editbar-done" onClick={() => setLayoutEdit(false)}>
            Done
          </button>
        </div>
      )}

      <div className="rm-body">
        <aside data-dock="left" className={`rm-dock rm-dock-side${layout.left.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "left" ? " hot" : ""}`}>{renderDock("left")}</aside>

        <div className="rm-center">
          <div className="rm-canvas">
            {engineOk && <PreviewPanel />}
            {!engineOk && snapshot && (
              <div className="rm-canvas-msg">
                {snapshot.disabled ? "Live engine not bundled in this build." : "Warming up the engine…"}
              </div>
            )}
          </div>

          <div className="rm-float">{banner && <div className="rm-banner">{banner}</div>}</div>

          <PermBanner sources={sources} />
        </div>

        <aside data-dock="right" className={`rm-dock rm-dock-side${layout.right.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "right" ? " hot" : ""}`}>{renderDock("right")}</aside>
      </div>

      {dragging && ghost && (
        <div className="rm-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className="rm-grip">{ic.grip}</span>
          {PANEL_META[dragging].title}
        </div>
      )}

      {overlayOpen && (
        <>
          <div className="rm-pop-backdrop" onClick={() => setOverlayOpen(false)} />
          <div className="rm-editor rm-editor-overlay">
            <div className="rm-editor-head">
              <span className="rm-group-label">ALERTS &amp; OVERLAYS</span>
              <button className="rm-panel-plus" onClick={() => setOverlayOpen(false)} title="Close">
                {ic.x}
              </button>
            </div>
            <OverlayPicker
              activeWindow={sources.overlay_window ?? null}
              activeUrl={sources.overlay_url ?? null}
            />
          </div>
        </>
      )}

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

      {(layout.bottom.length > 0 || dragging) && (
        <div className={`rm-sheet${sheetOpen ? "" : " collapsed"}`}>
          <div
            className="rm-sheet-head"
            role="button"
            tabIndex={0}
            title={sheetOpen ? "Hide the bottom row" : "Show the bottom row"}
            onClick={() => setSheetOpen((o) => !o)}
            onKeyDown={(e) => e.key === "Enter" && setSheetOpen((o) => !o)}
          >
            <span className="rm-sheet-handle" />
          </div>
          {sheetOpen && streaming && (
            <div className="rm-livewarn">
              <span className="rm-live-dot" />
              You&rsquo;re on air — scene cuts and source changes hit the broadcast instantly.
            </div>
          )}
          {(sheetOpen || dragging) && (
            <div data-dock="bottom" className={`rm-dock rm-dock-bottom${layoutEdit ? " armed" : ""}${dropHint?.dock === "bottom" ? " hot" : ""}`}>{renderDock("bottom")}</div>
          )}
        </div>
      )}
    </div>
  );
}
