import { useState } from "react";
import type { Channel } from "../lib/ipc";
import { Select } from "./Select";

/** These are the per-target controls already used by Producer's quick composer. */
export interface ChannelParams {
  useCaption: boolean;
  caption: string;
  feed: boolean;
  location: string;
  userTags: string[];
  collaborators: string[];
  cover_url: string;
  trial_post: boolean;
  reply_control: string;
  topic_tag: string;
  link_attachment: string;
}

export const DEFAULT_CHANNEL_PARAMS: ChannelParams = {
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

export function buildChannelOverrides(params: ChannelParams | undefined, platform: string): Record<string, boolean | string | string[]> {
  if (!params) return {};
  const overrides: Record<string, boolean | string | string[]> = {};
  if (params.useCaption && params.caption.trim()) overrides.caption = params.caption.trim();
  if (platform.toLowerCase() === "instagram") {
    overrides.feed = params.feed;
    if (params.location.trim()) overrides.location = params.location.trim();
    if (params.userTags.length) overrides.userTags = params.userTags;
    if (params.collaborators.length) overrides.collaborators = params.collaborators;
    if (params.cover_url.trim()) overrides.cover_url = params.cover_url.trim();
    if (params.trial_post) overrides.trial_post = true;
  }
  if (platform.toLowerCase() === "threads") {
    if (params.reply_control) overrides.reply_control = params.reply_control;
    if (params.topic_tag.trim()) overrides.topic_tag = params.topic_tag.trim();
    if (params.link_attachment.trim()) overrides.link_attachment = params.link_attachment.trim();
  }
  return overrides;
}

export function updateChannelPresets(existing: Record<string, boolean | string | string[]> | undefined, params: ChannelParams, platform: string): Record<string, boolean | string | string[]> {
  const known = new Set(["caption", "feed", "location", "userTags", "collaborators", "cover_url", "trial_post", "reply_control", "topic_tag", "link_attachment"]);
  // Editing must retain an enabled, empty custom caption and trailing spaces.
  // Publish-time normalization belongs to buildChannelOverrides, not keystrokes.
  return { ...Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => !known.has(key))), ...buildChannelOverrides(params, platform), ...(params.useCaption ? { caption: params.caption } : {}) };
}

export function channelParamsFromPresets(presets?: Record<string, boolean | string | string[]>): ChannelParams {
  const field = (key: string) => typeof presets?.[key] === "string" ? presets[key] as string : "";
  const tags = (key: string) => Array.isArray(presets?.[key]) ? presets[key] as string[] : [];
  return {
    ...DEFAULT_CHANNEL_PARAMS,
    useCaption: Object.prototype.hasOwnProperty.call(presets ?? {}, "caption"),
    caption: field("caption"),
    feed: typeof presets?.feed === "boolean" ? presets.feed : true,
    location: field("location"),
    userTags: tags("userTags"),
    collaborators: tags("collaborators"),
    cover_url: field("cover_url"),
    trial_post: presets?.trial_post === true,
    reply_control: field("reply_control"),
    topic_tag: field("topic_tag"),
    link_attachment: field("link_attachment"),
  };
}

function ChannelSwitch({ on, onChange, disabled = false }: { on: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} disabled={disabled} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)}><span className="knob" /></button>;
}

function ChannelTags({ values, onChange, placeholder, disabled = false }: { values: string[]; onChange: (values: string[]) => void; placeholder: string; disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const safeValues = Array.isArray(values) ? values : [];
  function commit(raw: string) {
    const tag = raw.trim().replace(/^@/, "").replace(/,+$/, "");
    setDraft("");
    if (tag && !safeValues.includes(tag)) onChange([...safeValues, tag]);
  }
  return <div className="tag-input">
    {safeValues.map((value) => <span className="tag-chip" key={value}>@{value}{!disabled && <button type="button" aria-label={"Remove " + value} onClick={() => onChange(safeValues.filter((item) => item !== value))}>✕</button>}</span>)}
    {!disabled && <input value={draft} onChange={(event) => {
      if (event.target.value.endsWith(",")) commit(event.target.value);
      else setDraft(event.target.value);
    }} onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); commit(draft); }
      else if (event.key === "Backspace" && !draft && safeValues.length) onChange(safeValues.slice(0, -1));
    }} onBlur={() => { if (draft) commit(draft); }} placeholder={safeValues.length ? "" : placeholder} />}
  </div>;
}

