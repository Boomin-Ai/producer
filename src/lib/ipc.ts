import { invoke } from "@tauri-apps/api/core";

export interface EndpointInfo {
  id: string;
  kind: "connected" | "independent";
  name: string;
  base_url: string;
  created_at: string;
  /** Hosted workspace scope (connected endpoints); the brand switch keys on it. */
  brand_slug?: string | null;
}

export interface Channel {
  id: string;
  platform: string;
  display_name: string;
  external_handle?: string;
  status: "active" | "needs_reconnect" | "disabled";
  capabilities?: {
    rateLimit?: { type: string; max: number; windowSeconds: number };
    media?: { kinds?: string[] };
    text?: { maxChars?: number };
  };
  /** Added client-side: which endpoint this channel lives on. */
  endpoint_id: string;
  endpoint_kind: EndpointInfo["kind"];
}

export interface Job {
  id: string;
  channel_id: string;
  intent_id?: string;
  state: string;
  attempt: number;
  due_at: string;
  error_message?: string;
  published_external_url?: string;
  created_at: string;
  published_at?: string;
  /** Added client-side. */
  endpoint_id: string;
}

export interface TargetResult {
  endpoint_id: string;
  channel_id: string;
  accepted: boolean;
  replayed: boolean;
  error: string | null;
}

export const hasTauri = () => "__TAURI_INTERNALS__" in window;

