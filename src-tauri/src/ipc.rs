//! Tauri commands — the IPC surface the webview renders from.
//! Tokens never cross this boundary: the UI passes a token in exactly
//! once (add_endpoint) and never reads one back.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
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
    /// Hosted workspace scope (connected endpoints); the brand switch keys on it.
    pub brand_slug: Option<String>,
    /// Derived, never stored: "boomin" when the endpoint carries a brand
    /// scope, "selfhost" otherwise. The ONE switch the UI keys Boomin-only
    /// surfaces (network rail, deals, room visibility) on — everything about
    /// making a show, guests included, is endpoint-agnostic.
    pub endpoint_kind: &'static str,
}

/// See `EndpointInfo::endpoint_kind`.
pub fn endpoint_kind_of(brand_slug: Option<&str>) -> &'static str {
    match brand_slug {
        Some(s) if !s.is_empty() => "boomin",
        _ => "selfhost",
    }
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
        "SELECT id, kind, name, base_url, created_at, brand_slug FROM endpoints ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let brand_slug: Option<String> = r.get(5)?;
            Ok(EndpointInfo {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                base_url: r.get(3)?,
                created_at: r.get(4)?,
                endpoint_kind: endpoint_kind_of(brand_slug.as_deref()),
                brand_slug,
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

/// Small durable app preferences (store.rs `prefs`): one string per key,
/// surviving reinstalls of the webview state — the "never show this again"
/// kind of fact must not live in localStorage, which a cache clear empties.
#[tauri::command]
pub fn pref_get(state: State<'_, AppState>, key: String) -> EngineResult<Option<String>> {
    let conn = state.db.lock().expect("db mutex poisoned");
    let v = conn
        .query_row(
            "SELECT value FROM prefs WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .ok();
    Ok(v)
}

/// `value: null` deletes the key.
#[tauri::command]
pub fn pref_set(
    state: State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> EngineResult<()> {
    let conn = state.db.lock().expect("db mutex poisoned");
    match value {
        Some(v) => {
            conn.execute(
                "INSERT INTO prefs (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, v],
            )?;
        }
        None => {
            conn.execute("DELETE FROM prefs WHERE key = ?1", params![key])?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn endpoint_channels(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .list_channels()
        .await
}

/// Connected-mode sign-in, step 1: ask Boomin to email a code.
#[tauri::command]
pub async fn boomin_request_otp(api_root: Option<String>, email: String) -> EngineResult<()> {
    let root = api_root.unwrap_or_else(|| boomin::DEFAULT_BOOMIN_API_ROOT.to_string());
    boomin::request_otp(&root, &email).await
}

/// Connected-mode sign-in, step 2: verify the code. If the account has one
/// workspace, connect immediately; with several, hold the token engine-side
/// (AppState.pending_auth — it never crosses to the webview) and hand the
/// UI a workspace list to pick from (finish via boomin_select_brand).
#[tauri::command]
pub async fn boomin_connect(
    state: State<'_, AppState>,
    api_root: Option<String>,
    email: String,
    code: String,
) -> EngineResult<Value> {
    let root = api_root.unwrap_or_else(|| boomin::DEFAULT_BOOMIN_API_ROOT.to_string());
    let token = boomin::verify_otp(&root, &email, &code).await?;
    let brands = boomin::list_brands(&root, &token).await?;
    match brands.len() {
        0 => Err(EngineError::Other(
            "this account has no workspace yet — create one in the Boomin web app first".into(),
        )),
        1 => finalize_boomin_endpoint(&state, &root, &token, &brands[0].0).await,
        _ => {
            *state.pending_auth.lock().expect("auth mutex poisoned") = Some((root, token));
            Ok(json!({
                "needs_brand": true,
                "brands": brands
                    .iter()
                    .map(|(slug, name)| json!({ "slug": slug, "name": name }))
                    .collect::<Vec<_>>(),
            }))
        }
    }
}

/// Connected-mode sign-in, step 3 (multi-workspace accounts): bind the held
/// token to the chosen workspace and connect the endpoint.
#[tauri::command]
pub async fn boomin_select_brand(
    state: State<'_, AppState>,
    brand_slug: String,
) -> EngineResult<Value> {
    let pending = state
        .pending_auth
        .lock()
        .expect("auth mutex poisoned")
        .clone();
    let Some((root, token)) = pending else {
        return Err(EngineError::Other(
            "the sign-in session expired — start over".into(),
        ));
    };
    let result = finalize_boomin_endpoint(&state, &root, &token, &brand_slug).await?;
    *state.pending_auth.lock().expect("auth mutex poisoned") = None;
    Ok(result)
}

async fn finalize_boomin_endpoint(
    state: &State<'_, AppState>,
    api_root: &str,
    token: &str,
    brand_slug: &str,
) -> EngineResult<Value> {
    let base = boomin::producer_base_for_root(api_root);
    let session = ProducerClient::new(&base, token)
        .with_brand(Some(brand_slug.to_string()))
        .get_session()
        .await?;

    // Re-connecting an already-connected workspace refreshes its token
    // instead of minting a duplicate endpoint (a duplicate would list the
    // same channels twice and double-post).
    let existing: Option<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT id FROM endpoints WHERE base_url = ?1 AND brand_slug = ?2",
            params![base, brand_slug],
            |r| r.get(0),
        )
        .ok()
    };
    if let Some(existing_id) = existing {
        vault::set_token(&existing_id, token)?;
        return Ok(json!({ "id": existing_id, "session": session, "refreshed": true }));
    }

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
            "INSERT INTO endpoints (id, kind, name, base_url, brand_slug)
             VALUES (?1, 'connected', ?2, ?3, ?4)",
            params![id, name, base, brand_slug],
        )?;
    }
    vault::set_token(&id, token)?;
    Ok(json!({ "id": id, "session": session }))
}

/// Every brand this account can act in, from the hosted API — the same list
/// onboarding shows. Read live so a brand created on the web appears without
/// re-onboarding. Returns [{slug, name}].
#[tauri::command]
pub async fn boomin_list_brands(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Value> {
    let (base_url, _slug, token) = endpoint_access(&state, &endpoint_id)?;
    let root = api_root_of(&base_url);
    let brands = boomin::list_brands(&root, &token).await?;
    Ok(json!({
        "brands": brands
            .into_iter()
            .map(|(slug, name)| json!({ "slug": slug, "name": name }))
            .collect::<Vec<_>>()
    }))
}

/// Bind another brand of the SAME account as its own workspace: the token is
/// user-scoped, so the new endpoint reuses it with a different brandSlug.
/// Idempotent — re-binding an existing (base_url, brand_slug) refreshes it.
#[tauri::command]
pub async fn boomin_add_brand(
    state: State<'_, AppState>,
    endpoint_id: String,
    brand_slug: String,
) -> EngineResult<Value> {
    let (base_url, _slug, token) = endpoint_access(&state, &endpoint_id)?;
    let root = api_root_of(&base_url);
    finalize_boomin_endpoint(&state, &root, &token, &brand_slug).await
}

/// The API origin an endpoint's producer base was derived from (see
/// boomin::producer_base_for_root): everything before "/v1/".
fn api_root_of(base_url: &str) -> String {
    match base_url.find("/v1/") {
        Some(i) => base_url[..i].to_string(),
        None => base_url.trim_end_matches('/').to_string(),
    }
}

/// Load an endpoint's connection details (base URL, hosted workspace scope,
/// keychain token).
fn endpoint_access(
    state: &State<'_, AppState>,
    endpoint_id: &str,
) -> EngineResult<(String, Option<String>, String)> {
    let (base_url, brand_slug): (String, Option<String>) = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT base_url, brand_slug FROM endpoints WHERE id = ?1",
            params![endpoint_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?
    };
    let token = vault::get_token(endpoint_id)?;
    Ok((base_url, brand_slug, token))
}

/// Begin channel authorization on an endpoint — returns the browser URL a
/// human completes (the endpoint enforces primary-token-only).
/// Register a local room server-side (idempotent by external_ref).
#[tauri::command]
pub async fn room_register(
    state: State<'_, AppState>,
    endpoint_id: String,
    title: String,
    external_ref: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .register_room(&title, &external_ref)
        .await
}

/// The brand's server rooms, for Home's reconcile (see src/lib/roomSync.ts).
#[tauri::command]
pub async fn room_list_server(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .list_rooms()
        .await
}

/// Push a local rename to the server room (server id, not the local one).
#[tauri::command]
pub async fn room_set_title(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    title: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_set_title(&room_id, &title)
        .await
}

/// Delete the server room (server id). See `ProducerClient::delete_room`
/// for the refused-vs-failed split the app relies on.
#[tauri::command]
pub async fn room_delete(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .delete_room(&room_id)
        .await
}

#[tauri::command]
pub async fn room_guest_admit(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    guest_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .admit_guest(&room_id, &guest_id)
        .await
}

#[tauri::command]
pub async fn room_guest_revoke(
    state: State<'_, AppState>,
    endpoint_id: String,
    guest_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .revoke_guest(&guest_id)
        .await
}

#[tauri::command]
pub async fn room_set_stage(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    on_stage: Vec<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .set_stage(&room_id, &on_stage)
        .await
}

#[tauri::command]
pub async fn room_guests(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_guests(&room_id)
        .await
}

#[tauri::command]
pub async fn room_access(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_access(&room_id)
        .await
}

#[tauri::command]
pub async fn room_mod_link(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    display_name: Option<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_mod_link(&room_id, display_name.as_deref())
        .await
}

#[tauri::command]
pub async fn room_control_session(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_control_session(&room_id)
        .await
}

#[tauri::command]
pub async fn room_contributions(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    run_id: Option<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_contributions(&room_id, run_id.as_deref())
        .await
}

#[tauri::command]
pub async fn room_run(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    action: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_run(&room_id, &action)
        .await
}

#[tauri::command]
pub async fn room_overlay(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    source_id: String,
    binding: Value,
    shown: bool,
    label: Option<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_overlay(&room_id, &source_id, &binding, shown, label.as_deref())
        .await
}

#[tauri::command]
pub async fn room_interactions(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_interactions(&room_id)
        .await
}

#[tauri::command]
pub async fn room_interaction_create(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    body: Value,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_interaction_create(&room_id, &body)
        .await
}

#[tauri::command]
pub async fn room_interaction_transition(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    interaction_id: String,
    transition: String,
    reveal_hold_ms: Option<u64>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_interaction_transition(&room_id, &interaction_id, &transition, reveal_hold_ms)
        .await
}

#[tauri::command]
pub async fn room_audience_link(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    rotate: bool,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_audience_link(&room_id, rotate)
        .await
}

#[tauri::command]
pub async fn room_guest_order(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    order: Vec<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_guest_order(&room_id, &order)
        .await
}

#[tauri::command]
pub async fn room_join_link(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_join_link(&room_id)
        .await
}

/// Invite a guest to a room; returns {guest, invite_url, render_url}.
#[tauri::command]
pub async fn room_guest_invite(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    guest_brand_id: Option<String>,
    display_name: Option<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    let res = ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .invite_room_guest(&room_id, guest_brand_id, display_name)
        .await;
    if let Ok(v) = &res {
        // The invite link is issued once. Log its shape so a renamed field
        // can never silently cost a real link again.
        eprintln!(
            "[guest] invite response keys: {:?}",
            v.as_object().map(|o| o.keys().collect::<Vec<_>>())
        );
    }
    res
}

#[tauri::command]
pub async fn network_connections(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_connections()
        .await
}

#[tauri::command]
pub async fn network_status(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_status()
        .await
}

#[tauri::command]
pub async fn network_invitations(
    state: State<'_, AppState>,
    endpoint_id: String,
    direction: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_invitations(&direction)
        .await
}

#[tauri::command]
pub async fn network_invite(
    state: State<'_, AppState>,
    endpoint_id: String,
    to_slug: String,
    message: Option<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_invite(&to_slug, message)
        .await
}

#[tauri::command]
pub async fn network_invite_email(
    state: State<'_, AppState>,
    endpoint_id: String,
    to_email: String,
    message: Option<String>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_invite_email(&to_email, message)
        .await
}

#[tauri::command]
pub async fn network_invitation_action(
    state: State<'_, AppState>,
    endpoint_id: String,
    id: String,
    action: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_invitation_action(&id, &action)
        .await
}

/// Everything the webview needs to mount the server's settings console in
/// one round trip: whether the server advertises one (self-hosted servers
/// don't — the open-source app bundles no Boomin UI), and a fresh one-time
/// handoff code. The keychain token stays here.
#[tauri::command]
pub async fn console_open(state: State<'_, AppState>, endpoint_id: String) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    let client = ProducerClient::new(&base_url, &token).with_brand(brand_slug.clone());
    let session = client.get_session().await?;
    let console = session
        .server
        .get("console")
        .cloned()
        .unwrap_or(Value::Null);
    if console.is_null() {
        return Ok(
            serde_json::json!({ "console": Value::Null, "handoff": Value::Null, "brand_slug": brand_slug }),
        );
    }
    let handoff = client.auth_handoff(brand_slug.as_deref()).await?;
    Ok(serde_json::json!({ "console": console, "handoff": handoff, "brand_slug": brand_slug }))
}

#[tauri::command]
pub async fn network_lookup(
    state: State<'_, AppState>,
    endpoint_id: String,
    slug: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_lookup(&slug)
        .await
}

#[tauri::command]
pub async fn network_live_rooms(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_live_rooms()
        .await
}

/// Knock on a visible open stage. Returns the seat (`join_url`, `resumed`)
/// plus `api_base` and `producer_cam` — see `network_deal_enter`.
#[tauri::command]
pub async fn network_enter_room(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    let res = ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_enter_room(&room_id)
        .await?;
    Ok(seat_result(
        res,
        &base_url,
        state.live.set_virtual_cam(true).is_ok(),
    ))
}

/// The seat a knock returns, completed for the native guest seat: the API
/// the invite code is a credential for, and whether Producer's scene is the
/// camera (the virtual camera started) this time.
fn seat_result(mut res: Value, base_url: &str, producer_cam: bool) -> Value {
    if let Some(o) = res.as_object_mut() {
        o.insert("api_base".into(), Value::String(base_url.to_string()));
        o.insert("producer_cam".into(), Value::Bool(producer_cam));
    }
    res
}

#[tauri::command]
pub async fn network_deals(state: State<'_, AppState>, endpoint_id: String) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_deals()
        .await
}

#[tauri::command]
pub async fn network_propose_deal(
    state: State<'_, AppState>,
    endpoint_id: String,
    connection_id: String,
    beneficiary_brand_id: String,
    room_id: String,
    title: String,
    amount_cents: u64,
    min_stage_minutes: Option<u32>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_propose_deal(
            &connection_id,
            &beneficiary_brand_id,
            &room_id,
            &title,
            amount_cents,
            min_stage_minutes,
        )
        .await
}

#[tauri::command]
pub async fn network_deal_action(
    state: State<'_, AppState>,
    endpoint_id: String,
    id: String,
    action: String,
) -> EngineResult<Value> {
    if !matches!(action.as_str(), "accept" | "decline" | "cancel") {
        return Err(EngineError::Other("unsupported deal action".into()));
    }
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_deal_action(&id, &action)
        .await
}

/// Enter a funded (or free) deal's show from Producer as the BENEFICIARY.
/// Knocks through the deal via the API (so the host admitting us settles
/// it) and returns the seat: `join_url` (its invite code is the seat's
/// credential), `resumed`, `api_base` and `producer_cam`. No browser and no
/// window — the UI opens a room in guest mode and runs the guest half of
/// the call natively (src/lib/guestSeat.ts). Producer IS the guest's camera:
/// the scene goes out through the virtual camera and the seat prefers that
/// device. No driver or no engine → the seat falls back to a real webcam.
#[tauri::command]
pub async fn network_deal_enter(
    state: State<'_, AppState>,
    endpoint_id: String,
    deal_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    let res = ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_deal_enter(&deal_id)
        .await?;
    if res.get("join_url").and_then(Value::as_str).is_none() {
        return Err(EngineError::Other("enter returned no join_url".into()));
    }
    Ok(seat_result(
        res,
        &base_url,
        state.live.set_virtual_cam(true).is_ok(),
    ))
}

/// The room's mount timings, written beside the engine report so a room
/// open can be read off disk (engine → applied → settled → veil, plus the
/// boot phases) — the ruler every speedup is measured against.
#[tauri::command]
pub async fn live_room_open_report(app: AppHandle, report: Value) -> EngineResult<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| EngineError::Other(e.to_string()))?
        .join("live");
    let _ = std::fs::create_dir_all(&dir);
    let json = serde_json::to_string_pretty(&report).unwrap_or_default();
    std::fs::write(dir.join("room-open-report.json"), json)
        .map_err(|e| EngineError::Other(e.to_string()))
}

#[tauri::command]
pub async fn room_set_visibility(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
    visibility: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_set_visibility(&room_id, &visibility)
        .await
}

#[tauri::command]
pub async fn room_set_default(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .room_set_default(&room_id)
        .await
}

/// Join the Brand Network for a connected endpoint's brand.
#[tauri::command]
pub async fn network_join(
    state: State<'_, AppState>,
    endpoint_id: String,
    rejoin: Option<bool>,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .network_join(rejoin.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn connect_channel(
    state: State<'_, AppState>,
    endpoint_id: String,
    platform: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .create_connect_session(&platform)
        .await
}

#[tauri::command]
pub async fn disconnect_channel(
    state: State<'_, AppState>,
    endpoint_id: String,
    channel_id: String,
) -> EngineResult<Value> {
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .disconnect_channel(&channel_id)
        .await
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

    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    let client = ProducerClient::new(&base_url, &token).with_brand(brand_slug);
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
    let (base_url, brand_slug, token) = endpoint_access(&state, &endpoint_id)?;
    ProducerClient::new(&base_url, &token)
        .with_brand(brand_slug)
        .list_jobs(50)
        .await
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
