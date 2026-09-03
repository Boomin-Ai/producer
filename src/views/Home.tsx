import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Channel, EndpointInfo, Job, LiveDestination, LiveRoom, LiveSnapshot } from "../lib/ipc";
import type { TargetResult } from "../lib/ipc";
import { ipc,
  network,
  networkConnections,
  networkJoin,
  registerRoom,
  roomSetVisibility,
  type NetworkStatus,
  type NetworkInvitation,
  type NetworkBrandCard,
  type NetworkConnectionRow,
  type NetworkLiveRoom,
} from "../lib/ipc";
import { demoOn, setDemo } from "../lib/demo";
import { markRoomClick } from "../lib/perf";
import { KEYMAP, getKey, setKey, resetKey, displayKey, type KeyBinding } from "../lib/keys";
import { liveRoomId, parseConfig, serializeConfig } from "../lib/room";
import { useUpdater } from "../lib/updater";
import { DestinationEditor, LiveView } from "./Live";

const STATE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  canceled: "Canceled",
};

type MainView =
  | { kind: "home" }
  | { kind: "room"; room: LiveRoom }
  | { kind: "compose" }
  | { kind: "history" };

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

/** Preset → dot color for the channel spine. */
const PRESET_TONE: Record<string, string> = {
  twitch: "#a970ff",
  kick: "#53fc18",
  youtube: "#ff4e45",
  custom: "#8b93a7",
  instagram: "#e1306c",
  facebook: "#1877f2",
  threads: "#e7eaf3",
};

