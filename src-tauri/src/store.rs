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
            preset        TEXT NOT NULL CHECK (preset IN ('twitch', 'kick', 'youtube', 'facebook', 'instagram', 'rumble', 'tiktok', 'custom')),
            label         TEXT NOT NULL,
            server        TEXT,
            credential_id TEXT NOT NULL,
            enabled       INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        -- Live rooms: each room is a switchable show document owning its
        -- scene config (sources, overlay) as JSON. Destinations stay global.
        CREATE TABLE IF NOT EXISTS live_rooms (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            config       TEXT NOT NULL DEFAULT '{}',
            last_live_at TEXT,
            created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

        -- Durable app preferences (ipc::pref_get / pref_set). Facts that must
        -- outlive the webview's storage: "don't show the Network invitation
        -- again" lives here, never in localStorage.
        CREATE TABLE IF NOT EXISTS prefs (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS manager_cache (
            endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
            session_scope TEXT NOT NULL,
            resource TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY(endpoint_id, session_scope, resource)
        );

        -- Capture catalog: paths are local; only provenance syncs to Boomin.
        CREATE TABLE IF NOT EXISTS local_recordings (
            id TEXT PRIMARY KEY,
            endpoint_id TEXT,
            room_id TEXT NOT NULL,
            room_name TEXT NOT NULL,
            source_room_id TEXT,
            path TEXT NOT NULL UNIQUE,
            started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            started_ms INTEGER NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            file_size INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','ready','interrupted')),
            collection_id TEXT,
            unit_id TEXT,
            sync_error TEXT
        );
        CREATE INDEX IF NOT EXISTS local_recordings_endpoint_idx ON local_recordings(endpoint_id, started_at);
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
    // v3: rooms and destinations belong to a WORKSPACE (endpoint). A room
    // registered under one brand must never be opened as another brand's —
    // its server room, guests, knock and deals all hang off that brand.
    // Legacy rows (NULL) are claimed by the first connected workspace once,
    // which is the only one they could have belonged to.
    for table in ["live_rooms", "live_destinations"] {
        let has = conn
            .prepare(&format!(
                "SELECT 1 FROM pragma_table_info('{table}') WHERE name = 'endpoint_id'"
            ))?
            .exists([])?;
        if !has {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN endpoint_id TEXT;"))?;
        }
        conn.execute(
            &format!(
                "UPDATE {table} SET endpoint_id = (SELECT id FROM endpoints WHERE kind = 'connected' ORDER BY created_at LIMIT 1)
                 WHERE endpoint_id IS NULL AND EXISTS (SELECT 1 FROM endpoints WHERE kind = 'connected')"
            ),
            [],
        )?;
    }
    migrate_streaming_presets(conn)?;
    Ok(())
}

/// SQLite cannot expand a CHECK in place. Keep every destination and its
/// keychain reference while rebuilding the old table atomically.
fn migrate_streaming_presets(conn: &Connection) -> EngineResult<()> {
    let schema: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'live_destinations'",
        [], |r| r.get(0),
    )?;
    if schema.contains("'facebook'") && schema.contains("'instagram'") && schema.contains("'rumble'") && schema.contains("'tiktok'") {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(r#"
        CREATE TABLE live_destinations_expanded (
            id TEXT PRIMARY KEY,
            preset TEXT NOT NULL CHECK (preset IN ('twitch', 'kick', 'youtube', 'facebook', 'instagram', 'rumble', 'tiktok', 'custom')),
            label TEXT NOT NULL,
            server TEXT,
            credential_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            endpoint_id TEXT
        );
        INSERT INTO live_destinations_expanded
            (id, preset, label, server, credential_id, enabled, created_at, endpoint_id)
            SELECT id, preset, label, server, credential_id, enabled, created_at, endpoint_id
            FROM live_destinations;
        DROP TABLE live_destinations;
        ALTER TABLE live_destinations_expanded RENAME TO live_destinations;
    "#)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod streaming_preset_tests {
    use super::*;

    #[test]
    fn upgrades_the_instagram_rumble_tiktok_schema_to_include_facebook() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(r#"
            CREATE TABLE live_destinations (
                id TEXT PRIMARY KEY,
                preset TEXT NOT NULL CHECK (preset IN ('twitch', 'kick', 'youtube', 'instagram', 'rumble', 'tiktok', 'custom')),
                label TEXT NOT NULL, server TEXT, credential_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT 'saved', endpoint_id TEXT
            );
            INSERT INTO live_destinations (id, preset, label, credential_id, endpoint_id)
                VALUES ('ig', 'instagram', 'Instagram', 'existing-ref', 'workspace');
        "#).unwrap();
        migrate_streaming_presets(&conn).unwrap();
        conn.execute("INSERT INTO live_destinations (id, preset, label, credential_id) VALUES ('fb', 'facebook', 'Facebook', 'new-ref')", []).unwrap();
        let credential: String = conn.query_row("SELECT credential_id FROM live_destinations WHERE id = 'ig'", [], |r| r.get(0)).unwrap();
        assert_eq!(credential, "existing-ref");
    }

    #[test]
    fn upgrades_old_destinations_without_losing_credentials_or_workspace() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(r#"
            CREATE TABLE live_destinations (
                id TEXT PRIMARY KEY,
                preset TEXT NOT NULL CHECK (preset IN ('twitch', 'kick', 'youtube', 'custom')),
                label TEXT NOT NULL, server TEXT, credential_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
                endpoint_id TEXT
            );
            INSERT INTO live_destinations VALUES
                ('existing', 'custom', 'My stream', 'rtmps://example.com/live', 'opaque-key-ref', 0, '2026-09-29', 'workspace');
        "#).unwrap();
        migrate_streaming_presets(&conn).unwrap();
        migrate_streaming_presets(&conn).unwrap();
        let row: (String, String, i64, String, String) = conn.query_row(
            "SELECT label, credential_id, enabled, created_at, endpoint_id FROM live_destinations WHERE id = 'existing'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).unwrap();
        assert_eq!(row, ("My stream".into(), "opaque-key-ref".into(), 0, "2026-09-29".into(), "workspace".into()));
        for preset in ["facebook", "instagram", "rumble", "tiktok"] {
            conn.execute("INSERT INTO live_destinations (id, preset, label, credential_id) VALUES (?1, ?1, ?1, 'ref')", [preset]).unwrap();
        }
        assert!(conn.execute("INSERT INTO live_destinations (id, preset, label, credential_id) VALUES ('bad', 'invalid', 'bad', 'ref')", []).is_err());
    }
}
