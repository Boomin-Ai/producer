// producer-server — the sovereignty backend for Producer.
//
// One deployment = one workspace. The desktop app (or a CLI, or an
// agent) speaks the Producer contract to this worker exactly as it does
// to Boomin's hosted backend; the difference is WHO runs it. Here: you.
// D1 is the queue, private R2 is the media store (exposed only through
// opaque bearer-capability URLs), the every-minute cron is the scheduler,
// and your own Meta apps do the publishing.

import { Hono } from "hono";
import type { Context } from "hono";
import { CONTRACT_VERSION, type Env } from "./env";
import { ApiError, errorBody, preflight } from "./errors";
import { classifyToken, requirePrimary, type TokenClass } from "./auth";
import { encryptSecret, randomCapability, randomId, sha256Hex } from "./crypto";
import { authorizeUrl, exchangeCode } from "./oauth";
import { senderFor, SENDERS } from "./senders";
import type { JobInput } from "./senders/types";
import { captionFromOverrides, rememberOrigin, tick, type JobRow } from "./queue";
import { connectGuestRoutes, guestPageRoutes, liveHostRoutes } from "./live";
import { contributionConnectStubs, contributionHostStubs } from "./stubs";

type Vars = { tokenClass: TokenClass };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString() : undefined);

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(errorBody(err), err.status as never);
  console.error("unhandled error", err);
  return c.json({ error: { code: "internal_error", message: err.message } }, 500);
});
app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found." } }, 404));

function serverInfo() {
  return { ok: true, implementation: "producer-server", contract_version: CONTRACT_VERSION };
}

// ── Health (no auth) ─────────────────────────────────────────────────────────

app.get("/v1/health", (c) => c.json(serverInfo()));

// ── Bearer auth for everything else under /v1 ────────────────────────────────

app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") return next();
  // The one-time PUT of upload bytes authenticates by its signed URL token,
  // exactly like a presigned URL — an uploader tool needs no bearer header.
  if (c.req.method === "PUT" && /^\/v1\/media\/uploads\/[^/]+\/content$/.test(c.req.path)) return next();
  // Guest pages and the signaling upgrades carry no bearer: the invite code,
  // room code, render key or 120-second ticket in the request IS the credential.
  if (c.req.path.startsWith("/v1/connect/guest")) return next();
  // The audience door (docs/CONTRIBUTIONS.md): a room code mints a per-device
  // capability token; the token, not a bearer, is the credential afterwards.
  if (c.req.path.startsWith("/v1/connect/audience")) return next();
  const tokenClass = classifyToken(c.env, c);
  c.set("tokenClass", tokenClass);
  // Self-configure the public origin so cron ticks can mint media URLs.
  await rememberOrigin(c.env, new URL(c.req.url).origin);
  return next();
});

// ── Session ──────────────────────────────────────────────────────────────────

app.get("/v1/session", (c) =>
  c.json({
    token_class: c.get("tokenClass"),
    account: { display_name: "producer-server" },
    server: serverInfo(),
  }),
);

// ── Channels ─────────────────────────────────────────────────────────────────

app.get("/v1/channels", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, platform, display_name, handle, status FROM channels ORDER BY created_at",
  ).all<{ id: string; platform: string; display_name: string; handle: string | null; status: string }>();
  return c.json({
    channels: (rows.results ?? []).map((r) => ({
      id: r.id,
      platform: r.platform,
      display_name: r.display_name,
      external_handle: r.handle ?? undefined,
      status: r.status,
      capabilities: senderFor(r.platform)?.capabilities() ?? {},
    })),
  });
});

app.post("/v1/channels/:platform/connect-session", async (c) => {
  requirePrimary(c.get("tokenClass"));
  const platform = c.req.param("platform");
  if (!SENDERS[platform]) throw new ApiError(404, "not_found", `Unknown platform: ${platform}`);
  // Fail fast if the BYO app isn't configured — the error names the var.
  authorizeUrl(platform, c.env, "https://example.invalid/probe", "probe");

  const nonce = randomCapability();
  const state = randomCapability();
  const expires = nowSec() + 600;
  await c.env.DB.prepare(
    "INSERT INTO connect_sessions (nonce, platform, state, status, created_at, expires_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?5)",
  )
    .bind(nonce, platform, state, nowSec(), expires)
    .run();

  const origin = new URL(c.req.url).origin;
  return c.json({ browser_url: `${origin}/connect/${platform}?session=${nonce}`, expires_at: iso(expires) }, 201);
});

