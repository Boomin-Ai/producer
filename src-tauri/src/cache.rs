//! Disposable Manager read cache. Credentials remain in the vault; drafts and
//! submission intents are never stored here. Scope includes the current token
//! so reconnecting as another account cannot hydrate the previous account.
use crate::{
    error::{EngineError, EngineResult},
    vault, AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

fn scope(state: &AppState, endpoint_id: &str) -> EngineResult<String> {
    let (base, brand): (String, Option<String>) =
        state.db.lock().expect("db mutex poisoned").query_row(
            "SELECT base_url, brand_slug FROM endpoints WHERE id = ?1",
            [endpoint_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
    let token = vault::get_token(endpoint_id)?;
    scope_hash(endpoint_id, &base, brand.as_deref(), &token)
}
fn scope_hash(
    endpoint_id: &str,
    base: &str,
    brand: Option<&str>,
    token: &str,
) -> EngineResult<String> {
    let bytes = serde_json::to_vec(&(endpoint_id, base, brand, token))
        .map_err(|_| EngineError::Other("cache scope encoding failed".into()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}
fn validate(
    state: &AppState,
    endpoint_id: &str,
    session_scope: &str,
    resource: &str,
) -> EngineResult<()> {
    if !matches!(resource, "queries" | "navigation") || scope(state, endpoint_id)? != session_scope
    {
        return Err(EngineError::Other("cache scope changed".into()));
    }
    Ok(())
}

#[tauri::command]
pub fn manager_cache_scope(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<String> {
    let current = scope(&state, &endpoint_id)?;
    state.db.lock().expect("db mutex poisoned").execute(
        "DELETE FROM manager_cache WHERE endpoint_id = ?1 AND session_scope <> ?2",
        params![endpoint_id, current],
    )?;
    Ok(current)
}

#[tauri::command]
pub fn manager_cache_get(
    state: State<'_, AppState>,
    endpoint_id: String,
    session_scope: String,
    resource: String,
) -> EngineResult<Option<Value>> {
    validate(&state, &endpoint_id, &session_scope, &resource)?;
    let conn = state.db.lock().expect("db mutex poisoned");
    read_cache(&conn, &endpoint_id, &session_scope, &resource)
}
fn read_cache(
    conn: &Connection,
    endpoint_id: &str,
    session_scope: &str,
    resource: &str,
) -> EngineResult<Option<Value>> {
    let value: Option<String> = conn.query_row(
        "SELECT value FROM manager_cache WHERE endpoint_id = ?1 AND session_scope = ?2 AND resource = ?3 AND expires_at > unixepoch()",
        params![endpoint_id, session_scope, resource], |r| r.get(0)).optional()?;
    // Corruption is a cache miss, never a reason to block the workspace.
    Ok(value.and_then(|s| serde_json::from_str(&s).ok()))
}

#[tauri::command]
pub fn manager_cache_set(
    state: State<'_, AppState>,
    endpoint_id: String,
    session_scope: String,
    resource: String,
    value: Option<Value>,
) -> EngineResult<()> {
    validate(&state, &endpoint_id, &session_scope, &resource)?;
    let conn = state.db.lock().expect("db mutex poisoned");
    write_cache(&conn, &endpoint_id, &session_scope, &resource, value)
}
fn write_cache(
    conn: &Connection,
    endpoint_id: &str,
    session_scope: &str,
    resource: &str,
    value: Option<Value>,
) -> EngineResult<()> {
    let Some(value) = value else {
        conn.execute("DELETE FROM manager_cache WHERE endpoint_id = ?1 AND session_scope = ?2 AND resource = ?3", params![endpoint_id, session_scope, resource])?;
        return Ok(());
    };
    let json = serde_json::to_string(&value)
        .map_err(|_| EngineError::Other("cache encoding failed".into()))?;
    if json.len() > 8 * 1024 * 1024 {
        return Err(EngineError::Other("cache entry exceeds size limit".into()));
    }
    let ttl = if resource == "navigation" {
        30 * 86400
    } else {
        86400
    };
    conn.execute(
        "DELETE FROM manager_cache WHERE expires_at <= unixepoch()",
        [],
    )?;
    conn.execute(
        "INSERT INTO manager_cache (endpoint_id, session_scope, resource, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch() + ?5)
         ON CONFLICT(endpoint_id, session_scope, resource) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at",
        params![endpoint_id, session_scope, resource, json, ttl])?;
    // Bound persisted cache to 64 MiB, evicting the oldest entries first.
    while conn.query_row(
        "SELECT coalesce(sum(length(CAST(value AS BLOB))), 0) FROM manager_cache",
        [],
        |r| r.get::<_, i64>(0),
    )? > 64 * 1024 * 1024
    {
        conn.execute("DELETE FROM manager_cache WHERE rowid = (SELECT rowid FROM manager_cache ORDER BY updated_at, rowid LIMIT 1)", [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Connection {
        let conn = crate::store::open_in_memory().unwrap();
        conn.execute("INSERT INTO endpoints(id,kind,name,base_url) VALUES('a','connected','A','https://example.com'),('b','connected','B','https://example.com')", []).unwrap();
        conn
    }
    #[test]
    fn scopes_separate_credentials_hosts_and_brands() {
        let original = scope_hash("a", "https://example.com", Some("brand"), "secret").unwrap();
        assert_eq!(
            original,
            scope_hash("a", "https://example.com", Some("brand"), "secret").unwrap()
        );
        for (endpoint, host, brand, token) in [
            ("b", "https://example.com", "brand", "secret"),
            ("a", "https://other.com", "brand", "secret"),
            ("a", "https://example.com", "other", "secret"),
            ("a", "https://example.com", "brand", "another-account"),
        ] {
            assert_ne!(
                original,
                scope_hash(endpoint, host, Some(brand), token).unwrap()
            );
        }
        assert!(!original.contains("secret"));
    }
    #[test]
    fn isolates_resources_and_cascades_disconnect() {
        let conn = fixture();
        write_cache(
            &conn,
            "a",
            "session",
            "queries",
            Some(json!({"units": [1]})),
        )
        .unwrap();
        assert_eq!(
            read_cache(&conn, "a", "session", "queries").unwrap(),
            Some(json!({"units": [1]}))
        );
        assert!(read_cache(&conn, "b", "session", "queries")
            .unwrap()
            .is_none());
        assert!(read_cache(&conn, "a", "other-session", "queries")
            .unwrap()
            .is_none());
        assert!(read_cache(&conn, "a", "session", "navigation")
            .unwrap()
            .is_none());
        conn.execute("DELETE FROM endpoints WHERE id='a'", [])
            .unwrap();
        assert!(read_cache(&conn, "a", "session", "queries")
            .unwrap()
            .is_none());
        assert!(write_cache(&conn, "a", "session", "queries", Some(json!({}))).is_err());
    }
    #[test]
    fn expired_or_corrupt_entries_are_misses() {
        let conn = fixture();
        write_cache(&conn, "a", "s", "queries", Some(json!({"units": []}))).unwrap();
        conn.execute("UPDATE manager_cache SET expires_at=0", [])
            .unwrap();
        assert!(read_cache(&conn, "a", "s", "queries").unwrap().is_none());
        write_cache(&conn, "a", "s", "queries", Some(json!({}))).unwrap();
        conn.execute("UPDATE manager_cache SET value='broken json'", [])
            .unwrap();
        assert!(read_cache(&conn, "a", "s", "queries").unwrap().is_none());
    }
    #[test]
    fn oversized_writes_keep_last_known_data() {
        let conn = fixture();
        write_cache(&conn, "a", "s", "queries", Some(json!({"saved": true}))).unwrap();
        assert!(write_cache(
            &conn,
            "a",
            "s",
            "queries",
            Some(json!("x".repeat(8 * 1024 * 1024)))
        )
        .is_err());
        assert_eq!(
            read_cache(&conn, "a", "s", "queries").unwrap(),
            Some(json!({"saved": true}))
        );
        write_cache(&conn, "a", "s", "queries", None).unwrap();
        assert!(read_cache(&conn, "a", "s", "queries").unwrap().is_none());
    }
    #[test]
    fn survives_database_reopen() {
        let path = std::env::temp_dir().join(format!("producer-cache-{}.db", uuid::Uuid::new_v4()));
        {
            let conn = crate::store::open(&path).unwrap();
            conn.execute("INSERT INTO endpoints(id,kind,name,base_url) VALUES('a','connected','A','https://example.com')", []).unwrap();
            write_cache(
                &conn,
                "a",
                "s",
                "navigation",
                Some(json!({"tab":"insights","scroll":120})),
            )
            .unwrap();
        }
        let conn = crate::store::open(&path).unwrap();
        assert_eq!(
            read_cache(&conn, "a", "s", "navigation").unwrap(),
            Some(json!({"tab":"insights","scroll":120}))
        );
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
}
