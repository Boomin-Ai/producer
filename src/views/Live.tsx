import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ipc,
  listenLiveEvents,
  type LiveDestination,
  type LiveDestStatus,
  type LivePermissions,
  type LivePreset,
  type LiveSnapshot,
  type LiveSources,
  chat as chatIpc,
  listenChat,
  devices as deviceIpc,
  extraSources,
  guests as guestsIpc,
  registerRoom,
  setSourceAudio,
  setSyncOffset,
  type RoomGuest,
  type LiveItem,
  stinger as stingerIpc,
  recording as recIpc,
  setOpacity,
  vcam as vcamIpc,
  type VcamStatus,
  type ExtraSpec,
  type LiveWindow,
  type LiveTransformPatch,
  type ChatConnection,
  type DeviceOption,
} from "../lib/ipc";
import {
  FILTER_CATALOG,
  filters as filtersIpc,
  specOf,
  type FilterOp,
  type FilterState,
} from "../lib/filters";
import { DEMO_CHAT, DEMO_VIDEO_URL, demoOn, type DemoPlatform } from "../lib/demo";
import { StageEditor } from "./StageEditor";
import {
  PANEL_META,
  PANEL_ORDER,
  PRESETS as LAYOUT_PRESETS,
  dockOf,
  SIDE_MAX,
  SIDE_MIN,
  type DockSizes,
  movePanel,
  movePanelTo,
  type Dock,
  type Layout,
  type PanelId,
} from "../lib/layout";
import {
  DEFAULT_SCENES,
  markLiveRoom,
  parseConfig,
  serializeConfig,
  type RoomConfig,
  type RoomScene,
  type SceneItemLook,
  type SceneTransition,
  type TransitionKind,
  type RoomExtra,
} from "../lib/room";

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
/** One rendered chat line, whatever platform it came from. */
interface ChatLine {
  platform: string;
  user: string;
  text: string;
  color?: string | null;
  emotes?: Record<string, string>;
}

/** Which channels this machine reads chat from. Not a credential — a name. */
export interface ChatNames {
  twitch: string;
  kick: string;
  youtube: string;
}

const CHAT_NAMES_KEY = "producer.chat.names";
const KICK_ROOM_KEY = "producer.chat.kick.chatroom";

function loadChatNames(): ChatNames {
  try {
    const raw = localStorage.getItem(CHAT_NAMES_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ChatNames>;
      return { twitch: p.twitch ?? "", kick: p.kick ?? "", youtube: p.youtube ?? "" };
    }
  } catch {
    /* chat identity is a convenience, never a blocker */
  }
  return { twitch: "", kick: "", youtube: "" };
}

function saveChatNames(n: ChatNames) {
  try {
    localStorage.setItem(CHAT_NAMES_KEY, JSON.stringify(n));
  } catch {
    /* ignore */
  }
}

/** Kick's slug→chatroom lookup is the one Cloudflare-guarded call in the
 * chat path, and the answer never changes — so it is cached per slug and
 * the lookup effectively runs once per channel, ever. */
function loadKickChatroom(slug: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(KICK_ROOM_KEY) ?? "{}") as Record<string, string>;
    return map[slug.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

function saveKickChatroom(slug: string, id: string) {
  try {
    const map = JSON.parse(localStorage.getItem(KICK_ROOM_KEY) ?? "{}") as Record<string, string>;
    map[slug.toLowerCase()] = id;
    localStorage.setItem(KICK_ROOM_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Chat channels. These are public channel names, not credentials — reading
 * needs no account on either platform. Sending does, and arrives with
 * Connect; this panel says so rather than pretending. */
function ChatSetup({
  names,
  conns,
  error,
  onApply,
}: {
  names: ChatNames;
  conns: ChatConnection[];
  error: string | null;
  onApply: (n: ChatNames) => void;
}) {
  const [draft, setDraft] = useState<ChatNames>(names);
  const state = (p: string) => conns.find((c) => c.platform === p);
  const LABEL: Record<keyof ChatNames, string> = {
    twitch: "Twitch",
    kick: "Kick",
    youtube: "YouTube",
  };
  const HINT: Record<keyof ChatNames, string> = {
    twitch: "channel name",
    kick: "channel name",
    youtube: "@handle or channel id",
  };
  return (
    <form
      className="rm-chatsetup"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({
          twitch: draft.twitch.trim(),
          kick: draft.kick.trim(),
          youtube: draft.youtube.trim(),
        });
      }}
    >
      {(["twitch", "kick", "youtube"] as const).map((p) => {
        const st = state(p);
        return (
          <label key={p} className="rm-chatsetup-row">
            <span className="rm-chatsetup-label">
              <span className="rm-row-dot" style={{ background: PLATFORM_TINT[p] }} />
              {LABEL[p]}
              {st?.connected && <span className="rm-chatsetup-on">reading</span>}
            </span>
            <input
              className="rm-chatsetup-input"
              placeholder={HINT[p]}
              value={draft[p]}
              onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
        );
      })}
      {error && <div className="rm-chatsetup-err">{error}</div>}
      <div className="rm-chatsetup-foot">
        <span className="rm-chatsetup-note">Reading is public. Talking back arrives with Connect.</span>
        <button className="rm-editbar-done" type="submit">
          Connect
        </button>
      </div>
    </form>
  );
}

/** Vertical window list — the sidebar-docked counterpart of the strip. */
function WindowPickerList({
  itemId,
  onPick,
  onPicked,
}: {
  itemId: string;
  onPick: (itemId: string, windowId: number, label: string) => Promise<void>;
  onPicked: () => void;
}) {
  const [windows, setWindows] = useState<LiveWindow[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    ipc
      .liveListWindows()
      .then((w) => alive && setWindows(w))
      .catch(() => alive && setWindows([]));
    return () => {
      alive = false;
    };
  }, []);
  if (windows === null) return <div className="rm-devices-empty">Looking…</div>;
  if (windows.length === 0)
    return <div className="rm-devices-empty">No windows — needs the screen-recording grant.</div>;
  return (
    <>
      {windows.map((w) => (
        <button
          key={w.id}
          className="rm-device"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onPick(itemId, w.id, w.owner);
              onPicked();
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="rm-device-name">
            {w.owner}
            {w.title ? ` — ${w.title}` : ""}
          </span>
        </button>
      ))}
    </>
  );
}

/** Window chips for a window source's settings strip: pick a different
 * window without losing the item's place, size or layer — the item is
 * replaced in situ under the same id. */
function WindowStripList({
  itemId,
  onPick,
  onPicked,
}: {
  itemId: string;
  onPick: (itemId: string, windowId: number, label: string) => Promise<void>;
  onPicked: () => void;
}) {
  const [windows, setWindows] = useState<LiveWindow[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    ipc
      .liveListWindows()
      .then((w) => alive && setWindows(w))
      .catch(() => alive && setWindows([]));
    return () => {
      alive = false;
    };
  }, []);
  if (windows === null) return <span className="rm-srcstrip-note">Looking…</span>;
  if (windows.length === 0)
    return <span className="rm-srcstrip-note">No windows — needs the screen-recording grant.</span>;
  return (
    <>
      {windows.map((w) => (
        <button
          key={w.id}
          className="rm-srcstrip-chip"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onPick(itemId, w.id, w.owner);
              onPicked();
            } finally {
              setBusy(false);
            }
          }}
        >
          {w.owner}
          {w.title ? ` — ${w.title}` : ""}
        </button>
      ))}
    </>
  );
}

/** A scene's settings, in the same horizontal strip sources use. Scope is
 * explicit: editing a scene sets that scene's override; the room default is
 * reachable from the panel header. */
function SceneSettingsStrip({
  scene,
  effective,
  onSet,
  onUpdate,
  onClose,
}: {
  scene: RoomScene | null;
  effective: SceneTransition;
  onSet: (t: SceneTransition | undefined) => void;
  onUpdate: () => void;
  onClose: () => void;
}) {
  const KINDS: { k: TransitionKind; label: string }[] = [
    { k: "cut", label: "None (cut)" },
    { k: "move", label: "Move" },
    { k: "fade", label: "Fade" },
    { k: "stinger", label: "Stinger" },
  ];
  const DURS = effective.kind === "stinger" ? [800, 1200, 1600, 2400] : [200, 320, 500, 800];
  const overridden = !!scene?.transition;
  return (
    <div className="rm-srcstrip">
      <span className="rm-srcstrip-icon">{ic.screen}</span>
      <span className="rm-srcstrip-name">{scene ? scene.name : "All scenes"}</span>
      <span className="rm-srcstrip-sep" />
      <div className="rm-srcstrip-list">
        {KINDS.map((t) => (
          <button
            key={t.k}
            className={`rm-srcstrip-chip${effective.kind === t.k ? " on" : ""}`}
            onClick={() => {
              if (t.k === "stinger") {
                extraSources.pickFile("media").then((path) => {
                  if (!path) return;
                  // Open it now, not during the cut.
                  stingerIpc.prepare(path).catch(() => {});
                  onSet({ ...effective, kind: "stinger", stinger: path });
                });
              } else {
                onSet({ ...effective, kind: t.k, stinger: undefined });
              }
            }}
          >
            {effective.kind === t.k && <span className="rm-srcstrip-dot" />}
            {t.label}
          </button>
        ))}
        {effective.kind !== "cut" && (
          <>
            <span className="rm-srcstrip-sep" />
            {effective.kind === "stinger" && (
              <span className="rm-srcstrip-note">clip length</span>
            )}
            {DURS.map((ms) => (
              <button
                key={ms}
                className={`rm-srcstrip-chip${(effective.ms ?? (effective.kind === "stinger" ? 1200 : 320)) === ms ? " on" : ""}`}
                onClick={() => onSet({ ...effective, ms })}
              >
                {ms}ms
              </button>
            ))}
          </>
        )}
        {effective.kind === "stinger" && effective.stinger && (
          <>
            <span className="rm-srcstrip-sep" />
            <span className="rm-srcstrip-note">{effective.stinger.split("/").pop()}</span>
          </>
        )}
        {scene && overridden && (
          <>
            <span className="rm-srcstrip-sep" />
            <button className="rm-srcstrip-chip" onClick={() => onSet(undefined)}>
              Use room default
            </button>
          </>
        )}
        {scene && (
          <>
            <span className="rm-srcstrip-sep" />
            <button
              className="rm-srcstrip-chip"
              title="Save what's on the stage right now as this scene"
              onClick={onUpdate}
            >
              Save current look
            </button>
          </>
        )}
      </div>
      <button className="rm-srcstrip-x" title="Close settings" onClick={onClose}>
        {ic.x}
      </button>
    </div>
  );
}

/** Experimental (founder-requested): a source's settings live in a
 * HORIZONTAL strip above the docked panels; each chip opens its own
 * vertical menu. One strip at a time — it's the selected source's control
 * surface, not a tree. */
function SourceSettingsStrip({
  rowKey,
  items,
  sources,
  onClose,
  openOverlay,
  onPickWindow,
}: {
  rowKey: string;
  items: LiveItem[];
  sources: LiveSources;
  onClose: () => void;
  openOverlay: () => void;
  onPickWindow: (itemId: string, windowId: number, label: string) => Promise<void>;
}) {
  const meta: Record<string, { name: string; icon: ReactNode }> = {
    screen: { name: "Screen", icon: ic.screen },
    camera: { name: "Camera", icon: ic.cam },
    mic: { name: "Microphone", icon: ic.mic },
    alerts: { name: "Overlay", icon: ic.link },
  };
  const windowItemId = rowKey.startsWith("window:") ? rowKey.slice(7) : null;
  const m = windowItemId
    ? { name: "Window", icon: ic.screen }
    : (meta[rowKey] ?? { name: rowKey, icon: ic.link });
  const deviceKind = rowKey === "alerts" || windowItemId ? null : rowKey; // camera | mic | screen
  const [list, setList] = useState<DeviceOption[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!deviceKind) return;
    let alive = true;
    let wasDenied = false;
    setList(null);
    const fetchList = () =>
      deviceIpc
        .list(deviceKind)
        .then((d) => alive && setList(Array.isArray(d) ? d : []))
        .catch(() => alive && setList([]));
    const check = () =>
      ipc
        .livePermissions()
        .then((p) => {
          if (!alive) return;
          const st = deviceKind === "camera" ? p.camera : deviceKind === "mic" ? p.mic : p.screen;
          const nowDenied = st !== "granted";
          // The instant a grant lands, the device list is real — refetch it
          // so "Allow access" turns into hardware without reopening.
          if (wasDenied && !nowDenied) fetchList();
          wasDenied = nowDenied;
          setDenied(nowDenied);
        })
        .catch(() => {});
    fetchList();
    check();
    const t = setInterval(check, 800);
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, [deviceKind]);

  // Only sources that actually carry audio can drift against their video.
  const syncItem = items.find((i) => i.id === (rowKey === "alerts" ? "overlay" : rowKey) && i.has_audio);
  const active =
    deviceKind === "camera"
      ? sources.camera_device
      : deviceKind === "mic"
        ? sources.mic_device
        : sources.screen_device;

  return (
    <div className="rm-srcstrip">
      <span className="rm-srcstrip-icon">{m.icon}</span>
      <span className="rm-srcstrip-name">{m.name}</span>
      <span className="rm-srcstrip-sep" />
      <div className="rm-srcstrip-list">
        {windowItemId && (
          <WindowStripList itemId={windowItemId} onPick={onPickWindow} onPicked={onClose} />
        )}
        {rowKey === "alerts" && (
          <button className="rm-srcstrip-chip" onClick={openOverlay}>
            Configure
            {ic.chev}
          </button>
        )}
        {deviceKind && list === null && <span className="rm-srcstrip-note">Looking…</span>}
        {deviceKind && list?.length === 0 && denied && (
          <button
            className="rm-srcstrip-chip grant"
            onClick={() => {
              if (deviceKind === "screen") ipc.liveScreenCoach("open_settings").catch(() => {});
              else if (denied)
                ipc
                  .liveScreenCoach(deviceKind === "camera" ? "open_camera_settings" : "open_mic_settings")
                  .catch(() => {});
              else ipc.liveRequestPermission(deviceKind as "camera" | "mic").catch(() => {});
            }}
          >
            Open Settings
          </button>
        )}
        {deviceKind && list?.length === 0 && !denied && (
          <span className="rm-srcstrip-note">Nothing found</span>
        )}
        {/* A/V sync, the control OBS calls sync offset. Audio and video reach
          * the engine by different paths — a capture card has a fixed lag, a
          * remote guest has a network one — and the drift is steady, so a
          * fixed nudge fixes it. Clap on camera and dial until it lines up. */}
        {syncItem && (
          <>
            <span className="rm-srcstrip-sep" />
            <span className="rm-srcstrip-note">A/V sync</span>
            <button
              className="rm-srcstrip-chip"
              title="Delay the audio 20ms less"
              onClick={() => setSyncOffset(syncItem.id, (syncItem.sync_ms ?? 0) - 20).catch(() => {})}
            >
              −20
            </button>
            <span className="rm-srcstrip-sync">{syncItem.sync_ms ?? 0}ms</span>
            <button
              className="rm-srcstrip-chip"
              title="Delay the audio 20ms more"
              onClick={() => setSyncOffset(syncItem.id, (syncItem.sync_ms ?? 0) + 20).catch(() => {})}
            >
              +20
            </button>
            {(syncItem.sync_ms ?? 0) !== 0 && (
              <button
                className="rm-srcstrip-chip"
                title="Back to zero"
                onClick={() => setSyncOffset(syncItem.id, 0).catch(() => {})}
              >
                Reset
              </button>
            )}
          </>
        )}
        {deviceKind &&
          list?.map((d) => {
            const on = active ? d.id === active : false;
            return (
              <button
                key={d.id}
                className={`rm-srcstrip-chip${on ? " on" : ""}`}
                disabled={d.disabled || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await deviceIpc.set(deviceKind, d.id);
                  } catch {
                    /* engine reports via banner */
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {on && <span className="rm-srcstrip-dot" />}
                {d.name}
              </button>
            );
          })}
      </div>
      <button className="rm-srcstrip-x" title="Close settings" onClick={onClose}>
        {ic.x}
      </button>
    </div>
  );
}

/** The Guest component: one row for the whole panel, expanding to whoever is
 * in it. Guests arrive through a shared room link, so the list is the server's
 * roster rather than anything Producer decided.
 *
 * Waiting guests are shown but NOT on the broadcast. The link is public, so
 * admitting is an explicit act — otherwise anyone holding the URL would appear
 * on air under a name they typed themselves. */
