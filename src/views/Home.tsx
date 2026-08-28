import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Channel, EndpointInfo, Job, TargetResult } from "../lib/ipc";
import { ipc } from "../lib/ipc";

const STATE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  canceled: "Canceled",
};

export function Home({
  endpoints,
  onAddEndpoint,
  onRemoveEndpoint,
}: {
  endpoints: EndpointInfo[];
  onAddEndpoint: () => void;
  onRemoveEndpoint: (id: string) => void;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    const all: Channel[] = [];
    let firstError: string | null = null;
    for (const ep of endpoints) {
      try {
        const { channels: rows } = await ipc.endpointChannels(ep.id);
        for (const row of rows) all.push({ ...row, endpoint_id: ep.id, endpoint_kind: ep.kind });
      } catch (e) {
        firstError = firstError ?? `${ep.name}: ${e}`;
      }
    }
    setChannels(all);
    setLoadError(firstError);
  }, [endpoints]);

  const loadJobs = useCallback(async () => {
    const all: Job[] = [];
    for (const ep of endpoints) {
      try {
        const { jobs: rows } = await ipc.listJobs(ep.id);
        for (const row of rows) all.push({ ...row, endpoint_id: ep.id });
      } catch {
        // endpoint errors already surfaced by loadChannels; jobs stay best-effort
      }
    }
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    setJobs(all);
  }, [endpoints]);

  useEffect(() => {
    loadChannels();
    loadJobs();
  }, [loadChannels, loadJobs]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const active = useMemo(() => channels.filter((c) => c.status === "active"), [channels]);
  const connectedCount = endpoints.filter((e) => e.kind === "connected").length;
  const independentCount = endpoints.length - connectedCount;

  return (
    <div className="frame">
      <header className="toolbar">
        <span className="wordmark">
          PRODUCER <span className="by">by Boomin</span>
        </span>
        <span className="spacer" />
        {endpoints.map((ep) => (
          <span key={ep.id} className="endpoint-pill" title={ep.base_url}>
            <span className={`dot ${ep.kind}`} />
            <strong>{ep.name}</strong>
            <button onClick={() => onRemoveEndpoint(ep.id)} title="Remove endpoint">
              ✕
            </button>
          </span>
        ))}
        <button className="ghost" onClick={onAddEndpoint}>
          + Add endpoint
        </button>
      </header>

      <div className="dock">
        <section className="panel panel-channels">
          <div className="panel-header">
            <h2 className="panel-title">Channels</h2>
          </div>
          <div className="panel-body">
            {active.length === 0 ? (
              <p className="muted">
                No publishable channels. Connected workspaces pick up channels
                from the Boomin web app; independent servers list them once a
                platform is connected there.
              </p>
            ) : (
              active.map((c) => (
                <label key={c.id} className={`channel-row${selected.has(c.id) ? " picked" : ""}`}>
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="platform">{c.platform}</span>
                  <span className="name">{c.display_name}</span>
                  <span className="mode-tag">
                    {c.endpoint_kind === "connected" ? "Boomin" : "Self"}
                  </span>
                </label>
              ))
            )}
            {loadError && <p className="error">{loadError}</p>}
          </div>
        </section>

        <Composer
          channels={active}
          selected={selected}
          onClearSelection={() => setSelected(new Set())}
          onSubmitted={loadJobs}
        />

        <JobsList jobs={jobs} channels={channels} onRefresh={loadJobs} />
      </div>

      <footer className="statusbar">
        <span>
          <span className="live-dot" />
          {connectedCount} connected · {independentCount} independent
        </span>
        <span>{active.length} channel{active.length === 1 ? "" : "s"}</span>
        <span className="spacer" />
        <span>v0.1.0-dev</span>
      </footer>
    </div>
  );
}