export const ipc = {
  listEndpoints: () => invoke<EndpointInfo[]>("list_endpoints"),
  removeEndpoint: (endpointId: string) => invoke("remove_endpoint", { endpointId }),
  addEndpoint: (kind: string, name: string, baseUrl: string, token: string) =>
    invoke("add_endpoint", { kind, name, baseUrl, token }),
  boominRequestOtp: (email: string, apiRoot?: string) =>
    invoke("boomin_request_otp", { email, apiRoot: apiRoot || null }),
  boominConnect: (email: string, code: string, apiRoot?: string) =>
    invoke<{ needs_brand?: boolean; brands?: { slug: string; name: string }[] }>(
      "boomin_connect",
      { email, code, apiRoot: apiRoot || null },
    ),
  boominSelectBrand: (brandSlug: string) => invoke<{ id?: string }>("boomin_select_brand", { brandSlug }),
  /** Every brand this account can act in — live from the API, for the switcher. */
  boominListBrands: (endpointId: string) =>
    invoke<{ brands: { slug: string; name: string }[] }>("boomin_list_brands", { endpointId }),
  /** Bind another brand of the same account as its own workspace (token reused). */
  boominAddBrand: (endpointId: string, brandSlug: string) =>
    invoke<{ id: string; refreshed?: boolean }>("boomin_add_brand", { endpointId, brandSlug }),
  connectChannel: (endpointId: string, platform: string) =>
    invoke<{ browser_url: string; expires_at: string }>("connect_channel", { endpointId, platform }),
  endpointChannels: (endpointId: string) =>
    invoke<{ channels: Omit<Channel, "endpoint_id" | "endpoint_kind">[] }>("endpoint_channels", { endpointId }),
  uploadMedia: (endpointId: string, filePath: string) =>
    invoke<{ upload_id: string; kind: string; filename: string; endpoint_id: string }>("upload_media", {
      endpointId,
      filePath,
    }),
  listJobs: (endpointId: string) =>
    invoke<{ jobs: Omit<Job, "endpoint_id">[] }>("list_jobs", { endpointId }),
  submitPost: (input: {
    text?: string;
    media_url?: string;
    media_upload_id?: string;
    schedule_at?: string;
    targets: {
      endpoint_id: string;
      channel_id: string;
      overrides?: Record<string, unknown>;
    }[];
  }) => invoke<{ intent_id: string; results: TargetResult[] }>("submit_post", { input }),

  // --- Live (LIVE-REVIEW.md §5.4 / §8) ---
  // Stream keys cross this boundary exactly once, inside upsert; nothing
  // here ever returns one.
  liveListDestinations: (endpointId?: string) => invoke<LiveDestination[]>("live_list_destinations", { endpointId: endpointId ?? null }),
  liveUpsertDestination: (input: {
    /** Workspace on create; ignored on update. */
    endpoint_id?: string;
    id?: string;
    preset: LivePreset;
    label: string;
    server?: string;
    key?: string;
    enabled?: boolean;
  }) => invoke<LiveDestination>("live_upsert_destination", { input }),
  liveDeleteDestination: (id: string) => invoke("live_delete_destination", { id }),
  liveGoLive: () => invoke("live_go_live"),
  liveStop: () => invoke("live_stop"),
  liveEngineStatus: () => invoke<LiveSnapshot>("live_engine_status"),
  liveSetSources: (screen: boolean, camera: boolean, mic: boolean) =>
    invoke("live_set_sources", { screen, camera, mic }),
  liveAttachPreview: (x: number, y: number, w: number, h: number) =>
    invoke<boolean>("live_attach_preview", { x, y, w, h }),
  liveMovePreview: (x: number, y: number, w: number, h: number) =>
    invoke("live_move_preview", { x, y, w, h }),
  liveDetachPreview: () => invoke("live_detach_preview"),
  livePermissions: () => invoke<LivePermissions>("live_permissions"),
  liveRequestPermission: (kind: "screen" | "camera" | "mic") =>
    invoke("live_request_permission", { kind }),
  liveScreenCoach: (
    action:
      | "chip_show"
      | "chip_hide"
      | "open_settings"
      | "open_camera_settings"
      | "open_mic_settings",
  ) =>
    invoke("live_screen_coach", { action }),
  firstlightResume: (action: "set" | "take" | "clear") =>
    invoke<boolean>("firstlight_resume", { action }),
  liveListRooms: (endpointId?: string) => invoke<LiveRoom[]>("live_list_rooms", { endpointId: endpointId ?? null }),
  liveCreateRoom: (name: string, endpointId?: string) =>
    invoke<LiveRoom>("live_create_room", { name, endpointId: endpointId ?? null }),
  liveUpdateRoom: (id: string, patch: { name?: string; config?: string; touchLive?: boolean }) =>
    invoke("live_update_room", {
      id,
      name: patch.name ?? null,
      config: patch.config ?? null,
      touchLive: patch.touchLive ?? null,
    }),
  liveDeleteRoom: (id: string) => invoke("live_delete_room", { id }),
  liveListWindows: () => invoke<LiveWindow[]>("live_list_windows"),
  liveSetOverlay: (windowId: number | null, colorKey: boolean, url?: string | null) =>
    invoke("live_set_overlay", { windowId, colorKey, url: url ?? null }),
  liveSetMicAudio: (patch: { volume?: number; muted?: boolean }) =>
    invoke("live_set_mic_audio", { volume: patch.volume ?? null, muted: patch.muted ?? null }),
  liveSetVideo: (height: number, fps: number) => invoke("live_set_video", { height, fps }),
  liveHomeGlass: () => invoke("live_home_glass"),
  /** Preview demand control: fps the engine should spend on guest thumbs
   * (0 = off). The UI asks for what it can actually display. */
  liveSetThumbRate: (fps: number) => invoke("live_set_thumb_rate", { fps }),
  /** Stage editor: commit=false at gesture rate, commit=true on release. */
  liveSetTransform: (id: string, patch: LiveTransformPatch, commit: boolean) =>
    invoke("live_set_transform", { id, patch, commit }),
  livePreviewHidden: (hidden: boolean) => invoke("live_preview_hidden", { hidden }),
  /** Rects (CSS px, window coords) the native preview must leave to the webview. */
  livePreviewCutouts: (rects: { x: number; y: number; w: number; h: number }[]) =>
    invoke("live_preview_cutouts", { rects }),
  /** Stage editor: which item is selected, so the native preview can outline it. */
  liveSetSelection: (id: string | null) => invoke("live_set_selection", { id }),
  liveOpenChat: (url: string) => invoke("live_open_chat", { url }),
};

export interface LiveWindow {
  id: number;
  owner: string;
  title: string;
}

export interface LiveRoom {
  id: string;
  name: string;
  /** JSON blob of the room's scene config (LiveSources shape). */
  config: string;
  last_live_at: string | null;
  created_at: string;
  /** Workspace (endpoint) the room belongs to; null = legacy/global. */
  endpoint_id?: string | null;
}

