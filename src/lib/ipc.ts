import { invoke } from "@tauri-apps/api/core";

export interface EndpointInfo {
  id: string;
  kind: "connected" | "independent";
  name: string;
  base_url: string;
  created_at: string;
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
  boominSelectBrand: (brandSlug: string) => invoke("boomin_select_brand", { brandSlug }),
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
  liveListDestinations: () => invoke<LiveDestination[]>("live_list_destinations"),
  liveUpsertDestination: (input: {
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
    invoke("live_attach_preview", { x, y, w, h }),
  liveMovePreview: (x: number, y: number, w: number, h: number) =>
    invoke("live_move_preview", { x, y, w, h }),
  liveDetachPreview: () => invoke("live_detach_preview"),
  livePermissions: () => invoke<LivePermissions>("live_permissions"),
  liveRequestPermission: (kind: "screen" | "camera" | "mic") =>
    invoke("live_request_permission", { kind }),
  liveScreenCoach: (action: "chip_show" | "chip_hide" | "open_settings") =>
    invoke("live_screen_coach", { action }),
  firstlightResume: (action: "set" | "take" | "clear") =>
    invoke<boolean>("firstlight_resume", { action }),
  liveListWindows: () => invoke<LiveWindow[]>("live_list_windows"),
  liveSetOverlay: (windowId: number | null, colorKey: boolean, url?: string | null) =>
    invoke("live_set_overlay", { windowId, colorKey, url: url ?? null }),
};

export interface LiveWindow {
  id: number;
  owner: string;
  title: string;
}

export interface LivePermissions {
  screen: string;
  camera: string;
  mic: string;
}

export interface LiveSources {
  screen: boolean;
  camera: boolean;
  mic: boolean;
  overlay_window?: number | null;
  overlay_url?: string | null;
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
  session_state: LiveSessionState;
  elapsed_secs: number;
  destinations: LiveDestStatus[];
  sources?: LiveSources;
  preview_attached?: boolean;
  disabled?: boolean;
}

export type LiveEvent =
  | { type: "engine_ready"; ok: boolean; graphics_backend?: string | null; obs_version: string }
  | { type: "session_state"; state: LiveSessionState }
  | { type: "status"; elapsed_secs: number; destinations: LiveDestStatus[] }
  | { type: "session_ended"; report: { ok: boolean; destinations: LiveDestStatus[]; notes: string[] } }
  | { type: "sources_changed"; sources: LiveSources }
  | { type: "engine_error"; message: string };

export async function listenLiveEvents(cb: (ev: LiveEvent) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LiveEvent>("live://event", (e) => cb(e.payload));
}
