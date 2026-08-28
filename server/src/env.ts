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
}

export const CONTRACT_VERSION = "0.1.0";
