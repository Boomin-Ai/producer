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

-- ── Live guests ─────────────────────────────────────────────────────────────
-- Host↔guest over WebRTC. This server only INTRODUCES peers (a signaling
-- Durable Object per guest and per room) and keeps the roster + stage list;
-- media flows device to device and never touches the worker. Same tables
-- and DTOs as Boomin's hosted API minus every brand/org/deal column, so the
-- Producer desktop app speaks to either without a fork.

CREATE TABLE IF NOT EXISTS live_rooms (
  id TEXT PRIMARY KEY,
  title TEXT,
  -- Producer's OWN room id (its local SQLite row). Never the PK — a client
  -- must not choose identity here — just a lookup key that makes
  -- registration idempotent across retries, reinstalls, second machines.
  external_ref TEXT UNIQUE,
  config TEXT NOT NULL DEFAULT '{}',
  -- Room-level guest join link: hashed; rotating revokes everyone who joined
  -- through the old code.
  guest_join_code_hash TEXT,
  guest_join_enabled INTEGER NOT NULL DEFAULT 0,
  -- Escape hatch for a trusted panel. OFF by default: a public link plus
  -- auto-admit puts an unknown person on air under a name they typed.
  guest_auto_admit INTEGER NOT NULL DEFAULT 0,
  -- Concurrent ADMITTED guests, enforced server-side.
  guest_capacity INTEGER NOT NULL DEFAULT 8,
  -- Who is ON STAGE right now (JSON array of guest ids) — authoritative and
  -- persisted, so the ephemeral fan-out layer owns no durable truth.
  stage_guest_ids TEXT NOT NULL DEFAULT '[]',
  -- Monotonic, single-writer: clients apply an update only if newer.
  stage_version INTEGER NOT NULL DEFAULT 0,
  stage_capacity INTEGER NOT NULL DEFAULT 4,
  -- Last time the host's Producer touched this room (roster poll / stage
  -- publish). A heartbeat, not a flag: a crashed host stops stamping.
  host_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS live_room_guests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  -- Hashed, shown once. The invite code IS the guest's credential.
  invite_code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'waiting', 'accepted', 'declined', 'revoked', 'ended')),
  -- 'room_link' guests land in `waiting` and are not renderable until
  -- admitted; 'invite' guests were sent to a specific named person.
  joined_via TEXT NOT NULL DEFAULT 'invite' CHECK (joined_via IN ('invite', 'room_link')),
  -- Host-controlled slot order; never derived from a timestamp a reload changes.
  position INTEGER,
  -- Reserved (v1 does not accept snapshot uploads on the public join route).
  snapshot TEXT,
  -- Stable peer id across reconnects, so a reconnect is the same participant.
  peer_id TEXT NOT NULL,
  -- Coarse inbound quality reported by the RENDER page + when.
  quality TEXT CHECK (quality IS NULL OR quality IN ('good', 'degraded', 'failing')),
  quality_at INTEGER,
  quality_stats TEXT,
  -- Touched by ticket mints and quality reports: evidence, not self-report.
  last_seen_at INTEGER,
  accepted_at INTEGER,
  admitted_at INTEGER,
  declined_at INTEGER,
  revoked_at INTEGER,
  ended_at INTEGER,
  -- The on-stage clock: stage publishes open (stage_since) and close (fold
  -- into stage_seconds) one segment per guest. Roster bookkeeping only here.
  stage_seconds INTEGER NOT NULL DEFAULT 0,
  stage_since INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS live_room_guests_room_idx ON live_room_guests (room_id, created_at);
