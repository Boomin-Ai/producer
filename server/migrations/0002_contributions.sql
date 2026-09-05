-- Phase 1 item 5 (#50): the contribution ledger + runs; item 7 (#51): the
-- audience code. Fresh installs read schema.sql; existing deployments apply
-- this once with `wrangler d1 migrations apply producer`.
ALTER TABLE live_rooms ADD COLUMN run_id TEXT;
ALTER TABLE live_rooms ADD COLUMN run_started_at INTEGER;
ALTER TABLE live_rooms ADD COLUMN audience_code TEXT;

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  run_id TEXT,
  participant_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('presence', 'media.screen', 'overlay', 'input', 'credit')),
  binding TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  source TEXT NOT NULL CHECK (source IN ('host_stage', 'participant', 'interaction', 'host_credit')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (participant_id, kind, started_at)
);
CREATE INDEX IF NOT EXISTS contributions_room_idx ON contributions (room_id, run_id, started_at);
CREATE INDEX IF NOT EXISTS contributions_open_idx ON contributions (room_id, ended_at);
