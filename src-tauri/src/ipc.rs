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
use crate::{outbox, submit, vault, AppState};

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
    /// Stable public URL (media-by-URL). Upload-slot flow lands in M2.
    pub media_url: Option<String>,
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
    if input.text.as_deref().unwrap_or("").is_empty() && input.media_url.is_none() {
        return Err(EngineError::Other("a post needs text or media".into()));
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
