//! Durable recording provenance. Media never uploads implicitly.
use crate::{
    client::ProducerClient,
    error::{EngineError, EngineResult},
    vault, AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct Recording {
    pub id: String,
    pub endpoint_id: Option<String>,
    pub room_id: String,
    pub room_name: String,
    pub source_room_id: Option<String>,
    pub path: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: i64,
    pub file_size: i64,
    pub status: String,
    pub collection_id: Option<String>,
    pub unit_id: Option<String>,
    pub sync_error: Option<String>,
}
const COLUMNS: &str = "id,endpoint_id,room_id,room_name,source_room_id,path,started_at,ended_at,duration_ms,file_size,status,collection_id,unit_id,sync_error";
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Recording> {
    Ok(Recording {
        id: r.get(0)?,
        endpoint_id: r.get(1)?,
        room_id: r.get(2)?,
        room_name: r.get(3)?,
        source_room_id: r.get(4)?,
        path: r.get(5)?,
        started_at: r.get(6)?,
        ended_at: r.get(7)?,
        duration_ms: r.get(8)?,
        file_size: r.get(9)?,
        status: r.get(10)?,
        collection_id: r.get(11)?,
        unit_id: r.get(12)?,
        sync_error: r.get(13)?,
    })
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn begin(db: &Connection, path: &str, room_id: Option<&str>) -> EngineResult<()> {
    let (room, name, endpoint, server): (String, String, Option<String>, Option<String>) =
        if let Some(id) = room_id {
            db.query_row(
                "SELECT id,name,endpoint_id,config FROM live_rooms WHERE id=?1",
                params![id],
                |r| {
                    let config: String = r.get(3)?;
                    let server = serde_json::from_str::<Value>(&config)
                        .ok()
                        .and_then(|v| v["server_room_id"].as_str().map(str::to_owned));
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, server))
                },
            )?
        } else {
            (Uuid::nil().to_string(), "Room".into(), None, None)
        };
    db.execute("INSERT INTO local_recordings(id,room_id,room_name,endpoint_id,source_room_id,path,started_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![Uuid::new_v4().to_string(),room,name,endpoint,server,path,now_ms()])?;
    Ok(())
}
/// Check the container index before advertising a recording as playable.
/// Seek over media data: even a multi-hour recording needs only a few header reads.
pub fn validate_mp4(path: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let (mut offset, mut movie, mut media, mut format) = (0u64, false, false, false);
    while offset < len {
        if len - offset < 8 {
            return Err("Recording has a truncated MP4 header.".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        let short = u32::from_be_bytes(header[..4].try_into().unwrap());
        let (size, header_len) = match short {
            0 => (len - offset, 8),
            1 => {
                let mut extended = [0u8; 8];
                file.read_exact(&mut extended).map_err(|e| e.to_string())?;
                (u64::from_be_bytes(extended), 16)
            }
            n => (n as u64, 8),
        };
        if size < header_len || size > len - offset {
            return Err("Recording has an incomplete MP4 box.".into());
        }
        match &header[4..] {
            b"ftyp" => format = size > header_len,
            b"moov" => movie = size > header_len,
            b"mdat" => media |= size > header_len,
            _ => {}
        }
        offset += size;
    }
    if format && movie && media {
        Ok(())
    } else {
        Err(
            "Recording did not finish its MP4 container. The original file is kept for recovery."
                .into(),
        )
    }
}

pub fn finish(db: &Connection, path: &str) -> EngineResult<()> {
    if let Err(message) = validate_mp4(std::path::Path::new(path)) {
        db.execute("UPDATE local_recordings SET status='interrupted', sync_error=?2 WHERE path=?1 AND status='recording'", params![path, message])?;
        return Err(EngineError::Other(message));
    }
    let size = std::fs::metadata(path)
        .map_err(|e| EngineError::Other(format!("Could not read the saved recording: {e}")))?
        .len() as i64;
    db.execute("UPDATE local_recordings SET status='ready', ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), duration_ms=MAX(0,?2-started_ms), file_size=?3 WHERE path=?1 AND status='recording'", params![path,now_ms(),size])?;
    Ok(())
}
pub fn recover(db: &Connection) -> EngineResult<()> {
    // A crashed muxer is not silently advertised as a playable recording.
    db.execute("UPDATE local_recordings SET status='interrupted', sync_error='Recording was interrupted before it finished.' WHERE status='recording'", [])?;
    Ok(())
}
#[tauri::command]
pub fn recordings_list(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Vec<Recording>> {
    let db = state.db.lock().unwrap();
    let mut query = db.prepare(&format!(
        "SELECT {COLUMNS} FROM local_recordings WHERE endpoint_id=?1 ORDER BY started_at DESC"
    ))?;
    let rows = query
        .query_map(params![endpoint_id], row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
#[tauri::command]
pub async fn recordings_sync(state: State<'_, AppState>, endpoint_id: String) -> EngineResult<()> {
    let (base, brand, pending) = {
        let db = state.db.lock().unwrap();
        let (base, brand): (String, Option<String>) = db.query_row(
            "SELECT base_url,brand_slug FROM endpoints WHERE id=?1",
            params![endpoint_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if brand.is_none() {
            return Ok(());
        } // Independent endpoint keeps local captures.
        let mut query=db.prepare(&format!("SELECT {COLUMNS} FROM local_recordings WHERE endpoint_id=?1 AND status='ready' AND unit_id IS NULL"))?;
        let pending = query
            .query_map(params![endpoint_id], row)?
            .collect::<Result<Vec<_>, _>>()?;
        (base, brand, pending)
    };
    if pending.is_empty() {
        return Ok(());
    }
    let token = vault::get_token(&endpoint_id)?;
    let client = ProducerClient::new(&base, &token).with_brand(brand);
    let mut failed = false;
    for recording in pending {
        let response=client.access_request("POST","/v1/app/content/recordings",Some(json!({
            "capture_id":recording.id,"local_room_id":recording.room_id,"source_room_id":recording.source_room_id,
            "room_name":recording.room_name,"started_at":recording.started_at,"ended_at":recording.ended_at,
            "duration_ms":recording.duration_ms,"file_size":recording.file_size
        }))).await;
        let db = state.db.lock().unwrap();
        match response {
            Ok(value) if value["body"]["recording"]["unit_id"].is_string() => {
                let result = &value["body"]["recording"];
                db.execute("UPDATE local_recordings SET unit_id=?2,collection_id=?3,sync_error=NULL WHERE id=?1 AND endpoint_id=?4",params![recording.id,result["unit_id"].as_str(),result["collection_id"].as_str(),endpoint_id])?;
            }
            result => {
                failed = true;
                let message = match result {
                    Err(e) => e.to_string(),
                    _ => "Boomin recording registration is unavailable. The file is saved locally."
                        .into(),
                };
                db.execute(
                    "UPDATE local_recordings SET sync_error=?2 WHERE id=?1",
                    params![recording.id, message],
                )?;
            }
        }
    }
    if failed {
        return Err(EngineError::Other(
            "Some recordings are saved locally and still need to sync.".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn recording_by_path(
    state: State<'_, AppState>,
    path: String,
) -> EngineResult<Option<Recording>> {
    let db = state.db.lock().unwrap();
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS} FROM local_recordings WHERE path=?1"),
            params![path],
            row,
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_keeps_room_workspace_and_survives_restart() {
        let db = crate::store::open_in_memory().unwrap();
        db.execute("INSERT INTO endpoints(id,kind,name,base_url) VALUES('endpoint','connected','Brand','https://example.com')", []).unwrap();
        db.execute("INSERT INTO live_rooms(id,name,endpoint_id,config) VALUES('room','My room','endpoint','{\"server_room_id\":\"server-room\"}')", []).unwrap();
        let path =
            std::env::temp_dir().join(format!("producer-capture-test-{}.mp4", Uuid::new_v4()));
        let mut bytes = Vec::new();
        for kind in [b"ftyp", b"mdat", b"moov"] {
            bytes.extend_from_slice(&9u32.to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.push(0);
        }
        std::fs::write(&path, &bytes).unwrap();
        let path_string = path.to_string_lossy();
        begin(&db, &path_string, Some("room")).unwrap();
        finish(&db, &path_string).unwrap();
        recover(&db).unwrap();
        let recording = db
            .query_row(&format!("SELECT {COLUMNS} FROM local_recordings"), [], row)
            .unwrap();
        assert_eq!(recording.endpoint_id.as_deref(), Some("endpoint"));
        assert_eq!(recording.source_room_id.as_deref(), Some("server-room"));
        assert_eq!(recording.status, "ready");
        assert_eq!(recording.file_size, 27);
        assert!(recording.ended_at.is_some());
        assert!(begin(&db, &path_string, Some("room")).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn missing_movie_index_is_interrupted_even_when_media_exists() {
        let db = crate::store::open_in_memory().unwrap();
        let path = std::env::temp_dir().join(format!("producer-unfinished-{}.mp4", Uuid::new_v4()));
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&9u32.to_be_bytes());
        bytes.extend_from_slice(b"ftypx");
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(b"mdatunfinished-media");
        std::fs::write(&path, bytes).unwrap();
        let p = path.to_string_lossy();
        begin(&db, &p, None).unwrap();
        assert!(finish(&db, &p).is_err());
        let recording = db
            .query_row(&format!("SELECT {COLUMNS} FROM local_recordings"), [], row)
            .unwrap();
        assert_eq!(recording.status, "interrupted");
        assert!(recording.sync_error.unwrap().contains("MP4 container"));
        assert!(path.exists());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unfinished_capture_is_not_promoted_to_ready() {
        let db = crate::store::open_in_memory().unwrap();
        begin(&db, "/tmp/unfinalized-capture.mp4", None).unwrap();
        recover(&db).unwrap();
        let recording = db
            .query_row(&format!("SELECT {COLUMNS} FROM local_recordings"), [], row)
            .unwrap();
        assert_eq!(recording.status, "interrupted");
        assert!(recording.unit_id.is_none());
    }
}