export interface LivePermissions {
  screen: string;
  camera: string;
  mic: string;
}

/** One scene item's live geometry, canvas coordinates (UI-P1). */
export interface LiveItem {
  id: string;
  kind: string;
  label: string;
  visible: boolean;
  /** The source has produced at least one frame (engine truth: reported
   * width > 0). Absent on older engines. The honest "on stage" signal. */
  has_frame?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  crop_left: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
  /** A/V sync offset in ms; positive means audio is delayed to meet video. */
  sync_ms?: number;
  z: number;
  src_w: number;
  src_h: number;
  /** Audio facts, so the mixer can show a strip for anything that makes
   * sound rather than only the microphone. */
  has_audio: boolean;
  volume: number;
  muted: boolean;
}

export interface LiveTransformPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
  crop_left?: number;
  crop_top?: number;
  crop_right?: number;
  crop_bottom?: number;
  z?: number;
  visible?: boolean;
}

export interface LiveSources {
  screen: boolean;
  camera: boolean;
  mic: boolean;
  mic_volume?: number;
  mic_muted?: boolean;
  overlay_window?: number | null;
  overlay_url?: string | null;
  items?: LiveItem[];
  camera_device?: string | null;
  mic_device?: string | null;
  screen_device?: string | null;
}

export type LivePreset = "twitch" | "kick" | "youtube" | "custom";

export interface LiveDestination {
  id: string;
  preset: LivePreset;
  label: string;
  server?: string | null;
  enabled: boolean;
  created_at: string;
}

/** Transport truth only: "live" means the RTMP session is accepting bytes,
 * not that the platform confirms the stream (check the dashboard). */
export type LivePhase = "idle" | "connecting" | "live" | "reconnecting" | "stopped";

export interface LiveDestStatus {
  id: string;
  phase: LivePhase;
  active: boolean;
  total_frames: number;
  dropped_frames: number;
  bytes_sent: number;
  congestion: number;
  reconnects: number;
  went_live_at_secs?: number | null;
  stop_code?: number | null;
  last_error?: string | null;
}

export type LiveSessionState = "idle" | "starting" | "streaming" | "stopping";

export interface LiveSnapshot {
  engine_ready: boolean;
  bootstrap_ok: boolean;
  graphics_backend?: string | null;
  /** Boot phase timings (name, ms): startup, reset_video, reset_audio,
   * load_modules (CEF lives here), post_load. */
  boot_phases_ms?: [string, number][];
  session_state: LiveSessionState;
  elapsed_secs: number;
  destinations: LiveDestStatus[];
  sources?: LiveSources;
  preview_attached?: boolean;
  disabled?: boolean;
  /** OBS-parity performance. Skipped frames = the machine is behind;
   * dropped frames = the network is behind. Different fixes, so both shown. */
  fps?: number;
  skipped_frames?: number;
  total_frames?: number;
  cpu?: number;
  video_height?: number;
  video_fps?: number;
  stage_transparent?: boolean;
}

export type LiveEvent =
  | { type: "engine_ready"; ok: boolean; graphics_backend?: string | null; obs_version: string }
  | { type: "session_state"; state: LiveSessionState }
  | { type: "status"; elapsed_secs: number; destinations: LiveDestStatus[] }
  | { type: "session_ended"; report: { ok: boolean; destinations: LiveDestStatus[]; notes: string[] } }
  | { type: "sources_changed"; sources: LiveSources }
  | { type: "levels"; mic_peak: number; extra_peaks: { id: string; peak: number }[] }
  | { type: "guest_thumbs"; w: number; h: number; thumbs: { id: string; jpeg: string }[] }
  | { type: "video_changed"; height: number; fps: number }
  | { type: "engine_error"; message: string };

export async function listenLiveEvents(cb: (ev: LiveEvent) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LiveEvent>("live://event", (e) => cb(e.payload));
}

// --- Live chat (P2.5) ---------------------------------------------------
// Read-only ingest: Twitch via anonymous IRC, Kick via its public Pusher
// stream. No credential crosses this boundary; sending needs an account and
// arrives with Connect.

export interface ChatMsg {
  platform: string;
  id: string;
  user: string;
  color: string | null;
  text: string;
  /** Emotes named in this message (Twitch's own), name → image URL. */
  emotes?: Record<string, string>;
}

