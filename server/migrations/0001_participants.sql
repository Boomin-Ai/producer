-- Phase 1 item 1 (#46): participant kind + grants on the roster row, and the
-- control seat (#47). Fresh installs get these from schema.sql; an EXISTING
-- deployment applies this once with `wrangler d1 migrations apply producer`
-- (tracked in d1_migrations, so re-running is safe).
ALTER TABLE live_room_guests ADD COLUMN kind TEXT NOT NULL DEFAULT 'visitor' CHECK (kind IN ('visitor', 'producer', 'audience'));
ALTER TABLE live_room_guests ADD COLUMN producer_ref TEXT;
ALTER TABLE live_room_guests ADD COLUMN grants TEXT;
ALTER TABLE live_room_guests ADD COLUMN seat TEXT NOT NULL DEFAULT 'guest' CHECK (seat IN ('guest', 'control'));
