import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Channel, EndpointInfo, Job, TargetResult } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { Wordmark } from "./Onboarding";

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
        // channel errors already surfaced by loadChannels; keep jobs best-effort
      }
    }
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    setJobs(all);
  }, [endpoints]);

  useEffect(() => {
    loadChannels();
    loadJobs();
  }, [loadChannels, loadJobs]);

  return (
    <div className="home">
      <header className="home-head">
        <Wordmark />
        <button className="ghost" onClick={onAddEndpoint}>
          Add endpoint
        </button>
      </header>

      <h2 className="section-title">Endpoints</h2>
      <ul className="endpoint-list">
        {endpoints.map((ep) => (
          <li key={ep.id} className="endpoint">
            <div>
              <span className={`mode-badge ${ep.kind}`}>
                {ep.kind === "connected" ? "Connected" : "Independent"}
              </span>
              <strong>{ep.name}</strong>
              <span className="endpoint-url">{ep.base_url}</span>
            </div>
            <button className="ghost" onClick={() => onRemoveEndpoint(ep.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {loadError && <p className="error">{loadError}</p>}

      <Composer channels={channels} onSubmitted={loadJobs} />
      <JobsList jobs={jobs} channels={channels} onRefresh={loadJobs} />
    </div>
  );
}

function Composer({ channels, onSubmitted }: { channels: Channel[]; onSubmitted: () => void }) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mediaUrl, setMediaUrl] = useState("");
  const [upload, setUpload] = useState<{ upload_id: string; filename: string; endpoint_id: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TargetResult[] | null>(null);

  const active = useMemo(() => channels.filter((c) => c.status === "active"), [channels]);
  const maxChars = useMemo(() => {
    const limits = active
      .filter((c) => selected.has(c.id))
      .map((c) => c.capabilities?.text?.maxChars)
      .filter((n): n is number => typeof n === "number");
    return limits.length ? Math.min(...limits) : null;
  }, [active, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function pickFile() {
    setError(null);
    const targetChannel = active.find((c) => selected.has(c.id));
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
      const targets = active
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
        setSelected(new Set());
        setMediaUrl("");
        setUpload(null);
        setScheduleAt("");
      }
      onSubmitted();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="composer">
      <h2 className="section-title">New post</h2>
      {active.length === 0 ? (
        <p className="muted">
          No publishable channels yet. Connected accounts pick up channels from
          the Boomin web app; independent servers list channels once you
          connect a platform there.
        </p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write the caption once. Post it everywhere."
            rows={4}
          />
          <div className="composer-row">
            {maxChars !== null && (
              <span className={`char-count${text.length > maxChars ? " over" : ""}`}>
                {text.length}/{maxChars}
              </span>
            )}
          </div>

          <div className="channel-picks">
            {active.map((c) => (
              <label key={c.id} className={`channel-pick${selected.has(c.id) ? " picked" : ""}`}>
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                />
                <span className="platform">{c.platform}</span>
                <span>{c.display_name}</span>
                <span className={`mode-badge ${c.endpoint_kind}`}>
                  {c.endpoint_kind === "connected" ? "Connected" : "Independent"}
                </span>
              </label>
            ))}
          </div>

          <div className="media-row">
            <button type="button" className="ghost" onClick={pickFile} disabled={uploading}>
              {uploading ? "Uploading…" : upload ? `📎 ${upload.filename}` : "Attach a file"}
            </button>
            {upload && (
              <button type="button" className="linkish" onClick={() => setUpload(null)}>
                clear
              </button>
            )}
            <span className="muted">or</span>
            <input
              value={mediaUrl}
              onChange={(e) => {
                setMediaUrl(e.target.value);
                if (e.target.value) setUpload(null);
              }}
              placeholder="paste a public media URL (https://…/clip.mp4)"
            />
          </div>

          <div className="media-row">
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
            <span className="spacer" />
            <button onClick={submit} disabled={busy || selected.size === 0}>
              {busy ? "Submitting…" : scheduleAt ? "Schedule" : "Post now"}
            </button>
          </div>

          {error && <p className="error">{error}</p>}
          {results && (
            <ul className="results">
              {results.map((r) => (
                <li key={`${r.endpoint_id}-${r.channel_id}`} className={r.accepted ? "ok" : "bad"}>
                  {r.accepted
                    ? `Accepted${r.replayed ? " (replayed)" : ""}`
                    : `Failed: ${r.error}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
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
    <section className="jobs">
      <div className="home-head">
        <h2 className="section-title">Queue & history</h2>
        <button className="ghost" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {jobs.length === 0 ? (
        <p className="muted">Nothing yet — your first post will show up here.</p>
      ) : (
        <ul className="job-list">
          {jobs.map((j) => (
            <li key={j.id} className="job">
              <span className={`state-chip ${j.state}`}>{STATE_LABEL[j.state] ?? j.state}</span>
              <span className="job-channel">{channelName(j.channel_id)}</span>
              <span className="muted">
                {j.state === "scheduled"
                  ? `fires ${new Date(j.due_at).toLocaleString()}`
                  : new Date(j.created_at).toLocaleString()}
              </span>
              {j.published_external_url && (
                <a href={j.published_external_url} target="_blank" rel="noreferrer">
                  view post
                </a>
              )}
              {j.error_message && <span className="error">{j.error_message}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
