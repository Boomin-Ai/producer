//! SQLite store. Holds endpoints and the client outbox — instructions
//! only, never tokens (vault) and never media bytes (paths/URLs only).

use std::path::Path;

use rusqlite::Connection;

use crate::error::EngineResult;

pub fn open(path: &Path) -> EngineResult<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> EngineResult<Connection> {
    let conn = Connection::open_in_memory()?;
    init(&conn)?;
    Ok(conn)
}

fn init(conn: &Connection) -> EngineResult<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS endpoints (
            id         TEXT PRIMARY KEY,
            kind       TEXT NOT NULL CHECK (kind IN ('connected', 'independent')),
            name       TEXT NOT NULL,
            base_url   TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        -- Live destinations (LIVE-REVIEW.md §5.4 / §8). credential_id is an
        -- opaque keychain reference; the stream key itself NEVER lands here.
        CREATE TABLE IF NOT EXISTS live_destinations (
            id            TEXT PRIMARY KEY,
            preset        TEXT NOT NULL CHECK (preset IN ('twitch', 'kick', 'youtube', 'custom')),
            label         TEXT NOT NULL,
            server        TEXT,
            credential_id TEXT NOT NULL,
            enabled       INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        -- The client outbox (PHASE1.md §2.4). Each target is
        -- self-sufficient: request_json is the exact immutable request
        -- to replay; resumption never depends on mutable draft state.
        CREATE TABLE IF NOT EXISTS submission_intents (
            id             TEXT PRIMARY KEY,
            created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            schema_version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS submission_targets (
            intent_id       TEXT NOT NULL REFERENCES submission_intents(id) ON DELETE CASCADE,
            endpoint_id     TEXT NOT NULL,
            channel_id      TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            request_json    TEXT NOT NULL,
            request_hash    TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'acknowledged')),
            acknowledged_at TEXT,
            last_error      TEXT,
            PRIMARY KEY (intent_id, endpoint_id, channel_id)
        );

        CREATE INDEX IF NOT EXISTS idx_targets_pending
            ON submission_targets(status) WHERE status = 'pending';
        "#,
    )?;
    // v2: connected endpoints carry the hosted workspace scope. A backend-
    // specific scoping detail (like the token itself), not a contract concept.
    let has_brand_slug = conn
        .prepare("SELECT 1 FROM pragma_table_info('endpoints') WHERE name = 'brand_slug'")?
        .exists([])?;
    if !has_brand_slug {
        conn.execute_batch("ALTER TABLE endpoints ADD COLUMN brand_slug TEXT;")?;
    }
    Ok(())
}
