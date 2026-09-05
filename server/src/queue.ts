// The queue — why "laptop closed" is true on a $0 stack.
//
// D1 is the canonical scheduler: every job is a row with a due time, an
// attempt count, a lease, and a checkpoint. The worker's every-minute
// cron claims due rows and advances them through their sender. Two
// invariants, deliberately separate (PHASE1.md v4.1.1):
//
//   IDEMPOTENCY  — platform ids persist in the checkpoint BEFORE the call
//                  that consumes them; a crashed tick resumes, never
//                  re-creates.
//   MUTUAL EXCL. — a conditional-UPDATE lease claim means two overlapping
//                  ticks can never advance the same job.

import type { Env } from "./env";
import { expireStale } from "./contributions";
import { decryptSecret } from "./crypto";
import { senderFor } from "./senders";
import { SendError, type Checkpoint, type ChannelRow, type JobInput } from "./senders/types";

const MAX_ATTEMPTS = 30;
const LEASE_SECONDS = 120;
const CLAIM_BATCH = 5;

export interface JobRow {
  id: string;
  channel_id: string;
  caption: string | null;
  media_id: string | null;
  media_url: string | null;
  overrides: string;
  state: string;
  due_at: number;
  attempt: number;
  next_attempt_at: number | null;
  checkpoint: string;
  intent_id: string | null;
  client_request_id: string | null;
  created_at: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export function backoffSeconds(attempt: number): number {
  return Math.min(600, Math.max(1, attempt) * 30);
}

/** One cron tick: claim due jobs under a lease and advance each. */
export async function tick(env: Env): Promise<void> {
  const now = nowSec();
  const workerId = `tick-${crypto.randomUUID()}`;

  // The reviewer's claim shape: state eligible, due, lease absent-or-expired.
  const claimed = await env.DB.prepare(
    `UPDATE jobs SET
       state = 'publishing',
       attempt = attempt + 1,
       lease_owner = ?1,
       lease_expires_at = ?2
     WHERE id IN (
       SELECT id FROM jobs
       WHERE state IN ('scheduled', 'queued')
         AND COALESCE(next_attempt_at, due_at) <= ?3
       ORDER BY due_at
       LIMIT ${CLAIM_BATCH}
     )
       AND (lease_expires_at IS NULL OR lease_expires_at < ?3)
     RETURNING *`,
  )
    .bind(workerId, now + LEASE_SECONDS, now)
    .all<JobRow>();

  for (const job of claimed.results ?? []) {
    try {
      await advance(env, job);
    } catch (err) {
      console.error("queue: unhandled advance error", job.id, err);
      await recordFailure(env, job, "retryable", err instanceof Error ? err.message : String(err));
    }
  }

  await refreshExpiringTokens(env);
  await expireOrphanMedia(env);
  // The ledger's heartbeat rule: a crashed host's open intervals close at
  // the last moment it was known alive (+ the presence window).
  try {
    await expireStale(env);
  } catch (err) {
    console.error("[tick] contribution expiry failed", err);
  }
}

async function advance(env: Env, job: JobRow): Promise<void> {
  const channel = await env.DB.prepare("SELECT * FROM channels WHERE id = ?1")
    .bind(job.channel_id)
    .first<ChannelRow & { access_token_enc: string }>();
  if (!channel) {
    await recordFailure(env, job, "permanent", "The channel for this job no longer exists.");
    return;
  }

  const sender = senderFor(channel.platform);
  if (!sender) {
    await recordFailure(env, job, "permanent", `No sender for platform ${channel.platform}.`);
    return;
  }

  if (!env.TOKEN_ENCRYPTION_KEY) {
    await recordFailure(env, job, "retryable", "TOKEN_ENCRYPTION_KEY is not configured.");
    return;
  }
  const accessToken = await decryptSecret(channel.access_token_enc, env.TOKEN_ENCRYPTION_KEY);

  const input = await buildInput(env, job);
  const checkpoint = JSON.parse(job.checkpoint || "{}") as Checkpoint;

  try {
    const result = await sender.publish(input, checkpoint, accessToken, channel);
    if (result.done) {
      await env.DB.prepare(
        `UPDATE jobs SET state = 'published', checkpoint = ?2, published_external_id = ?3,
           published_external_url = ?4, published_at = ?5, error_class = NULL,
           error_message = NULL, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?1`,
      )
        .bind(job.id, JSON.stringify(result.checkpoint), result.externalId, result.externalUrl ?? null, nowSec())
        .run();
      if (job.media_id) {
        await env.DB.prepare("UPDATE media SET status = 'attached' WHERE id = ?1").bind(job.media_id).run();
      }
    } else {
      await env.DB.prepare(
        `UPDATE jobs SET state = 'queued', checkpoint = ?2, next_attempt_at = ?3,
           lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?1`,
      )
        .bind(job.id, JSON.stringify(result.checkpoint), nowSec() + result.retryInSeconds)
        .run();
    }
  } catch (err) {
    if (err instanceof SendError) {
      if (err.errorClass === "token_expired") {
        await env.DB.prepare("UPDATE channels SET status = 'needs_reconnect' WHERE id = ?1")
          .bind(channel.id)
          .run();
        await recordFailure(env, job, "token_expired", err.message, err.retryAt);
      } else {
        await recordFailure(env, job, err.errorClass, err.message, err.retryAt);
      }
    } else {
      throw err;
    }
  }
}

async function buildInput(env: Env, job: JobRow): Promise<JobInput> {
  let mediaUrl = job.media_url;
  let mediaKind: "image" | "video" | null = mediaUrl
    ? /\.(mp4|mov|webm)([?#].*)?$/i.test(mediaUrl)
      ? "video"
      : "image"
    : null;

  if (job.media_id) {
    const media = await env.DB.prepare("SELECT * FROM media WHERE id = ?1")
      .bind(job.media_id)
      .first<{ capability_id: string; content_type: string }>();
    if (media) {
      const origin = await publicOrigin(env);
      mediaUrl = `${origin}/media/${media.capability_id}`;
      mediaKind = media.content_type.startsWith("video/") ? "video" : "image";
    }
  }

  const overrides = JSON.parse(job.overrides || "{}") as Record<string, unknown>;
  return {
    // A per-channel caption override beats the global text — same
    // preference order as the hosted engine.
    caption: captionFromOverrides(overrides) ?? job.caption,
    mediaUrl,
    mediaKind,
    overrides,
  };
}

export function captionFromOverrides(overrides: Record<string, unknown>): string | null {
  const caption = overrides.caption;
  return typeof caption === "string" && caption.trim() ? caption.trim() : null;
}

async function recordFailure(
  env: Env,
  job: JobRow,
  errorClass: string,
  message: string,
  retryAt?: number,
): Promise<void> {
  const terminal = errorClass === "permanent" || job.attempt >= MAX_ATTEMPTS;
  if (terminal) {
    await env.DB.prepare(
      `UPDATE jobs SET state = 'failed', error_class = ?2, error_message = ?3,
         lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ?1`,
    )
      .bind(job.id, errorClass === "permanent" ? "permanent" : errorClass, message)
      .run();
    return;
  }
  const next = retryAt ?? nowSec() + backoffSeconds(job.attempt);
  await env.DB.prepare(
    `UPDATE jobs SET state = 'queued', error_class = ?2, error_message = ?3,
       next_attempt_at = ?4, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ?1`,
  )
    .bind(job.id, errorClass, message, next)
    .run();
}

/** The worker learns its own public URL from the first authed request
 *  (saved in settings) so cron ticks can mint capability URLs. */
export async function publicOrigin(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'public_origin'").first<{ value: string }>();
  if (!row) {
    throw new SendError(
      "retryable",
      "The server has not learned its public URL yet — open the Producer app (or call any /v1 route) once.",
    );
  }
  return row.value;
}

export async function rememberOrigin(env: Env, origin: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('public_origin', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
  )
    .bind(origin)
    .run();
}

// ── Housekeeping on the same tick ────────────────────────────────────────────

/** IG/Threads long-lived tokens last ~60 days; refresh inside the final week. */
async function refreshExpiringTokens(env: Env): Promise<void> {
  if (!env.TOKEN_ENCRYPTION_KEY) return;
  const soon = nowSec() + 7 * 86400;
  const rows = await env.DB.prepare(
    `SELECT id, platform, access_token_enc FROM channels
     WHERE status = 'active' AND token_expires_at IS NOT NULL AND token_expires_at <= ?1
     LIMIT 3`,
  )
    .bind(soon)
    .all<{ id: string; platform: string; access_token_enc: string }>();

  for (const row of rows.results ?? []) {
    try {
      const token = await decryptSecret(row.access_token_enc, env.TOKEN_ENCRYPTION_KEY);
      const refreshUrl =
        row.platform === "instagram"
          ? `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`
          : row.platform === "threads"
            ? `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`
            : null;
      if (!refreshUrl) continue;
      const resp = await fetch(refreshUrl);
      const body = (await resp.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
      if (resp.ok && body.access_token) {
        const { encryptSecret } = await import("./crypto");
        await env.DB.prepare(
          "UPDATE channels SET access_token_enc = ?2, token_expires_at = ?3 WHERE id = ?1",
        )
          .bind(
            row.id,
            await encryptSecret(body.access_token, env.TOKEN_ENCRYPTION_KEY),
            nowSec() + (body.expires_in ?? 60 * 86400),
          )
          .run();
      }
    } catch (err) {
      console.error("token refresh failed", row.id, err);
    }
  }
}

/** The orphan TTL from the frozen media rule: uploads never attached to a
 *  post are garbage-collected (1h). */
async function expireOrphanMedia(env: Env): Promise<void> {
  const cutoff = nowSec() - 3600;
  const rows = await env.DB.prepare(
    `SELECT id, r2_key FROM media
     WHERE status IN ('pending', 'stored') AND created_at <= ?1
       AND id NOT IN (SELECT media_id FROM jobs WHERE media_id IS NOT NULL)
     LIMIT 10`,
  )
    .bind(cutoff)
    .all<{ id: string; r2_key: string }>();
  for (const row of rows.results ?? []) {
    await env.MEDIA.delete(row.r2_key).catch(() => {});
    await env.DB.prepare("UPDATE media SET status = 'orphan_expired' WHERE id = ?1").bind(row.id).run();
  }
}
