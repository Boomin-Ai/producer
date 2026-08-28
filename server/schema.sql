-- producer-server D1 schema. Single-user by design: no accounts, orgs,
-- teams, or billing — one deployment IS one workspace. Idempotent
-- (CREATE IF NOT EXISTS) so re-running is always safe.

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'threads')),
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  handle TEXT,
  access_token_enc TEXT NOT NULL,
  token_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect', 'disabled')),
  created_at INTEGER NOT NULL,
  UNIQUE (platform, external_id)
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'attached', 'orphan_expired')),
  -- Opaque bearer capability (>=128-bit CSPRNG) — the ONLY public handle
  -- to the private R2 object. Never logged.
  capability_id TEXT NOT NULL UNIQUE,
  -- One-time signed token authorizing the PUT of the bytes.
  put_token TEXT,
  put_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  caption TEXT,
  media_id TEXT REFERENCES media(id),
  media_url TEXT,
  overrides TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled', 'queued', 'publishing', 'published', 'failed', 'canceled')),
  due_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  -- Platform-side ids persisted BEFORE the call that consumes them
  -- (container ids, creation ids) so a crashed tick resumes, never re-posts.
  checkpoint TEXT NOT NULL DEFAULT '{}',
  error_class TEXT,
  error_message TEXT,
  published_external_id TEXT,
  published_external_url TEXT,
  intent_id TEXT,
  client_request_id TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (state, due_at);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at);

-- Effectively-once acceptance. Rows are permanent by design: a client can
-- replay an unacknowledged outbox item months later and must receive the
-- original result, never a second post.
CREATE TABLE IF NOT EXISTS submissions (
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  job_id TEXT,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (operation, idempotency_key)
);

-- Self-configuration (e.g. public_origin, learned from the first authed
-- request so cron ticks can mint public media URLs without any config).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Short-lived, single-use browser sessions for channel OAuth. The bearer
-- token never appears in a URL; `state` authenticates the callback.
CREATE TABLE IF NOT EXISTS connect_sessions (
  nonce TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
