export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;

  /** Full-rights endpoint token — pasted into the Producer desktop app. */
  PRIMARY_TOKEN?: string;
  /** Optional publish/read/media-upload token for agents, CLI, MCP, CI.
   *  Can never touch channels, credentials, or configuration. */
  AUTOMATION_TOKEN?: string;
  /** Encrypts platform OAuth tokens at rest in D1 (AES-GCM). */
  TOKEN_ENCRYPTION_KEY?: string;

  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;

  // ── Live guests (host↔guest over WebRTC, this worker only introduces) ──────
  /** Signaling Durable Object namespace (class RealtimeHub, SQLite-backed —
   *  the flavour available on the Workers Free plan). Optional so a deploy
   *  without the binding still publishes; guest routes 503 `realtime_unavailable`. */
  REALTIME?: DurableObjectNamespace;
  /** Static guest pages (server/public). */
  ASSETS?: Fetcher;
  /** Signs the 120-second signaling tickets and derives per-guest render
   *  keys. 32+ random chars; rotating it invalidates every render URL. */
  SIGNALING_SECRET?: string;
  /** Optional JSON array of RTCIceServer objects. Default = public STUN only;
   *  add TURN here when direct traversal fails for your guests. */
  ICE_SERVERS?: string;
}

export const CONTRACT_VERSION = "0.1.0";