app.delete("/v1/channels/:channelId", async (c) => {
  requirePrimary(c.get("tokenClass"));
  const result = await c.env.DB.prepare("DELETE FROM channels WHERE id = ?1")
    .bind(c.req.param("channelId"))
    .run();
  if (!result.meta.changes) throw new ApiError(404, "not_found", "No such channel.");
  return c.body(null, 204);
});

// ── Media (upload slots + capability gateway) ────────────────────────────────

app.post("/v1/media/uploads", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { filename?: string; content_type?: string; size_bytes?: number }
    | null;
  if (!body?.filename || !body.content_type || !body.size_bytes || body.size_bytes < 1) {
    throw new ApiError(400, "invalid_request", "filename, content_type, and size_bytes are required.");
  }
  if (body.size_bytes > 1024 * 1024 * 1024) {
    throw new ApiError(413, "file_too_large", "Uploads are limited to 1 GB.");
  }

  const id = crypto.randomUUID();
  const capability = randomCapability();
  const putToken = randomId(24);
  const ext = body.filename.split(".").pop()?.toLowerCase() ?? "bin";
  const key = `media/${id}.${ext}`;
  const expires = nowSec() + 900;

  await c.env.DB.prepare(
    `INSERT INTO media (id, r2_key, filename, content_type, size_bytes, status, capability_id, put_token, put_expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9)`,
  )
    .bind(id, key, body.filename, body.content_type, body.size_bytes, capability, putToken, expires, nowSec())
    .run();

  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      upload_id: id,
      put_url: `${origin}/v1/media/uploads/${id}/content?token=${putToken}`,
      expires_at: iso(expires),
    },
    201,
  );
});

// The "presigned PUT": authorized by the one-time token in the URL and
// streamed straight into private R2. No credentials ever reach a client.
app.put("/v1/media/uploads/:id/content", async (c) => {
  const media = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?1")
    .bind(c.req.param("id"))
    .first<{ id: string; r2_key: string; content_type: string; put_token: string | null; put_expires_at: number | null; status: string }>();
  const token = c.req.query("token") ?? "";
  if (!media || media.status !== "pending" || !media.put_token || media.put_token !== token) {
    throw new ApiError(403, "invalid_upload_token", "The upload link is invalid or was already used.");
  }
  if ((media.put_expires_at ?? 0) < nowSec()) {
    throw new ApiError(403, "invalid_upload_token", "The upload link expired — request a new slot.");
  }
  const object = await c.env.MEDIA.put(media.r2_key, c.req.raw.body, {
    httpMetadata: { contentType: media.content_type, cacheControl: "public, max-age=31536000, immutable" },
  });
  await c.env.DB.prepare(
    "UPDATE media SET status = 'stored', size_bytes = ?2, put_token = NULL WHERE id = ?1",
  )
    .bind(media.id, object?.size ?? 0)
    .run();
  return c.json({ ok: true });
});

app.get("/v1/media/:id", async (c) => {
  const media = await c.env.DB.prepare(
    "SELECT id, status, content_type, size_bytes FROM media WHERE id = ?1",
  )
    .bind(c.req.param("id"))
    .first<{ id: string; status: string; content_type: string; size_bytes: number }>();
  if (!media) throw new ApiError(404, "not_found", "No such upload.");
  return c.json({
    upload_id: media.id,
    status: media.status,
    content_type: media.content_type,
    size_bytes: media.size_bytes,
  });
});

// ── Posts (effectively-once acceptance) ──────────────────────────────────────

interface CreatePostBody {
  channel_id?: string;
  text?: string;
  media?: ({ upload_id: string } | { url: string })[];
  overrides?: Record<string, unknown>;
  schedule_at?: string;
  intent_id?: string;
}

