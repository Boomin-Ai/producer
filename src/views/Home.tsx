import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Channel, EndpointInfo, Job, TargetResult } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useUpdater } from "../lib/updater";
import { LiveView } from "./Live";

const STATE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  canceled: "Canceled",
};

type MainView = "compose" | "history" | "live";

interface Attached {
  upload_id: string;
  filename: string;
  endpoint_id: string;
  kind: string;
  local_path: string;
}

/** Per-channel platform params. Each platform gets its own real knobs:
 *  Instagram mirrors the web ChannelAccordion; Threads carries reply
 *  control, one topic tag, and a text-only link attachment. */
interface ChannelParams {
  useCaption: boolean;
  caption: string;
  // instagram
  feed: boolean;
  location: string;
  userTags: string[];
  collaborators: string[];
  cover_url: string;
  trial_post: boolean;
  // threads
  reply_control: string;
  topic_tag: string;
  link_attachment: string;
}

const DEFAULT_PARAMS: ChannelParams = {
  useCaption: false,
  caption: "",
  feed: true,
  location: "",
  userTags: [],
  collaborators: [],
  cover_url: "",
  trial_post: false,
  reply_control: "",
  topic_tag: "",
  link_attachment: "",
};

function buildOverrides(p: ChannelParams | undefined, platform: string): Record<string, unknown> | undefined {
  if (!p) return undefined;
  const o: Record<string, unknown> = {};
  if (p.useCaption && p.caption.trim()) o.caption = p.caption.trim();
  if (platform === "instagram") {
    o.feed = p.feed;
    if (p.location.trim()) o.location = p.location.trim();
    if (p.userTags.length) o.userTags = p.userTags;
    if (p.collaborators.length) o.collaborators = p.collaborators;
    if (p.cover_url.trim()) o.cover_url = p.cover_url.trim();
    if (p.trial_post) o.trial_post = true;
  }
  if (platform === "threads") {
    if (p.reply_control) o.reply_control = p.reply_control;
    if (p.topic_tag.trim()) o.topic_tag = p.topic_tag.trim();
    if (p.link_attachment.trim()) o.link_attachment = p.link_attachment.trim();
  }
  return o;
}

/** Chip-style tag input: Enter/comma adds, Backspace on empty or ✕
 *  removes. Emits a clean array — no separator parsing downstream. */