function fmtAgo(iso: string | null): string {
  if (!iso) return "never live";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "live just now";
  if (m < 60) return `live ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `live ${h}h ago`;
  return `live ${Math.floor(h / 24)}d ago`;
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
  const [view, setView] = useState<MainView>({ kind: "home" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Home is SURFACES, not one long page: Rooms (the stage list) and Manager
  // (channels, network, rundown — productions soon). The rail switches them.
  const [surface, setSurface] = useState<"rooms" | "manager">("rooms");
  // Rooms strip the window glass so stage overlays work (shim.m); returning
  // home puts it back.
  useEffect(() => {
    if (view.kind === "home") ipc.liveHomeGlass().catch(() => {});
  }, [view.kind]);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const updater = useUpdater();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [destinations, setDestinations] = useState<LiveDestination[]>([]);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
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
    if (firstError) setErrorDismissed(false);
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

  const loadLive = useCallback(async () => {
    try {
      setRooms(await ipc.liveListRooms());
      setDestinations(await ipc.liveListDestinations());
      setSnapshot(await ipc.liveEngineStatus());
    } catch {
      /* engine-less build — live sections render empty */
    }
  }, []);

  useEffect(() => {
    loadChannels();
    loadJobs();
    loadLive();
  }, [loadChannels, loadJobs, loadLive]);

  // Keep the ON AIR state honest while sitting on home.
  useEffect(() => {
    if (view.kind !== "home") return;
    const t = setInterval(() => {
      ipc.liveEngineStatus().then(setSnapshot).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [view.kind]);

  const streaming =
    snapshot?.session_state === "streaming" ||
    snapshot?.session_state === "starting" ||
    snapshot?.session_state === "stopping";

  const back = () => {
    setView({ kind: "home" });
    loadLive();
    loadJobs();
  };

  const title = view.kind === "compose" ? "New post" : view.kind === "history" ? "Rundown" : null;

  // The room owns the entire window, its own top bar included (mock-faithful).
  if (view.kind === "room") {
    return (
      <>
        {loadError && !errorDismissed && (
          <SystemBanner message={loadError} onDismiss={() => setErrorDismissed(true)} />
        )}
        <LiveView
          key={view.room.id}
          room={view.room}
          onLeave={back}
        />
      </>
    );
  }

  return (
    <div className={view.kind === "home" ? "cr cr--vibrant" : "cr"}>
      <header className="cr-top" data-tauri-drag-region>
        <div className="cr-top-left" data-tauri-drag-region>
          {view.kind !== "home" && (
            <button className="cr-back" onClick={back} title="Back to the control room">
              ✕
            </button>
          )}
          <span className="cr-brand" data-tauri-drag-region>
            PRODUCER
          </span>
          {title && <span className="cr-title">{title}</span>}
          {streaming && <span className="cr-live-pill">LIVE</span>}
        </div>
        <div className="cr-top-drag" data-tauri-drag-region />

        <div className="cr-top-right">
          {updater.state === "ready" && (
            <button className="cr-update" onClick={updater.restart} title={`Producer ${updater.version} is staged`}>
              <span className="update-dot" /> Restart to update
            </button>
          )}
        </div>
      </header>

      {loadError && !errorDismissed && (
        <SystemBanner message={loadError} onDismiss={() => setErrorDismissed(true)} />
      )}

      {settingsOpen && (
        <SettingsSheet
          endpoints={endpoints}
          destinations={destinations}
          channels={channels}
          onChannelsChanged={loadLive}
          onAddEndpoint={() => {
            setSettingsOpen(false);
            onAddEndpoint();
          }}
          onRemoveEndpoint={onRemoveEndpoint}
          updater={updater}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {view.kind === "home" && (
        <HomeRail
          brandName={endpoints[0]?.name ?? "Workspace"}
          surface={surface}
          onSurface={setSurface}
          onCompose={() => setView({ kind: "compose" })}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      {view.kind === "home" && (
        <ControlRoomHome
          surface={surface}
          rooms={rooms}
          channels={channels}
          jobs={jobs}
          streaming={streaming}
          onOpenRoom={(room) => {
            markRoomClick();
            setView({ kind: "room", room });
          }}
          onRoomsChanged={loadLive}
          onCompose={() => setView({ kind: "compose" })}
          onHistory={() => setView({ kind: "history" })}
        />
      )}

      {view.kind === "compose" && (
        <main className="cr-page">
          <ComposerDetail
            channels={channels.filter((c) => c.status === "active")}
            independents={endpoints.filter((e) => e.kind === "independent")}
            onRefreshChannels={loadChannels}
              onSubmitted={() => {
              loadJobs();
              setView({ kind: "history" });
            }}
          />
        </main>
      )}

      {view.kind === "history" && (
        <main className="cr-page">
          <HistoryView jobs={jobs} channels={channels} onRefresh={loadJobs} />
        </main>
      )}
    </div>
  );
}

/** System-level trouble (workspace fetch, keychain, engine) belongs in one
 * predictable place — a dismissible banner at the bottom of the app — not
 * inline in whatever section happened to notice it. */
function SystemBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  // macOS keychain refuses to prompt while the machine is in dark wake; say
  // so plainly instead of leaking the raw platform string.
  const darkWake = /dark wake|no UI possible/i.test(message);
  return (
    <div className="sys-banner" role="status">
      <span className="sys-banner-dot" />
      <span className="sys-banner-text">
        {darkWake
          ? "macOS wouldn't unlock the keychain while the Mac was half-asleep. Wake it fully and reopen Producer."
          : message}
      </span>
      {darkWake && <span className="sys-banner-raw">{message}</span>}
      <button className="sys-banner-x" onClick={onDismiss} title="Dismiss">
        ✕
      </button>
    </div>
  );
}


/** Channels — live destinations + social channels. Lives in SETTINGS (the
 * profile popout): channels are workspace facts you configure, not a surface
 * you work in. */
function ChannelsBlock({
  destinations,
  channels,
  onChanged,
}: {
  destinations: LiveDestination[];
  channels: Channel[];
  onChanged: () => void;
}) {
  const [addingDest, setAddingDest] = useState(false);
  const [editingDest, setEditingDest] = useState<LiveDestination | null>(null);
  return (
      <section className="cr-section" id="sec-channels">
        <div className="cr-label">CHANNELS</div>
        <div className="cr-channels">
          {destinations.map((d) => (
            <button
              key={d.id}
              className={`cr-chip${d.enabled ? "" : " off"}`}
              title={`${d.preset} · key in Keychain — click to edit`}
              onClick={() => setEditingDest(d)}
            >
              <span className="cr-chip-dot" style={{ background: PRESET_TONE[d.preset] ?? "#8b93a7" }} />
              {d.label}
              <span className="cr-chip-kind">live</span>
            </button>
          ))}
          {channels.map((c) => (
            <span key={c.id} className="cr-chip static" title={`${c.platform} via ${c.endpoint_kind === "connected" ? "Boomin" : "self-hosted"}`}>
              <span className="cr-chip-dot" style={{ background: PRESET_TONE[c.platform] ?? "#8b93a7" }} />
              {c.display_name}
              <span className="cr-chip-kind">{c.platform}</span>
            </span>
          ))}
          <button className="cr-chip add" onClick={() => setAddingDest(true)}>
            + Add
          </button>
        </div>
        {(addingDest || editingDest) && (
          <div className="cr-dest-editor">
            <DestinationEditor
              existing={editingDest}
              onSaved={() => {
                setAddingDest(false);
                setEditingDest(null);
                onChanged();
              }}
              onCancel={() => {
                setAddingDest(false);
                setEditingDest(null);
              }}
            />
            <div className="cr-hint">
              Live channels stream from rooms. Social channels join through your Boomin workspace and
              receive posts.
            </div>
          </div>
        )}
      </section>
  );
}

function SettingsSheet({
  endpoints,
  destinations,
  channels,
  onChannelsChanged,
  onAddEndpoint,
  onRemoveEndpoint,
  updater,
  onClose,
}: {
  endpoints: EndpointInfo[];
  destinations: LiveDestination[];
  channels: Channel[];
  onChannelsChanged: () => void;
  onAddEndpoint: () => void;
  onRemoveEndpoint: (id: string) => void;
  updater: { state: string; version: string | null; restart: () => void };
  onClose: () => void;
}) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  type RepoRelease = { tag_name: string; name: string | null; body: string | null; published_at: string; html_url: string };
  const [releases, setReleases] = useState<RepoRelease[] | null | "err">(null);
  useEffect(() => {
    fetch("https://api.github.com/repos/Boomin-Ai/producer/releases?per_page=8")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((rs: RepoRelease[]) => setReleases(rs))
      .catch(() => setReleases("err"));
  }, []);
  const linkifyRel = (text: string) =>
    text.split(/(#\d+|https?:\/\/\S+)/g).map((part, k) => {
      if (/^#\d+$/.test(part))
        return (
          <a key={k} className="upd-ref" onClick={() => openUrl(`https://github.com/Boomin-Ai/producer/issues/${part.slice(1)}`).catch(() => {})}>
            {part}
          </a>
        );
      if (/^https?:\/\//.test(part))
        return (
          <a key={k} className="upd-ref" onClick={() => openUrl(part).catch(() => {})}>
            {part.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
          </a>
        );
      return part;
    });

  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
      <ChannelsBlock destinations={destinations} channels={channels} onChanged={onChannelsChanged} />

  return (
    <>
      <div className="cr-sheet-backdrop" onClick={onClose} />
      <aside className="cr-sheet">
        <div className="cr-sheet-head">
          <span className="cr-sheet-title">Settings</span>
          <button className="cr-back" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="cr-label">WORKSPACES</div>
        <div className="cr-sheet-rows">
          {endpoints.map((ep) => (
            <div key={ep.id} className="cr-sheet-row" title={ep.base_url}>
              <span className={`dot ${ep.kind}`} />
              <span className="cr-sheet-row-name">{ep.name}</span>
              <span className="cr-sheet-row-sub">
                {ep.kind === "connected" ? "Boomin" : "self-hosted"}
              </span>
              <button onClick={() => onRemoveEndpoint(ep.id)} title="Disconnect workspace">
                ✕
              </button>
            </div>
          ))}
          <button className="cr-ghost" onClick={onAddEndpoint}>
            + Add workspace
          </button>
        </div>

        <div className="cr-label" style={{ marginTop: 28 }}>
          APP
        </div>
        <div className="cr-sheet-rows">
          <div className="cr-sheet-row">
            <span className="cr-sheet-row-name">Producer {appVersion ?? ""}</span>
            {updater.state === "ready" ? (
              <button className="cr-primary" onClick={updater.restart}>
                Restart to update{updater.version ? ` to ${updater.version}` : ""}
              </button>
            ) : updater.state === "downloading" ? (
              <span className="cr-sheet-row-sub">downloading update…</span>
            ) : (
              <span className="cr-sheet-row-sub">up to date — updates install themselves</span>
            )}
          </div>
        </div>

        <div className="cr-label" style={{ marginTop: 28 }}>
          SHORTCUTS
        </div>
        <div className="ks">
          {KEYMAP.map((b) => (
            <KeyRow key={b.id} b={b} />
          ))}
          {/* The grammar — fixed on purpose, listed so it can be learned. */}
          {([
            ["⌘1–9", "Cut to a scene"],
            ["Arrows", "Nudge selected (⇧ ×10)"],
            ["⌥ drag edge", "Crop instead of scale"],
            ["Esc", "Deselect"],
          ] as const).map(([k, label]) => (
            <div key={k} className="ks-row fixed">
              <span className="ks-label">{label}</span>
              <span className="ks-key">{k}</span>
            </div>
          ))}
        </div>

        <div className="cr-label" style={{ marginTop: 28 }}>
          WHAT'S NEW
        </div>
        <div className="upd upd-sheet">
          {releases === null && <div className="cr-sheet-row-sub">Checking…</div>}
          {releases === "err" && (
            <div className="cr-sheet-row-sub">The update stream goes live when the repo does.</div>
          )}
          {Array.isArray(releases) &&
            releases.map((r) => (
              <div key={r.tag_name} className="upd-item">
                <div className="upd-head" onClick={() => openUrl(r.html_url).catch(() => {})}>
                  <span className="upd-tag">{r.tag_name}</span>
                  <span className="upd-name">{r.name || ""}</span>
                  <span className="upd-date">
                    {new Date(r.published_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
                {r.body && (
                  <div className="upd-body">
                    {r.body
                      .split("\n")
                      .filter((l) => l.trim())
                      .slice(0, 4)
                      .map((l, k) => (
                        <p key={k}>{linkifyRel(l.replace(/^[-*#\s]+/, ""))}</p>
                      ))}
                  </div>
                )}
              </div>
            ))}
        </div>

        <div className="cr-label" style={{ marginTop: 28 }}>
          DEV
        </div>
        <div className="cr-sheet-rows">
          <div className="cr-sheet-row">
            <span className="cr-sheet-row-name">Demo data</span>
            <span className="cr-sheet-row-sub">fake chat, alerts &amp; canvas footage</span>
            <Switch
              on={demoOn()}
              onChange={(v) => {
                setDemo(v);
                window.location.reload();
              }}
            />
          </div>
        </div>

      </aside>
    </>
  );
}

function ControlRoomHome({
  surface,
  rooms,
  channels,
  jobs,
  streaming,
  onOpenRoom,
  onRoomsChanged,
  onCompose,
  onHistory,
}: {
  surface: "rooms" | "manager";
  rooms: LiveRoom[];
  channels: Channel[];
  jobs: Job[];
  streaming: boolean;
  onOpenRoom: (room: LiveRoom) => void;
  onRoomsChanged: () => void;
  onCompose: () => void;
  onHistory: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const liveRoom = streaming ? liveRoomId() : null;
  const [name, setName] = useState("");

  const upcoming = jobs.filter((j) => ["scheduled", "queued", "publishing"].includes(j.state));
  const recent = jobs.filter((j) => !["scheduled", "queued", "publishing"].includes(j.state)).slice(0, 3);

  async function createRoom() {
    const n = name.trim();
    if (!n) return;
    setName("");
    setNaming(false);
    const room = await ipc.liveCreateRoom(n);
    onRoomsChanged();
    onOpenRoom(room);
  }

  return (
    <main className={`cr-home${surface === "rooms" ? " has-net-rail" : ""}`}>
      {surface === "rooms" && (
      <>
      {/* Network lives at HOME, never inside a room: a failed network call
        * here is harmless, whereas mid-broadcast it would be noise over a
        * running show. The rail is FIXED against the icon rail — attached,
        * full height, part of the furniture rather than a floating card. */}
      <NetworkRail />
      <LiveNowStrip />
      <section className="cr-section" id="sec-onair">
        <div className="cr-label">
          ON AIR
          {streaming && <span className="cr-live-pill">LIVE</span>}
        </div>
        <div className="cr-rooms">
          {rooms.map((room) => (
            <button
              key={room.id}
              className={`cr-room${liveRoom === room.id ? " onair" : ""}`}
              onClick={() => onOpenRoom(room)}
            >
              <span className="cr-room-name">{room.name}</span>
              <span className="cr-room-meta">
                {liveRoom === room.id ? "streaming now — click to return" : fmtAgo(room.last_live_at)}
              </span>
              {liveRoom === room.id && (
                <span className="cr-room-live">
                  <span className="rm-live-dot" />
                  LIVE
                </span>
              )}
              <span
                className="cr-room-del"
                title={liveRoom === room.id ? "Stop the stream first" : "Delete room"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (liveRoom === room.id) return;
                  ipc.liveDeleteRoom(room.id).then(onRoomsChanged);
                }}
              >
                ✕
              </span>
              <RoomShareChip room={room} onChanged={onRoomsChanged} />
            </button>
          ))}
          {naming ? (
            <form
              className="cr-room cr-room-new naming"
              onSubmit={(e) => {
                e.preventDefault();
                createRoom();
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => (name.trim() ? createRoom() : setNaming(false))}
                onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
                placeholder="Name your show…"
              />
            </form>
          ) : (
            <button className="cr-room cr-room-new" onClick={() => setNaming(true)}>
              <span className="cr-room-plus">+</span>
              <span className="cr-room-name">New room</span>
              <span className="cr-room-meta">a stage of its own</span>
            </button>
          )}
        </div>
      </section>

      </>
      )}

      {surface === "manager" && (
      <>


      <section className="cr-section" id="sec-rundown">
        <div className="cr-label">
          RUNDOWN
          <span className="cr-label-actions">
            <button className="cr-primary" onClick={onCompose}>
              New post
            </button>
            <button className="cr-ghost" onClick={onHistory}>
              Everything ▸
            </button>
          </span>
        </div>
        {upcoming.length === 0 && recent.length === 0 ? (
          <div className="cr-hint">Nothing scheduled. Write once, post everywhere.</div>
        ) : (
          <div className="cr-rundown">
            {upcoming.slice(0, 4).map((j) => (
              <div key={j.id} className="cr-run-row">
                <span className={`chip ${j.state}`}>{STATE_LABEL[j.state] ?? j.state}</span>
                <span className="cr-run-name">
                  {channels.find((c) => c.id === j.channel_id)?.display_name ?? "channel"}
                </span>
                <span className="cr-run-when">
                  {j.state === "scheduled" ? new Date(j.due_at).toLocaleString() : new Date(j.created_at).toLocaleString()}
                </span>
              </div>
            ))}
            {recent.map((j) => (
              <div key={j.id} className="cr-run-row past">
                <span className={`chip ${j.state}`}>{STATE_LABEL[j.state] ?? j.state}</span>
                <span className="cr-run-name">
                  {channels.find((c) => c.id === j.channel_id)?.display_name ?? "channel"}
                </span>
                <span className="cr-run-when">{new Date(j.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      </>
      )}
    </main>
  );
}

function ComposerDetail({
  channels,
  independents,
  onRefreshChannels,
  onSubmitted,
}: {
  channels: Channel[];
  independents: EndpointInfo[];
  onRefreshChannels: () => void;
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

/** Brand Network at a glance: how many are live, who's waiting on you, and a
 * slug field to invite someone. Slugs are unique platform-wide, so typing one
 * addresses a brand exactly — no picker needed. */
/** Resolve the connected Boomin endpoint once — every network surface needs it. */
function useConnectedEndpoint(): string | null {
  const [endpointId, setEndpointId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .listEndpoints()
      .then((eps) => {
        const ep = eps.find((e) => e.kind === "connected") ?? eps[0];
        if (alive && ep) setEndpointId(ep.id);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return endpointId;
}

/** The network rail — a left column on the control room home.
 *
 * Discovery is EXACT-HANDLE ONLY, by design: Producer is never handed the
 * directory list, so the Find tab resolves a handle you were given and
 * nothing more. Connected shows the brands who already said yes, with the
 * inbox of open handshakes above them. */
function NetworkRail() {
  const endpointId = useConnectedEndpoint();
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [inbox, setInbox] = useState<NetworkInvitation[]>([]);
  const [conns, setConns] = useState<NetworkConnectionRow[]>([]);
  const [tab, setTab] = useState<"connected" | "find">("connected");
  const [slug, setSlug] = useState("");
  const [card, setCard] = useState<NetworkBrandCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    const [st, inv, cn] = await Promise.all([
      network.status(id).catch(() => null),
      network.invitations(id, "inbox").catch(() => null),
      networkConnections(id).catch(() => null),
    ]);
    if (st) setStatus(st);
    setInbox((inv?.invitations ?? []).filter((i) => i.status === "invited"));
    setConns(cn?.connections ?? []);
  }, []);

  useEffect(() => {
    if (endpointId) void load(endpointId);
  }, [endpointId, load]);

  if (!endpointId) return null;

  const liveNow = status?.network?.live_now ?? 0;
  const members = status?.network?.members ?? 0;

  const find = async () => {
    const q = slug.trim().replace(/^@/, "");
    if (!q || !endpointId) return;
    setBusy(true);
    setNote(null);
    setCard(null);
    try {
      setCard(await network.lookup(endpointId, q));
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const inviteCard = async () => {
    if (!endpointId || !card) return;
    setBusy(true);
    try {
      const res = await network.invite(endpointId, card.brand.slug);
      // A counter-invite IS acceptance server-side.
      setNote(res.kind === "connected" ? `Connected with ${card.brand.name}.` : `Invited ${card.brand.name}.`);
      setCard(await network.lookup(endpointId, card.brand.slug).catch(() => null) ?? null);
      void load(endpointId);
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: "accept" | "decline") => {
    if (!endpointId) return;
    await network.act(endpointId, id, action).catch(() => {});
    void load(endpointId);
    if (card) setCard(await network.lookup(endpointId, card.brand.slug).catch(() => null) ?? null);
  };

  if (!status?.membership) {
    return (
      <aside className="net-rail">
        <div className="net-rail-head">NETWORK</div>
        <div className="cr-hint">
          List your brand on the Boomin network to connect with other producers and open your stages to them.
        </div>
        <button
          className="cr-primary"
          onClick={() => networkJoin(endpointId).then(() => load(endpointId)).catch(() => {})}
        >
          Join the network
        </button>
      </aside>
    );
  }

  return (
    <aside className="net-rail">
      <div className="net-rail-head">
        NETWORK
        <span className="net-count">
          <span className="net-dot" />
          {liveNow} live
          <span className="net-of">of {members}</span>
        </span>
      </div>

      <div className="net-tabs">
        <button className={tab === "connected" ? "on" : ""} onClick={() => setTab("connected")}>
          Connected{conns.length ? ` · ${conns.length}` : ""}
          {inbox.length > 0 && <span className="net-badge">{inbox.length}</span>}
        </button>
        <button className={tab === "find" ? "on" : ""} onClick={() => setTab("find")}>
          Find
        </button>
      </div>

      {tab === "connected" && (
        <div className="net-list">
          {inbox.map((i) => (
            <div key={i.id} className="net-invite">
              <span className="net-invite-name">{i.brand?.name ?? i.brand?.slug}</span>
              {i.message && <span className="net-invite-msg">{i.message}</span>}
              <button className="cr-primary" onClick={() => act(i.id, "accept")}>
                Accept
              </button>
              <button className="net-decline" onClick={() => act(i.id, "decline")}>
                Decline
              </button>
            </div>
          ))}
          {conns.map((c) => (
            <div key={c.connection.id} className="net-conn">
              {c.counterparty.avatarUrl ? (
                <img className="net-ava" src={c.counterparty.avatarUrl} alt="" />
              ) : (
                <span className="net-ava net-ava-ph">{(c.counterparty.name || "?").slice(0, 1)}</span>
              )}
              <span className="net-conn-txt">
                <span className="net-conn-name">{c.counterparty.name}</span>
                <span className="net-conn-slug">@{c.counterparty.slug}</span>
              </span>
            </div>
          ))}
          {inbox.length === 0 && conns.length === 0 && (
            <div className="cr-hint">No connections yet. Find a producer by their handle.</div>
          )}
        </div>
      )}

      {tab === "find" && (
        <div className="net-find">
          <div className="net-invite-row">
            <input
              className="net-slug"
              placeholder="Handle — e.g. kleveland"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void find();
              }}
            />
            <button className="cr-primary" disabled={busy || !slug.trim()} onClick={() => void find()}>
              Find
            </button>
          </div>
          {card && (
            <div className="net-card">
              {card.brand.avatar_url ? (
                <img className="net-ava" src={card.brand.avatar_url} alt="" />
              ) : (
                <span className="net-ava net-ava-ph">{(card.brand.name || "?").slice(0, 1)}</span>
              )}
              <span className="net-conn-txt">
                <span className="net-conn-name">{card.brand.name}</span>
                <span className="net-conn-slug">@{card.brand.slug}</span>
                {card.membership.headline && <span className="net-card-head">{card.membership.headline}</span>}
              </span>
              {card.relationship.self ? (
                <span className="net-state">You</span>
              ) : card.relationship.connected ? (
                <span className="net-state on">Connected</span>
              ) : card.relationship.invitation?.direction === "inbox" ? (
                <button className="cr-primary" disabled={busy} onClick={() => act(card.relationship.invitation!.id, "accept")}>
                  Accept
                </button>
              ) : card.relationship.invitation ? (
                <span className="net-state">Invited</span>
              ) : (
                <button className="cr-primary" disabled={busy} onClick={() => void inviteCard()}>
                  Invite
                </button>
              )}
            </div>
          )}
          {note && <div className="cr-hint">{note}</div>}
        </div>
      )}
    </aside>
  );
}

/** Open stages this brand may see — connections' rooms and public ones.
 * Entering KNOCKS: the API seats us in the host's waiting room with our
 * verified brand identity, and the guest page opens to wait for the admit. */
function LiveNowStrip() {
  const endpointId = useConnectedEndpoint();
  const [rooms, setRooms] = useState<NetworkLiveRoom[]>([]);
  const [entering, setEntering] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointId) return;
    let alive = true;
    const poll = () => {
      network
        .liveRooms(endpointId)
        .then((r) => {
          if (alive) setRooms(r.rooms ?? []);
        })
        .catch(() => {});
    };
    poll();
    const t = window.setInterval(poll, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [endpointId]);

  if (!endpointId || (rooms.length === 0 && !note)) return null;

  const enter = async (r: NetworkLiveRoom) => {
    setEntering(r.room_id);
    setNote(null);
    try {
      const res = await network.enterRoom(endpointId, r.room_id);
      await openUrl(res.join_url);
      setNote(`Knocked on ${r.brand.name}'s stage — your guest seat opened in the browser.`);
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setEntering(null);
    }
  };

  return (
    <section className="cr-section" id="sec-livenow">
      <div className="cr-label">LIVE ON THE NETWORK</div>
      <div className="net-live">
        {rooms.map((r) => (
          <div key={r.room_id} className="net-live-card">
            {r.brand.avatar_url ? (
              <img className="net-ava" src={r.brand.avatar_url} alt="" />
            ) : (
              <span className="net-ava net-ava-ph">{(r.brand.name || "?").slice(0, 1)}</span>
            )}
            <span className="net-conn-txt">
              <span className="net-conn-name">{r.brand.name}</span>
              <span className="net-conn-slug">{r.title ?? "Main room"}</span>
            </span>
            <span className={`net-live-badge${r.status === "live" ? " onair" : ""}`}>
              {r.status === "live" ? "LIVE" : "OPEN"}
            </span>
            <button
              className="cr-primary"
              disabled={entering === r.room_id}
              onClick={() => void enter(r)}
            >
              {entering === r.room_id ? "Knocking…" : "Enter"}
            </button>
          </div>
        ))}
      </div>
      {note && <div className="cr-hint">{note}</div>}
    </section>
  );
}

/** Who can find this stage open on the network. Cycles private → connections
 * → public; the first non-private setting lazily registers the room. Local
 * config mirrors the server so the chip renders offline. */
function RoomShareChip({ room, onChanged }: { room: LiveRoom; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [vis, setVis] = useState<"private" | "connections" | "public">(
    () => parseConfig(room.config).visibility ?? "private",
  );
  useEffect(() => {
    setVis(parseConfig(room.config).visibility ?? "private");
  }, [room.config]);

  const cycle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    const next = vis === "private" ? "connections" : vis === "connections" ? "public" : "private";
    const prev = vis;
    setBusy(true);
    setVis(next);
    // The SERVER is the exposure truth. Once the PATCH lands, the room IS
    // `next` on the network — so the chip must never roll back past that
    // point, or the UI would read Private while the stage is publicly open.
    let patched = false;
    try {
      const eps = await ipc.listEndpoints();
      const ep = eps.find((x) => x.kind === "connected") ?? eps[0];
      if (!ep) throw new Error("no endpoint");
      let sid = parseConfig(room.config).server_room_id;
      if (!sid) {
        const reg = await registerRoom(ep.id, room.name, room.id);
        sid = reg.room.id;
      }
      await roomSetVisibility(ep.id, sid, next);
      patched = true;
      // Read-modify-write against FRESH config, not the click-time snapshot —
      // a guest link or slot binding saved in the meantime must survive.
      const fresh = (await ipc.liveListRooms()).find((r) => r.id === room.id);
      const cfg = parseConfig(fresh?.config ?? room.config);
      await ipc.liveUpdateRoom(room.id, {
        config: serializeConfig({ ...cfg, server_room_id: sid, visibility: next }),
      });
      onChanged();
    } catch {
      // Before the PATCH: nothing changed anywhere — roll the chip back.
      // After it: the server moved; keep showing `next` (the local mirror
      // heals on the next successful write).
      if (!patched) setVis(prev);
    } finally {
      setBusy(false);
    }
  };

  const label = vis === "private" ? "Private" : vis === "connections" ? "Connections" : "Public";
  return (
    <span
      className={`cr-room-share ${vis}${busy ? " busy" : ""}`}
      title="Who can see this stage open on the network — click to change"
      onClick={cycle}
    >
      {label}
    </span>
  );
}


/** One rebindable shortcut row: click the chip, press the new key. */
function KeyRow({ b }: { b: KeyBinding }) {
  const [cur, setCur] = useState(() => getKey(b.id));
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setArming(false);
        return;
      }
      // Bare keys only — modifiers stay grammar, not bindings.
      if (["Shift", "Meta", "Alt", "Control"].includes(e.key)) return;
      setKey(b.id, e.key);
      setCur(e.key);
      setArming(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [arming, b.id]);
  return (
    <div className="ks-row">
      <span className="ks-label">{b.label}</span>
      {cur !== b.def && (
        <button
          className="ks-reset"
          title={`Reset to ${displayKey(b.def)}`}
          onClick={() => {
            resetKey(b.id);
            setCur(b.def);
          }}
        >
          reset
        </button>
      )}
      <button
        className={`ks-key${arming ? " arming" : ""}`}
        title="Click, then press the new key"
        onClick={() => setArming((a) => !a)}
      >
        {arming ? "Press a key…" : displayKey(cur)}
      </button>
    </div>
  );
}

/** Icons-only side rail on the control room home — floating inset glass,
 * macOS-styling: translucent card, heavy backdrop blur, hairline border.
 * Navigation is scroll-to-section; compose and settings ride the bottom. */
const railIc = {
  onair: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
      <path d="M7.5 16.5a6.4 6.4 0 0 1 0-9M16.5 7.5a6.4 6.4 0 0 1 0 9" />
      <path d="M4.8 19.2a10.2 10.2 0 0 1 0-14.4M19.2 4.8a10.2 10.2 0 0 1 0 14.4" />
    </svg>
  ),
  manager: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="9" width="17" height="10.5" rx="2" />
      <path d="m4 9 1.6-4.2 15 2.4-.6 1.8" />
      <path d="m8.2 5.6 2.4 3.1M13 6.4l2.4 3.1" />
    </svg>
  ),
  plus: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
};

function HomeRail({
  brandName,
  avatarUrl,
  surface,
  onSurface,
  onCompose,
  onSettings,
}: {
  brandName: string;
  /** The brand's avatar once the session serves it; initial until then. */
  avatarUrl?: string | null;
  surface: "rooms" | "manager";
  onSurface: (s: "rooms" | "manager") => void;
  onCompose: () => void;
  onSettings: () => void;
}) {
  return (
    <nav className="home-rail">
      {/* The profile IS the settings entry — workspace identity and its
        * controls live behind one button. */}
      <button className="home-rail-avatar" title={`${brandName} — settings`} onClick={onSettings}>
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{(brandName[0] ?? "?").toUpperCase()}</span>}
        <i className="home-rail-presence" />
      </button>
      <button className={surface === "rooms" ? "on" : ""} title="Rooms" onClick={() => onSurface("rooms")}>
        {railIc.onair}
      </button>
      <button className={surface === "manager" ? "on" : ""} title="Manager" onClick={() => onSurface("manager")}>
        {railIc.manager}
      </button>
      <div className="home-rail-spring" />
      <button title="New post" onClick={onCompose}>{railIc.plus}</button>
    </nav>
  );
}
