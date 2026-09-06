import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { installStageCutouts } from "../lib/stageCutouts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { expandSlotBindings, guestSlotPatch, lookPatch, slotOfGuest } from "../lib/slotMath";
import { GreenRoomBar, useGuestSeat } from "./GuestSeat";
import type { GuestSeatSpec } from "../lib/guestSeat";
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
  listServerRooms,
  registerRoom,
  roomOpenReport,
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
import { activeEndpointId, isBoomin, resolveActiveEndpoint } from "../lib/workspace";
import { StageEditor } from "./StageEditor";
import { Select } from "../components/Select";
import { fromCanvas, modFeedRect, modFeedZ, modSourceOwner, rememberModFeed, toCanvas, type ModFeedTrack } from "../lib/modFeed";
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
  BOTTOM_MAX, TOP_MAX, ROW_SNAP, ROW_MINI,
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
import { homePaintedMs, takeRoomClick } from "../lib/perf";
import { RoomControlLink, type ControlFrame, type SceneCutFrame } from "../lib/roomControl";
import { overlayBridge, type Contribution, type Interaction } from "../lib/ipc";
import { mintJoinLink } from "../lib/roomLink";
import {
  BOOMIN_ROOM_CHANNELS,
  boominAudienceUrl,
  boominStageConfig,
  boominVoteBody,
  contributionsInWindow,
  normalizeBoominInteraction,
  parseBoominFrame,
  scenesFromBoominConfig,
  type ContributionFrame,
} from "../lib/boominRoom";
import {
  moveInOrder,
  participantKind,
  resolveGrants,
  roomAccessFrom,
  capabilitiesOf,
  kindBadge,
  sourceIdsFor,
  wantedSourceIds,
  guestReconcileIds,
  wantedModSourceIds,
  modSourceIdsFor,
  modSourceLabel,
  isModSourceId,
  dedupeSeatRows,
  seatRoleLabel,
  type RoomGrantRowLike,
  type RoomAccessInfo,
  type RoomRole,
  SET_IS_HOSTS,
  setEditingAllowed,
  localSetDecision,
  isMonitor,
  isMediaSeat,
  hasAnyMedia,
  seatDisplayName,

  seatUserId,
} from "../lib/participants";
import { MonitorSender, ProgramMonitor, monitorLog, monitorPlaceholder, type MonitorRoomInfo, type MonitorState, type ProgramSource } from "../lib/monitorFeed";
import { SeatMediaLeg } from "../lib/seatMedia";
import { ModBoard } from "./ModBoard";
import { VotePanel, VoteEditor } from "./VotePanel";
import { voteFormFor, firstSentence } from "../lib/votePanel";
import { DEFAULT_MOD_BOARD, MOD_BOARD_PREF, normalizeModBoard, seatFeeds, throwUpState, type ModBoardLayout } from "../lib/modBoard";
import { prefGet } from "../lib/prefs";
import { team } from "../lib/access";
import type { Member } from "../lib/accessDiff";
import {
  EMPTY_MOD_STAGE,
  hostStagePlan,
  isOwnEcho,
  modRowStage,
  modStageReduce,
  modStageWish,
  type ModStageEvent,
  type ModStageState,
} from "../lib/stageTruth";
import { RoleCard } from "./RoleCard";
import { areaPath, pushSample, renderPressure, renderScale, renderTone } from "../lib/renderLoad";

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
            {selfCaptureNote(w)}
          </span>
        </button>
      ))}
    </>
  );
}

/** Producer's own window in a capture list. Capturing it puts the preview
 * inside the preview: every frame contains the last one, so dragging any
 * source looks like an explosion of copies. That is the mirror, not a
 * transform bug — the chip says so before the click. */