function GuestPanel({
  thumbs,
  roster,
  error,
  items,
  onAdmit,
  onRemove,
  onMute,
  onShow,
}: {
  thumbs: Record<string, string>;
  roster: RoomGuest[];
  error: string | null;
  items: LiveItem[];
  onAdmit: (id: string) => void;
  onRemove: (id: string) => void;
  onMute: (sourceId: string, muted: boolean) => void;
  onShow: (sourceId: string, show: boolean) => void;
}) {
  // render_url is the server's own statement of "this one may go on the
  // host". Waiting guests have none, so the gate is enforced there rather
  // than by us choosing not to draw someone.
  const onStage = items.filter((i) => i.visible).length;
  const waiting = roster.filter((g) => !g.render_url);
  const live = roster.filter((g) => !!g.render_url);
  const ROOM_CAP = 8;
  const STAGE_CAP = 4;


  return (
    <div className="rm-guests">

      {(
        <div className="rm-guest-list">
          {roster.length === 0 && (
            <div className="rm-rows-empty">
              No one yet. Copy the link and share it — guests join from any browser.
            </div>
          )}
          {waiting.map((g) => (
            <div key={g.id} className="rm-guest waiting">
              <span className="rm-wait-dot" />
              <span className="rm-guest-name">{g.display_name || "Guest"}</span>
              <button
                className="rm-guest-admit"
                disabled={live.length >= ROOM_CAP}
                title={live.length >= ROOM_CAP ? `Room is full (${ROOM_CAP})` : "Bring them into the room"}
                onClick={() => onAdmit(g.id)}
              >
                Admit
              </button>
              <button className="rm-row-edit" title="Remove" onClick={() => onRemove(g.id)}>
                {ic.x}
              </button>
            </div>
          ))}
          {live.map((g) => {
            const item = items.find((i) => i.id === `guest-${g.id.slice(0, 8)}`);
            const muted = item?.muted ?? false;
            const q = (g.quality ?? g.connection_quality ?? "unknown") as string;
            return (
              <div key={g.id} className={`rm-gcard${item?.visible ? " on" : ""}`}>
                {thumbs[`guest-${g.id.slice(0, 8)}`] ? (
                  <img className="rm-gcard-img" src={thumbs[`guest-${g.id.slice(0, 8)}`]} alt="" />
                ) : (
                  <span className="rm-gcard-img empty" />
                )}
                {/* Identity strip: always visible — name and the health of
                  * what actually reaches the show. Neutral when unknown. */}
                <div className="rm-gcard-id">
                  <span className={`rm-qual ${q}`} title={
                    q === "good" ? "Connection healthy"
                      : q === "degraded" ? "Connection struggling — they may break up on air"
                      : q === "failing" ? "Connection failing — don't put them up yet"
                      : "No recent reading"
                  } />
                  <span className="rm-gcard-name">{g.display_name || "Guest"}</span>
                  {item?.visible && <span className="rm-gcard-live">ON</span>}
                </div>
                {/* Controls: the card is the feed; hands appear on hover. */}
                <div className="rm-gcard-ctl">
                  <button
                    className={`rm-guest-stage${item?.visible ? " on" : ""}`}
                    title={
                      item?.visible ? "Take off screen (stays in the room)"
                        : onStage >= STAGE_CAP ? `Four on screen is the limit — take one down first`
                        : "Put on screen"
                    }
                    disabled={!item || (!item.visible && onStage >= STAGE_CAP)}
                    data-warn={!item?.visible && q === "failing" ? "1" : undefined}
                    onClick={() => item && onShow(item.id, !item.visible)}
                  >
                    {item?.visible ? "On screen" : "Show"}
                  </button>
                  <button
                    className={`rm-row-edit${muted ? " muted" : ""}`}
                    title={muted ? "Unmute" : "Mute"}
                    disabled={!item}
                    onClick={() => item && onMute(item.id, !muted)}
                  >
                    {ic.mic}
                  </button>
                  <button className="rm-row-edit" title="Remove" onClick={() => onRemove(g.id)}>
                    {ic.x}
                  </button>
                </div>
              </div>
            );
          })}
          {error && <div className="rm-chatsetup-err">{error}</div>}
        </div>
      )}
    </div>
  );
}

/** A source's filter chain, and the properties of whichever filter is open.
 * Lives INSIDE the panel body so the stage stays fully visible while you
 * tune — you're judging a chroma key by looking at the picture, not at a
 * dialog that covers it. Works the same wherever the panel is docked. */
