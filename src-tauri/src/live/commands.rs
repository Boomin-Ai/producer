//! Live IPC surface (M-L5). §8 boundary rules, mirroring the endpoint-token
//! law in ipc.rs: a stream key crosses this boundary exactly once, inbound,
//! in `live_upsert_destination` — it goes straight to the OS keychain and is
//! never readable back. The webview only ever sees destination rows and
//! engine status; even the credential_id stays server-side.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::error::{EngineError, EngineResult};
use crate::live::creds;
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct DestinationRow {
    pub id: String,
    pub preset: String,
    pub label: String,
    pub server: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct UpsertDestination {
    pub id: Option<String>,
    pub preset: String,
    pub label: String,
    pub server: Option<String>,
    /// The stream key. Present on create (required) or to replace. Consumed
    /// here — stored in the keychain, never persisted or echoed back.
    pub key: Option<String>,
    pub enabled: Option<bool>,
}

const PRESETS: &[&str] = &["twitch", "kick", "youtube", "custom"];

fn row_from_db(r: &rusqlite::Row<'_>) -> rusqlite::Result<DestinationRow> {
    Ok(DestinationRow {
        id: r.get(0)?,
        preset: r.get(1)?,
        label: r.get(2)?,
        server: r.get(3)?,
        enabled: r.get::<_, i64>(4)? != 0,
        created_at: r.get(5)?,
    })
}

#[tauri::command]
pub fn live_list_destinations(state: State<'_, AppState>) -> EngineResult<Vec<DestinationRow>> {
    let conn = state.db.lock().expect("db mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT id, preset, label, server, enabled, created_at FROM live_destinations ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], row_from_db)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn live_upsert_destination(
    state: State<'_, AppState>,
    input: UpsertDestination,
) -> EngineResult<DestinationRow> {
    if !PRESETS.contains(&input.preset.as_str()) {
        return Err(EngineError::Other(format!(
            "unknown preset {}",
            input.preset
        )));
    }
    let server = match input.preset.as_str() {
        "kick" => {
            let raw = input.server.as_deref().ok_or_else(|| {
                EngineError::Other("Kick needs its ingest URL (from the Kick dashboard)".into())
            })?;
            Some(crate::live::normalize_kick_server_checked(raw).map_err(EngineError::Other)?)
        }
        "custom" => {
            let raw = input
                .server
                .as_deref()
                .ok_or_else(|| EngineError::Other("Custom RTMP needs a server URL".into()))?
                .trim()
                .to_string();
            if !(raw.starts_with("rtmp://") || raw.starts_with("rtmps://")) {
                return Err(EngineError::Other(
                    "server must start with rtmp:// or rtmps://".into(),
                ));
            }
            Some(raw)
        }
        _ => None,
    };

    let conn = state.db.lock().expect("db mutex poisoned");
    let (id, credential_id, creating) = match &input.id {
        Some(id) => {
            let cred: String = conn
                .query_row(
                    "SELECT credential_id FROM live_destinations WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .map_err(|_| EngineError::Other("destination not found".into()))?;
            (id.clone(), cred, false)
        }
        None => (
            Uuid::new_v4().to_string(),
            format!("cred-{}", Uuid::new_v4()),
            true,
        ),
    };

    // §8: the key goes to the keychain now, under the opaque credential id,
    // and nowhere else. Creation requires one.
    match (&input.key, creating) {
        (Some(key), _) => {
            let key = key.trim();
            if key.is_empty() {
                return Err(EngineError::Other("stream key is empty".into()));
            }
            creds::store(&credential_id, key).map_err(EngineError::Other)?;
        }
        (None, true) => return Err(EngineError::Other("a stream key is required".into())),
        (None, false) => {}
    }

    let enabled = input.enabled.unwrap_or(true);
    conn.execute(
        "INSERT INTO live_destinations (id, preset, label, server, credential_id, enabled)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET preset = ?2, label = ?3, server = ?4, enabled = ?6",
        params![
            id,
            input.preset,
            input.label,
            server,
            credential_id,
            enabled as i64
        ],
    )?;

    let row = conn.query_row(
        "SELECT id, preset, label, server, enabled, created_at FROM live_destinations WHERE id = ?1",
        params![id],
        row_from_db,
    )?;
    Ok(row)
}

#[tauri::command]
pub fn live_delete_destination(state: State<'_, AppState>, id: String) -> EngineResult<()> {
    let conn = state.db.lock().expect("db mutex poisoned");
    let cred: Option<String> = conn
        .query_row(
            "SELECT credential_id FROM live_destinations WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    conn.execute("DELETE FROM live_destinations WHERE id = ?1", params![id])?;
    if let Some(cred) = cred {
        // Best-effort: the row is gone either way; a stale keychain entry is
        // inert because nothing references the credential id anymore.
        let _ = creds::delete(&cred);
    }
    Ok(())
}

#[tauri::command]
pub fn live_go_live(state: State<'_, AppState>) -> EngineResult<()> {
    let specs: Vec<(String, String, Option<String>, String)> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, preset, server, credential_id FROM live_destinations WHERE enabled = 1 ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if specs.is_empty() {
        return Err(EngineError::Other("no enabled destinations".into()));
    }
    state.live.go_live_specs(specs).map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_stop(state: State<'_, AppState>) -> EngineResult<()> {
    state.live.stop_live().map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_engine_status(state: State<'_, AppState>) -> EngineResult<serde_json::Value> {
    Ok(state.live.status())
}

#[tauri::command]
pub fn live_set_sources(
    state: State<'_, AppState>,
    screen: bool,
    camera: bool,
    mic: bool,
) -> EngineResult<()> {
    state
        .live
        .set_sources(screen, camera, mic)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_attach_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> EngineResult<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| EngineError::Other("main window missing".into()))?;
        let ns_window = window
            .ns_window()
            .map_err(|e| EngineError::Other(format!("ns_window: {e}")))?
            as usize;
        state
            .live
            .attach_preview(ns_window, x, y, w, h)
            .map_err(EngineError::Other)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, x, y, w, h);
        Err(EngineError::Other(
            "live preview is macOS-only in this build".into(),
        ))
    }
}

#[tauri::command]
pub fn live_move_preview(
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> EngineResult<()> {
    state
        .live
        .move_preview(x, y, w, h)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_detach_preview(state: State<'_, AppState>) -> EngineResult<()> {
    state.live.detach_preview().map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_set_overlay(
    state: State<'_, AppState>,
    window_id: Option<u32>,
    color_key: bool,
    url: Option<String>,
) -> EngineResult<()> {
    state
        .live
        .set_overlay(window_id, color_key, url)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_list_windows(state: State<'_, AppState>) -> EngineResult<serde_json::Value> {
    state.live.list_windows().map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_permissions() -> EngineResult<serde_json::Value> {
    Ok(crate::live::permissions())
}

#[tauri::command]
pub fn live_request_permission(kind: String) -> EngineResult<()> {
    crate::live::request_permission(&kind).map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_screen_coach(action: String) -> EngineResult<()> {
    crate::live::screen_grant_coach(&action).map_err(EngineError::Other)
}

/// First Light resume marker. localStorage can't carry this across the
/// screen-grant relaunch (WKWebView flushes it to disk asynchronously, so
/// an immediate restart loses the write) — a file in app data is
/// deterministic. "set" on entering the permissions step, "take" on boot
/// (returns whether onboarding should resume there), "clear" on finish.
#[tauri::command]
pub fn firstlight_resume(app: tauri::AppHandle, action: String) -> EngineResult<bool> {
    use tauri::Manager;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| EngineError::Other(e.to_string()))?
        .join("firstlight-resume");
    match action.as_str() {
        "set" => {
            std::fs::write(&path, b"permissions").map_err(|e| EngineError::Other(e.to_string()))?;
            Ok(true)
        }
        "take" => {
            let hit = path.exists();
            if hit {
                let _ = std::fs::remove_file(&path);
            }
            Ok(hit)
        }
        "clear" => {
            let _ = std::fs::remove_file(&path);
            Ok(true)
        }
        other => Err(EngineError::Other(format!("unknown resume action {other}"))),
    }
}
