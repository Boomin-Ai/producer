import { useCallback, useEffect, useRef, useState } from "react";
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

function SourceToggles({
  sources,
  disabled,
  onChange,
}: {
  sources: LiveSources;
  disabled: boolean;
  onChange: (s: LiveSources) => void;
}) {
  const toggles: { key: keyof LiveSources; label: string }[] = [
    { key: "screen", label: "Screen" },
    { key: "camera", label: "Camera" },
    { key: "mic", label: "Mic" },
  ];
  return (
    <div className="live-sources">
      {toggles.map((t) => (
        <button
          key={t.key}
          className={`live-source-toggle${sources[t.key] ? " on" : ""}`}
          disabled={disabled}
          onClick={() => onChange({ ...sources, [t.key]: !sources[t.key] })}
        >
          {t.label}
        </button>
      ))}
      <span className="live-sources-note">Camera appears picture-in-picture.</span>
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

export function LiveView({ room }: { room?: { id: string; name: string; config: string } }) {
  const [destinations, setDestinations] = useState<LiveDestination[]>([]);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [statuses, setStatuses] = useState<Map<string, LiveDestStatus>>(new Map());
  const [elapsed, setElapsed] = useState(0);
  const [editing, setEditing] = useState<LiveDestination | null>(null);
  const [adding, setAdding] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [sources, setSources] = useState<LiveSources>({ screen: false, camera: false, mic: false });
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
          if (cfg.overlay_window != null || cfg.overlay_url) {
            await ipc.liveSetOverlay(cfg.overlay_window ?? null, true, cfg.overlay_url ?? null);
          }
          setSources((s) => ({ ...s, ...cfg }));
        }
      } catch {
        /* malformed config — start clean */
      }
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

  return (
    <div className="live-view">
      <div className="section-head">
        <span className="section-label">Live</span>
        {snapshot?.graphics_backend && <span className="live-backend">engine: {snapshot.graphics_backend}</span>}
      </div>

      {engineOk && <PreviewPanel />}
      <SourceToggles
        sources={sources}
        disabled={!engineOk}
        onChange={async (s) => {
          setSources(s);
          try {
            await ipc.liveSetSources(s.screen, s.camera, s.mic);
          } catch (e) {
            setBanner(String(e));
          }
        }}
      />
      <PermissionsCoach sources={sources} />

      <details className="live-overlay-details" open={sources.overlay_window != null || sources.overlay_url != null}>
        <summary>
          Overlay {sources.overlay_window != null || sources.overlay_url != null ? "· active" : ""}
        </summary>
        <OverlayPicker activeWindow={sources.overlay_window ?? null} activeUrl={sources.overlay_url ?? null} />
      </details>

      <div className="section-head">
        <span className="section-label">Destinations</span>
      </div>

      {banner && <div className="live-error">{banner}</div>}
      {!engineOk && snapshot && (
        <div className="live-error">
          {snapshot.disabled ? "Live engine not bundled in this build." : "Live engine is starting…"}
        </div>
      )}

      <div className="live-rows">
        {destinations.map((d) => {
          const st = statuses.get(d.id);
          const phase = st ? PHASE_COPY[st.phase] ?? PHASE_COPY.idle : PHASE_COPY.idle;
          return (
            <div key={d.id} className={`live-row${d.enabled ? "" : " disabled"}`}>
              <span className={`live-dot ${st ? phase.tone : "muted"}`} />
              <div className="live-row-main">
                <div className="live-row-title">
                  {d.label} <span className="live-preset">{d.preset}</span>
                </div>
                <div className="live-row-sub">
                  {st && streaming ? (
                    <>
                      {phase.label}
                      {st.phase === "live" && ` · ${fmtBitrate(st.bytes_sent, elapsed)} · ${st.total_frames} frames`}
                      {st.dropped_frames > 0 && ` · ${st.dropped_frames} dropped`}
                      {st.reconnects > 0 && ` · ${st.reconnects} reconnects`}
                      {st.phase === "live" && " · confirm on the platform dashboard"}
                    </>
                  ) : (
                    <>key stored in Keychain{d.server ? ` · ${d.server}` : ""}</>
                  )}
                  {st?.last_error && <span className="live-error-inline"> · {st.last_error}</span>}
                </div>
              </div>
              {!streaming && (
                <>
                  <button className="live-toggle" onClick={() => toggleEnabled(d)} title="Include when going live">
                    {d.enabled ? "On" : "Off"}
                  </button>
                  <button onClick={() => setEditing(d)}>Edit</button>
                  <button
                    onClick={async () => {
                      await ipc.liveDeleteDestination(d.id);
                      refresh();
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          );
        })}
        {destinations.length === 0 && !adding && (
          <div className="side-soon">Add a destination to go live. Keys go straight to the macOS Keychain.</div>
        )}
      </div>

      {(adding || editing) && (
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
      )}
      {!adding && !editing && !streaming && (
        <button onClick={() => setAdding(true)}>+ Add destination</button>
      )}

      <div className="live-actions">
        {streaming ? (
          <button className="live-stop" onClick={() => ipc.liveStop()} disabled={state === "stopping"}>
            {state === "stopping" ? "Stopping…" : `STOP (${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")})`}
          </button>
        ) : (
          <button
            className="live-go"
            onClick={goLive}
            disabled={!engineOk || destinations.filter((d) => d.enabled).length === 0}
          >
            GO LIVE
          </button>
        )}
      </div>
    </div>
  );
}
