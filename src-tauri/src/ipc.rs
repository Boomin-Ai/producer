//! Tauri commands — the IPC surface the webview renders from.
//! Tokens never cross this boundary: the UI passes a token in exactly
//! once (add_endpoint) and never reads one back.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

use crate::client::ProducerClient;
use crate::error::{EngineError, EngineResult};
use crate::{boomin, outbox, submit, vault, AppState};

#[derive(Debug, Serialize)]
pub struct EndpointInfo {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub base_url: String,
    pub created_at: String,
}

fn normalize_base_url(raw: &str) -> EngineResult<String> {
    let base = raw.trim().trim_end_matches('/').to_string();
    if base.starts_with("http://") || base.starts_with("https://") {
        Ok(base)
    } else {
        Err(EngineError::Other(
            "endpoint URL must start with http:// or https://".into(),
        ))
    }
}

#[tauri::command]
pub fn list_endpoints(state: State<'_, AppState>) -> EngineResult<Vec<EndpointInfo>> {
    let conn = state.db.lock().expect("db mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, base_url, created_at FROM endpoints ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(EndpointInfo {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                base_url: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Validates the endpoint + token (GET /v1/session) before storing.
/// The token goes straight into the OS keychain, keyed by endpoint id.
#[tauri::command]
pub async fn add_endpoint(
    state: State<'_, AppState>,
    kind: String,
    name: String,
    base_url: String,
    token: String,
) -> EngineResult<Value> {
    if kind != "connected" && kind != "independent" {
        return Err(EngineError::Other(
            "kind must be 'connected' or 'independent'".into(),
        ));
    }
    let base = normalize_base_url(&base_url)?;
    let session = ProducerClient::new(&base, &token).get_session().await?;

    let id = Uuid::new_v4().to_string();
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.execute(
            "INSERT INTO endpoints (id, kind, name, base_url) VALUES (?1, ?2, ?3, ?4)",
            params![id, kind, name, base],
        )?;
    }
    vault::set_token(&id, &token)?;
    Ok(json!({ "id": id, "session": session }))
}

#[tauri::command]
pub fn remove_endpoint(state: State<'_, AppState>, endpoint_id: String) -> EngineResult<()> {
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.execute("DELETE FROM endpoints WHERE id = ?1", params![endpoint_id])?;
    }
    vault::delete_token(&endpoint_id)
}

#[tauri::command]
pub async fn endpoint_channels(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Value> {
    let base_url: String = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT base_url FROM endpoints WHERE id = ?1",
            params![endpoint_id],
            |r| r.get(0),
        )?
    };
    let token = vault::get_token(&endpoint_id)?;
    ProducerClient::new(&base_url, &token).list_channels().await
}

/// Connected-mode sign-in, step 1: ask Boomin to email a code.
#[tauri::command]
pub async fn boomin_request_otp(api_root: Option<String>, email: String) -> EngineResult<()> {
    let root = api_root.unwrap_or_else(|| boomin::DEFAULT_BOOMIN_API_ROOT.to_string());
    boomin::request_otp(&root, &email).await
}

/// Connected-mode sign-in, step 2: verify the code and connect the endpoint
/// in one motion — the session token flows straight into the keychain and
/// never crosses the IPC boundary back to the webview.
#[tauri::command]
pub async fn boomin_connect(
    state: State<'_, AppState>,
    api_root: Option<String>,
    email: String,
    code: String,
) -> EngineResult<Value> {
    let root = api_root.unwrap_or_else(|| boomin::DEFAULT_BOOMIN_API_ROOT.to_string());
    let token = boomin::verify_otp(&root, &email, &code).await?;
    let base = boomin::producer_base_for_root(&root);
    let session = ProducerClient::new(&base, &token).get_session().await?;

    let id = Uuid::new_v4().to_string();
    let name = session
        .account
        .as_ref()
        .and_then(|a| a.get("display_name"))
        .and_then(Value::as_str)
        .unwrap_or("Boomin")
        .to_string();
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.execute(
            "INSERT INTO endpoints (id, kind, name, base_url) VALUES (?1, 'connected', ?2, ?3)",
            params![id, name, base],
        )?;
    }
    vault::set_token(&id, &token)?;
    Ok(json!({ "id": id, "session": session }))
}

fn mime_for_path(path: &str) -> Option<(&'static str, &'static str)> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some(("image/jpeg", "image")),
        "png" => Some(("image/png", "image")),
        "webp" => Some(("image/webp", "image")),
        "gif" => Some(("image/gif", "image")),
        "mp4" => Some(("video/mp4", "video")),
        "mov" => Some(("video/quicktime", "video")),
        "webm" => Some(("video/webm", "video")),
        _ => None,
    }
}

