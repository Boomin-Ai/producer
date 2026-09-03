import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Channel, EndpointInfo, Job, LiveDestination, LiveRoom, LiveSnapshot } from "../lib/ipc";
import type { TargetResult } from "../lib/ipc";
import { WORKSPACE_EVENT, activeEndpointId, resolveActiveEndpoint, setActiveEndpointId } from "../lib/workspace";
import { copyText, ensureRoomJoinLink } from "../lib/roomLink";
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
  type NetworkDeal,
  type NetworkLiveRoom,
} from "../lib/ipc";
import { demoOn, setDemo } from "../lib/demo";
import { markHomePainted, markRoomClick } from "../lib/perf";
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
  onEndpointsChanged,
}: {
  endpoints: EndpointInfo[];
  onAddEndpoint: () => void;
  onRemoveEndpoint: (id: string) => void;
  /** A brand was bound as a new workspace from the popout — reload the endpoint list. */
  onEndpointsChanged?: () => void;
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
  // The active workspace (brand). Rooms, destinations and the network rail
  // all key on it; the profile popout switches it.
  const [activeId, setActiveId] = useState<string | null>(() => activeEndpointId());
  const [profileOpen, setProfileOpen] = useState(false);
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
      const ep = await resolveActiveEndpoint();
      if (ep?.id !== activeId) {
        // Workspace changed: nothing from the previous one may linger, not
        // even for a frame — it belongs to another brand.
        setRooms([]);
        setDestinations([]);
      }
      setActiveId(ep?.id ?? null);
      setRooms(await ipc.liveListRooms(ep?.id ?? undefined));
      setDestinations(await ipc.liveListDestinations(ep?.id ?? undefined));
      setSnapshot(await ipc.liveEngineStatus());
    } catch {
      /* engine-less build — live sections render empty */
    }
  }, []);
  useEffect(() => {
    const h = () => void loadLive();
    window.addEventListener(WORKSPACE_EVENT, h);
    return () => window.removeEventListener(WORKSPACE_EVENT, h);
  }, [loadLive]);

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
          brandName={(endpoints.find((e) => e.id === activeId) ?? endpoints.find((e) => e.kind === "connected") ?? endpoints[0])?.name ?? "Workspace"}
          surface={surface}
          onSurface={setSurface}
          onCompose={() => setView({ kind: "compose" })}
          onSettings={() => setProfileOpen((v) => !v)}
        />
      )}
      {view.kind === "home" && profileOpen && (
        <WorkspacePopout
          endpoints={endpoints}
          activeId={activeId}
          onSwitch={(id) => {
            setActiveEndpointId(id);
            setActiveId(id);
            setProfileOpen(false);
            onEndpointsChanged?.();
          }}
          onSettings={() => {
            setProfileOpen(false);
            setSettingsOpen(true);
          }}
          onClose={() => setProfileOpen(false)}
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
  useEffect(() => {
    // Post-commit ≈ first paint of the home. One-shot, module-level.
    markHomePainted();
  }, []);
  const liveRoom = streaming ? liveRoomId() : null;
  const [name, setName] = useState("");

  const upcoming = jobs.filter((j) => ["scheduled", "queued", "publishing"].includes(j.state));
  const recent = jobs.filter((j) => !["scheduled", "queued", "publishing"].includes(j.state)).slice(0, 3);

  async function createRoom() {
    const n = name.trim();
    if (!n) return;
    setName("");
    setNaming(false);
    const room = await ipc.liveCreateRoom(n, activeEndpointId() ?? undefined);
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
      <NetworkRail rooms={rooms} />
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
              <RoomLinkChip room={room} onChanged={onRoomsChanged} />
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
  const [endpointId, setEndpointId] = useState<string | null>(() => activeEndpointId());
  useEffect(() => {
    let alive = true;
    const load = () =>
      resolveActiveEndpoint()
        .then((ep) => {
          if (alive) setEndpointId(ep?.id ?? null);
        })
        .catch(() => {});
    load();
    window.addEventListener(WORKSPACE_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(WORKSPACE_EVENT, load);
    };
  }, []);
  return endpointId;
}

/** The network rail — a left column on the control room home.
 *
 * Discovery is EXACT-HANDLE ONLY, by design: Producer is never handed the
 * directory list, so the Find tab resolves a handle you were given and
 * nothing more. Connected shows the brands who already said yes, with the
 * inbox of open handshakes above them.
 *
 * Deals ride the connection rows: every open deal with that brand is a chip,
 * and "Book" proposes an APPEARANCE deal — we (the host) pay them to appear
 * on one of our rooms. Presence is delivery: admitting them from the Guests
 * panel settles the funded deal server-side; nothing here marks anything. */
function NetworkRail({ rooms }: { rooms: LiveRoom[] }) {
  const endpointId = useConnectedEndpoint();
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [inbox, setInbox] = useState<NetworkInvitation[]>([]);
  const [conns, setConns] = useState<NetworkConnectionRow[]>([]);
  const [deals, setDeals] = useState<NetworkDeal[]>([]);
  const [tab, setTab] = useState<"connected" | "find">("connected");
  const [slug, setSlug] = useState("");
  const [card, setCard] = useState<NetworkBrandCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [booking, setBooking] = useState<string | null>(null);
  const [bookRoom, setBookRoom] = useState("");
  const [bookAmt, setBookAmt] = useState("");
  const [bookMin, setBookMin] = useState("");
  /** The deal whose sheet (terms + answer) is open. */
  const [dealOpen, setDealOpen] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    const [st, inv, cn, dl] = await Promise.all([
      network.status(id).catch(() => null),
      network.invitations(id, "inbox").catch(() => null),
      networkConnections(id).catch(() => null),
      network.deals(id).catch(() => null),
    ]);
    if (st) setStatus(st);
    setInbox((inv?.invitations ?? []).filter((i) => i.status === "invited"));
    setConns(cn?.connections ?? []);
    setDeals(dl?.deals ?? []);
  }, []);

  const dealsFor = (connectionId: string) =>
    deals.filter((d) => d.connection_id === connectionId && !["released", "declined", "cancelled", "expired"].includes(d.status));

  const bookCents = Math.round((Number(bookAmt) || 0) * 100);

  /** The deal's own page — boomin.ai/<our slug>/deals/<id>. That is the link
   * that goes out: the guest signs in as their brand, reads the terms, and
   * joins the room THROUGH the deal, so admitting them settles it. */
  const sendLink = async (d: NetworkDeal, name: string) => {
    setBusy(true);
    setNote(null);
    try {
      const ep = await resolveActiveEndpoint();
      const slug = ep?.brand_slug;
      if (!slug) throw new Error("This workspace has no brand handle.");
      const url = `https://boomin.ai/${slug}/deals/${d.id}`;
      setNote((await copyText(url)) ? `${name}'s deal link copied — send it to them. They sign in, accept, and join the room from it.` : url);
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const dealAct = async (id: string, action: "accept" | "decline" | "cancel") => {
    if (!endpointId) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await network.dealAction(endpointId, id, action);
      setNote(
        r.deal.status === "accepted"
          ? "Accepted. They fund it in Boomin; the escrow shows here once it lands."
          : r.deal.status === "declined"
            ? "Declined."
            : r.deal.status === "cancelled"
              ? action === "cancel" && !r.deal.funded_at ? "Withdrawn." : "Cancelled."
              : `Deal ${r.deal.status}.`,
      );
      void load(endpointId);
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const book = async (c: NetworkConnectionRow) => {
    const room = rooms.find((r) => r.id === bookRoom);
    if (!endpointId || !room || bookCents < 500) return;
    setBusy(true);
    setNote(null);
    try {
      // The deal names a SERVER room; register the local one lazily (idempotent
      // by external_ref) and mirror the id the same way RoomShareChip does.
      let sid = parseConfig(room.config).server_room_id;
      if (!sid) {
        const reg = await registerRoom(endpointId, room.name, room.id);
        sid = reg.room.id;
        const fresh = (await ipc.liveListRooms()).find((r) => r.id === room.id);
        const cfg = parseConfig(fresh?.config ?? room.config);
        await ipc.liveUpdateRoom(room.id, { config: serializeConfig({ ...cfg, server_room_id: sid }) });
      }
      await network.proposeDeal(endpointId, {
        connectionId: c.connection.id,
        beneficiaryBrandId: c.counterparty.id,
        roomId: sid,
        title: `Appearance on ${room.name}`,
        amountCents: bookCents,
        minStageMinutes: Number(bookMin) >= 1 ? Math.min(720, Math.round(Number(bookMin))) : null,
      });
      setNote(`Proposal sent to ${c.counterparty.name}. You'll get an email when they answer.`);
      setBooking(null);
      setBookAmt("");
      setBookMin("");
      void load(endpointId);
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // SWEEP first: this component outlives a workspace switch, and every
    // piece of it — inbox, connections, deals, the Find card, the note, an
    // open booking — belongs to the brand that just left.
    setStatus(null);
    setInbox([]);
    setConns([]);
    setDeals([]);
    setCard(null);
    setNote(null);
    setSlug("");
    setBooking(null);
    setDealOpen(null);
    setTab("connected");
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
        <span className="net-rail-title">Network</span>
        <span className="net-count" title={`${liveNow} of ${members} network members are live right now`}>
          <span className={`net-dot${liveNow > 0 ? " on" : ""}`} />
          {liveNow} live
          <span className="net-of">· {members}</span>
        </span>
      </div>

      <div className="net-tabs" role="tablist">
        <button role="tab" className={tab === "connected" ? "on" : ""} onClick={() => setTab("connected")}>
          Connected
          {conns.length > 0 && <span className="net-tab-n">{conns.length}</span>}
          {inbox.length > 0 && <span className="net-badge">{inbox.length}</span>}
        </button>
        <button role="tab" className={tab === "find" ? "on" : ""} onClick={() => setTab("find")}>
          Find
        </button>
      </div>

      {tab === "connected" && (
        <div className="net-list">
          {inbox.length > 0 && <div className="net-section">Requests</div>}
          {inbox.map((i) => {
            const name = i.brand?.name ?? i.brand?.slug ?? "Someone";
            return (
              <div key={i.id} className="net-invite">
                <div className="net-invite-row">
                  <span className="net-ava net-ava-ph">{(name || "?").slice(0, 1)}</span>
                  <span className="net-conn-txt">
                    <span className="net-conn-name">{name}</span>
                    <span className="net-conn-slug">wants to connect{i.brand?.slug ? ` · @${i.brand.slug}` : ""}</span>
                  </span>
                </div>
                {i.message && <div className="net-invite-msg">“{i.message}”</div>}
                <div className="net-invite-acts">
                  <button className="net-accept" onClick={() => act(i.id, "accept")}>
                    Accept
                  </button>
                  <button className="net-decline" onClick={() => act(i.id, "decline")}>
                    Decline
                  </button>
                </div>
              </div>
            );
          })}
          {inbox.length > 0 && conns.length > 0 && <div className="net-section">Connected</div>}
          {conns.map((c) => {
            const ds = dealsFor(c.connection.id);
            const open = booking === c.connection.id;
            return (
              <div key={c.connection.id} className={`net-conn${open ? " booking" : ""}`}>
                {c.counterparty.avatarUrl ? (
                  <img className="net-ava" src={c.counterparty.avatarUrl} alt="" />
                ) : (
                  <span className="net-ava net-ava-ph">{(c.counterparty.name || "?").slice(0, 1)}</span>
                )}
                <span className="net-conn-txt">
                  <span className="net-conn-name">{c.counterparty.name}</span>
                  <span className="net-conn-slug">@{c.counterparty.slug}</span>
                </span>
                {rooms.length > 0 && (
                  <button
                    className="net-book"
                    title="Book an appearance — you pay them to appear on one of your rooms"
                    onClick={() => {
                      setBooking(open ? null : c.connection.id);
                      setBookRoom(rooms[0]?.id ?? "");
                      setNote(null);
                    }}
                  >
                    {open ? "Close" : "Book"}
                  </button>
                )}
                {ds.length > 0 && (
                  <div className="net-deals">
                    {ds.map((d) => {
                      const amt = `$${(d.amount_cents / 100).toFixed(d.amount_cents % 100 ? 2 : 0)}`;
                      const earn = d.role === "beneficiary";
                      const detail =
                        d.min_stage_minutes != null
                          ? `${Math.floor((d.stage_seconds ?? 0) / 60)} of ${d.min_stage_minutes} min on stage`
                          : d.appearance
                            ? "admitted — delivered"
                            : d.room_title
                              ? `appearance on ${d.room_title}`
                              : null;
                      const line =
                        d.status === "proposed"
                          ? earn ? `${amt} offered to you` : `${amt} proposed`
                          : d.status === "accepted"
                            ? earn ? `${amt} accepted — awaiting their funding` : `${amt} accepted — fund it in Boomin`
                            : d.status === "funded"
                              ? earn ? `${amt} in escrow for you` : `${amt} in escrow`
                              : d.status === "delivered"
                                ? earn ? `${amt} delivered — awaiting release` : `${amt} delivered — release in Boomin`
                                : `${amt} · ${d.status}`;
                      return (
                        <button
                          key={d.id}
                          className={`net-deal ${d.status}`}
                          title="Terms and details"
                          onClick={() => setDealOpen(d.id)}
                        >
                          <span className="net-deal-line">
                            <i className="net-deal-dot" />
                            {line}
                            <span className="net-deal-more">{earn && d.status === "proposed" ? "Review ›" : "Details ›"}</span>
                          </span>
                          {detail && <span className="net-deal-sub">{detail}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {open && (
                  <div className="net-book-form">
                    <label className="net-field">
                      <span>Room</span>
                      <select value={bookRoom} onChange={(e) => setBookRoom(e.target.value)}>
                        {rooms.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="net-field-row">
                      <label className="net-field">
                        <span>Pay (USD)</span>
                        <input
                          className="net-slug"
                          inputMode="decimal"
                          placeholder="50"
                          value={bookAmt}
                          onChange={(e) => setBookAmt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void book(c);
                          }}
                        />
                      </label>
                      <label className="net-field">
                        <span>Min on stage</span>
                        <input
                          className="net-slug"
                          inputMode="numeric"
                          placeholder="none"
                          title="Minutes on your stage before it counts as delivered (blank = presence alone delivers)"
                          value={bookMin}
                          onChange={(e) => setBookMin(e.target.value)}
                        />
                      </label>
                    </div>
                    <button className="net-accept" disabled={busy || bookCents < 500} onClick={() => void book(c)}>
                      {bookCents >= 500 ? `Propose $${(bookCents / 100).toFixed(bookCents % 100 ? 2 : 0)}` : "Propose"}
                    </button>
                    <div className="cr-hint">
                      {Number(bookMin) >= 1
                        ? `Delivered the moment @${c.counterparty.slug} has been on your stage ${Math.min(720, Math.round(Number(bookMin)))} min. Cutting them early still counts. Minimum $5.`
                        : `Presence is delivery: admitting @${c.counterparty.slug} to that room settles it. Add minutes for a stage minimum. Minimum $5.`}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {note && tab === "connected" && <div className="cr-hint">{note}</div>}
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
      {dealOpen && (() => {
        const d = deals.find((x) => x.id === dealOpen);
        if (!d) return null;
        const other = conns.find((c) => c.connection.id === d.connection_id)?.counterparty;
        return (
          <DealSheet
            deal={d}
            otherName={other?.name ?? "the other brand"}
            busy={busy}
            note={note}
            onAct={(a) => void dealAct(d.id, a).then(() => setDealOpen(null))}
            onSendLink={() => void sendLink(d, other?.name ?? "Guest")}
            onClose={() => setDealOpen(null)}
          />
        );
      })()}
    </aside>
  );
}

/** A room's guest link, one click from the card. Mints it on first use. */
function RoomLinkChip({ room, onChanged }: { room: LiveRoom; onChanged: () => void }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "err">("idle");
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "busy") return;
    setState("busy");
    try {
      const url = await ensureRoomJoinLink(room);
      setState((await copyText(url)) ? "copied" : "err");
      onChanged();
    } catch {
      setState("err");
    }
    window.setTimeout(() => setState("idle"), 1800);
  };
  return (
    <span className={`cr-room-link ${state}`} title="Copy this room's guest link" onClick={go}>
      {state === "copied" ? "Copied" : state === "busy" ? "…" : state === "err" ? "No link" : "Link"}
    </span>
  );
}

const DEAL_TERMS_URL = "https://boomin.ai/terms/deals";

/** The deal, in full, and the answer — a protective layer: nobody accepts
 * money terms from a chip. What is shown here is what the terms page says. */
function DealSheet({
  deal: d,
  otherName,
  busy,
  note,
  onAct,
  onSendLink,
  onClose,
}: {
  deal: NetworkDeal;
  otherName: string;
  busy: boolean;
  note?: string | null;
  onAct: (a: "accept" | "decline" | "cancel") => void;
  onSendLink?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const earn = d.role === "beneficiary";
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [ownSlug, setOwnSlug] = useState<string | null>(null);
  useEffect(() => {
    resolveActiveEndpoint().then((ep) => setOwnSlug(ep?.brand_slug ?? null)).catch(() => {});
  }, []);
  // The deal's own page lives on the CLIENT brand's lobby.
  const clientSlug = d.client_brand_slug ?? (earn ? null : ownSlug);
  const pageUrl = clientSlug ? `https://boomin.ai/${clientSlug}/deals/${d.id}` : null;
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const feeBps = d.platform_fee_bps ?? 1000;
  const feeCents = d.platform_fee_cents ?? Math.floor((d.amount_cents * feeBps) / 10_000);
  const net = d.net_to_beneficiary_cents ?? d.amount_cents - feeCents;
  const review = d.review_days ?? 7;
  const expires = d.propose_expires_at ? new Date(d.propose_expires_at).toLocaleDateString() : null;
  const delivery =
    d.min_stage_minutes != null
      ? `By the clock: delivered once ${earn ? "you have" : `${otherName} has`} been on ${earn ? `${otherName}'s` : "your"} stage ${d.min_stage_minutes} min, as published by the host's Producer. If the host removes ${earn ? "you" : "them"} early after ${earn ? "you were" : "they were"} on stage, it is delivered anyway.`
      : d.room_id
        ? `By presence: delivered the moment the host admits ${earn ? "you" : otherName} into "${d.room_title ?? "the room"}". The admission is the evidence.`
        : `By hand: ${earn ? "you mark" : `${otherName} marks`} it delivered when the work is done.`;
  // Portaled: the sheet is fixed-position and the rail it opens from is a
  // scrolling fixed column — rendered inside it, the rail clips the sheet's
  // left edge and scrolls it. The body is the only honest parent.
  return createPortal(
    <>
      <div className="ws-pop-backdrop" onClick={onClose} />
      <div className="deal-sheet" role="dialog">
        <div className="deal-sheet-head">
          <span className="deal-sheet-title">{d.title}</span>
          <button className="cr-back" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="deal-sheet-sub">
          {earn ? `${otherName} pays you` : `You pay ${otherName}`} · <span className="deal-status">{d.status}</span>
        </div>

        <div className="deal-money">
          <div><span>Amount</span><b>{usd(d.amount_cents)}</b></div>
          <div><span>Boomin fee ({(feeBps / 100).toFixed(1)}%{d.fee_locked ? ", locked" : ""})</span><b>−{usd(feeCents)}</b></div>
          <div className="deal-net"><span>{earn ? "You receive" : `${otherName} receives`}</span><b>{usd(net)}</b></div>
        </div>

        <div className="deal-terms">
          <div className="deal-term"><span>Deliverable</span><p>{d.deliverable || (d.room_id ? `Appearance on "${d.room_title ?? "the room"}"` : "As titled")}</p></div>
          <div className="deal-term"><span>Delivered</span><p>{delivery}</p></div>
          <div className="deal-term"><span>Escrow</span><p>{earn ? `${otherName} funds` : "You fund"} the full {usd(d.amount_cents)} after acceptance (14-day window). Held by Boomin; nothing is charged at acceptance.</p></div>
          <div className="deal-term"><span>Release</span><p>{earn ? otherName : "You"} can release right after delivery. Silence auto-releases after {review} day{review === 1 ? "" : "s"}. A dispute in that window freezes the escrow until resolved.</p></div>
          <div className="deal-term"><span>Cancel</span><p>Either side before funding. After funding only {earn ? "you" : otherName} can cancel, which refunds in full. Delivered deals are released or disputed, never cancelled.</p></div>
          {expires && <div className="deal-term"><span>Expires</span><p>Unanswered, this proposal expires {expires}.</p></div>}
        </div>

        {!earn && (d.status === "proposed" || d.status === "accepted" || d.status === "funded") && (
          <div className="deal-link">
            <div className="deal-term">
              <span>Their link</span>
              <p>
                One link does it all: {otherName} signs in as their brand, reads these terms,
                {d.status === "proposed" ? " accepts," : ""} and joins {d.room_id ? `"${d.room_title ?? "the room"}"` : "the show"} from it —
                so when you admit them the deal knows it's them
                {d.min_stage_minutes != null ? ` and the ${d.min_stage_minutes}-minute clock runs on stage.` : "."}
                {d.status === "accepted" ? " Fund it in Boomin before the show so delivery can settle." : ""}
              </p>
            </div>
            <button className="net-accept" disabled={busy} onClick={onSendLink}>
              Send their link
            </button>
            {note && <div className="cr-hint">{note}</div>}
          </div>
        )}

        <div className="deal-sheet-acts">
          {earn && d.status === "proposed" ? (
            <>
              <button className="net-accept" disabled={busy} onClick={() => onAct("accept")}>Accept {usd(d.amount_cents)}</button>
              <button className="net-decline" disabled={busy} onClick={() => onAct("decline")}>Decline</button>
            </>
          ) : !earn && d.status === "proposed" ? (
            confirmWithdraw ? (
              <>
                <button className="net-decline danger" disabled={busy} onClick={() => onAct("cancel")}>Yes, withdraw it</button>
                <button className="net-decline" onClick={() => setConfirmWithdraw(false)}>Keep it</button>
              </>
            ) : (
              <>
                <button className="net-decline" onClick={() => setConfirmWithdraw(true)}>Withdraw proposal</button>
                <button className="net-decline" onClick={onClose}>Close</button>
              </>
            )
          ) : !earn && d.status === "accepted" ? (
            <>
              <button className="net-decline" disabled={busy} onClick={() => onAct("cancel")}>Cancel deal</button>
              <button className="net-decline" onClick={onClose}>Close</button>
            </>
          ) : (
            <button className="net-decline" onClick={onClose}>Close</button>
          )}
        </div>
        <div className="deal-foot">
          {pageUrl && (
            <a className="deal-foot-link" onClick={() => openUrl(pageUrl).catch(() => {})}>
              Open this deal on boomin.ai ›
            </a>
          )}
          <div className="deal-agree">
            {earn
              ? "Accepting means you agree to deliver as written, to the delivery rule above, and to the fee shown, under Boomin's "
              : "Funding means you agree the escrow is released by delivery as written, by your release, or by the review window, under Boomin's "}
            <a onClick={() => openUrl(DEAL_TERMS_URL).catch(() => {})}>network deal terms</a>.
          </div>
        </div>
      </div>
    </>,
    document.body,
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
    setRooms([]);
    setNote(null);
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

/** The profile popout: who you are acting as, and the brand switch.
 *
 * Mirrors the web's BrandSwitcherDropdown: every brand of the account (live
 * from the API), the current one marked, unbound ones bound on first pick
 * (same token, new endpoint row). Settings lives behind it. */
function WorkspacePopout({
  endpoints,
  activeId,
  onSwitch,
  onSettings,
  onClose,
}: {
  endpoints: EndpointInfo[];
  activeId: string | null;
  onSwitch: (endpointId: string) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const active = endpoints.find((e) => e.id === activeId) ?? endpoints.find((e) => e.kind === "connected") ?? endpoints[0];
  const [brands, setBrands] = useState<{ slug: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const ep = endpoints.find((e) => e.kind === "connected" && e.id === activeId) ?? endpoints.find((e) => e.kind === "connected");
    if (!ep) {
      setBrands([]);
      return;
    }
    ipc
      .boominListBrands(ep.id)
      .then((r) => setBrands(r.brands ?? []))
      .catch(() => setBrands(endpoints.filter((e) => e.brand_slug).map((e) => ({ slug: e.brand_slug!, name: e.name }))));
  }, [endpoints, activeId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = async (slug: string) => {
    const bound = endpoints.find((e) => e.brand_slug === slug);
    if (bound) {
      onSwitch(bound.id);
      return;
    }
    const via = endpoints.find((e) => e.kind === "connected" && e.id === activeId) ?? endpoints.find((e) => e.kind === "connected");
    if (!via) return;
    setBusy(slug);
    setNote(null);
    try {
      const r = await ipc.boominAddBrand(via.id, slug);
      onSwitch(r.id);
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  };

  const rows = brands ?? [];
  const independents = endpoints.filter((e) => e.kind !== "connected");
  return (
    <>
      <div className="ws-pop-backdrop" onClick={onClose} />
      <div className="ws-pop" role="menu">
        <div className="ws-pop-head">
          <span className="ws-ava">{(active?.name?.[0] ?? "?").toUpperCase()}</span>
          <span className="ws-pop-txt">
            <span className="ws-pop-name">{active?.name ?? "Workspace"}</span>
            {active?.brand_slug && <span className="ws-pop-slug">@{active.brand_slug}</span>}
          </span>
        </div>
        <div className="ws-pop-label">BRAND WORKSPACES</div>
        <div className="ws-pop-list">
          {brands === null && <div className="cr-hint">Loading…</div>}
          {rows.map((b) => {
            const bound = endpoints.find((e) => e.brand_slug === b.slug);
            const isCurrent = !!bound && bound.id === active?.id;
            return (
              <button
                key={b.slug}
                className={`ws-row${isCurrent ? " on" : ""}`}
                disabled={busy !== null}
                onClick={() => void pick(b.slug)}
              >
                <span className="ws-ava sm">{(b.name?.[0] ?? "B").toUpperCase()}</span>
                <span className="ws-pop-txt">
                  <span className="ws-pop-name">{b.name}</span>
                  <span className="ws-pop-slug">@{b.slug}{bound ? "" : " · not set up yet"}</span>
                </span>
                {isCurrent ? <i className="ws-dot" /> : busy === b.slug ? <span className="ws-pop-slug">…</span> : null}
              </button>
            );
          })}
          {independents.map((e) => (
            <button key={e.id} className={`ws-row${e.id === active?.id ? " on" : ""}`} onClick={() => onSwitch(e.id)}>
              <span className="ws-ava sm">{(e.name[0] ?? "S").toUpperCase()}</span>
              <span className="ws-pop-txt">
                <span className="ws-pop-name">{e.name}</span>
                <span className="ws-pop-slug">self-hosted</span>
              </span>
              {e.id === active?.id && <i className="ws-dot" />}
            </button>
          ))}
          {brands !== null && rows.length === 0 && independents.length === 0 && (
            <div className="cr-hint">No workspaces yet. Add one in Settings.</div>
          )}
        </div>
        {note && <div className="cr-hint">{note}</div>}
        <div className="ws-pop-foot">
          <button className="ws-row" onClick={onSettings}>
            <span className="ws-pop-name">Settings</span>
          </button>
        </div>
      </div>
    </>
  );
}

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