function selfCaptureNote(w: { owner: string }) {
  return w.owner === "Producer" ? " (this app — captures itself)" : "";
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
          {selfCaptureNote(w)}
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
export function GuestPanel({
  thumbs,
  roster,
  error,
  items,
  role,
  stage,
  onAdmit,
  onRemove,
  onMute,
  onShow,
  onStageToggle,
  onOrder,
  control,
  stageState,
  form = "column",
}: {
  thumbs: Record<string, string>;
  roster: RoomGuest[];
  error: string | null;
  items: LiveItem[];
  /** host = this Producer runs the show (unchanged path). mod = a member
   * holding room control on someone else's room: admit / remove / stage /
   * order through the server, nothing local. viewer = read-only. */
  role: RoomRole;
  /** The stage list (mods only). ModSeat passes the server's list; Live
   * passes `stageState` too, and that wins: the HOST's confirmed truth
   * with one pending ask overlaid (lib/stageTruth.ts). */
  stage: string[];
  stageState?: ModStageState;
  onAdmit: (id: string) => void;
  onRemove: (id: string) => void;
  onMute: (sourceId: string, muted: boolean) => void;
  onShow: (sourceId: string, show: boolean) => void;
  onStageToggle: (guestId: string) => void;
  onOrder: (guestId: string, dir: -1 | 1) => void;
  /** Dock form (v0.4.33): `row` = one 40px tile per guest scrolling
   * sideways (a slim top/bottom dock); `column` = the cards. The mod link
   * and the room cap live in the panel HEAD, never in the body. */
  form?: "row" | "column";
  /** Room control (`can.control` from the access answer): admit / remove /
   * stage / order. Host, manager and mod hold it; a viewer does not.
   * Defaults from the role for callers without the DTO. */
  control?: boolean;
}) {
  // render_url is the server's own statement of "this one may go on the
  // host". Waiting guests have none, so the gate is enforced there rather
  // than by us choosing not to draw someone.
  const waiting = roster.filter((g) => !g.render_url);
  const admitted = roster.filter((g) => !!g.render_url);
  // A mod sees the host's slot order (position), so the arrows mean
  // something. The host's own list is left exactly as it was.
  const live = role === "host"
    ? admitted
    : [...admitted].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  const ROOM_CAP = 8;
  const canControl = control ?? role !== "viewer";


  if (form === "row") {
    // ROW FORM: one tile per person — thumb, name, ONE control. Waiting
    // guests are an Admit chip. The list scrolls sideways under the dock's
    // sideways rules; nothing wraps, nothing grows tall.
    return (
      <div className="rm-guests rm-guests-row">
        {roster.length === 0 && <div className="rm-rows-empty">No one yet — copy the link from the panel head.</div>}
        {waiting.map((g) => (
          <div key={g.id} className="rm-gtile waiting">
            <span className="rm-wait-dot" />
            <span className="rm-gtile-name">{g.display_name || "Guest"}</span>
            {canControl ? (
              <button
                className="rm-guest-admit"
                disabled={live.length >= ROOM_CAP}
                title={live.length >= ROOM_CAP ? `Room is full (${ROOM_CAP})` : "Bring them into the room"}
                onClick={() => onAdmit(g.id)}
              >
                Admit
              </button>
            ) : (
              <span className="rm-guest-wait-note">waiting</span>
            )}
          </div>
        ))}
        {live.map((g) => {
          if (role === "host") {
            const ids = sourceIdsFor(g.id);
            const item = items.find((i) => i.id === ids.camera);
            return (
              <div key={g.id} className={`rm-gtile${item?.visible ? " on" : ""}`}>
                {thumbs[ids.camera] ? <img className="rm-gtile-img" src={thumbs[ids.camera]} alt="" /> : <span className="rm-gtile-img empty" />}
                <span className="rm-gtile-name">{g.display_name || "Guest"}</span>
                <button
                  className={`rm-guest-stage${item?.visible ? " on" : ""}`}
                  disabled={!item}
                  title={item?.visible ? "Take off screen (stays in the room)" : "Pop into the next free guest slot"}
                  onClick={() => item && onShow(item.id, !item.visible)}
                >
                  {item?.visible ? "On" : "Show"}
                </button>
              </div>
            );
          }
          const row = stageState ? modRowStage(stageState, g.id) : stage.includes(g.id) ? "on" : "off";
          const onStage = row === "on";
          const pendingRow = row === "pending-on" || row === "pending-off";
          return (
            <div key={g.id} className={`rm-gtile${onStage ? " on" : ""}${pendingRow ? " pending" : ""}`}>
              {g.snapshot ? <img className="rm-gtile-img" src={g.snapshot} alt="" /> : <span className="rm-gtile-img empty" />}
              <span className="rm-gtile-name">{g.display_name || "Guest"}</span>
              {canControl && (
                <button
                  className={`rm-guest-stage${onStage ? " on" : ""}${pendingRow ? " pending" : ""}`}
                  disabled={pendingRow}
                  onClick={() => onStageToggle(g.id)}
                >
                  {row === "pending-on" ? "…" : row === "pending-off" ? "…" : onStage ? "On" : "Stage"}
                </button>
              )}
            </div>
          );
        })}
        {error && <div className="rm-chatsetup-err">{error}</div>}
      </div>
    );
  }

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
              {/* Kind = identity strength, never what they may do. */}
              <span className={`rm-kind ${participantKind(g)}`}>{kindBadge(g)}</span>
              {!canControl && <span className="rm-guest-wait-note" title="Your seat is read-only — ask the host for room control">waiting</span>}
              {canControl && (
                <>
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
                </>
              )}
            </div>
          ))}
          {role !== "host" && live.map((g) => {
            // Not our engine: no thumbs, no sources, no mute. The stage is
            // the HOST's confirmed list; a mod's click is a request that
            // stays PENDING until the host answers (lib/stageTruth.ts).
            const row = stageState ? modRowStage(stageState, g.id) : stage.includes(g.id) ? "on" : "off";
            const onStage = row === "on";
            const pendingRow = row === "pending-on" || row === "pending-off";
            const notice = stageState?.notice?.guestId === g.id ? stageState.notice.text : null;
            const q = (g.quality ?? g.connection_quality ?? "unknown") as string;
            return (
              <div key={g.id} className={`rm-gcard${onStage ? " on" : ""}${pendingRow ? " pending" : ""}`}>
                {g.snapshot ? <img className="rm-gcard-img" src={g.snapshot} alt="" /> : <span className="rm-gcard-img empty" />}
                <div className="rm-gcard-id">
                  <span className={`rm-qual ${q}`} />
                  <span className="rm-gcard-name">{g.display_name || "Guest"}</span>
                  <span className={`rm-kind ${participantKind(g)}`}>{kindBadge(g)}</span>
                  {onStage && <span className="rm-gcard-live">ON</span>}
                </div>
                {canControl && (
                  <div className="rm-gcard-ctl">
                    <button className="rm-row-edit" title="Move up the order" onClick={() => onOrder(g.id, -1)}>↑</button>
                    <button
                      className={`rm-guest-stage${onStage ? " on" : ""}${pendingRow ? " pending" : ""}`}
                      disabled={pendingRow}
                      title={
                        pendingRow
                          ? "Asked the host — waiting for its set to answer"
                          : onStage
                            ? "Ask the host to take them off the stage"
                            : "Ask the host to put them on the stage"
                      }
                      onClick={() => onStageToggle(g.id)}
                    >
                      {row === "pending-on" ? "Staging…" : row === "pending-off" ? "Leaving…" : onStage ? "On stage" : "Stage"}
                    </button>
                    <button className="rm-row-edit" title="Move down the order" onClick={() => onOrder(g.id, 1)}>↓</button>
                    <button className="rm-row-edit" title="Remove" onClick={() => onRemove(g.id)}>
                      {ic.x}
                    </button>
                  </div>
                )}
                {notice && <div className="rm-gcard-notice">{notice}</div>}
              </div>
            );
          })}
          {role === "host" && live.map((g) => {
            const ids = sourceIdsFor(g.id);
            const item = items.find((i) => i.id === ids.camera);
            // The share is its own source; the button exists only for a guest
            // who may share (media.screen) — grants decide, never the kind.
            const screenItem = resolveGrants(g).has("media.screen") ? items.find((i) => i.id === ids.screen) : undefined;
            const muted = item?.muted ?? false;
            const q = (g.quality ?? g.connection_quality ?? "unknown") as string;
            return (
              <div key={g.id} className={`rm-gcard${item?.visible ? " on" : ""}`}>
                {thumbs[ids.camera] ? (
                  <img className="rm-gcard-img" src={thumbs[ids.camera]} alt="" />
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
                  <span className={`rm-kind ${participantKind(g)}`}>{kindBadge(g)}</span>
                  {item?.visible && <span className="rm-gcard-live">ON</span>}
                </div>
                {/* Controls: the card is the feed; hands appear on hover. */}
                <div className="rm-gcard-ctl">
                  <button
                    className={`rm-guest-stage${item?.visible ? " on" : ""}`}
                    title={item?.visible ? "Take off screen (stays in the room)" : "Pop into the next free guest slot"}
                    disabled={!item}
                    data-warn={!item?.visible && q === "failing" ? "1" : undefined}
                    onClick={() => item && onShow(item.id, !item.visible)}
                  >
                    {item?.visible ? "On screen" : "Show"}
                  </button>
                  {screenItem && (
                    <button
                      className={`rm-guest-stage${screenItem.visible ? " on" : ""}`}
                      title={screenItem.visible ? "Take their screen off (they keep sharing)" : "Pop their screen share into the next free guest slot"}
                      onClick={() => onShow(screenItem.id, !screenItem.visible)}
                    >
                      {screenItem.visible ? "Screen on" : "Screen"}
                    </button>
                  )}
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

/** The host's MODS panel: the seats in the room (program-monitor rows —
 * never listed among the guests, founder rule), ONE row per member
 * (dedupeSeatRows), each with its name and its role read from TRUTH — the
 * room's grant roster joined by user, team editor+ = Host, never Host by
 * default (seatRoleLabel). For the HOST three media toggles per seat
 * (camera / mic / screen — the Jamie pattern; media grants are the host's
 * alone to give) and, once the seat holds media, ON SET toggles for the
 * camera and the screen: they place / remove the seat's MOD SOURCE (its own
 * kind, its own placement — never a guest slot; v0.4.32), with a readout of
 * what the set shows. "Seat someone" = a room role for a team member
 * through the same door the Access tab uses. */
function ModsPanel({
  seats,
  items,
  isHost,
  canManage,
  members,
  grants,
  onToggleGrant,
  onPlace,
  onSeat,
  error,
}: {
  seats: RoomGuest[];
  items: LiveItem[];
  isHost: boolean;
  canManage: boolean;
  members: Member[] | null;
  grants: RoomGrantRowLike[] | null;
  onToggleGrant: (seat: RoomGuest, grant: "media.camera" | "media.mic" | "media.screen", enabled: boolean) => void;
  onPlace: (seat: RoomGuest, track: ModFeedTrack, on: boolean) => void;
  onSeat: (memberId: string, role: "admin" | "editor" | "viewer") => void;
  error: string | null;
}) {
  const [pick, setPick] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("editor");
  const seated = new Set(seats.map((g) => seatUserId(g)).filter((x): x is string => !!x));
  const candidates = (members ?? []).filter((m) => !seated.has(m.user_id) && !(m.type === "team" && (m.role === "owner" || m.role === "admin" || m.role === "editor")));
  return (
    <div className="rm-mods">
      {seats.length === 0 && <div className="rm-rows-empty">No one is seated. A manager or mod who opens this room takes a seat here.</div>}
      {seats.map((g) => {
        const grants_ = resolveGrants(g);
        const ids = modSourceIdsFor(g.id);
        const cam = items.find((i) => i.id === ids.camera);
        const scr = grants_.has("media.screen") ? items.find((i) => i.id === ids.screen) : undefined;
        const media = isMediaSeat(g);
        const name = seatDisplayName(g);
        const roleLabel = seatRoleLabel({ seat: g, grants, members });
        const tg = (grant: "media.camera" | "media.mic" | "media.screen", icon: ReactNode, what: string) => {
          const on = grants_.has(grant);
          const tip = !isHost ? `Only the host gives ${what}` : on ? `Take ${what} back from ${name}` : `Give ${name} ${what}`;
          return (
            <button
              type="button"
              className={`rm-mod-tg${on ? " on" : ""}`}
              disabled={!isHost}
              title={tip}
              aria-label={tip}
              aria-pressed={on}
              onClick={() => onToggleGrant(g, grant, !on)}
            >
              {icon}
            </button>
          );
        };
        const onSet = !!cam?.visible;
        const scrOn = !!scr?.visible;
        const readout = !media
          ? "no media"
          : onSet && scrOn
            ? "on set · camera + screen"
            : onSet
              ? "on set · camera"
              : scrOn
                ? "on set · screen"
                : cam || scr
                  ? "off set"
                  : "feed connecting…";
        return (
          <div key={g.id} className="rm-mod-row">
            <div className="rm-mod-id">
              <span className="rm-mod-name">{name}</span>
              <span className="rm-mod-role" title="Role in this room, from the room's grants">{roleLabel}</span>
              {(onSet || scrOn) && <span className="rm-mod-onset">ON SET</span>}
            </div>
            <div className="rm-mod-media" role="group" aria-label={`${name}: media`}>
              {tg("media.camera", ic.cam, "camera")}
              {tg("media.mic", ic.mic, "mic")}
              {tg("media.screen", ic.screen, "screen")}
            </div>
            {media && (
              <div className="rm-mod-set">
                <span className="rm-mod-readout" title="What the host's set shows for this seat">
                  {readout}
                </span>
                {isHost && (
                  <>
                    <button
                      type="button"
                      className={`rm-guest-stage${onSet ? " on" : ""}`}
                      disabled={!cam}
                      aria-pressed={onSet}
                      title={onSet ? `Take ${name}'s camera off the set` : cam ? `Place ${name}'s camera on the set (mod feed, lower-right)` : "Their feed hasn't connected yet"}
                      onClick={() => cam && onPlace(g, "camera", !onSet)}
                    >
                      {ic.cam} {onSet ? "Camera on set" : "Camera"}
                    </button>
                    {scr && (
                      <button
                        type="button"
                        className={`rm-guest-stage${scrOn ? " on" : ""}`}
                        aria-pressed={scrOn}
                        title={scrOn ? `Take ${name}'s screen off the set` : `Place ${name}'s screen on the set (mod feed, full frame)`}
                        onClick={() => onPlace(g, "screen", !scrOn)}
                      >
                        {ic.screen} {scrOn ? "Screen on set" : "Screen"}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {canManage && (
        <div className="rm-mod-seat">
          <Select
            size="sm"
            value={pick}
            onChange={setPick}
            placeholder="Seat someone…"
            title="Seat a team member"
            options={[{ value: "", label: "Seat someone…" }, ...candidates.map((m) => ({ value: m.id, label: m.name || m.email }))]}
          />
          <Select
            size="sm"
            value={role}
            onChange={(v) => setRole(v as "editor")}
            title="Their role in this room"
            options={[
              { value: "editor", label: "Mod" },
              { value: "viewer", label: "Viewer" },
              { value: "admin", label: "Manager" },
            ]}
          />
          <button className="rm-guest-admit" disabled={!pick} onClick={() => { if (pick) { onSeat(pick, role); setPick(""); } }}>
            Seat
          </button>
        </div>
      )}
      {!canManage && seats.length > 0 && <div className="rm-mod-note">Seating someone is a manager's act — the Access tab.</div>}
      {error && <div className="rm-chatsetup-err">{error}</div>}
    </div>
  );
}

/** The run report (#50): every contribution of the run that just ended, with
 * its interval. Presence, screens, overlays, inputs — never a price. */
function RunReportSheet({
  report,
  roster,
  extras,
  onClose,
}: {
  report: { run_id: string | null; rows: Contribution[] };
  roster: RoomGuest[];
  extras: RoomExtra[];
  onClose: () => void;
}) {
  const who = (c: Contribution) => {
    if (c.participant_id) return roster.find((g) => g.id === c.participant_id)?.display_name ?? c.participant_id.slice(0, 8);
    if (c.kind === "overlay") {
      const sid = typeof c.binding.source_id === "string" ? c.binding.source_id : "";
      const ex = extras.find((e) => e.id === sid);
      const sponsor = typeof c.binding.sponsor === "string" ? c.binding.sponsor : null;
      return sponsor ? `${ex?.label ?? sid} · ${sponsor}` : ex?.label ?? sid;
    }
    if (c.kind === "input") return `${String(c.binding.participant_kind ?? "audience")} · ${String(c.metadata.count ?? "")} inputs`;
    return "Host";
  };
  const where = (c: Contribution) => {
    if (c.kind === "presence") return `slot ${Number(c.binding.slot ?? 0) + 1}`;
    if (c.kind === "media.screen") return "screen";
    if (c.kind === "input") return `vote ${String(c.binding.interaction_id ?? "").slice(0, 8)}`;
    return typeof c.binding.corner === "string" ? c.binding.corner : "overlay";
  };
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
  const secs = (c: Contribution) => (c.ended_at ? Math.max(0, Math.round((Date.parse(c.ended_at) - Date.parse(c.started_at)) / 1000)) : 0);
  const rows = [...report.rows].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const total = rows.filter((c) => c.kind === "presence").reduce((n, c) => n + secs(c), 0);
  return createPortal(
    <div className="rm-modal-backdrop" onClick={onClose}>
      <div className="rm-runreport" onClick={(e) => e.stopPropagation()}>
        <div className="rm-runreport-head">
          <strong>Run report</strong>
          <span className="rm-runreport-sub">
            {rows.length} contribution{rows.length === 1 ? "" : "s"} · {Math.floor(total / 60)}:{String(total % 60).padStart(2, "0")} on stage
          </span>
          <button className="rm-row-edit" onClick={onClose} title="Close">{ic.x}</button>
        </div>
        {rows.length === 0 ? (
          <div className="rm-rows-empty">Nothing was contributed this run — no guest on stage, no credited overlay, no vote.</div>
        ) : (
          <table className="rm-runreport-table">
            <thead>
              <tr><th>Who</th><th>What</th><th>Where</th><th>From</th><th>To</th><th>Length</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{who(c)}</td>
                  <td>{c.kind}</td>
                  <td>{where(c)}</td>
                  <td>{fmt(c.started_at)}</td>
                  <td>{fmt(c.ended_at)}</td>
                  <td>{c.ended_at ? `${secs(c)} s` : "open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>,
    document.body,
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
  locked = false,
}: {
  sourceId: string;
  sourceLabel: string;
  media: "video" | "audio";
  onBack: () => void;
  /** A non-host seat may look but not touch: every op but `list` refuses. */
  locked?: boolean;
}) {
  const [chain, setChain] = useState<FilterState[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(
    async (op: FilterOp) => {
      if (locked && op.op !== "list") {
        setErr(SET_IS_HOSTS);
        return;
      }
      try {
        setChain(await filtersIpc(sourceId, op));
        setErr(null);
      } catch (e) {
        setErr(String(e));
      }
    },
    [sourceId, locked],
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
            if (pr.showWhen && String(current.settings[pr.showWhen.key]) !== pr.showWhen.value) {
              return null;
            }
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
        {!locked && (
          <button className="rm-panel-plus" title="Add a filter" onClick={() => setAdding((a) => !a)}>
            {ic.plus}
          </button>
        )}
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
                : "Cutout removes your background with no green screen; colour correction fixes a dull camera."}
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
            {selfCaptureNote(w)}
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
  /** Attach in flight: syncs that land meanwhile must not attach AGAIN
   * (the engine ignores a second attach and their newer rect was lost —
   * the "stale frame on first join" bug). They park their rect here and
   * it is replayed as a move the moment the attach resolves. */
  const attaching = useRef(false);
  const pending = useRef<DOMRect | null>(null);
  const lastSent = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    // Coalesced on a MACROTASK, not an animation frame: once the native
    // preview sits over the webview WebKit may deem the page occluded and
    // halt rAF — a dock resize would then leave the stage misplaced until
    // frames resume. Timers keep running.
    let raf = 0;
    const send = async (r: DOMRect) => {
      lastSent.current = { x: r.x, y: r.y, w: r.width, h: r.height };
      await ipc.liveMovePreview(r.x, r.y, r.width, r.height);
    };
    const sync = () => {
      window.clearTimeout(raf);
      raf = window.setTimeout(async () => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return;
        try {
          if (attaching.current) {
            pending.current = r;
            return;
          }
          if (!attached.current) {
            attaching.current = true;
            // The attach call itself reports whether the stage can be a
            // transparent hole (preview behind the webview) — no polling.
            const transparent = await ipc.liveAttachPreview(r.x, r.y, r.width, r.height);
            lastSent.current = { x: r.x, y: r.y, w: r.width, h: r.height };
            attached.current = true;
            attaching.current = false;
            document.documentElement.dataset.stage = transparent ? "transparent" : "opaque";
            // Replay whatever the layout did while we were attaching — and
            // re-measure regardless: the rect at attach time is rarely final.
            const now = pending.current ?? el.getBoundingClientRect();
            pending.current = null;
            if (now.width >= 10 && now.height >= 10) await send(now);
          } else {
            await send(r);
          }
        } catch {
          attaching.current = false;
          // engine not ready yet; retry on next layout change
        }
      }, 0);
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    // Reconcile: a lost move (engine busy, event coalesced away) must not
    // leave the stage misplaced — every second, if the measured rect differs
    // from the last one sent, send it again.
    const tick = window.setInterval(() => {
      const el = ref.current;
      if (!el || !attached.current || attaching.current) return;
      const r = el.getBoundingClientRect();
      const l = lastSent.current;
      if (r.width < 10 || r.height < 10) return;
      if (!l || Math.abs(l.x - r.x) > 0.5 || Math.abs(l.y - r.y) > 0.5 || Math.abs(l.w - r.width) > 0.5 || Math.abs(l.h - r.height) > 0.5) {
        void send(r).catch(() => {});
      }
    }, 250);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(raf);
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
            <Select
              value={selected === "" ? "" : String(selected)}
              onChange={(v) => setSelected(v === "" ? "" : Number(v))}
              placeholder="Choose a window…"
              title="Window"
              options={[{ value: "", label: "Choose a window…" }, ...windows.map((w) => ({ value: String(w.id), label: `${w.owner}${w.title ? ` — ${w.title}` : ""}` }))]}
            />
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
  /** A mod feed: a shield with a dot — the seat's badge, not a guest's invite. */
  mod: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 8.5 4.1-.9 7-4.3 7-8.5V6z" />
      <circle cx="12" cy="11.5" r="2" fill="currentColor" stroke="none" />
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
  mod: ic.mod,
  overlay: ic.link,
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
/** One track per voice: the level meter IS the volume slider. Two parallel
 * lines said the same thing twice — the fill shows what's coming through,
 * the thumb on the same rail sets how much of it goes out. Draggable in
 * every form, the mini console included. */
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
  const track = useRef<HTMLDivElement | null>(null);
  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const el = track.current;
    if (!el || dead) return;
    const r = el.getBoundingClientRect();
    const t = horizontal ? (e.clientX - r.left) / r.width : 1 - (e.clientY - r.top) / r.height;
    const u = Math.max(0, Math.min(1, t));
    onVolume?.(u * u * u);
  };
  const lvl = Math.round((dead || muted ? 0 : level) * 100);
  return (
    <div className={`rm-strip${horizontal ? " horizontal" : ""}${dead ? " dead" : ""}`}>
      <div
        ref={track}
        className="rm-track"
        onPointerDown={(e) => {
          if (dead) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          fromEvent(e);
        }}
        onPointerMove={(e) => {
          if (dead || e.buttons !== 1) return;
          fromEvent(e);
        }}
      >
        <div
          className="rm-track-fill"
          style={horizontal ? { clipPath: `inset(0 ${100 - lvl}% 0 0)` } : { clipPath: `inset(${100 - lvl}% 0 0 0)` }}
        />
        <div
          className="rm-track-thumb"
          style={horizontal ? { left: `calc(${(dead ? 0.35 : ui) * 100}% - 7px)` } : { top: `calc(${(1 - (dead ? 0.35 : ui)) * 100}% - 7px)` }}
        />
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
        endpoint_id: existing ? undefined : activeEndpointId() ?? undefined,
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
        <Select value={preset} onChange={(v) => setPreset(v as LivePreset)} disabled={!!existing} title="Destination" options={PRESETS.map((p) => ({ value: p.value, label: p.label }))} />
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

/** The room whose document the ENGINE currently holds. The engine session
 * outlives this view — leaving for Home unmounts the React tree, not the
 * graph — so reopening the same room must reconcile against what is already
 * there rather than destroy and respawn it. Tearing every item down cost a
 * black stage, every CEF guest page re-created (renegotiation, "Connecting…",
 * a flash per guest) and every slot popping in at full frame before its look
 * landed. Module-scoped on purpose: it is a fact about the engine. */
let engineHeldRoom: string | null = null;

function useMonitorState(seat: ProgramMonitor | null): MonitorState | null {
  return useSyncExternalStore(
    (fn) => (seat ? seat.subscribe(fn) : () => {}),
    () => (seat ? seat.snapshot() : null),
    () => null,
  );
}

/** The off-host stage: the host's output, full-bleed, once it arrives;
 * one quiet line until then. Same 16:9 footprint as the native preview so
 * the docks never jump.
 *
 * Two pictures (lib/monitorFeed.ts): the video leg when it decodes frames
 * — counted HERE with requestVideoFrameCallback, the one signal that
 * cannot lie about a black or muted track — and the host's 8 fps preview
 * over the data channel when it does not. The placeholder names the real
 * cause once the host has said what its capture is doing. */
function ProgramMonitorStage({ seat, pending, boomin }: { seat: ProgramMonitor | null; pending: boolean; boomin: boolean }) {
  const st = useMonitorState(seat);
  const ref = useRef<HTMLVideoElement>(null);
  const stream = st?.hasProgram ? seat?.programStream() ?? null : null;
  useEffect(() => {
    const v = ref.current;
    if (!v || !seat) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (!stream) return;
    void v.play().catch(() => {});
    // Decoded-frame accounting: rVFC fires per presented frame; a track
    // that is "live" but delivers nothing never fires it.
    let alive = true;
    let handle = 0;
    const vv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
    const onFrame = () => {
      if (!alive) return;
      seat.noteFrame();
      if (vv.requestVideoFrameCallback) handle = vv.requestVideoFrameCallback(onFrame);
    };
    if (vv.requestVideoFrameCallback) {
      handle = vv.requestVideoFrameCallback(onFrame);
    } else {
      // No rVFC (older WebView2): count timeupdate as frames — coarse, honest enough.
      v.addEventListener("timeupdate", onFrame);
    }
    return () => {
      alive = false;
      if (vv.cancelVideoFrameCallback && handle) vv.cancelVideoFrameCallback(handle);
      v.removeEventListener("timeupdate", onFrame);
    };
  }, [stream, seat]);
  const showVideo = !!stream && !!st?.hasFrames;
  const showThumb = !showVideo && !!st?.onThumbs && !!st?.thumbUrl;
  const line = pending
    ? "Checking your seat…"
    : !boomin
      ? "Host's output — a mod link on an open server carries no return feed"
      : !seat || !st
        ? "Host's output — connecting…"
        : monitorPlaceholder({
            phase: st.phase,
            message: st.message,
            connected: st.phase === "live",
            programState: st.programState,
            stalled: st.stalled,
          });
  const has = showVideo || showThumb;
  return (
    <div className={`rm-canvas-msg rm-program-monitor${has ? " has-program" : ""}`}>
      <video ref={ref} className="rm-program-video" autoPlay playsInline muted hidden={!showVideo} />
      {showThumb && <img className="rm-program-video" src={st!.thumbUrl!} alt="" />}
      {!has && <span>{line}</span>}
      {has && <span className="rm-program-tag">HOST OUTPUT</span>}
      {showThumb && <span className="rm-program-tag rm-program-tag-fallback">Live · 8 fps preview</span>}
    </div>
  );
}

export function LiveView({
  room,
  onLeave,
  seat,
}: {
  room?: RoomInfo;
  onLeave?: () => void;
  /** GUEST MODE: this Producer holds a seat in someone else's room. The
   * stage is the guest's own scene (their camera); the green-room strip
   * above it is the seat. Leaving the view leaves the seat. */
  seat?: GuestSeatSpec;
}) {
  // Windows float mode: popovers/toasts over the stage are punched out of
  // the native preview so they stay visible. No-op elsewhere.
  useEffect(() => {
    installStageCutouts();
  }, []);
  const [destinations, setDestinations] = useState<LiveDestination[]>([]);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  /** 60-sample render-PRESSURE history for the stats chart (1 Hz): mean
   * render time over the frame budget, from the engine snapshot. */
  const [loadHist, setLoadHist] = useState<number[]>([]);
  const snapRef = useRef<LiveSnapshot | null>(null);
  const loadPrevRef = useRef<LiveSnapshot | null>(null);
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
  /** The room DOCUMENT has been pushed to the engine. Before this, "no
   * pending scene" means nothing — it is simply too early to know. */
  const [docApplied, setDocApplied] = useState(false);
  /** Mount instrumentation: wall-clock from mount to each gate. The footer
   * shows the total so every build proves (or disproves) a speedup. */
  // t0 is the CLICK on the home tile when we have it (what the user feels),
  // else this mount. `mount` = click→mount gap; `since_launch` = how long
  // the app had been up — a cold first open pays device warm-ups no later
  // open does.
  const mountT0 = useRef(takeRoomClick() ?? performance.now());
  const mountMarks = useRef<Record<string, number>>({
    mount: Math.round(performance.now() - mountT0.current),
    since_launch: Math.round(performance.now()),
    // App launch → home painted; the rest of since_launch is the human.
    home_painted: homePaintedMs() ?? -1,
  });
  const mark = (k: string) => {
    if (mountMarks.current[k] == null) mountMarks.current[k] = Math.round(performance.now() - mountT0.current);
  };
  const [mountMs, setMountMs] = useState<number | null>(null);
  /** Largest gap between 100ms ticks until the veil lifts — a ready room
   * that cannot paint for seconds is a MAIN-THREAD stall, not engine work. */
  const stallMax = useRef(0);
  useEffect(() => {
    let last = performance.now();
    const t = window.setInterval(() => {
      const now = performance.now();
      const gap = now - last - 100;
      if (gap > stallMax.current) stallMax.current = gap;
      last = now;
    }, 100);
    return () => window.clearInterval(t);
  }, []);
  /** sources_changed events seen — the settle signal is "one more than when
   * the mount apply started", never "the next one" (that consumed the
   * set-sources echo and settled BEFORE the scene was applied). */
  const srcEvCount = useRef(0);
  /** Set after the mount apply: the NEXT sources_changed from the engine is
   * the settle signal — the engine acknowledging the transforms — instead
   * of a timer guessing how long that takes. */
  const settleOnSources = useRef(false);
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
  /** The canvas height the engine reports (720 until it does) — read by the
   * mod-feed placement, which works in canvas fractions (lib/modFeed.ts). */
  const vhRef = useRef(720);
  /** First PIXELS, per source. The engine's has_frame only reaches React on
   * a sources_changed edge, so we POLL engine truth every 100ms from the
   * moment the document is applied: each visible item's first-frame time is
   * recorded by id, and the report is re-written when the last one lands
   * (or at 10s, naming who never did). This names the culprit — camera,
   * screen capture, overlay — instead of a total. */
  const firstFramesDone = useRef(false);
  /** The gate the veil actually waits on: every visible source has produced
   * a frame (or the cap fired). `pendingFrames` names who is still black so
   * the veil can say "Starting camera…" instead of hiding a black stage. */
  const [framesReady, setFramesReady] = useState(false);
  const [pendingFrames, setPendingFrames] = useState<string[]>([]);
  // The frame cap: 2.5s after the document lands, stop waiting for pixels
  // and show the stage as it is — a black source beats a trapped user.
  const [framesCapped, setFramesCapped] = useState(false);
  useEffect(() => {
    if (!docApplied) return;
    const t = window.setTimeout(() => setFramesCapped(true), 2500);
    return () => window.clearTimeout(t);
  }, [docApplied]);
  useEffect(() => {
    if (firstFramesDone.current || !docApplied) return;
    let alive = true;
    const seen: Record<string, number> = {};
    const t0 = performance.now();
    const finish = (pending: string[]) => {
      if (!alive || firstFramesDone.current) return;
      firstFramesDone.current = true;
      setFramesReady(true);
      setPendingFrames([]);
      mark("first_frames");
      const m = mountMarks.current;
      roomOpenReport({
        ...m,
        first_frame_by_item: seen,
        never_framed: pending,
        stall_max_ms: Math.round(stallMax.current),
        boot_phases: snapRef.current?.boot_phases_ms ?? null,
        at: new Date().toISOString(),
      }).catch(() => {});
    };
    const tick = async () => {
      if (!alive) return;
      const snap = await ipc.liveEngineStatus().catch(() => null);
      if (!alive) return;
      const items = (snap?.sources?.items ?? []).filter((i) => i.visible);
      for (const i of items) if (i.has_frame && seen[i.id] == null) seen[i.id] = Math.round(performance.now() - mountT0.current);
      const pending = items.filter((i) => !i.has_frame).map((i) => i.id);
      setPendingFrames((p) => (p.length === pending.length && p.every((x, k) => x === pending[k]) ? p : pending));
      if (items.length && pending.length === 0) return finish([]);
      if (performance.now() - t0 > 10_000) return finish(pending);
      window.setTimeout(tick, 100);
    };
    void tick();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docApplied]);
  const [micLevel, setMicLevel] = useState(0);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  type RepoRelease = { tag_name: string; name: string | null; body: string | null; published_at: string; html_url: string };
  const [releases, setReleases] = useState<RepoRelease[] | null | "err">(null);
  useEffect(() => {
    fetch("https://api.github.com/repos/Boomin-Ai/producer/releases?per_page=15")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((rs: RepoRelease[]) => setReleases(rs))
      .catch(() => setReleases("err"));
  }, []);
  useEffect(() => {
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setAppVersion).catch(() => {});
  }, []);
  /** Per-source meter levels for audio-bearing extras (guests, media). */
  const [extraLevels, setExtraLevels] = useState<Record<string, number>>({});
  const [sheetOpen, setSheetOpen] = useState(true);
  // Every dock retracts, same grammar everywhere: its boundary handle DRAGS
  // to resize and CLICKS to hide/show.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [topOpen, setTopOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [linkMenuOpen, setLinkMenuOpen] = useState(false);
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
        // Guest layers never appear in this list (slots own their geometry
        // and z), so the rendered order IS the full reorder set.
        const expanded = order;
        (async () => {
          for (let i = expanded.length - 1; i >= 0; i--) {
            const z = expanded.length - 1 - i;
            try {
              await ipc.liveSetTransform(itemId(expanded[i]), { z }, i === 0);
            } catch {
              /* engine not ready */
            }
          }
          captureActiveLook();
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
    kind: "bottom" | "left" | "right" | "top";
    startX: number;
    startY: number;
    /** Pair resizes drag along the dock's own axis; dock resizes drag across it. */
    axis: "x" | "y";
    /** Set once the pointer travels — an unmoved release is a CLICK (retract). */
    moved?: boolean;
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
  /** Weights are earned per dock; legacy bare keys were bottom-row drags. */
  const weightOf = (dock: Dock, id: PanelId): number | undefined =>
    shown.weights?.[`${dock}:${id}`] ?? (dock === "bottom" ? shown.weights?.[id] : undefined);
  /** A short bottom dock IS the top form — the form system has one slim axis,
   * so panels collapse into exactly the console shapes they wear up top. */
  const bottomSlim = !!shown.bottom && shown.bottom <= ROW_SNAP;
  const topExpanded = !!shown.top && shown.top > ROW_SNAP;
  /** Form follows SIZE, not dock identity: a short row dock wears the console
   * (top) forms, an expanded one wears the full (bottom) forms — top and
   * bottom are the same axis at different heights. */
  const formDockOf = (id: PanelId): Dock => {
    const d = dockOf(layout, id);
    if (d === "bottom" && bottomSlim) return "top";
    if (d === "top" && topExpanded) return "bottom";
    return d;
  };

  const beginResize = (
    e: React.PointerEvent,
    kind: "bottom" | "left" | "right" | "top",
    a?: PanelId,
    b?: PanelId,
    open = true,
  ) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!open) {
      // A closed dock's handle can only be clicked open — nothing to resize.
      resize.current = null;
      return;
    }
    if (a && b) {
      // PAIR resize — neighbours trade weight along the dock's own axis:
      // side docks stack, so the slider runs up/down; top and bottom flow,
      // so it runs left/right.
      const axis: "x" | "y" = kind === "left" || kind === "right" ? "y" : "x";
      const dim = (el: HTMLElement | null) =>
        (axis === "x" ? el?.getBoundingClientRect().width : el?.getBoundingClientRect().height) ?? 1;
      resize.current = {
        kind,
        axis,
        startX: e.clientX,
        startY: e.clientY,
        a,
        b,
        aW: weightOf(kind, a) ?? 1,
        bW: weightOf(kind, b) ?? 1,
        aPx: dim(document.querySelector<HTMLElement>(`[data-panel="${a}"]`)),
        bPx: dim(document.querySelector<HTMLElement>(`[data-panel="${b}"]`)),
      };
    } else {
      // DOCK resize — the boundary handle drags across the dock.
      const axis: "x" | "y" = kind === "left" || kind === "right" ? "x" : "y";
      const el = document.querySelector<HTMLElement>(`[data-dock="${kind}"]`);
      const rect = el?.getBoundingClientRect();
      resize.current = {
        kind,
        axis,
        startX: e.clientX,
        startY: e.clientY,
        startPx: (axis === "x" ? rect?.width : rect?.height) ?? (kind === "top" ? ROW_MINI : SIDE_MIN),
      };
    }
    setLiveSizes(sizes);
  };

  const moveResize = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r || e.buttons !== 1) return;
    const d = r.axis === "y" ? e.clientY - r.startY : e.clientX - r.startX;
    if (!r.moved && Math.abs(d) <= 4) return; // still a click until it travels
    r.moved = true;
    if (r.a && r.b) {
      // Weights are proportional to measured pixels, so a drag moves the
      // divider by exactly the distance travelled.
      const floor = r.axis === "y" ? 100 : 140;
      const total = (r.aPx ?? 1) + (r.bPx ?? 1);
      const totalW = (r.aW ?? 1) + (r.bW ?? 1);
      const aPx = Math.max(floor, Math.min(total - floor, (r.aPx ?? 1) + d));
      const aW = (aPx / total) * totalW;
      setLiveSizes({
        ...sizes,
        weights: { ...sizes.weights, [`${r.kind}:${r.a}`]: aW, [`${r.kind}:${r.b}`]: totalW - aW },
      });
    } else {
      // Handles sit on the stage side of every dock, so growth is always a
      // drag TOWARD the stage: left +, right −, top +, bottom −.
      const raw = r.kind === "left" || r.kind === "top" ? (r.startPx ?? 0) + d : (r.startPx ?? 0) - d;
      // Row docks have a universal MINI view: under the snap threshold they
      // warp straight to ROW_MINI (console form for every panel) instead of
      // lingering at broken in-between heights.
      const px =
        r.kind === "top" || r.kind === "bottom"
          ? raw < ROW_SNAP
            ? ROW_MINI
            : Math.min(r.kind === "top" ? TOP_MAX : BOTTOM_MAX, raw)
          : Math.max(SIDE_MIN, Math.min(SIDE_MAX, raw));
      setLiveSizes({ ...sizes, [r.kind]: px });
    }
  };

  /** Release. An unmoved release on a dock handle is a CLICK — retract. */
  const endResize = (toggle?: () => void) => {
    const r = resize.current;
    resize.current = null;
    if (!r) {
      toggle?.();
      return;
    }
    if (!r.moved) {
      setLiveSizes(null);
      toggle?.();
      return;
    }
    const final = liveSizesRef.current;
    if (final) setSizes(final);
    setLiveSizes(null);
  };

  const splitter = (
    kind: "bottom" | "left" | "right" | "top",
    a?: PanelId,
    b?: PanelId,
    dockCtl?: { open: boolean; onToggle: () => void },
  ) => (
    <div
      className={`rm-split ${
        a
          ? kind === "left" || kind === "right"
            ? "rm-split-row"
            : "rm-split-v"
          : "rm-split-h"
      }${dockCtl && !dockCtl.open ? " closed" : ""}`}
      title={a ? "Drag to resize" : dockCtl?.open ? "Drag to resize — click to hide" : "Show this dock"}
      onPointerDown={(e) => beginResize(e, kind, a, b, dockCtl ? dockCtl.open : true)}
      onPointerMove={moveResize}
      onPointerUp={() => endResize(dockCtl?.onToggle)}
      onPointerCancel={() => endResize()}
    >
      <span className="rm-split-grab" />
    </div>
  );
  const scenes: RoomScene[] = cfg.scenes.length ? cfg.scenes : DEFAULT_SCENES;
  /** Overlay config drills IN like Filters — a menu inside the Sources
   * panel, never a popout over the stage. */
  const [overlayInline, setOverlayInline] = useState(false);
  /** The stage's selected item — mirrored into the Sources rail highlight. */
  const [stageSel, setStageSel] = useState<string | null>(null);
  /** Delete on the stage keymap: same effect as the row's ✕, per kind. */
  const deleteStageItem = (id: string) => {
    if (refuseSetEdit()) return;
    if (id === "screen" || id === "camera" || id === "overlay") return removeCoreSource(id);
    const it = (sources.items ?? []).find((i) => i.id === id);
    if (!it) return;
    if (it.kind === "guest") return void hideGuestFromSlot(id);
    if (it.kind === "mod") {
      const owner = modSourceOwner(id, liveRowsRef.current);
      if (owner) removeModFeed(owner.row.id, owner.track, "stage delete");
      return;
    }
    void removeExtraSource(id);
  };
  const videoApplied = useRef(false);
  const channelsApplied = useRef(false);
  const demoVideoSet = useRef(false);
  const demo = demoOn();
  const [chatOn, setChatOn] = useState<Record<string, boolean>>({ twitch: true, kick: true, youtube: true });
  const [chatChipsOpen, setChatChipsOpen] = useState(false);
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
  const guestSeat = useGuestSeat(seat, vcamState?.device_name);
  const [vcamOn, setVcamOn] = useState(false);
  const vcamOnRef = useRef(false);
  vcamOnRef.current = vcamOn;
  const vcamStateRef = useRef<VcamStatus | null>(null);
  vcamStateRef.current = vcamState;
  /** The virtual camera was started FOR a monitor seat (lib/monitorFeed.ts),
   * not by the host: it stops when the last monitor leaves. A manual toggle
   * takes ownership back. */
  const vcamAutoRef = useRef(false);
  const vcamAutoNextTry = useRef(0);

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
    // The host's own hand on the switch: whatever a monitor started, the
    // host owns it from here.
    vcamAutoRef.current = false;
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
  /** The endpoint's base URL — the API the program-monitor leg talks to
   * directly from this webview (lib/monitorFeed.ts). */
  const endpointBaseRef = useRef<string | null>(null);
  // ── The program monitor (lib/monitorFeed.ts) ─────────────────────────
  // Off-host on a Boomin room the stage shows the HOST's program: a
  // return-feed-only participant row is minted for this seat and received
  // here, in the webview. On the host, one sender per monitor row on the
  // roster pushes the virtual camera to it. Neither touches the engine.
  const monitorRef = useRef<ProgramMonitor | null>(null);
  const monitorStartedFor = useRef<string | null>(null);
  const [monitorSeat, setMonitorSeat] = useState<ProgramMonitor | null>(null);
  const monitorSenders = useRef<Map<string, MonitorSender>>(new Map());
  // ── A seat WITH MEDIA (lib/seatMedia.ts, the Jamie pattern) ──────────
  // When the host hands this seat camera / mic / screen, its monitor row
  // becomes a sending participant: the receive-only leg above is replaced
  // by the guest-page leg on the SAME row (camera + mic on peer main, the
  // screen on peer screen, the program back as the return feed).
  const mediaLegRef = useRef<SeatMediaLeg | null>(null);
  const [mediaLeg, setMediaLeg] = useState<SeatMediaLeg | null>(null);
  /** This seat's own participant row: id + join URL from `POST …/monitor`,
   * and the media it holds (re-read off the roster every tick). */
  const mySeatRef = useRef<{ id: string; joinUrl: string; media: string } | null>(null);
  const [mySeatId, setMySeatId] = useState<string | null>(null);
  const [myGrants, setMyGrants] = useState<Set<string>>(() => new Set());
  /** HOST: the seats in the room (monitor rows) for the Mods panel — never
   * in `roster` (the guests panel never lists them, founder rule). */
  const [seatRows, setSeatRows] = useState<RoomGuest[]>([]);
  /** HOST: everything that may be on the set — guests, plus seats holding
   * media. The stage truth and the reconcile read THIS, not `roster`. */
  const liveRowsRef = useRef<RoomGuest[]>([]);
  const [members, setMembers] = useState<Member[] | null>(null);
  /** The room's grant roster (`GET …/access` → `grants`, a manager's view):
   * what the Mods panel's role label is READ from. Null = not a manager,
   * or not answered yet — the label then falls back to team standing. */
  const [roomGrants, setRoomGrants] = useState<RoomGrantRowLike[] | null>(null);
  const [modsErr, setModsErr] = useState<string | null>(null);
  /** The board's own layout (lib/modBoard.ts), saved per seat. */
  const [boardLayout, setBoardLayout] = useState<ModBoardLayout>(DEFAULT_MOD_BOARD);
  useEffect(() => {
    let alive = true;
    prefGet(MOD_BOARD_PREF)
      .then((v) => alive && setBoardLayout(normalizeModBoard(v)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  /** The engine's program thumb runs while ANY monitor seat asked for it. */
  const programThumbOn = useRef(false);
  const monitorThumbDemand = () => {
    const want = [...monitorSenders.current.values()].some((s) => s.wantsThumbs());
    if (want === programThumbOn.current) return;
    programThumbOn.current = want;
    monitorLog(`host: program thumb ${want ? "on" : "off"}`);
    ipc.liveSetProgramThumb(want).catch((e) => monitorLog(`host: program thumb toggle failed: ${String(e)}`));
  };
  /** Room-owned facts every monitor seat reads (chat handles). */
  const roomInfoRef = useRef<MonitorRoomInfo>({});
  // Who WE are in this room. "host" until the access route says otherwise
  // (and forever, on a server without the route). A mod's Producer must not
  // load guest render pages — those would be a second host peer on every
  // guest's channel — nor post a stage list derived from its own engine.
  const [roomRole, setRoomRole] = useState<RoomRole>("host");
  const roomRoleRef = useRef<RoomRole>("host");
  const accessAsked = useRef(false);
  const accessTries = useRef(0);
  /** The whole answer (role · via · can) — what the role card shows and
   * what the host-only chrome is gated on. Assumed host until the route
   * answers; `known` says whether it did. */
  const [roomAccess, setRoomAccess] = useState<RoomAccessInfo>(() => ({ role: "host", via: "server", can: capabilitiesOf("host"), known: false }));
  /** A Boomin room whose access route hasn't answered yet: the host chrome
   * stays hidden rather than flashing GO LIVE at a mod. */
  const [accessPending, setAccessPending] = useState(false);
  const isHost = setEditingAllowed({ role: roomRole }, accessPending);
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  /** Belt and braces under the hidden chrome: every set-editing IPC path
   * refuses on a non-host seat, with the banner, so a stray handler (a
   * keyboard shortcut, a stale popover) cannot edit the host's set. */
  const refuseSetEdit = (): boolean => {
    if (isHostRef.current) return false;
    setBanner(SET_IS_HOSTS);
    return true;
  };
  /** The room's server is Boomin (a brand-scoped endpoint) rather than an
   * open server: the room channel, votes, overlays and the run then use
   * Boomin's routes (lib/boominRoom.ts). Resolved with the endpoint. */
  const [boominRoom, setBoominRoom] = useState(false);
  const boominRoomRef = useRef(false);
  /** Honest staging (lib/stageTruth.ts): the HOST's confirmed stage list
   * with this seat's one pending ask overlaid. Driven by `stage` frames off
   * the room channel; the ref composes events synchronously. */
  const [modStage, setModStage] = useState<ModStageState>(EMPTY_MOD_STAGE);
  const modStageRef = useRef<ModStageState>(EMPTY_MOD_STAGE);
  const dispatchStage = (ev: ModStageEvent) => {
    const next = modStageReduce(modStageRef.current, ev);
    if (next === modStageRef.current) return;
    modStageRef.current = next;
    setModStage(next);
  };
  // The host's-silence clock: a pending ask expires into a message.
  useEffect(() => {
    const t = window.setInterval(() => dispatchStage({ type: "tick", now: Date.now() }), 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** The last stage version THIS host posted — a frame no newer is our echo. */
  const hostPostedVersionRef = useRef(0);
  const noteHostPosted = (res: unknown) => {
    const v = (res as { version?: unknown } | null)?.version;
    if (typeof v === "number" && v > hostPostedVersionRef.current) hostPostedVersionRef.current = v;
  };
  // Which guests the auto-layout last arranged. The tick may not re-flow an
  // unchanged set: the host dragging a guest smaller must WIN — auto-layout
  // exists for joins/leaves, not as a 3-second undo of manual placement.
  // Last stage list we told the server about (sorted, joined). The tick runs
  // every 3s but the stage rarely changes — an unchanged list is not news.
  const stagePostedRef = useRef<string | null>(null);

  /** Bring a guest on or off screen with a dissolve rather than a cut.
   * Guests appear and vanish while the show is LIVE, so a hard pop is visible
   * to the audience — and we already have the opacity path the fade
   * transition uses. Audio moves with the picture. */
  /** Scene furniture: gslot-N extras, sorted. */
  const slotItems = () =>
    (sources.items ?? []).filter((i) => i.id.startsWith("gslot-")).sort((a, b) => a.id.localeCompare(b.id));
  const freeSlot = () => {
    const b = cfgRef.current.slot_bindings ?? {};
    const liveIds = new Set((sources.items ?? []).map((i) => i.id));
    return slotItems().find((sl) => !b[sl.id] || !liveIds.has(b[sl.id]));
  };
  /** Show = pop the guest INTO a designed slot. No slot, no show — and the
   * caller learns which (a mod's request is answered with the truth). */
  const showGuestInSlot = async (guestItemId: string): Promise<boolean> => {
    const sl = freeSlot();
    if (!sl) {
      setBanner("Scene is full — add a Guest slot (Sources → + → Guest slot)");
      return false;
    }
    const b = cfgRef.current.slot_bindings ?? {};
    writeCfg({ ...cfgRef.current, slot_bindings: { ...b, [sl.id]: guestItemId } });
    await ipc.liveSetTransform(sl.id, { visible: false }, true).catch(() => {});
    await ipc
      .liveSetTransform(guestItemId, { x: sl.x, y: sl.y, w: sl.w, h: sl.h, z: sl.z, visible: false }, true)
      .catch(() => {});
    fadeGuest(guestItemId, true);
    return true;
  };
  /** Hide = pop out; the slot placeholder returns exactly where it was. */
  const hideGuestFromSlot = (guestItemId: string) => {
    const b = cfgRef.current.slot_bindings ?? {};
    const slotId = Object.keys(b).find((k) => b[k] === guestItemId);
    if (slotId) {
      const nb = { ...b };
      delete nb[slotId];
      writeCfg({ ...cfgRef.current, slot_bindings: nb });
      ipc.liveSetTransform(slotId, { visible: true }, true).catch(() => {});
    }
    fadeGuest(guestItemId, false);
  };

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

  // ── MOD FEEDS (v0.4.32): the seat's own source kind on the set ─────────
  // A seat's feed is `mod-<uuid8>` (camera + mic page) / `-screen` (share).
  // Placing it is NOT a slot: it takes its remembered rect (default:
  // lower-right PiP for the camera, full frame for the screen), the layer
  // just under the overlays, and opens a contribution interval bound
  // `{kind:"mod", track}`; removing closes it. Nothing here touches
  // slot_bindings — slot math never sees a mod row.
  const modPlacedRef = useRef<Map<string, boolean>>(new Map());
  const placeModFeed = async (participantId: string, track: ModFeedTrack, why: string): Promise<boolean> => {
    const id = modSourceIdsFor(participantId)[track];
    const items = sourcesRef.current.items ?? [];
    const it = items.find((i) => i.id === id);
    if (!it) {
      monitorLog(`host: mod feed ${id} not placed (${why}) — the source is not on the graph yet`);
      return false;
    }
    const bw = (vhRef.current * 16) / 9;
    const bh = vhRef.current;
    const rect = toCanvas(modFeedRect(cfgRef.current.mod_feeds, participantId, track), bw, bh);
    const z = modFeedZ(items.filter((i) => i.id !== id));
    await ipc.liveSetTransform(id, { ...rect, z, visible: false }, true).catch(() => {});
    fadeGuest(id, true);
    // Remember the rect (the default becomes explicit the first time).
    const feeds = rememberModFeed(cfgRef.current.mod_feeds, participantId, track, modFeedRect(cfgRef.current.mod_feeds, participantId, track));
    writeCfg({ ...cfgRef.current, mod_feeds: feeds });
    modLedger(participantId, track, id, true);
    monitorLog(`host: mod feed ${id} placed (${why}) at ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}×${Math.round(rect.h)} z${z}`);
    return true;
  };
  const removeModFeed = (participantId: string, track: ModFeedTrack, why: string) => {
    const id = modSourceIdsFor(participantId)[track];
    const it = (sourcesRef.current.items ?? []).find((i) => i.id === id);
    if (it?.visible) fadeGuest(id, false);
    modLedger(participantId, track, id, false);
    monitorLog(`host: mod feed ${id} removed (${why})`);
  };
  /** The ledger half: one open interval per placed mod feed, bound
   * `{kind:"mod", track, participant_id, source_id}` — closed on remove,
   * on the row leaving, and at End (the overlay path closes with it). */
  const modLedger = (participantId: string, track: ModFeedTrack, sourceId: string, shown: boolean) => {
    const ep = endpointRef.current;
    const sid = cfgRef.current.server_room_id;
    if (!ep || !sid || !boominRoomRef.current) return;
    const was = modPlacedRef.current.get(sourceId) ?? false;
    if (was === shown) return;
    modPlacedRef.current.set(sourceId, shown);
    const row = liveRowsRef.current.find((g) => g.id === participantId);
    const label = row ? modSourceLabel(row, track) : sourceId;
    guestsIpc.overlay(ep, sid, sourceId, { kind: "mod", track, participant_id: participantId }, shown, label).catch((e) => monitorLog(`host: mod ledger ${shown ? "open" : "close"} failed: ${String(e)}`));
  };
  /** The stage editor moved / resized a placed mod feed: remember the rect
   * as canvas fractions so the next placement (and the next session) lands
   * there. */
  const rememberModPlacement = (id: string, patch: LiveTransformPatch) => {
    if (!isModSourceId(id)) return;
    const owner = modSourceOwner(id, liveRowsRef.current);
    if (!owner) return;
    const it = (sourcesRef.current.items ?? []).find((i) => i.id === id);
    if (!it) return;
    const g = { x: patch.x ?? it.x, y: patch.y ?? it.y, w: patch.w ?? it.w, h: patch.h ?? it.h };
    const bw = (vhRef.current * 16) / 9;
    const rect = fromCanvas(g, bw, vhRef.current);
    writeCfg({ ...cfgRef.current, mod_feeds: rememberModFeed(cfgRef.current.mod_feeds, owner.row.id, owner.track, rect) });
  };

  const admitGuest = async (id: string) => {
    if (!endpointRef.current || !cfg.server_room_id) return;
    // The guest's return video IS the virtual camera — the render page opens
    // it as a capture device and sends it down the peer connection it already
    // holds. Start it on admit so nobody discovers it was off after someone
    // is already talking into oblivion.
    if (roomRoleRef.current === "host" && !vcamOn && vcamState?.installed) {
      await vcamIpc.output(true).catch(() => {});
    }
    await guestsIpc.admit(endpointRef.current, cfg.server_room_id, id).catch((e) =>
      setGuestErr(String(e).replace(/^Error:\s*/, "")),
    );
  };

  const removeGuest = async (id: string) => {
    if (!endpointRef.current || !cfg.server_room_id) return;
    try {
      await guestsIpc.revoke(endpointRef.current, id);
      rosterTickRef.current?.();
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  /** The set's truth as guest ids: guest sources SHOWN by the engine, plus
   * guests already BOUND to a slot (placed a moment ago; the engine's
   * visibility echo lands a frame later) — mapped back through the roster. */
  const shownGuestIds = (): string[] => {
    const live = liveRowsRef.current.filter((g) => !!g.render_url);
    const visible = new Set((sourcesRef.current.items ?? []).filter((i) => (i.kind === "guest" || i.kind === "mod") && i.visible).map((i) => i.id));
    const bound = new Set(Object.values(cfgRef.current.slot_bindings ?? {}));
    return live
      .filter((g) =>
        isMonitor(g)
          ? // A seat is on the set when its MOD camera feed is placed (v0.4.32).
            visible.has(modSourceIdsFor(g.id).camera)
          : visible.has(sourceIdsFor(g.id).camera) || bound.has(sourceIdsFor(g.id).camera),
      )
      .map((g) => g.id);
  };
  const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  /** Host: post the stage list UNCONDITIONALLY — after acting on a mod's
   * request the version must bump even when nothing changed, or the mod's
   * row never learns the answer (lib/stageTruth.ts). */
  const postStageTruth = async (ids: string[], why: string) => {
    if (!endpointRef.current || !cfg.server_room_id) return;
    const sorted = [...ids].sort();
    stagePostedRef.current = sorted.join(",");
    try {
      const res = await guestsIpc.setStage(endpointRef.current, cfg.server_room_id, sorted);
      noteHostPosted(res);
      monitorLog(`host: stage posted (${why}) → [${sorted.map((x) => x.slice(0, 8)).join(", ")}] v${hostPostedVersionRef.current}`);
    } catch (e) {
      stagePostedRef.current = null; // the tick retries
      monitorLog(`host: stage post failed (${why}): ${String(e)}`);
    }
  };
  /** A `stage` frame off the room channel. Host: a mod's request (unless it
   * is our own echo) — act on the set, then post what the set actually
   * shows. Mod: the reducer decides whether it is an echo or the answer. */
  const onStageFrameRef = useRef<((onStage: string[], version: number) => void) | null>(null);
  onStageFrameRef.current = (onStage, version) => {
    if (roomRoleRef.current !== "host") {
      dispatchStage({ type: "frame", on_stage: onStage, version, now: Date.now() });
      return;
    }
    if (isOwnEcho(version, hostPostedVersionRef.current)) return;
    if (!roomApplied.current) return; // the set is not mounted; the tick posts the truth when it is
    const live = liveRowsRef.current.filter((g) => !!g.render_url);
    const shown = shownGuestIds();
    // The server pushes the frame BEFORE our own POST resolves, so the
    // version alone cannot tell our echo from a request: a list equal to
    // the set's truth is nothing to act on — and answering it would post
    // again, echo again, forever.
    if (sameIds(onStage, shown)) return;
    // Seats go through the MOD path — their own source, never a slot.
    const seats = live.filter((g) => isMonitor(g)).map((g) => g.id);
    const plan = hostStagePlan({ requested: onStage, shown, admitted: live.map((g) => g.id), seats });
    monitorLog(`host: stage request v${version} — show [${plan.toShow.map((x) => x.slice(0, 8)).join(", ")}] hide [${plan.toHide.map((x) => x.slice(0, 8)).join(", ")}] place-mod [${plan.toPlaceMod.map((x) => x.slice(0, 8)).join(", ")}] remove-mod [${plan.toRemoveMod.map((x) => x.slice(0, 8)).join(", ")}]`);
    void (async () => {
      const placed: string[] = [];
      const refused: string[] = [];
      for (const gid of plan.toShow) {
        const ok = await showGuestInSlot(sourceIdsFor(gid).camera);
        (ok ? placed : refused).push(gid);
      }
      for (const gid of plan.toHide) hideGuestFromSlot(sourceIdsFor(gid).camera);
      for (const pid of plan.toPlaceMod) {
        // "Place my camera": the mod camera feed at its own rect. A seat
        // that is also sharing gets its screen from the share interval.
        const ok = await placeModFeed(pid, "camera", "throw up");
        (ok ? placed : refused).push(pid);
        if (ok && pendingSeatShare.current.delete(pid)) void placeModFeed(pid, "screen", "share pending");
      }
      for (const pid of plan.toRemoveMod) {
        removeModFeed(pid, "camera", "take down");
        removeModFeed(pid, "screen", "take down");
      }
      const refusedGuests = refused.filter((id) => !seats.includes(id));
      if (refusedGuests.length) {
        const names = refusedGuests.map((gid) => live.find((x) => x.id === gid)?.display_name || "a guest").join(", ");
        setBanner(`A mod asked to stage ${names} — no free guest slot. Add one: Sources → + → Guest slot`);
        window.setTimeout(() => setBanner(null), 8000);
      }
      // The truth the set is about to show: what stayed, plus what was
      // placed (the engine's visibility echo lands a frame later).
      const hide = new Set([...plan.toHide, ...plan.toRemoveMod]);
      const truth = [...shown.filter((id) => !hide.has(id)), ...placed];
      await postStageTruth(truth, refused.length ? "mod request, partly refused" : "mod request");
    })();
  };

  /** A seat's SHARE as server truth: its `media.screen` interval opening /
   * closing on the room channel (lib/seatMedia.ts announces it). Host: a
   * seat that is ON THE SET (camera placed, or being placed) gets its MOD
   * SCREEN feed placed full-frame; the interval closing takes it down.
   * A seat not on the set: nothing — "place my screen" is the seat's
   * throw-up, which stages the seat first. */
  const onSeatShareRef = useRef<((c: Contribution, opened: boolean) => void) | null>(null);
  onSeatShareRef.current = (c, opened) => {
    if (roomRoleRef.current !== "host" || c.kind !== "media.screen" || !c.participant_id) return;
    const row = liveRowsRef.current.find((g) => g.id === c.participant_id);
    if (!row || !isMonitor(row)) return;
    if (!opened) {
      removeModFeed(row.id, "screen", "share ended");
      return;
    }
    const ids = modSourceIdsFor(row.id);
    const cam = (sourcesRef.current.items ?? []).find((i) => i.id === ids.camera);
    if (!cam?.visible) {
      monitorLog(`host: seat ${row.id.slice(0, 8)} is sharing but not on the set — waiting for its throw-up`);
      pendingSeatShare.current.add(row.id);
      return;
    }
    void placeModFeed(row.id, "screen", "share started");
  };
  /** Seats sharing while off the set: their screen lands when they come on. */
  const pendingSeatShare = useRef<Set<string>>(new Set());

  /** Mod: ASK the host to put a guest on or off the stage. The server takes
   * the full list (a dropped call is corrected by the next one) and echoes
   * it; the row stays pending until the HOST posts what its set did
   * (lib/stageTruth.ts) — nothing here is optimistic. */
  const modStageToggle = async (guestId: string) => {
    if (!endpointRef.current || !cfg.server_room_id) return;
    const st = modStageRef.current;
    if (st.pending) return; // one ask at a time; the host answers in order
    const { on_stage, want } = modStageWish(st, guestId);
    dispatchStage({ type: "dismiss", guestId });
    try {
      const res = (await guestsIpc.setStage(endpointRef.current, cfg.server_room_id, on_stage)) as { version?: unknown } | null;
      const version = typeof res?.version === "number" ? res.version : st.version + 1;
      dispatchStage({ type: "request", guestId, want, version, now: Date.now() });
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      dispatchStage({ type: "request-failed", guestId, error: /stage_full|holds/i.test(msg) ? "The server's stage is full — ask the host" : msg });
    }
  };
  /** The roster tick, callable from an action: order/remove are server
   * truth, so the panel re-reads instead of guessing. */
  const rosterTickRef = useRef<(() => void) | null>(null);

  /** Mod: nudge a guest one step in the slot order and post the full list. */
  const modOrder = async (guestId: string, dir: -1 | 1) => {
    if (!endpointRef.current || !cfg.server_room_id) return;
    const admitted = rosterRef.current
      .filter((g) => !!g.render_url)
      .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
      .map((g) => g.id);
    const next = moveInOrder(admitted, guestId, dir);
    // Server truth, not optimistic: post, then re-read the roster now
    // rather than showing an order the server may not have taken.
    try {
      await guestsIpc.order(endpointRef.current, cfg.server_room_id, next);
      rosterTickRef.current?.();
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  /** Seat: THROW UP — ask the host's set for a slot for this seat's own row
   * through the honest-staging path (lib/stageTruth.ts). The screen window
   * starts the share first; the host frames the share from its Mods panel. */
  const throwUp = async (kind: "camera" | "screen") => {
    const id = mySeatRef.current?.id;
    if (!id) return;
    const leg = mediaLegRef.current;
    if (kind === "screen") {
      // "Place my screen": the share is announced to the server as a
      // media.screen interval (lib/seatMedia.ts); the host's set places the
      // MOD SCREEN feed from that interval once the seat is on the set —
      // so stage the seat if it is not yet.
      if (leg && !leg.snapshot().sharing) {
        const ok = await leg.toggleShare();
        if (!ok) return;
      }
      if (modRowStage(modStageRef.current, id) === "on") return;
    }
    await modStageToggle(id);
  };
  /** HOST: give or take a seat's camera / mic / screen (api: host-only). */
  const toggleSeatGrant = async (seatRow: RoomGuest, grant: "media.camera" | "media.mic" | "media.screen", enabled: boolean) => {
    const ep = endpointRef.current;
    if (!ep) return;
    try {
      const r = await guestsIpc.request(ep, "POST", `/v1/app/live/guests/${seatRow.id}/grants`, { grant, enabled });
      if (!r.available) throw new Error("This server has no seat media (update the API).");
      if (r.status >= 400) {
        const b = (r.body ?? {}) as { code?: string; message?: string };
        throw new Error(b.code === "room_host_required" ? "Only the host gives a seat media." : b.message ?? b.code ?? `HTTP ${r.status}`);
      }
      setModsErr(null);
      rosterTickRef.current?.();
    } catch (e) {
      setModsErr(String(e).replace(/^Error:\s*/, ""));
    }
  };
  /** HOST / MANAGER: seat a team member — a room role through the Access
   * tab's own door (`POST …/access/grants`). They take the seat when they
   * open this room. */
  const seatMember = async (memberId: string, grant: "admin" | "editor" | "viewer") => {
    const ep = endpointRef.current;
    const sid = cfg.server_room_id;
    if (!ep || !sid) return;
    try {
      await team.setRoomRole(ep, sid, memberId, grant);
      setModsErr(null);
      setBanner("Seated — they take the seat when they open this room in Producer.");
      window.setTimeout(() => setBanner(null), 5000);
    } catch (e) {
      setModsErr(String(e).replace(/^Error:\s*/, ""));
    }
  };
  /** The team, for the Mods panel's names / roles / "seat someone". Read
   * once per room open, only on Boomin and only for a seat that manages. */
  const membersAsked = useRef(false);
  useEffect(() => {
    if (!boominRoom || accessPending || !(roomRole === "host" || roomAccess.can.manage) || membersAsked.current) return;
    if (seatRows.length === 0 && dockOf(layout, "mods") === "hidden") return;
    const ep = endpointRef.current;
    if (!ep) return;
    membersAsked.current = true;
    void (async () => {
      try {
        const bid = await team.brandId(ep);
        if (!bid) return;
        setMembers(await team.members(ep, bid));
      } catch {
        membersAsked.current = false;
      }
    })();
  }, [boominRoom, accessPending, roomRole, roomAccess.can.manage, seatRows.length, layout]);

  /** Mint (or reuse) the room's shareable link. */
  const ensureGuestLink = async () => {
    if (guestLink) return guestLink;
    try {
      const ep = await resolveActiveEndpoint();
      if (!ep) throw new Error("Connect a workspace first.");
      let sid = cfg.server_room_id;
      if (!sid) {
        const reg = await registerRoom(ep.id, room?.name ?? "Room", room?.id ?? "");
        sid = reg.room.id;
        writeCfg({ ...cfgRef.current, server_room_id: sid });
      }
      const url = await mintJoinLink(ep.id, sid!);
      setGuestLink(url);
      writeCfg({ ...cfgRef.current, guest_link: url });
      return url;
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
      return null;
    }
  };

  /** Copy the room link and SAY so. Both the header chip and the guest
   * panel's link button go through here — the panel button used to copy
   * silently (and swallow clipboard failures), which read as "doesn't work". */
  const copyRoomLink = async () => {
    const url = guestLink ?? (await ensureGuestLink());
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      // Deals are a Boomin thing; a self-hosted room has none.
      const boomin = isBoomin(await resolveActiveEndpoint().catch(() => null));
      setBanner(
        boomin
          ? "Room link copied — send it to your guests. Deal guests must enter through the deal."
          : "Room link copied — send it to your guests.",
      );
    } catch {
      setBanner(url);
    }
  };

  const [srcSettings, setSrcSettings] = useState<string | null>(null);
  /** Which scene's settings strip is open — same grammar as sources. */
  const [sceneSettings, setSceneSettings] = useState<string | null>(null);
  /** Which source's filter chain the Sources panel is drilled into. */
  const [filterFor, setFilterFor] = useState<{ id: string; label: string; media: "video" | "audio" } | null>(null);
  /** The Vote panel's question editor is open (v0.4.33) — a sub-page in a
   * column dock, a popover over the strip in a row dock. Cleared on Open
   * and on back, exactly like `filterFor`. */
  const [voteEdit, setVoteEdit] = useState(false);
  /** Device picking drills into the Sources panel exactly like Filters does —
   *  same crumb, same place — instead of popping a floating menu. */
  const [deviceFor, setDeviceFor] = useState<{ key: string; label: string } | null>(null);
  /** Mini-editor popover for adding an open-list source. */
  const [srcSubPop, setSrcSubPop] = useState<"text" | "color" | "window" | "mod" | null>(null);

  /** Add an open-list item and record it in the room document so it
   * respawns when the room reopens. */
  const addExtraSource = async (label: string, spec: ExtraSpec, inviteUrl?: string) => {
    if (refuseSetEdit()) return;
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
      // A new source belongs to the scene you added it in. Scenes are looks
      // over ONE graph, so without this every other scene would inherit it
      // visible (a guest slot added in PiP showed up in Full cam and Screen).
      // The active scene gets it visible; every other scene with a look
      // records it hidden. Geometry fills in via the write-through capture.
      // MEMBERSHIP: the new source joins the ACTIVE scene's look and no
      // other. A scene without a look is materialized from the stage first
      // so it has one to join. Absence from a look = not in that scene.
      const active = activeSceneRef.current;
      const stage: Record<string, SceneItemLook> = Object.fromEntries(
        (sourcesRef.current.items ?? [])
          .filter((i) => i.kind !== "guest" && i.kind !== "mod")
          .map((i) => [i.id, { visible: i.visible, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z }]),
      );
      const scenes = (c.scenes.length ? c.scenes : DEFAULT_SCENES).map((sc) => {
        if (sc.id !== active) return sc;
        const look = { ...(sc.look && Object.keys(sc.look).length ? sc.look : stage) };
        look[id] = { ...(look[id] ?? {}), visible: true };
        return { ...sc, look };
      });
      writeCfg({ ...c, scenes, sources: { ...c.sources, extras: [...(c.sources.extras ?? []), entry] } });
    } catch (e) {
      setBanner(String(e));
    }
  };

  /** Re-point a window item at a different window: replaced in place under
   * the same id, and the room document follows so it respawns correctly. */
  const replaceWindowSource = async (itemId: string, windowId: number, label: string) => {
    if (refuseSetEdit()) return;
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

  /** MEMBERSHIP delete: a source leaves the scene it was deleted in. It
   * leaves the GRAPH only when no scene references it anymore — scenes are
   * looks over one graph, so "delete" used to be graph-wide by construction
   * (a slot deleted in PiP vanished from Full cam and Screen too). */
  const removeExtraSource = (id: string) => {
    if (refuseSetEdit()) return;
    const c = cfgRef.current;
    const active = activeSceneRef.current;
    const all = c.scenes.length ? c.scenes : DEFAULT_SCENES;
    const stillUsed = all.some((sc) => sc.id !== active && !!sc.look && id in sc.look);
    if (active && stillUsed) {
      // Leave THIS scene: drop the membership, hide the item, keep the source.
      ipc.liveSetTransform(id, { visible: false }, true).catch(() => {});
      writeCfg({
        ...c,
        scenes: all.map((sc) => {
          if (sc.id !== active || !sc.look) return sc;
          const look = { ...sc.look };
          delete look[id];
          return { ...sc, look };
        }),
      });
      return;
    }
    // Last scene using it: the source leaves the graph, every look is scrubbed.
    extraSources.remove(id).catch(() => {});
    writeCfg({
      ...c,
      scenes: all.map((sc) => {
        if (!sc.look || !(id in sc.look)) return sc;
        const look = { ...sc.look };
        delete look[id];
        return { ...sc, look };
      }),
      sources: { ...c.sources, extras: (c.sources.extras ?? []).filter((e) => e.id !== id) },
    });
  };
  /** MEMBERSHIP delete for the well-known sources (screen/camera/overlay).
   * Before this they were exempt: "remove" tore the engine source down
   * globally, the scene's look still listed it, and the next applyScene
   * re-created it — the edit undid itself on every switch. Now, exactly like
   * extras: leave THIS scene's look (materialized from the stage if the scene
   * was still running on its built-in recipe); tear the source down only when
   * no other scene needs it. */
  const removeCoreSource = (id: "screen" | "camera" | "overlay") => {
    if (refuseSetEdit()) return;
    const c = cfgRef.current;
    const active = activeSceneRef.current;
    const all = c.scenes.length ? c.scenes : DEFAULT_SCENES;
    const realLook = (sc: RoomScene) => !!(sc.look && Object.keys(sc.look).length);
    // A scene needs a core source if its look lists it, or — still on the
    // built-in recipe — its flags imply it (overlay is always in a recipe).
    const needs = (sc: RoomScene) =>
      realLook(sc) ? id in sc.look! : id === "overlay" ? true : id === "screen" ? sc.screen : sc.camera;
    const stillUsed = all.some((sc) => sc.id !== active && needs(sc));
    const stage: Record<string, SceneItemLook> = Object.fromEntries(
      (sourcesRef.current.items ?? [])
        .filter((i) => i.kind !== "guest")
        .map((i) => [i.id, { visible: i.visible, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z }]),
    );
    const leaveScene = (sc: RoomScene) => {
      const look = { ...(realLook(sc) ? sc.look! : stage) };
      delete look[id];
      return { ...sc, look, ...(id === "screen" ? { screen: false } : id === "camera" ? { camera: false } : {}) };
    };
    window.clearTimeout(lookTimer.current); // a pending capture would re-list it
    if (active && stillUsed) {
      ipc.liveSetTransform(id, { visible: false }, true).catch(() => {});
      writeCfg({ ...c, scenes: all.map((sc) => (sc.id === active ? leaveScene(sc) : sc)) });
      return;
    }
    // No scene needs it: the source leaves the graph, every look is scrubbed.
    if (id === "overlay") ipc.liveSetOverlay(null, false).catch(() => {});
    else void setSrc(id === "screen" ? { screen: false } : { camera: false });
    writeCfg({
      ...c,
      scenes: all.map((sc) => (sc.id === active || (sc.look && id in sc.look) ? leaveScene(sc) : sc)),
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

  /** `persist` = these are THIS machine's channels (the host's). A seat
   * reading the host's room channels never overwrites its own saved ones. */
  const connectChat = useCallback(async (names: ChatNames, persist = true) => {
    setChatError(null);
    if (persist) saveChatNames(names);
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

  // Chat channels belong to the ROOM. The host publishes its handles to
  // every monitor seat over the monitor leg (Boomin's room config schema
  // is strict, so the leg is the room-scoped transport that works on
  // every server) and keeps them on the room document; a seat reads them
  // — the read-only ingest needs only a handle — and never edits them.
  const monitorState = useMonitorState(monitorSeat);
  useEffect(() => {
    if (!isHost) return;
    const cc: MonitorRoomInfo["chat_channels"] = {};
    if (chatNames.twitch.trim()) cc.twitch = chatNames.twitch.trim();
    if (chatNames.kick.trim()) cc.kick = chatNames.kick.trim();
    if (chatNames.youtube.trim()) cc.youtube = chatNames.youtube.trim();
    roomInfoRef.current = { ...roomInfoRef.current, chat_channels: cc };
    for (const snd of monitorSenders.current.values()) snd.setRoomInfo(roomInfoRef.current);
    const prev = JSON.stringify(cfgRef.current.chat_channels ?? {});
    if (prev !== JSON.stringify(cc)) writeCfg({ ...cfgRef.current, chat_channels: cc });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, chatNames.twitch, chatNames.kick, chatNames.youtube]);
  const hostChatKey = JSON.stringify(monitorState?.roomInfo?.chat_channels ?? null);
  const hostChatAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isHost || accessPending) return;
    if (hostChatAppliedRef.current === hostChatKey) return;
    hostChatAppliedRef.current = hostChatKey;
    const cc = monitorState?.roomInfo?.chat_channels;
    // The host's room, not this machine's saved channels: swap to the
    // room's handles (or to none, until the host publishes them).
    void connectChat({ twitch: cc?.twitch ?? "", kick: cc?.kick ?? "", youtube: cc?.youtube ?? "" }, false);
  }, [isHost, accessPending, hostChatKey, monitorState, connectChat]);

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
  /** A non-host seat on a Boomin room: the local document was deliberately
   * NOT applied and the engine cleared, once per room open. */
  const localSetSkipped = useRef(false);
  const roomId = room?.id ?? null;
  /** The room's endpoint, resolved once and shared by the room-apply path
   * and the roster tick — both need to know whether the server is Boomin
   * before they can know whose set this is. */
  const ensureEndpoint = async (): Promise<string | null> => {
    if (endpointRef.current) return endpointRef.current;
    const ep = await resolveActiveEndpoint().catch(() => null);
    if (!ep) return null;
    endpointRef.current = ep.id;
    endpointBaseRef.current = ep.base_url;
    boominRoomRef.current = isBoomin(ep);
    setBoominRoom(boominRoomRef.current);
    return ep.id;
  };

  const refresh = useCallback(async () => {
    setDestinations(await ipc.liveListDestinations(activeEndpointId() ?? undefined));
    const snap = await ipc.liveEngineStatus();
    setSnapshot(snap);
    if (snap.sources) setSources(snap.sources);
    // Opening a room applies its saved scene — but never over a live
    // session (switching rooms mid-stream adopts the running scene).
    if (room && !roomApplied.current && snap.engine_ready && snap.session_state === "idle") {
      // WHOSE set is this? A Boomin room may be someone else's: a mod's or a
      // viewer's Producer must not mount its own camera, screen, mic and
      // scenes as if it ran the show (the founder's Windows mod saw
      // its own desktop where the host's program belonged). The answer is
      // the access route's; until it lands nothing local is applied, and
      // the roster tick calls refresh again the moment it does.
      const sid = parseConfig(room.config).server_room_id;
      if (sid) await ensureEndpoint();
      const decision = localSetDecision({
        boomin: !!sid && boominRoomRef.current,
        answered: accessAsked.current,
        tries: accessTries.current,
        role: roomRoleRef.current,
      });
      if (decision === "wait") return;
      if (decision === "skip") {
        // Not our set. Nothing of this room is applied; anything the engine
        // still holds from a previous room comes DOWN so the stage cannot
        // show it — devices off, no items, no overlay, no mic capture.
        if (!localSetSkipped.current) {
          localSetSkipped.current = true;
          await ipc.liveSetSources(false, false, false).catch(() => {});
          for (const i of (snap.sources?.items ?? []).filter((x) => !["screen", "camera", "overlay"].includes(x.id))) {
            await extraSources.remove(i.id).catch(() => {});
          }
          if (snap.sources?.overlay_window != null || snap.sources?.overlay_url) {
            ipc.liveSetOverlay(null, false, null).catch(() => {});
          }
          engineHeldRoom = null;
          // The veil waits on pixels; there are none to wait for.
          firstFramesDone.current = true;
          setFramesReady(true);
          setDocApplied(true);
        }
        return;
      }
      roomApplied.current = true;
      const saved = parseConfig(room.config).sources;
      if (typeof saved.screen === "boolean") {
        await ipc.liveSetSources(saved.screen, saved.camera ?? false, saved.mic ?? false);
        if (saved.mic_volume != null || saved.mic_muted != null) {
          await ipc.liveSetMicAudio({ volume: saved.mic_volume, muted: saved.mic_muted });
        }
        setSources((s) => ({ ...s, ...saved }));
      }
      // Item-list half of the document. A DIFFERENT room: clear whatever
      // open-list items the engine is holding from the previous one, then
      // respawn this room's. The SAME room reopened: the engine already holds
      // it — keep every item the document still lists (same id, same kind;
      // spec edits go through their own remove+add paths), keep every guest
      // (the roster tick owns their lifetime, and a kept CEF page keeps its
      // call), add only what is missing. Nothing flashes, nothing
      // reconnects that did not have to.
      const hot = engineHeldRoom === room.id;
      const held = (snap.sources?.items ?? []).filter(
        (i) => !["screen", "camera", "overlay"].includes(i.id),
      );
      const listed = new Map((saved.extras ?? []).map((e) => [e.id, e]));
      const kept = new Set<string>();
      for (const i of held) {
        const doc = listed.get(i.id);
        if (hot && (i.kind === "guest" || i.kind === "mod" || (doc && doc.spec.kind === i.kind))) {
          kept.add(i.id);
          continue;
        }
        await extraSources.remove(i.id).catch(() => {});
      }
      for (const e of saved.extras ?? []) {
        if (kept.has(e.id)) continue;
        await extraSources.add(e.id, e.label, e.spec).catch(() => {});
      }
      engineHeldRoom = room.id;
      // The overlay LAST: its CEF create is the slowest thing in the apply
      // (measured 4.6s cold, holding the engine loop), so nothing else may
      // queue behind it. Not awaited — the scene mounts around it and the
      // first-frame gate holds the veil until it lands. Setting it re-creates
      // the CEF page, so a hot reopen with the same overlay leaves it alone.
      const overlaySame =
        hot &&
        (snap.sources?.overlay_window ?? null) === (saved.overlay_window ?? null) &&
        (snap.sources?.overlay_url ?? null) === (saved.overlay_url ?? null);
      if (
        typeof saved.screen === "boolean" &&
        (saved.overlay_window != null || saved.overlay_url) &&
        !overlaySame
      ) {
        ipc.liveSetOverlay(saved.overlay_window ?? null, true, saved.overlay_url ?? null).catch(() => {});
      }
      const mount = parseConfig(room.config).active_scene;
      if (mount) setPendingScene(mount);
      setDocApplied(true);
      // Warm the stinger the room already uses, so the first cut is instant.
      const cfgNow = parseConfig(room.config);
      const firstStinger =
        cfgNow.transition?.stinger ?? cfgNow.scenes.find((x) => x.transition?.stinger)?.transition?.stinger;
      if (firstStinger) stingerIpc.prepare(firstStinger).catch(() => {});
    }
    // Video settings re-apply when idle: the room's own `video` first (a 4K
    // room stays 4K), else the global OBS-style localStorage value.
    if (!videoApplied.current && snap.engine_ready && snap.session_state === "idle") {
      videoApplied.current = true;
      try {
        const stored =
          (room ? parseConfig(room.config).video : undefined) ??
          (JSON.parse(localStorage.getItem("producer.video") ?? "null") as {
            h: number;
            f: number;
          } | null);
        if (stored && (stored.h !== (snap.video_height || 720) || stored.f !== (snap.video_fps || 30))) {
          await ipc.liveSetVideo(stored.h, stored.f);
        }
      } catch {
        /* bad stored value — engine default stands */
      }
    }
    // Channel selection from the room document → engine flags.
    if (!channelsApplied.current && room && roomApplied.current) {
      channelsApplied.current = true;
      const want = parseConfig(room.config).channels;
      if (Object.keys(want).length) {
        for (const d of await ipc.liveListDestinations(activeEndpointId() ?? undefined)) {
          const target = want[d.id];
          if (typeof target === "boolean" && target !== d.enabled) {
            await ipc
              .liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, enabled: target })
              .catch(() => {});
          }
        }
        setDestinations(await ipc.liveListDestinations(activeEndpointId() ?? undefined));
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
        srcEvCount.current += 1;
        if (settleOnSources.current) {
          settleOnSources.current = false;
          setSceneSettled(true);
        }
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
        for (const t of ev.thumbs) {
          if (t.id === "program") {
            // The PROGRAM thumb exists only for monitor seats that asked
            // (lib/monitorFeed.ts): bytes down every data channel, never a
            // guests-panel tile.
            if (monitorSenders.current.size) {
              const bin = atob(t.jpeg);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              for (const snd of monitorSenders.current.values()) snd.pushThumb(bytes.buffer);
            }
            continue;
          }
          next[t.id] = `data:image/jpeg;base64,${t.jpeg}`;
        }
        if (Object.keys(next).length) setGuestThumbs((prev) => ({ ...prev, ...next }));
      } else if (ev.type === "engine_error") {
        setBanner(ev.message);
      } else if (ev.type === "engine_ready") {
        if (!ev.ok) setBanner("Live engine failed to initialize — see engine report.");
        // A room opened DURING boot must apply the moment the engine is up —
        // previously nothing re-ran refresh on success, so the veil rode to
        // its cap and the room mounted unconfigured.
        else void refresh();
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
      const now = snapRef.current;
      // A stopped engine has no renderer: no sample, the chart holds still
      // (the one honest flat line). Idle-but-running jitters, as it should.
      if (!now?.engine_ready) return;
      const v = renderPressure(now, loadPrevRef.current);
      loadPrevRef.current = now;
      setLoadHist((h) => pushSample(h, v));
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (engineOk) mark("engine");
  }, [engineOk]);
  useEffect(() => {
    if (!engineOk || !sceneSettled || !mountVeil) return;
    mark("settled");
    // 100% ready means PIXELS: hold for every visible source's first frame.
    // The note names who we are waiting on; the cap keeps a wedged device
    // from trapping the user (and is recorded, so it is never silent).
    if (!framesReady && !framesCapped) {
      const who = pendingFrames[0];
      setVeilNote(
        who === "camera" ? "Starting camera…"
        : who === "screen" ? "Starting screen capture…"
        : who === "overlay" ? "Loading overlay…"
        : who?.startsWith("gslot") || !who ? "Preparing the stage…"
        : "Starting sources…",
      );
      return;
    }
    // Lift on a MACROTASK, never an animation frame: WebKit halts rAF while
    // it deems the view occluded, and the native Metal preview attaches over
    // the webview right here — measured: main thread free (stall 3ms), rAF
    // starved for 5.1s. Timers keep running; readiness rides them.
    const t = window.setTimeout(() => {
      {
        setMountVeil(false);
        mark("veil");
        const m = mountMarks.current;
        setMountMs(m.veil);
        const report = {
          ...m,
          veil_capped: framesCapped && !framesReady,
          stall_max_ms: Math.round(stallMax.current),
          boot_phases: snapRef.current?.boot_phases_ms ?? null,
          at: new Date().toISOString(),
        };
        console.info("[room] mount timings ms", report);
        roomOpenReport(report).catch(() => {});
      }
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineOk, sceneSettled, mountVeil, framesReady, framesCapped, pendingFrames]);
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

  // ── WRITE-THROUGH (room state, mirror 1) ─────────────────────────────────
  // The room document mirrors engine truth continuously: whatever flips a
  // source flag — the rail, the stage toolbar, a scene, the overlay picker —
  // the mirrored subset lands in the document a moment later. This is what
  // makes "leave with the camera on, come back to the camera on" true.
  // Gated on roomApplied so the previous room's engine state can never
  // overwrite this room's document during open.
  useEffect(() => {
    if (!room || !roomApplied.current) return;
    const t = window.setTimeout(() => {
      const c = cfgRef.current;
      const cur = c.sources ?? {};
      const next = {
        ...cur,
        screen: sources.screen,
        camera: sources.camera,
        mic: sources.mic,
        mic_volume: sources.mic_volume,
        mic_muted: sources.mic_muted,
        overlay_window: sources.overlay_window ?? null,
        overlay_url: sources.overlay_url ?? null,
      };
      const KEYS = ["screen", "camera", "mic", "mic_volume", "mic_muted", "overlay_window", "overlay_url"] as const;
      if (KEYS.some((k) => (cur as Record<string, unknown>)[k] !== (next as Record<string, unknown>)[k])) {
        writeCfg({ ...c, sources: next });
      }
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.screen, sources.camera, sources.mic, sources.mic_volume, sources.mic_muted, sources.overlay_window, sources.overlay_url, room]);

  // ── WRITE-THROUGH (room state, mirror 2) ─────────────────────────────────
  /** The active scene IS what you're looking at: any real edit — drag, nudge,
   * eye, layer, delete — re-captures the scene's look after the engine
   * settles. No more owing the Update button a click before leaving. Guests
   * are excluded (transient ids; slots carry their geometry). */
  const lookTimer = useRef(0);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const activeSceneRef = useRef<string | null>(null);
  /** The scene a capture is owed to — bound when the edit happens, not when
   * the debounce fires, or an edit made in scene A followed by a quick switch
   * would be written into scene B (and A never learns of it). */
  const lookOwed = useRef<string | null>(null);
  const captureLookNow = (sceneId: string) => {
    if (!roomApplied.current) return;
    // Guests AND mod feeds are excluded: transient ids; slots carry guest
    // geometry, `mod_feeds` carries a seat's (lib/modFeed.ts).
    const items = (sourcesRef.current.items ?? []).filter((i) => i.kind !== "guest" && i.kind !== "mod");
    if (!items.length) return;
    const look: Record<string, SceneItemLook> = Object.fromEntries(
      items.map((i) => [i.id, { visible: i.visible, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z }]),
    );
    const base = cfgRef.current;
    writeCfg({
      ...base,
      scenes: (base.scenes.length ? base.scenes : DEFAULT_SCENES).map((x) =>
        x.id === sceneId ? { ...x, look, screen: sourcesRef.current.screen, camera: sourcesRef.current.camera } : x,
      ),
    });
  };
  const captureActiveLook = () => {
    const sceneId = activeSceneRef.current;
    if (!sceneId) return;
    window.clearTimeout(lookTimer.current);
    lookOwed.current = sceneId;
    lookTimer.current = window.setTimeout(() => {
      lookOwed.current = null;
      captureLookNow(sceneId);
    }, 1200); // past the next engine poll, so the capture reads settled truth
  };
  /** Settle any owed capture before the stage changes underneath it. */
  const flushActiveLook = () => {
    const owed = lookOwed.current;
    if (!owed) return;
    window.clearTimeout(lookTimer.current);
    lookOwed.current = null;
    captureLookNow(owed);
  };

  async function setSrc(patch: Partial<Pick<LiveSources, "screen" | "camera" | "mic">>) {
    if (refuseSetEdit()) return;
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
  activeSceneRef.current = activeScene ?? null;

  /** Apply a scene as a LOOK: sources are never created or destroyed on a
   * switch (no flicker, no permission re-prompts, no z scramble) — only
   * visibility, geometry and stacking change, through the same transform
   * pipeline the stage editor uses. Missing well-known sources the scene
   * needs are created once; nothing is ever torn down. */
  const applyScene = async (p: RoomScene, opts?: { cut?: boolean }) => {
    // A selection belongs to the scene it was made in: leaving the scene
    // drops it, or the outline (and Delete) would follow you to items that
    // aren't even on this look.
    setStageSel(null);
    // What you edited in the scene you're leaving is written to THAT scene
    // before its stage is repainted as another one.
    flushActiveLook();
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
      // SLOT MODEL: a slot bound to a guest applies AS the guest — same rect,
      // same layer, same visibility — with the slot hidden underneath at its
      // own rect. A guest is never at the top of the stack merely because it
      // was created last.
      const bindings = cfgRef.current.slot_bindings ?? {};
      const entries = expandSlotBindings(
        Object.entries(look).filter(([id]) => exists.has(id)),
        bindings,
        exists,
      );
      // Seen, not heard: a guest a scene hides is muted; one it shows speaks.
      for (const [id, l] of entries) {
        if (id.startsWith("guest-") && bindings[slotOfGuest(bindings, id) ?? ""] === id) {
          setSourceAudio(id, undefined, !l.visible).catch(() => {});
        }
      }
      // MEMBERSHIP: a scene's look is the set of sources that belong to it.
      // Anything the look does not mention is not in this scene — hide it.
      // Screen/camera/overlay follow the same rule as every other source
      // (a scene that dropped its camera stays camera-less); only guests are
      // exempt, because slots — not scenes — carry their geometry.
      const realLook = !!(p.look && Object.keys(p.look).length);
      if (realLook) {
        for (const it of sources.items ?? []) {
          // Guests and mod feeds are not scene members: slots and mod_feeds
          // carry them across every scene.
          if (it.kind === "guest" || it.kind === "mod") continue;
          if (!(it.id in look) && it.visible) {
            ipc.liveSetTransform(it.id, { visible: false }, true).catch(() => {});
          }
        }
      }
      // Hidden first (plain visibility flips), then visible bottom-to-top so
      // z-order lands exactly as the scene says.
      for (const [id, l] of entries.filter(([, l]) => !l.visible)) {
        ipc.liveSetTransform(id, lookPatch(l, false), true).catch(() => {});
      }
      const visible = entries
        .filter(([, l]) => l.visible)
        .sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));

      const tr: SceneTransition = opts?.cut
        ? { kind: "cut" }
        : p.transition ?? cfgRef.current.transition ?? { kind: "cut" as const };

      // Stinger: the clip covers the stage, the scene changes UNDERNEATH it
      // at the halfway point, and the clip plays out to reveal the result.
      // The cut is never seen — that's the whole trick.
      if (tr.kind === "stinger" && tr.stinger) {
        const applyLook = () => {
          const vis = entries
            .filter(([, l]) => l.visible)
            .sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));
          for (const [id, l] of entries.filter(([, l]) => !l.visible)) {
            ipc.liveSetTransform(id, lookPatch(l, false), true).catch(() => {});
          }
          vis.forEach(([id, l], i) => {
            ipc.liveSetTransform(id, lookPatch(l, true, i), true).catch(() => {});
          });
        };
        setActiveSceneId(p.id);
        writeCfg({ ...cfgRef.current, active_scene: p.id });
        try {
          const reported = await stingerIpc.play(tr.stinger);
          const total = reported > 0 ? reported : (tr.ms ?? 1200);
          transitionUntil.current = performance.now() + total + 400;
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
      if (animate) transitionUntil.current = performance.now() + dur + 400;

      if (!animate) {
        visible.forEach(([id, l], i) => {
          ipc.liveSetTransform(id, lookPatch(l, true, i), true).catch(() => {});
        });
      } else {
        const from = new Map((sources.items ?? []).map((it) => [it.id, it]));

        if (tr.kind === "fade") {
          // Items that stay simply stay — only what enters or leaves
          // dissolves. Anything that MOVES is `move`'s job, and the two can
          // be combined by picking one per scene.
          const leaving = entries.filter(([, l]) => !l.visible);
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
            ipc.liveSetTransform(id, lookPatch(l, true, i), false).catch(() => {});
          });
          const t0f = performance.now();
          // If frames starve mid-dissolve (WebKit halts rAF when it deems the
          // view occluded), a timer still lands the end state — a guest must
          // never be left half-transparent by a paused animation loop.
          let fadeDone = false;
          const stepFade = () => {
            if (fadeDone) return;
            const k = Math.min(1, (performance.now() - t0f) / dur);
            for (const id of arriving) setOpacity(id, k).catch(() => {});
            for (const [id] of leaving) setOpacity(id, 1 - k).catch(() => {});
            if (k < 1) {
              requestAnimationFrame(stepFade);
              return;
            }
            fadeDone = true;
            // Settle: hide what left and restore its opacity, so the next
            // scene that shows it doesn't inherit a transparent source.
            for (const [id, l] of leaving) {
              ipc.liveSetTransform(id, lookPatch(l, false), true).catch(() => {});
              setOpacity(id, 1).catch(() => {});
            }
            visible.forEach(([id], i) => {
              setOpacity(id, 1).catch(() => {});
              ipc.liveSetTransform(id, { visible: true, z: i }, true).catch(() => {});
            });
          };
          requestAnimationFrame(stepFade);
          window.setTimeout(() => {
            if (!fadeDone) {
              fadeDone = true;
              for (const [id, l] of leaving) {
                ipc.liveSetTransform(id, lookPatch(l, false), true).catch(() => {});
                setOpacity(id, 1).catch(() => {});
              }
              visible.forEach(([id], i) => {
                setOpacity(id, 1).catch(() => {});
                ipc.liveSetTransform(id, { visible: true, z: i }, true).catch(() => {});
              });
            }
          }, dur + 80);
          setActiveSceneId(p.id);
          writeCfg({ ...cfgRef.current, active_scene: p.id });
          return;
        }

        // Make everything visible and correctly stacked up front, then move.
        visible.forEach(([id], i) => {
          ipc.liveSetTransform(id, { visible: true, z: i }, false).catch(() => {});
        });
        const t0 = performance.now();
        // Same belt as fade: if frames starve mid-glide, a timer lands every
        // item on its target geometry, committed.
        let moveDone = false;
        const step = () => {
          if (moveDone) return;
          const k = Math.min(1, (performance.now() - t0) / dur);
          // ease-out cubic: quick off the mark, settles gently
          const e = 1 - Math.pow(1 - k, 3);
          const done = k >= 1;
          if (done) moveDone = true;
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
        window.setTimeout(() => {
          if (moveDone) return;
          moveDone = true;
          visible.forEach(([id, l], i) => {
            ipc.liveSetTransform(id, lookPatch(l, true, i), true).catch(() => {});
          });
        }, dur + 80);
      }
      setActiveSceneId(p.id);
      const c = cfgRef.current;
      writeCfg({ ...c, active_scene: p.id });
    } catch (e) {
      setBanner(String(e));
    }
  };

  const addScene = () => {
    if (refuseSetEdit()) return;
    const n = scenes.length + 1;
    // Save the CURRENT look, extras included — the scene is a snapshot of
    // the whole stage, not just which slots are on.
    const look: Record<string, SceneItemLook> = Object.fromEntries(
      (sources.items ?? [])
        .filter((i) => i.kind !== "guest") // slots carry guest geometry; ids are transient
        .map((i) => [i.id, { visible: i.visible, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z }]),
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

  const removeScene = (id: string) => {
    if (refuseSetEdit()) return;
    writeCfg({ ...cfg, scenes: scenes.filter((s) => s.id !== id) });
  };

  /** Re-record a scene from what's on the stage right now. Without this, a
   * built-in look can never be corrected — you'd fix the stage, switch away,
   * and the old recipe would undo you every time. */
  const updateScene = (id: string) => {
    if (refuseSetEdit()) return;
    const look: Record<string, SceneItemLook> = Object.fromEntries(
      (sources.items ?? [])
        .filter((i) => i.kind !== "guest") // slots carry guest geometry; ids are transient
        .map((i) => [i.id, { visible: i.visible, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z }]),
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
    if (refuseSetEdit()) return;
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
      if (hostScenesRef.current) {
        const hs = hostScenesRef.current.scenes[n - 1];
        if (!hs) return;
        e.preventDefault();
        void cutHostScene(hs.id);
        return;
      }
      if (!isHostRef.current) return; // no host directory yet: nothing to cut
      const sc = scenes[n - 1];
      if (!sc) return;
      e.preventDefault();
      applyScene(sc);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Room control channel (#47) ──────────────────────────────────────────
  // The host's Producer holds one socket to the room's Durable Object: it
  // publishes the scene list (ids + names, never looks) so mod seats see it
  // with the active scene lit, and it receives `scene.cut` frames from mods
  // holding room.scene — applied exactly as the host's own keypress, which
  // then persists active_scene and republishes.
  const controlRef = useRef<RoomControlLink | null>(null);
  const applySceneRef = useRef(applyScene);
  applySceneRef.current = applyScene;
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  useEffect(() => {
    if (!room?.id || !cfg.server_room_id) return;
    // Open server: the host only (a mod runs views/ModSeat.tsx). Boomin: any
    // role — a mod's Producer lights the host's list off `scene.cut` frames
    // and takes the tally on `interactions:control` (the hub gates it).
    if (roomRole !== "host" && !boominRoom) return;
    const sid = cfg.server_room_id;
    let link: RoomControlLink | null = null;
    let alive = true;
    void (async () => {
      const ep = await resolveActiveEndpoint().catch(() => null);
      if (!ep || !alive) return;
      const boomin = isBoomin(ep);
      link = new RoomControlLink({
        origin: new URL(ep.base_url).origin,
        // On Boomin `controlSession` mints the room-channel ticket (api #392)
        // and returns the same {signaling_ticket, signaling_url} shape.
        session: () => guestsIpc.controlSession(ep.id, sid),
        // `stage` on both: a mod's stage request reaches the host as a frame
        // and the host answers with its set's truth (lib/stageTruth.ts).
        subscribe: boomin ? [...BOOMIN_ROOM_CHANNELS] : ["interaction:host", "stage"],
        parse: boomin ? parseBoominFrame : undefined,
        onFrame: (frame: ControlFrame) => {
          if (frame.type === "interaction") {
            const ix = (frame as { payload?: unknown }).payload as Interaction | undefined;
            if (ix && typeof ix === "object" && typeof ix.id === "string") onInteractionFrame(ix);
            return;
          }
          if (frame.type === "contribution.closed") {
            // The server closed an overlay interval (a run ended, a mod hid
            // it, a deal capped): a bound source still showing on the set
            // comes down, so the ledger and the picture agree.
            onContributionClosed((frame as ContributionFrame).contribution as unknown as Contribution);
            onSeatShareRef.current?.((frame as ContributionFrame).contribution as unknown as Contribution, false);
            return;
          }
          if (frame.type === "contribution.opened") {
            onSeatShareRef.current?.((frame as ContributionFrame).contribution as unknown as Contribution, true);
            return;
          }
          if (frame.type === "stage") {
            const f = frame as { on_stage?: unknown; version?: unknown };
            if (Array.isArray(f.on_stage) && typeof f.version === "number") {
              onStageFrameRef.current?.(f.on_stage.filter((x): x is string => typeof x === "string"), f.version);
            }
            return;
          }
          if (frame.type !== "scene.cut") return;
          const cut = frame as SceneCutFrame;
          if (roomRoleRef.current !== "host") {
            // A mod's Producer on Boomin: the host cut (or another mod did) —
            // light it, never apply it to our own engine.
            setHostScenes((h) => (h ? { ...h, active_scene_id: cut.scene_id } : h));
            return;
          }
          // The engine ignores cuts for scenes not in the room's list —
          // the DO already refused them, this is the second lock.
          const sc = scenesRef.current.find((x) => x.id === cut.scene_id);
          if (!sc) return;
          void applySceneRef.current(sc, cut.transition === "cut" ? { cut: true } : undefined);
        },
        onOpen: () => {
          if (!boomin) link?.publishScenes(scenesRef.current, activeSceneRef.current);
        },
      });
      controlRef.current = link;
      link.start();
    })();
    return () => {
      alive = false;
      link?.stop();
      if (controlRef.current === link) controlRef.current = null;
    };
  }, [room?.id, cfg.server_room_id, roomRole, boominRoom]);
  // Every change to the list or the active scene reaches the mods. Open
  // server: a `scene.publish` frame. Boomin: the room config carries a scene
  // DIRECTORY (ids + labels, `stage_enabled: false`) that `POST …/scene`
  // validates against — debounced, and only when it actually changed.
  const publishedCfgRef = useRef<string | null>(null);
  useEffect(() => {
    controlRef.current?.publishScenes(scenes, activeScene ?? null);
    if (!boominRoom || roomRole !== "host" || !cfg.server_room_id) return;
    const sid = cfg.server_room_id;
    const config = boominStageConfig(scenes, activeScene ?? null);
    const key = JSON.stringify(config);
    if (publishedCfgRef.current === key) return;
    const t = window.setTimeout(() => {
      const ep = endpointRef.current;
      if (!ep) return;
      guestsIpc
        .publishScenes(ep, sid, config)
        .then(() => {
          publishedCfgRef.current = key;
        })
        .catch(() => {});
    }, 600);
    return () => window.clearTimeout(t);
  }, [scenes, activeScene, boominRoom, roomRole, cfg.server_room_id]);

  /** Boomin, a mod's Producer: the host's scene directory as the room config
   * carries it, the active one lit by `scene.cut` frames. Null on the host
   * (its own list is the truth) and on an open server (ModSeat). */
  const [hostScenes, setHostScenes] = useState<{ scenes: { id: string; name: string }[]; active_scene_id: string | null } | null>(null);
  useEffect(() => {
    if (!boominRoom || roomRole === "host" || !cfg.server_room_id) {
      setHostScenes(null);
      return;
    }
    const sid = cfg.server_room_id;
    let alive = true;
    const read = async () => {
      const ep = endpointRef.current;
      if (!ep) return;
      const res = await listServerRooms(ep).catch(() => null);
      const r = res?.rooms?.find((x) => x.id === sid);
      if (!alive || !r) return;
      const dir = scenesFromBoominConfig(r.config);
      setHostScenes((h) => ({ scenes: dir.scenes, active_scene_id: dir.active_scene_id ?? h?.active_scene_id ?? null }));
    };
    void read();
    // The directory changes rarely (the host adds a scene); the active one
    // arrives as a frame. A slow re-read covers a missed frame.
    const t = window.setInterval(() => void read(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [boominRoom, roomRole, cfg.server_room_id]);
  /** Boomin mod: cut the host's room to one of its scenes. */
  const cutHostScene = async (sceneId: string) => {
    const ep = endpointRef.current;
    if (!ep || !cfg.server_room_id) return;
    try {
      await guestsIpc.sceneCut(ep, cfg.server_room_id, sceneId);
      setHostScenes((h) => (h ? { ...h, active_scene_id: sceneId } : h));
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };
  const hostScenesRef = useRef(hostScenes);
  hostScenesRef.current = hostScenes;

  /** Mint a mod link and put it on the clipboard. The server keeps only a
   * hash, so this is the one time the URL is readable. */
  const mintModLink = async () => {
    try {
      const ep = await resolveActiveEndpoint();
      if (!ep) throw new Error("Connect a workspace first.");
      let sid = cfg.server_room_id;
      if (!sid) {
        const reg = await registerRoom(ep.id, room?.name ?? "Room", room?.id ?? "");
        sid = reg.room.id;
        writeCfg({ ...cfgRef.current, server_room_id: sid });
      }
      const res = await guestsIpc.modLink(ep.id, sid!);
      try {
        await navigator.clipboard.writeText(res.mod_url);
        setBanner("Mod link copied — whoever opens it in Producer can admit, stage, order, remove and cut scenes. They never appear on the set.");
      } catch {
        setBanner(res.mod_url);
      }
      window.setTimeout(() => setBanner(null), 6000);
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // ── Interactions: the two-choice vote (#51) ────────────────────────────
  // The room's RoomState DO is authoritative; this Producer opens, starts,
  // reveals and closes through the server and reads the running tally off
  // its control socket (`interaction:host`). The bar on the SET is a browser
  // source on the local bridge fed from HERE — never from the server — so
  // what is on air follows the host's clock (INTERACTIVE.md decision 1).
  const [vote, setVote] = useState<Interaction | null>(null);
  const votesRef = useRef<Map<string, Interaction>>(new Map());
  const [audienceLink, setAudienceLink] = useState<string | null>(null);
  const onInteractionFrame = (ix: Interaction) => {
    const cur = votesRef.current.get(ix.id);
    if (cur && cur.version > ix.version) return;
    votesRef.current.set(ix.id, ix);
    // The one to show: collecting first, else the newest not cancelled.
    const all = [...votesRef.current.values()];
    const collecting = all.filter((i) => i.state === "collecting");
    const alive = all.filter((i) => i.state !== "cancelled");
    const shown = collecting[collecting.length - 1] ?? alive[alive.length - 1] ?? null;
    setVote(shown);
    overlayBridge.set(shown ? { interaction: shown, server_now: shown.server_now } : null).catch(() => {});
  };

  /** The vote bar lives in an `overlay` extra pointed at the local bridge.
   * Created once per room; re-pointed if the bridge moved (port). */
  const ensureVoteOverlay = async () => {
    // The vote bar is a source on the HOST's stage; a mod opens the vote on
    // the server and the host's Producer places the overlay. No banner.
    if (!isHostRef.current) return;
    const url = await overlayBridge.start();
    const c = cfgRef.current;
    // The bar's source is the overlay that points at THIS Producer's bridge
    // (127.0.0.1/overlay) — found by where it points, never by its label, so
    // a renamed source still counts and a sponsor's overlay is never
    // hijacked. It is an ordinary overlay otherwise: Sources row, eye, drag,
    // geometry, filters. Closing a vote leaves it in place, rendering empty.
    const isBridge = (u: string) => {
      try {
        const x = new URL(u);
        return x.hostname === "127.0.0.1" && x.pathname === "/overlay";
      } catch {
        return false;
      }
    };
    const existing = (c.sources.extras ?? []).find((e) => e.spec.kind === "overlay" && isBridge(e.spec.url));
    if (existing && existing.spec.kind === "overlay" && existing.spec.url === url) return;
    if (existing) {
      await extraSources.remove(existing.id).catch(() => {});
      await extraSources.add(existing.id, existing.label, { kind: "overlay", url }).catch(() => {});
      writeCfg({
        ...c,
        sources: { ...c.sources, extras: (c.sources.extras ?? []).map((e) => (e.id === existing.id ? { ...e, spec: { kind: "overlay", url } } : e)) },
      });
      return;
    }
    await addExtraSource("Vote bar", { kind: "overlay", url });
  };

  const openVote = async (input: { a: string; b: string; prompt: string; who: "guest" | "audience" | "both" }) => {
    try {
      const ep = await resolveActiveEndpoint();
      if (!ep) throw new Error("Connect a workspace first.");
      let sid = cfg.server_room_id;
      if (!sid) {
        const reg = await registerRoom(ep.id, room?.name ?? "Room", room?.id ?? "");
        sid = reg.room.id;
        writeCfg({ ...cfgRef.current, server_room_id: sid });
      }
      await ensureVoteOverlay();
      // Boomin takes the contract envelope only and collects from the moment
      // it opens; the open server also takes the short form and waits for
      // Start. The card reads the state either way.
      const res = await guestsIpc.interactionCreate(
        ep.id,
        sid!,
        isBoomin(ep)
          ? boominVoteBody(input)
          : {
              type: "vote",
              prompt: input.prompt,
              options: [input.a, input.b],
              reveal: "manual",
              input: { who: input.who, once: true, cooldown_ms: 0 },
            },
      );
      const ix = isBoomin(ep) ? normalizeBoominInteraction(res.interaction) : res.interaction;
      if (ix) onInteractionFrame(ix);
      setVoteEdit(false);
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const transitionVote = async (transition: "open" | "reveal" | "close" | "cancel", holdMs?: number) => {
    const v = vote;
    if (!v || !cfg.server_room_id) return;
    try {
      const ep = endpointRef.current ?? (await resolveActiveEndpoint())?.id;
      if (!ep) return;
      if (boominRoomRef.current && transition === "reveal" && holdMs && holdMs > 0) {
        // No reveal hold on Boomin's wire (the DO's alarm is `collect_ms` at
        // open): a "Reveal in 3 s" is timed here, on the host's clock — the
        // same clock the set follows (INTERACTIVE.md decision 1).
        window.setTimeout(() => {
          const latest = votesRef.current.get(v.id);
          if (latest && latest.state === "collecting") void transitionVote("reveal");
        }, holdMs);
        return;
      }
      const res = await guestsIpc.interactionTransition(ep, cfg.server_room_id, v.id, transition, holdMs ?? null);
      const ix = boominRoomRef.current ? normalizeBoominInteraction(res.interaction) : res.interaction;
      if (ix) onInteractionFrame(ix);
      if (transition === "cancel" || transition === "close") {
        // Leave the result on the set for a beat, then clear the bar.
        window.setTimeout(() => {
          const latest = votesRef.current.get(v.id);
          if (latest && (latest.state === "closed" || latest.state === "cancelled")) overlayBridge.set(null).catch(() => {});
        }, transition === "close" ? 8000 : 0);
      }
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const copyAudienceLink = async () => {
    try {
      const ep = await resolveActiveEndpoint();
      if (!ep || !cfg.server_room_id) throw new Error("Open the room on a server first.");
      let url: string;
      let hint: string;
      if (isBoomin(ep)) {
        // Boomin: no room-level code — the link is the vote's own page on
        // boomin.ai (`/a/<interaction id>`), phones answer through the
        // audience input route with a device id they keep.
        if (!vote || vote.state === "closed" || vote.state === "cancelled") throw new Error("Open a vote first — on Boomin the audience link is per vote.");
        url = boominAudienceUrl(vote.id);
        hint = `Audience link copied — ${url}. Phones answer this vote; no account needed.`;
      } else {
        const res = await guestsIpc.audienceLink(ep.id, cfg.server_room_id);
        url = res.url;
        hint = `Audience link copied — ${res.url} (code ${res.code}). Works while you're live; no account needed.`;
      }
      setAudienceLink(url);
      try {
        await navigator.clipboard.writeText(url);
        setBanner(hint);
      } catch {
        setBanner(url);
      }
      window.setTimeout(() => setBanner(null), 6000);
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // ── The contribution ledger (#50) ──────────────────────────────────────
  // Presence is the server's (it follows the stage list we publish). Two
  // things only this Producer knows are published from here: an OVERLAY
  // source with a binding (a sponsor's logo) being shown or hidden, and the
  // RUN — started when we go live, stopped at End, then read back as the
  // run report.
  const overlayShownRef = useRef<Map<string, boolean>>(new Map());
  /** A `contribution.closed` frame for an overlay we hold: take the source
   * down if it is still showing, and forget the interval so the next show
   * opens a fresh one. Our own hide produces the same frame — a no-op then. */
  const onContributionClosed = (c: Contribution) => {
    if (c.kind !== "overlay") return;
    const sid = typeof c.binding?.source_id === "string" ? c.binding.source_id : null;
    if (!sid) return;
    const bound = (cfgRef.current.sources.extras ?? []).find((e) => e.id === sid && e.binding && Object.keys(e.binding).length);
    if (!bound) return;
    if (overlayShownRef.current.get(sid)) {
      overlayShownRef.current.set(sid, false);
      ipc.liveSetTransform(sid, { visible: false }, true).catch(() => {});
    }
  };
  useEffect(() => {
    if (roomRole !== "host" || !cfg.server_room_id || !endpointRef.current) return;
    const ep = endpointRef.current;
    const sid = cfg.server_room_id;
    const bound = (cfgRef.current.sources.extras ?? []).filter((e) => e.binding && Object.keys(e.binding).length);
    if (!bound.length) return;
    const items = sources.items ?? [];
    for (const ex of bound) {
      const item = items.find((i) => i.id === ex.id);
      const shown = !!item && item.visible !== false;
      const was = overlayShownRef.current.get(ex.id) ?? false;
      if (shown === was) continue;
      overlayShownRef.current.set(ex.id, shown);
      guestsIpc.overlay(ep, sid, ex.id, ex.binding!, shown, ex.label).catch(() => {});
    }
  }, [sources.items, roomRole, cfg.server_room_id]);

  const [runReport, setRunReport] = useState<{ run_id: string | null; rows: Contribution[] } | null>(null);
  const prevStateRef = useRef<string>("idle");
  /** When this Producer went live — the run's bracket on Boomin, which has
   * no run route for Producer rooms (the roster poll is the heartbeat and a
   * lapse ends the run server-side; `run_id` stays null on its rows). */
  const runStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (roomRole !== "host" || !cfg.server_room_id) return;
    const sid = cfg.server_room_id;
    const wasLive = prev === "streaming" || prev === "starting" || prev === "stopping";
    if (state === "streaming" && !wasLive) {
      runStartedAtRef.current = Date.now();
      void (async () => {
        const ep = endpointRef.current ?? (await resolveActiveEndpoint().catch(() => null))?.id;
        if (ep) guestsIpc.run(ep, sid, "start").catch(() => {});
      })();
    } else if (state === "idle" && wasLive && prev !== "starting") {
      void (async () => {
        const ep = endpointRef.current ?? (await resolveActiveEndpoint().catch(() => null))?.id;
        if (!ep) return;
        const startedAt = runStartedAtRef.current;
        const endedAt = Date.now();
        if (boominRoomRef.current) {
          // End closes what THIS Producer opened: every bound overlay still
          // showing gets its interval closed now (the picture stays; a
          // later show opens a fresh interval), so the report is whole and
          // a metered deal settles on End rather than on the heartbeat lapse.
          const shown = [...overlayShownRef.current.entries()].filter(([, v]) => v).map(([id]) => id);
          for (const id of shown) {
            const ex = (cfgRef.current.sources.extras ?? []).find((e) => e.id === id);
            if (!ex?.binding) continue;
            overlayShownRef.current.set(id, false);
            await guestsIpc.overlay(ep, sid, id, ex.binding, false, ex.label).catch(() => {});
          }
          const res = await guestsIpc.contributions(ep, sid, null).catch(() => null);
          if (!res) return;
          const rows = startedAt ? contributionsInWindow(res.contributions ?? [], startedAt, endedAt) : res.contributions ?? [];
          setRunReport({ run_id: null, rows });
          return;
        }
        const stopped = await guestsIpc.run(ep, sid, "stop").catch(() => null);
        if (!stopped?.run_id) return;
        const res = await guestsIpc.contributions(ep, sid, stopped.run_id).catch(() => null);
        if (res) setRunReport({ run_id: stopped.run_id, rows: res.contributions ?? [] });
      })();
    }
  }, [state, roomRole, cfg.server_room_id]);

  /** Give an extra source a ledger binding: a sponsor credit. Show / hide
   * of that source then lands as an overlay contribution. */
  const setSourceCredit = (itemId: string) => {
    const c = cfgRef.current;
    const ex = (c.sources.extras ?? []).find((e) => e.id === itemId);
    if (!ex) return;
    const cur = typeof ex.binding?.sponsor === "string" ? ex.binding.sponsor : "";
    const raw = window.prompt("Sponsor credit for this source (blank to clear):", cur);
    if (raw === null) return;
    const sponsor = raw.trim().slice(0, 80);
    const extras = (c.sources.extras ?? []).map((e) =>
      e.id !== itemId ? e : sponsor ? { ...e, binding: { ...(e.binding ?? {}), sponsor } } : { ...e, binding: undefined },
    );
    writeCfg({ ...c, sources: { ...c.sources, extras } });
    // A newly bound source that is already showing opens its interval now.
    overlayShownRef.current.delete(itemId);
  };

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

  /** Until when a scene transition is still gliding items — the slot
   * reconcile below must not snap a guest mid-move. */
  const transitionUntil = useRef(0);

  // SLOT INVARIANT, held against engine truth on every poll: a shown guest
  // sits at its slot's rect and layer. Anything that moved it away — its own
  // creation (top of the stack), a source-list reorder that only knew the
  // slot, a look applied before the guest existed — is corrected here, from
  // the slot, never the other way round. The slot is authored; the guest
  // follows.
  useEffect(() => {
    if (performance.now() < transitionUntil.current) return;
    const items = sources.items ?? [];
    const b = cfgRef.current.slot_bindings ?? {};
    for (const [slotId, gid] of Object.entries(b)) {
      const slot = items.find((i) => i.id === slotId);
      const guest = items.find((i) => i.id === gid);
      if (!slot || !guest || !guest.visible) continue;
      const patch = guestSlotPatch(slot, guest);
      if (patch) ipc.liveSetTransform(gid, patch, true).catch(() => {});
    }
  }, [sources.items]);

  /** A guest dragged, resized or re-layered on the stage is the SLOT being
   * edited through its occupant: the slot (hidden underneath) takes the same
   * transform, so the authored rect is what moved and the reconcile above
   * has nothing to undo. */
  const mirrorToSlot = (id: string, patch: LiveTransformPatch, commit: boolean) => {
    if (!isHostRef.current) return; // the stage editor is disabled off-host; quiet here
    if (!id.startsWith("guest-")) return;
    const slotId = slotOfGuest(cfgRef.current.slot_bindings ?? {}, id);
    if (!slotId) return;
    const { visible: _v, ...geometry } = patch;
    void _v;
    if (Object.keys(geometry).length) ipc.liveSetTransform(slotId, geometry, commit).catch(() => {});
  };

  /** Mint (or reuse) this seat's monitor row and open the receive leg. A
   * server without the route (404 → `available: false`) leaves the
   * placeholder: the seat can still cut scenes and run the roster. */
  const startProgramMonitor = async (epId: string, serverRoomId: string) => {
    try {
      const res = await guestsIpc.request(epId, "POST", `/v1/app/live/rooms/${serverRoomId}/monitor`, {});
      if (!res.available || !endpointBaseRef.current) return;
      const body = (res.body ?? {}) as { join_url?: string; participant?: { id?: string; grants?: unknown } };
      if (!body.join_url) return;
      const grants = resolveGrants({ grants: body.participant?.grants });
      const id = typeof body.participant?.id === "string" ? body.participant.id : null;
      mySeatRef.current = id ? { id, joinUrl: body.join_url, media: mediaKey(grants) } : null;
      setMySeatId(id);
      setMyGrants(grants);
      openSeatLeg(body.join_url, grants);
    } catch (e) {
      setGuestErr(String(e).replace(/^Error:\s*/, ""));
    }
  };
  /** The media a seat holds, as one comparable key. */
  const mediaKey = (g: ReadonlySet<string>) => ["media.camera", "media.mic", "media.screen"].filter((k) => g.has(k)).join(",");
  /** Open the leg this seat's grants call for: the receive-only monitor, or
   * — when the host handed it media — the sending half on the same row.
   * Never both: two host peers on one channel would collide. */
  const openSeatLeg = (joinUrl: string, grants: ReadonlySet<string>) => {
    monitorRef.current?.leave();
    monitorRef.current = null;
    setMonitorSeat(null);
    mediaLegRef.current?.leave();
    mediaLegRef.current = null;
    setMediaLeg(null);
    const apiBase = endpointBaseRef.current;
    if (!apiBase) return;
    if (hasAnyMedia(grants)) {
      monitorLog(`seat: the host gave this seat ${mediaKey(grants)} — opening the sending half`);
      const leg = new SeatMediaLeg({
        joinUrl,
        apiBase,
        hostName: room?.name ?? null,
        camera: grants.has("media.camera"),
        mic: grants.has("media.mic"),
        screen: grants.has("media.screen"),
      });
      mediaLegRef.current = leg;
      setMediaLeg(leg);
      void leg.start();
    } else {
      const m = new ProgramMonitor({ joinUrl, apiBase, hostName: room?.name ?? null });
      monitorRef.current = m;
      setMonitorSeat(m);
      m.start();
    }
  };
  // The monitor legs live exactly as long as the room is open in this view:
  // leaving drops every sender, closes the receive leg and ends the server
  // row (DELETE …/monitor), so the host's roster stops carrying us.
  useEffect(() => {
    if (!room?.id) return;
    return () => {
      for (const s of monitorSenders.current.values()) s.stop();
      monitorSenders.current.clear();
      if (programThumbOn.current) {
        programThumbOn.current = false;
        ipc.liveSetProgramThumb(false).catch(() => {});
      }
      if (vcamAutoRef.current) {
        vcamAutoRef.current = false;
        vcamIpc.output(false).catch(() => {});
      }
      const m = monitorRef.current;
      monitorRef.current = null;
      monitorStartedFor.current = null;
      setMonitorSeat(null);
      const leg = mediaLegRef.current;
      mediaLegRef.current = null;
      setMediaLeg(null);
      leg?.leave();
      mySeatRef.current = null;
      setMySeatId(null);
      if (m || leg) {
        m?.leave();
        const epId = endpointRef.current;
        const sid = parseConfig(room.config).server_room_id;
        if (epId && sid) guestsIpc.request(epId, "DELETE", `/v1/app/live/rooms/${sid}/monitor`).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  // Poll the roster and reconcile browser sources against it. Not while we
  // hold a SEAT elsewhere: the poll is also the room-open heartbeat, and a
  // guest's own stage must not read as open on the network.
  useEffect(() => {
    if (!room?.id || !cfg.server_room_id || seat) return;
    let alive = true;
    const tick = async () => {
      try {
        const epId = await ensureEndpoint();
        if (!epId) return;
        if (!accessAsked.current) {
          // Once per room open — once it has ANSWERED. A transport failure
          // (offline blip, a 5xx) is not an answer: on a Boomin room the tick
          // asks again next time rather than settling on "host" for the rest
          // of the session, which is how a mod used to get the host's room.
          // 404 (no route: self-hosted, or Boomin before #380) and 401/403
          // (refused) are answers; the shell maps them (client.rs).
          if (boominRoomRef.current && accessTries.current === 0) setAccessPending(true);
          const acc = await guestsIpc.access(epId, cfg.server_room_id!).catch(() => null);
          if (!alive) return;
          if (acc === null && boominRoomRef.current) {
            // Three misses (~9 s) and the person who opened their own room
            // with the API down gets their room back — as the ASSUMED host
            // (the card says so), while the tick keeps asking.
            accessTries.current += 1;
            if (accessTries.current >= 3) {
              setAccessPending(false);
              void refresh(); // the room-apply path was waiting on this answer
            }
            return;
          }
          accessAsked.current = true;
          const info = roomAccessFrom(acc);
          {
            const dto = (acc && typeof acc === "object" ? (acc as { access?: unknown }).access : null) as { grants?: unknown } | null;
            setRoomGrants(Array.isArray(dto?.grants) ? (dto!.grants as RoomGrantRowLike[]) : null);
          }
          roomRoleRef.current = info.role;
          setRoomRole(info.role);
          setRoomAccess(info);
          setAccessPending(false);
          // The room-apply path (refresh) held the local document back
          // until this answer: a host mounts its set now, anyone else
          // never does.
          void refresh();
        }
        const res = await guestsIpc.roster(epId, cfg.server_room_id!);
        if (!alive) return;
        // Program monitors (seats receiving the host's program) ride the
        // roster flagged `monitor: true` and are kept OUT of it here, at the
        // one place it enters: never a guests-panel row, never a source,
        // never on stage — the host only opens the return leg to them.
        const full = res.guests ?? [];
        const list = full.filter((g) => !isMonitor(g));
        // Reconcile, never replace-on-equal: an identical roster is not news.
        setRoster((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
        setGuestErr(null);
        if (roomRoleRef.current !== "host") {
          // Not the host: the roster is all we do. No render pages (they would
          // be a second host peer on every guest's channel), no stage post
          // from our engine (we have none for this room). What we DO want is
          // the host's program: mint our monitor once per room open.
          if (boominRoomRef.current && monitorStartedFor.current !== room.id) {
            monitorStartedFor.current = room.id;
            void startProgramMonitor(epId, cfg.server_room_id!);
          }
          // Our own row rides the roster: the media the host gave (or took
          // back) shows up here, and the leg follows it — the sending half
          // opens the moment camera / mic / screen lands, the receive-only
          // monitor returns when the last one is revoked.
          const me = mySeatRef.current;
          const mine = me ? full.find((g) => g.id === me.id) : undefined;
          if (me && mine) {
            const grants = resolveGrants(mine);
            const key = mediaKey(grants);
            if (key !== me.media) {
              me.media = key;
              setMyGrants(grants);
              openSeatLeg(me.joinUrl, grants);
            }
          }
          return;
        }
        // Seats (monitor rows) for the Mods panel — and the set's candidate
        // list: guests plus seats the host handed media (isMediaSeat).
        // One row per member (dedupeSeatRows): ended rows hidden, the newest
        // accepted row wins when the api still lists a reopened seat twice.
        const seats = dedupeSeatRows(full);
        setSeatRows((prev) => (JSON.stringify(prev) === JSON.stringify(seats) ? prev : seats));
        liveRowsRef.current = [...full.filter((g) => !isMonitor(g)), ...seats.filter((g) => isMediaSeat(g))];
        // The host's half of every monitor leg: one sender per monitor row,
        // dropped when the row leaves the roster (seat left, grant revoked,
        // run ended) — or when the seat gained media: its render page's
        // return leg carries the program then, and a second host peer on
        // the same channel would collide. The engine never sees these.
        if (endpointBaseRef.current) {
          const wantedMonitors = new Map(full.filter((g) => isMonitor(g) && !isMediaSeat(g) && !!g.render_url).map((g) => [g.id, g] as const));
          for (const [id, sender] of monitorSenders.current) {
            if (!wantedMonitors.has(id)) {
              sender.stop();
              monitorSenders.current.delete(id);
              monitorThumbDemand();
            }
          }
          for (const [id, g] of wantedMonitors) {
            if (monitorSenders.current.has(id)) continue;
            monitorLog(`host: monitor row ${id.slice(0, 8)} (${g.display_name ?? "seat"}) — opening the send leg`);
            const sender = new MonitorSender({
              renderUrl: g.render_url!,
              apiBase: endpointBaseRef.current,
              programLabel: vcamStateRef.current?.device_name,
              tag: g.display_name ?? id.slice(0, 8),
              onThumbDemand: () => monitorThumbDemand(),
            });
            sender.setRoomInfo(roomInfoRef.current);
            monitorSenders.current.set(id, sender);
            sender.start();
            // A seat just arrived: give it the stage baseline (the tick's
            // post is deduped; forcing it costs one request).
            stagePostedRef.current = null;
          }
          // The video leg captures the VIRTUAL CAMERA — a device that exists
          // only while the output runs. A host idling in a room never
          // started it, so the monitor got a black frame, then nothing.
          // Start it for the seat; stop it when the last seat leaves, but
          // only if the host did not switch it on themselves.
          const wantVcam = wantedMonitors.size > 0;
          const vs = vcamStateRef.current;
          if (wantVcam && !vcamOnRef.current && Date.now() > vcamAutoNextTry.current) {
            vcamAutoNextTry.current = Date.now() + 10_000;
            if (vs?.installed || vs?.state === "active") {
              monitorLog("host: a monitor seat is present — starting the virtual camera for it");
              vcamIpc
                .output(true)
                .then((on) => {
                  vcamOnRef.current = on;
                  setVcamOn(on);
                  if (on) vcamAutoRef.current = true;
                  monitorLog(`host: virtual camera ${on ? "started" : "did not start"}`);
                })
                .catch((e) => monitorLog(`host: virtual camera start failed: ${String(e)}`));
            } else {
              monitorLog(`host: virtual camera not installed (state=${vs?.state ?? "unknown"}) — the seat falls back to the 8 fps preview`);
            }
          }
          if (!wantVcam && vcamAutoRef.current) {
            vcamAutoRef.current = false;
            if (vcamOnRef.current) {
              monitorLog("host: last monitor left — stopping the virtual camera we started for it");
              vcamIpc
                .output(false)
                .then((on) => {
                  vcamOnRef.current = on;
                  setVcamOn(on);
                })
                .catch(() => {});
            }
          }
        }
        // The roster is news either way; reconciling sources against it is
        // not, until the document has been applied and the engine's item
        // list read — before that `sources.items` is empty, and an empty list
        // reads as "every binding is stale": slots freed, guests re-added,
        // the stage blinking on every reopen.
        if (!roomApplied.current) return;

        // Only guests the host has admitted get a source. A waiting guest is
        // deliberately NOT on the broadcast: the room link is public, so
        // auto-admitting would put an unknown person on air with a name they
        // chose themselves.
        const live = liveRowsRef.current.filter((g) => !!g.render_url);
        // Guest-kind items ONLY — the vote bar overlay and every other
        // host source are never the roster's to remove.
        const present = guestReconcileIds(sources.items ?? []);
        // One source per TRACK: the camera for everyone, and a second
        // "<name> · screen" source for a guest who holds media.screen. The
        // screen page shares the guest's signaling channel and receives only
        // the share, so the host frames it independently of the person.
        const wanted = wantedSourceIds(live);

        for (const [id, { guest: g, track }] of wanted) {
          if (!present.has(id)) {
            const u = new URL(g.render_url!);
            if (track === "screen") {
              u.searchParams.set("track", "screen");
            } else {
              // &program= names the virtual camera so the page captures the
              // SHOW rather than guessing at a device; &mic= does the same for
              // the host's microphone. Both are labels, because a browser's
              // deviceIds are salted per origin and can never match ours.
              if (micDeviceLabel) u.searchParams.set("mic", micDeviceLabel);
              u.searchParams.set("program", vcamState?.device_name ?? "Producer Virtual Camera");
              // No media.return_feed → the page never opens the return leg.
              if (!resolveGrants(g).has("media.return_feed")) u.searchParams.set("feed", "0");
            }
            // Guests only here — a seat's feed is a MOD source (below).
            const name = g.display_name || "Guest";
            await extraSources
              .add(id, track === "screen" ? `${name} · screen` : name, { kind: "guest", url: u.toString() })
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

        // MOD SOURCES (v0.4.32): one `mod-<uuid8>` page per seat holding
        // camera / mic, one `-screen` page per seat holding media.screen —
        // their own kind, born hidden at their remembered rect on the mod
        // layer, never a guest slot. Dropped when the grant goes or the
        // seat leaves (the ledger interval closes with it).
        {
          const presentMods = new Set((sources.items ?? []).filter((i) => i.kind === "mod").map((i) => i.id));
          const wantedMods = wantedModSourceIds(seats.filter((g) => !!g.render_url));
          for (const [id, { seat, track }] of wantedMods) {
            if (presentMods.has(id)) continue;
            const u = new URL(seat.render_url!);
            if (track === "screen") {
              u.searchParams.set("track", "screen");
            } else {
              if (micDeviceLabel) u.searchParams.set("mic", micDeviceLabel);
              u.searchParams.set("program", vcamState?.device_name ?? "Producer Virtual Camera");
              if (!resolveGrants(seat).has("media.return_feed")) u.searchParams.set("feed", "0");
            }
            const label = modSourceLabel(seat, track);
            await extraSources.add(id, label, { kind: "mod", url: u.toString() }).catch(() => {});
            // Its place and layer, hidden: the seat's throw-up / the Mods
            // panel reveal it there rather than full-frame on top.
            const bw = (vhRef.current * 16) / 9;
            const rect = toCanvas(modFeedRect(cfgRef.current.mod_feeds, seat.id, track), bw, vhRef.current);
            const z = modFeedZ(sources.items ?? []);
            ipc.liveSetTransform(id, { ...rect, z, visible: false }, true).catch(() => {});
            monitorLog(`host: mod source ${id} (${label}) added, hidden at its rect`);
          }
          for (const id of presentMods) {
            if (wantedMods.has(id)) continue;
            const it = (sources.items ?? []).find((i) => i.id === id);
            const owner = modSourceOwner(id, full);
            if (owner) modLedger(owner.row.id, owner.track, id, false);
            else if (modPlacedRef.current.get(id)) modPlacedRef.current.set(id, false);
            if (it?.visible) {
              fadeGuest(id, false);
              window.setTimeout(() => extraSources.remove(id).catch(() => {}), 320);
            } else {
              await extraSources.remove(id).catch(() => {});
            }
            monitorLog(`host: mod source ${id} dropped (grant revoked or seat left)`);
          }
        }

        // SLOT MODEL: the scene owns guest geometry. No auto-layout — a shown
        // guest occupies the slot it was bound to and nothing else moves.
        const shown = (sources.items ?? []).filter((i) => i.kind === "guest" && i.visible);
        // Reconcile: bindings whose guest source no longer exists free their
        // slot — the placeholder returns at its own geometry.
        {
          const b = cfgRef.current.slot_bindings ?? {};
          const liveIds = new Set((sources.items ?? []).map((i) => i.id));
          const stale = Object.entries(b).filter(([, gid]) => !liveIds.has(gid));
          if (stale.length) {
            const nb = { ...b };
            for (const [slotId] of stale) {
              delete nb[slotId];
              ipc.liveSetTransform(slotId, { visible: true }, true).catch(() => {});
            }
            writeCfg({ ...cfgRef.current, slot_bindings: nb });
          }
        }

        // Tell the server who is on stage — the FULL list, on registration and
        // on every change. Source ids are `guest-<uuid8>`, so map back through
        // the roster rather than un-truncating. Fire-and-forget: the server
        // list is a cache for reconnecting guests, never read back here —
        // scene-item visibility in the engine stays the only truth.
        const shownMods = (sources.items ?? []).filter((i) => i.kind === "mod" && i.visible);
        const stageIds = [
          ...shown.map((it) => live.find((g) => !isMonitor(g) && sourceIdsFor(g.id).camera === it.id)?.id),
          ...shownMods.map((it) => live.find((g) => isMonitor(g) && modSourceIdsFor(g.id).camera === it.id)?.id),
        ]
          .filter((id): id is string => !!id)
          .sort();
        const stageKey = stageIds.join(",");
        if (stageKey !== stagePostedRef.current && endpointRef.current && cfg.server_room_id) {
          stagePostedRef.current = stageKey;
          guestsIpc
            .setStage(endpointRef.current, cfg.server_room_id, stageIds)
            .then(noteHostPosted)
            .catch(() => {
              // Retry on the next tick rather than losing the change.
              stagePostedRef.current = null;
            });
        }
      } catch (e) {
        if (alive) setGuestErr(String(e).replace(/^Error:\s*/, ""));
      }
    };
    rosterTickRef.current = () => void tick();
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      rosterTickRef.current = null;
      clearInterval(t);
    };
  }, [room?.id, cfg.server_room_id, sources.items, snapshot?.video_height, guestSlot, seat]);

  // Mount the room into its saved scene once the engine can take it.
  useEffect(() => {
    if (!engineOk || !docApplied) return;
    if (!pendingScene) {
      setSceneSettled(true);
      return;
    }
    const sc = scenes.find((x) => x.id === pendingScene);
    setPendingScene(null);
    void (async () => {
      // Mount CUTS: transitions are for switching in front of an audience,
      // not for laying out a room nobody is watching yet.
      if (sc) {
        const seen0 = srcEvCount.current;
        await applyScene(sc, { cut: true });
        mark("applied");
        if (srcEvCount.current > seen0) {
          // The transforms' commit already echoed back during the apply.
          setSceneSettled(true);
        } else {
          settleOnSources.current = true;
          // Belt: an empty look sends no transforms, so nothing would answer.
          window.setTimeout(() => {
            if (settleOnSources.current) {
              settleOnSources.current = false;
              setSceneSettled(true);
            }
          }, 250);
        }
      } else {
        setSceneSettled(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScene, engineOk, docApplied]);


  const setVolume = (v: number) => {
    setSources((s) => ({ ...s, mic_volume: v }));
    ipc.liveSetMicAudio({ volume: v }).catch((e) => setBanner(String(e)));
  };
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const saveChannelKey = async (d: LiveDestination) => {
    try {
      await ipc.liveUpsertDestination({ id: d.id, preset: d.preset, label: d.label, server: d.server ?? undefined, key: keyVal, enabled: d.enabled });
      setDestinations(await ipc.liveListDestinations(activeEndpointId() ?? undefined));
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
  vhRef.current = vh;
  const vf = snapshot?.video_fps || 30;
  // 4K is a hardware-encoder feature: the engine reports whether one
  // registered (VideoToolbox, NVENC, QSV, or AMF).
  const hwEncoder = !!snapshot?.hw_encoder;
  // Intel Macs: the encoder is there, the headroom for 4K60 isn't.
  const hw4k60 = !!snapshot?.hw_4k60;
  async function setVideoCfg(h: number, f: number) {
    try {
      await ipc.liveSetVideo(h, f);
      localStorage.setItem("producer.video", JSON.stringify({ h, f }));
      // The room remembers its own canvas so reopening it lands where it was.
      writeCfg({ ...cfgRef.current, video: { h, f } });
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
    setOverlayInline(false);
    setChatOpen(false);
    setLinkMenuOpen(false);
    setSrcAddOpen(false);
    setDeviceMenu(null);
    setSrcSubPop(null);
    setSceneSettings(null);
    if (formDockOf("vote") === "top") setVoteEdit(false);
  };
  const anyPop =
    destsOpen || (voteEdit && formDockOf("vote") === "top") || qualityOpen || micPopOpen || chatOpen || linkMenuOpen || srcAddOpen || deviceMenu !== null || srcSubPop !== null ||
    // Scene settings are a POPOVER only on a side rail; in the bottom sheet
    // and the top rail they are a strip in the flow — a popover backdrop
    // there would sit over the strip and eat every click.
    (sceneSettings !== null && dockOf(layout, "scenes") !== "bottom" && dockOf(layout, "scenes") !== "top") || panelMenu !== null || layoutMenu || addMenu !== null || adding || !!editing;

  const micStrip = (
    <MeterStrip
      horizontal={formDockOf("mixer") === "top"}
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
        // A mod's Producer on Boomin: the HOST's scenes, read from the room's
        // directory, the active one lit by the server's `scene.cut` frames.
        // A click is `POST …/scene`; nothing here touches our own engine.
        // The LOCAL list never renders off-host: this Producer holds no set
        // for the room, so its own scenes would be a lie about the picture.
        if (!isHost) {
          if (!hostScenes) {
            return (
              <div className="rm-scenes">
                <div className="rm-rows-empty">
                  {accessPending ? "Checking your seat…" : "The host's scenes appear here once their Producer opens the room."}
                </div>
              </div>
            );
          }
          return (
            <div className="rm-scenes">
              {hostScenes.scenes.length === 0 && (
                <div className="rm-rows-empty">The host hasn't published scenes yet — they appear once their Producer opens the room.</div>
              )}
              {hostScenes.scenes.map((p, i) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className={`rm-scene-row${hostScenes.active_scene_id === p.id ? " active" : ""}`}
                  title="Cut the host's room to this scene"
                  onClick={() => void cutHostScene(p.id)}
                  onKeyDown={(e) => e.key === "Enter" && void cutHostScene(p.id)}
                >
                  <span className="rm-scene-icon">{ic.screen}</span>
                  <span className="rm-scene-name">{p.name}</span>
                  {hostScenes.active_scene_id === p.id ? (
                    <span className="rm-scene-live">On</span>
                  ) : (
                    <span className="rm-scene-key">{i < 9 ? `⌘${i + 1}` : ""}</span>
                  )}
                </div>
              ))}
            </div>
          );
        }
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
                  <span className="rm-scene-live">{streaming ? "Live" : "On"}</span>
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
            {(() => {
              const chatMini = formDockOf("chat") === "top";
              const all = ["twitch", "kick", "youtube"] as const;
              const active = all.filter((p) => chatOn[p] !== false);
              const lead = active[0] ?? "twitch";
              const rest = Math.max(active.length - 1, 0);
              // Mini form: ONE logo + "+n more you're streaming to"; the
              // cluster expands to the full toggleable set on demand.
              if (chatMini && !chatChipsOpen) {
                return (
                  <div className="rm-chat-chips mini">
                    <button className="rm-chat-chip on" title="Chat channels" onClick={() => setChatChipsOpen(true)}>
                      <span className="rm-chip-logo">{PLATFORM_LOGO[lead]}</span>
                    </button>
                    {rest > 0 && (
                      <button className="rm-chip-more" title="Show all chat channels" onClick={() => setChatChipsOpen(true)}>
                        +{rest}
                      </button>
                    )}
                  </div>
                );
              }
              return (
                <div className="rm-chat-chips" onMouseLeave={() => chatMini && setChatChipsOpen(false)}>
                  {all.map((p) => (
                    <button
                      key={p}
                      className={`rm-chat-chip${chatOn[p] ? " on" : ""}`}
                      title={chatOn[p] ? `Hide ${p}` : `Show ${p}`}
                      onClick={() => setChatOn((f) => ({ ...f, [p]: !f[p] }))}
                    >
                      <span className="rm-chip-logo">{PLATFORM_LOGO[p]}</span>
                      <span className="rm-chip-name">{p === "youtube" ? "YouTube" : p[0].toUpperCase() + p.slice(1)}</span>
                    </button>
                  ))}
                </div>
              );
            })()}
            {formDockOf("chat") === "top" ? (
              /* MINI: the latest message, the previous poking through above
               * it. Rendered explicitly — no scroll/mask tricks that can
               * quietly swallow the content in a 40px window. */
              (() => {
                const visible = chatMsgs.filter((m) => chatOn[m.platform] !== false).slice(-2);
                return (
                  <div className="rm-chat-mini">
                    {visible.map((m, i) => (
                      <div key={i} className={`rm-chat-msg${i === visible.length - 1 ? "" : " prev"}`}>
                        <span className="rm-chat-user">{m.user}</span>
                        <ChatText text={m.text} emotes={m.emotes} channelEmotes={channelEmotes} />
                      </div>
                    ))}
                    {visible.length === 0 && (
                      <div className="rm-chat-mini-empty">
                        {chatLive ? "Connected — waiting for the first message." : "Connect chat to read it here."}
                      </div>
                    )}
                  </div>
                );
              })()
            ) : (
            <div className="rm-chat-list" ref={chatList} onScroll={onChatScroll} onWheel={onChatWheel}>
              {chatMsgs
                .filter((m) => chatOn[m.platform] !== false)
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
            )}
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
        if (!isHost) {
          return <div className="rm-rows-empty">The set is the host's. Cut scenes and run the roster from here; sources live in their Producer.</div>;
        }
        if (overlayInline) {
          return (
            <div className="rm-filters">
              <div className="rm-filters-head">
                <button className="rm-crumb" onClick={() => setOverlayInline(false)}>
                  {ic.chevRight}
                  Sources
                </button>
                <span className="rm-filters-title">Overlay</span>
              </div>
              <OverlayPicker
                activeWindow={sources.overlay_window ?? null}
                activeUrl={sources.overlay_url ?? null}
              />
            </div>
          );
        }
        if (filterFor) {
          return (
            <FilterEditor
              sourceId={filterFor.id}
              sourceLabel={filterFor.label}
              media={filterFor.media}
              locked={!isHost}
              onBack={() => setFilterFor(null)}
            />
          );
        }
        if (deviceFor) {
          return (
            <div className="rm-filters">
              <div className="rm-filters-head">
                <button className="rm-crumb" onClick={() => setDeviceFor(null)}>
                  {ic.chevRight}
                  Sources
                </button>
                <span className="rm-filters-title">{deviceFor.label} · Device</span>
              </div>
              {deviceFor.key.startsWith("window:") ? (
                <div className="rm-devices">
                  <WindowPickerList
                    itemId={deviceFor.key.slice(7)}
                    onPick={replaceWindowSource}
                    onPicked={() => setDeviceFor(null)}
                  />
                </div>
              ) : (
                <DevicePicker kind={deviceFor.key} onClose={() => setDeviceFor(null)} />
              )}
            </div>
          );
        }
        const liveItems = sources.items ?? [];
        const itemIdFor = (key: string) => (key === "alerts" ? "overlay" : key);
        const itemFor = (key: string) => liveItems.find((i) => i.id === itemIdFor(key));
        // Membership: a scene with a look lists only its own sources — the
        // well-known ones included (a source kept alive for another scene is
        // not a row here).
        const inScene = (id: string) => {
          const sc = scenes.find((x) => x.id === activeScene);
          return !sc?.look || Object.keys(sc.look).length === 0 || id in sc.look;
        };
        const activeRows = (
          [
            sources.screen && inScene("screen") && { key: "screen", label: "Screen", icon: ic.screen, device: "screen", remove: () => removeCoreSource("screen") },
            sources.camera && inScene("camera") && { key: "camera", label: "Camera", icon: ic.cam, device: "camera", remove: () => removeCoreSource("camera") },
            overlayActive && inScene("overlay") && { key: "alerts", label: "Overlay", icon: ic.link, remove: () => removeCoreSource("overlay") },
            // Audio is a source, like OBS: the picker lives here, the fader
            // lives in the mixer.
            sources.mic && { key: "mic", label: "Microphone", icon: ic.mic, device: "mic", audio: true, remove: () => setSrc({ mic: false }) },
            // Open-list items, straight from engine truth. Guest ITEMS are
            // excluded: slots are the general idea — guest geometry belongs
            // to gslot scene furniture, and people are managed per-person in
            // the Guests panel. The retired aggregate "Guests · n/m" row is
            // exactly what slots replaced.
            ...liveItems
              .filter((i) => !["screen", "camera", "overlay"].includes(i.id) && i.kind !== "guest")
              // A MOD FEED is a row in every scene (it is not scene furniture:
              // its place is the room's mod_feeds), and only while it is on
              // the set — a connected-but-unplaced seat lives in Mods.
              .filter((i) => (i.kind === "mod" ? i.visible : inScene(i.id)))
              .map((i) => ({
                key: i.id,
                label: i.label || i.kind,
                icon: EXTRA_ICONS[i.kind] ?? ic.link,
                // Window items are re-selectable: same strip, list of windows.
                device: i.kind === "window" ? `window:${i.id}` : undefined,
                inviteUrl: (cfg.sources.extras ?? []).find((e) => e.id === i.id)?.invite_url,
                // Visual extras can carry a sponsor credit (#50).
                credit: ["image", "text", "media", "color"].includes(i.kind)
                  ? (cfg.sources.extras ?? []).find((e) => e.id === i.id)?.binding?.sponsor ?? ""
                  : undefined,
                remove: () => {
                  if (i.kind === "mod") {
                    const owner = modSourceOwner(i.id, liveRowsRef.current);
                    if (owner) removeModFeed(owner.row.id, owner.track, "source row");
                    return;
                  }
                  removeExtraSource(i.id);
                },
              })),
          ].filter(Boolean) as {
            key: string;
            label: string;
            icon: ReactNode;
            device?: string;
            audio?: boolean;
            credit?: unknown;
            remove: () => void;
          }[]
        ).sort((a, b) => {
          // Microphone (audio-only, grip-less) stays at the bottom.
          const rank = (k: string) => (k === "mic" ? 1 : 0);
          if (rank(a.key) !== rank(b.key)) return rank(a.key) - rank(b.key);
          const zOf = (k: string) => itemFor(k)?.z;
          const za = zOf(a.key);
          const zb = zOf(b.key);
          if (za != null && zb != null) return zb - za; // topmost first
          if (za != null) return -1;
          if (zb != null) return 1;
          return 0;
        });
        return (
          <>
              <div
                className="rm-rows"
                ref={srcRowsRef}
                onWheel={(e) => {
                  // Sideways rows (top dock): a plain wheel/two-finger vertical
                  // scroll drives the strip, so it scrolls without a bar.
                  const el = e.currentTarget;
                  if (el.scrollWidth <= el.clientWidth) return;
                  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
                }}
              >
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
                      data-srcrow={item ? t.key : undefined}
                      className={`rm-row${hidden ? " off" : ""}${srcDrag?.key === t.key ? " dragging" : ""}${stageSel === itemIdFor(t.key) ? " sel" : ""}${dropCls}`}
                      // Clicking a row lights its output on the stage — selection
                      // is shared state in both directions.
                      onClick={() => item && setStageSel(stageSel === item.id ? null : item.id)}
                    >
                      {item && (
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
                      {(t.key === "alerts" || t.device) && (
                        <button
                          className={`rm-row-edit${srcSettings === t.key ? " on" : ""}`}
                          title="Source settings"
                          onClick={() => {
                            // Docked on a ROW (sheet or top rail) → the
                            // horizontal settings strip beside the dock.
                            // Docked on a sidebar → the strip has nowhere to
                            // live, so pop vertically right here.
                            if (dockOf(layout, "sources") === "bottom" || dockOf(layout, "sources") === "top") {
                              setSrcSettings((k) => (k === t.key ? null : t.key));
                            } else if (t.key === "alerts") {
                              setOverlayInline(true);
                            } else if (t.device) {
                              setDeviceFor({ key: t.device, label: t.label });
                            }
                          }}
                        >
                          {ic.gear}
                        </button>
                      )}
                      {t.credit !== undefined && (
                        <button
                          className={`rm-row-edit rm-row-credit${t.credit ? " on" : ""}`}
                          title={t.credit ? `Credited to ${String(t.credit)} — show/hide is recorded in the run report` : "Add a sponsor credit (recorded in the run report)"}
                          onClick={() => setSourceCredit(t.key)}
                        >
                          ©
                        </button>
                      )}
                      {item && (
                        <button
                          className={`rm-row-edit rm-row-eye${hidden ? " off" : ""}`}
                          title={hidden ? "Show on stage" : "Hide from stage"}
                          onClick={() => {
                            ipc.liveSetTransform(item.id, { visible: hidden }, true).catch(() => {});
                            captureActiveLook();
                          }}
                        >
                          {ic.eye}
                        </button>
                      )}
                      <button className="rm-row-edit rm-row-remove" title="Remove from this room" onClick={t.remove}>
                        {ic.x}
                      </button>
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
            role={roomRole}
            control={roomAccess.can.control}
            stage={modStage.confirmed}
            stageState={modStage}
            onAdmit={admitGuest}
            onRemove={removeGuest}
            onMute={(id, muted) => setSourceAudio(id, undefined, muted).catch(() => {})}
            onShow={(id, show) => (show ? void showGuestInSlot(id) : hideGuestFromSlot(id))}
            onStageToggle={(id) => void modStageToggle(id)}
            onOrder={(id, dir) => void modOrder(id, dir)}
            form={formDockOf("guests") === "top" ? "row" : "column"}
          />
        );
      case "vote": {
        // The vote is its own panel (v0.4.33): one question, the set shows
        // the answer. Form follows the dock (lib/votePanel.ts).
        if (!roomAccess.can.interactions) {
          return <div className="rm-rows-empty">This seat can't run votes — the host grants room.interactions.</div>;
        }
        const form = voteFormFor(formDockOf("vote"), { state: vote?.state ?? null, editing: voteEdit });
        return (
          <VotePanel
            form={form}
            vote={vote}
            audienceLink={audienceLink}
            editing={voteEdit}
            onEdit={(open, anchor) => {
              if (anchor) setPopAnchor(anchor);
              setVoteEdit(open);
            }}
            onOpen={(i) => void openVote(i)}
            onTransition={(t, hold) => void transitionVote(t, hold)}
            onAudienceLink={() => void copyAudienceLink()}
            popover={
              <Pop anchor={popAnchor} align="right" className="rm-pop-vote">
                <VoteEditor onOpen={(i) => void openVote(i)} onBack={() => setVoteEdit(false)} />
              </Pop>
            }
          />
        );
      }
      case "mods":
        // Seats — never guests (founder: the guests panel never lists a
        // monitor row). Host: media toggles per seat + seat someone.
        if (!boominRoom) return <div className="rm-rows-empty">Seats live on Boomin rooms. On an open server, mint a mod link from Guests.</div>;
        return (
          <ModsPanel
            seats={seatRows}
            items={(sources.items ?? []).filter((i) => i.kind === "mod")}
            isHost={isHost}
            canManage={isHost || roomAccess.can.manage}
            members={members}
            grants={roomGrants}
            onToggleGrant={(g, grant, on) => void toggleSeatGrant(g, grant, on)}
            onPlace={(g, track, on) => (on ? void placeModFeed(g.id, track, "mods panel") : removeModFeed(g.id, track, "mods panel"))}
            onSeat={(m, r) => void seatMember(m, r)}
            error={modsErr}
          />
        );
      case "mixer":
        if (!isHost) return <div className="rm-rows-empty">Audio is mixed in the host's Producer.</div>;
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
                      horizontal={formDockOf("mixer") === "top"}
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
        // Icon toggles are the channels form in EVERY dock — the logos ARE
        // the component. The rows form (with key entry) lives on in the
        // header popover and Home settings.
        const chnTop = true;
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
                    {/* In a side rail the toggle expands into a row and says
                      * its state; in the top/bottom rows it stays a logo. */}
                    <span className="chn-ico-txt">
                      <b>{d.label}</b>
                      <i>
                        {!d.enabled
                          ? "Off"
                          : !streaming
                            ? "Ready"
                            : st && st.phase === "live"
                              ? "On"
                              : (st && (PHASE_COPY[st.phase] ?? PHASE_COPY.idle).label) || "Starting"}
                      </i>
                    </span>
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
      case "updates": {
        // The stream of what shipped. Every #N reference is a real link to
        // the exact PR/issue; the version header opens the release itself.
        const REPO = "https://github.com/Boomin-Ai/producer";
        const linkify = (text: string) =>
          text.split(/(#\d+|https?:\/\/\S+)/g).map((part, k) => {
            if (/^#\d+$/.test(part)) {
              return (
                <a key={k} className="upd-ref" onClick={() => openUrl(`${REPO}/issues/${part.slice(1)}`).catch(() => {})}>
                  {part}
                </a>
              );
            }
            if (/^https?:\/\//.test(part)) {
              return (
                <a key={k} className="upd-ref" onClick={() => openUrl(part).catch(() => {})}>
                  {part.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
                </a>
              );
            }
            return part;
          });
        if (formDockOf("updates") === "top") {
          // ROW FORM: one line — the latest tag and its first sentence,
          // ellipsized like chat's last message. The list is column-only.
          const latest = Array.isArray(releases) ? releases[0] : null;
          return (
            <div className="upd upd-strip">
              {releases === null && <span className="upd-line">Checking for updates…</span>}
              {releases === "err" && <span className="upd-line">The update stream goes live when the repo does.</span>}
              {latest && (
                <span className="upd-line" onClick={() => openUrl(latest.html_url).catch(() => {})} title={latest.name || latest.tag_name}>
                  <span className="upd-tag">{latest.tag_name}</span>
                  <span className="upd-sentence"> · {firstSentence(latest.body) || latest.name || ""}</span>
                </span>
              )}
            </div>
          );
        }
        return (
          <div className="upd">
            {releases === null && <div className="rm-rows-empty">Checking for updates…</div>}
            {releases === "err" && (
              <div className="rm-rows-empty">
                The update stream goes live when the repo does.
              </div>
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
                        .slice(0, 6)
                        .map((l, k) => (
                          <p key={k}>{linkify(l.replace(/^[-*#\s]+/, ""))}</p>
                        ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        );
      }
      case "stats": {
        // The numbers behind the health dot. Real data only.
        const fmtT = (secs: number) =>
          `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
        // Render load: mean render time / frame budget, 0–100%. The area is
        // a 60 s window at the 1 Hz status tick; the axis ceiling follows the
        // window's peak so an idle engine's jitter is still a curve.
        const loadNow = loadHist.length ? loadHist[loadHist.length - 1] : 0;
        const loadTone = renderTone(loadNow);
        const loadScale = renderScale(loadHist);
        const CW = 240;
        const CH = 80;
        const { line, area } = areaPath(loadHist, CW, CH, loadScale);
        const budgetUs = snapshot?.video_fps ? 1e6 / snapshot.video_fps : 0;
        const loadTitle = engineOk
          ? `Render load: mean render time over the frame budget${
              snapshot?.render_time_us ? ` (${(snapshot.render_time_us / 1000).toFixed(2)} ms of ${(budgetUs / 1000).toFixed(1)} ms)` : ""
            }, last 60 s`
          : "Render load — engine stopped";
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
            <div className={`stx-chart tone-${loadTone}`} title={loadTitle}>
              <div className="stx-chart-head">
                <span className="stx-lbl">Render load</span>
                <span className="stx-chart-now">{engineOk ? `Render ${loadNow < 10 ? loadNow.toFixed(1) : loadNow.toFixed(0)}%` : "Stopped"}</span>
              </div>
              <div className="stx-chart-plot">
                <span className="stx-chart-scale">{loadScale}%</span>
                <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" aria-hidden="true">
                  <line className="stx-chart-base" x1="0" y1={CH - 0.5} x2={CW} y2={CH - 0.5} />
                  {area && <path className="stx-chart-area" d={area} />}
                  {line && <path className="stx-chart-line" d={line} />}
                </svg>
              </div>
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
          {isHost && (
            <button
              className="rm-guest-modlink rm-head-modlink"
              title="Mint a link another Producer opens to help run this room: admit, stage, order, remove, and cut scenes. Never on the set."
              onClick={() => void mintModLink()}
            >
              Mod link
            </button>
          )}
          <button
            className="rm-panel-plus"
            title="Copy the room's guest link"
            onClick={copyRoomLink}
          >
            {ic.link}
          </button>
        </>
      );
    }
    if (id === "scenes") {
      // Off-host the list is the host's directory: no transition to set, no
      // scene to save from a set this Producer does not hold.
      if (!isHost) return null;
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
    }
    if (id === "chat")
      return (
        <>
          <button
            className={`rm-panel-plus rm-chat-plug${chatLive ? " live" : ""}`}
            title={!isHost ? "Chat channels — set by the host" : chatLive ? "Chat channels" : "Connect your chat"}
            onClick={(e) => {
              setPopAnchor(e.currentTarget);
              setChatSetupOpen((o) => !o);
            }}
          >
            {ic.link}
          </button>
          {chatSetupOpen && isHost && (
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
          {chatSetupOpen && !isHost && (
            <Pop anchor={popAnchor} align="right" className="rm-pop-chat">
              <div className="rm-chatsetup">
                <div className="rm-pop-title">CHAT CHANNELS</div>
                {(["twitch", "kick", "youtube"] as const).map((p) => (
                  <div key={p} className="rm-chatsetup-row">
                    <span className="rm-chatsetup-label">
                      {p === "youtube" ? "YouTube" : p[0].toUpperCase() + p.slice(1)}
                      {chatConns.find((c) => c.platform === p)?.connected && <span className="rm-chatsetup-on">reading</span>}
                    </span>
                    <span className="rm-chatsetup-ro">{chatNames[p] || "—"}</span>
                  </div>
                ))}
                {chatError && <div className="rm-chatsetup-err">{chatError}</div>}
                <div className="rm-chatsetup-foot">
                  <span className="rm-chatsetup-note">
                    {monitorState?.roomInfo ? "These are the host's room channels — only the host changes them." : "Waiting for the host to publish the room's channels…"}
                  </span>
                </div>
              </div>
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
      // A non-host seat has no "+": the set is the host's (the body says so).
      if (!isHost) return null;
      const addable = [
        !sources.screen && { key: "screen", label: "Screen", icon: ic.screen, act: () => setSrc({ screen: true }) },
        !sources.camera && { key: "camera", label: "Camera", icon: ic.cam, act: () => setSrc({ camera: true }) },
        !overlayActive && { key: "alerts", label: "Overlay", icon: ic.link, act: () => setOverlayInline(true) },
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
        {
          key: "gslot",
          label: "Guest slot",
          icon: ic.invite,
          act: () => {
            const n = slotItems().length + 1;
            const id = `gslot-${n}`;
            extraSources
              .add(id, `Guest ${n}`, { kind: "color", color: "#10151d" })
              .then(() => {
                const c = cfgRef.current;
                writeCfg({
                  ...c,
                  sources: {
                    ...c.sources,
                    extras: [...(c.sources.extras ?? []), { id, label: `Guest ${n}`, spec: { kind: "color", color: "#10151d" } }],
                  },
                });
              })
              .catch((e) => setBanner(String(e)));
          },
        },
        { key: "window", label: "Window capture", icon: ic.screen, act: () => setSrcSubPop("window") },
        // A seated mod's feed (v0.4.32): pick a seat holding media; its
        // camera / screen lands as a MOD source — own layer, own rect.
        boominRoom && { key: "mod", label: "Mod feed", icon: ic.mod, act: () => setSrcSubPop("mod") },
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
      const horizontal = dock === "bottom" || dock === "top";
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

  /** Dock-level surface ownership (edit mode only): the DOCK paints one card
   * and its components go flat, or every panel keeps its own card. Dock-level
   * by decree — never per component. */
  const bgToggle = (dock: Dock) => {
    if (!layoutEdit || dock === "hidden") return null;
    const on = !!cfg.dock_bg?.[dock];
    return (
      <button
        key={`${dock}-bg`}
        className={`rm-dock-bgbtn${on ? " on" : ""}`}
        title={on ? "Dock owns the background — click to give each panel its own card" : "Panels own their cards — click to merge this dock into one surface"}
        onClick={() => {
          const c = cfgRef.current;
          writeCfg({ ...c, dock_bg: { ...c.dock_bg, [dock]: !on } });
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="4" width="16" height="16" rx="4" fill={on ? "currentColor" : "none"} fillOpacity={on ? 0.35 : 0} />
        </svg>
      </button>
    );
  };

  const renderDock = (dock: Dock) => {
    const ids = layout[dock];
    return (
      <>
        {ids.map((id, i) => (
          <Fragment key={id}>
            {/* A splitter between every pair of neighbours, in every dock —
             * up/down in the side rails, left/right in the rows. */}
            {dock !== "hidden" && i > 0 && !layoutEdit && splitter(dock, ids[i - 1], id)}
            {slot(dock, i)}
            {renderPanel(id)}
          </Fragment>
        ))}
        {slot(dock, ids.length)}
        {addButton(dock)}
        {bgToggle(dock)}
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
      data-in={formDockOf(id)}
      className={`rm-panel rm-panel-${id}${dragging === id ? " dragging" : ""}`}
      style={(() => {
        // A weight is RELATIVE to a sibling and EARNED in a specific dock:
        // alone, or in a dock it wasn't dragged in, it must not apply — a
        // stale weight pinned chat mid-rail while guests filled.
        const d = dockOf(layout, id);
        const w = d === "hidden" || layout[d].length < 2 ? undefined : weightOf(d, id);
        return w ? { flexGrow: w, flexBasis: 0 } : undefined;
      })()}
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
          {/* What you are here — the same card a mod seat and a self-hosted
            * room show (views/RoleCard.tsx). The host's own room says so
            * quietly; a mod's says what the seat may do. */}
          <RoleCard access={roomAccess} compact pending={accessPending} />
        </div>

        {/* The way DOWN and the way AROUND both live at the FAR LEFT, apart
          * from the transport cluster: collapse first, then edit. */}
        <button
          className="rm-leave"
          onClick={() => onLeave?.()}
          title={streaming ? "Collapse — the stream keeps running" : "Collapse room"}
        >
          {ic.collapseDown}
        </button>
        {/* Layout editing is stage furniture for the person running the set;
          * a control seat gets the panels as they are. */}
        {isHost && (
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
        )}

        {/* The header's health chip was the footer's stream-health meter said
          * twice; the footer keeps it (with fps), the LIVE pill keeps time. */}
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
          {/* HOST-ONLY TRANSPORT. A mod or manager on Boomin holds a control
            * seat, not the show: no guest link to hand out, no channels, no
            * encoder, no recording, no GO LIVE, no virtual camera — exactly
            * what an open-server mod seat (views/ModSeat.tsx) never shows.
            * Scenes, guests, votes and chat stay, gated by `can`. */}
          {isHost ? (
            <>
          <span className="hd-link-group">
            <button
              className="hd-chip hd-link"
              title="Copy this room's guest link"
              onClick={copyRoomLink}
            >
              {ic.link ?? "🔗"} Link
            </button>
            <button
              className={`hd-chip hd-link-more${linkMenuOpen ? " on" : ""}`}
              title="More"
              aria-label="Link options"
              onClick={(e) => {
                setPopAnchor(e.currentTarget);
                setLinkMenuOpen((o) => !o);
              }}
            >
              ▾
            </button>
          </span>
          {linkMenuOpen && (
            <Pop anchor={popAnchor} align="left" className="rm-pop-link">
              <button
                className="rm-pop-row"
                onClick={async () => {
                  setLinkMenuOpen(false);
                  // VERBATIM: the join link is whatever the endpoint returned
                  // (a self-hosted server's own origin, or Boomin's). Producer
                  // never rewrites the host.
                  const url = guestLink ?? (await ensureGuestLink());
                  if (url) await openUrl(url).catch(() => setBanner(url));
                }}
              >
                Open guest page in browser
              </button>
            </Pop>
          )}
          <button
            className="hd-chip hd-chans"
            title="Channels this room goes out to"
            onClick={(e) => {
              setPopAnchor(e.currentTarget);
              setDestsOpen((o) => !o);
            }}
          >
            {enabledDests.length > 0 ? (
              enabledDests.map((d) => (
                <span key={d.id} className="hd-chan-logo">
                  {PLATFORM_LOGO[d.preset] ?? <span className="rm-row-dot" style={{ background: PLATFORM_TINT[d.preset] ?? "oklch(0.6 0.02 250)" }} />}
                </span>
              ))
            ) : (
              <span>Channels</span>
            )}
            {ic.chev}
          </button>
          {destsOpen && (
            <Pop anchor={popAnchor} align="right" className="rm-pop-dests">
              <div className="rm-pop-title">CHANNELS</div>
              {destinations.map((d) => {
                const st = statuses.get(d.id);
                const phase = st ? PHASE_COPY[st.phase] ?? PHASE_COPY.idle : PHASE_COPY.idle;
                return (
                  <div key={d.id} className="chn-row" style={{ minWidth: 220 }}>
                    <span className="chn-logo">{PLATFORM_LOGO[d.preset] ?? <span className="rm-row-dot" />}</span>
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
                      onClick={() => toggleEnabled(d)}
                    >
                      <span className="rm-switch-knob" />
                    </button>
                  </div>
                );
              })}
              {destinations.length === 0 && <div className="rm-rows-empty">No channels yet.</div>}
            </Pop>
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
                  {[720, 1080, 2160].map((h) => {
                    const gated = h === 2160 && !hwEncoder;
                    return (
                      <button
                        key={h}
                        className={`rm-q${vh === h ? " on" : ""}`}
                        disabled={streaming || !engineOk || gated}
                        title={gated ? "4K needs a hardware encoder (VideoToolbox, NVENC, QSV, or AMF)" : undefined}
                        onClick={() => setVideoCfg(h, h === 2160 && !hw4k60 ? 30 : vf)}
                      >
                        {h}p{h === 2160 && <span className="rm-q-tag">4K</span>}
                      </button>
                    );
                  })}
                </span>
              </div>
              <div className="rm-ctrl-row">
                <span className="rm-ctrl-label">Frame rate</span>
                <span className="rm-quality-set">
                  {[30, 60].map((f) => {
                    const gated = f === 60 && vh === 2160 && !hw4k60;
                    return (
                      <button
                        key={f}
                        className={`rm-q${vf === f ? " on" : ""}`}
                        disabled={streaming || !engineOk || gated}
                        title={
                          gated
                            ? hwEncoder
                              ? "4K on an Intel Mac runs at 30 fps"
                              : "4K needs a hardware encoder (VideoToolbox, NVENC, QSV, or AMF)"
                            : undefined
                        }
                        onClick={() => setVideoCfg(vh, f)}
                      >
                        {f}
                      </button>
                    );
                  })}
                </span>
              </div>
              <div className="rm-ctrl-row">
                <span className="rm-ctrl-label">Bitrate</span>
                <span className="rm-ctrl-value" title="Producer negotiates the best rate every channel accepts">Auto</span>
              </div>
            </Pop>
          )}

          {streaming && (
            <span className="hd-live">
              <span className="stg-live-dot" />
              LIVE {`${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}
            </span>
          )}
            </>
          ) : (
            <span className="rm-top-seat-note">
              {accessPending ? "" : roomAccess.role === "viewer" ? "Read-only seat" : "Control seat — the host runs the show"}
            </span>
          )}
        </div>
      </header>
      {seat && <GreenRoomBar seat={guestSeat} spec={seat} onLeave={() => onLeave?.()} />}

      {/* THE MOD VIEW (views/ModBoard.tsx): a non-host seat gets a board of
        * its own — host output, scene pads, people, my feeds, switches —
        * never the host's dock layout. The host's body follows. */}
      {!isHost ? (
        <ModBoard
          title={room?.name ?? "Room"}
          access={roomAccess}
          pending={accessPending}
          boomin={boominRoom}
          online={!!monitorSeat || !!mediaLeg}
          program={(mediaLeg as ProgramSource | null) ?? monitorSeat}
          scenes={hostScenes}
          onCut={(id) => void cutHostScene(id)}
          vote={
            roomAccess.can.interactions ? (
              <VotePanel
                form={voteFormFor("left", { state: vote?.state ?? null, editing: voteEdit })}
                vote={vote}
                audienceLink={audienceLink}
                editing={voteEdit}
                onEdit={(open) => setVoteEdit(open)}
                onOpen={(i) => void openVote(i)}
                onTransition={(t, hold) => void transitionVote(t, hold)}
                onAudienceLink={() => void copyAudienceLink()}
              />
            ) : undefined
          }
          voteLive={!!vote && vote.state !== "closed" && vote.state !== "cancelled"}
          onAudienceLink={roomAccess.can.interactions ? () => void copyAudienceLink() : undefined}
          audienceLink={audienceLink}
          people={
            <GuestPanel
              thumbs={{}}
              roster={roster}
              error={null}
              items={[]}
              role={roomRole}
              control={roomAccess.can.control}
              stage={modStage.confirmed}
              stageState={modStage}
              onAdmit={admitGuest}
              onRemove={removeGuest}
              onMute={() => {}}
              onShow={() => {}}
              onStageToggle={(id) => void modStageToggle(id)}
              onOrder={(id, dir) => void modOrder(id, dir)}
            />
          }
          grants={myGrants}
          feeds={seatFeeds(myGrants)}
          media={mediaLeg}
          throwUp={throwUpState({ stage: modStage, seatId: mySeatId, grants: myGrants, canAsk: roomAccess.can.control })}
          onThrowUp={(k) => void throwUp(k)}
          layout={boardLayout}
          error={guestErr}
        />
      ) : (
      <>
      {layoutEdit && (
        <div className="rm-editbar">
          <span className="rm-editbar-dot" />
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
          {/* Where the stage's quick controls float — an edge of the canvas. */}
          <span className="rm-editbar-ctl" title="Quick controls position">
            {(["left", "top", "bottom", "right"] as const).map((pos) => (
              <button
                key={pos}
                className={`rm-editbar-pos${(cfg.stage_bar ?? "bottom") === pos ? " on" : ""}`}
                title={`Controls on the ${pos}`}
                onClick={() => writeCfg({ ...cfgRef.current, stage_bar: pos })}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="3" width="18" height="18" rx="4" />
                  {pos === "left" && <rect x="5" y="8" width="4" height="8" rx="1" fill="currentColor" stroke="none" />}
                  {pos === "right" && <rect x="15" y="8" width="4" height="8" rx="1" fill="currentColor" stroke="none" />}
                  {pos === "top" && <rect x="8" y="5" width="8" height="4" rx="1" fill="currentColor" stroke="none" />}
                  {pos === "bottom" && <rect x="8" y="15" width="8" height="4" rx="1" fill="currentColor" stroke="none" />}
                </svg>
              </button>
            ))}
          </span>
          <span className="rm-editbar-text">
            Editing layout — drag a panel by its grip, or use + to add one
          </span>
        </div>
      )}

      {/* The TOP DOCK: a real dock — drag any panel up here (Controller
        * belongs; chat while chatting; whatever the show needs). Renders only
        * when populated or while editing, so the default room stays clean. */}
      {(layout.top.length > 0 || layoutEdit) && (
        <>
          {(topOpen || layoutEdit) && (
            <div
              data-dock="top"
              className={`rm-dock rm-dock-top${layout.top.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "top" ? " hot" : ""}${cfg.dock_bg?.top ? " dock-bg" : ""}${shown.top ? " sized" : ""}${topExpanded ? " expanded" : ""}`}
              style={topOpen && shown.top ? { height: shown.top } : undefined}
            >
              {renderDock("top")}
            </div>
          )}
          {(topOpen || layoutEdit) && sceneSettings && dockOf(layout, "scenes") === "top" && (
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
          {(topOpen || layoutEdit) && srcSettings && dockOf(layout, "sources") === "top" && (
            <SourceSettingsStrip
              rowKey={srcSettings}
              items={sources.items ?? []}
              sources={sources}
              onClose={() => setSrcSettings(null)}
              openOverlay={() => { setSrcSettings(null); setOverlayInline(true); }}
              onPickWindow={replaceWindowSource}
            />
          )}
          {!layoutEdit && (
            <div
              className={`rm-vtab rm-vtab-top${topOpen ? "" : " closed"}`}
              role="button"
              tabIndex={0}
              title={topOpen ? "Drag to resize — click to hide" : "Show the top dock"}
              onPointerDown={(e) => beginResize(e, "top", undefined, undefined, topOpen)}
              onPointerMove={moveResize}
              onPointerUp={() => endResize(() => setTopOpen((o) => !o))}
              onPointerCancel={() => endResize()}
              onKeyDown={(e) => e.key === "Enter" && setTopOpen((o) => !o)}
            >
              <span className="rm-sheet-handle" />
            </div>
          )}
        </>
      )}

      <div className="rm-body">
        {(leftOpen || layoutEdit) && (
          <aside
            data-dock="left"
            className={`rm-dock rm-dock-side${layout.left.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "left" ? " hot" : ""}${cfg.dock_bg?.left ? " dock-bg" : ""}`}
            style={layout.left.length && shown.left ? { width: shown.left, flex: "0 0 auto" } : undefined}
          >
            {renderDock("left")}
          </aside>
        )}
        {layout.left.length > 0 && !layoutEdit &&
          splitter("left", undefined, undefined, { open: leftOpen, onToggle: () => setLeftOpen((o) => !o) })}

        <div className="rm-center">
          <div className="rm-canvas">
            {/* Off-host the stage is a PROGRAM MONITOR, not an editor: the
              * native preview is never attached (there is no local set to
              * show — see localSetDecision) and the picture is the host's,
              * received on this seat's return-feed row (lib/monitorFeed.ts).
              * The note stays only while the leg connects — or on an open
              * server, where a mod link carries no media leg at all. */}
            {engineOk && !isHost && (
              <ProgramMonitorStage seat={monitorSeat} pending={accessPending} boomin={boominRoom} />
            )}
            {engineOk && isHost && (
              <PreviewPanel>
                <StageEditor
                  items={sources.items ?? []}
                  baseW={(vh * 16) / 9}
                  baseH={vh}
                  disabled={!engineOk || !isHost}
                  onOrder={(id, dir) => {
                    const items = sources.items ?? [];
                    const it = items.find((i) => i.id === id);
                    if (!it) return;
                    // A bound guest re-layers as its slot: the slot moves,
                    // the guest is placed at the slot's new layer.
                    const slotId = it.kind === "guest" ? slotOfGuest(cfgRef.current.slot_bindings ?? {}, id) : null;
                    const slot = slotId ? items.find((i) => i.id === slotId) : undefined;
                    if (slot) {
                      const z = Math.max(0, slot.z + dir);
                      ipc
                        .liveSetTransform(slot.id, { z }, true)
                        .then(() => ipc.liveSetTransform(id, { z }, true))
                        .catch(() => {});
                    } else {
                      ipc.liveSetTransform(id, { z: it.z + dir }, true).catch(() => {});
                    }
                    captureActiveLook();
                  }}
                  onSelect={setStageSel}
                  selectId={stageSel}
                  onDelete={(id) => {
                    deleteStageItem(id);
                    captureActiveLook();
                  }}
                  onLive={(id, patch) => mirrorToSlot(id, patch, false)}
                  onCommit={(id, patch) => {
                    mirrorToSlot(id, patch, true);
                    rememberModPlacement(id, patch);
                    captureActiveLook();
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

          {/* Mic / camera / screen / record act on OUR engine — host only. */}
          {engineOk && isHost && (
            <div className={`stg-bar pos-${cfg.stage_bar ?? "bottom"}`}>
              <button
                className={`stg-btn${sources.mic_muted ? " off" : ""}`}
                title={sources.mic_muted ? "Unmute mic" : "Mute mic"}
                onClick={toggleMute}
              >
                {ic.mic}
              </button>
              {(() => {
                const cam = (sources.items ?? []).find((i) => i.id === "camera");
                return cam && isHost ? (
                  <button
                    className={`stg-btn${cam.visible ? "" : " off"}`}
                    title={cam.visible ? "Hide camera" : "Show camera"}
                    onClick={() => {
                      ipc.liveSetTransform("camera", { visible: !cam.visible }, true).catch(() => {});
                      captureActiveLook();
                    }}
                  >
                    {ic.cam}
                  </button>
                ) : null;
              })()}
              {(() => {
                const scr = (sources.items ?? []).find((i) => i.id === "screen");
                return scr && isHost ? (
                  <button
                    className={`stg-btn${scr.visible ? "" : " off"}`}
                    title={scr.visible ? "Hide screen" : "Show screen"}
                    onClick={() => {
                      ipc.liveSetTransform("screen", { visible: !scr.visible }, true).catch(() => {});
                      captureActiveLook();
                    }}
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
          {runReport && (
            <RunReportSheet
              report={runReport}
              roster={roster}
              extras={cfg.sources.extras ?? []}
              onClose={() => setRunReport(null)}
            />
          )}

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

        {layout.right.length > 0 && !layoutEdit &&
          splitter("right", undefined, undefined, { open: rightOpen, onToggle: () => setRightOpen((o) => !o) })}
        {(rightOpen || layoutEdit) && (
          <aside
            data-dock="right"
            className={`rm-dock rm-dock-side${layout.right.length === 0 ? " empty" : ""}${layoutEdit ? " armed" : ""}${dropHint?.dock === "right" ? " hot" : ""}${cfg.dock_bg?.right ? " dock-bg" : ""}`}
            style={layout.right.length && shown.right ? { width: shown.right, flex: "0 0 auto" } : undefined}
          >
            {renderDock("right")}
          </aside>
        )}
      </div>
      </>
      )}

      {sceneSettings && dockOf(layout, "scenes") !== "bottom" && dockOf(layout, "scenes") !== "top" && (
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

      {srcSubPop && isHost && (
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
          {srcSubPop === "mod" && (
            <div className="rm-devices">
              <div className="rm-devices-head">Mod feed</div>
              {(() => {
                const rows = seatRows
                  .filter((g) => isMediaSeat(g))
                  .flatMap((g) => {
                    const grants_ = resolveGrants(g);
                    const ids = modSourceIdsFor(g.id);
                    const out: { key: string; label: string; icon: ReactNode; ready: boolean; act: () => void }[] = [];
                    const items = sources.items ?? [];
                    if (grants_.has("media.camera") || grants_.has("media.mic")) {
                      const it = items.find((i) => i.id === ids.camera);
                      out.push({ key: ids.camera, label: modSourceLabel(g, "camera"), icon: ic.cam, ready: !!it && !it.visible, act: () => void placeModFeed(g.id, "camera", "add menu") });
                    }
                    if (grants_.has("media.screen")) {
                      const it = items.find((i) => i.id === ids.screen);
                      out.push({ key: ids.screen, label: modSourceLabel(g, "screen"), icon: ic.screen, ready: !!it && !it.visible, act: () => void placeModFeed(g.id, "screen", "add menu") });
                    }
                    return out;
                  });
                if (!rows.length) return <div className="rm-pop-empty">No seated mod holds media — give one camera or screen in Mods.</div>;
                return rows.map((r) => (
                  <div
                    key={r.key}
                    role="button"
                    tabIndex={0}
                    className={`rm-device rm-addsource${r.ready ? "" : " dim"}`}
                    title={r.ready ? "Place on the set" : "Already on the set, or its feed hasn't connected yet"}
                    onClick={() => {
                      if (!r.ready) return;
                      setSrcSubPop(null);
                      r.act();
                    }}
                  >
                    <span className="rm-row-icon">{r.icon}</span>
                    <span className="rm-device-name">{r.label}</span>
                  </div>
                ));
              })()}
            </div>
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
            title={sheetOpen ? "Drag to resize — click to hide" : "Show the bottom row"}
            onPointerDown={(e) => beginResize(e, "bottom", undefined, undefined, sheetOpen)}
            onPointerMove={moveResize}
            onPointerUp={() => endResize(() => setSheetOpen((o) => !o))}
            onPointerCancel={() => endResize()}
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
              openOverlay={() => { setSrcSettings(null); setOverlayInline(true); }}
              onPickWindow={replaceWindowSource}
            />
          )}
          {(sheetOpen || dragging) && (
            <div
              data-dock="bottom"
              className={`rm-dock rm-dock-bottom${layoutEdit ? " armed" : ""}${dropHint?.dock === "bottom" ? " hot" : ""}${cfg.dock_bg?.bottom ? " dock-bg" : ""}${shown.bottom ? " sized" : ""}${bottomSlim ? " slim" : ""}`}
              style={shown.bottom ? { height: shown.bottom } : undefined}
            >{renderDock("bottom")}</div>
          )}
        </div>
      )}
      <footer className="rm-foot">
        <span className="rm-foot-item">Producer v{appVersion ?? "…"}</span>
        {mountMs != null && (
          <span className="rm-foot-item dim-inline" title="Room open → stage ready (engine boot phases in the console)">
            opened in {(mountMs / 1000).toFixed(2)}s
          </span>
        )}
        {engineOk && (
          <span className="rm-foot-item dim-inline">
            {!streaming && enabledDests.length === 0 ? "No channels · " : ""}
            {(snapshot?.fps ?? 0).toFixed(0)} fps
          </span>
        )}
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
        <span className="rm-foot-item dim">
          {[snapshot?.graphics_backend, encoderLabel(snapshot?.video_encoder)].filter(Boolean).join(" · ")}
        </span>
      </footer>
    </div>
  );
}

/** Short, human name for the engine's H.264 encoder id (footer readout). */
function encoderLabel(id?: string | null): string {
  if (!id) return "";
  if (id.includes("videotoolbox")) return "VideoToolbox";
  if (id.includes("nvenc")) return "NVENC";
  if (id.includes("qsv")) return "QSV";
  if (id.includes("amf")) return "AMF";
  if (id === "obs_x264") return "x264";
  return id;
}
