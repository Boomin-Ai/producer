//! Local-only rolling clips. Enabling capture and saving a file are explicit
//! host actions; neither the panel nor a stored preference starts capture.
use crate::{
    error::{EngineError, EngineResult},
    AppState,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{OnceLock, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ClipOutput {
    #[default]
    Landscape,
    Portrait,
    Both,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClipSettings {
    pub seconds: u32,
    pub memory_mb: u32,
    pub output: ClipOutput,
}
impl Default for ClipSettings {
    fn default() -> Self {
        Self {
            seconds: 60,
            memory_mb: 256,
            output: ClipOutput::Landscape,
        }
    }
}
impl ClipSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=600).contains(&self.seconds) {
            return Err("Choose a buffer between 1 and 600 seconds".into());
        }
        if !(64..=1024).contains(&self.memory_mb) {
            return Err("Choose a buffer memory budget between 64 and 1024 MB".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Default)]
pub struct ClipTrackStatus {
    pub output: ClipOutput,
    pub captured_frames: u64,
    pub encoded_frames: u32,
    pub input_frames: u32,
    pub input_skipped_frames: u32,
    pub video_active: bool,
    pub audio_active: bool,
}
#[derive(Debug, Clone, Serialize, Default)]
pub struct ClipStatus {
    pub enabled: bool,
    pub saving: bool,
    pub room_id: Option<String>,
    pub settings: ClipSettings,
    pub elapsed_seconds: u64,
    pub video_frames: u64,
    pub tracks: Vec<ClipTrackStatus>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipFile {
    pub path: String,
    pub output: ClipOutput,
    #[serde(default)]
    pub duration_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClipAction {
    Status,
    Enable { settings: ClipSettings },
    Disable,
    Save { job_id: String, directory: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipRequest {
    pub room_id: String,
    #[serde(flatten)]
    pub action: ClipAction,
}

static DIRECTORY: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
fn directory_setting() -> &'static RwLock<Option<PathBuf>> {
    DIRECTORY.get_or_init(|| RwLock::new(None))
}
pub fn default_directory() -> PathBuf {
    let home = std::env::var(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(if cfg!(target_os = "windows") {
            "Videos"
        } else {
            "Movies"
        })
        .join("Producer")
}
pub fn directory() -> PathBuf {
    directory_setting()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(default_directory)
}
pub fn init(db: &rusqlite::Connection) -> EngineResult<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS local_clips(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,created_ms INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('saving','ready','failed')),requested_seconds INTEGER NOT NULL,files_json TEXT NOT NULL DEFAULT '[]',error TEXT);CREATE INDEX IF NOT EXISTS local_clips_room_time ON local_clips(room_id,created_ms DESC);")?;
    db.execute("UPDATE local_clips SET status='failed',error='Producer closed before this clip was confirmed. Check the recording folder for a recovered file.' WHERE status='saving'",[])?;
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM prefs WHERE key='recording.directory'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(value) = value {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            *directory_setting()
                .write()
                .unwrap_or_else(|e| e.into_inner()) = Some(path);
        }
    }
    Ok(())
}
pub fn writable_directory() -> Result<PathBuf, String> {
    let path = directory();
    // Create the normal default on demand. A user-selected folder must still
    // exist: never recreate an unmounted /Volumes path on the internal disk.
    if directory_setting()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .is_none()
        && !path.is_symlink()
    {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    let path = path.canonicalize().map_err(|_| {
        "The recording folder is unavailable. Connect the drive or choose another folder."
            .to_string()
    })?;
    if !path.is_dir() {
        return Err("Choose a recording folder".into());
    }
    let probe = path.join(format!(".producer-write-{}", uuid::Uuid::new_v4()));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| {
            "Producer cannot write to the recording folder. Choose another folder.".to_string()
        })?;
    drop(file);
    std::fs::remove_file(probe).map_err(|e| e.to_string())?;
    Ok(path)
}
async fn apply(state: &AppState, request: ClipRequest) -> EngineResult<Value> {
    let dispatch = state.live.clips_dispatch().map_err(EngineError::Other)?;
    tauri::async_runtime::spawn_blocking(move || dispatch(request))
        .await
        .map_err(|e| EngineError::Other(e.to_string()))?
        .map_err(EngineError::Other)
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
#[tauri::command]
pub async fn clips_status(state: State<'_, AppState>, room_id: String) -> EngineResult<Value> {
    let status = apply(
        &state,
        ClipRequest {
            room_id,
            action: ClipAction::Status,
        },
    )
    .await?;
    Ok(
        json!({"capture":status,"directory":directory().canonicalize().unwrap_or_else(|_|directory()).to_string_lossy()}),
    )
}
#[tauri::command]
pub async fn clips_enable(
    state: State<'_, AppState>,
    room_id: String,
    settings: ClipSettings,
) -> EngineResult<Value> {
    settings.validate().map_err(EngineError::Other)?;
    writable_directory().map_err(EngineError::Other)?;
    apply(
        &state,
        ClipRequest {
            room_id,
            action: ClipAction::Enable { settings },
        },
    )
    .await
}
#[tauri::command]
pub async fn clips_disable(state: State<'_, AppState>, room_id: String) -> EngineResult<Value> {
    apply(
        &state,
        ClipRequest {
            room_id,
            action: ClipAction::Disable,
        },
    )
    .await
}
#[tauri::command]
pub async fn clips_save(state: State<'_, AppState>, room_id: String) -> EngineResult<Value> {
    let directory = writable_directory().map_err(EngineError::Other)?;
    let status = apply(
        &state,
        ClipRequest {
            room_id: room_id.clone(),
            action: ClipAction::Status,
        },
    )
    .await?;
    if status["enabled"] != true || status["saving"] == true {
        return Err(EngineError::Other(
            "Enable rolling capture and wait for the current save to finish".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    {
        let db = state.db.lock().unwrap();
        db.execute("INSERT INTO local_clips(id,room_id,created_ms,status,requested_seconds) VALUES(?1,?2,?3,'saving',?4)",params![id,room_id,now_ms(),status["settings"]["seconds"].as_u64().unwrap_or(60)])?;
    }
    let request = ClipRequest {
        room_id: room_id.clone(),
        action: ClipAction::Save {
            job_id: id.clone(),
            directory: directory.to_string_lossy().into_owned(),
        },
    };
    let result = apply(&state, request).await.and_then(|value| {
        let files: Vec<ClipFile> = serde_json::from_value(value["files"].clone())
            .map_err(|e| EngineError::Other(e.to_string()))?;
        if files.is_empty() || files.len() > 2 {
            return Err(EngineError::Other(
                "The clip writer returned no confirmed output files".into(),
            ));
        }
        Ok(files)
    });
    let db = state.db.lock().unwrap();
    match result {
        Ok(mut files) => {
            let registered = (|| -> EngineResult<()> {
                let tx = db.unchecked_transaction()?;
                for file in &mut files {
                    let path = std::path::Path::new(&file.path);
                    crate::recordings::validate_mp4(path).map_err(EngineError::Other)?;
                    file.duration_ms =
                        crate::clips_media::duration_ms(path).map_err(EngineError::Other)?;
                    crate::recordings::begin(&tx, &file.path, Some(&room_id))?;
                    crate::recordings::finish(&tx, &file.path)?;
                    tx.execute("UPDATE local_recordings SET duration_ms=?2,started_ms=?3,started_at=strftime('%Y-%m-%dT%H:%M:%fZ',?3/1000.0,'unixepoch') WHERE path=?1",params![file.path,file.duration_ms,now_ms()-file.duration_ms])?;
                }
                tx.commit()?;
                Ok(())
            })();
            if let Err(error) = registered {
                db.execute(
                    "UPDATE local_clips SET status='failed',files_json=?2,error=?3 WHERE id=?1",
                    params![
                        id,
                        serde_json::to_string(&files)
                            .map_err(|e| EngineError::Other(e.to_string()))?,
                        error.to_string()
                    ],
                )?;
                return Err(error);
            }
            db.execute(
                "UPDATE local_clips SET status='ready',files_json=?2 WHERE id=?1",
                params![
                    id,
                    serde_json::to_string(&files).map_err(|e| EngineError::Other(e.to_string()))?
                ],
            )?;
            Ok(json!({"id":id,"files":files}))
        }
        Err(error) => {
            db.execute(
                "UPDATE local_clips SET status='failed',error=?2 WHERE id=?1",
                params![id, error.to_string()],
            )?;
            Err(error)
        }
    }
}
#[tauri::command]
pub fn clips_list(state: State<'_, AppState>, room_id: String) -> EngineResult<Value> {
    let db = state.db.lock().unwrap();
    let mut q=db.prepare("SELECT id,created_ms,status,requested_seconds,files_json,error FROM local_clips WHERE room_id=?1 ORDER BY created_ms DESC LIMIT 50")?;
    let rows=q.query_map(params![room_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"created_ms":r.get::<_,i64>(1)?,"status":r.get::<_,String>(2)?,"requested_seconds":r.get::<_,i64>(3)?,"files":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!([])),"error":r.get::<_,Option<String>>(5)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}
#[tauri::command]
pub async fn clips_pick_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> EngineResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("Save Producer recordings and clips")
        .pick_folder(move |picked| {
            let _ = tx.blocking_send(picked.and_then(|p| p.into_path().ok()));
        });
    let Some(path) = rx.recv().await.flatten() else {
        return Ok(None);
    };
    let path = path
        .canonicalize()
        .map_err(|e| EngineError::Other(e.to_string()))?;
    let probe = path.join(format!(".producer-write-{}", uuid::Uuid::new_v4()));
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| EngineError::Other("Producer cannot write to this folder".into()))?;
    drop(f);
    std::fs::remove_file(probe).map_err(|e| EngineError::Other(e.to_string()))?;
    state.db.lock().unwrap().execute("INSERT INTO prefs(key,value) VALUES('recording.directory',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![path.to_string_lossy()])?;
    *directory_setting()
        .write()
        .unwrap_or_else(|e| e.into_inner()) = Some(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_are_enforced() {
        let mut s = ClipSettings::default();
        assert!(s.validate().is_ok());
        for n in [0, 601, u32::MAX] {
            s.seconds = n;
            assert!(s.validate().is_err())
        }
        s.seconds = 60;
        for n in [0, 63, 1025, u32::MAX] {
            s.memory_mb = n;
            assert!(s.validate().is_err())
        }
    }
    #[test]
    fn request_has_flat_action() {
        let r:ClipRequest=serde_json::from_value(json!({"room_id":"r","action":"enable","settings":{"seconds":30,"memory_mb":128,"output":"both"}})).unwrap();
        assert!(matches!(r.action, ClipAction::Enable { .. }));
    }
}