function Composer({
  channels,
  selected,
  onClearSelection,
  onSubmitted,
}: {
  channels: Channel[];
  selected: Set<string>;
  onClearSelection: () => void;
  onSubmitted: () => void;
}) {
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [upload, setUpload] = useState<{ upload_id: string; filename: string; endpoint_id: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TargetResult[] | null>(null);

  const maxChars = useMemo(() => {
    const limits = channels
      .filter((c) => selected.has(c.id))
      .map((c) => c.capabilities?.text?.maxChars)
      .filter((n): n is number => typeof n === "number");
    return limits.length ? Math.min(...limits) : null;
  }, [channels, selected]);

  async function pickFile() {
    setError(null);
    const targetChannel = channels.find((c) => selected.has(c.id));
    if (!targetChannel) {
      setError("Pick at least one channel first — uploads are stored on that channel's endpoint.");
      return;
    }
    const path = await open({
      multiple: false,
      filters: [{ name: "Media", extensions: ["jpg", "jpeg", "png", "webp", "gif", "mp4", "mov", "webm"] }],
    });
    if (typeof path !== "string") return;
    setUploading(true);
    try {
      const slot = await ipc.uploadMedia(targetChannel.endpoint_id, path);
      setUpload({ upload_id: slot.upload_id, filename: slot.filename, endpoint_id: slot.endpoint_id });
      setMediaUrl("");
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const targets = channels
        .filter((c) => selected.has(c.id))
        .map((c) => ({ endpoint_id: c.endpoint_id, channel_id: c.id }));
      const { results } = await ipc.submitPost({
        text: text || undefined,
        media_url: mediaUrl.trim() || undefined,
        media_upload_id: upload?.upload_id,
        schedule_at: scheduleAt ? new Date(scheduleAt).toISOString() : undefined,
        targets,
      });
      setResults(results);
      if (results.every((r) => r.accepted)) {
        setText("");
        setMediaUrl("");
        setUpload(null);
        setScheduleAt("");
        onClearSelection();
      }
      onSubmitted();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-composer composer">
      <div className="panel-header">
        <h2 className="panel-title">New Post</h2>
        {maxChars !== null && (
          <span className={`char-count${text.length > maxChars ? " over" : ""}`}>
            {text.length}/{maxChars}
          </span>
        )}
      </div>
      <div className="panel-body">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write the caption once. Post it everywhere."
        />
        <div className="composer-row">
          <button type="button" onClick={pickFile} disabled={uploading}>
            {uploading ? "Uploading…" : upload ? `📎 ${upload.filename}` : "Attach a file"}
          </button>
          {upload && (
            <button type="button" className="linkish" onClick={() => setUpload(null)}>
              clear
            </button>
          )}
          <span className="or">or</span>
          <input
            className="grow"
            value={mediaUrl}
            onChange={(e) => {
              setMediaUrl(e.target.value);
              if (e.target.value) setUpload(null);
            }}
            placeholder="public media URL (https://…/clip.mp4)"
          />
        </div>
        <div className="composer-row">
          <label className="schedule-label">
            Schedule
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
          </label>
          {scheduleAt && (
            <button type="button" className="linkish" onClick={() => setScheduleAt("")}>
              post now instead
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="primary" onClick={submit} disabled={busy || selected.size === 0}>
            {busy ? "Submitting…" : scheduleAt ? "Schedule" : "Post now"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {results && (
          <ul className="results">
            {results.map((r) => (
              <li key={`${r.endpoint_id}-${r.channel_id}`} className={r.accepted ? "ok" : "bad"}>
                {r.accepted ? `accepted${r.replayed ? " (replayed)" : ""}` : `failed: ${r.error}`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function JobsList({
  jobs,
  channels,
  onRefresh,
}: {
  jobs: Job[];
  channels: Channel[];
  onRefresh: () => void;
}) {
  const channelName = (id: string) => channels.find((c) => c.id === id)?.display_name ?? "channel";
  return (
    <section className="panel panel-queue">
      <div className="panel-header">
        <h2 className="panel-title">Queue &amp; History</h2>
        <button className="ghost" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {jobs.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>
            Nothing yet — your first post will show up here.
          </p>
        ) : (
          <table className="job-table">
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <span className={`state-chip ${j.state}`}>{STATE_LABEL[j.state] ?? j.state}</span>
                  </td>
                  <td>{channelName(j.channel_id)}</td>
                  <td className="when">
                    {j.state === "scheduled"
                      ? `fires ${new Date(j.due_at).toLocaleString()}`
                      : new Date(j.created_at).toLocaleString()}
                  </td>
                  <td className="grow-cell">
                    {j.published_external_url && (
                      <a href={j.published_external_url} target="_blank" rel="noreferrer">
                        view post
                      </a>
                    )}
                    {j.error_message && <span className="job-error">{j.error_message}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