function FilterEditor({
  sourceId,
  sourceLabel,
  media,
  onBack,
}: {
  sourceId: string;
  sourceLabel: string;
  media: "video" | "audio";
  onBack: () => void;
}) {
  const [chain, setChain] = useState<FilterState[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(
    async (op: FilterOp) => {
      try {
        setChain(await filtersIpc(sourceId, op));
        setErr(null);
      } catch (e) {
        setErr(String(e));
      }
    },
    [sourceId],
  );

  useEffect(() => {
    run({ op: "list" });
  }, [run]);

  const available = FILTER_CATALOG.filter((f) => f.media === media);
  const current = chain?.find((f) => f.name === open) ?? null;
  const spec = current ? specOf(current.kind) : null;

  // A filter's identity is its name; two of a kind get numbered.
  const nameFor = (label: string) => {
    const taken = new Set((chain ?? []).map((f) => f.name));
    if (!taken.has(label)) return label;
    for (let i = 2; i < 50; i++) if (!taken.has(`${label} ${i}`)) return `${label} ${i}`;
    return `${label} ${Date.now()}`;
  };

  if (current && spec) {
    return (
      <div className="rm-filters">
        <div className="rm-filters-head">
          <button className="rm-crumb" onClick={() => setOpen(null)}>
            {ic.chevRight}
            {sourceLabel} · Filters
          </button>
          <span className="rm-filters-title">{current.name}</span>
        </div>
        <div className="rm-props">
          {spec.props.map((pr) => {
            const raw = current.settings[pr.key];
            if (pr.kind === "choice") {
              return (
                <div key={pr.key} className="rm-prop">
                  <span className="rm-prop-label">{pr.label}</span>
                  <div className="rm-prop-choices">
                    {pr.choices?.map((c) => (
                      <button
                        key={c.value}
                        className={`rm-srcstrip-chip${String(raw) === c.value ? " on" : ""}`}
                        onClick={() =>
                          run({ op: "update", name: current.name, settings: { [pr.key]: c.value } })
                        }
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            }
            const val = typeof raw === "number" ? raw : Number(raw ?? 0);
            return (
              <div key={pr.key} className="rm-prop">
                <span className="rm-prop-label">{pr.label}</span>
                <input
                  className="rm-prop-range"
                  type="range"
                  min={pr.min}
                  max={pr.max}
                  step={pr.step}
                  value={val}
                  onChange={(e) =>
                    run({
                      op: "update",
                      name: current.name,
                      settings: { [pr.key]: Number(e.target.value) },
                    })
                  }
                />
                <span className="rm-prop-val">
                  {Number.isInteger(val) ? val : val.toFixed(2)}
                  {pr.unit ?? ""}
                </span>
              </div>
            );
          })}
        </div>
        {err && <div className="rm-chatsetup-err">{err}</div>}
      </div>
    );
  }

  return (
    <div className="rm-filters">
      <div className="rm-filters-head">
        <button className="rm-crumb" onClick={onBack}>
          {ic.chevRight}
          Sources
        </button>
        <span className="rm-filters-title">{sourceLabel} · Filters</span>
        <button className="rm-panel-plus" title="Add a filter" onClick={() => setAdding((a) => !a)}>
          {ic.plus}
        </button>
      </div>

      {adding && (
        <div className="rm-rows">
          {available.map((f) => (
            <div
              key={f.kind}
              role="button"
              tabIndex={0}
              className="rm-row rm-addfilter"
              onClick={() => {
                setAdding(false);
                run({ op: "add", kind: f.kind, name: nameFor(f.label) });
              }}
            >
              <span className="rm-row-name">{f.label}</span>
              <span className="rm-filter-hint">{f.hint}</span>
            </div>
          ))}
        </div>
      )}

      {!adding && (
        <div className="rm-rows">
          {chain === null && <div className="rm-rows-empty">Reading the chain…</div>}
          {chain?.length === 0 && (
            <div className="rm-rows-empty">
              No filters yet.{" "}
              {media === "audio"
                ? "Most streamers run noise suppression, a gate, then a compressor."
                : "Chroma key removes a green screen; colour correction fixes a dull camera."}
            </div>
          )}
          {chain?.map((f, i) => (
            <div key={f.name} className={`rm-row${f.enabled ? "" : " off"}`}>
              <span className="rm-filter-ord">{i + 1}</span>
              <span className="rm-row-name">{f.name}</span>
              <button
                className="rm-row-edit"
                title="Move earlier in the chain"
                disabled={i === 0}
                onClick={() => run({ op: "reorder", name: f.name, movement: 0 })}
              >
                ▲
              </button>
              <button
                className="rm-row-edit"
                title="Move later in the chain"
                disabled={i === (chain?.length ?? 1) - 1}
                onClick={() => run({ op: "reorder", name: f.name, movement: 1 })}
              >
                ▼
              </button>
              <button
                className={`rm-row-edit rm-row-eye${f.enabled ? "" : " off"}`}
                title={f.enabled ? "Bypass" : "Enable"}
                onClick={() => run({ op: "enable", name: f.name, on: !f.enabled })}
              >
                {ic.eye}
              </button>
              <button className="rm-row-edit" title="Settings" onClick={() => setOpen(f.name)}>
                {ic.gear}
              </button>
              <button
                className="rm-row-edit rm-row-remove"
                title="Remove"
                onClick={() => run({ op: "remove", name: f.name })}
              >
                {ic.x}
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <div className="rm-chatsetup-err">{err}</div>}
    </div>
  );
}

/** Mini-editors for open-list sources: enough to put the thing on the
 * stage; refinement happens there. */
function TextSourceForm({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="rm-srcform">
      <div className="rm-devices-head">Text</div>
      <input
        autoFocus
        placeholder="Say it big…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) onAdd(text.trim());
        }}
      />
      <button className="rm-srcform-add" disabled={!text.trim()} onClick={() => onAdd(text.trim())}>
        Add to stage
      </button>
    </div>
  );
}

function ColorSourceForm({ onAdd }: { onAdd: (color: string) => void }) {
  const [color, setColor] = useState("#3ddca6");
  return (
    <div className="rm-srcform">
      <div className="rm-devices-head">Color</div>
      <div className="rm-srcform-row">
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <span className="rm-srcform-hex">{color}</span>
      </div>
      <button className="rm-srcform-add" onClick={() => onAdd(color)}>
        Add to stage
      </button>
    </div>
  );
}

function WindowSourceForm({ onAdd }: { onAdd: (id: number, title: string) => void }) {
  const [windows, setWindows] = useState<LiveWindow[] | null>(null);
  useEffect(() => {
    ipc
      .liveListWindows()
      .then(setWindows)
      .catch(() => setWindows([]));
  }, []);
  return (
    <div className="rm-devices">
      <div className="rm-devices-head">Window</div>
      {windows === null && <div className="rm-devices-empty">Looking…</div>}
      {windows?.length === 0 && (
        <div className="rm-devices-empty">No windows found — needs the screen-recording grant.</div>
      )}
      {windows?.map((w) => (
        <button key={w.id} className="rm-device" onClick={() => onAdd(w.id, w.owner)}>
          <span className="rm-device-name">
            {w.owner}
            {w.title ? ` — ${w.title}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Device picker for a source. The list comes straight from the engine, so
 * whatever the OS exposes — built-in camera, capture card, USB mic, audio
 * interface, second display — appears here without Producer knowing the
 * hardware. Switching applies in place: the source keeps its position, size
 * and place in the stack. */
function DevicePicker({ kind, onClose }: { kind: string; onClose: () => void }) {
  const [list, setList] = useState<DeviceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let alive = true;
    deviceIpc
      .list(kind)
      .then((d) => alive && setList(Array.isArray(d) ? d : []))
      .catch((e) => alive && setError(String(e)));
    // macOS gates device ENUMERATION, not just capture: without the grant
    // the list comes back empty, which must read as "allow access", never
    // as "you have no camera". Watch briskly so a fresh grant flips the
    // menu to hardware while it's still open.
    let wasDenied = false;
    const check = () =>
      ipc
        .livePermissions()
        .then((p) => {
          if (!alive) return;
          const status = kind === "camera" ? p.camera : kind === "mic" ? p.mic : p.screen;
          const nowDenied = status !== "granted";
          if (wasDenied && !nowDenied) {
            deviceIpc
              .list(kind)
              .then((d) => alive && setList(Array.isArray(d) ? d : []))
              .catch(() => {});
          }
          wasDenied = nowDenied;
          setDenied(nowDenied);
        })
        .catch(() => {});
    check();
    const t = setInterval(check, 800);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [kind]);

  const label = kind === "camera" ? "Camera" : kind === "mic" ? "Microphone" : "Screen recording";
  const title = kind === "camera" ? "Camera" : kind === "mic" ? "Input device" : "Display";
  return (
    <div className="rm-devices">
      <div className="rm-devices-head">{title}</div>
      {error && <div className="rm-chatsetup-err">{error}</div>}
      {!error && list === null && <div className="rm-devices-empty">Looking…</div>}
      {!error && list?.length === 0 && denied && (
        <div className="rm-devices-empty">
          <div>{label} access isn&rsquo;t granted yet, so macOS hides the device list.</div>
          <button
            className="rm-device-grant"
            onClick={() => {
              if (kind === "screen") ipc.liveScreenCoach("open_settings").catch(() => {});
              else ipc.liveRequestPermission(kind as "camera" | "mic").catch(() => {});
            }}
          >
            {kind === "screen" ? "Open Settings" : "Allow access"}
          </button>
        </div>
      )}
      {!error && list?.length === 0 && !denied && (
        <div className="rm-devices-empty">
          {kind === "mic" ? "No inputs found. Plug one in and reopen." : "Nothing available."}
        </div>
      )}
      {list?.map((d) => (
        <button
          key={d.id}
          className="rm-device"
          disabled={d.disabled || busy !== null}
          onClick={async () => {
            setBusy(d.id);
            try {
              await deviceIpc.set(kind, d.id);
              onClose();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          <span className="rm-device-name">{d.name}</span>
        </button>
      ))}
    </div>
  );
}

function PreviewPanel({ children }: { children?: ReactNode }) {
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
            // The attach call itself reports whether the stage can be a
            // transparent hole (preview behind the webview) — no polling.
            const transparent = await ipc.liveAttachPreview(r.x, r.y, r.width, r.height);
            attached.current = true;
            document.documentElement.dataset.stage = transparent ? "transparent" : "opaque";
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
        // Home must not inherit the hole: its ground rules assume opaque.
        document.documentElement.dataset.stage = "opaque";
        ipc.liveDetachPreview().catch(() => {});
      }
    };
  }, []);

  return (
    <div ref={ref} className="live-preview">
      {children}
    </div>
  );
}

/** The three built-in scenes as canvas-sized recipes. Deterministic z is
 * the point: screen 0, overlay above it, camera on top — never an accident
 * of which source happened to be created last. */
function builtinLook(p: RoomScene, bw: number, bh: number): Record<string, SceneItemLook> {
  const pipW = Math.round(bw * 0.28);
  const pipH = Math.round((pipW * 9) / 16);
  const m = Math.round(bw * 0.02);
  const look: Record<string, SceneItemLook> = {};
  look.screen = p.screen ? { visible: true, x: 0, y: 0, w: bw, h: bh, z: 0 } : { visible: false };
  look.overlay = { visible: true, z: 1 };
  look.camera = p.camera
    ? p.screen
      ? { visible: true, x: bw - pipW - m, y: bh - pipH - m, w: pipW, h: pipH, z: 2 }
      : { visible: true, x: 0, y: 0, w: bw, h: bh, z: 2 }
    : { visible: false };
  return look;
}

/** Permission state lives with the controls, not over the canvas: a slim
 * dark banner above the pills, one line per missing grant. Screen uses the
 * First Light machinery (Settings deep-link + native drag chip). */
function PermBanner({
  sources,
  onGranted,
}: {
  sources: LiveSources;
  onGranted?: (kind: "screen" | "camera" | "mic") => void;
}) {
  const [perms, setPerms] = useState<LivePermissions | null>(null);
  const prevPerms = useRef<LivePermissions | null>(null);
  const onGrantedRef = useRef(onGranted);
  onGrantedRef.current = onGranted;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const p = await ipc.livePermissions();
        if (!alive) return;
        const prev = prevPerms.current;
        prevPerms.current = p;
        setPerms(p);
        if (prev) {
          for (const k of ["screen", "camera", "mic"] as const) {
            if (prev[k] !== "granted" && p[k] === "granted") onGrantedRef.current?.(k);
          }
        }
      } catch {
        /* engine absent */
      }
    };
    load();
    // The OS answers instantly; a slow poll here is the only reason a
    // granted banner would linger. Check briskly, and re-check the moment
    // the app regains focus (grants made in System Settings happen outside).
    const t = setInterval(load, 800);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", load);
    };
  }, []);

  if (!perms) return null;
  const rows: { kind: "screen" | "camera" | "mic"; label: string; status: string; needed: boolean }[] = [
    { kind: "screen", label: "Screen recording", status: perms.screen, needed: sources.screen },
    { kind: "camera", label: "Camera", status: perms.camera, needed: sources.camera },
    { kind: "mic", label: "Microphone", status: perms.mic, needed: sources.mic },
  ];
  const pending = rows.filter((r) => r.needed && r.status !== "granted");
  if (pending.length === 0) return null;

  return (
    <div className="rm-perms">
      {pending.map((r) => {
        // Once a capture permission is DENIED, macOS never prompts again —
        // requestAccess just completes with NO and nothing appears. An
        // "Allow" button there is a lie; Settings is the only way back.
        const askable = r.kind !== "screen" && r.status === "not_determined";
        return (
          <div key={r.kind} className="rm-perm-row">
            <span className="rm-perm-dot" />
            <span className="rm-perm-text">
              {r.kind === "screen"
                ? `${r.label} isn’t granted — drag the chip in, then relaunch`
                : askable
                  ? `${r.label} isn’t granted`
                  : `${r.label} was turned off — switch Producer back on in Settings`}
            </span>
            <button
              className="rm-perm-fix"
              onClick={() => {
                if (r.kind === "screen") {
                  ipc.liveScreenCoach("open_settings").catch(() => {});
                  ipc.liveScreenCoach("chip_show").catch(() => {});
                } else if (askable) {
                  ipc.liveRequestPermission(r.kind).catch(() => {});
                } else {
                  ipc
                    .liveScreenCoach(r.kind === "camera" ? "open_camera_settings" : "open_mic_settings")
                    .catch(() => {});
                }
              }}
            >
              {r.kind === "screen" ? "Fix in Settings" : askable ? "Allow" : "Open Settings"}
            </button>
          </div>
        );
      })}
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

/** Popovers escape every scrolling/clipping ancestor by rendering into the
 * document root and positioning against their anchor, clamped to the
 * viewport. Any menu that lives inside a dock or panel needs this. */
function Pop({
  anchor,
  align = "right",
  className = "",
  children,
}: {
  anchor: HTMLElement | null;
  align?: "left" | "right" | "up";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    visibility: "hidden",
    top: 0,
    left: 0,
    right: "auto",
    bottom: "auto",
    maxHeight: "70vh",
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const gap = 8;
      const pad = 10;
      let top = align === "up" ? a.top - r.height - gap : a.bottom + gap;
      let left =
        align === "up"
          ? a.left + a.width / 2 - r.width / 2
          : align === "left"
            ? a.left
            : a.right - r.width;
      // Flip up if it would fall off the bottom, then clamp both axes.
      if (align !== "up" && top + r.height > window.innerHeight - pad) {
        top = a.top - r.height - gap;
      }
      left = Math.max(pad, Math.min(left, window.innerWidth - r.width - pad));
      top = Math.max(pad, Math.min(top, window.innerHeight - r.height - pad));
      setStyle({ position: "fixed", top, left, right: "auto", bottom: "auto", maxHeight: "70vh" });
    };
    place();
    // Content can arrive after the first measure (a device list, a fetched
    // status), and a popover measured while it said "Looking…" would then
    // grow straight off the bottom of the window. Re-place whenever the
    // element's own size changes.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, align]);

  return createPortal(
    <div ref={ref} className={`rm-pop rm-pop-portal ${className}`} style={style}>
      {children}
    </div>,
    document.body,
  );
}

/* Icon set lifted from the Boomin Live room mocks. */
const ic = {
  play: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4" width="19" height="16" rx="3" />
      <path d="M10 9.2v5.6L14.8 12z" fill="currentColor" stroke="none" />
    </svg>
  ),
  image: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3.8 18.5 9.5 13l4 4 3-3 3.7 3.7" />
    </svg>
  ),
  text: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 6V4.5h14V6M12 4.5V19.5M9 19.5h6" />
    </svg>
  ),
  swatch: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  ),
  mic: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </svg>
  ),
  cam: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10l5-3v10l-5-3" />
      <rect x="2" y="6" width="13" height="12" rx="2" />
    </svg>
  ),
  screen: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M12 11V8M10 9.5l2-1.5 2 1.5M8 21h8" />
    </svg>
  ),
  link: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  ),
  invite: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  ),
  plus: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  gear: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  eye: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  chev: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  onair: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" />
      <path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8" />
    </svg>
  ),
  cast: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <path d="M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01" />
    </svg>
  ),
  x: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  chat: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  collapseDown: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M8 11l4 4 4-4M12 15V9" />
    </svg>
  ),
  grip: (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
      <circle cx="3.5" cy="3" r="1.3" /><circle cx="8.5" cy="3" r="1.3" />
      <circle cx="3.5" cy="7" r="1.3" /><circle cx="8.5" cy="7" r="1.3" />
      <circle cx="3.5" cy="11" r="1.3" /><circle cx="8.5" cy="11" r="1.3" />
    </svg>
  ),
  dots: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
    </svg>
  ),
  layout: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M9 14h12" />
    </svg>
  ),
  chevRight: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  collapse: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  sliders: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </svg>
  ),
  ext: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  ),
};

/** Chat is text on the wire — "KEKW" arrives as four letters. Swap any word
 * that names an emote for its image, so the panel reads the way the real
 * chat does. Per-message emotes (Twitch's own) win over the channel-wide
 * 7TV/BTTV set. */
function ChatText({
  text,
  emotes,
  channelEmotes,
}: {
  text: string;
  emotes?: Record<string, string>;
  channelEmotes: Record<string, string>;
}) {
  const parts = text.split(/(\s+)/);
  return (
    <span className="rm-chat-text">
      {parts.map((p, i) => {
        const url = emotes?.[p] ?? channelEmotes[p];
        return url ? (
          <img key={i} className="rm-emote" src={url} alt={p} title={p} loading="lazy" />
        ) : (
          <Fragment key={i}>{p}</Fragment>
        );
      })}
    </span>
  );
}

/** Icon per open-list source kind, for panel rows. */
const EXTRA_ICONS: Record<string, ReactNode> = {
  media: ic.play,
  image: ic.image,
  text: ic.text,
  color: ic.swatch,
  window: ic.screen,
  guest: ic.invite,
};


/** Brand marks (twitch/youtube via svgl.app; kick authored to brand green). */
const PLATFORM_LOGO: Record<string, ReactNode> = {
  twitch: (
    <svg width="15" height="15" viewBox="0 0 2400 2800">
      <path fill="#fff" d="m2200 1300-400 400h-400l-350 350v-350H600V200h1600z" />
      <g fill="#9146ff">
        <path d="M500 0 0 500v1800h600v500l500-500h400l900-900V0zm1700 1300-400 400h-400l-350 350v-350H600V200h1600z" />
        <path d="M1700 550h200v600h-200zm-550 0h200v600h-200z" />
      </g>
    </svg>
  ),
  youtube: (
    <svg width="17" height="12" viewBox="0 0 256 180">
      <path fill="red" d="M250.346 28.075A32.18 32.18 0 0 0 227.69 5.418C207.824 0 127.87 0 127.87 0S47.912.164 28.046 5.582A32.18 32.18 0 0 0 5.39 28.24c-5.408 35.298-7.505 89.084.152 122.97a32.18 32.18 0 0 0 22.656 22.657c19.866 5.418 99.822 5.418 99.822 5.418s79.955 0 99.82-5.418a32.18 32.18 0 0 0 22.657-22.657c5.71-35.348 7.467-89.1-.15-123.134" />
      <path fill="#fff" d="m102.421 128.06 66.328-38.418-66.328-38.418z" />
    </svg>
  ),
  kick: (
    <svg width="14" height="14" viewBox="0 0 32 32">
      <path fill="#53fc18" d="M4 2h8v8h4V6h4V2h8v10h-4v4h4v10h-8v-4h-4v-4h-4v8H4z" />
    </svg>
  ),
};

const PLATFORM_TINT: Record<string, string> = {
  twitch: "#a970ff",
  kick: "#53fc18",
  youtube: "#ff4e45",
};

/** Mock-faithful slim fader: 4px track, white 26×14 thumb, pointer drag. */
function Fader({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (ui: number) => void }) {
  const track = useRef<HTMLDivElement | null>(null);

  function fromEvent(e: { clientY: number }) {
    const el = track.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ui = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    onChange(ui);
  }

  return (
    <div
      ref={track}
      className={`rm-fader${disabled ? " disabled" : ""}`}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        fromEvent(e);
      }}
      onPointerMove={(e) => {
        if (disabled || e.buttons !== 1) return;
        fromEvent(e);
      }}
    >
      <div className="rm-fader-track" />
      <div className="rm-fader-thumb" style={{ top: `calc(${(1 - value) * 100}% - 7px)` }} />
    </div>
  );
}

/** Vertical meter + fader strip, straight from the sources-sheet mock. */
function MeterStrip({
  label,
  icon,
  level,
  horizontal,
  volume,
  muted,
  disabled,
  onVolume,
  onMute,
  onToggle,
  onFilters,
}: {
  label: string;
  icon: ReactNode;
  level: number;
  /** Top-dock form: name + a thin left-to-right level bar. */
  horizontal?: boolean;
  volume: number;
  muted: boolean;
  disabled?: boolean;
  onVolume?: (mul: number) => void;
  onMute?: () => void;
  onToggle?: () => void;
  onFilters?: () => void;
}) {
  const ui = Math.cbrt(Math.max(0, Math.min(1, volume)));
  const db = volume > 0.001 ? Math.round(20 * Math.log10(volume)) : -60;
  const dead = disabled;
  return (
    <div className={`rm-strip${horizontal ? " horizontal" : ""}${dead ? " dead" : ""}`}>
      <div className="rm-strip-cols">
        <div className="rm-meter">
          <div
            className="rm-meter-fill"
            style={
              horizontal
                ? { width: `${Math.round((dead || muted ? 0 : level) * 100)}%`, height: "100%" }
                : { height: `${Math.round((dead || muted ? 0 : level) * 100)}%` }
            }
          />
        </div>
        <Fader value={dead ? 0.35 : ui} disabled={dead} onChange={(u) => onVolume?.(u * u * u)} />
      </div>
      <span className="rm-strip-db">{disabled ? "off" : muted ? "muted" : `${db <= -60 ? "-∞" : db} dB`}</span>
      <button className={`rm-strip-icon${muted ? " muted" : ""}`} disabled={dead} onClick={onMute} title={muted ? "Unmute" : "Mute"}>
        {icon}
      </button>
      {onToggle ? (
        <button
          className={`rm-strip-name as-toggle${disabled ? " off" : ""}`}
          onClick={onToggle}
          title={disabled ? `Turn ${label.toLowerCase()} on` : `Turn ${label.toLowerCase()} off`}
        >
          {label}
        </button>
      ) : (
        <span className="rm-strip-name">{label}</span>
      )}
      {onFilters && (
        <button
          className="rm-strip-fx"
          disabled={dead}
          title="Filters — noise suppression, gate, compressor"
          onClick={onFilters}
        >
          ƒ
        </button>
      )}
    </div>
  );
}

/** Day-one chat: platform popout chat in a compact companion window.
 * Channel names are remembered locally — no OAuth involved. */
function ChatPopover({ onClose }: { onClose: () => void }) {
  const [twitch, setTwitch] = useState(() => localStorage.getItem("producer.chat.twitch") ?? "");
  const [kick, setKick] = useState(() => localStorage.getItem("producer.chat.kick") ?? "");
  const [error, setError] = useState<string | null>(null);

  async function open(url: string, storeKey: string, value: string) {
    try {
      localStorage.setItem(storeKey, value.trim());
      await ipc.liveOpenChat(url);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="st-chat-pop">
      <div className="st-chat-row">
        <span className="st-chat-label">Twitch</span>
        <input
          value={twitch}
          onChange={(e) => setTwitch(e.target.value)}
          placeholder="channel name"
        />
        <button
          disabled={!twitch.trim()}
          onClick={() =>
            open(
              `https://www.twitch.tv/popout/${encodeURIComponent(twitch.trim().toLowerCase())}/chat`,
              "producer.chat.twitch",
              twitch,
            )
          }
        >
          Open
        </button>
      </div>
      <div className="st-chat-row">
        <span className="st-chat-label">Kick</span>
        <input value={kick} onChange={(e) => setKick(e.target.value)} placeholder="channel name" />
        <button
          disabled={!kick.trim()}
          onClick={() =>
            open(
              `https://kick.com/popout/${encodeURIComponent(kick.trim().toLowerCase())}/chat`,
              "producer.chat.kick",
              kick,
            )
          }
        >
          Open
        </button>
      </div>
      <div className="st-chat-hint">
        Opens the platform&rsquo;s own chat in a small window — sign in once, it remembers you.
      </div>
      {error && <div className="live-error">{error}</div>}
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

export interface RoomInfo {
  id: string;
  name: string;
  config: string;
}

export function LiveView({
  room,
  onLeave,
}: {
  room?: RoomInfo;
  onLeave?: () => void;
}) {
  const [destinations, setDestinations] = useState<LiveDestination[]>([]);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  /** 60s render-load history for the stats sparkline (1Hz, CPU share). */
  const loadHist = useRef<number[]>([]);
  const snapRef = useRef<LiveSnapshot | null>(null);
  /** Live guest previews, source-id → data URL (15fps demand-driven). */
  const [guestThumbs, setGuestThumbs] = useState<Record<string, string>>({});

  // Mount veil: the engine takes a beat to bootstrap, and permission grants
  // bounce sources — both look like a broken room if the half-built UI shows.
  // The veil holds until the engine is truly ready, and returns during
  // post-Allow source restarts.
  const [mountVeil, setMountVeil] = useState(true);
  const [veilNote, setVeilNote] = useState("Preparing the stage…");
  // engineOk means the ENGINE booted — the room is configured only after the
  // stored video mode is applied and the pending scene has been laid out.
  const [sceneSettled, setSceneSettled] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, LiveDestStatus>>(new Map());

  // Header health. Derived every render, never stored: a health number that
  // can go stale is worse than none when you're deciding whether to keep
  // streaming.
  const droppedTotal = [...statuses.values()].reduce((n, st) => n + st.dropped_frames, 0);
  const reconnectTotal = [...statuses.values()].reduce((n, st) => n + st.reconnects, 0);
  const bytesTotal = [...statuses.values()].reduce((n, st) => n + st.bytes_sent, 0);

  const [elapsed, setElapsed] = useState(0);
  const [editing, setEditing] = useState<LiveDestination | null>(null);
  const [adding, setAdding] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [sources, setSources] = useState<LiveSources>({ screen: false, camera: false, mic: false });
  const [micLevel, setMicLevel] = useState(0);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setAppVersion).catch(() => {});
  }, []);
  /** Per-source meter levels for audio-bearing extras (guests, media). */
  const [extraLevels, setExtraLevels] = useState<Record<string, number>>({});
  const [sheetOpen, setSheetOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [micPopOpen, setMicPopOpen] = useState(false);
  const [destsOpen, setDestsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [panelMenu, setPanelMenu] = useState<PanelId | null>(null);
  const [layoutMenu, setLayoutMenu] = useState(false);
  const [layoutEdit, setLayoutEdit] = useState(false);
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [dropHint, setDropHint] = useState<{ dock: Dock; index: number } | null>(null);

  // Sources panel: pointer-drag row rearranging (stage z-order lives here).
  const srcRowsRef = useRef<HTMLDivElement | null>(null);
  const [srcDrag, setSrcDrag] = useState<{ key: string; over: number } | null>(null);
  const [srcAddOpen, setSrcAddOpen] = useState(false);
  /** Insertion index among the OTHER item rows for a pointer at clientY. */
  const srcDropIndex = (dragKey: string, clientY: number) => {
    const list = srcRowsRef.current;
    if (!list) return 0;
    const others = Array.from(list.querySelectorAll<HTMLElement>("[data-srcrow]")).filter(
      (el) => el.dataset.srcrow !== dragKey,
    );
    let idx = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        idx = i;
        break;
      }
    }
    return idx;
  };
  const commitSrcOrder = () => {
    setSrcDrag((d) => {
      if (d) {
        const list = srcRowsRef.current;
        const rendered = list
          ? Array.from(list.querySelectorAll<HTMLElement>("[data-srcrow]")).map((el) => el.dataset.srcrow!)
          : [];
        const others = rendered.filter((k) => k !== d.key);
        const order = [...others.slice(0, d.over), d.key, ...others.slice(d.over)];
        // Rendered order is topmost-first; engine z counts from the bottom.
        // Apply bottom-up so each set lands on a settled stack.
        const itemId = (k: string) => (k === "alerts" ? "overlay" : k);
        // The Guests row is one BLOCK: expand it into the guest layers
        // (topmost first, internal order preserved) so the block moves
        // through the stack as a unit.
        const guestIds = (sources.items ?? [])
          .filter((i) => i.kind === "guest")
          .sort((a, b) => b.z - a.z)
          .map((i) => i.id);
        const expanded = order.flatMap((k) => (k === "guests" ? guestIds : [k]));
        (async () => {
          for (let i = expanded.length - 1; i >= 0; i--) {
            const z = expanded.length - 1 - i;
            try {
              await ipc.liveSetTransform(itemId(expanded[i]), { z }, i === 0);
            } catch {
              /* engine not ready */
            }
          }
        })();
      }
      return null;
    });
  };
  const [addMenu, setAddMenu] = useState<Dock | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [popAnchor, setPopAnchor] = useState<HTMLElement | null>(null);
  // The room document: dock layout, scenes, channel selection, scene state.
  const [cfg, setCfgState] = useState<RoomConfig>(() => parseConfig(room?.config));
  // Event handlers registered once must not close over a stale document.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const layout = cfg.layout;
  // Demand control (docs/THUMB-PIPELINE-V2.md): pay for preview frames only
  // while the guests panel is somewhere visible. 0 on hide and on unmount.
  const guestsDock = dockOf(layout, "guests");
  useEffect(() => {
    ipc.liveSetThumbRate(guestsDock === "hidden" ? 0 : 15).catch(() => {});
    return () => {
      ipc.liveSetThumbRate(0).catch(() => {});
    };
  }, [guestsDock]);
  const writeCfg = (next: RoomConfig) => {
    // Update the ref SYNCHRONOUSLY. Engine events arrive faster than React
    // re-renders, and they merge against cfgRef — a stale ref meant a
    // SourcesChanged landing between a write and its render would resurrect
    // the previous value and silently drop what was just written (this ate
    // guest invite links).
    cfgRef.current = next;
    setCfgState(next);
    // Room-less sessions keep layout in memory only: the old localStorage
    // write was never read back anywhere (audited) — half-wired dead code.
    if (room) ipc.liveUpdateRoom(room.id, { config: serializeConfig(next) }).catch(() => {});
  };
  const setLayout = (l: Layout) => writeCfg({ ...cfg, layout: l });
  const sizes: DockSizes = cfg.sizes ?? {};
  const setSizes = (next: DockSizes) => writeCfg({ ...cfgRef.current, sizes: next });

  /** Splitter drags: bottom panels trade flex weight with their neighbour;
   * side docks take a pixel width. Live while dragging, persisted on
   * release, so the room remembers the shape you built. */
  const resize = useRef<{
    kind: "bottom" | "left" | "right";
    startX: number;
    a?: PanelId;
    b?: PanelId;
    aW?: number;
    bW?: number;
    aPx?: number;
    bPx?: number;
    startPx?: number;
  } | null>(null);
  const [liveSizes, setLiveSizesState] = useState<DockSizes | null>(null);
  // The pointer-up handler is created at render time, so reading state
  // there would see the value from BEFORE the drag — the resize would
  // revert on release. Mirror it in a ref and persist from that.
  const liveSizesRef = useRef<DockSizes | null>(null);
  const setLiveSizes = (v: DockSizes | null) => {
    liveSizesRef.current = v;
    setLiveSizesState(v);
  };
  const shown: DockSizes = liveSizes ?? sizes;

  const beginResize = (e: React.PointerEvent, kind: "bottom" | "left" | "right", a?: PanelId, b?: PanelId) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (kind === "bottom" && a && b) {
      const ael = document.querySelector<HTMLElement>(`[data-panel="${a}"]`);
      const bel = document.querySelector<HTMLElement>(`[data-panel="${b}"]`);
      resize.current = {
        kind,
        startX: e.clientX,
        a,
        b,
        aW: sizes.weights?.[a] ?? 1,
        bW: sizes.weights?.[b] ?? 1,
        aPx: ael?.getBoundingClientRect().width ?? 1,
        bPx: bel?.getBoundingClientRect().width ?? 1,
      };
    } else {
      const el = document.querySelector<HTMLElement>(`[data-dock="${kind}"]`);
      resize.current = {
        kind,
        startX: e.clientX,
        startPx: el?.getBoundingClientRect().width ?? SIDE_MIN,
      };
    }
    setLiveSizes(sizes);
  };

  const moveResize = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r || e.buttons !== 1) return;
    const dx = e.clientX - r.startX;
    if (r.kind === "bottom" && r.a && r.b) {
      // Weights are proportional to measured pixels, so a drag moves the
      // divider by exactly the distance travelled.
      const total = (r.aPx ?? 1) + (r.bPx ?? 1);
      const totalW = (r.aW ?? 1) + (r.bW ?? 1);
      const aPx = Math.max(140, Math.min(total - 140, (r.aPx ?? 1) + dx));
      const aW = (aPx / total) * totalW;
      setLiveSizes({
        ...sizes,
        weights: { ...sizes.weights, [r.a]: aW, [r.b]: totalW - aW },
      });
    } else {
      const raw = r.kind === "left" ? (r.startPx ?? 0) + dx : (r.startPx ?? 0) - dx;
      const px = Math.max(SIDE_MIN, Math.min(SIDE_MAX, raw));
      setLiveSizes({ ...sizes, [r.kind]: px });
    }
  };

  const endResize = () => {
    const final = liveSizesRef.current;
    if (resize.current && final) setSizes(final);
    resize.current = null;
    setLiveSizes(null);
  };

  const splitter = (kind: "bottom" | "left" | "right", a?: PanelId, b?: PanelId) => (
    <div
      className={`rm-split rm-split-${kind === "bottom" ? "v" : "h"}`}
      title="Drag to resize"
      onPointerDown={(e) => beginResize(e, kind, a, b)}
      onPointerMove={moveResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
    >
      <span className="rm-split-grab" />
    </div>
  );
  const scenes: RoomScene[] = cfg.scenes.length ? cfg.scenes : DEFAULT_SCENES;
  const [overlayOpen, setOverlayOpen] = useState(false);
  const videoApplied = useRef(false);
  const channelsApplied = useRef(false);
  const demoVideoSet = useRef(false);
  const demo = demoOn();
  const [chatFilter, setChatFilter] = useState<"all" | DemoPlatform>("all");
  const [chatMsgs, setChatMsgs] = useState<ChatLine[]>(() => (demoOn() ? DEMO_CHAT.slice(0, 9) : []));
  const chatEnd = useRef<HTMLDivElement | null>(null);
  const chatList = useRef<HTMLDivElement | null>(null);
  /** Reading back through chat pauses the feed — the stream keeps arriving,
   * the view just stops moving under you. */
  const [chatPinned, setChatPinned] = useState(true);
  const chatPinnedRef = useRef(true);
  const [chatBehind, setChatBehind] = useState(0);
  const [chatConns, setChatConns] = useState<ChatConnection[]>([]);
  const [chatSetupOpen, setChatSetupOpen] = useState(false);
  /** Channel-wide emote vocabulary (7TV + BTTV), keyed by name. */
  const [channelEmotes, setChannelEmotes] = useState<Record<string, string>>({});
  /** Which source's device picker is open ("camera" | "mic" | "screen"). */
  const [deviceMenu, setDeviceMenu] = useState<string | null>(null);
  /** Human label of the mic the show is actually using. The guest render page
   * opens the host mic for return audio and can only match by label — browser
   * device ids are salted per origin and can never equal libobs's. */
  const [micDeviceLabel, setMicDeviceLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!sources.mic) {
      setMicDeviceLabel(null);
      return;
    }
    let alive = true;
    deviceIpc
      .list("mic")
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        const id = sources.mic_device;
        const hit = id ? list.find((d) => d.id === id) : undefined;
        // No explicit selection means the system default, which the page
        // also falls back to — so send nothing rather than guess wrong.
        setMicDeviceLabel(hit?.name ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sources.mic, sources.mic_device]);
  /** Experimental: source settings as a horizontal strip above the docked
   * panels — which row's settings are showing. */
  /** R3: recording is independent of streaming — either, both, or neither. */
  /** R13: Producer as a webcam in Zoom/Meet/Discord. Two separate things —
   * the extension being installed (once, with the user's approval) and the
   * output actually running. */
  const [vcamState, setVcamState] = useState<VcamStatus | null>(null);
  const [vcamOn, setVcamOn] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      vcamIpc
        .status()
        .then((v) => alive && setVcamState(v))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const toggleVcam = async () => {
    // Not installed yet → the first click is the install request, not a
    // toggle. macOS then asks the user to approve it in Settings.
    if (!vcamState?.installed && vcamState?.state !== "active") {
      await vcamIpc.activate().catch(() => {});
      // Poll briefly: activation answers on a delegate, and when macOS
      // refuses it the reason is the only thing worth showing.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const st = await vcamIpc.status().catch(() => null);
        if (!st) continue;
        setVcamState(st);
        if (st.state === "failed") {
          setBanner(st.error ?? "macOS refused the camera extension.");
          window.setTimeout(() => setBanner(null), 12000);
          return;
        }
        if (st.state === "needs_approval") {
          setBanner("Approve Producer's camera extension in System Settings › General › Login Items & Extensions.");
          window.setTimeout(() => setBanner(null), 12000);
          return;
        }
        if (st.state === "active" || st.installed) {
          setBanner("Virtual camera installed. Click again to start it.");
          window.setTimeout(() => setBanner(null), 6000);
          return;
        }
      }
      setBanner("Still waiting on macOS for the camera extension.");
      window.setTimeout(() => setBanner(null), 6000);
      return;
    }
    try {
      const on = await vcamIpc.output(!vcamOn);
      setVcamOn(on);
    } catch (e) {
      setBanner(String(e));
      window.setTimeout(() => setBanner(null), 5000);
    }
  };

  const [recPath, setRecPath] = useState<string | null>(null);
  const [recSince, setRecSince] = useState<number>(0);
  const [recTick, setRecTick] = useState(0);
  const [lastRec, setLastRec] = useState<string | null>(null);

  useEffect(() => {
    if (!recPath) return;
    const t = setInterval(() => setRecTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [recPath]);

  const toggleRecord = async () => {
    if (recPath) {
      const done = await recIpc.stop().catch((e) => {
        setBanner(String(e));
        return null;
      });
      setRecPath(null);
      if (done) {
        setLastRec(done);
        setBanner(`Saved ${done.split("/").pop()}`);
        window.setTimeout(() => setBanner(null), 4000);
      }
      return;
    }
    // The engine owns no clock, so the file name is stamped here.
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    try {
      const path = await recIpc.start(stamp);
      setRecPath(path);
      setRecSince(Date.now());
      setRecTick(0);
    } catch (e) {
      setBanner(String(e));
      window.setTimeout(() => setBanner(null), 5000);
    }
  };

  // recTick only exists to re-render once a second while recording.
  void recTick;
  const recElapsed = recPath ? Math.floor((Date.now() - recSince) / 1000) : 0;

  // ── Guest panel ────────────────────────────────────────────────────────
  // Guests arrive through the room link on their own, so the server roster is
  // the source of truth and the local scene is reconciled against it — never
  // the other way round.
  const [roster, setRoster] = useState<RoomGuest[]>([]);
  const [guestLink, setGuestLink] = useState<string | null>(cfg.guest_link ?? null);
  const [guestErr, setGuestErr] = useState<string | null>(null);
  const rosterRef = useRef<RoomGuest[]>([]);
  rosterRef.current = roster;
  const endpointRef = useRef<string | null>(null);
  // Which guests the auto-layout last arranged. The tick may not re-flow an
  // unchanged set: the host dragging a guest smaller must WIN — auto-layout
  // exists for joins/leaves, not as a 3-second undo of manual placement.
  const guestLayoutRef = useRef<string | null>(null);
  // Last stage list we told the server about (sorted, joined). The tick runs
  // every 3s but the stage rarely changes — an unchanged list is not news.
  const stagePostedRef = useRef<string | null>(null);

  /** Bring a guest on or off screen with a dissolve rather than a cut.
   * Guests appear and vanish while the show is LIVE, so a hard pop is visible
   * to the audience — and we already have the opacity path the fade
   * transition uses. Audio moves with the picture. */
  const fadeGuest = (id: string, show: boolean, ms = 260) => {
    if (show) {
      setOpacity(id, 0).catch(() => {});
      ipc.liveSetTransform(id, { visible: true }, true).catch(() => {});
      setSourceAudio(id, undefined, false).catch(() => {});
    } else {
      // Mute immediately on the way out — a voice lingering over a dissolve
      // is worse than a cut.
      setSourceAudio(id, undefined, true).catch(() => {});
    }
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      setOpacity(id, show ? k : 1 - k).catch(() => {});
      if (k < 1) {
        requestAnimationFrame(step);
        return;
      }
      if (!show) {
        ipc.liveSetTransform(id, { visible: false }, true).catch(() => {});
        // Leave them at full opacity so the next show starts from a known
        // state rather than inheriting a transparent source.
        setOpacity(id, 1).catch(() => {});
      }
    };
    requestAnimationFrame(step);
  };

  const admitGuest = async (id: string) => {
    if (!endpointRef.current || !cfg.server_room_id) return;
    // The guest's return video IS the virtual camera — the render page opens
    // it as a capture device and sends it down the peer connection it already
    // holds. Start it on admit so nobody discovers it was off after someone
    // is already talking into oblivion.
    if (!vcamOn && vcamState?.installed) {
      await vcamIpc.output(true).catch(() => {});
    }
    await guestsIpc.admit(endpointRef.current, cfg.server_room_id, id).catch((e) =>
      setGuestErr(String(e).replace(/^Error:\s*/, "")),
    );
  };

  const removeGuest = async (id: string) => {
    if (!endpointRef.current || !cfg.server_room_id) return;
    await guestsIpc.revoke(endpointRef.current, id).catch(() => {});
  };

  /** Mint (or reuse) the room's shareable link. */
  const ensureGuestLink = async () => {
    if (guestLink) return guestLink;
    try {
      const eps = await ipc.listEndpoints();
      const ep = eps.find((e) => e.kind === "connected") ?? eps[0];
      if (!ep) throw new Error("Connect a Boomin workspace first.");
      let sid = cfg.server_room_id;
      if (!sid) {
        const reg = await registerRoom(ep.id, room?.name ?? "Room", room?.id ?? "");
        sid = reg.room.id;
        writeCfg({ ...cfgRef.current, server_room_id: sid });
      }
      const res = await guestsIpc.joinLink(ep.id, sid!);
      const url = res.join_url ?? res.url ?? null;
      if (url) {
        setGuestLink(url);
        writeCfg({ ...cfgRef.current, guest_link: url });
      }
      return url;
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
      return null;
    }
  };

  const [srcSettings, setSrcSettings] = useState<string | null>(null);
  /** Which scene's settings strip is open — same grammar as sources. */
  const [sceneSettings, setSceneSettings] = useState<string | null>(null);
  /** Which source's filter chain the Sources panel is drilled into. */
  const [filterFor, setFilterFor] = useState<{ id: string; label: string; media: "video" | "audio" } | null>(null);
  /** Mini-editor popover for adding an open-list source. */
  const [srcSubPop, setSrcSubPop] = useState<"text" | "color" | "window" | null>(null);

  /** Add an open-list item and record it in the room document so it
   * respawns when the room reopens. */
  const addExtraSource = async (label: string, spec: ExtraSpec, inviteUrl?: string) => {
    const id = `${spec.kind}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await extraSources.add(id, label, spec);
      // A guest invite link is issued ONCE and never reissued, so it lives on
      // the room document rather than only in the dialog that created it.
      const entry: RoomExtra = {
        id,
        label,
        spec,
        ...(inviteUrl ? { invite_url: inviteUrl } : {}),
      };
      const c = cfgRef.current;
      writeCfg({ ...c, sources: { ...c.sources, extras: [...(c.sources.extras ?? []), entry] } });
    } catch (e) {
      setBanner(String(e));
    }
  };

  /** Re-point a window item at a different window: replaced in place under
   * the same id, and the room document follows so it respawns correctly. */
  const replaceWindowSource = async (itemId: string, windowId: number, label: string) => {
    try {
      await extraSources.remove(itemId);
      await extraSources.add(itemId, label, { kind: "window", window: windowId });
      const c = cfgRef.current;
      writeCfg({
        ...c,
        sources: {
          ...c.sources,
          extras: (c.sources.extras ?? []).map((e) =>
            e.id === itemId ? { ...e, label, spec: { kind: "window" as const, window: windowId } } : e,
          ),
        },
      });
    } catch (e) {
      setBanner(String(e));
    }
  };

  const removeExtraSource = (id: string) => {
    extraSources.remove(id).catch(() => {});
    const c = cfgRef.current;
    writeCfg({
      ...c,
      sources: { ...c.sources, extras: (c.sources.extras ?? []).filter((e) => e.id !== id) },
    });
  };
  const [chatNames, setChatNames] = useState<ChatNames>(loadChatNames);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatLive = chatConns.some((c) => c.connected);

  // Never trust the shape coming back across IPC: a stub, an older host, or
  // a failed call must not be able to blank the room.
  const refreshChat = useCallback(
    () =>
      chatIpc
        .status()
        .then((c) => setChatConns(Array.isArray(c) ? c : []))
        .catch(() => setChatConns([])),
    [],
  );

  // Real chat: host-side readers emit here. Demo chatter yields the moment a
  // real socket joins, so fake lines never mix with real ones.
  useEffect(() => {
    let stop: (() => void) | null = null;
    listenChat((ev) => {
      if (ev.type === "message") {
        setChatMsgs((m) => [
          // Trimming from the top while someone is reading back yanks the
          // content out from under them; hold the backlog until they return.
          ...(chatPinnedRef.current ? m.slice(-199) : m.slice(-1999)),
          {
            platform: ev.msg.platform,
            user: ev.msg.user,
            text: ev.msg.text,
            color: ev.msg.color,
            emotes: ev.msg.emotes,
          },
        ]);
      } else if (ev.type === "emote_set") {
        setChannelEmotes((prev) => ({ ...prev, ...ev.emotes }));
      } else if (ev.type === "connected") {
        setChatError(null);
        refreshChat();
      } else if (ev.type === "disconnected") {
        if (ev.reason) setChatError(ev.reason);
        refreshChat();
      }
    })
      .then((un) => {
        stop = un;
      })
      .catch(() => {});
    refreshChat();
    return () => stop?.();
  }, [refreshChat]);

  const connectChat = useCallback(async (names: ChatNames) => {
    setChatError(null);
    saveChatNames(names);
    setChatNames(names);
    for (const platform of ["twitch", "kick", "youtube"] as const) {
      const name = names[platform].trim();
      if (!name) {
        chatIpc.disconnect(platform).catch(() => {});
        continue;
      }
      try {
        if (platform === "kick") {
          let id = loadKickChatroom(name);
          if (!id) {
            id = await chatIpc.resolveKickChatroom(name);
            saveKickChatroom(name, id);
          }
          await chatIpc.connect("kick", name, id);
        } else {
          // Twitch takes a login name; YouTube takes a handle or channel id.
          await chatIpc.connect(platform, name);
        }
      } catch (e) {
        setChatError(String(e));
      }
    }
    refreshChat();
  }, [refreshChat]);

  // Rejoin saved channels when the room opens.
  const chatAutoConnected = useRef(false);
  useEffect(() => {
    if (chatAutoConnected.current) return;
    chatAutoConnected.current = true;
    if (chatNames.twitch || chatNames.kick) connectChat(chatNames);
  }, [chatNames, connectChat]);

  // Demo liveness: the chat keeps talking.
  useEffect(() => {
    if (!demo || chatLive) return;
    let i = 0;
    const t = setInterval(
      () => {
        setChatMsgs((m) => [...m.slice(-59), DEMO_CHAT[(9 + i++) % DEMO_CHAT.length]]);
      },
      3800 + Math.random() * 2400,
    );
    return () => clearInterval(t);
  }, [demo, chatLive]);

  useEffect(() => {
    if (chatPinnedRef.current) {
      // Instant, never smooth: an in-flight smooth animation keeps firing
      // scroll events and hauls the reader back down the moment they try to
      // scroll up.
      const el = chatList.current;
      if (el) el.scrollTop = el.scrollHeight;
      setChatBehind(0);
    } else {
      setChatBehind((n) => n + 1);
    }
  }, [chatMsgs]);

  /** Within a few px of the bottom counts as pinned — the browser's own
   * smooth scrolling never lands exactly on zero. */
  const onChatScroll = () => {
    const el = chatList.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== chatPinnedRef.current) {
      chatPinnedRef.current = atBottom;
      setChatPinned(atBottom);
    }
    if (atBottom) setChatBehind(0);
  };

  /** Any upward wheel gesture means "I'm reading" — unpin at once. */
  const onChatWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0 && chatPinnedRef.current) {
      chatPinnedRef.current = false;
      setChatPinned(false);
    }
  };

  const jumpToLatest = () => {
    chatPinnedRef.current = true;
    setChatPinned(true);
    setChatBehind(0);
    const el = chatList.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
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
      const saved = parseConfig(room.config).sources;
      if (typeof saved.screen === "boolean") {
        await ipc.liveSetSources(saved.screen, saved.camera ?? false, saved.mic ?? false);
        if (saved.mic_volume != null || saved.mic_muted != null) {
          await ipc.liveSetMicAudio({ volume: saved.mic_volume, muted: saved.mic_muted });
        }
        if (saved.overlay_window != null || saved.overlay_url) {
          await ipc.liveSetOverlay(saved.overlay_window ?? null, true, saved.overlay_url ?? null);
        }
        setSources((s) => ({ ...s, ...saved }));
      }
      // Item-list half of the document: clear whatever open-list items the
      // engine is holding from the previous room, then respawn this room's.
      const held = (snap.sources?.items ?? []).filter(
        (i) => !["screen", "camera", "overlay"].includes(i.id),
      );
      for (const i of held) {
        await extraSources.remove(i.id).catch(() => {});
      }
      for (const e of saved.extras ?? []) {
        await extraSources.add(e.id, e.label, e.spec).catch(() => {});
      }
      const mount = parseConfig(room.config).active_scene;
      if (mount) setPendingScene(mount);
      // Warm the stinger the room already uses, so the first cut is instant.
      const cfgNow = parseConfig(room.config);
      const firstStinger =
        cfgNow.transition?.stinger ?? cfgNow.scenes.find((x) => x.transition?.stinger)?.transition?.stinger;
      if (firstStinger) stingerIpc.prepare(firstStinger).catch(() => {});
    }
    // Stored video settings (global, OBS-style) re-apply when idle.
    if (!videoApplied.current && snap.engine_ready && snap.session_state === "idle") {
      videoApplied.current = true;
      try {
        const stored = JSON.parse(localStorage.getItem("producer.video") ?? "null") as {
          h: number;
          f: number;
        } | null;
        if (stored && (stored.h !== (snap.video_height || 720) || stored.f !== (snap.video_fps || 30))) {
          await ipc.liveSetVideo(stored.h, stored.f);
        }
      } catch {
        /* bad stored value — engine default stands */
      }
    }
    // Channel selection from the room document → engine flags.
    if (!channelsApplied.current && room) {
      channelsApplied.current = true;
      const want = parseConfig(room.config).channels;
      if (Object.keys(want).length) {
        for (const d of await ipc.liveListDestinations()) {
          const target = want[d.id];
          if (typeof target === "boolean" && target !== d.enabled) {
            await ipc
              .liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, enabled: target })
              .catch(() => {});
          }
        }
        setDestinations(await ipc.liveListDestinations());
      }
    }
    // Demo mode: put real gameplay footage on the canvas via the CEF
    // browser source, so the room never demos black.
    if (
      demo &&
      !demoVideoSet.current &&
      snap.engine_ready &&
      snap.bootstrap_ok &&
      snap.session_state === "idle" &&
      snap.sources &&
      snap.sources.overlay_window == null &&
      !snap.sources.overlay_url
    ) {
      demoVideoSet.current = true;
      ipc.liveSetOverlay(null, false, DEMO_VIDEO_URL).catch(() => {});
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
        markLiveRoom(null);
        setStatuses(new Map(ev.report.destinations.map((d) => [d.id, d])));
        if (!ev.report.ok && ev.report.notes.length > 0) setBanner(ev.report.notes.join(" · "));
      } else if (ev.type === "sources_changed") {
        setSources(ev.sources);
        // The room document follows the scene, without disturbing the rest
        // of the document (layout, scenes, channels).
        if (roomId) {
          // The engine owns screen/camera/mic/items/devices, but `extras` is
          // OURS — the open-list items and, for guests, their once-only invite
          // link. Assigning ev.sources wholesale deleted them on every source
          // change, which is why guests didn't survive a reopen.
          const next = {
            ...cfgRef.current,
            sources: { ...ev.sources, extras: cfgRef.current.sources.extras },
          };
          cfgRef.current = next;
          setCfgState(next);
          ipc.liveUpdateRoom(roomId, { config: serializeConfig(next) }).catch(() => {});
        }
      } else if (ev.type === "video_changed") {
        setSnapshot((s) => (s ? { ...s, video_height: ev.height, video_fps: ev.fps } : s));
      } else if (ev.type === "levels") {
        // peak → dB → 0..1 over a 50dB window, with a falling ballistic.
        const db = ev.mic_peak > 0.00001 ? 20 * Math.log10(ev.mic_peak) : -60;
        const pct = Math.max(0, Math.min(1, (db + 50) / 50));
        setMicLevel((prev) => Math.max(pct, prev * 0.78));
        if (ev.extra_peaks?.length) {
          setExtraLevels((prev) => {
            const next = { ...prev };
            for (const p of ev.extra_peaks) {
              const db = p.peak > 0.00001 ? 20 * Math.log10(p.peak) : -60;
              const pctX = Math.max(0, Math.min(1, (db + 50) / 50));
              next[p.id] = Math.max(pctX, (prev[p.id] ?? 0) * 0.78);
            }
            return next;
          });
        }
      } else if (ev.type === "guest_thumbs") {
        // Already JPEG from the engine — a data URL is all the UI needs.
        const next: Record<string, string> = {};
        for (const t of ev.thumbs) next[t.id] = `data:image/jpeg;base64,${t.jpeg}`;
        setGuestThumbs((prev) => ({ ...prev, ...next }));
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

  snapRef.current = snapshot;
  const state = snapshot?.session_state ?? "idle";
  const streaming = state === "streaming" || state === "starting" || state === "stopping";

  // OBS's network-quality model, followed exactly (OBSBasicStatusBar.cpp):
  // congestion is smoothed toward the worse of the last two samples, then
  // averaged over 4 seconds, then bucketed at 0 / 0.3333 / 0.6667 / 1.0.
  // Averaging matters — raw congestion spikes constantly and an unsmoothed
  // indicator would flicker between "excellent" and "bad" every second.
  const congestionNow = Math.max(
    0,
    Math.min(1, [...statuses.values()].reduce((m, st) => Math.max(m, st.congestion), 0)),
  );
  const congHistory = useRef<number[]>([]);
  const [congAvg, setCongAvg] = useState(0);
  const lastCong = useRef(0);
  useEffect(() => {
    if (!streaming) {
      congHistory.current = [];
      lastCong.current = 0;
      setCongAvg(0);
      return;
    }
    const smoothed = Math.max(congestionNow, (congestionNow + lastCong.current) * 0.5);
    lastCong.current = congestionNow;
    const h = congHistory.current;
    h.push(smoothed);
    if (h.length >= 4) {
      setCongAvg(h.reduce((a, b) => a + b, 0) / h.length);
      congHistory.current = [];
    }
  }, [congestionNow, streaming, elapsed]);

  const quality: "excellent" | "good" | "mediocre" | "bad" | "off" = !streaming
    ? "off"
    : congAvg <= 0.0001
      ? "excellent"
      : congAvg <= 0.3333
        ? "good"
        : congAvg <= 0.6667
          ? "mediocre"
          : "bad";
  const droppedPct =
    droppedTotal > 0
      ? [...statuses.values()].reduce((n, st) => n + st.total_frames, 0) > 0
        ? (droppedTotal /
            [...statuses.values()].reduce((n, st) => n + st.total_frames, 0)) *
          100
        : 0
      : 0;

  const engineOk = snapshot?.engine_ready && snapshot?.bootstrap_ok;
  useEffect(() => {
    const t = window.setInterval(() => {
      loadHist.current.push(snapRef.current?.cpu ?? 0);
      if (loadHist.current.length > 60) loadHist.current.shift();
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!engineOk || !sceneSettled || !mountVeil) return;
    // A beat of settle time: lifting mid-populate trades one flicker for
    // another.
    const t = window.setTimeout(() => setMountVeil(false), 350);
    return () => window.clearTimeout(t);
  }, [engineOk, sceneSettled, mountVeil]);
  // Hard cap: a wedged step may never trap the user behind the veil.
  useEffect(() => {
    const t = window.setTimeout(() => setMountVeil(false), 8000);
    return () => window.clearTimeout(t);
  }, []);

  /** Channel selection is part of the room document; opening a room pushes
   * it to the engine's destination flags so go-live stays honest. */
  async function toggleEnabled(d: LiveDestination) {
    writeCfg({ ...cfg, channels: { ...cfg.channels, [d.id]: !d.enabled } });
    await ipc.liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, enabled: !d.enabled });
    refresh();
  }

  async function goLive() {
    setBanner(null);
    try {
      await ipc.liveGoLive();
      if (roomId) {
        ipc.liveUpdateRoom(roomId, { touchLive: true }).catch(() => {});
        markLiveRoom(roomId);
      }
    } catch (e) {
      setBanner(String(e));
    }
  }

  async function setSrc(patch: Partial<Pick<LiveSources, "screen" | "camera" | "mic">>) {
    const next = { ...sources, ...patch };
    setSources(next);
    try {
      await ipc.liveSetSources(next.screen, next.camera, next.mic);
    } catch (e) {
      setBanner(String(e));
    }
  }

  const overlayActive = sources.overlay_window != null || !!sources.overlay_url;
  const enabledDests = destinations.filter((d) => d.enabled);

  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  /** Scene to mount into once the engine is ready (set when the room's
   * document is applied on open). */
  const [pendingScene, setPendingScene] = useState<string | null>(null);
  // Legacy fallback so a room saved before looks existed still highlights.
  const activeScene =
    activeSceneId ?? scenes.find((p) => p.screen === sources.screen && p.camera === sources.camera)?.id;

  /** Apply a scene as a LOOK: sources are never created or destroyed on a
   * switch (no flicker, no permission re-prompts, no z scramble) — only
   * visibility, geometry and stacking change, through the same transform
   * pipeline the stage editor uses. Missing well-known sources the scene
   * needs are created once; nothing is ever torn down. */
  const applyScene = async (p: RoomScene) => {
    if (!engineOk) return;
    try {
      const bh = snapshot?.video_height || 720;
      const bw = (bh * 16) / 9;
      const look = p.look && Object.keys(p.look).length ? p.look : builtinLook(p, bw, bh);
      const needScreen = look.screen?.visible ?? false;
      const needCamera = look.camera?.visible ?? false;
      if ((needScreen && !sources.screen) || (needCamera && !sources.camera)) {
        await ipc.liveSetSources(sources.screen || needScreen, sources.camera || needCamera, sources.mic);
      }
      // Only address items that actually exist (or were just created) — a
      // transform on a missing id is an engine error, not a no-op.
      const exists = new Set([
        ...(sources.items ?? []).map((i) => i.id),
        ...(sources.screen || needScreen ? ["screen"] : []),
        ...(sources.camera || needCamera ? ["camera"] : []),
        ...(overlayActive ? ["overlay"] : []),
      ]);
      const entries = Object.entries(look).filter(([id]) => exists.has(id));
      // Hidden first (plain visibility flips), then visible bottom-to-top so
      // z-order lands exactly as the scene says.
      for (const [id, l] of entries.filter(([, l]) => !l.visible)) {
        void l;
        ipc.liveSetTransform(id, { visible: false }, true).catch(() => {});
      }
      const visible = entries
        .filter(([, l]) => l.visible)
        .sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));

      const tr = p.transition ?? cfgRef.current.transition ?? { kind: "cut" as const };

      // Stinger: the clip covers the stage, the scene changes UNDERNEATH it
      // at the halfway point, and the clip plays out to reveal the result.
      // The cut is never seen — that's the whole trick.
      if (tr.kind === "stinger" && tr.stinger) {
        const applyLook = () => {
          const vis = entries
            .filter(([, l]) => l.visible)
            .sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));
          for (const [id, l] of entries.filter(([, l]) => !l.visible)) {
            void l;
            ipc.liveSetTransform(id, { visible: false }, true).catch(() => {});
          }
          vis.forEach(([id, l], i) => {
            const patch: LiveTransformPatch = { visible: true, z: i };
            if (l.x != null && l.y != null && l.w != null && l.h != null) {
              patch.x = l.x;
              patch.y = l.y;
              patch.w = l.w;
              patch.h = l.h;
            }
            ipc.liveSetTransform(id, patch, true).catch(() => {});
          });
        };
        setActiveSceneId(p.id);
        writeCfg({ ...cfgRef.current, active_scene: p.id });
        try {
          const reported = await stingerIpc.play(tr.stinger);
          const total = reported > 0 ? reported : (tr.ms ?? 1200);
          window.setTimeout(applyLook, Math.round(total / 2));
          window.setTimeout(() => stingerIpc.stop().catch(() => {}), total + 120);
        } catch (e) {
          // A missing or unreadable clip must never cost the switch itself —
          // and must never be left covering the stage.
          setBanner(String(e));
          window.setTimeout(() => setBanner(null), 2600);
          stingerIpc.stop().catch(() => {});
          applyLook();
        }
        return;
      }

      // `move` glides items from where they are into where the scene wants
      // them — the same transform pipeline, just walked over time. Only
      // possible because scenes are looks over one graph.
      const animate = (tr.kind === "move" || tr.kind === "fade") && !!sources.items?.length;
      const dur = Math.max(80, Math.min(2000, tr.ms ?? 320));

      if (!animate) {
        visible.forEach(([id, l], i) => {
          const patch: LiveTransformPatch = { visible: true, z: i };
          if (l.x != null && l.y != null && l.w != null && l.h != null) {
            patch.x = l.x;
            patch.y = l.y;
            patch.w = l.w;
            patch.h = l.h;
          }
          ipc.liveSetTransform(id, patch, true).catch(() => {});
        });
      } else {
        const from = new Map((sources.items ?? []).map((it) => [it.id, it]));

        if (tr.kind === "fade") {
          // Items that stay simply stay — only what enters or leaves
          // dissolves. Anything that MOVES is `move`'s job, and the two can
          // be combined by picking one per scene.
          const leaving = entries.filter(([, l]) => !l.visible).map(([id]) => id);
          const arriving = visible
            .map(([id]) => id)
            .filter((id) => !(from.get(id)?.visible ?? false));
          // Arriving items start transparent, then become visible so the
          // first frame drawn is already at zero rather than a hard pop.
          for (const id of arriving) {
            setOpacity(id, 0).catch(() => {});
            ipc.liveSetTransform(id, { visible: true }, false).catch(() => {});
          }
          visible.forEach(([id, l], i) => {
            const patch: LiveTransformPatch = { visible: true, z: i };
            if (l.x != null && l.y != null && l.w != null && l.h != null) {
              patch.x = l.x;
              patch.y = l.y;
              patch.w = l.w;
              patch.h = l.h;
            }
            ipc.liveSetTransform(id, patch, false).catch(() => {});
          });
          const t0f = performance.now();
          const stepFade = () => {
            const k = Math.min(1, (performance.now() - t0f) / dur);
            for (const id of arriving) setOpacity(id, k).catch(() => {});
            for (const id of leaving) setOpacity(id, 1 - k).catch(() => {});
            if (k < 1) {
              requestAnimationFrame(stepFade);
              return;
            }
            // Settle: hide what left and restore its opacity, so the next
            // scene that shows it doesn't inherit a transparent source.
            for (const id of leaving) {
              ipc.liveSetTransform(id, { visible: false }, true).catch(() => {});
              setOpacity(id, 1).catch(() => {});
            }
            visible.forEach(([id], i) => {
              setOpacity(id, 1).catch(() => {});
              ipc.liveSetTransform(id, { visible: true, z: i }, true).catch(() => {});
            });
          };
          requestAnimationFrame(stepFade);
          setActiveSceneId(p.id);
          writeCfg({ ...cfgRef.current, active_scene: p.id });
          return;
        }

        // Make everything visible and correctly stacked up front, then move.
        visible.forEach(([id], i) => {
          ipc.liveSetTransform(id, { visible: true, z: i }, false).catch(() => {});
        });
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / dur);
          // ease-out cubic: quick off the mark, settles gently
          const e = 1 - Math.pow(1 - k, 3);
          const done = k >= 1;
          visible.forEach(([id, l], i) => {
            const a = from.get(id);
            if (!a || l.x == null || l.y == null || l.w == null || l.h == null) {
              if (done) ipc.liveSetTransform(id, { visible: true, z: i }, true).catch(() => {});
              return;
            }
            ipc
              .liveSetTransform(
                id,
                {
                  visible: true,
                  z: i,
                  x: a.x + (l.x - a.x) * e,
                  y: a.y + (l.y - a.y) * e,
                  w: a.w + (l.w - a.w) * e,
                  h: a.h + (l.h - a.h) * e,
                },
                done,
              )
              .catch(() => {});
          });
          if (!done) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      setActiveSceneId(p.id);
      const c = cfgRef.current;
      writeCfg({ ...c, active_scene: p.id });
    } catch (e) {
      setBanner(String(e));
    }
  };

  const addScene = () => {
    const n = scenes.length + 1;
    // Save the CURRENT look, extras included — the scene is a snapshot of
    // the whole stage, not just which slots are on.
    const look: Record<string, SceneItemLook> = Object.fromEntries(
      (sources.items ?? []).map((i) => [
        i.id,
        { visible: i.visible, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z },
      ]),
    );
    const next: RoomScene = {
      id: `s${Date.now().toString(36)}`,
      name: `Scene ${n}`,
      screen: sources.screen,
      camera: sources.camera,
      look,
    };
    writeCfg({ ...cfg, scenes: [...scenes, next] });
    setActiveSceneId(next.id);
  };

  const removeScene = (id: string) => writeCfg({ ...cfg, scenes: scenes.filter((s) => s.id !== id) });

  /** Re-record a scene from what's on the stage right now. Without this, a
   * built-in look can never be corrected — you'd fix the stage, switch away,
   * and the old recipe would undo you every time. */
  const updateScene = (id: string) => {
    const look: Record<string, SceneItemLook> = Object.fromEntries(
      (sources.items ?? []).map((i) => [
        i.id,
        { visible: i.visible, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z },
      ]),
    );
    const base = cfgRef.current;
    writeCfg({
      ...base,
      scenes: (base.scenes.length ? base.scenes : DEFAULT_SCENES).map((x) =>
        x.id === id ? { ...x, look, screen: sources.screen, camera: sources.camera } : x,
      ),
    });
    setBanner("Scene updated to the current stage.");
    window.setTimeout(() => setBanner(null), 2200);
  };

  /** What a scene will actually do: its own override, else the room default,
   * else a plain cut. */
  const transitionFor = (sc: RoomScene | null): SceneTransition =>
    sc?.transition ?? cfg.transition ?? { kind: "cut" };

  /** Write a transition: a scene id overrides that scene, null sets the
   * room default every scene inherits. */
  const setTransition = (sceneId: string | null, t: SceneTransition | undefined) => {
    const c = cfgRef.current;
    if (sceneId === null) {
      writeCfg({ ...c, transition: t });
    } else {
      writeCfg({
        ...c,
        scenes: (c.scenes.length ? c.scenes : DEFAULT_SCENES).map((x) =>
          x.id === sceneId ? { ...x, transition: t } : x,
        ),
      });
    }
  };

  const [renamingScene, setRenamingScene] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const commitRename = () => {
    const id = renamingScene;
    setRenamingScene(null);
    const name = renameDraft.trim();
    if (!id || !name) return;
    writeCfg({ ...cfg, scenes: scenes.map((x) => (x.id === id ? { ...x, name } : x)) });
  };

  // R1: ⌘1–⌘9 cut to a scene. The rows have advertised these since the
  // first build with nothing listening. Ignored while typing so chat and
  // rename fields keep their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const sc = scenes[n - 1];
      if (!sc) return;
      e.preventDefault();
      applyScene(sc);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Where a guest sits on stage, given how many are on. One fills the frame,
   * two split it, three or four make a grid — recomputed whenever the roster
   * changes so joining or leaving re-flows the panel. */
  const guestSlot = useCallback(
    (index: number, total: number, bw: number, bh: number) => {
      if (total <= 1) return { x: 0, y: 0, w: bw, h: bh };
      if (total === 2) {
        const w = bw / 2;
        return { x: index * w, y: 0, w, h: bh };
      }
      const cols = 2;
      const rows = 2;
      const w = bw / cols;
      const h = bh / rows;
      return { x: (index % cols) * w, y: Math.floor(index / cols) * h, w, h };
    },
    [],
  );

  // Poll the roster and reconcile browser sources against it.
  useEffect(() => {
    if (!room?.id || !cfg.server_room_id) return;
    let alive = true;
    const tick = async () => {
      try {
        if (!endpointRef.current) {
          const eps = await ipc.listEndpoints();
          const ep = eps.find((e) => e.kind === "connected") ?? eps[0];
          if (!ep) return;
          endpointRef.current = ep.id;
        }
        const res = await guestsIpc.roster(endpointRef.current, cfg.server_room_id!);
        if (!alive) return;
        const list = res.guests ?? [];
        setRoster(list);
        setGuestErr(null);

        // Only guests the host has admitted get a source. A waiting guest is
        // deliberately NOT on the broadcast: the room link is public, so
        // auto-admitting would put an unknown person on air with a name they
        // chose themselves.
        const live = list.filter((g) => !!g.render_url);
        const present = new Set(
          (sources.items ?? []).filter((i) => i.kind === "guest").map((i) => i.id),
        );
        const wanted = new Map(live.map((g) => [`guest-${g.id.slice(0, 8)}`, g]));

        for (const [id, g] of wanted) {
          if (!present.has(id)) {
            // &program= names the virtual camera so the page captures the
            // SHOW rather than guessing at a device; &mic= does the same for
            // the host's microphone. Both are labels, because a browser's
            // deviceIds are salted per origin and can never match ours.
            const u = new URL(g.render_url!);
            if (micDeviceLabel) u.searchParams.set("mic", micDeviceLabel);
            u.searchParams.set("program", "Producer Virtual Camera");
            await extraSources
              .add(id, g.display_name || "Guest", { kind: "guest", url: u.toString() })
              .catch(() => {});
            // Hidden-at-birth is the engine's job (see add_extra): sending a
            // follow-up hide raced the creation and errored with "no item".
          }
        }
        for (const id of present) {
          if (!wanted.has(id)) {
            // Someone whose laptop died shouldn't blink off the broadcast.
            // Fade first, then destroy — and only if they were on screen.
            const it = (sources.items ?? []).find((i) => i.id === id);
            if (it?.visible) {
              fadeGuest(id, false);
              window.setTimeout(() => extraSources.remove(id).catch(() => {}), 320);
            } else {
              await extraSources.remove(id).catch(() => {});
            }
          }
        }

        // Re-flow the panel to match the current count.
        const bh = snapshot?.video_height || 720;
        const bw = (bh * 16) / 9;
        // Only guests actually on screen get a slot, and layout NEVER flips
        // visibility — otherwise arranging the grid would quietly put someone
        // on air.
        const shown = (sources.items ?? []).filter((i) => i.kind === "guest" && i.visible);
        const layoutKey = shown.map((i) => i.id).sort().join(",");
        if (layoutKey !== guestLayoutRef.current) {
          guestLayoutRef.current = layoutKey;
          shown.forEach((it, i) => {
            const r = guestSlot(i, shown.length, bw, bh);
            ipc.liveSetTransform(it.id, r, true).catch(() => {});
          });
        }

        // Tell the server who is on stage — the FULL list, on registration and
        // on every change. Source ids are `guest-<uuid8>`, so map back through
        // the roster rather than un-truncating. Fire-and-forget: the server
        // list is a cache for reconnecting guests, never read back here —
        // scene-item visibility in the engine stays the only truth.
        const stageIds = shown
          .map((it) => live.find((g) => `guest-${g.id.slice(0, 8)}` === it.id)?.id)
          .filter((id): id is string => !!id)
          .sort();
        const stageKey = stageIds.join(",");
        if (stageKey !== stagePostedRef.current && endpointRef.current && cfg.server_room_id) {
          stagePostedRef.current = stageKey;
          guestsIpc
            .setStage(endpointRef.current, cfg.server_room_id, stageIds)
            .catch(() => {
              // Retry on the next tick rather than losing the change.
              stagePostedRef.current = null;
            });
        }
      } catch (e) {
        if (alive) setGuestErr(String(e).replace(/^Error:\s*/, ""));
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [room?.id, cfg.server_room_id, sources.items, snapshot?.video_height, guestSlot]);

  // Mount the room into its saved scene once the engine can take it.
  useEffect(() => {
    if (!engineOk) return;
    if (!pendingScene) {
      setSceneSettled(true);
      return;
    }
    const sc = scenes.find((x) => x.id === pendingScene);
    setPendingScene(null);
    void (async () => {
      if (sc) await applyScene(sc);
      // The apply's transforms land engine-side just after the awaits;
      // half a beat covers the tail of the animation frames.
      window.setTimeout(() => setSceneSettled(true), 500);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScene, engineOk]);


  const setVolume = (v: number) => {
    setSources((s) => ({ ...s, mic_volume: v }));
    ipc.liveSetMicAudio({ volume: v }).catch((e) => setBanner(String(e)));
  };
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const saveChannelKey = async (d: LiveDestination) => {
    try {
      await ipc.liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, key: keyVal, enabled: d.enabled });
      setDestinations(await ipc.liveListDestinations());
      setKeyFor(null);
      setKeyVal("");
    } catch (e) {
      setBanner(String(e));
    }
  };
  const toggleMute = () => {
    const m = !(sources.mic_muted ?? false);
    setSources((s) => ({ ...s, mic_muted: m }));
    ipc.liveSetMicAudio({ muted: m }).catch((e) => setBanner(String(e)));
  };

  const vh = snapshot?.video_height || 720;
  const vf = snapshot?.video_fps || 30;
  async function setVideoCfg(h: number, f: number) {
    try {
      await ipc.liveSetVideo(h, f);
      localStorage.setItem("producer.video", JSON.stringify({ h, f }));
    } catch (e) {
      setBanner(String(e));
    }
  }

  const closePops = () => {
    setDestsOpen(false);
    setQualityOpen(false);
    setPanelMenu(null);
    setLayoutMenu(false);
    setAddMenu(null);
    setMicPopOpen(false);
    setOverlayOpen(false);
    setChatOpen(false);
    setSrcAddOpen(false);
    setDeviceMenu(null);
    setSrcSubPop(null);
    setSceneSettings(null);
  };
  const anyPop =
    destsOpen || qualityOpen || micPopOpen || overlayOpen || chatOpen || srcAddOpen || deviceMenu !== null || srcSubPop !== null ||
    (sceneSettings !== null && dockOf(layout, "scenes") !== "bottom") || panelMenu !== null || layoutMenu || addMenu !== null || adding || !!editing;

  const micStrip = (
    <MeterStrip
      horizontal={dockOf(layout, "mixer") === "top"}
      label="Mic"
      icon={ic.mic}
      level={micLevel}
      volume={sources.mic_volume ?? 1}
      muted={sources.mic_muted ?? false}
      disabled={!sources.mic}
      onVolume={setVolume}
      onMute={toggleMute}
      onToggle={() => setSrc({ mic: !sources.mic })}
      onFilters={() => {
        // The mic's chain lives in the Sources panel navigator; make sure
        // that panel is actually visible before sending them there.
        if (dockOf(layout, "sources") === "hidden") {
          setLayout(movePanel(layout, "sources", dockOf(layout, "mixer")));
        }
        setFilterFor({ id: "mic", label: "Microphone", media: "audio" });
      }}
    />
  );


  // ── Panels: everything that isn't the stage is a dockable panel ────────
  const panelBody = (id: PanelId) => {
    switch (id) {
      case "scenes":
        return (
          <div className="rm-scenes">
            {scenes.map((p, i) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                className={`rm-scene-row${activeScene === p.id ? " active" : ""}${activeScene === p.id && streaming ? " onair" : ""}`}
                onClick={() => applyScene(p)}
                onKeyDown={(e) => e.key === "Enter" && applyScene(p)}
              >
                <span className="rm-scene-icon">{ic.screen}</span>
                {/* What this scene will do on air, dimmed so the name still
                 * leads. Only shown when it isn't a plain cut. */}
                {transitionFor(p).kind !== "cut" && (
                  <span className="rm-scene-tr">
                    {transitionFor(p).kind === "move"
                      ? "Move"
                      : transitionFor(p).kind === "fade"
                        ? "Fade"
                        : "Stinger"}
                  </span>
                )}
                {renamingScene === p.id ? (
                  <input
                    className="rm-scene-rename"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingScene(null);
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <span
                    className="rm-scene-name"
                    title="Double-click to rename"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenamingScene(p.id);
                      setRenameDraft(p.name);
                    }}
                  >
                    {p.name}
                  </span>
                )}
                {activeScene === p.id ? (
                  <>
                    <span className="rm-scene-live">{streaming ? "Live" : "On"}</span>
                    <span className="rm-scene-rec" />
                  </>
                ) : (
                  <>
                    <button
                      className={`rm-scene-gear${sceneSettings === p.id ? " on" : ""}`}
                      title="Scene settings"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPopAnchor(e.currentTarget);
                        setSceneSettings((k) => (k === p.id ? null : p.id));
                      }}
                    >
                      {ic.gear}
                    </button>
                    <span className="rm-scene-key">{i < 9 ? `⌘${i + 1}` : ""}</span>
                    {!DEFAULT_SCENES.some((d) => d.id === p.id) && (
                      <button
                        className="rm-scene-x"
                        title="Remove scene"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeScene(p.id);
                        }}
                      >
                        {ic.x}
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        );
      case "chat":
        return (
          <>
            <div className="rm-chat-chips">
              {(["all", "twitch", "kick", "youtube"] as const).map((p) => (
                <button
                  key={p}
                  className={`rm-chat-chip${chatFilter === p ? " on" : ""}`}
                  onClick={() => setChatFilter(p)}
                >
                  {p === "all" ? "All" : p === "youtube" ? "YouTube" : p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <div className="rm-chat-list" ref={chatList} onScroll={onChatScroll} onWheel={onChatWheel}>
              {chatMsgs
                .filter((m) => chatFilter === "all" || m.platform === chatFilter)
                .map((m, i) => (
                  <div key={i} className="rm-chat-msg">
                    <span
                      className="rm-chat-user"
                      style={{ color: m.color || PLATFORM_TINT[m.platform as DemoPlatform] }}
                    >
                      {m.user}
                    </span>
                    <ChatText text={m.text} emotes={m.emotes} channelEmotes={channelEmotes} />
                  </div>
                ))}
              {chatMsgs.length === 0 && (
                <div className="rm-alerts-empty">
                  {chatLive
                    ? "Connected — waiting for the first message."
                    : "Connect your Twitch or Kick channel to read chat here."}
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            {!chatPinned && (
              <button className="rm-chat-jump" onClick={jumpToLatest}>
                {ic.chev}
                {chatBehind > 0 ? `${chatBehind} new message${chatBehind === 1 ? "" : "s"}` : "Jump to latest"}
              </button>
            )}
            {/* Read-only for now. Sending needs per-platform OAuth, which
              * belongs with Connect; an input that quietly drops what you
              * type is worse than no input at all. */}
          </>
        );
      case "sources": {
        if (filterFor) {
          return (
            <FilterEditor
              sourceId={filterFor.id}
              sourceLabel={filterFor.label}
              media={filterFor.media}
              onBack={() => setFilterFor(null)}
            />
          );
        }
        const liveItems = sources.items ?? [];
        const guestItems = liveItems.filter((i) => i.kind === "guest");
        const revealGuests = () => {
          if (dockOf(layout, "guests") === "hidden") {
            setLayout(movePanel(layout, "guests", dockOf(layout, "sources")));
          }
        };
        const itemIdFor = (key: string) => (key === "alerts" ? "overlay" : key);
        const itemFor = (key: string) => liveItems.find((i) => i.id === itemIdFor(key));
        const activeRows = (
          [
            sources.screen && { key: "screen", label: "Screen", icon: ic.screen, device: "screen", remove: () => setSrc({ screen: false }) },
            sources.camera && { key: "camera", label: "Camera", icon: ic.cam, device: "camera", remove: () => setSrc({ camera: false }) },
            overlayActive && { key: "alerts", label: "Overlay", icon: ic.link, remove: () => ipc.liveSetOverlay(null, false).catch(() => {}) },
            // Audio is a source, like OBS: the picker lives here, the fader
            // lives in the mixer.
            sources.mic && { key: "mic", label: "Microphone", icon: ic.mic, device: "mic", audio: true, remove: () => setSrc({ mic: false }) },
            // One collapsed Guest COMPONENT row — the dock must show that
            // guest cameras are part of this scene, but people are managed
            // per-person in the Guests panel, so it opens that instead of
            // exposing eye/remove that could quietly change who is on air.
            guestItems.length > 0 && {
              key: "guests",
              label: `Guests · ${guestItems.filter((g) => g.visible).length}/${guestItems.length} on screen`,
              icon: ic.invite,
              remove: revealGuests,
            },
            // Open-list items, straight from engine truth. Guests are
            // excluded here: they collapse into the Guest component above
            // rather than appearing as a row per person.
            ...liveItems
              .filter((i) => !["screen", "camera", "overlay"].includes(i.id) && i.kind !== "guest")
              .map((i) => ({
                key: i.id,
                label: i.label || i.kind,
                icon: EXTRA_ICONS[i.kind] ?? ic.link,
                // Window items are re-selectable: same strip, list of windows.
                device: i.kind === "window" ? `window:${i.id}` : undefined,
                inviteUrl: (cfg.sources.extras ?? []).find((e) => e.id === i.id)?.invite_url,
                remove: () => removeExtraSource(i.id),
              })),
          ].filter(Boolean) as {
            key: string;
            label: string;
            icon: ReactNode;
            device?: string;
            audio?: boolean;
            remove: () => void;
          }[]
        ).sort((a, b) => {
          // Microphone (audio-only, grip-less) stays at the bottom. The
          // Guests COMPONENT sorts into the stack at its block's z — it
          // drags as one layer, so it must render where its layers sit.
          const rank = (k: string) => (k === "mic" ? 1 : 0);
          if (rank(a.key) !== rank(b.key)) return rank(a.key) - rank(b.key);
          const zOf = (k: string) =>
            k === "guests" ? Math.max(...guestItems.map((g) => g.z)) : itemFor(k)?.z;
          const za = zOf(a.key);
          const zb = zOf(b.key);
          if (za != null && zb != null) return zb - za; // topmost first
          if (za != null) return -1;
          if (zb != null) return 1;
          return 0;
        });
        return (
          <>
              <div className="rm-rows" ref={srcRowsRef}>
                {activeRows.length === 0 && (
                  <div className="rm-rows-empty">Nothing on the stage — add a source with +</div>
                )}
                {activeRows.map((t) => {
                  const item = itemFor(t.key);
                  const hidden = item ? !item.visible : false;
                  const others = srcDrag ? activeRows.filter((r) => itemFor(r.key) && r.key !== srcDrag.key).map((r) => r.key) : [];
                  const oi = others.indexOf(t.key);
                  const dropCls = srcDrag && oi >= 0
                    ? oi === srcDrag.over
                      ? " drop-before"
                      : srcDrag.over === others.length && oi === others.length - 1
                        ? " drop-after"
                        : ""
                    : "";
                  return (
                    <div
                      key={t.key}
                      data-srcrow={item || t.key === "guests" ? t.key : undefined}
                      className={`rm-row${hidden ? " off" : ""}${srcDrag?.key === t.key ? " dragging" : ""}${dropCls}`}
                    >
                      {(item || t.key === "guests") && (
                        <span
                          className="rm-row-grip"
                          title="Drag to rearrange"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                            setSrcDrag({ key: t.key, over: srcDropIndex(t.key, e.clientY) });
                          }}
                          onPointerMove={(e) => {
                            if (e.buttons !== 1) return;
                            setSrcDrag((d) => (d ? { ...d, over: srcDropIndex(d.key, e.clientY) } : d));
                          }}
                          onPointerUp={() => commitSrcOrder()}
                          onPointerCancel={() => setSrcDrag(null)}
                        >
                          {ic.grip}
                        </span>
                      )}
                      <span className="rm-row-icon">{t.icon}</span>
                      <span className="rm-row-name">{t.label}</span>
                      {t.key !== "guests" && (
                      <button
                        className="rm-row-edit rm-row-fx"
                        title="Filters"
                        onClick={() =>
                          setFilterFor({
                            id: t.key === "alerts" ? "overlay" : t.key,
                            label: t.label,
                            media: t.key === "mic" ? "audio" : "video",
                          })
                        }
                      >
                        ƒ
                      </button>
                      )}
                      {(t.key === "alerts" || t.device) && (
                        <button
                          className={`rm-row-edit${srcSettings === t.key ? " on" : ""}`}
                          title="Source settings"
                          onClick={(e) => {
                            // Docked in the sheet → horizontal settings strip
                            // above the panels. Docked on a sidebar → the
                            // strip has nowhere to live, so pop vertically
                            // right here.
                            if (dockOf(layout, "sources") === "bottom") {
                              setSrcSettings((k) => (k === t.key ? null : t.key));
                            } else if (t.key === "alerts") {
                              setOverlayOpen(true);
                            } else if (t.device) {
                              setPopAnchor(e.currentTarget);
                              setDeviceMenu((d) => (d === t.device ? null : t.device!));
                            }
                          }}
                        >
                          {ic.gear}
                        </button>
                      )}
                      {item && (
                        <button
                          className={`rm-row-edit rm-row-eye${hidden ? " off" : ""}`}
                          title={hidden ? "Show on stage" : "Hide from stage"}
                          onClick={() => ipc.liveSetTransform(item.id, { visible: hidden }, true).catch(() => {})}
                        >
                          {ic.eye}
                        </button>
                      )}
                      {t.key === "guests" ? (
                        <button className="rm-row-edit" title="Manage in the Guests panel" onClick={t.remove}>
                          {ic.gear}
                        </button>
                      ) : (
                        <button className="rm-row-edit rm-row-remove" title="Remove from this room" onClick={t.remove}>
                          {ic.x}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

          </>
        );
      }
      case "guests":
        // Guests are people you monitor for the length of a show, like chat —
        // so this is a dockable panel of its own, not a row inside Sources.
        return (
          <GuestPanel
            thumbs={guestThumbs}
            roster={roster}
            error={guestErr}
            items={(sources.items ?? []).filter((i) => i.kind === "guest")}
            onAdmit={admitGuest}
            onRemove={removeGuest}
            onMute={(id, muted) => setSourceAudio(id, undefined, muted).catch(() => {})}
            onShow={(id, show) => fadeGuest(id, show)}
          />
        );
      case "mixer":
        return (
              <div className="rm-strips">
                {sources.mic && micStrip}
                {/* Every audio-bearing source gets a strip, not just the mic —
                  * a guest you cannot level is only half a guest. */}
                {(sources.items ?? [])
                  // Guests and media genuinely carry audio. Screen and camera
                  // advertise the capability but produce no track in our
                  // graph, and a row of silent faders just buries the ones
                  // that matter.
                  .filter((i) => i.has_audio && (i.kind === "guest" || i.kind === "media"))
                  .map((i) => (
                    <MeterStrip
                      horizontal={dockOf(layout, "mixer") === "top"}
                      key={i.id}
                      label={i.label || i.kind}
                      icon={i.kind === "guest" ? ic.invite : ic.play}
                      level={extraLevels[i.id] ?? 0}
                      volume={i.volume ?? 1}
                      muted={i.muted ?? false}
                      onVolume={(v) => setSourceAudio(i.id, v).catch(() => {})}
                      onMute={() => setSourceAudio(i.id, undefined, !i.muted).catch(() => {})}
                    />
                  ))}
                {!sources.mic &&
                  (sources.items ?? []).every(
                    (i) => !(i.has_audio && (i.kind === "guest" || i.kind === "media")),
                  ) && (
                  <div className="rm-rows-empty">
                    No audio sources. Add a microphone from Sources.
                  </div>
                )}
              </div>
        );
      case "channels": {
        // Channels card: brand mark · name · phase · switch. Clicking a row
        // (off the switch) opens INLINE key entry — the key goes straight to
        // the Keychain via the same upsert the editor uses.
        const chnTop = dockOf(layout, "channels") === "top";
        if (chnTop) {
          // Top bar: the LOGO is the toggle. Lit = armed. Nothing else.
          return (
            <div className="chn chn-icons">
              {destinations.map((d) => {
                const st = statuses.get(d.id);
                return (
                  <button
                    key={d.id}
                    className={`chn-ico${d.enabled ? " on" : ""}`}
                    disabled={streaming}
                    title={`${d.label} — ${d.enabled ? "armed" : "off"}${streaming && st ? ` · ${(PHASE_COPY[st.phase] ?? PHASE_COPY.idle).label}` : ""}`}
                    onClick={() => toggleEnabled(d)}
                  >
                    {PLATFORM_LOGO[d.preset] ?? <span className="rm-row-dot" style={{ background: PLATFORM_TINT[d.preset] ?? "oklch(0.6 0.02 250)" }} />}
                    {streaming && st && <span className={`rm-chan-phase ${st.phase}`} />}
                  </button>
                );
              })}
            </div>
          );
        }
        return (
          <div className="chn">
            {destinations.map((d) => {
              const st = statuses.get(d.id);
              const phase = st ? PHASE_COPY[st.phase] ?? PHASE_COPY.idle : PHASE_COPY.idle;
              const open = keyFor === d.id;
              return (
                <div key={d.id} className={`chn-item${open ? " open" : ""}`}>
                  <div
                    className={`chn-row${d.enabled ? "" : " off"}`}
                    onClick={() => {
                      if (streaming) return;
                      setKeyVal("");
                      setKeyFor(open ? null : d.id);
                    }}
                  >
                    <span className="chn-logo">{PLATFORM_LOGO[d.preset] ?? <span className="rm-row-dot" style={{ background: PLATFORM_TINT[d.preset] ?? "oklch(0.6 0.02 250)" }} />}</span>
                    <span className="chn-name">{d.label}</span>
                    {streaming && st && (
                      <span className="chn-sub">
                        {phase.label}
                        <span className={`rm-chan-phase ${st.phase}`} />
                      </span>
                    )}
                    <button
                      className={`rm-switch${d.enabled ? " on" : ""}`}
                      disabled={streaming}
                      title={d.enabled ? "Disarm" : "Arm"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleEnabled(d);
                      }}
                    >
                      <span className="rm-switch-knob" />
                    </button>
                  </div>
                  {open && (
                    <div className="chn-key" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="password"
                        autoFocus
                        placeholder="Stream key (stored in Keychain — paste to replace)"
                        value={keyVal}
                        onChange={(e) => setKeyVal(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && keyVal && saveChannelKey(d)}
                      />
                      <button className="chn-key-save" disabled={!keyVal} onClick={() => saveChannelKey(d)}>
                        Save
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {destinations.length === 0 && (
              <div className="rm-rows-empty">No channels — add them in Settings</div>
            )}
          </div>
        );
      }
      case "stats": {
        // The numbers behind the health dot. Real data only.
        const fmtT = (secs: number) =>
          `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
        return (
          <div className="stx">
            <div className="stx-grid">
              <div className="stx-tile"><span className="stx-lbl">FPS</span><span className="stx-num">{(snapshot?.fps ?? 0).toFixed(0)}</span></div>
              <div className="stx-tile"><span className="stx-lbl">CPU</span><span className="stx-num">{(snapshot?.cpu ?? 0).toFixed(1)}%</span></div>
              <div className="stx-tile"><span className="stx-lbl">Bitrate</span><span className="stx-num">{streaming ? fmtBitrate(bytesTotal, elapsed) : "—"}</span></div>
              <div className="stx-tile"><span className="stx-lbl">Dropped</span><span className={`stx-num${droppedTotal > 0 ? " warn" : ""}`}>{streaming ? `${droppedTotal} (${droppedPct.toFixed(1)}%)` : "—"}</span></div>
              <div className="stx-tile"><span className="stx-lbl">Live time</span><span className="stx-num">{streaming ? fmtT(elapsed) : "—"}</span></div>
            </div>
            {(snapshot?.skipped_frames ?? 0) > 0 || reconnectTotal > 0 ? (
              <div className="stx-warns">
                {(snapshot?.skipped_frames ?? 0) > 0 && <span>{snapshot?.skipped_frames} skipped (renderer)</span>}
                {reconnectTotal > 0 && <span>{reconnectTotal} reconnect{reconnectTotal === 1 ? "" : "s"}</span>}
              </div>
            ) : null}
            <div className="stx-chart" title="Render load (CPU share), last 60s">
              <span className="stx-lbl">Render load</span>
              <svg viewBox="0 0 120 28" preserveAspectRatio="none">
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  points={loadHist.current.map((v, k) => `${(k / 59) * 120},${28 - Math.min(1, v / 100) * 26 - 1}`).join(" ")}
                />
              </svg>
            </div>
              </div>
        );
      }
    }
  };

  const panelExtra = (id: PanelId) => {
    if (id === "guests") {
      const liveGuests = roster.filter((g) => g.state !== "waiting" && g.render_url);
      const waitingN = roster.filter((g) => g.state === "waiting").length;
      return (
        <>
          <span className="rm-cnt">
            {liveGuests.length}/8{waitingN > 0 && <em>{waitingN} waiting</em>}
          </span>
          <button
            className="rm-panel-plus"
            title="Copy the room's guest link"
            onClick={async () => {
              const url = guestLink ?? (await ensureGuestLink());
              if (url) await navigator.clipboard.writeText(url).catch(() => {});
            }}
          >
            {ic.link}
          </button>
        </>
      );
    }
    if (id === "scenes")
      return (
        <>
          {/* A bare gear says nothing. Show the room's transition by name so
           * the control explains itself and doubles as status. */}
          <button
            className={`rm-scene-default${sceneSettings === "__room__" ? " on" : ""}`}
            title="Transition used by every scene that has no override"
            onClick={(e) => {
              setPopAnchor(e.currentTarget);
              setSceneSettings((k) => (k === "__room__" ? null : "__room__"));
            }}
          >
            {(cfg.transition?.kind ?? "cut") === "cut"
              ? "None"
              : (cfg.transition?.kind ?? "cut") === "move"
                ? `Move ${cfg.transition?.ms ?? 320}ms`
                : (cfg.transition?.kind ?? "cut") === "fade"
                  ? `Fade ${cfg.transition?.ms ?? 320}ms`
                : `Stinger ${cfg.transition?.ms ?? 1200}ms`}
            {ic.chev}
          </button>
          <button className="rm-panel-plus" title="Save the current look as a scene" onClick={addScene}>
            {ic.plus}
          </button>
        </>
      );
    if (id === "chat")
      return (
        <>
          <button
            className={`rm-panel-plus rm-chat-plug${chatLive ? " live" : ""}`}
            title={chatLive ? "Chat channels" : "Connect your chat"}
            onClick={(e) => {
              setPopAnchor(e.currentTarget);
              setChatSetupOpen((o) => !o);
            }}
          >
            {ic.link}
          </button>
          {chatSetupOpen && (
            <Pop anchor={popAnchor} align="right" className="rm-pop-chat">
              <ChatSetup
                names={chatNames}
                conns={chatConns}
                error={chatError}
                onApply={(n) => {
                  setChatSetupOpen(false);
                  connectChat(n);
                }}
              />
            </Pop>
          )}
          <button
            className="rm-panel-plus"
            title="Pop out platform chat"
            onClick={(e) => {
              setPopAnchor(e.currentTarget);
              setChatOpen((o) => !o);
            }}
          >
            {ic.ext}
          </button>
          {chatOpen && (
            <Pop anchor={popAnchor} align="right">
              <ChatPopover onClose={() => setChatOpen(false)} />
            </Pop>
          )}
        </>
      );
    if (id === "sources") {
      const addable = [
        !sources.screen && { key: "screen", label: "Screen", icon: ic.screen, act: () => setSrc({ screen: true }) },
        !sources.camera && { key: "camera", label: "Camera", icon: ic.cam, act: () => setSrc({ camera: true }) },
        !overlayActive && { key: "alerts", label: "Overlay", icon: ic.link, act: () => setOverlayOpen(true) },
        !sources.mic && { key: "mic", label: "Microphone", icon: ic.mic, act: () => setSrc({ mic: true }) },
        {
          key: "media",
          label: "Media file",
          icon: ic.play,
          act: async () => {
            const path = await extraSources.pickFile("media").catch(() => null);
            if (path) {
              const base = path.split("/").pop() ?? "Media";
              addExtraSource(base, { kind: "media", path, looping: true });
            }
          },
        },
        {
          key: "image",
          label: "Image",
          icon: ic.image,
          act: async () => {
            const path = await extraSources.pickFile("image").catch(() => null);
            if (path) {
              const base = path.split("/").pop() ?? "Image";
              addExtraSource(base, { kind: "image", path });
            }
          },
        },
        { key: "text", label: "Text", icon: ic.text, act: () => setSrcSubPop("text") },
        { key: "color", label: "Color", icon: ic.swatch, act: () => setSrcSubPop("color") },
        { key: "window", label: "Window capture", icon: ic.screen, act: () => setSrcSubPop("window") },
        {
          // Guests are COMPONENTS — real people admitted through the Guests
          // panel — not name-typed sources. A guest source cannot exist
          // without one, so "adding" a guest means opening that panel.
          key: "guest",
          label: "Guest — via Guests panel",
          icon: ic.invite,
          act: () => {
            if (dockOf(layout, "guests") === "hidden") {
              setLayout(movePanel(layout, "guests", dockOf(layout, "sources")));
            }
          },
        },
      ].filter(Boolean) as { key: string; label: string; icon: ReactNode; act: () => void }[];
      return (
        <>
          <button
            className={`rm-panel-plus rm-src-add${srcAddOpen ? " open" : ""}`}
            title="Add a source"
            onClick={(e) => {
              setPopAnchor(e.currentTarget);
              setSrcAddOpen((o) => !o);
            }}
          >
            {ic.plus}
          </button>
          {srcAddOpen && (
            <Pop anchor={popAnchor} align="right">
              {addable.length === 0 ? (
                <div className="rm-pop-empty">Everything is on the stage</div>
              ) : (
                addable.map((t) => (
                  // div, not button: WKWebView can't flex-lay-out button
                  // children (they stack), same trap as the scene tiles.
                  <div
                    key={t.key}
                    role="button"
                    tabIndex={0}
                    className="rm-device rm-addsource"
                    onClick={() => {
                      setSrcAddOpen(false);
                      t.act();
                    }}
                  >
                    <span className="rm-row-icon">{t.icon}</span>
                    <span className="rm-device-name">{t.label}</span>
                  </div>
                ))
              )}
            </Pop>
          )}
        </>
      );
    }
    if (id === "mixer")
      return <span className="rm-card-sub">{sources.mic ? (sources.mic_muted ? "mic muted" : "mic open") : "mic off"}</span>;
    return null;
  };

  const slot = (dock: Dock, index: number) => (
    <div
      key={`${dock}-slot-${index}`}
      className={`rm-slot${layoutEdit ? " armed" : ""}${
        dropHint && dropHint.dock === dock && dropHint.index === index ? " hot" : ""
      }`}
    />
  );

  /** WKWebView's HTML5 drag-and-drop is unreliable, so panels drag on raw
   * pointer events (the dnd-kit / VS Code approach): capture the pointer,
   * follow it with a ghost, and work out the drop from geometry. */
  const dragRef = useRef<{ id: PanelId; x: number; y: number; moved: boolean } | null>(null);

  const hitTest = (x: number, y: number): { dock: Dock; index: number } | null => {
    const docks = Array.from(document.querySelectorAll<HTMLElement>("[data-dock]"));
    for (const el of docks) {
      const r = el.getBoundingClientRect();
      const pad = 16;
      if (x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad) continue;
      const dock = el.dataset.dock as Dock;
      const horizontal = dock === "bottom";
      const panels = Array.from(el.querySelectorAll<HTMLElement>("[data-panel]"));
      let index = panels.length;
      for (let i = 0; i < panels.length; i++) {
        const pr = panels[i].getBoundingClientRect();
        const mid = horizontal ? pr.left + pr.width / 2 : pr.top + pr.height / 2;
        if ((horizontal ? x : y) < mid) {
          index = i;
          break;
        }
      }
      return { dock, index };
    }
    return null;
  };

  const gripDown = (id: PanelId) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { id, x: e.clientX, y: e.clientY, moved: false };
  };

  const gripMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(d.id);
    }
    setGhost({ x: e.clientX, y: e.clientY });
    setDropHint(hitTest(e.clientX, e.clientY));
  };

  const gripUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) {
      const target = hitTest(e.clientX, e.clientY);
      if (target) setLayout(movePanelTo(layout, d.id, target.dock, target.index));
    }
    setDragging(null);
    setDropHint(null);
    setGhost(null);
  };

  const addButton = (dock: Dock) => {
    const available = PANEL_ORDER.filter((id) => dockOf(layout, id) !== dock);
    return (
      <div className="rm-pop-anchor rm-add-anchor" key={`${dock}-add`}>
        <button
          className="rm-add-panel"
          title="Add a panel here"
          onClick={(e) => {
            setPopAnchor(e.currentTarget);
            setAddMenu((m) => (m === dock ? null : dock));
          }}
        >
          {ic.plus}
        </button>
        {addMenu === dock && (
          <Pop
            anchor={popAnchor}
            align={dock === "bottom" ? "up" : dock === "left" ? "left" : "right"}
            className="rm-pop-add"
          >
            <div className="rm-pop-title">ADD PANEL</div>
            {available.map((id) => (
              <button
                key={id}
                className="rm-pop-row"
                onClick={() => {
                  setLayout(movePanelTo(layout, id, dock, layout[dock].length));
                  setAddMenu(null);
                }}
              >
                <span className="rm-add-name">{PANEL_META[id].title}</span>
                <span className="rm-add-where">
                  {dockOf(layout, id) === "hidden" ? "hidden" : `from ${dockOf(layout, id)}`}
                </span>
              </button>
            ))}
            {available.length === 0 && <div className="rm-rows-empty">Everything is already here.</div>}
          </Pop>
        )}
      </div>
    );
  };

  const renderDock = (dock: Dock) => {
    const ids = layout[dock];
    return (
      <>
        {ids.map((id, i) => (
          <Fragment key={id}>
            {/* Splitters only between neighbours in the bottom row; side
             * docks resize against the stage, not against each other. */}
            {dock === "bottom" && i > 0 && !layoutEdit && splitter("bottom", ids[i - 1], id)}
            {slot(dock, i)}
            {renderPanel(id)}
          </Fragment>
        ))}
        {slot(dock, ids.length)}
        {addButton(dock)}
      </>
    );
  };

  const renderPanel = (id: PanelId) => {
    // Belt to normalize's braces: an unknown id must never render, because
    // one missing entry in the inventory would otherwise blank the room.
    if (!PANEL_META[id]) return null;
    return (
    <section
      key={id}
      data-panel={id}
      data-in={dockOf(layout, id)}
      className={`rm-panel rm-panel-${id}${dragging === id ? " dragging" : ""}`}
      style={
        dockOf(layout, id) === "bottom" && shown.weights?.[id]
          ? { flexGrow: shown.weights[id], flexBasis: 0 }
          : undefined
      }
    >
      <div className="rm-panel-head">
        <span
          className="rm-grip"
          title="Drag to move this panel"
          onPointerDown={gripDown(id)}
          onPointerMove={gripMove}
          onPointerUp={gripUp}
          onPointerCancel={gripUp}
        >
          {ic.grip}
        </span>
        <span className="rm-group-label">{PANEL_META[id].title.toUpperCase()}</span>
        <div className="rm-panel-actions">
          {panelExtra(id)}
          <button
            className="rm-panel-plus rm-panel-hide"
            title="Hide this panel"
            onClick={() => setLayout(movePanel(layout, id, "hidden"))}
          >
            {ic.x}
          </button>
        </div>
      </div>
      <div className="rm-panel-body">{panelBody(id)}</div>
    </section>
    );
  };

  return (
    <div className={`room${layoutEdit ? " layout-edit" : ""}`}>
      {mountVeil && (
        <div className="rm-veil">
          <span className="rm-veil-spin" />
          <span className="rm-veil-note">{veilNote}</span>
        </div>
      )}
      {anyPop && <div className="rm-pop-backdrop" onClick={closePops} />}

      <header className="rm-top" data-tauri-drag-region>
        <div className="rm-top-left" data-tauri-drag-region>
          {/* Stream health lives here, not in a dock. Health you have to go
            * find — or that a layout can hide — is health you learn about too
            * late. Dot is always present; the numbers appear once they mean
            * something. */}
        </div>

        {/* Always present. Moving health out of the dock was pointless if it
          * disappears whenever you aren't live — the idle state is itself
          * information ("engine up, nothing going out"). */}
        <div className="rm-chip rm-health">
          <span className={`rm-bars q-${quality}`} title={`Network: ${quality}`}>
            <i />
            <i />
            <i />
            <i />
          </span>
          {!streaming ? (
            <span className="rm-health-idle">
              {!engineOk ? "Starting engine" : enabledDests.length === 0 ? "No channels" : "Ready"}
            </span>
          ) : (
            <span className="rm-health-time">
              {`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
            </span>
          )}
          {engineOk && (
            <>
              <span className="rm-health-sep" />
              <span className="rm-health-num">{(snapshot?.fps ?? 0).toFixed(0)} fps</span>
            </>
          )}
        </div>
        {!streaming && lastRec && (
          <button
            className="rm-health-rec"
            onClick={() => recIpc.reveal(lastRec).catch(() => {})}
            title={lastRec}
          >
            {ic.play}
            Last take
          </button>
        )}
        <div className="rm-top-drag" data-tauri-drag-region />

        <div className="rm-top-right">
          {streaming && (
            <span className="rm-live-pill">
              <span className="rm-live-dot" />
              {`${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}
            </span>
          )}

          <button
            className="hd-chip"
            title="Output video settings"
            onClick={(e) => {
              setPopAnchor(e.currentTarget);
              setQualityOpen((o) => !o);
            }}
          >
            {vh}p · {vf}
            {ic.chev}
          </button>

          <button
            className={`hd-chip${vcamOn ? " on" : ""}`}
            onClick={toggleVcam}
            disabled={!engineOk}
            title={
              vcamState?.installed
                ? "Appear as a webcam in Zoom, Meet and Discord"
                : "Install Producer's virtual camera (one approval in System Settings)"
            }
          >
            {ic.cam}
            {vcamState?.state === "needs_approval"
              ? "Approve"
              : vcamOn
                ? "Cam on"
                : vcamState?.installed
                  ? "Virtual cam"
                  : "Install cam"}
          </button>

          <button
            className={`hd-chip${recPath ? " rec" : ""}`}
            onClick={toggleRecord}
            disabled={!engineOk}
            title={recPath ? `Recording to ${recPath.split("/").pop()}` : "Record locally"}
          >
            <span className="rm-rec-dot" />
            {recPath
              ? `${Math.floor(recElapsed / 60)}:${String(recElapsed % 60).padStart(2, "0")}`
              : "Record"}
          </button>

          {streaming ? (
            <button className="hd-golive stop" onClick={() => ipc.liveStop()} disabled={state === "stopping"}>
              <span className="rm-big-icon">■</span>
              {state === "stopping" ? "Stopping…" : "End"}
            </button>
          ) : (
            <button
              className="hd-golive"
              onClick={goLive}
              disabled={!engineOk || enabledDests.length === 0}
              title={enabledDests.length === 0 ? "Arm a channel first" : undefined}
            >
              {ic.onair}
              GO LIVE
            </button>
          )}

          {qualityOpen && (
            <Pop anchor={popAnchor} align="right" className="rm-pop-quality">
              <div className="rm-pop-title">VIDEO {streaming && <span className="rm-card-sub">locked while live</span>}</div>
              <div className="rm-ctrl-row">
                <span className="rm-ctrl-label">Resolution</span>
                <span className="rm-quality-set">
                  {[720, 1080].map((h) => (
                    <button key={h} className={`rm-q${vh === h ? " on" : ""}`} disabled={streaming || !engineOk} onClick={() => setVideoCfg(h, vf)}>
                      {h}p
                    </button>
                  ))}
                </span>
              </div>
              <div className="rm-ctrl-row">
                <span className="rm-ctrl-label">Frame rate</span>
                <span className="rm-quality-set">
                  {[30, 60].map((f) => (
                    <button key={f} className={`rm-q${vf === f ? " on" : ""}`} disabled={streaming || !engineOk} onClick={() => setVideoCfg(vh, f)}>
                      {f}
                    </button>
                  ))}
                </span>
              </div>
              <div className="rm-ctrl-row">
                <span className="rm-ctrl-label">Bitrate</span>
                <span className="rm-ctrl-value" title="Producer negotiates the best rate every channel accepts">Auto</span>
              </div>
            </Pop>
          )}

          <button
            className={`rm-icon-chip${layoutEdit ? " on" : ""}`}
            onClick={() => {
              setLayoutEdit((e) => !e);
              setLayoutMenu(false);
            }}
            title={layoutEdit ? "Done editing layout" : "Edit layout"}
          >
            {ic.layout}
          </button>

          <button
            className="rm-leave"
            onClick={() => onLeave?.()}
            title={streaming ? "Collapse — the stream keeps running" : "Collapse room"}
          >
            {ic.collapseDown}
          </button>
        </div>
      </header>

      {layoutEdit && (
        <div className="rm-editbar">
          <span className="rm-editbar-dot" />
          <span className="rm-editbar-text">
            Editing layout — drag a panel by its grip, or use + to add one
          </span>
          <div className="rm-pop-anchor">
            <button
              className="rm-editbar-btn"
              onClick={(e) => {
                setPopAnchor(e.currentTarget);
                setLayoutMenu((o) => !o);
              }}
            >
              Presets
              {ic.chev}
            </button>
            {layoutMenu && (
              <Pop anchor={popAnchor} align="right" className="rm-pop-layout">
                {LAYOUT_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    className="rm-preset"
                    onClick={() => {
                      setLayout({
                        top: [...p.layout.top],
                        left: [...p.layout.left],
                        right: [...p.layout.right],
                        bottom: [...p.layout.bottom],
                        hidden: [...p.layout.hidden],
                      });
                      setLayoutMenu(false);
                    }}
                  >
                    <span className="rm-preset-name">{p.label}</span>
                    <span className="rm-preset-note">{p.note}</span>
                  </button>
                ))}
              </Pop>
            )}
          </div>
          <button className="rm-editbar-done" onClick={() => setLayoutEdit(false)}>
            Done
          </button>
        </div>
      )}

      {/* The TOP DOCK: a real dock — drag any panel up here (Controller
        * belongs; chat while chatting; whatever the show needs). Renders only
        * when populated or while editing, so the default room stays clean. */}
      {(layout.top.length > 0 || layoutEdit) && (
        <div
          data-dock="top"
          className={`rm-dock rm-dock-top${layout.top.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "top" ? " hot" : ""}`}
        >
          {renderDock("top")}
        </div>
      )}

      <div className="rm-body">
        <aside
          data-dock="left"
          className={`rm-dock rm-dock-side${layout.left.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "left" ? " hot" : ""}`}
          style={layout.left.length && shown.left ? { width: shown.left, flex: "0 0 auto" } : undefined}
        >
          {renderDock("left")}
        </aside>
        {layout.left.length > 0 && !layoutEdit && splitter("left")}

        <div className="rm-center">
          <div className="rm-canvas">
            {engineOk && (
              <PreviewPanel>
                <StageEditor
                  items={sources.items ?? []}
                  baseW={(vh * 16) / 9}
                  baseH={vh}
                  disabled={!engineOk}
                  onOrder={(id, dir) => {
                    const it = (sources.items ?? []).find((i) => i.id === id);
                    if (it) ipc.liveSetTransform(id, { z: it.z + dir }, true).catch(() => {});
                  }}
                />
              </PreviewPanel>
            )}
            {!engineOk && snapshot && (
              <div className="rm-canvas-msg">
                {snapshot.disabled ? "Live engine not bundled in this build." : "Warming up the engine…"}
              </div>
            )}
          </div>

          {/* Stage overlays: HTML floats above the hole-mode preview. */}
          {streaming && (
            <div className="stg-live">
              <span className="stg-live-dot" />
              LIVE {`${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}
            </div>
          )}
          {engineOk && (
            <div className="stg-bar">
              <button
                className={`stg-btn${sources.mic_muted ? " off" : ""}`}
                title={sources.mic_muted ? "Unmute mic" : "Mute mic"}
                onClick={toggleMute}
              >
                {ic.mic}
              </button>
              {(() => {
                const cam = (sources.items ?? []).find((i) => i.id === "camera");
                return cam ? (
                  <button
                    className={`stg-btn${cam.visible ? "" : " off"}`}
                    title={cam.visible ? "Hide camera" : "Show camera"}
                    onClick={() => ipc.liveSetTransform("camera", { visible: !cam.visible }, true).catch(() => {})}
                  >
                    {ic.cam}
                  </button>
                ) : null;
              })()}
              {(() => {
                const scr = (sources.items ?? []).find((i) => i.id === "screen");
                return scr ? (
                  <button
                    className={`stg-btn${scr.visible ? "" : " off"}`}
                    title={scr.visible ? "Hide screen" : "Show screen"}
                    onClick={() => ipc.liveSetTransform("screen", { visible: !scr.visible }, true).catch(() => {})}
                  >
                    {ic.screen}
                  </button>
                ) : null;
              })()}
              <button
                className={`stg-btn${recPath ? " rec" : ""}`}
                title={recPath ? "Stop recording" : "Record"}
                onClick={toggleRecord}
              >
                <span className="rm-rec-dot" />
              </button>
            </div>
          )}
          <div className="rm-float">{banner && <div className="rm-banner">{banner}</div>}</div>

          <PermBanner
            sources={sources}
            onGranted={(kind) => {
              // A source created while the grant was missing is bound to
              // nothing — macOS does not retrofit access onto a live
              // capture session. Bounce just that source so the grant
              // takes effect without a relaunch or a second Allow.
              const b = sources;
              const bounce = async (screen: boolean, camera: boolean, mic: boolean, on: () => Promise<unknown>) => {
                // The grant is confirmed but the sources restart to bind it —
                // hold the veil over the flicker instead of showing it.
                setVeilNote("Applying access…");
                setMountVeil(true);
                try {
                  await ipc.liveSetSources(screen, camera, mic);
                  await on();
                } catch {
                  /* engine reports via banner */
                } finally {
                  window.setTimeout(() => setMountVeil(false), 300);
                }
              };
              if (kind === "mic" && b.mic)
                bounce(b.screen, b.camera, false, () => ipc.liveSetSources(b.screen, b.camera, true));
              if (kind === "camera" && b.camera)
                bounce(b.screen, false, b.mic, () => ipc.liveSetSources(b.screen, true, b.mic));
              if (kind === "screen" && b.screen)
                bounce(false, b.camera, b.mic, () => ipc.liveSetSources(true, b.camera, b.mic));
            }}
          />
        </div>

        {layout.right.length > 0 && !layoutEdit && splitter("right")}
        <aside
          data-dock="right"
          className={`rm-dock rm-dock-side${layout.right.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "right" ? " hot" : ""}`}
          style={layout.right.length && shown.right ? { width: shown.right, flex: "0 0 auto" } : undefined}
        >
          {renderDock("right")}
        </aside>
      </div>

      {sceneSettings && dockOf(layout, "scenes") !== "bottom" && (
        <Pop anchor={popAnchor} align="right" className="rm-pop-devices">
          <div className="rm-devices">
            <div className="rm-devices-head">Transition</div>
            {sceneSettings !== "__room__" && (
              <button
                className="rm-device"
                onClick={() => {
                  updateScene(sceneSettings);
                  setSceneSettings(null);
                }}
              >
                <span className="rm-device-name">Save current look</span>
              </button>
            )}
            {sceneSettings !== "__room__" &&
              scenes.find((x) => x.id === sceneSettings)?.transition && (
                <button
                  className="rm-device"
                  onClick={() => {
                    setTransition(sceneSettings, undefined);
                    setSceneSettings(null);
                  }}
                >
                  <span className="rm-device-name">Use room default</span>
                </button>
              )}
            {(["cut", "move", "fade", "stinger"] as const).map((k) => (
              <button
                key={k}
                className="rm-device"
                onClick={() => {
                  const sc = sceneSettings === "__room__" ? null : scenes.find((x) => x.id === sceneSettings) ?? null;
                  const eff = sceneSettings === "__room__" ? cfg.transition ?? { kind: "cut" as const } : transitionFor(sc);
                  const target = sceneSettings === "__room__" ? null : sceneSettings;
                  if (k === "stinger") {
                    extraSources.pickFile("media").then((path) => {
                      if (!path) return;
                      stingerIpc.prepare(path).catch(() => {});
                      setTransition(target, { ...eff, kind: "stinger", stinger: path });
                    });
                  } else {
                    setTransition(target, { ...eff, kind: k, stinger: undefined });
                  }
                  setSceneSettings(null);
                }}
              >
                <span className="rm-device-name">
                  {k === "cut" ? "None (cut)" : k === "move" ? "Move" : k === "fade" ? "Fade" : "Stinger…"}
                </span>
              </button>
            ))}
          </div>
        </Pop>
      )}

      {srcSubPop && (
        <Pop anchor={popAnchor} align="right" className="rm-pop-devices">
          {srcSubPop === "text" && (
            <TextSourceForm
              onAdd={(text) => {
                setSrcSubPop(null);
                addExtraSource("Text", { kind: "text", text });
              }}
            />
          )}
          {srcSubPop === "color" && (
            <ColorSourceForm
              onAdd={(color) => {
                setSrcSubPop(null);
                addExtraSource("Color", { kind: "color", color });
              }}
            />
          )}
          {srcSubPop === "window" && (
            <WindowSourceForm
              onAdd={(id, title) => {
                setSrcSubPop(null);
                addExtraSource(title, { kind: "window", window: id });
              }}
            />
          )}
        </Pop>
      )}

      {deviceMenu && (
        <Pop anchor={popAnchor} align="right" className="rm-pop-devices">
          {deviceMenu.startsWith("window:") ? (
            <div className="rm-devices">
              <div className="rm-devices-head">Window</div>
              <WindowPickerList
                itemId={deviceMenu.slice(7)}
                onPick={replaceWindowSource}
                onPicked={() => setDeviceMenu(null)}
              />
            </div>
          ) : (
            <DevicePicker kind={deviceMenu} onClose={() => setDeviceMenu(null)} />
          )}
        </Pop>
      )}

      {dragging && ghost && (
        <div className="rm-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className="rm-grip">{ic.grip}</span>
          {PANEL_META[dragging].title}
        </div>
      )}

      {overlayOpen && (
        <>
          <div className="rm-pop-backdrop" onClick={() => setOverlayOpen(false)} />
          <div className="rm-editor rm-editor-overlay">
            <div className="rm-editor-head">
              <span className="rm-group-label">OVERLAY</span>
              <button className="rm-panel-plus" onClick={() => setOverlayOpen(false)} title="Close">
                {ic.x}
              </button>
            </div>
            <OverlayPicker
              activeWindow={sources.overlay_window ?? null}
              activeUrl={sources.overlay_url ?? null}
            />
          </div>
        </>
      )}

      {(adding || editing) && (
        <>
          <div className="rm-pop-backdrop" onClick={() => (setAdding(false), setEditing(null))} />
          <div className="rm-editor">
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
          </div>
        </>
      )}

      {(layout.bottom.length > 0 || dragging) && (
        <div className={`rm-sheet${sheetOpen ? "" : " collapsed"}${sheetOpen && srcSettings && dockOf(layout, "sources") === "bottom" ? " has-strip" : ""}`}>
          <div
            className="rm-sheet-head"
            role="button"
            tabIndex={0}
            title={sheetOpen ? "Hide the bottom row" : "Show the bottom row"}
            onClick={() => setSheetOpen((o) => !o)}
            onKeyDown={(e) => e.key === "Enter" && setSheetOpen((o) => !o)}
          >
            <span className="rm-sheet-handle" />
          </div>
          {sheetOpen && streaming && (
            <div className="rm-livewarn">
              <span className="rm-live-dot" />
              You&rsquo;re on air — scene cuts and source changes hit the broadcast instantly.
            </div>
          )}
          {sheetOpen && sceneSettings && dockOf(layout, "scenes") === "bottom" && (
            <SceneSettingsStrip
              scene={sceneSettings === "__room__" ? null : scenes.find((x) => x.id === sceneSettings) ?? null}
              effective={
                sceneSettings === "__room__"
                  ? cfg.transition ?? { kind: "cut" }
                  : transitionFor(scenes.find((x) => x.id === sceneSettings) ?? null)
              }
              onSet={(t) => setTransition(sceneSettings === "__room__" ? null : sceneSettings, t)}
              onUpdate={() => {
                if (sceneSettings !== "__room__") updateScene(sceneSettings);
              }}
              onClose={() => setSceneSettings(null)}
            />
          )}
          {sheetOpen && srcSettings && dockOf(layout, "sources") === "bottom" && (
            <SourceSettingsStrip
              rowKey={srcSettings}
              items={sources.items ?? []}
              sources={sources}
              onClose={() => setSrcSettings(null)}
              openOverlay={() => setOverlayOpen(true)}
              onPickWindow={replaceWindowSource}
            />
          )}
          {(sheetOpen || dragging) && (
            <div data-dock="bottom" className={`rm-dock rm-dock-bottom${layoutEdit ? " armed" : ""}${dropHint?.dock === "bottom" ? " hot" : ""}`}>{renderDock("bottom")}</div>
          )}
        </div>
      )}
      <footer className="rm-foot">
        <span className="rm-foot-item">Producer v{appVersion ?? "…"}</span>
        <span className="rm-foot-item">
          Stream health
          <span className={`stg-meter foot q-${quality}`}>
            {Array.from({ length: 6 }).map((_, k) => (
              <i key={k} className={(quality === "excellent" ? 6 : quality === "good" ? 4 : quality === "mediocre" ? 2 : quality === "bad" ? 1 : 0) > k ? "on" : ""} />
            ))}
          </span>
          <span className="rm-foot-q">{quality === "off" ? "idle" : quality}</span>
        </span>
        {recPath && (
          <span className="rm-foot-item rec">
            <span className="rm-rec-dot" /> Recording {`${Math.floor(recElapsed / 60)}:${String(recElapsed % 60).padStart(2, "0")}`}
          </span>
        )}
        <span className="rm-foot-item dim">{snapshot?.graphics_backend ?? ""}</span>
      </footer>
    </div>
  );
}
