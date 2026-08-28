import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
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

type MainView = "compose" | "history";

interface Attached {
  upload_id: string;
  filename: string;
  endpoint_id: string;
  kind: string;
  local_path: string;
}

export function Home({
  endpoints,
  onAddEndpoint,
  onRemoveEndpoint,
}: {
  endpoints: EndpointInfo[];
  onAddEndpoint: () => void;
  onRemoveEndpoint: (id: string) => void;
}) {
  const [view, setView] = useState<MainView>("compose");
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
        // surfaced via loadChannels; jobs stay best-effort
      }
    }
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    setJobs(all);
  }, [endpoints]);

  useEffect(() => {
    loadChannels();
    loadJobs();
  }, [loadChannels, loadJobs]);

  const upcoming = jobs.filter((j) => j.state === "scheduled" || j.state === "queued" || j.state === "publishing");

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="side-brand">
          PRODUCER <span className="by">by Boomin</span>
        </div>

        <div className="side-label">Manager</div>
        <button className={`side-item${view === "compose" ? " active" : ""}`} onClick={() => setView("compose")}>
          New post
        </button>
        <button className={`side-item${view === "history" ? " active" : ""}`} onClick={() => setView("history")}>
          Queue &amp; history
          {upcoming.length > 0 && <span className="side-count">{upcoming.length}</span>}
        </button>

        <div className="side-label">Collections</div>
        <div className="side-soon">Series &amp; collections arrive with the creation phase.</div>

        <div className="side-spacer" />

        <div className="side-label">Endpoints</div>
        {endpoints.map((ep) => (
          <div key={ep.id} className="side-endpoint" title={ep.base_url}>
            <span className={`dot ${ep.kind}`} />
            <span className="name">{ep.name}</span>
            <button onClick={() => onRemoveEndpoint(ep.id)} title="Remove">
              ✕
            </button>
          </div>
        ))}
        <button className="side-item" onClick={onAddEndpoint}>
          + Add endpoint
        </button>
      </aside>

      <main className="main">
        {view === "compose" ? (
          <ComposerDetail
            channels={channels.filter((c) => c.status === "active")}
            loadError={loadError}
            onSubmitted={() => {
              loadJobs();
              setView("history");
            }}
          />
        ) : (
          <HistoryView jobs={jobs} channels={channels} onRefresh={loadJobs} />
        )}
      </main>
    </div>
  );
}

