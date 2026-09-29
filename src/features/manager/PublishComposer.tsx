import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc, type Channel, type TargetResult } from "../../lib/ipc";
import { ChannelPostSettings, DEFAULT_CHANNEL_PARAMS, buildChannelOverrides, type ChannelParams } from "../../components/ChannelPostSettings";

/** Real publishing uses the existing native upload + durable outbox boundary. */
export function PublishComposer({ endpointId, channels, onBack, onSubmitted }: {
  endpointId: string; channels: Channel[]; onBack: () => void; onSubmitted: () => void;
}) {
  const available = channels.filter((channel) => channel.endpoint_id === endpointId && channel.status === "active");
  const [caption, setCaption] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [params, setParams] = useState<Record<string, ChannelParams>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [upload, setUpload] = useState<{ upload_id: string; endpoint_id: string; filename: string; kind: string; path: string } | null>(null);
  const [mediaUrl, setMediaUrl] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TargetResult[] | null>(null);
  const submitLock = useRef(false);
  const uploadLock = useRef(false);
  const chosen = available.filter((channel) => selected.has(channel.id));
  const locked = busy || uploading || submitted;
  const source = upload ? convertFileSrc(upload.path) : /^https:\/\//i.test(mediaUrl.trim()) ? mediaUrl.trim() : null;
  const video = upload ? upload.kind === "video" : /\.(mp4|mov|webm)(?:[?#]|$)/i.test(mediaUrl);
  const limits = chosen.map((channel) => channel.capabilities?.text?.maxChars).filter((value): value is number => typeof value === "number");
  const maxChars = limits.length ? Math.min(...limits) : 2200;
  useEffect(() => {
    if (!pickerOpen) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    window.addEventListener("pointerdown", dismiss); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", escape); };
  }, [pickerOpen]);
  function toggle(id: string) {
    if (locked) return;
    setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
    setExpanded((current) => new Set([...current, id]));
  }
  async function pickMedia() {
    if (locked || uploadLock.current) return;
    uploadLock.current = true; setUploading(true); setError(null);
    try {
      const path = await open({ multiple: false, filters: [{ name: "Media", extensions: ["jpg", "jpeg", "png", "webp", "gif", "mp4", "mov", "webm"] }] });
      if (typeof path !== "string") return;
      const result = await ipc.uploadMedia(endpointId, path);
      if (result.endpoint_id !== endpointId) throw new Error("The upload belongs to another workspace.");
      setUpload({ ...result, path }); setMediaUrl("");
    } catch (cause) { setError(String(cause)); }
    finally { uploadLock.current = false; setUploading(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (locked || submitLock.current) return;
    setError(null);
    if (!chosen.length) { setError("Choose a channel before posting."); return; }
    if (!upload && !mediaUrl.trim()) { setError("Add an image or video before posting."); return; }
    if (mediaUrl.trim()) {
      try { if (new URL(mediaUrl.trim()).protocol !== "https:") throw new Error(); }
      catch { setError("Use a public HTTPS media URL."); return; }
    }
    const scheduled = scheduleAt ? new Date(scheduleAt) : null;
    if (scheduled && (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() <= Date.now())) { setError("Choose a future date and time."); return; }
    for (const channel of chosen) {
      const overrides = buildChannelOverrides(params[channel.id] ?? DEFAULT_CHANNEL_PARAMS, channel.platform);
      const text = typeof overrides.caption === "string" ? overrides.caption : caption;
      if (text.length > (channel.capabilities?.text?.maxChars ?? 2200)) { setError(`The caption is too long for ${channel.display_name}.`); return; }
    }
    submitLock.current = true; setBusy(true); setResults(null);
    try {
      const targets = chosen.map((channel) => ({ endpoint_id: endpointId, channel_id: channel.id, overrides: buildChannelOverrides(params[channel.id] ?? DEFAULT_CHANNEL_PARAMS, channel.platform) }));
      const response = await ipc.submitPost({ text: caption || undefined, media_upload_id: upload?.upload_id, media_url: upload ? undefined : mediaUrl.trim() || undefined, schedule_at: scheduled?.toISOString(), targets });
      setSubmitted(true); setResults(response.results);
      if (targets.every((target) => response.results.some((result) => result.channel_id === target.channel_id && result.endpoint_id === endpointId && result.accepted))) onSubmitted();
    } catch (cause) {
      // A network error may occur after durable handoff. Avoid generating a second intent.
      setSubmitted(true); setError(`Couldn’t confirm submission: ${String(cause)}. Check posting activity before submitting again.`);
    } finally { submitLock.current = false; setBusy(false); }
  }
  return <form className="pm-new-post pm-publish-composer" onSubmit={(event) => void submit(event)}>
    <header className="pm-new-post-bar">
      <button type="button" className="pm-unit-back" disabled={busy || uploading} onClick={onBack} aria-label="Back to overview">←</button>
      <div className="pm-unit-meta-title"><span>NEW POST</span><h1>New post</h1><small>Unfiled</small></div>
      <div className="pm-unit-meta-field"><span>CONTENT</span><strong>{source ? video ? "Short video" : "Image" : "Add media"}</strong></div>
      <div className="pm-unit-meta-field pm-new-post-channels" ref={pickerRef}><span>DISTRIBUTION</span><button type="button" className="pm-new-post-channel-trigger" disabled={locked} onClick={() => setPickerOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={pickerOpen} aria-label="Choose channels"><span className="pm-channel-trigger-content">{chosen[0] ? <><span className="pm-publish-avatar">{chosen[0].avatar_url ? <img src={chosen[0].avatar_url} alt="" /> : chosen[0].display_name[0]}</span><span className="pm-channel-trigger-name">{chosen[0].external_handle ? "@" + chosen[0].external_handle.replace(/^@/, "") : chosen[0].display_name}</span>{chosen.length > 1 && <span className="pm-channel-more">+{chosen.length - 1}</span>}</> : "Choose channels"}</span><span aria-hidden="true">⌄</span></button>{pickerOpen && <div className="pm-new-post-channel-menu" role="dialog" aria-label="Distribution channels"><div className="pm-new-post-channel-menu-head">CHANNELS</div>{available.map((channel) => <label className="pm-new-post-channel-option" key={channel.id}><input type="checkbox" checked={selected.has(channel.id)} disabled={locked} onChange={() => toggle(channel.id)} /><span><strong>{channel.external_handle ? "@" + channel.external_handle.replace(/^@/, "") : channel.display_name}</strong><small>{channel.platform}</small></span></label>)}{!available.length && <p>No connected channels. Connect an account in Settings → Integrations.</p>}</div>}</div>
      <div className="pm-unit-meta-field"><span>STAGE</span><strong>{submitted ? "Submitted" : scheduleAt ? "Scheduling" : "Draft"}</strong></div>
    </header>
    <div className="pm-new-post-body">
      <aside className="pm-new-post-preview"><div className="pm-new-post-preview-head"><span>MEDIA</span><small>{upload?.filename ?? (source ? "Media URL" : "No files")}</small></div><div className="pm-new-post-media-frame">{source ? video ? <video src={source} controls /> : <img src={source} alt="Selected media" /> : <div className="pm-new-post-media-empty"><span aria-hidden="true">＋</span><strong>No media yet</strong><small>Add an image or video.</small></div>}</div><div className="pm-new-post-media-actions"><button type="button" disabled={locked || !available.length} onClick={() => void pickMedia()}>{uploading ? "Uploading…" : source ? "Replace media" : "Add media"}</button>{source && <button type="button" disabled={locked} onClick={() => { setUpload(null); setMediaUrl(""); }}>Remove</button>}</div>{!upload && <input className="pm-publish-url" aria-label="Public media URL" placeholder="…or paste a public media URL" disabled={locked} value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} />}</aside>
      <div className="pm-new-post-editor"><div className="pm-new-post-intro"><div><p className="pm-eyebrow">CREATE CONTENT</p><h2>New post</h2></div><button className="pm-new-post-save" type="submit" disabled={locked || !chosen.length || !source}>{busy ? "Submitting…" : submitted ? "Submitted" : scheduleAt ? "Schedule" : "Post now"}</button></div>
        {error && <p className="pm-publish-error" role="alert">{error}</p>}
        {results && <section className="pm-new-post-card" role="status"><h3>SUBMISSION</h3>{results.map((result) => <p key={result.channel_id}>{available.find((channel) => channel.id === result.channel_id)?.display_name ?? "Channel"}: {result.accepted ? "Accepted for publishing" : result.error ?? "Awaiting confirmation"}</p>)}<p>Check posting activity for the final status.</p></section>}
        <section className="pm-new-post-card"><h3>CAPTION <small>{caption.length}/{maxChars}</small></h3><label className="pm-new-post-field"><textarea aria-label="Caption" rows={8} placeholder="Write your caption…" disabled={locked} value={caption} onChange={(event) => setCaption(event.target.value)} /></label></section>
        <section className="pm-new-post-card pm-post-targets"><h3>POST SETTINGS <small>{chosen.length} {chosen.length === 1 ? "channel" : "channels"}</small></h3>{chosen.length ? <div className="channel-cards">{chosen.map((channel) => <ChannelPostSettings key={channel.id} channel={channel} params={params[channel.id] ?? DEFAULT_CHANNEL_PARAMS} expanded={expanded.has(channel.id)} readOnly={locked} onToggle={() => setExpanded((current) => { const next = new Set(current); next.has(channel.id) ? next.delete(channel.id) : next.add(channel.id); return next; })} onPatch={(patch) => setParams((current) => ({ ...current, [channel.id]: { ...(current[channel.id] ?? DEFAULT_CHANNEL_PARAMS), ...patch } }))} onRemove={locked ? undefined : () => toggle(channel.id)} />)}</div> : <p>Choose a channel in Distribution.</p>}</section>
        <section className="pm-new-post-card"><h3>SCHEDULE</h3><input className="pm-publish-schedule" aria-label="Schedule time" type="datetime-local" disabled={locked} value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /><p>Leave empty to post now. Times use this Mac’s timezone.</p></section>
      </div>
    </div>
  </form>;
}
