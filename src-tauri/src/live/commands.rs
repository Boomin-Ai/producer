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
    // Windows split of the Mac shim's division of labor: the child window is
    // created/moved/destroyed ON THE MAIN THREAD (cross-thread child windows
    // link input queues with the webview's thread — the M-W6 crash); the
    // engine thread only ever touches the obs_display bound to it.
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| EngineError::Other("main window missing".into()))?;
        let parent = window
            .hwnd()
            .map_err(|e| EngineError::Other(format!("hwnd: {e}")))?
            .0 as usize;
        let scale = window.scale_factor().unwrap_or(1.0);
        let (px, py) = ((x * scale) as i32, (y * scale) as i32);
        let (pw, ph) = (((w * scale) as i32).max(1), ((h * scale) as i32).max(1));
        // Tauri sync commands run ON the main thread — dispatch-and-wait from
        // here self-deadlocks (froze the whole app). On the owner thread,
        // create directly; only genuinely-foreign threads dispatch.
        let child = if win_preview_child::on_owner_thread(parent as *mut _) {
            win_preview_child::create(parent as *mut _, px, py, pw, ph) as usize
        } else {
            let (tx, rx) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || {
                let child = win_preview_child::create(parent as *mut _, px, py, pw, ph);
                let _ = tx.send(child as usize);
            })
            .map_err(|e| EngineError::Other(format!("main-thread dispatch: {e}")))?;
            rx.recv_timeout(std::time::Duration::from_secs(3))
                .map_err(|_| EngineError::Other("preview child creation timed out".into()))?
        };
        if child == 0 {
            return Err(EngineError::Other(
                "preview child window creation failed".into(),
            ));
        }
        win_preview_child::CHILD.store(child, std::sync::atomic::Ordering::SeqCst);
        // Engine receives the child hwnd; w/h already in device pixels.
        state
            .live
            .attach_preview(child, 0.0, 0.0, pw as f64, ph as f64)
            .map_err(EngineError::Other)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, state, x, y, w, h);
        Err(EngineError::Other(
            "live preview is not supported on this platform yet".into(),
        ))
    }
}

/// Win32 preview child helpers — main-thread only (see live_attach_preview).
#[cfg(all(have_engine, target_os = "windows"))]
pub(crate) mod win_preview_child {
    use std::os::raw::c_void;
    use std::sync::atomic::AtomicUsize;
    pub static CHILD: AtomicUsize = AtomicUsize::new(0);
    const WS_CHILD: u32 = 0x4000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(
            ex: u32,
            class: *const u16,
            name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: *mut c_void,
            menu: *mut c_void,
            inst: *mut c_void,
            param: *mut c_void,
        ) -> *mut c_void;
        fn DestroyWindow(hwnd: *mut c_void) -> i32;
        fn SetWindowPos(
            hwnd: *mut c_void,
            after: *mut c_void,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            flags: u32,
        ) -> i32;
        fn GetWindow(hwnd: *mut c_void, cmd: u32) -> *mut c_void;
        fn GetWindowLongW(hwnd: *mut c_void, idx: i32) -> i32;
        fn SetWindowLongW(hwnd: *mut c_void, idx: i32, value: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
    }
    /// True when the calling thread owns `hwnd` (== the UI thread). Tauri runs
    /// sync commands ON the main thread, so dispatch-and-wait from a command
    /// self-deadlocks (the M-W6 freeze); when already on the owner thread,
    /// window ops must run directly.
    pub fn on_owner_thread(hwnd: *mut c_void) -> bool {
        unsafe { GetWindowThreadProcessId(hwnd, std::ptr::null_mut()) == GetCurrentThreadId() }
    }
    const GW_CHILD: u32 = 5;
    const GW_HWNDNEXT: u32 = 2;
    const GWL_STYLE: i32 = -16;
    const WS_CLIPSIBLINGS: i32 = 0x0400_0000;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOACTIVATE: u32 = 0x0010;
    pub fn create(parent: *mut c_void, x: i32, y: i32, w: i32, h: i32) -> *mut c_void {
        let class: Vec<u16> = "STATIC".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let child = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE,
                x,
                y,
                w,
                h,
                parent,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if child.is_null() {
                return child;
            }
            // Keep our child at the top of the sibling z-order. Do NOT mutate
            // the webview's styles (an earlier WS_CLIPSIBLINGS stamp on
            // WebView2's window broke its size/input alignment — the
            // "everything shifted right, clicks land nowhere" bug).
            SetWindowPos(
                child,
                std::ptr::null_mut(), // HWND_TOP
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            child
        }
    }
    pub fn move_to(hwnd: usize, x: i32, y: i32, w: i32, h: i32) {
        unsafe {
            SetWindowPos(hwnd as *mut c_void, std::ptr::null_mut(), x, y, w, h, 0);
        }
    }
    pub fn destroy(hwnd: usize) {
        unsafe {
            DestroyWindow(hwnd as *mut c_void);
        }
    }
}

#[tauri::command]
pub fn live_move_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> EngineResult<()> {
    #[cfg(all(have_engine, target_os = "windows"))]
    {
        use tauri::Manager;
        let child = win_preview_child::CHILD.load(std::sync::atomic::Ordering::SeqCst);
        if child != 0 {
            let scale = app
                .get_webview_window("main")
                .and_then(|win| win.scale_factor().ok())
                .unwrap_or(1.0);
            let (px, py) = ((x * scale) as i32, (y * scale) as i32);
            let (pw, ph) = (((w * scale) as i32).max(1), ((h * scale) as i32).max(1));
            if win_preview_child::on_owner_thread(child as *mut _) {
                win_preview_child::move_to(child, px, py, pw, ph);
            } else {
                let _ = app.run_on_main_thread(move || {
                    win_preview_child::move_to(child, px, py, pw, ph);
                });
            }
            return state
                .live
                .move_preview(0.0, 0.0, pw as f64, ph as f64)
                .map_err(EngineError::Other);
        }
    }
    #[cfg(not(all(have_engine, target_os = "windows")))]
    let _ = &app;
    state
        .live
        .move_preview(x, y, w, h)
        .map_err(EngineError::Other)
}

#[tauri::command]
pub fn live_detach_preview(app: tauri::AppHandle, state: State<'_, AppState>) -> EngineResult<()> {
    let result = state.live.detach_preview().map_err(EngineError::Other);
    #[cfg(all(have_engine, target_os = "windows"))]
    {
        let child = win_preview_child::CHILD.swap(0, std::sync::atomic::Ordering::SeqCst);
        if child != 0 {
            if win_preview_child::on_owner_thread(child as *mut _) {
                win_preview_child::destroy(child);
            } else {
                let _ = app.run_on_main_thread(move || win_preview_child::destroy(child));
            }
        }
    }
    #[cfg(not(all(have_engine, target_os = "windows")))]
    let _ = &app;
    result
}

#[tauri::command]
pub fn live_set_overlay(
    state: State<'_, AppState>,
    window_id: Option<u32>,
    color_key: bool,
) -> EngineResult<()> {
    state
        .live
        .set_overlay(window_id, color_key)
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