export interface ChatConnection {
  platform: string;
  channel: string;
  connected: boolean;
}

export type ChatEvent =
  | { type: "connected"; platform: string; channel: string }
  | { type: "disconnected"; platform: string; reason: string | null }
  | { type: "message"; msg: ChatMsg }
  | { type: "emote_set"; platform: string; emotes: Record<string, string> };

export const chat = {
  connect: (platform: string, channel: string, chatroomId?: string) =>
    invoke("chat_connect", { platform, channel, chatroomId: chatroomId ?? null }),
  disconnect: (platform: string) => invoke("chat_disconnect", { platform }),
  status: () => invoke<ChatConnection[]>("chat_status"),
  /** Kick only: slug → chatroom id. Cache it; it never changes. */
  resolveKickChatroom: (slug: string) => invoke<string>("kick_resolve_chatroom", { slug }),
};

export async function listenChat(cb: (ev: ChatEvent) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ChatEvent>("chat://event", (e) => cb(e.payload));
}

/** One selectable device behind a source's picker (UI-P2.9). */
export interface DeviceOption {
  id: string;
  name: string;
  disabled: boolean;
}

export const devices = {
  /** kind: "camera" | "mic" | "screen" */
  list: (kind: string) => invoke<DeviceOption[]>("live_source_devices", { kind }),
  set: (kind: string, device: string) => invoke("live_set_source_device", { kind, device }),
};

/** Open-list source spec (UI-P2.10 item-list model). Tagged for serde. */
export type ExtraSpec =
  | { kind: "media"; path: string; looping?: boolean }
  | { kind: "image"; path: string }
  | { kind: "text"; text: string; size?: number; color?: string }
  | { kind: "color"; color: string }
  | { kind: "window"; window: number }
  | { kind: "guest"; url: string };

export const extraSources = {
  add: (id: string, label: string, spec: ExtraSpec) =>
    invoke("live_add_source", { id, label, spec }),
  remove: (id: string) => invoke("live_remove_source", { id }),
  /** Native file dialog; resolves null if the user cancels. */
  pickFile: (kind: "media" | "image") => invoke<string | null>("live_pick_file", { kind }),
};

export const stinger = {
  /** Open the clip ahead of the cut so playing it is instant. */
  prepare: (path: string) => invoke("live_prepare_stinger", { path }),
  /** Starts the clip over the stage; resolves its duration in ms (0 = the
   * file hasn't reported one, use your configured length). */
  play: (path: string) => invoke<number>("live_play_stinger", { path }),
  stop: () => invoke("live_stop_stinger"),
};

export const recording = {
  /** stamp names the file; resolves the path being written. */
  start: (stamp: string) => invoke<string>("live_start_recording", { stamp }),
  stop: () => invoke<string | null>("live_stop_recording"),
  reveal: (path: string) => invoke("live_reveal_file", { path }),
};

export interface VcamStatus {
  /** The camera's label as other apps see it; per platform (Windows: OBS's filter name). */
  device_name?: string;
  state: "idle" | "requested" | "needs_approval" | "active" | "failed" | "unavailable";
  installed: boolean;
  error: string | null;
}

export const vcam = {
  status: () => invoke<VcamStatus>("live_vcam_status"),
  /** Asks macOS to install the camera extension; the user approves once. */
  activate: () => invoke("live_vcam_activate"),
  /** Starts/stops sending the program feed to the virtual camera. */
  output: (on: boolean) => invoke<boolean>("live_vcam_output", { on }),
};

/** Per-item opacity 0–1, for scene fades. Fire-and-forget at frame rate. */
export const setOpacity = (id: string, opacity: number) =>
  invoke("live_set_opacity", { id, opacity });

/** Join the Brand Network. Idempotent; `rejoin` only from explicit user
 * action — a brand that deliberately left must never be silently re-listed. */
export const networkJoin = (endpointId: string, rejoin = false) =>
  invoke<{ joined: boolean; status: string }>("network_join", { endpointId, rejoin });

export interface GuestInvite {
  guest: { id: string; display_name?: string | null; status: string };
  invite_url: string;
  render_url: string;
}

/** Both URLs come back ONCE ONLY — persist them immediately. Omitting
 * guestBrandId yields an anonymous link that needs no Boomin account. */