function TagInput({
  values: rawValues,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  // Defensive: survive stale in-memory state from hot reloads or older
  // shapes — never let a non-array white-screen the composer.
  const values = Array.isArray(rawValues) ? rawValues : [];

  function commit() {
    const tag = draft.trim().replace(/^@/, "").replace(/,+$/, "");
    setDraft("");
    if (tag && !values.includes(tag)) onChange([...values, tag]);
  }

  return (
    <div className="tag-input">
      {values.map((v) => (
        <span key={v} className="tag-chip">
          @{v}
          <button
            type="button"
            aria-label={`remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => {
          if (e.target.value.endsWith(",")) {
            setDraft(e.target.value);
            commit();
          } else {
            setDraft(e.target.value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length ? "" : placeholder}
      />
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
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
  const updater = useUpdater();
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

        <div className="side-label">Live</div>
        <button className={`side-item${view === "live" ? " active" : ""}`} onClick={() => setView("live")}>
          Go live
        </button>

        <div className="side-label">Collections</div>
        <div className="side-soon">Series &amp; collections arrive with the creation phase.</div>

        <div className="side-spacer" />

        {updater.state === "ready" && (
          <button className="side-item update-ready" onClick={updater.restart} title={`Producer ${updater.version} is staged`}>
            <span className="update-dot" />
            Update ready — Restart
          </button>
        )}

        <div className="side-label">Workspaces</div>
        {endpoints.map((ep) => (
          <div
            key={ep.id}
            className="side-endpoint"
            title={`${ep.kind === "connected" ? "Boomin workspace" : "Self-hosted server"} · ${ep.base_url}`}
          >
            <span className={`dot ${ep.kind}`} />
            <span className="name">{ep.name}</span>
            <button onClick={() => onRemoveEndpoint(ep.id)} title="Disconnect workspace">
              ✕
            </button>
          </div>
        ))}
        <button className="side-item" onClick={onAddEndpoint}>
          + Add workspace
        </button>
      </aside>

      <main className="main">
        {view === "live" ? (
          <LiveView />
        ) : view === "compose" ? (
          <ComposerDetail
            channels={channels.filter((c) => c.status === "active")}
            independents={endpoints.filter((e) => e.kind === "independent")}
            onRefreshChannels={loadChannels}
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
  independents,
  onRefreshChannels,
  loadError,
  onSubmitted,
}: {
  channels: Channel[];
  independents: EndpointInfo[];
  onRefreshChannels: () => void;
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connectPending, setConnectPending] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, ChannelParams>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(channelId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  async function startConnect(endpointId: string, platform: string) {
    setConnectError(null);
    try {
      const { browser_url } = await ipc.connectChannel(endpointId, platform);
      await openUrl(browser_url);
      setConnectPending(true);
    } catch (e) {
      setConnectError(String(e));
    }
  }

  function patchParams(channelId: string, patch: Partial<ChannelParams>) {
    setParams((prev) => ({
      ...prev,
      [channelId]: { ...(prev[channelId] ?? DEFAULT_PARAMS), ...patch },
    }));
  }

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
        .map((c) => ({
          endpoint_id: c.endpoint_id,
          channel_id: c.id,
          overrides: buildOverrides(params[c.id] ?? DEFAULT_PARAMS, c.platform),
        }));
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
          <span className="meta-block dist-block">
            <span className="meta-label">Distribution</span>
            <span className="meta-value">
              {selected.size} channel{selected.size === 1 ? "" : "s"}
              <button
                className="pencil"
                title="Choose channels"
                onClick={() => setPickerOpen((o) => !o)}
              >
                ✎
              </button>
            </span>
            {pickerOpen && (
              <>
                <div className="popover-backdrop" onClick={() => setPickerOpen(false)} />
                <div className="channel-popover">
                  <div className="popover-label">Channels</div>
                  {channels.length === 0 ? (
                    <div className="popover-empty">No publishable channels yet.</div>
                  ) : (
                    channels.map((c) => (
                      <label key={c.id} className="popover-row">
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                        <span className="popover-row-text">
                          <span className="popover-name">{c.display_name}</span>
                          <span className="popover-sub">
                            {c.platform}
                            {c.endpoint_kind === "independent" ? " · self-hosted" : ""}
                          </span>
                        </span>
                      </label>
                    ))
                  )}
                  {independents.length > 0 && (
                    <>
                      <div className="popover-divider" />
                      <div className="popover-label">Connect new</div>
                      {connectPending ? (
                        <div className="popover-connect-hint">
                          Finish approving in your browser, then
                          <button
                            className="linkish"
                            onClick={() => {
                              onRefreshChannels();
                              setConnectPending(false);
                            }}
                          >
                            refresh channels
                          </button>
                        </div>
                      ) : (
                        independents.map((ep) => (
                          <div key={ep.id} className="popover-connect-row">
                            <span className="popover-sub">{ep.name}</span>
                            {["instagram", "facebook", "threads"].map((p) => (
                              <button key={p} className="platform-btn" onClick={() => startConnect(ep.id, p)}>
                                {p}
                              </button>
                            ))}
                          </div>
                        ))
                      )}
                      {connectError && <div className="popover-empty error">{connectError}</div>}
                    </>
                  )}
                </div>
              </>
            )}
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
            {selected.size === 0 ? (
              <div className="empty-strip">
                No channels selected.
                {channels.length === 0 &&
                  " Connected workspaces pick up channels from the Boomin web app; self-hosted servers list them once a platform is connected there."}
              </div>
            ) : (
              <div className="channel-cards">
                {channels
                  .filter((c) => selected.has(c.id))
                  .map((c) => {
                    const p = params[c.id] ?? DEFAULT_PARAMS;
                    const isOpen = expanded.has(c.id);
                    return (
                      <div key={c.id} className="channel-acc">
                        <div
                          className="acc-head clickable"
                          onClick={() => toggleExpanded(c.id)}
                          role="button"
                          aria-expanded={isOpen}
                        >
                          <span className={`chev${isOpen ? " open" : ""}`}>▸</span>
                          <span className="platform">{c.platform}</span>
                          <span className="name">{c.display_name}</span>
                          {c.external_handle && (
                            <span className="muted">@{c.external_handle}</span>
                          )}
                          <span className="mode-tag">
                            {c.endpoint_kind === "connected" ? "Boomin" : "Self-hosted"}
                          </span>
                          <button
                            className="linkish"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(c.id);
                            }}
                          >
                            remove
                          </button>
                        </div>

                        {isOpen && (
                          <>
                        <div className="acc-row">
                          <span className="acc-group">Caption</span>
                          <span className="muted">
                            {p.useCaption ? "Custom for this channel" : "Using global"}
                          </span>
                          <span className="acc-control">
                            <Switch
                              on={p.useCaption}
                              onChange={(v) => patchParams(c.id, { useCaption: v })}
                            />
                          </span>
                        </div>
                        {p.useCaption && (
                          <textarea
                            className="acc-caption"
                            value={p.caption}
                            onChange={(e) => patchParams(c.id, { caption: e.target.value })}
                            placeholder={`Caption just for ${c.display_name}…`}
                          />
                        )}

                        {c.platform === "instagram" && (
                          <>
                            <div className="acc-row">
                              <span className="acc-label">Show on Feed</span>
                              <span className="acc-control">
                                <Switch on={p.feed} onChange={(v) => patchParams(c.id, { feed: v })} />
                              </span>
                            </div>
                            <div className="acc-row">
                              <span className="acc-label">Location</span>
                              <input
                                value={p.location}
                                onChange={(e) => patchParams(c.id, { location: e.target.value })}
                                placeholder="Add location…"
                              />
                            </div>
                            <div className="acc-row">
                              <span className="acc-label">User Tags</span>
                              <TagInput
                                values={p.userTags}
                                onChange={(v) => patchParams(c.id, { userTags: v })}
                                placeholder="@username — press Enter to add"
                              />
                            </div>
                            <div className="acc-row">
                              <span className="acc-label">Collaborators</span>
                              <TagInput
                                values={p.collaborators}
                                onChange={(v) => patchParams(c.id, { collaborators: v.slice(0, 3) })}
                                placeholder="@collaborator — press Enter to add (max 3)"
                              />
                            </div>
                            <div className="acc-row">
                              <span className="acc-group">Cover photo</span>
                              <input
                                value={p.cover_url}
                                onChange={(e) => patchParams(c.id, { cover_url: e.target.value })}
                                placeholder="https://… (optional — sets the Reel thumbnail)"
                              />
                            </div>
                            <div className="acc-row">
                              <span className="acc-group">Trial</span>
                              <span className="acc-label">Post as trial reel</span>
                              <span className="acc-control">
                                <Switch
                                  on={p.trial_post}
                                  onChange={(v) => patchParams(c.id, { trial_post: v })}
                                />
                              </span>
                            </div>
                          </>
                        )}

                        {c.platform === "threads" && (
                          <>
                            <div className="acc-row">
                              <span className="acc-label">Who can reply</span>
                              <select
                                className="acc-select"
                                value={p.reply_control}
                                onChange={(e) => patchParams(c.id, { reply_control: e.target.value })}
                              >
                                <option value="">Everyone (default)</option>
                                <option value="accounts_you_follow">Accounts you follow</option>
                                <option value="mentioned_only">Mentioned only</option>
                              </select>
                            </div>
                            <div className="acc-row">
                              <span className="acc-label">Topic tag</span>
                              <input
                                value={p.topic_tag}
                                onChange={(e) => patchParams(c.id, { topic_tag: e.target.value })}
                                placeholder="one topic, no # needed (e.g. Producer)"
                              />
                            </div>
                            <div className="acc-row">
                              <span className="acc-label">Link attachment</span>
                              <input
                                value={p.link_attachment}
                                onChange={(e) => patchParams(c.id, { link_attachment: e.target.value })}
                                placeholder="https://… (text-only posts — shows a preview card)"
                              />
                            </div>
                          </>
                        )}
                          </>
                        )}
                      </div>
                    );
                  })}
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
