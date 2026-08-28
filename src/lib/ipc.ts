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
};