export const roomGuestInvite = (
  endpointId: string,
  roomId: string,
  displayName?: string,
  guestBrandId?: string,
) =>
  invoke<GuestInvite>("room_guest_invite", {
    endpointId,
    roomId,
    guestBrandId: guestBrandId ?? null,
    displayName: displayName ?? null,
  });

export interface NetworkConnectionRow {
  connection: { id: string; status: string; connectedAt?: string };
  /** Always the OTHER brand of the pair. */
  counterparty: { id: string; name: string; slug: string; avatarUrl?: string | null };
}
export const networkConnections = (endpointId: string) =>
  invoke<{ connections?: NetworkConnectionRow[] }>("network_connections", { endpointId });

export interface NetworkBrandCard {
  brand: { id: string; name: string; slug: string; avatar_url?: string | null };
  membership: { headline?: string | null; blurb?: string | null; joined_at?: string };
  relationship: {
    self: boolean;
    connected: boolean;
    invitation?: { id: string; direction: "inbox" | "outbox" } | null;
  };
}

export interface NetworkLiveRoom {
  room_id: string;
  title?: string | null;
  visibility: "connections" | "public";
  status: "live" | "idle";
  connected: boolean;
  brand: { id: string; name: string; slug: string; avatar_url?: string | null };
}

/** Register a local room with the platform. Idempotent by external_ref, so
 * it's safe to call unconditionally on first server-side need. */
export const registerRoom = (endpointId: string, title: string, externalRef: string) =>
  invoke<{ room: { id: string }; created: boolean }>("room_register", {
    endpointId,
    title,
    externalRef,
  });

export interface NetworkStatus {
  membership?: { status?: string } | null;
  /** live_now is DERIVED from open broadcasts, not a heartbeat — it can
   * under-report but never invents presence. Label it "live now", not
   * "online", because that's what it actually measures. */
  network?: { live_now?: number; members?: number };
}

export interface NetworkInvitation {
  id: string;
  direction: "inbox" | "outbox";
  status: string;
  message?: string | null;
  created_at?: string;
  /** Always the COUNTERPART brand, whichever side of the pair it is. */
  brand: { id: string; name: string; slug?: string; avatar_url?: string | null };
}

export const network = {
  status: (endpointId: string) => invoke<NetworkStatus>("network_status", { endpointId }),
  invitations: (endpointId: string, direction: "inbox" | "outbox") =>
    invoke<{ invitations?: NetworkInvitation[] }>("network_invitations", { endpointId, direction }),
  /** Slugs are unique platform-wide, so a slug addresses a brand on its own. */
  invite: (endpointId: string, toSlug: string, message?: string) =>
    invoke<{ kind: "invited" | "connected"; invitation?: NetworkInvitation }>("network_invite", {
      endpointId,
      toSlug,
      message: message ?? null,
    }),
  act: (endpointId: string, id: string, action: "accept" | "decline" | "revoke") =>
    invoke("network_invitation_action", { endpointId, id, action }),
  /** Exact-handle lookup — the ONLY discovery surface Producer gets. */
  lookup: (endpointId: string, slug: string) =>
    invoke<NetworkBrandCard>("network_lookup", { endpointId, slug }),
  liveRooms: (endpointId: string) =>
    invoke<{ rooms?: NetworkLiveRoom[] }>("network_live_rooms", { endpointId }),
  /** Knock on a visible open stage; the join_url opens the guest page. */
  enterRoom: (endpointId: string, roomId: string) =>
    invoke<{ join_url: string; resumed: boolean }>("network_enter_room", { endpointId, roomId }),
  /** Every deal this brand is party to. */
  deals: (endpointId: string) => invoke<{ deals?: NetworkDeal[] }>("network_deals", { endpointId }),
  /** Book an appearance: we (the host) pay them to appear on OUR server room.
   * Presence is delivery — admitting them from the Guests panel settles it. */
  proposeDeal: (
    endpointId: string,
    input: {
      connectionId: string;
      beneficiaryBrandId: string;
      roomId: string;
      title: string;
      amountCents: number;
      /** Stage minimum in minutes; null = presence alone delivers. */
      minStageMinutes: number | null;
    },
  ) => invoke<{ deal: NetworkDeal }>("network_propose_deal", { endpointId, ...input }),
  /** accept | decline (beneficiary) · cancel (either side, before funding). */
  dealAction: (endpointId: string, id: string, action: "accept" | "decline" | "cancel") =>
    invoke<{ deal: NetworkDeal }>("network_deal_action", { endpointId, id, action }),
};

