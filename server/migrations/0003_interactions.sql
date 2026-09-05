-- Phase 1 item 7 (#51): interactions. Fresh installs read schema.sql;
-- existing deployments apply this once with `wrangler d1 migrations apply producer`.
CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  run_id TEXT,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('draft', 'open', 'collecting', 'revealed', 'closed', 'cancelled')),
  spec TEXT NOT NULL DEFAULT '{}',
  input TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT '{}',
  timing TEXT NOT NULL DEFAULT '{}',
  render TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  revealed_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS interactions_room_idx ON interactions (room_id, created_at);