export function ChannelPostSettings({ channel, params, expanded, onToggle, onPatch, onRemove, readOnly = false }: {
  channel: Channel;
  params: ChannelParams;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<ChannelParams>) => void;
  onRemove?: () => void;
  readOnly?: boolean;
}) {
  const platform = channel.platform.toLowerCase();
  return <div className="channel-acc">
    <div className="acc-head">
      <button type="button" className="acc-disclosure" onClick={onToggle} aria-expanded={expanded} aria-label={(expanded ? "Collapse " : "Expand ") + channel.display_name + " post settings"}>
        <span className={"chev" + (expanded ? " open" : "")}>▸</span>
        <span className="platform">{channel.platform}</span>
        <span className="name">{channel.display_name}</span>
        {channel.external_handle && <span className="muted">@{channel.external_handle.replace(/^@/, "")}</span>}
        <span className="mode-tag">{channel.endpoint_kind === "connected" ? "Boomin" : "Self-hosted"}</span>
      </button>
      {onRemove && !readOnly && <button type="button" className="linkish" onClick={onRemove}>remove</button>}
    </div>
    {expanded && <>
      <div className="acc-row"><span className="acc-group">Caption</span><span className="muted">{params.useCaption ? "Custom for this channel" : "Using global"}</span><span className="acc-control"><ChannelSwitch on={params.useCaption} disabled={readOnly} onChange={(value) => onPatch({ useCaption: value })} /></span></div>
      {params.useCaption && <textarea className="acc-caption" value={params.caption} disabled={readOnly} onChange={(event) => onPatch({ caption: event.target.value })} placeholder={"Caption just for " + channel.display_name + "…"} />}
      {platform === "instagram" && <>
        <div className="acc-row"><span className="acc-label">Show on Feed</span><span className="acc-control"><ChannelSwitch on={params.feed} disabled={readOnly} onChange={(value) => onPatch({ feed: value })} /></span></div>
        <div className="acc-row"><span className="acc-label">Location</span><input value={params.location} disabled={readOnly} onChange={(event) => onPatch({ location: event.target.value })} placeholder="Add location…" /></div>
        <div className="acc-row"><span className="acc-label">User Tags</span><ChannelTags values={params.userTags} disabled={readOnly} onChange={(values) => onPatch({ userTags: values })} placeholder="@username — press Enter to add" /></div>
        <div className="acc-row"><span className="acc-label">Collaborators</span><ChannelTags values={params.collaborators} disabled={readOnly} onChange={(values) => onPatch({ collaborators: values.slice(0, 3) })} placeholder="@collaborator — press Enter to add (max 3)" /></div>
        <div className="acc-row"><span className="acc-group">Cover photo</span><input value={params.cover_url} disabled={readOnly} onChange={(event) => onPatch({ cover_url: event.target.value })} placeholder="https://… (optional — sets the Reel thumbnail)" /></div>
        <div className="acc-row"><span className="acc-group">Trial</span><span className="acc-label">Post as trial reel</span><span className="acc-control"><ChannelSwitch on={params.trial_post} disabled={readOnly} onChange={(value) => onPatch({ trial_post: value })} /></span></div>
      </>}
      {platform === "threads" && <>
        <div className="acc-row"><span className="acc-label">Who can reply</span><Select size="sm" value={params.reply_control} disabled={readOnly} onChange={(value) => onPatch({ reply_control: value })} title="Who can reply" options={[{ value: "", label: "Everyone (default)" }, { value: "accounts_you_follow", label: "Accounts you follow" }, { value: "mentioned_only", label: "Mentioned only" }]} /></div>
        <div className="acc-row"><span className="acc-label">Topic tag</span><input value={params.topic_tag} disabled={readOnly} onChange={(event) => onPatch({ topic_tag: event.target.value })} placeholder="one topic, no # needed (e.g. Producer)" /></div>
        <div className="acc-row"><span className="acc-label">Link attachment</span><input value={params.link_attachment} disabled={readOnly} onChange={(event) => onPatch({ link_attachment: event.target.value })} placeholder="https://… (text-only posts — shows a preview card)" /></div>
      </>}
    </>}
  </div>;
}