app.post("/v1/posts", async (c) => {
  const idempotencyKey = c.req.header("Idempotency-Key")?.trim() ?? "";
  if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "An Idempotency-Key header (16-128 chars) is required.");
  }

  const raw = await c.req.text();
  const requestHash = await sha256Hex(raw);

  const existing = await c.env.DB.prepare(
    "SELECT request_hash, result_json FROM submissions WHERE operation = 'create_post' AND idempotency_key = ?1",
  )
    .bind(idempotencyKey)
    .first<{ request_hash: string; result_json: string }>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ApiError(409, "idempotency_conflict", "This idempotency key was already used with a different payload.");
    }
    return c.json({ job: JSON.parse(existing.result_json), replayed: true }, 200);
  }

  let body: CreatePostBody;
  try {
    body = JSON.parse(raw) as CreatePostBody;
  } catch {
    throw new ApiError(400, "invalid_request", "The request body must be JSON.");
  }
  if (!body.channel_id) throw new ApiError(400, "invalid_request", "channel_id is required.");

  const channel = await c.env.DB.prepare("SELECT * FROM channels WHERE id = ?1")
    .bind(body.channel_id)
    .first<{ id: string; platform: string; status: string }>();
  if (!channel) throw new ApiError(404, "not_found", "No such channel.");
  if (channel.status !== "active") {
    throw preflight("This channel needs to be reconnected before publishing.", [
      { code: "channel_needs_reconnect", message: "Reconnect the channel, then retry." },
    ]);
  }
  const sender = senderFor(channel.platform);
  if (!sender) throw new ApiError(422, "preflight_failed", `No sender for ${channel.platform}.`);

  // Resolve media: durable upload reference or stable public URL.
  const mediaRef = body.media?.[0];
  let mediaId: string | null = null;
  let mediaUrl: string | null = null;
  let mediaKind: "image" | "video" | null = null;
  if (mediaRef && "upload_id" in mediaRef) {
    const media = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?1")
      .bind(mediaRef.upload_id)
      .first<{ id: string; r2_key: string; status: string; content_type: string }>();
    if (!media) throw new ApiError(404, "not_found", "No such upload.");
    if (media.status === "pending") {
      const head = await c.env.MEDIA.head(media.r2_key);
      if (!head) {
        throw preflight("The referenced upload has no stored bytes yet.", [
          { code: "media_not_uploaded", message: "PUT the file to its upload URL, then retry.", field: "media" },
        ]);
      }
      await c.env.DB.prepare("UPDATE media SET status = 'stored', size_bytes = ?2 WHERE id = ?1")
        .bind(media.id, head.size)
        .run();
    }
    mediaId = media.id;
    mediaKind = media.content_type.startsWith("video/") ? "video" : "image";
    mediaUrl = "capability://pending"; // real URL minted at publish time
  } else if (mediaRef && "url" in mediaRef) {
    if (!/^https:\/\//i.test(mediaRef.url)) {
      throw preflight("Media URLs must be public HTTPS URLs.", [
        { code: "media_url_not_https", message: "Use a public https:// URL.", field: "media" },
      ]);
    }
    mediaUrl = mediaRef.url;
    mediaKind = /\.(mp4|mov|webm)([?#].*)?$/i.test(mediaRef.url) ? "video" : "image";
  }

  const input: JobInput = {
    // Preflight against what will actually publish: a per-channel caption
    // override wins over the global text.
    caption: captionFromOverrides(body.overrides ?? {}) ?? body.text ?? null,
    mediaUrl,
    mediaKind,
    overrides: body.overrides ?? {},
  };
  const issues = sender.preflight(input);
  if (issues.length) throw preflight(issues[0].message, issues);

  const dueAt = body.schedule_at ? Math.floor(new Date(body.schedule_at).getTime() / 1000) : nowSec();
  if (Number.isNaN(dueAt)) throw new ApiError(400, "invalid_request", "schedule_at must be an RFC3339 datetime.");

  const jobId = crypto.randomUUID();
  const state = dueAt > nowSec() ? "scheduled" : "queued";
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, channel_id, caption, media_id, media_url, overrides, state, due_at,
                       intent_id, client_request_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      jobId,
      channel.id,
      body.text ?? null,
      mediaId,
      mediaId ? null : mediaUrl,
      JSON.stringify(body.overrides ?? {}),
      state,
      dueAt,
      body.intent_id ?? null,
      idempotencyKey,
      nowSec(),
    )
    .run();
  if (mediaId) {
    await c.env.DB.prepare("UPDATE media SET status = 'attached' WHERE id = ?1").bind(mediaId).run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(jobId).first<JobRow & Record<string, unknown>>();
  const job = contractJob(row!);

  // Permanent acceptance record — replay returns this snapshot verbatim.
  await c.env.DB.prepare(
    `INSERT INTO submissions (operation, idempotency_key, request_hash, job_id, result_json, created_at)
     VALUES ('create_post', ?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (operation, idempotency_key) DO NOTHING`,
  )
    .bind(idempotencyKey, requestHash, jobId, JSON.stringify(job), nowSec())
    .run();

  return c.json({ job, replayed: false }, 201);
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

function contractJob(row: JobRow & Record<string, unknown>) {
  return {
    id: row.id,
    channel_id: row.channel_id,
    intent_id: row.intent_id ?? undefined,
    client_request_id: row.client_request_id ?? undefined,
    state: row.state,
    attempt: row.attempt,
    due_at: iso(row.due_at)!,
    next_attempt_at: iso(row.next_attempt_at),
    error_class: (row.error_class as string | null) ?? undefined,
    error_message: (row.error_message as string | null) ?? undefined,
    published_external_id: (row.published_external_id as string | null) ?? undefined,
    published_external_url: (row.published_external_url as string | null) ?? undefined,
    created_at: iso(row.created_at)!,
    published_at: iso(row.published_at as number | null),
  };
}

async function loadJob(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<JobRow & Record<string, unknown>> {
  const row = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?1")
    .bind(c.req.param("jobId"))
    .first<JobRow & Record<string, unknown>>();
  if (!row) throw new ApiError(404, "not_found", "No such job.");
  return row;
}

app.get("/v1/jobs", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const cursor = c.req.query("cursor");
  const cursorSec = cursor ? Math.floor(new Date(cursor).getTime() / 1000) : null;
  const states = c.req.query("state")?.split(",").map((s) => s.trim()).filter(Boolean);
  const channelId = c.req.query("channel_id");
  const intentId = c.req.query("intent_id");

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (channelId) {
    conditions.push(`channel_id = ?${binds.length + 1}`);
    binds.push(channelId);
  }
  if (intentId) {
    conditions.push(`intent_id = ?${binds.length + 1}`);
    binds.push(intentId);
  }
  if (cursorSec && !Number.isNaN(cursorSec)) {
    conditions.push(`created_at < ?${binds.length + 1}`);
    binds.push(cursorSec);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await c.env.DB.prepare(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ${limit + 1}`,
  )
    .bind(...binds)
    .all<JobRow & Record<string, unknown>>();

  let jobs = (rows.results ?? []).slice(0, limit).map(contractJob);
  const hasMore = (rows.results ?? []).length > limit;
  if (states?.length) jobs = jobs.filter((j) => states.includes(j.state));
  return c.json({
    jobs,
    ...(hasMore && jobs.length ? { next_cursor: jobs[jobs.length - 1].created_at } : {}),
  });
});

app.get("/v1/jobs/:jobId", async (c) => c.json(contractJob(await loadJob(c))));

app.patch("/v1/jobs/:jobId", async (c) => {
  const row = await loadJob(c);
  if (row.state !== "scheduled") {
    throw new ApiError(409, "job_not_reschedulable", `A ${row.state} job cannot be rescheduled.`);
  }
  const body = (await c.req.json().catch(() => null)) as { schedule_at?: string } | null;
  const when = body?.schedule_at ? Math.floor(new Date(body.schedule_at).getTime() / 1000) : NaN;
  if (Number.isNaN(when)) throw new ApiError(400, "invalid_request", "schedule_at must be an RFC3339 datetime.");
  await c.env.DB.prepare("UPDATE jobs SET due_at = ?2, next_attempt_at = NULL WHERE id = ?1")
    .bind(row.id, when)
    .run();
  return c.json(contractJob({ ...row, due_at: when, next_attempt_at: null }));
});

app.post("/v1/jobs/:jobId/cancel", async (c) => {
  const row = await loadJob(c);
  if (row.state !== "scheduled" && row.state !== "queued") {
    throw new ApiError(409, "job_not_cancelable", `A ${row.state} job cannot be canceled.`);
  }
  await c.env.DB.prepare("UPDATE jobs SET state = 'canceled', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?1")
    .bind(row.id)
    .run();
  return c.json(contractJob({ ...row, state: "canceled" }));
});

app.post("/v1/jobs/:jobId/retry", async (c) => {
  const row = await loadJob(c);
  if (row.state !== "failed") {
    throw new ApiError(409, "job_not_retryable", `A ${row.state} job cannot be retried — only failed jobs can.`);
  }
  await c.env.DB.prepare(
    `UPDATE jobs SET state = 'queued', next_attempt_at = ?2, error_class = NULL, error_message = NULL,
       attempt = 0, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ?1`,
  )
    .bind(row.id, nowSec())
    .run();
  return c.json(contractJob({ ...row, state: "queued", attempt: 0, error_class: null, error_message: null }));
});

// ── Live rooms + guests (see live.ts) ────────────────────────────────────────
// Host family (primary token only) at the same paths Boomin serves, so the
// Producer desktop app speaks to either backend unchanged.

app.route("/v1/app/live", liveHostRoutes);
app.route("/v1/connect", connectGuestRoutes);

// ── Contract-first stubs (docs/CONTRIBUTIONS.md) ─────────────────────────────
// Documented in the contract, not built: 501 + the issue that builds each one.
// Same mounts, same gates as the families above (see stubs.ts).

app.route("/v1/app/live", contributionHostStubs);
app.route("/v1/connect", contributionConnectStubs);
app.route("/connect", guestPageRoutes);

// ── Public: OAuth connect flow (human browser consent) ───────────────────────

app.get("/connect/:platform", async (c) => {
  const nonce = c.req.query("session") ?? "";
  const platform = c.req.param("platform");
  const session = await c.env.DB.prepare(
    "SELECT * FROM connect_sessions WHERE nonce = ?1 AND platform = ?2 AND status = 'pending'",
  )
    .bind(nonce, platform)
    .first<{ state: string; expires_at: number }>();
  if (!session || session.expires_at < nowSec()) {
    return c.html("<h3>This connect link is invalid or expired.</h3><p>Start the connection again from Producer.</p>", 403);
  }
  const origin = new URL(c.req.url).origin;
  return c.redirect(authorizeUrl(platform, c.env, `${origin}/oauth/callback/${platform}`, session.state), 302);
});

app.get("/oauth/callback/:platform", async (c) => {
  const platform = c.req.param("platform");
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";

  // Single-use: the conditional UPDATE is the authentication.
  const claimed = await c.env.DB.prepare(
    "UPDATE connect_sessions SET status = 'used' WHERE state = ?1 AND platform = ?2 AND status = 'pending' AND expires_at >= ?3",
  )
    .bind(state, platform, nowSec())
    .run();
  if (!claimed.meta.changes || !code) {
    return c.html("<h3>This connect attempt is invalid or expired.</h3><p>Start again from Producer.</p>", 403);
  }
  if (!c.env.TOKEN_ENCRYPTION_KEY) {
    return c.html("<h3>TOKEN_ENCRYPTION_KEY is not configured on this server.</h3>", 503);
  }

  const origin = new URL(c.req.url).origin;
  const identities = await exchangeCode(platform, c.env, `${origin}/oauth/callback/${platform}`, code);
  for (const identity of identities) {
    await c.env.DB.prepare(
      `INSERT INTO channels (id, platform, external_id, display_name, handle, access_token_enc, token_expires_at, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8)
       ON CONFLICT (platform, external_id) DO UPDATE SET
         display_name = ?4, handle = ?5, access_token_enc = ?6, token_expires_at = ?7, status = 'active'`,
    )
      .bind(
        crypto.randomUUID(),
        platform,
        identity.external_id,
        identity.display_name,
        identity.handle,
        await encryptSecret(identity.access_token, c.env.TOKEN_ENCRYPTION_KEY),
        identity.token_expires_at,
        nowSec(),
      )
      .run();
  }
  const names = identities.map((i) => i.display_name).join(", ");
  return c.html(
    `<div style="font-family:system-ui;max-width:420px;margin:15vh auto;text-align:center">
       <h2>Connected ✓</h2>
       <p>${names} is ready in Producer. You can close this window.</p>
     </div>`,
  );
});

// ── Public: the media capability gateway ─────────────────────────────────────
// Private R2, exposed one object at a time through opaque >=128-bit ids.
// This is what platforms fetch; there is no public bucket.

app.get("/media/:capability", async (c) => {
  const media = await c.env.DB.prepare(
    "SELECT r2_key, content_type, status FROM media WHERE capability_id = ?1",
  )
    .bind(c.req.param("capability"))
    .first<{ r2_key: string; content_type: string; status: string }>();
  if (!media || media.status === "orphan_expired") {
    throw new ApiError(404, "not_found", "No such media.");
  }
  const range = c.req.header("Range");
  const object = await c.env.MEDIA.get(media.r2_key, range ? { range: parseRange(range) } : undefined);
  if (!object) throw new ApiError(404, "not_found", "No such media.");
  const headers = new Headers({
    "Content-Type": media.content_type,
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": "bytes",
  });
  if (range && "offset" in (object.range ?? {})) {
    const r = object.range as { offset: number; length: number };
    headers.set("Content-Range", `bytes ${r.offset}-${r.offset + r.length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
});

function parseRange(header: string): R2Range | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, start, end] = match;
  if (start === "" && end === "") return undefined;
  if (start === "") return { suffix: Number(end) };
  const offset = Number(start);
  return end === "" ? { offset } : { offset, length: Number(end) - offset + 1 };
}

// ── Worker entry ─────────────────────────────────────────────────────────────

export { RealtimeHub } from "./realtime";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(tick(env)),
} satisfies ExportedHandler<Env>;