function ComposerDetail({
  channels,
  loadError,
  onSubmitted,
}: {
  channels: Channel[];
  loadError: string | null;
  onSubmitted: () => void;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mediaUrl, setMediaUrl] = useState("");
  const [upload, setUpload] = useState<Attached | null>(null);
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
    const targetChannel = channels.find((c) => selected.has(c.id)) ?? channels[0];
    if (!targetChannel) {
      setError("Connect a channel first — uploads are stored on its endpoint.");
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
      setUpload({ ...slot, local_path: path } as Attached);
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
        setSelected(new Set());
        setMediaUrl("");
        setUpload(null);
        setScheduleAt("");
        onSubmitted();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const previewSrc = upload
    ? convertFileSrc(upload.local_path)
    : mediaUrl.trim() && /^https:\/\//i.test(mediaUrl.trim())
      ? mediaUrl.trim()
      : null;
  const previewKind = upload
    ? upload.kind
    : /\.(mp4|mov|webm)([?#].*)?$/i.test(mediaUrl)
      ? "video"
      : "image";

  return (
    <>
      <header className="main-top">
        <div className="crumb">
          Producer <span className="sep">›</span> <strong>New post</strong>
        </div>
        <div className="top-meta">
          <span className="meta-block">
            <span className="meta-label">Distribution</span>
            <span className="meta-value">
              {selected.size} channel{selected.size === 1 ? "" : "s"}
            </span>
          </span>
          <span className="meta-block">
            <span className="meta-label">Stage</span>
            <span className="meta-value">
              <span className={`stage-dot${scheduleAt ? " scheduled" : ""}`} />
              {scheduleAt ? "Scheduling" : "Draft"}
            </span>
          </span>
          <button className="btn-dark" onClick={submit} disabled={busy || selected.size === 0}>
            {busy ? "Submitting…" : scheduleAt ? "Schedule" : "Post now"}
          </button>
        </div>
      </header>

      <div className="detail">
        <div className="detail-media">
          <div className="media-card">
            {previewSrc ? (
              previewKind === "video" ? (
                <video key={previewSrc} src={previewSrc} controls />
              ) : (
                <img src={previewSrc} alt="attached media" />
              )
            ) : (
              <div className="media-empty">
                <p>No media yet.</p>
                <button onClick={pickFile} disabled={uploading}>
                  {uploading ? "Uploading…" : "Upload media"}
                </button>
              </div>
            )}
          </div>
          {(upload || mediaUrl) && (
            <div className="media-meta">
              <span className="muted">{upload ? upload.filename : "external URL"}</span>
              <button
                className="linkish"
                onClick={() => {
                  setUpload(null);
                  setMediaUrl("");
                }}
              >
                remove
              </button>
              {!upload && (
                <button className="linkish" onClick={pickFile} disabled={uploading}>
                  upload instead
                </button>
              )}
            </div>
          )}
          {!upload && (
            <input
              className="media-url"
              value={mediaUrl}
              onChange={(e) => setMediaUrl(e.target.value)}
              placeholder="…or paste a public media URL"
            />
          )}
        </div>

        <div className="detail-form">
          <section className="section">
            <div className="section-head">
              <span className="section-label">Caption</span>
              {maxChars !== null && (
                <span className={`char-count${text.length > maxChars ? " over" : ""}`}>
                  {text.length}/{maxChars}
                </span>
              )}
            </div>
            <textarea
              className="caption-box"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write the caption once. Post it everywhere."
            />
          </section>

          <section className="section">
            <div className="section-head">
              <span className="section-label">Selected channels</span>
            </div>
            {channels.length === 0 ? (
              <div className="empty-strip">
                No publishable channels. Connected workspaces pick up channels from the Boomin
                web app; independent servers list them once a platform is connected there.
              </div>
            ) : (
              <div className="channel-cards">
                {channels.map((c) => (
                  <label key={c.id} className={`channel-card${selected.has(c.id) ? " picked" : ""}`}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className="platform">{c.platform}</span>
                    <span className="name">{c.display_name}</span>
                    <span className="mode-tag">{c.endpoint_kind === "connected" ? "Boomin" : "Self-hosted"}</span>
                  </label>
                ))}
              </div>
            )}
            {loadError && <p className="error">{loadError}</p>}
          </section>

          <section className="section">
            <div className="section-head">
              <span className="section-label">Schedule</span>
            </div>
            <div className="schedule-row">
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              {scheduleAt ? (
                <button className="linkish" onClick={() => setScheduleAt("")}>
                  post now instead
                </button>
              ) : (
                <span className="muted">Leave empty to post immediately.</span>
              )}
            </div>
          </section>

          {error && <p className="error">{error}</p>}
          {results && (
            <ul className="results">
              {results.map((r) => (
                <li key={`${r.endpoint_id}-${r.channel_id}`} className={r.accepted ? "ok" : "bad"}>
                  {r.accepted ? `Accepted${r.replayed ? " (replayed)" : ""}` : `Failed: ${r.error}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function HistoryView({
  jobs,
  channels,
  onRefresh,
}: {
  jobs: Job[];
  channels: Channel[];
  onRefresh: () => void;
}) {
  const channelName = (id: string) => channels.find((c) => c.id === id)?.display_name ?? "channel";
  const upcoming = jobs.filter((j) => ["scheduled", "queued", "publishing"].includes(j.state));
  const past = jobs.filter((j) => !["scheduled", "queued", "publishing"].includes(j.state));

  const row = (j: Job) => (
    <div key={j.id} className="job-row">
      <span className={`chip ${j.state}`}>{STATE_LABEL[j.state] ?? j.state}</span>
      <span className="job-channel">{channelName(j.channel_id)}</span>
      <span className="job-when">
        {j.state === "scheduled"
          ? `fires ${new Date(j.due_at).toLocaleString()}`
          : new Date(j.created_at).toLocaleString()}
      </span>
      <span className="job-extra">
        {j.published_external_url && (
          <a href={j.published_external_url} target="_blank" rel="noreferrer">
            View post
          </a>
        )}
        {j.error_message && <span className="job-error">{j.error_message}</span>}
      </span>
    </div>
  );

  return (
    <>
      <header className="main-top">
        <div className="crumb">
          Producer <span className="sep">›</span> <strong>Queue &amp; history</strong>
        </div>
        <div className="top-meta">
          <button onClick={onRefresh}>Refresh</button>
        </div>
      </header>
      <div className="history">
        <div className="section-head">
          <span className="section-label">Upcoming</span>
          <span className="count-pill">{upcoming.length}</span>
        </div>
        {upcoming.length === 0 ? (
          <div className="empty-strip">Nothing on the schedule.</div>
        ) : (
          <div className="job-list">{upcoming.map(row)}</div>
        )}

        <div className="section-head" style={{ marginTop: 28 }}>
          <span className="section-label">Published history</span>
          <span className="count-pill">{past.length}</span>
        </div>
        {past.length === 0 ? (
          <div className="empty-strip">Nothing published from Producer yet.</div>
        ) : (
          <div className="job-list">{past.map(row)}</div>
        )}
      </div>
    </>
  );
}