export interface NetworkDeal {
  id: string;
  connection_id: string;
  role: "client" | "beneficiary";
  title: string;
  status: "proposed" | "accepted" | "funded" | "delivered" | "released" | "declined" | "cancelled" | "disputed" | "expired";
  amount_cents: number;
  net_to_beneficiary_cents: number;
  room_id?: string | null;
  room_title?: string | null;
  appearance?: { guest_id: string; admitted_at: string } | null;
  delivered_by?: "presence" | "stage_minimum" | "host_ended" | "beneficiary" | null;
  min_stage_minutes?: number | null;
  stage_seconds?: number | null;
  deliverable?: string | null;
  platform_fee_bps?: number;
  platform_fee_cents?: number;
  fee_locked?: boolean;
  review_days?: number;
  propose_expires_at?: string | null;
  funded_at?: string | null;
  delivered_at?: string | null;
  created_at: string;
}

/** Mount timings → <app data>/live/room-open-report.json, the ruler every
 * room-open speedup is measured against. */
export const roomOpenReport = (report: Record<string, unknown>) =>
  invoke("live_room_open_report", { report });

/** Network exposure of a registered room (server id, not the local one). */
export const roomSetVisibility = (
  endpointId: string,
  roomId: string,
  visibility: "private" | "connections" | "public",
) => invoke("room_set_visibility", { endpointId, roomId, visibility });

export interface RoomGuest {
  id: string;
  display_name?: string | null;
  /** `render_url` is null while waiting — the waiting room is enforced
   * server-side, not by us declining to render someone. */
  state: "waiting" | "invited" | "connected" | "admitted" | "left" | string;
  render_url?: string | null;
  joined_via?: string | null;
  /** Connection health, measured on the RENDER page — what actually reaches
   * the show, not the guest's view of their own uplink. A stale reading
   * reports `unknown` rather than the last value: a confident "good" from
   * four minutes ago is what puts someone on air seconds before they fall
   * over. Tolerant of either field name until the contract settles. */
  quality?: "good" | "degraded" | "failing" | "unknown" | string | null;
  connection_quality?: "good" | "degraded" | "failing" | "unknown" | string | null;
  avatar_url?: string | null;
  joined_at?: string | null;
  last_seen_at?: string | null;
}

/** Guests arrive through the room link on their own, so the roster — not our
 * own bookkeeping — is the source of truth for who is present. */
export const guests = {
  roster: (endpointId: string, roomId: string) =>
    invoke<{ guests?: RoomGuest[] }>("room_guests", { endpointId, roomId }),
  joinLink: (endpointId: string, roomId: string) =>
    invoke<{ join_url?: string; url?: string }>("room_join_link", { endpointId, roomId }),
  /** A guest who joined by link waits until the host admits them — the link
   * is public, so nobody reaches the broadcast unreviewed. */
  admit: (endpointId: string, roomId: string, guestId: string) =>
    invoke("room_guest_admit", { endpointId, roomId, guestId }),
  /** The full on-stage guest list. Sent on every change — a reconnecting
   * guest reads this back to learn who is on air. */
  setStage: (endpointId: string, roomId: string, onStage: string[]) =>
    invoke("room_set_stage", { endpointId, roomId, onStage }),
  revoke: (endpointId: string, guestId: string) =>
    invoke("room_guest_revoke", { endpointId, guestId }),
};

/** Volume/mute for any audio-bearing source, guests included. */
export const setSourceAudio = (id: string, volume?: number, muted?: boolean) =>
  invoke("live_set_source_audio", { id, volume: volume ?? null, muted: muted ?? null });

/** A/V sync offset in ms, positive delays the audio. Same per-source control
 * OBS exposes — capture cards and remote guests each have a steady lag. */
export const setSyncOffset = (id: string, ms: number) =>
  invoke("live_set_sync_offset", { id, ms });