/// Upload a local file through the endpoint's slot flow (contract §media):
/// request slot → PUT bytes to the presigned URL → durable upload_id. This
/// runs BEFORE the outbox intent is committed, per the frozen media rule.
#[tauri::command]
pub async fn upload_media(
    state: State<'_, AppState>,
    endpoint_id: String,
    file_path: String,
) -> EngineResult<Value> {
    let Some((mime, kind)) = mime_for_path(&file_path) else {
        return Err(EngineError::Other(
            "unsupported file type — use jpg, png, webp, gif, mp4, mov, or webm".into(),
        ));
    };
    let bytes = std::fs::read(&file_path)
        .map_err(|e| EngineError::Other(format!("could not read the file: {e}")))?;
    let filename = file_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("media")
        .to_string();

    let base_url: String = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT base_url FROM endpoints WHERE id = ?1",
            params![endpoint_id],
            |r| r.get(0),
        )?
    };
    let token = vault::get_token(&endpoint_id)?;
    let client = ProducerClient::new(&base_url, &token);
    let slot = client
        .create_upload(&filename, mime, bytes.len() as u64)
        .await?;
    let put_url = slot
        .get("put_url")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Other("the endpoint returned no upload URL".into()))?;
    let upload_id = slot
        .get("upload_id")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Other("the endpoint returned no upload id".into()))?
        .to_string();
    client.put_bytes(put_url, mime, bytes).await?;
    Ok(
        json!({ "upload_id": upload_id, "kind": kind, "filename": filename, "endpoint_id": endpoint_id }),
    )
}

#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>, endpoint_id: String) -> EngineResult<Value> {
    let base_url: String = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT base_url FROM endpoints WHERE id = ?1",
            params![endpoint_id],
            |r| r.get(0),
        )?
    };
    let token = vault::get_token(&endpoint_id)?;
    ProducerClient::new(&base_url, &token).list_jobs(50).await
}

#[derive(Debug, Deserialize)]
pub struct SubmitTarget {
    pub endpoint_id: String,
    pub channel_id: String,
    #[serde(default)]
    pub overrides: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SubmitPostInput {
    pub text: Option<String>,
    /// Stable public URL (media-by-URL) — valid across any endpoints.
    pub media_url: Option<String>,
    /// Durable upload reference from `upload_media` — endpoint-scoped, so
    /// every target must live on the same endpoint.
    pub media_upload_id: Option<String>,
    pub schedule_at: Option<String>,
    pub targets: Vec<SubmitTarget>,
}

/// Fan a draft out across targets: persist the immutable outbox intent
/// first, then drain it. Crash-safe from the moment this returns an
/// intent id.
#[tauri::command]
pub async fn submit_post(
    state: State<'_, AppState>,
    input: SubmitPostInput,
) -> EngineResult<Value> {
    if input.targets.is_empty() {
        return Err(EngineError::Other("select at least one channel".into()));
    }
    if input.text.as_deref().unwrap_or("").is_empty()
        && input.media_url.is_none()
        && input.media_upload_id.is_none()
    {
        return Err(EngineError::Other("a post needs text or media".into()));
    }
    if input.media_url.is_some() && input.media_upload_id.is_some() {
        return Err(EngineError::Other(
            "use a media URL or an upload, not both".into(),
        ));
    }
    if input.media_upload_id.is_some() {
        let first = &input.targets[0].endpoint_id;
        if !input.targets.iter().all(|t| &t.endpoint_id == first) {
            return Err(EngineError::Other(
                "an uploaded file belongs to one endpoint — targets on other endpoints need a media URL".into(),
            ));
        }
    }

    let intent_id = Uuid::new_v4().to_string();
    let targets: Vec<outbox::NewTarget> = input
        .targets
        .iter()
        .map(|t| {
            let mut req = json!({
                "channel_id": t.channel_id,
                "intent_id": intent_id,
            });
            if let Some(text) = &input.text {
                req["text"] = json!(text);
            }
            if let Some(url) = &input.media_url {
                req["media"] = json!([{ "url": url }]);
            }
            if let Some(upload_id) = &input.media_upload_id {
                req["media"] = json!([{ "upload_id": upload_id }]);
            }
            if let Some(at) = &input.schedule_at {
                req["schedule_at"] = json!(at);
            }
            if let Some(ov) = &t.overrides {
                req["overrides"] = ov.clone();
            }
            outbox::NewTarget {
                endpoint_id: t.endpoint_id.clone(),
                channel_id: t.channel_id.clone(),
                request_json: req.to_string(),
            }
        })
        .collect();

    {
        let mut conn = state.db.lock().expect("db mutex poisoned");
        outbox::create_intent(&mut conn, &intent_id, &targets)?;
    }

    let results = submit::submit_pending(&state.db, Some(&intent_id)).await?;
    Ok(json!({ "intent_id": intent_id, "results": results }))
}

#[tauri::command]
pub fn outbox_inspect(state: State<'_, AppState>) -> EngineResult<Vec<outbox::TargetRow>> {
    let conn = state.db.lock().expect("db mutex poisoned");
    outbox::all_targets(&conn)
}

/// Re-drain anything a crash left pending (also runs at startup).
#[tauri::command]
pub async fn resume_outbox(state: State<'_, AppState>) -> EngineResult<Value> {
    let results = submit::submit_pending(&state.db, None).await?;
    Ok(json!({ "results": results }))
}
