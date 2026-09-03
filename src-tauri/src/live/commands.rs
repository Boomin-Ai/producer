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
pub async fn live_list_destinations(
    state: State<'_, AppState>,
) -> EngineResult<Vec<DestinationRow>> {
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
pub async fn live_upsert_destination(
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
pub async fn live_delete_destination(state: State<'_, AppState>, id: String) -> EngineResult<()> {
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
pub async fn live_go_live(state: State<'_, AppState>) -> EngineResult<()> {
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
pub async fn live_stop(state: State<'_, AppState>) -> EngineResult<()> {
    state.live.stop_live().map_err(EngineError::Other)
}

#[tauri::command]
// EVERY live command is async, by law: Tauri runs sync commands on the app's
// MAIN thread, and several engine wrappers block on a reply with a 5s timeout.
// Meanwhile the engine loop hops to the main thread (dispatch_sync in the
// preview attach, CEF's UI-thread task in browser creation). Main waiting on
// the engine while the engine waits on main = a room open frozen until the
// timeout fires — measured 4.5s, on whichever command reached the hop first.
pub async fn live_engine_status(state: State<'_, AppState>) -> EngineResult<serde_json::Value> {
    Ok(state.live.status())
}

#[tauri::command]
pub async fn live_set_sources(
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
pub async fn live_attach_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> EngineResult<bool> {
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
        // Decide the stage treatment here, synchronously, so the answer is
        // already true by the time the engine thread attaches the view.
        let transparent = crate::live::prepare_stage(ns_window);
        state
            .live
            .attach_preview(ns_window, x, y, w, h)
            .map_err(EngineError::Other)?;
        Ok(transparent)
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
pub async fn live_move_preview(
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
pub async fn live_detach_preview(state: State<'_, AppState>) -> EngineResult<()> {
    state.live.detach_preview().map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_set_overlay(
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
pub async fn live_list_windows(state: State<'_, AppState>) -> EngineResult<serde_json::Value> {
    state.live.list_windows().map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_permissions() -> EngineResult<serde_json::Value> {
    Ok(crate::live::permissions())
}

#[tauri::command]
pub async fn live_set_thumb_rate(state: State<'_, AppState>, fps: u32) -> EngineResult<()> {
    state.live.set_thumb_rate(fps);
    Ok(())
}

#[tauri::command]
pub async fn live_home_glass(app: tauri::AppHandle) -> EngineResult<()> {
    // Home wears the glass; rooms strip it on preview attach (shim.m). This
    // is the way back when the user leaves a room.
    #[cfg(all(target_os = "macos", have_engine))]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(ns) = window.ns_window() {
                unsafe { crate::live::ffi::producer_apply_window_vibrancy(ns) };
            }
        }
    }
    #[cfg(not(all(target_os = "macos", have_engine)))]
    let _ = app;
    Ok(())
}

#[tauri::command]
pub async fn live_request_permission(kind: String) -> EngineResult<()> {
    crate::live::request_permission(&kind).map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_screen_coach(action: String) -> EngineResult<()> {
    crate::live::screen_grant_coach(&action).map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_preview_hidden(state: State<'_, AppState>, hidden: bool) -> EngineResult<()> {
    state
        .live
        .set_preview_hidden(hidden)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_set_transform(
    state: State<'_, AppState>,
    id: String,
    patch: serde_json::Value,
    commit: bool,
) -> EngineResult<()> {
    #[cfg(have_engine)]
    {
        let patch: crate::live::graph::TransformPatch =
            serde_json::from_value(patch).map_err(|e| EngineError::Other(e.to_string()))?;
        state
            .live
            .set_transform(id, patch, commit)
            .map_err(EngineError::Other)
    }
    #[cfg(not(have_engine))]
    {
        state
            .live
            .set_transform(id, patch, commit)
            .map_err(EngineError::Other)
    }
}

/// Devices behind a source picker: cameras and capture cards, microphones
/// and audio interfaces, displays. Straight from libobs, so anything the OS
/// exposes shows up without Producer knowing the hardware.
#[tauri::command]
pub async fn live_source_devices(
    state: State<'_, AppState>,
    kind: String,
) -> EngineResult<serde_json::Value> {
    // HARD RULE: never ask libobs to enumerate a device class the OS has not
    // granted. AVFoundation blocks inside the properties call until the TCC
    // prompt is answered, and that call runs on the engine-owner thread —
    // so an ungranted camera would freeze the preview and the stream, not
    // just this menu. Permission state is cheap and non-blocking; check it
    // first and let the UI ask for the grant instead.
    let perms = crate::live::permissions();
    let needed = match kind.as_str() {
        "camera" => Some("camera"),
        "screen" => Some("screen"),
        // CoreAudio enumerates inputs without a grant; only capture is gated.
        _ => None,
    };
    if let Some(key) = needed {
        let granted = perms
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s == "granted")
            .unwrap_or(false);
        if !granted {
            return Ok(serde_json::Value::Array(Vec::new()));
        }
    }
    let list = state.live.list_devices(kind).map_err(EngineError::Other)?;
    Ok(serde_json::to_value(list).unwrap_or(serde_json::Value::Array(Vec::new())))
}

#[tauri::command]
pub async fn live_set_source_device(
    state: State<'_, AppState>,
    kind: String,
    device: String,
) -> EngineResult<()> {
    state
        .live
        .set_device(kind, device)
        .map_err(EngineError::Other)
}

/// Add an item from the open list (media/image/text/color/window). The spec
/// arrives as tagged JSON and is validated by serde before it can touch the
/// engine; the room document owns the id.
#[tauri::command]
pub async fn live_add_source(
    state: State<'_, AppState>,
    id: String,
    label: String,
    spec: serde_json::Value,
) -> EngineResult<()> {
    #[cfg(have_engine)]
    {
        let spec: crate::live::graph::ExtraSpec = serde_json::from_value(spec)
            .map_err(|e| EngineError::Other(format!("bad source spec: {e}")))?;
        return state
            .live
            .add_extra(id, label, spec)
            .map_err(EngineError::Other);
    }
    #[cfg(not(have_engine))]
    {
        let _ = (id, label, spec);
        Err(EngineError::Other(
            "live engine not bundled in this build".into(),
        ))
    }
}

#[tauri::command]
pub async fn live_remove_source(state: State<'_, AppState>, id: String) -> EngineResult<()> {
    state.live.remove_extra(id).map_err(EngineError::Other)
}

/// Native file picker for media/image sources.
///
/// 🔴 MUST be async with the CALLBACK api. A sync `#[tauri::command]` runs on
/// the main thread, and `blocking_pick_file()` then blocks that thread while
/// waiting for a dialog which itself needs the main thread to appear — the
/// app deadlocks into a spinning beachball and has to be force-quit. Async +
/// callback keeps the main thread free to actually draw the panel.
#[tauri::command]
pub async fn live_pick_file(app: tauri::AppHandle, kind: String) -> EngineResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().clone().file();
    let dialog = match kind.as_str() {
        "image" => dialog.add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]),
        _ => dialog.add_filter(
            "Media",
            &[
                "mp4", "mov", "m4v", "mkv", "webm", "mp3", "m4a", "wav", "aac", "flac",
            ],
        ),
    };
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    dialog.pick_file(move |f| {
        let _ = tx.blocking_send(f);
    });
    let picked = rx.recv().await.flatten();
    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Start the stinger over the stage; returns its duration in ms (0 = unknown).
#[tauri::command]
pub async fn live_play_stinger(state: State<'_, AppState>, path: String) -> EngineResult<i64> {
    state.live.play_stinger(path).map_err(EngineError::Other)
}

/// Start recording. The stamp comes from the UI so the engine owns no clock;
/// returns the file path it's writing.
#[tauri::command]
pub async fn live_start_recording(
    state: State<'_, AppState>,
    stamp: String,
) -> EngineResult<String> {
    state
        .live
        .start_recording(stamp)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_stop_recording(state: State<'_, AppState>) -> EngineResult<Option<String>> {
    state.live.stop_recording().map_err(EngineError::Other)
}

/// Reveal a finished recording in Finder.
#[tauri::command]
pub async fn live_reveal_file(path: String) -> EngineResult<()> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| EngineError::Other(e.to_string()))?;
    Ok(())
}

/// One door for the whole filter chain: list, add, remove, enable, reorder,
/// update. Every call answers with the chain's new state so the UI never has
/// to model it separately.
#[tauri::command]
pub async fn live_set_sync_offset(
    state: State<'_, AppState>,
    id: String,
    ms: i64,
) -> EngineResult<()> {
    state
        .live
        .set_sync_offset(id, ms)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_set_source_audio(
    state: State<'_, AppState>,
    id: String,
    volume: Option<f32>,
    muted: Option<bool>,
) -> EngineResult<()> {
    state
        .live
        .set_source_audio(id, volume, muted)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_set_opacity(
    state: State<'_, AppState>,
    id: String,
    opacity: f64,
) -> EngineResult<()> {
    state
        .live
        .set_item_opacity(id, opacity)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_filters(
    state: State<'_, AppState>,
    source: String,
    op: serde_json::Value,
) -> EngineResult<serde_json::Value> {
    #[cfg(have_engine)]
    {
        let op: crate::live::engine::FilterOp = serde_json::from_value(op)
            .map_err(|e| EngineError::Other(format!("bad filter op: {e}")))?;
        let list = state.live.filters(source, op).map_err(EngineError::Other)?;
        return Ok(serde_json::to_value(list).unwrap_or(serde_json::Value::Array(Vec::new())));
    }
    #[cfg(not(have_engine))]
    {
        let _ = (source, op);
        Ok(serde_json::Value::Array(Vec::new()))
    }
}

/// Virtual camera: activation is a system-extension install (needs user
/// approval, once), separate from starting the output.
#[tauri::command]
pub async fn live_vcam_status() -> EngineResult<serde_json::Value> {
    Ok(crate::live::vcam_status())
}

#[tauri::command]
pub async fn live_vcam_activate() -> EngineResult<()> {
    crate::live::vcam_activate();
    Ok(())
}

#[tauri::command]
pub async fn live_vcam_output(state: State<'_, AppState>, on: bool) -> EngineResult<bool> {
    // Upstream's own text says "OBS"; rewrite it on the way out. Only
    // meaningful with an engine — without one there is nothing to start.
    #[cfg(have_engine)]
    let map = |e: String| EngineError::Other(crate::live::engine::user_facing(&e));
    #[cfg(not(have_engine))]
    let map = EngineError::Other;
    state.live.set_virtual_cam(on).map_err(map)
}

#[tauri::command]
pub async fn live_prepare_stinger(state: State<'_, AppState>, path: String) -> EngineResult<()> {
    state.live.prepare_stinger(path).map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_stop_stinger(state: State<'_, AppState>) -> EngineResult<()> {
    state.live.stop_stinger().map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_set_video(state: State<'_, AppState>, height: u32, fps: u32) -> EngineResult<()> {
    state
        .live
        .set_video(height, fps)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub async fn live_set_mic_audio(
    state: State<'_, AppState>,
    volume: Option<f32>,
    muted: Option<bool>,
) -> EngineResult<()> {
    state
        .live
        .set_mic_audio(volume, muted)
        .map_err(EngineError::Other)
}

/// Day-one chat: the platform's own popout chat in a compact companion
/// window (cookies persist in the webview data store, so one login lasts).
/// Host-allowlisted — this must never become an arbitrary-URL opener.
#[tauri::command]
pub async fn live_open_chat(app: tauri::AppHandle, url: String) -> EngineResult<()> {
    use tauri::Manager;
    let parsed = tauri::Url::parse(&url).map_err(|e| EngineError::Other(e.to_string()))?;
    let host_ok = parsed.scheme() == "https"
        && parsed.host_str().is_some_and(|h| {
            h == "www.twitch.tv"
                || h == "twitch.tv"
                || h == "kick.com"
                || h == "www.youtube.com"
                || h == "youtube.com"
        });
    if !host_ok {
        return Err(EngineError::Other(
            "chat url must be a twitch/kick/youtube page".into(),
        ));
    }
    let label = "chat";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.close();
    }
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(parsed))
        .title("Chat")
        .inner_size(380.0, 640.0)
        .always_on_top(true)
        .build()
        .map_err(|e| EngineError::Other(e.to_string()))?;
    Ok(())
}

// ── Live rooms: switchable show documents (control-room home) ───────────────

#[derive(Debug, Serialize)]
pub struct RoomRow {
    pub id: String,
    pub name: String,
    pub config: String,
    pub last_live_at: Option<String>,
    pub created_at: String,
}

fn room_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoomRow> {
    Ok(RoomRow {
        id: row.get(0)?,
        name: row.get(1)?,
        config: row.get(2)?,
        last_live_at: row.get(3)?,
        created_at: row.get(4)?,
    })
}

#[tauri::command]
pub async fn live_list_rooms(state: State<'_, AppState>) -> EngineResult<Vec<RoomRow>> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT id, name, config, last_live_at, created_at FROM live_rooms
             ORDER BY COALESCE(last_live_at, created_at) DESC",
        )
        .map_err(|e| EngineError::Other(e.to_string()))?;
    let rows = stmt
        .query_map([], |r| room_from_row(r))
        .and_then(|it| it.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| EngineError::Other(e.to_string()))?;
    Ok(rows)
}

#[tauri::command]
pub async fn live_create_room(state: State<'_, AppState>, name: String) -> EngineResult<RoomRow> {
    let id = Uuid::new_v4().to_string();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(EngineError::Other("room name is empty".into()));
    }
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO live_rooms (id, name) VALUES (?1, ?2)",
        params![id, name],
    )
    .map_err(|e| EngineError::Other(e.to_string()))?;
    db.query_row(
        "SELECT id, name, config, last_live_at, created_at FROM live_rooms WHERE id = ?1",
        params![id],
        |r| room_from_row(r),
    )
    .map_err(|e| EngineError::Other(e.to_string()))
}

#[tauri::command]
pub async fn live_update_room(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    config: Option<String>,
    touch_live: Option<bool>,
) -> EngineResult<()> {
    let db = state.db.lock().unwrap();
    if let Some(name) = name {
        let name = name.trim().to_string();
        if !name.is_empty() {
            db.execute(
                "UPDATE live_rooms SET name = ?2 WHERE id = ?1",
                params![id, name],
            )
            .map_err(|e| EngineError::Other(e.to_string()))?;
        }
    }
    if let Some(config) = config {
        // Refuse malformed JSON so a bad write can't brick a room.
        serde_json::from_str::<serde_json::Value>(&config)
            .map_err(|e| EngineError::Other(format!("room config is not JSON: {e}")))?;
        db.execute(
            "UPDATE live_rooms SET config = ?2 WHERE id = ?1",
            params![id, config],
        )
        .map_err(|e| EngineError::Other(e.to_string()))?;
    }
    if touch_live == Some(true) {
        db.execute(
            "UPDATE live_rooms SET last_live_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
            params![id],
        )
        .map_err(|e| EngineError::Other(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn live_delete_room(state: State<'_, AppState>, id: String) -> EngineResult<()> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM live_rooms WHERE id = ?1", params![id])
        .map_err(|e| EngineError::Other(e.to_string()))?;
    Ok(())
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
