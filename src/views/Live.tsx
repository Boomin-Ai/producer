import { useCallback, useEffect, useRef, useState } from "react";
import {
  ipc,
  listenLiveEvents,
  type LiveDestination,
  type LiveDestStatus,
  type LivePreset,
  type LiveSnapshot,
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

function DestinationEditor({
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

export function LiveView() {
  const [destinations, setDestinations] = useState<LiveDestination[]>([]);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [statuses, setStatuses] = useState<Map<string, LiveDestStatus>>(new Map());
  const [elapsed, setElapsed] = useState(0);
  const [editing, setEditing] = useState<LiveDestination | null>(null);
  const [adding, setAdding] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const unlisten = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setDestinations(await ipc.liveListDestinations());
    setSnapshot(await ipc.liveEngineStatus());
  }, []);

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
  }, [refresh]);

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
    } catch (e) {
      setBanner(String(e));
    }
  }

  return (
    <div className="live-view">
      <div className="section-head">
        <span className="section-label">Live destinations</span>
        {snapshot?.graphics_backend && <span className="live-backend">engine: {snapshot.graphics_backend}</span>}
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
