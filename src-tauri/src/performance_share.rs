//! Explicitly enrolled, account-scoped diagnostic sharing. Never contacts a
//! user-supplied host and never enables remote consent from a background task.
use crate::performance_trace::{self, TraceExport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const BASE: &str = "https://api.boomin.ai/v1/app/producer";
const MAX_BODY: usize = 64 * 1024;
const MAX_EVENTS: usize = 64;
const MAX_CHUNKS: usize = 4;
const MAX_SESSIONS: usize = 128;
const MAX_SPOOL: usize = 256 * 1024;
const MAX_CREDENTIAL_CONTEXT: usize = 256;
type CredentialProof = BTreeMap<String, String>;
struct CredentialContext {
    proof: CredentialProof,
    tokens: BTreeMap<String, String>,
}
#[derive(Default)]
struct UploadAuthority(AtomicU64);
impl UploadAuthority {
    fn pause(&self) -> u64 {
        let mut current = self.0.load(Ordering::Acquire);
        loop {
            let next = (current & !1).wrapping_add(2) | 1;
            match self
                .0
                .compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return next,
                Err(actual) => current = actual,
            }
        }
    }
    fn current(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
    fn paused(&self) -> bool {
        self.current() & 1 != 0
    }
    fn is_current(&self, ticket: u64) -> bool {
        self.current() == ticket
    }
    fn resume(&self, ticket: u64) -> bool {
        ticket & 1 != 0
            && self
                .0
                .compare_exchange(ticket, ticket & !1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
}
static UPLOAD_AUTHORITY: UploadAuthority = UploadAuthority(AtomicU64::new(0));

/// Consent revocation invalidates auth checks even before diagnostics are ready.
pub fn pause_for_consent_change() {
    UPLOAD_AUTHORITY.pause();
}
fn auth_verification_needed(sharing_status: Option<bool>) -> bool {
    sharing_status != Some(false)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    endpoint_id: String,
    installation_id: String,
    revision: u64,
    consent_scope_id: String,
    sessions: BTreeMap<String, f64>,
    context_salt: String,
    credential_context: CredentialProof,
}
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    at: f64,
    seq: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    session: String,
    body: Value,
    cursors: BTreeMap<String, Cursor>,
    count: usize,
}
#[derive(Clone, Default)]
struct Delivery {
    binding: Option<Binding>,
    cursors: BTreeMap<String, BTreeMap<String, Cursor>>,
    pending: Option<Pending>,
    pruned_sessions: u64,
    attempt_window: Option<Instant>,
    attempted_chunks: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spool {
    binding: Binding,
    cursors: BTreeMap<String, BTreeMap<String, Cursor>>,
    pending: Option<Pending>,
    pruned_sessions: u64,
}
struct Transport {
    client: reqwest::Client,
    path: PathBuf,
    data: Mutex<Delivery>,
    busy: AtomicBool,
    epoch: AtomicU64,
}
pub struct PerformanceShareState {
    ready: Arc<tokio::sync::OnceCell<Result<Arc<Transport>, String>>>,
}
impl PerformanceShareState {
    fn current(&self) -> Option<&Arc<Transport>> {
        self.ready.get()?.as_ref().ok()
    }
}
async fn ready_transport(app: &tauri::AppHandle) -> Result<Arc<Transport>, String> {
    // A persisted installation/consent snapshot is required before session
    // enrollment can be restored. Neither initializer blocks the app shell.
    performance_trace::ensure_ready(app).await?;
    let ready = app
        .try_state::<PerformanceShareState>()
        .ok_or("Diagnostic sharing unavailable")?
        .ready
        .clone();
    let handle = app.clone();
    performance_trace::initialize_once(&ready, move || initialize_transport(&handle)).await
}
async fn with_delivery<T: Send + 'static>(
    inner: Arc<Transport>,
    operation: impl FnOnce(&Transport, &mut Delivery) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut data = inner
            .data
            .lock()
            .map_err(|_| "Diagnostic delivery unavailable")?;
        operation(&inner, &mut data)
    })
    .await
    .map_err(|_| "Diagnostic delivery task failed".to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareReceipt {
    accepted: usize,
    available: bool,
}
struct Access {
    token: String,
    brand: Option<String>,
}
struct Busy(Arc<Transport>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}
fn acquire(inner: &Arc<Transport>) -> Option<Busy> {
    inner
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| Busy(inner.clone()))
}
fn valid_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
fn trusted_base(base: &str) -> bool {
    base.trim_end_matches('/') == BASE
}
fn context_from_credentials(
    salt: &str,
    credentials: impl IntoIterator<Item = Result<(String, String), String>>,
) -> Result<CredentialContext, String> {
    if !valid_uuid(salt) {
        return Err("Invalid diagnostic credential context".into());
    }
    let mut proof = BTreeMap::new();
    let mut tokens = BTreeMap::new();
    for entry in credentials {
        let (id, token) = entry?;
        if proof.len() >= MAX_CREDENTIAL_CONTEXT
            || !valid_uuid(&id)
            || token.is_empty()
            || token.len() > 16 * 1024
            || proof.contains_key(&id)
        {
            return Err("Diagnostic credential context unavailable".into());
        }
        let mut hash = Sha256::new();
        hash.update(b"producer.performance.credentials/1\0");
        hash.update(salt.as_bytes());
        hash.update([0]);
        hash.update(id.as_bytes());
        hash.update([0]);
        hash.update(token.as_bytes());
        proof.insert(id.clone(), format!("{:x}", hash.finalize()));
        tokens.insert(id, token);
    }
    Ok(CredentialContext { proof, tokens })
}
fn credential_context(app: &tauri::AppHandle, salt: &str) -> Result<CredentialContext, String> {
    let state = app
        .try_state::<crate::AppState>()
        .ok_or("Diagnostic credential context unavailable")?;
    let ids = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "Diagnostic credential context unavailable")?;
        let mut query=conn.prepare("SELECT id FROM endpoints WHERE rtrim(base_url, '/') = ?1 AND brand_slug IS NOT NULL AND brand_slug <> '' ORDER BY id LIMIT 257").map_err(|_|"Diagnostic credential context unavailable")?;
        let rows = query
            .query_map([BASE], |row| row.get::<_, String>(0))
            .map_err(|_| "Diagnostic credential context unavailable")?;
        let ids = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Diagnostic credential context unavailable")?;
        ids
    };
    if ids.len() > MAX_CREDENTIAL_CONTEXT {
        return Err("Diagnostic credential context limit reached".into());
    }
    context_from_credentials(
        salt,
        ids.into_iter().map(|id| {
            let (base, brand, token) = crate::ipc::endpoint_access(&state, &id)
                .map_err(|_| "Diagnostic credential context unavailable".to_string())?;
            if !trusted_base(&base) || brand.as_ref().is_none_or(|v| v.is_empty()) {
                return Err("Diagnostic credential context changed".into());
            }
            Ok((id, token))
        }),
    )
}
async fn credential_context_async(
    app: &tauri::AppHandle,
    salt: &str,
) -> Result<CredentialContext, String> {
    let handle = app.clone();
    let salt = salt.to_owned();
    tauri::async_runtime::spawn_blocking(move || credential_context(&handle, &salt))
        .await
        .map_err(|_| "Diagnostic credential context task failed".to_string())?
}
fn fresh_context_with(
    read: impl FnOnce(&str) -> Result<CredentialContext, String>,
) -> Result<(String, CredentialContext), String> {
    let salt = uuid::Uuid::new_v4().to_string();
    let context = read(&salt)?;
    Ok((salt, context))
}
async fn fresh_credential_context(
    app: &tauri::AppHandle,
) -> Result<(String, CredentialContext), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fresh_context_with(|salt| credential_context(&handle, salt))
    })
    .await
    .map_err(|_| "Diagnostic credential context task failed".to_string())?
}
fn changed_credentials(
    binding: &Binding,
    current: &CredentialProof,
) -> Result<Vec<String>, String> {
    if current.len() > MAX_CREDENTIAL_CONTEXT
        || !current.contains_key(&binding.endpoint_id)
        || binding
            .credential_context
            .keys()
            .any(|id| !current.contains_key(id))
    {
        return Err("Diagnostic credential context changed".into());
    }
    Ok(current
        .iter()
        .filter(|(id, hash)| binding.credential_context.get(*id) != Some(*hash))
        .map(|(id, _)| id.clone())
        .collect())
}
fn access(app: &tauri::AppHandle, endpoint: &str) -> Result<Access, String> {
    if !valid_uuid(endpoint) {
        return Err("Invalid diagnostic workspace".into());
    }
    let state = app
        .try_state::<crate::AppState>()
        .ok_or("Diagnostic workspace unavailable")?;
    let (base, brand, token) = crate::ipc::endpoint_access(&state, endpoint)
        .map_err(|_| "Diagnostic workspace is not signed in")?;
    if !trusted_base(&base) {
        return Err("Diagnostic sharing requires the trusted Boomin service".into());
    }
    Ok(Access { token, brand })
}
async fn access_async(app: &tauri::AppHandle, endpoint: &str) -> Result<Access, String> {
    let handle = app.clone();
    let endpoint = endpoint.to_owned();
    tauri::async_runtime::spawn_blocking(move || access(&handle, &endpoint))
        .await
        .map_err(|_| "Diagnostic authorization task failed".to_string())?
}
fn request(
    inner: &Transport,
    auth: &Access,
    method: reqwest::Method,
    path: &str,
) -> reqwest::RequestBuilder {
    let mut r = inner
        .client
        .request(method, format!("{BASE}{path}"))
        .bearer_auth(&auth.token);
    if let Some(brand) = &auth.brand {
        r = r.query(&[("brandSlug", brand)]);
    }
    r
}
fn allowed(app: &tauri::AppHandle, inner: &Transport, epoch: u64) -> bool {
    permitted(app, inner, epoch, None)
}
fn permitted(app: &tauri::AppHandle, inner: &Transport, epoch: u64, ticket: Option<u64>) -> bool {
    inner.epoch.load(Ordering::Acquire) == epoch
        && performance_trace::sharing_enabled(app)
        && ticket.map_or_else(
            || !UPLOAD_AUTHORITY.paused(),
            |ticket| UPLOAD_AUTHORITY.is_current(ticket),
        )
}
async fn send_allowed(
    app: &tauri::AppHandle,
    inner: &Transport,
    epoch: u64,
    builder: reqwest::RequestBuilder,
) -> Result<Option<reqwest::Response>, String> {
    send_guarded(app, inner, epoch, None, builder).await
}
async fn send_guarded(
    app: &tauri::AppHandle,
    inner: &Transport,
    epoch: u64,
    ticket: Option<u64>,
    builder: reqwest::RequestBuilder,
) -> Result<Option<reqwest::Response>, String> {
    if !permitted(app, inner, epoch, ticket) {
        return Ok(None);
    }
    let pending = builder.send();
    tokio::pin!(pending);
    loop {
        tokio::select! {
            response=&mut pending=>return response.map(Some).map_err(|_|"Diagnostic service could not be reached".into()),
            _=tokio::time::sleep(Duration::from_millis(100))=>if !permitted(app,inner,epoch,ticket){return Ok(None);}
        }
    }
}
async fn small_json(mut response: reqwest::Response) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err("Diagnostic response exceeded limit".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read diagnostic response")?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("Diagnostic response exceeded limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "Diagnostic response was invalid".into())
}
fn unavailable(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 404 | 503)
}
fn consent_revision(v: &Value) -> Option<u64> {
    (v.get("enabled").and_then(Value::as_bool) == Some(true)
        && v.get("policyVersion").and_then(Value::as_u64) == Some(1))
    .then(|| v.get("revision").and_then(Value::as_u64))
    .flatten()
    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
}
fn consent_identity(v: &Value) -> Option<(u64, String)> {
    let revision = consent_revision(v)?;
    let scope = v.get("consentScopeId")?.as_str()?;
    valid_uuid(scope).then(|| (revision, scope.into()))
}
fn binding_matches(actual: &Binding, expected: &Binding) -> bool {
    actual.endpoint_id == expected.endpoint_id
        && actual.installation_id == expected.installation_id
        && actual.revision == expected.revision
        && actual.consent_scope_id == expected.consent_scope_id
        && actual.context_salt == expected.context_salt
        && actual.credential_context == expected.credential_context
}
fn auth_check_current(
    authority: &UploadAuthority,
    transport: &Transport,
    data: &Delivery,
    ticket: u64,
    epoch: u64,
    sharing: bool,
    binding: &Binding,
) -> bool {
    sharing
        && authority.is_current(ticket)
        && transport.epoch.load(Ordering::Acquire) == epoch
        && data
            .binding
            .as_ref()
            .is_some_and(|actual| binding_matches(actual, binding))
}
fn apply_context_check(
    authority: &UploadAuthority,
    transport: &Transport,
    data: &mut Delivery,
    ticket: u64,
    epoch: u64,
    sharing: bool,
    binding: &Binding,
    receipt: Option<(u64, String)>,
    proof: Option<CredentialProof>,
) -> Result<(), String> {
    if !auth_check_current(authority, transport, data, ticket, epoch, sharing, binding) {
        return Ok(());
    }
    if receipt == Some((binding.revision, binding.consent_scope_id.clone()))
        && proof
            .as_ref()
            .is_some_and(|proof| valid_context_proof(binding, proof))
    {
        let proof = proof.unwrap();
        if proof != binding.credential_context {
            let mut candidate = data.clone();
            candidate.binding.as_mut().unwrap().credential_context = proof;
            save_delivery(&transport.path, &candidate)?;
            if !auth_check_current(authority, transport, data, ticket, epoch, sharing, binding) {
                return Ok(());
            }
            *data = candidate;
        }
        authority.resume(ticket);
    } else {
        transport.epoch.fetch_add(1, Ordering::AcqRel);
        clear_delivery(transport, data)?;
    }
    Ok(())
}
#[cfg(test)]
fn apply_auth_check(
    authority: &UploadAuthority,
    transport: &Transport,
    data: &mut Delivery,
    ticket: u64,
    epoch: u64,
    sharing: bool,
    binding: &Binding,
    receipt: Option<(u64, String)>,
) -> Result<(), String> {
    let proof = receipt.as_ref().map(|_| binding.credential_context.clone());
    apply_context_check(
        authority, transport, data, ticket, epoch, sharing, binding, receipt, proof,
    )
}

pub struct BoominSessionFence {
    ticket: u64,
    expected_epoch: Option<u64>,
}
/// Pause before any newly validated credential can be stored or exposed.
/// This path performs no filesystem, keychain or network operations.
pub fn pause_for_boomin_session(app: &tauri::AppHandle) -> BoominSessionFence {
    let ticket = UPLOAD_AUTHORITY.pause();
    let expected_epoch = app.try_state::<PerformanceShareState>().and_then(|state| {
        state
            .current()
            .map(|inner| inner.epoch.fetch_add(1, Ordering::AcqRel).wrapping_add(1))
    });
    BoominSessionFence {
        ticket,
        expected_epoch,
    }
}
pub fn boomin_session_changed(
    app: &tauri::AppHandle,
    fence: BoominSessionFence,
    base: &str,
    token: &str,
) {
    if !auth_verification_needed(performance_trace::sharing_status(app)) {
        return;
    }
    let handle = app.clone();
    let source = (base.to_owned(), token.to_owned());
    tauri::async_runtime::spawn(async move {
        let Ok(inner) = ready_transport(&handle).await else {
            return;
        };
        verify_credential_context(
            &handle,
            &inner,
            fence.ticket,
            fence.expected_epoch,
            Some(source),
        )
        .await;
    });
}
async fn verify_credential_context(
    app: &tauri::AppHandle,
    inner: &Arc<Transport>,
    ticket: u64,
    expected_epoch: Option<u64>,
    source: Option<(String, String)>,
) {
    let epoch = expected_epoch.unwrap_or_else(|| inner.epoch.load(Ordering::Acquire));
    if !permitted(app, inner, epoch, Some(ticket)) {
        return;
    }
    let handle = app.clone();
    let binding = with_delivery(inner.clone(), move |transport, data| {
        Ok(if permitted(&handle, transport, epoch, Some(ticket)) {
            data.binding.clone()
        } else {
            None
        })
    })
    .await;
    let Ok(Some(binding)) = binding else {
        return;
    };
    let context = credential_context_async(app, &binding.context_salt).await;
    let mut verified = None;
    if let Ok(context) = context {
        if let Ok(changed) = changed_credentials(&binding, &context.proof) {
            let mut credentials = Vec::new();
            let mut trusted = true;
            if let Some((base, token)) = &source {
                trusted = trusted_base(base);
                credentials.push(token.as_str());
            }
            for id in &changed {
                if let Some(token) = context.tokens.get(id) {
                    credentials.push(token.as_str());
                } else {
                    trusted = false;
                }
            }
            if trusted {
                let mut unique = BTreeSet::new();
                credentials.retain(|token| unique.insert(*token));
                let mut matching = true;
                if !credentials.is_empty() {
                    let mut lease = None;
                    for _ in 0..120 {
                        if !permitted(app, inner, epoch, Some(ticket)) {
                            return;
                        }
                        if let Some(busy) = acquire(inner) {
                            lease = Some(busy);
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    if let Some(_lease) = lease {
                        for token in credentials {
                            let auth = Access {
                                token: token.to_owned(),
                                brand: None,
                            };
                            let receipt = match send_guarded(
                                app,
                                inner,
                                epoch,
                                Some(ticket),
                                request(inner, &auth, reqwest::Method::GET, "/performance/consent")
                                    .query(&[("installationId", &binding.installation_id)]),
                            )
                            .await
                            {
                                Ok(Some(response)) if response.status().is_success() => {
                                    small_json(response)
                                        .await
                                        .ok()
                                        .and_then(|body| consent_identity(&body))
                                }
                                _ => None,
                            };
                            if receipt != Some((binding.revision, binding.consent_scope_id.clone()))
                            {
                                matching = false;
                                break;
                            }
                        }
                    } else {
                        matching = false;
                    }
                }
                if matching && permitted(app, inner, epoch, Some(ticket)) {
                    if let Ok(current) = credential_context_async(app, &binding.context_salt).await
                    {
                        if current.proof == context.proof {
                            verified = Some(context.proof);
                        }
                    }
                }
            }
        }
    }
    let handle = app.clone();
    let receipt = verified
        .as_ref()
        .map(|_| (binding.revision, binding.consent_scope_id.clone()));
    let _ = with_delivery(inner.clone(), move |transport, data| {
        apply_context_check(
            &UPLOAD_AUTHORITY,
            transport,
            data,
            ticket,
            epoch,
            performance_trace::sharing_enabled(&handle),
            &binding,
            receipt,
            verified,
        )
    })
    .await;
}

fn save_delivery(path: &Path, data: &Delivery) -> Result<(), String> {
    if let Some(binding) = &data.binding {
        let pending = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(&Spool {
            binding: binding.clone(),
            cursors: data.cursors.clone(),
            pending: data.pending.clone(),
            pruned_sessions: data.pruned_sessions,
        })
        .map_err(|_| "Could not save diagnostic enrollment")?;
        if bytes.len() > MAX_SPOOL {
            return Err("Diagnostic delivery spool exceeded limit".into());
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options
                .open(&pending)
                .map_err(|_| "Could not save diagnostic enrollment")?;
            file.write_all(&bytes)
                .map_err(|_| "Could not save diagnostic enrollment")?;
            file.sync_all()
                .map_err(|_| "Could not save diagnostic enrollment")?;
            fs::rename(&pending, path).map_err(|_| "Could not save diagnostic enrollment")
        })();
        if result.is_err() {
            let _ = fs::remove_file(pending);
        }
        result.map_err(str::to_owned)
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not remove diagnostic enrollment".into()),
        }
    }
}
fn clear_delivery(inner: &Transport, data: &mut Delivery) -> Result<Option<Binding>, String> {
    let old = data.binding.take();
    data.cursors.clear();
    data.pending = None;
    save_delivery(&inner.path, data)?;
    Ok(old)
}
async fn clear_binding(inner: &Arc<Transport>) -> Result<Option<Binding>, String> {
    // Cancel in-flight sends before waiting for a serialized disk transaction.
    inner.epoch.fetch_add(1, Ordering::AcqRel);
    with_delivery(inner.clone(), clear_delivery).await
}
async fn clear_current_binding(
    inner: &Arc<Transport>,
    epoch: u64,
    expected: Binding,
) -> Result<(), String> {
    with_delivery(inner.clone(), move |transport, data| {
        if transport.epoch.load(Ordering::Acquire) == epoch
            && data
                .binding
                .as_ref()
                .is_some_and(|actual| binding_matches(actual, &expected))
        {
            transport.epoch.fetch_add(1, Ordering::AcqRel);
            clear_delivery(transport, data)?;
        }
        Ok(())
    })
    .await
}
async fn snapshot(app: &tauri::AppHandle) -> Result<TraceExport, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || performance_trace::export_snapshot(&app))
        .await
        .map_err(|_| "Diagnostic export task failed".to_string())?
}
fn export_ids(export: &TraceExport) -> Result<(String, String), String> {
    let install = export
        .metadata
        .get("installationId")
        .and_then(Value::as_str)
        .ok_or("Diagnostic identity unavailable")?;
    let session = export
        .metadata
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("Diagnostic session unavailable")?;
    if !valid_uuid(install) || !valid_uuid(session) {
        return Err("Diagnostic identity was invalid".into());
    }
    Ok((install.into(), session.into()))
}
fn record_position(record: &Value) -> Option<(&str, Cursor)> {
    let origin = record.get("origin")?.as_str()?;
    if !matches!(origin, "native" | "frontend") {
        return None;
    }
    let at = record.get("receivedSessionMs")?.as_f64()?;
    let seq = record.pointer("/event/seq")?.as_u64()?;
    if !at.is_finite() || at < 0.0 {
        return None;
    }
    Some((origin, Cursor { at, seq }))
}
fn after(value: Cursor, cursor: Cursor) -> bool {
    value.at > cursor.at || (value.at == cursor.at && value.seq > cursor.seq)
}
fn eligible_record(record: &Value, cutoff: f64) -> bool {
    let Some((origin, position)) = record_position(record) else {
        return false;
    };
    if position.at < cutoff {
        return false;
    }
    let Some(event) = record.get("event") else {
        return false;
    };
    let Some(at) = event
        .get("atMs")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
    else {
        return false;
    };
    let duration = event
        .get("durationMs")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let window = event
        .pointer("/fields/windowMs")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let semantic_elapsed = if matches!(
        event.get("kind").and_then(Value::as_str),
        Some("room" | "set")
    ) {
        event
            .pointer("/fields/elapsedMs")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    } else {
        0.0
    };
    let uncertainty = if origin == "frontend" {
        if event
            .pointer("/fields/nativeClockAligned")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return false;
        }
        let Some(uncertainty) = event
            .pointer("/fields/clockUncertaintyMs")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
        else {
            return false;
        };
        uncertainty
    } else {
        0.0
    };
    duration.is_finite()
        && duration >= 0.0
        && window.is_finite()
        && window >= 0.0
        && semantic_elapsed.is_finite()
        && semantic_elapsed >= 0.0
        && at - duration.max(window).max(semantic_elapsed) - uncertainty >= cutoff
}
fn batch_id(payload: &Value) -> String {
    let hash = Sha256::digest(serde_json::to_vec(payload).unwrap_or_default());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
fn metadata_for(export: &TraceExport, binding: &Binding, session: &str) -> Option<Value> {
    let matches = |v: &Value| {
        v.get("installationId").and_then(Value::as_str) == Some(binding.installation_id.as_str())
            && v.get("sessionId").and_then(Value::as_str) == Some(session)
    };
    if matches(&export.metadata) {
        return Some(export.metadata.clone());
    }
    export.records.iter().find_map(|record| {
        let metadata = record.get("metadata")?;
        (record.get("type").and_then(Value::as_str) == Some("metadata") && matches(metadata))
            .then(|| metadata.clone())
    })
}
fn payload(metadata: &Value, binding: &Binding, session: &str, events: &[Value]) -> Value {
    let mut value = json!({"schema":"producer.performance/1","installationId":binding.installation_id,"consentRevision":binding.revision,"consentScopeId":binding.consent_scope_id,"sessionId":session,"metadata":metadata,"events":events});
    let id = batch_id(&value);
    value["batchId"] = json!(id);
    value
}
fn select(
    export: &TraceExport,
    binding: &Binding,
    session: &str,
    cursors: &BTreeMap<String, Cursor>,
) -> Option<(Value, BTreeMap<String, Cursor>, usize)> {
    let cutoff = *binding.sessions.get(session)?;
    let metadata = metadata_for(export, binding, session)?;
    let mut events = Vec::new();
    let mut next = cursors.clone();
    for record in &export.records {
        if record.get("type").and_then(Value::as_str) != Some("event")
            || record.get("sessionId").and_then(Value::as_str) != Some(session)
        {
            continue;
        }
        let Some((origin, position)) = record_position(record) else {
            continue;
        };
        if !eligible_record(record, cutoff) {
            continue;
        }
        // Receipt timestamps remain monotonic if a frontend tracing toggle
        // resets its own sequence counter within the same native session.
        if !after(position, next.get(origin).copied().unwrap_or_default()) {
            continue;
        }
        let mut proposed = events.clone();
        proposed.push(record.clone());
        let candidate = payload(&metadata, binding, session, &proposed);
        if serde_json::to_vec(&candidate).ok()?.len() > MAX_BODY {
            break;
        }
        events = proposed;
        next.insert(origin.to_string(), position);
        if events.len() == MAX_EVENTS {
            break;
        }
    }
    if events.is_empty() {
        None
    } else {
        let n = events.len();
        Some((payload(&metadata, binding, session, &events), next, n))
    }
}
fn acknowledged(response: &Value, count: usize) -> bool {
    response.get("accepted").and_then(Value::as_bool) == Some(true)
        && response.get("eventCount").and_then(Value::as_u64) == Some(count as u64)
}
fn take_attempt(data: &mut Delivery, now: Instant) -> bool {
    if data
        .attempt_window
        .is_none_or(|start| now.saturating_duration_since(start) >= Duration::from_secs(60))
    {
        data.attempt_window = Some(now);
        data.attempted_chunks = 0;
    }
    if data.attempted_chunks >= MAX_CHUNKS {
        return false;
    }
    data.attempted_chunks += 1;
    true
}
fn next_batch(
    data: &mut Delivery,
    export: &TraceExport,
    binding: &Binding,
    _session: &str,
) -> Option<Pending> {
    if let Some(pending) = &data.pending {
        return Some(pending.clone());
    }
    let mut seen = BTreeSet::new();
    for record in &export.records {
        let Some(session) = record.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        if !binding.sessions.contains_key(session) || !seen.insert(session.to_owned()) {
            continue;
        }
        let cursor = data.cursors.get(session).cloned().unwrap_or_default();
        if let Some((body, cursors, count)) = select(export, binding, session, &cursor) {
            let pending = Pending {
                session: session.into(),
                body,
                cursors,
                count,
            };
            data.pending = Some(pending.clone());
            return Some(pending);
        }
    }
    None
}
fn valid_binding(binding: &Binding) -> bool {
    valid_uuid(&binding.endpoint_id)
        && valid_uuid(&binding.installation_id)
        && valid_uuid(&binding.consent_scope_id)
        && binding.revision > 0
        && binding.revision <= 9_007_199_254_740_991
        && !binding.sessions.is_empty()
        && binding.sessions.len() <= MAX_SESSIONS
        && binding.sessions.iter().all(|(session, cutoff)| {
            valid_uuid(session) && cutoff.is_finite() && (0.0..=1e15).contains(cutoff)
        })
        && valid_uuid(&binding.context_salt)
        && valid_context_proof(binding, &binding.credential_context)
}
fn valid_context_proof(binding: &Binding, proof: &CredentialProof) -> bool {
    !proof.is_empty()
        && proof.len() <= MAX_CREDENTIAL_CONTEXT
        && proof.contains_key(&binding.endpoint_id)
        && proof.iter().all(|(id, hash)| {
            valid_uuid(id) && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
        })
}
fn valid_cursor(cursor: Cursor) -> bool {
    cursor.at.is_finite()
        && (0.0..=1e15).contains(&cursor.at)
        && cursor.seq <= 9_007_199_254_740_991
}
fn load_delivery(path: &Path) -> Option<Delivery> {
    let stat = fs::symlink_metadata(path).ok()?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > MAX_SPOOL as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_SPOOL as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_SPOOL {
        return None;
    }
    let spool: Spool = serde_json::from_slice(&bytes).ok()?;
    if !valid_binding(&spool.binding)
        || spool.pruned_sessions > 9_007_199_254_740_991
        || spool.cursors.len() > MAX_SESSIONS
    {
        return None;
    }
    for (session, cursors) in &spool.cursors {
        if !spool.binding.sessions.contains_key(session)
            || cursors.len() > 2
            || cursors.iter().any(|(origin, c)| {
                !matches!(origin.as_str(), "native" | "frontend") || !valid_cursor(*c)
            })
        {
            return None;
        }
    }
    if let Some(pending) = &spool.pending {
        let body = &pending.body;
        let obj = body.as_object()?;
        let events = body.get("events")?.as_array()?;
        if obj.len() != 8
            || body.get("schema")?.as_str()? != "producer.performance/1"
            || body.get("installationId")?.as_str()? != spool.binding.installation_id
            || body.get("consentRevision")?.as_u64()? != spool.binding.revision
            || body.get("consentScopeId")?.as_str()? != spool.binding.consent_scope_id
            || body.get("sessionId")?.as_str()? != pending.session
            || pending.count == 0
            || pending.count > MAX_EVENTS
            || pending.count != events.len()
            || serde_json::to_vec(body).ok()?.len() > MAX_BODY
        {
            return None;
        }
        let mut unhashed = body.clone();
        unhashed.as_object_mut()?.remove("batchId");
        if body.get("batchId")?.as_str()? != batch_id(&unhashed) {
            return None;
        }
        let metadata = body.get("metadata")?;
        let header =
            json!({"schema":"producer.performance-trace/1","type":"metadata","metadata":metadata});
        if performance_trace::sanitized_record(header).is_none()
            || metadata.get("installationId")?.as_str()? != spool.binding.installation_id
            || metadata.get("sessionId")?.as_str()? != pending.session
        {
            return None;
        }
        let cutoff = *spool.binding.sessions.get(&pending.session)?;
        let mut next = spool
            .cursors
            .get(&pending.session)
            .cloned()
            .unwrap_or_default();
        for record in events {
            if performance_trace::sanitized_record(record.clone()).is_none()
                || record.get("sessionId")?.as_str()? != pending.session
            {
                return None;
            }
            let (origin, position) = record_position(record)?;
            if !eligible_record(record, cutoff)
                || !after(position, next.get(origin).copied().unwrap_or_default())
            {
                return None;
            }
            next.insert(origin.into(), position);
        }
        if next != pending.cursors {
            return None;
        }
    }
    Some(Delivery {
        binding: Some(spool.binding),
        cursors: spool.cursors,
        pending: spool.pending,
        pruned_sessions: spool.pruned_sessions,
        ..Delivery::default()
    })
}
fn enroll_session(data: &mut Delivery, session: String, cutoff: f64) {
    let protected = data.pending.as_ref().map(|p| p.session.clone());
    let Some(binding) = data.binding.as_mut() else {
        return;
    };
    if binding.sessions.contains_key(&session) {
        return;
    }
    if binding.sessions.len() >= MAX_SESSIONS {
        let victim = binding
            .sessions
            .keys()
            .find(|s| protected.as_ref().is_none_or(|p| p.as_str() != s.as_str()))
            .cloned();
        if let Some(victim) = victim {
            binding.sessions.remove(&victim);
            data.cursors.remove(&victim);
            data.pruned_sessions = data.pruned_sessions.saturating_add(1);
        }
    }
    binding.sessions.insert(session, cutoff);
}
fn prune_retained(data: &mut Delivery, export: &TraceExport) -> bool {
    let before = (
        data.binding.as_ref().map(|b| b.sessions.len()),
        data.cursors.len(),
    );
    let mut retained: BTreeSet<String> = export
        .records
        .iter()
        .filter_map(|r| {
            r.get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    if let Some(session) = export.metadata.get("sessionId").and_then(Value::as_str) {
        retained.insert(session.into());
    }
    if let Some(pending) = &data.pending {
        retained.insert(pending.session.clone());
    }
    if let Some(binding) = data.binding.as_mut() {
        binding.sessions.retain(|s, _| retained.contains(s));
        data.cursors.retain(|s, _| binding.sessions.contains_key(s));
    }
    before
        != (
            data.binding.as_ref().map(|b| b.sessions.len()),
            data.cursors.len(),
        )
}
pub fn pruned_sessions(app: &tauri::AppHandle) -> Option<u64> {
    let state = app.try_state::<PerformanceShareState>()?;
    let data = state.current()?.data.try_lock().ok()?;
    Some(data.pruned_sessions)
}

/// Init is best effort. No automatic enrollment or upload without an explicit
/// saved enrollment AND current local sharing permission.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    if app.try_state::<PerformanceShareState>().is_some() {
        return Ok(());
    }
    let startup_ticket = UPLOAD_AUTHORITY.pause();
    app.manage(PerformanceShareState {
        ready: Arc::new(tokio::sync::OnceCell::new()),
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let inner = match ready_transport(&handle).await {
            Ok(inner) => inner,
            Err(error) => {
                eprintln!("Performance sharing unavailable: {error}");
                return;
            }
        };
        if performance_trace::sharing_enabled(&handle) {
            verify_credential_context(&handle, &inner, startup_ticket, None, None).await;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            if performance_trace::sharing_enabled(&handle) {
                let _ = upload_internal(&handle, &inner, None).await;
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
    Ok(())
}
fn initialize_transport(app: &tauri::AppHandle) -> Result<Arc<Transport>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Diagnostic storage unavailable")?
        .join("performance-traces");
    fs::create_dir_all(&dir).map_err(|_| "Diagnostic storage unavailable")?;
    let path = dir.join("sharing.json");
    let mut data = load_delivery(&path).unwrap_or_default();
    let installation =
        performance_trace::installation_id(app).ok_or("Diagnostic installation unavailable")?;
    if data
        .binding
        .as_ref()
        .is_some_and(|b| b.installation_id != installation)
    {
        data.binding = None;
        data.pending = None;
        data.cursors.clear();
        save_delivery(&path, &data)?;
    }
    if performance_trace::sharing_enabled(app) && data.binding.is_some() {
        if let Some((session, cutoff)) = performance_trace::capture_position(app) {
            enroll_session(&mut data, session, cutoff);
            save_delivery(&path, &data)?;
        }
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| "Diagnostic transport unavailable")?;
    let inner = Arc::new(Transport {
        client,
        path,
        data: Mutex::new(data),
        busy: AtomicBool::new(false),
        epoch: AtomicU64::new(0),
    });
    Ok(inner)
}
fn prepare_delivery(
    transport: &Transport,
    data: &mut Delivery,
    export: &TraceExport,
    binding: &Binding,
    session: &str,
    permitted: impl Fn() -> bool,
) -> Result<Option<Pending>, String> {
    if !permitted() {
        return Ok(None);
    }
    let mut candidate = data.clone();
    let pruned = prune_retained(&mut candidate, export);
    let already_durable = candidate.pending.is_some();
    let selected = next_batch(&mut candidate, export, binding, session);
    // An existing pending body is already durable. Idle/budget retries
    // must not fsync an identical spool on every check.
    if pruned || (selected.is_some() && !already_durable) {
        save_delivery(&transport.path, &candidate)?;
    }
    if !permitted() {
        return Ok(None);
    }
    *data = candidate;
    Ok(selected)
}

async fn upload_internal(
    app: &tauri::AppHandle,
    inner: &Arc<Transport>,
    endpoint: Option<&str>,
) -> Result<ShareReceipt, String> {
    if !performance_trace::sharing_enabled(app) {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    }
    let Some(_busy) = acquire(inner) else {
        return Ok(ShareReceipt {
            accepted: 0,
            available: true,
        });
    };
    let epoch = inner.epoch.load(Ordering::Acquire);
    let binding = with_delivery(inner.clone(), |_, data| Ok(data.binding.clone())).await?;
    let Some(binding) = binding else {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    };
    if endpoint.is_some_and(|id| id != binding.endpoint_id) {
        return Err("Diagnostic sharing is enrolled to another workspace".into());
    }
    let auth = match access_async(app, &binding.endpoint_id).await {
        Ok(a) => a,
        Err(_) => {
            return Ok(ShareReceipt {
                accepted: 0,
                available: false,
            })
        }
    };
    let export = Arc::new(snapshot(app).await?);
    let (installation, session) = export_ids(&export)?;
    if installation != binding.installation_id {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    }
    let Some(response) = send_allowed(
        app,
        inner,
        epoch,
        request(inner, &auth, reqwest::Method::GET, "/performance/consent")
            .query(&[("installationId", &installation)]),
    )
    .await?
    else {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    };
    if unavailable(response.status()) {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    }
    if !response.status().is_success() {
        return Err("Diagnostic consent could not be confirmed".into());
    }
    if consent_identity(&small_json(response).await?)
        != Some((binding.revision, binding.consent_scope_id.clone()))
    {
        let _ = clear_current_binding(inner, epoch, binding.clone()).await;
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    }
    let mut accepted = 0;
    for _ in 0..MAX_CHUNKS {
        if !allowed(app, inner, epoch) {
            break;
        }
        let handle = app.clone();
        let bound = binding.clone();
        let session_copy = session.clone();
        let export_copy = export.clone();
        let pending = with_delivery(inner.clone(), move |transport, data| {
            prepare_delivery(transport, data, &export_copy, &bound, &session_copy, || {
                allowed(&handle, transport, epoch)
            })
        })
        .await?;
        let Some(Pending {
            session: delivery_session,
            body,
            cursors: next,
            count,
        }) = pending
        else {
            break;
        };
        let auth = match access_async(app, &binding.endpoint_id).await {
            Ok(auth) => auth,
            Err(_) => {
                return Ok(ShareReceipt {
                    accepted,
                    available: false,
                })
            }
        };
        let bytes = serde_json::to_vec(&body).map_err(|_| "Could not encode diagnostic batch")?;
        if !with_delivery(inner.clone(), |_, data| {
            Ok(take_attempt(data, Instant::now()))
        })
        .await?
        {
            break;
        }
        let Some(response) = send_allowed(
            app,
            inner,
            epoch,
            request(inner, &auth, reqwest::Method::POST, "/performance")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes),
        )
        .await?
        else {
            break;
        };
        if unavailable(response.status()) {
            return Ok(ShareReceipt {
                accepted,
                available: false,
            });
        }
        if !response.status().is_success() {
            return Err("Diagnostic batch was not accepted".into());
        }
        if !acknowledged(&small_json(response).await?, count) {
            return Err("Diagnostic acknowledgement was invalid".into());
        }
        if !allowed(app, inner, epoch) {
            break;
        }
        let handle = app.clone();
        let bound = binding.clone();
        let committed = with_delivery(inner.clone(), move |transport, data| {
            if !allowed(&handle, transport, epoch)
                || data.binding.as_ref().is_none_or(|b| {
                    b.endpoint_id != bound.endpoint_id
                        || b.revision != bound.revision
                        || b.consent_scope_id != bound.consent_scope_id
                })
            {
                return Ok(false);
            }
            let mut candidate = data.clone();
            candidate.cursors.insert(delivery_session, next);
            candidate.pending = None;
            save_delivery(&transport.path, &candidate)?;
            if !allowed(&handle, transport, epoch) {
                return Ok(false);
            }
            *data = candidate;
            Ok(true)
        })
        .await?;
        if !committed {
            break;
        }
        accepted += count;
    }
    Ok(ShareReceipt {
        accepted,
        available: true,
    })
}
#[tauri::command]
pub async fn performance_trace_upload(
    app: tauri::AppHandle,
    endpoint_id: String,
) -> Result<ShareReceipt, String> {
    let inner = ready_transport(&app).await?;
    upload_internal(&app, &inner, Some(&endpoint_id)).await
}
#[tauri::command]
pub async fn performance_trace_configure_sharing(
    app: tauri::AppHandle,
    endpoint_id: String,
) -> Result<ShareReceipt, String> {
    let ticket = UPLOAD_AUTHORITY.pause();
    let inner = ready_transport(&app).await?;
    if !performance_trace::sharing_enabled(&app) {
        return Err("Enable diagnostic sharing before enrollment".into());
    }
    clear_binding(&inner).await?;
    let Some(_busy) = acquire(&inner) else {
        return Err("Diagnostic transport is busy; retry enrollment".into());
    };
    let epoch = inner.epoch.load(Ordering::Acquire);
    let auth = access_async(&app, &endpoint_id).await?;
    let export = snapshot(&app).await?;
    let (installation, _) = export_ids(&export)?;
    let Some(response) = send_guarded(
        &app,
        &inner,
        epoch,
        Some(ticket),
        request(&inner, &auth, reqwest::Method::PUT, "/performance/consent")
            .json(&json!({"installationId":installation,"enabled":true,"policyVersion":1})),
    )
    .await?
    else {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    };
    if unavailable(response.status()) {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    }
    if !response.status().is_success() {
        return Err("Diagnostic enrollment was not accepted".into());
    }
    let (revision, consent_scope_id) = consent_identity(&small_json(response).await?)
        .ok_or("Diagnostic enrollment response was invalid")?;
    if !permitted(&app, &inner, epoch, Some(ticket)) {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    }
    let (context_salt, context) = fresh_credential_context(&app).await?;
    if !context.proof.contains_key(&endpoint_id) {
        return Err("Diagnostic credential context unavailable".into());
    }
    let binding = Binding {
        endpoint_id,
        installation_id: installation,
        revision,
        consent_scope_id,
        sessions: {
            let (session, cutoff) = performance_trace::capture_position(&app)
                .ok_or("Diagnostic capture clock unavailable")?;
            BTreeMap::from([(session, cutoff)])
        },
        context_salt,
        credential_context: context.proof,
    };
    let handle = app.clone();
    let committed = with_delivery(inner.clone(), move |transport, data| {
        if !permitted(&handle, transport, epoch, Some(ticket)) {
            return Ok(false);
        }
        let mut candidate = data.clone();
        candidate.binding = Some(binding);
        candidate.cursors.clear();
        candidate.pending = None;
        candidate.pruned_sessions = 0;
        save_delivery(&transport.path, &candidate)?;
        if !permitted(&handle, transport, epoch, Some(ticket)) {
            return Ok(false);
        }
        *data = candidate;
        Ok(UPLOAD_AUTHORITY.resume(ticket))
    })
    .await?;
    Ok(ShareReceipt {
        accepted: 0,
        available: committed,
    })
}
#[tauri::command]
pub async fn performance_trace_revoke(
    app: tauri::AppHandle,
    endpoint_id: String,
) -> Result<ShareReceipt, String> {
    UPLOAD_AUTHORITY.pause();
    let inner = ready_transport(&app).await?;
    // Remove local enrollment before network I/O, even if signed out/offline.
    let Some(old) = clear_binding(&inner).await? else {
        return Ok(ShareReceipt {
            accepted: 0,
            available: true,
        });
    };
    let _ = endpoint_id;
    // Revocation invalidates any upload epoch before waiting for the single
    // transport slot. Never overlap a DELETE with a telemetry POST.
    let mut lease = None;
    for _ in 0..120 {
        if let Some(busy) = acquire(&inner) {
            lease = Some(busy);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let Some(_lease) = lease else {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    };

    let auth = match access_async(&app, &old.endpoint_id).await {
        Ok(a) => a,
        Err(_) => {
            return Ok(ShareReceipt {
                accepted: 0,
                available: false,
            })
        }
    };
    let response = request(&inner, &auth, reqwest::Method::DELETE, "/performance")
        .query(&[
            ("installationId", old.installation_id),
            ("consentScopeId", old.consent_scope_id),
        ])
        .send()
        .await
        .map_err(|_| {
            "Diagnostic enrollment was removed locally; remote deletion could not be reached"
        })?;
    let available = response.status().is_success();
    Ok(ShareReceipt {
        accepted: 0,
        available,
    })
}
fn save_export(path: &Path, document: &TraceExport) -> Result<(), String> {
    if path
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("json"))
        || path.as_os_str().len() > 4096
    {
        return Err("Choose a JSON export file".into());
    }
    if let Ok(existing) = fs::symlink_metadata(path) {
        if !existing.is_file() || existing.file_type().is_symlink() {
            return Err("Export destination must be a regular file".into());
        }
    }
    let parent = path
        .parent()
        .filter(|p| p.is_dir())
        .ok_or("Export folder unavailable")?;
    let bytes = serde_json::to_vec(document).map_err(|_| "Could not encode diagnostic export")?;
    if bytes.len() > 8 * 1024 * 1024 + 65536 {
        return Err("Diagnostic export exceeded limit".into());
    }
    let pending = parent.join(format!(
        ".producer-performance-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&pending)
            .map_err(|_| "Could not create diagnostic export")?;
        file.write_all(&bytes)
            .map_err(|_| "Could not write diagnostic export")?;
        file.sync_all()
            .map_err(|_| "Could not save diagnostic export")?;
        fs::rename(&pending, path).map_err(|_| "Could not replace diagnostic export")
    })();
    if result.is_err() {
        let _ = fs::remove_file(pending);
    }
    result.map_err(str::to_owned)
}
#[tauri::command]
pub async fn performance_trace_save_export(
    app: tauri::AppHandle,
    path: String,
) -> Result<Value, String> {
    performance_trace::ensure_ready(&app).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let document = performance_trace::export_snapshot(&app)?;
        save_export(Path::new(&path), &document)?;
        Ok(json!({"saved":true}))
    })
    .await
    .map_err(|_| "Diagnostic export task failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn transport_fixture() -> (Arc<Transport>, TraceExport, Binding, String, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("producer-offload-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let binding = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        let inner = Arc::new(Transport {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            path: dir.join("sharing.json"),
            data: Mutex::new(Delivery {
                binding: Some(binding.clone()),
                ..Delivery::default()
            }),
            busy: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
        });
        (inner, e, binding, session, dir)
    }
    fn export() -> TraceExport {
        let install = uuid::Uuid::new_v4().to_string();
        let session = uuid::Uuid::new_v4().to_string();
        let records=(1..=100).map(|n|json!({"schema":"producer.performance-trace/1","type":"event","origin":"frontend","sessionId":session,"receivedSessionMs":n,"event":{"seq":n,"atMs":n,"kind":"action","name":"room.open","fields":{"count":1,"nativeClockAligned":true,"clockUncertaintyMs":0}}})).collect();
        TraceExport {
            schema: "producer.performance-trace/1".into(),
            metadata: json!({"installationId":install,"sessionId":session,"version":"0.4.83","os":"macos","arch":"aarch64","logicalCores":8,"startedUnixMs":1,"debugBuild":false}),
            records,
            dropped_events: 0,
            truncated: false,
        }
    }
    #[test]
    fn fixed_host_only() {
        for bad in [
            "http://api.boomin.ai/v1/app/producer",
            "https://api.boomin.ai.evil/v1/app/producer",
            "https://user@api.boomin.ai/v1/app/producer",
            "https://api.boomin.ai/v1/app/producer?x=1",
            "https://localhost:8795",
        ] {
            assert!(!trusted_base(bad));
        }
        assert!(trusted_base(BASE));
        assert!(trusted_base(&(BASE.to_owned() + "/")));
    }
    #[test]
    fn batches_bounded_and_acknowledged_per_origin() {
        let e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let b = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        let (body, cursors, count) = select(&e, &b, &session, &BTreeMap::new()).unwrap();
        assert_eq!(count, 64);
        assert!(serde_json::to_vec(&body).unwrap().len() <= MAX_BODY);
        assert_eq!(body, select(&e, &b, &session, &BTreeMap::new()).unwrap().0);
        assert!(valid_uuid(body["batchId"].as_str().unwrap()));
        let (_, _, count) = select(&e, &b, &session, &cursors).unwrap();
        assert_eq!(count, 36);
        assert!(!acknowledged(&json!({"accepted":true,"eventCount":63}), 64));
        assert!(acknowledged(&json!({"accepted":true,"eventCount":64}), 64));
    }
    #[test]
    fn retry_retains_identical_payload_when_new_events_arrive() {
        let mut e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let b = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        e.records.truncate(2);
        let mut data = Delivery::default();
        let first = next_batch(&mut data, &e, &b, &session).unwrap();
        assert_eq!(first.count, 2);
        let mut later = e.records[1].clone();
        later["receivedSessionMs"] = json!(3);
        later["event"]["seq"] = json!(3);
        e.records.push(later);
        assert_eq!(
            first.body,
            next_batch(&mut data, &e, &b, &session).unwrap().body
        );
        data.cursors.insert(session.clone(), first.cursors);
        data.pending = None; // Only the ACK path clears this pending batch.
        let next = next_batch(&mut data, &e, &b, &session).unwrap();
        assert_eq!(next.count, 1);
        assert_ne!(first.body["batchId"], next.body["batchId"]);
    }
    #[test]
    fn encoded_batch_budget_and_private_binding_shape() {
        let mut e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let b = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        for record in &mut e.records {
            record["event"]["fields"] = Value::Object(
                (0..22)
                    .map(|n| {
                        (
                            format!("performanceMeasurementCounterNumber{n}"),
                            json!(9_007_199_254_740_991u64),
                        )
                    })
                    .chain([
                        ("nativeClockAligned".into(), json!(true)),
                        ("clockUncertaintyMs".into(), json!(0)),
                    ])
                    .collect(),
            );
        }
        let (body, _, count) = select(&e, &b, &session, &BTreeMap::new()).unwrap();
        assert!(count > 0 && count < 64);
        assert!(serde_json::to_vec(&body).unwrap().len() <= MAX_BODY);
        let saved = serde_json::to_value(&b).unwrap();
        assert_eq!(saved.as_object().unwrap().len(), 7);
        assert!(serde_json::from_value::<Binding>(json!({
            "endpointId": b.endpoint_id,
            "installationId": b.installation_id,
            "revision":1,
            "token":"must never be saved"
        }))
        .is_err());
    }
    #[test]
    fn foreign_sessions_and_reset_sequences() {
        let mut e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let b = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        e.records[0]["sessionId"] = json!(uuid::Uuid::new_v4().to_string());
        let c = BTreeMap::from([("frontend".into(), Cursor { at: 99.0, seq: 99 })]);
        e.records[99]["event"]["seq"] = json!(1);
        let (body, _, n) = select(&e, &b, &session, &c).unwrap();
        assert_eq!(n, 1);
        assert_eq!(body["events"][0]["event"]["seq"], 1);
    }
    #[test]
    fn consent_responses_are_not_fabricated() {
        assert_eq!(
            consent_revision(&json!({"enabled":false,"revision":1,"policyVersion":1})),
            None
        );
        assert_eq!(
            consent_revision(&json!({"enabled":true,"revision":1,"policyVersion":2})),
            None
        );
        assert_eq!(
            consent_revision(&json!({"enabled":true,"revision":4,"policyVersion":1})),
            Some(4)
        );
    }
    #[test]
    fn automatic_and_manual_attempts_share_one_minute_budget() {
        let mut data = Delivery::default();
        let start = Instant::now();
        for _ in 0..MAX_CHUNKS {
            assert!(take_attempt(&mut data, start));
        }
        assert!(!take_attempt(&mut data, start));
        assert!(!take_attempt(&mut data, start + Duration::from_secs(59)));
        // Consent/binding changes clear delivery cursors, never this budget.
        data.cursors.clear();
        data.pending = None;
        data.binding = None;
        assert!(!take_attempt(&mut data, start + Duration::from_secs(59)));
        assert!(take_attempt(&mut data, start + Duration::from_secs(60)));
        assert_eq!(data.attempted_chunks, 1);
    }
    #[test]
    fn durable_retry_preserves_original_session_metadata_and_consent_cutoffs() {
        let dir =
            std::env::temp_dir().join(format!("producer-resume-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sharing.json");
        let mut old = export();
        old.metadata["version"] = json!("0.4.82");
        let (install, old_session) = export_ids(&old).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let binding = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install.clone(),
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(old_session.clone(), 50.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        let mut data = Delivery {
            binding: Some(binding.clone()),
            ..Delivery::default()
        };
        let pending = next_batch(&mut data, &old, &binding, &old_session).unwrap();
        assert_eq!(pending.count, 51);
        assert_eq!(pending.body["metadata"]["version"], "0.4.82");
        assert_eq!(pending.body["events"][0]["receivedSessionMs"], 50);
        save_delivery(&path, &data).unwrap();
        let mut resumed = load_delivery(&path).unwrap();
        let mut current = export();
        current.metadata["installationId"] = json!(install);
        let new_session = current.metadata["sessionId"].as_str().unwrap().to_owned();
        let mut records = vec![
            json!({"schema":"producer.performance-trace/1","type":"metadata","metadata":old.metadata}),
        ];
        records.extend(old.records);
        records.extend(current.records);
        current.records = records;
        enroll_session(&mut resumed, new_session.clone(), 10.0);
        let bound = resumed.binding.clone().unwrap();
        let retried = next_batch(&mut resumed, &current, &bound, &new_session).unwrap();
        assert_eq!(pending.body, retried.body); // ACK loss survives restart + new events.
        resumed.cursors.insert(old_session.clone(), retried.cursors);
        resumed.pending = None;
        save_delivery(&path, &resumed).unwrap();
        let mut resumed = load_delivery(&path).unwrap();
        let next = next_batch(&mut resumed, &current, &bound, &new_session).unwrap();
        assert_eq!(next.session, new_session);
        assert_eq!(next.body["metadata"]["version"], "0.4.83");
        assert_eq!(next.body["events"][0]["receivedSessionMs"], 10);
        assert!(next.body["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["sessionId"] == new_session));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn new_account_scope_and_manifest_cannot_resume_prior_account_payload() {
        let dir =
            std::env::temp_dir().join(format!("producer-scope-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sharing.json");
        let e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let a = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        let mut data = Delivery {
            binding: Some(a.clone()),
            ..Delivery::default()
        };
        next_batch(&mut data, &e, &a, &session).unwrap();
        let b_scope = uuid::Uuid::new_v4().to_string();
        data.binding.as_mut().unwrap().consent_scope_id = b_scope.clone();
        save_delivery(&path, &data).unwrap();
        assert!(
            load_delivery(&path).is_none(),
            "pending payload remains fenced to original owner scope"
        );
        assert_ne!(
            Some((a.revision, a.consent_scope_id.clone())),
            consent_identity(
                &json!({"enabled":true,"revision":1,"policyVersion":1,"consentScopeId":b_scope})
            )
        );
        data.pending = None;
        data.cursors.clear();
        data.binding.as_mut().unwrap().sessions = BTreeMap::from([(session.clone(), 75.0)]);
        let b = data.binding.clone().unwrap();
        let after = next_batch(&mut data, &e, &b, &session).unwrap();
        assert_eq!(after.count, 26);
        assert_eq!(after.body["events"][0]["receivedSessionMs"], 75);
        let unknown = uuid::Uuid::new_v4().to_string();
        assert!(select(&e, &b, &unknown, &BTreeMap::new()).is_none());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn cutoff_checks_occurrence_duration_window_and_clock_uncertainty() {
        let mut r = export().records.remove(99);
        r["receivedSessionMs"] = json!(200);
        assert!(eligible_record(&r, 75.0));
        r["event"]["durationMs"] = json!(30);
        assert!(!eligible_record(&r, 75.0));
        r["event"].as_object_mut().unwrap().remove("durationMs");
        r["event"]["fields"]["windowMs"] = json!(30);
        assert!(!eligible_record(&r, 75.0));
        r["event"]["fields"]["windowMs"] = json!(0);
        r["event"]["fields"]["clockUncertaintyMs"] = json!(30);
        assert!(!eligible_record(&r, 75.0));
        r["event"]["fields"]["clockUncertaintyMs"] = json!(0);
        r["event"]["fields"]["nativeClockAligned"] = json!(false);
        assert!(!eligible_record(&r, 75.0));
        r["origin"] = json!("native");
        assert!(eligible_record(&r, 75.0));
    }
    #[test]
    fn semantic_room_and_set_elapsed_excludes_operations_started_before_grant() {
        let mut record = export().records.remove(99);
        record["receivedSessionMs"] = json!(200);
        for kind in ["room", "set"] {
            record["event"]["kind"] = json!(kind);
            record["event"]["fields"]["elapsedMs"] = json!(30);
            assert!(
                !eligible_record(&record, 75.0),
                "old operation must not become eligible when its completion arrives late"
            );
            record["event"]["fields"]["elapsedMs"] = json!(20);
            assert!(eligible_record(&record, 75.0));
            record["event"]["durationMs"] = json!(10);
            record["event"]["fields"]["windowMs"] = json!(12);
            record["event"]["fields"]["clockUncertaintyMs"] = json!(5);
            assert!(eligible_record(&record, 75.0));
            record["event"]["fields"]["elapsedMs"] = json!(21);
            assert!(!eligible_record(&record, 75.0));
            record["event"]
                .as_object_mut()
                .unwrap()
                .remove("durationMs");
            record["event"]["fields"]["windowMs"] = json!(0);
            record["event"]["fields"]["clockUncertaintyMs"] = json!(0);
        }
        record["event"]["kind"] = json!("action");
        record["event"]["fields"]["elapsedMs"] = json!(1000);
        assert!(
            eligible_record(&record, 75.0),
            "elapsedMs only represents operation start for room/set semantics"
        );
    }
    #[test]
    fn eligibility_manifest_is_bounded_and_protects_pending_session() {
        let e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let b = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        let mut data = Delivery {
            binding: Some(b.clone()),
            ..Delivery::default()
        };
        next_batch(&mut data, &e, &b, &session).unwrap();
        for _ in 0..MAX_SESSIONS + 2 {
            enroll_session(&mut data, uuid::Uuid::new_v4().to_string(), 0.0);
        }
        assert_eq!(data.binding.as_ref().unwrap().sessions.len(), MAX_SESSIONS);
        assert!(data
            .binding
            .as_ref()
            .unwrap()
            .sessions
            .contains_key(&session));
        assert_eq!(data.pruned_sessions, 3);
    }
    #[tokio::test]
    async fn revocation_invalidates_pending_upload_before_transport_releases() {
        let dir =
            std::env::temp_dir().join(format!("producer-cancel-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = export();
        let (install, session) = export_ids(&e).unwrap();
        let endpoint_id = uuid::Uuid::new_v4().to_string();
        let b = Binding {
            endpoint_id: endpoint_id.clone(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
            context_salt: uuid::Uuid::new_v4().to_string(),
            credential_context: BTreeMap::from([(endpoint_id.clone(), "0".repeat(64))]),
        };
        let path = dir.join("sharing.json");
        let mut data = Delivery {
            binding: Some(b.clone()),
            ..Delivery::default()
        };
        next_batch(&mut data, &e, &b, &session).unwrap();
        save_delivery(&path, &data).unwrap();
        let inner = Arc::new(Transport {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            path,
            data: Mutex::new(data),
            busy: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
        });
        let lease = acquire(&inner).unwrap();
        let in_flight_epoch = inner.epoch.load(Ordering::Acquire);
        assert!(acquire(&inner).is_none());
        assert!(clear_binding(&inner).await.unwrap().is_some());
        assert_ne!(inner.epoch.load(Ordering::Acquire), in_flight_epoch);
        assert!(!inner.path.exists());
        {
            let d = inner.data.lock().unwrap();
            assert!(d.binding.is_none() && d.pending.is_none() && d.cursors.is_empty());
        }
        assert!(acquire(&inner).is_none()); // DELETE waits for the cancelled sender.
        drop(lease);
        assert!(acquire(&inner).is_some());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn exported_file_is_json_and_no_symlink() {
        let dir =
            std::env::temp_dir().join(format!("producer-share-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = export();
        assert!(save_export(&dir.join("report.txt"), &e).is_err());
        let path = dir.join("report.json");
        save_export(&path, &e).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap()["schema"],
            "producer.performance-trace/1"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&path, dir.join("link.json")).unwrap();
            assert!(save_export(&dir.join("link.json"), &e).is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn idle_selection_does_not_create_or_rewrite_spool() {
        let (inner, mut e, binding, session, dir) = transport_fixture();
        e.records.clear();
        let selected = with_delivery(inner.clone(), move |transport, data| {
            prepare_delivery(transport, data, &e, &binding, &session, || true)
        })
        .await
        .unwrap();
        assert!(selected.is_none());
        assert!(
            !inner.path.exists(),
            "idle checks must not create/fsync a spool"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_revoke_cancels_before_waiting_and_clears_serialized_persist() {
        let (inner, e, binding, session, dir) = transport_fixture();
        let epoch = inner.epoch.load(Ordering::Acquire);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let preparing = tokio::spawn(with_delivery(inner.clone(), move |transport, data| {
            let started = std::cell::RefCell::new(Some(started_tx));
            prepare_delivery(transport, data, &e, &binding, &session, || {
                let permitted = transport.epoch.load(Ordering::Acquire) == epoch;
                if let Some(started) = started.borrow_mut().take() {
                    let _ = started.send(());
                    let _ = release_rx.recv_timeout(Duration::from_secs(3));
                }
                permitted
            })
        }));
        started_rx.await.unwrap();
        let revoke_inner = inner.clone();
        let revoked = tokio::spawn(async move { clear_binding(&revoke_inner).await });
        tokio::time::timeout(Duration::from_secs(3), async {
            while inner.epoch.load(Ordering::Acquire) == epoch {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release_tx.send(()).unwrap();
        assert!(
            preparing.await.unwrap().unwrap().is_none(),
            "stale persist cannot publish a sendable pending body"
        );
        assert!(revoked.await.unwrap().unwrap().is_some());
        assert!(!inner.path.exists());
        assert!(with_delivery(inner, |_, data| Ok(
            data.binding.is_none() && data.pending.is_none()
        ))
        .await
        .unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn successful_same_owner_check_preserves_enrollment_and_resumes_authority() {
        let (inner, e, binding, session, dir) = transport_fixture();
        let authority = UploadAuthority::default();
        let ticket = authority.pause();
        let mut data = inner.data.lock().unwrap();
        next_batch(&mut data, &e, &binding, &session).unwrap();
        save_delivery(&inner.path, &data).unwrap();
        let original = fs::read(&inner.path).unwrap();
        apply_auth_check(
            &authority,
            &inner,
            &mut data,
            ticket,
            0,
            true,
            &binding,
            Some((binding.revision, binding.consent_scope_id.clone())),
        )
        .unwrap();
        assert!(!authority.paused());
        assert!(data.pending.is_some());
        assert!(binding_matches(data.binding.as_ref().unwrap(), &binding));
        assert_eq!(fs::read(&inner.path).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn different_missing_or_unverifiable_owner_clears_and_stays_paused() {
        for changed_revision in [false, true] {
            for missing in [false, true] {
                let (inner, e, binding, session, dir) = transport_fixture();
                let authority = UploadAuthority::default();
                let ticket = authority.pause();
                let receipt = if missing {
                    None
                } else if changed_revision {
                    Some((binding.revision + 1, binding.consent_scope_id.clone()))
                } else {
                    Some((binding.revision, uuid::Uuid::new_v4().to_string()))
                };
                let mut data = inner.data.lock().unwrap();
                next_batch(&mut data, &e, &binding, &session).unwrap();
                save_delivery(&inner.path, &data).unwrap();
                apply_auth_check(
                    &authority, &inner, &mut data, ticket, 0, true, &binding, receipt,
                )
                .unwrap();
                assert!(authority.paused());
                assert!(data.binding.is_none() && data.pending.is_none());
                assert!(!inner.path.exists());
                fs::remove_dir_all(dir).unwrap();
            }
        }
    }
    #[test]
    fn auth_fence_exists_before_readiness_and_known_off_skips_verification() {
        assert!(!auth_verification_needed(Some(false)));
        assert!(auth_verification_needed(None));
        assert!(auth_verification_needed(Some(true)));
        let ready = PerformanceShareState {
            ready: Arc::new(tokio::sync::OnceCell::new()),
        };
        let authority = UploadAuthority::default();
        let ticket = authority.pause();
        assert!(ready.current().is_none() && authority.paused());
        let (inner, _, binding, _, dir) = transport_fixture();
        assert!(ready.ready.set(Ok(inner.clone())).is_ok());
        apply_auth_check(
            &authority,
            &inner,
            &mut inner.data.lock().unwrap(),
            ticket,
            0,
            true,
            &binding,
            Some((binding.revision, binding.consent_scope_id.clone())),
        )
        .unwrap();
        assert!(!authority.paused());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_auth_checks_cannot_clear_new_grants_or_resume_after_opt_out() {
        let (inner, _, old, _, dir) = transport_fixture();
        let authority = UploadAuthority::default();
        let old_ticket = authority.pause();
        let grant_ticket = authority.pause();
        inner.epoch.fetch_add(1, Ordering::AcqRel);
        let mut data = inner.data.lock().unwrap();
        let mut fresh = old.clone();
        fresh.consent_scope_id = uuid::Uuid::new_v4().to_string();
        data.binding = Some(fresh.clone());
        save_delivery(&inner.path, &data).unwrap();
        apply_auth_check(
            &authority, &inner, &mut data, old_ticket, 0, true, &old, None,
        )
        .unwrap();
        assert!(binding_matches(data.binding.as_ref().unwrap(), &fresh));
        assert!(inner.path.exists());
        assert!(authority.resume(grant_ticket));
        let off_ticket = authority.pause();
        apply_auth_check(
            &authority,
            &inner,
            &mut data,
            old_ticket,
            0,
            false,
            &old,
            Some((old.revision, old.consent_scope_id.clone())),
        )
        .unwrap();
        apply_auth_check(
            &authority,
            &inner,
            &mut data,
            old_ticket,
            0,
            true,
            &old,
            Some((old.revision, old.consent_scope_id.clone())),
        )
        .unwrap();
        assert!(authority.is_current(off_ticket) && authority.paused());
        assert!(!authority.resume(old_ticket));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn credential_context_proofs_are_salted_private_bounded_and_fail_closed() {
        let (inner, e, mut binding, session, dir) = transport_fixture();
        let token = "test-only-private-credential";
        let context = context_from_credentials(
            &binding.context_salt,
            [Ok((binding.endpoint_id.clone(), token.into()))],
        )
        .unwrap();
        let hash = context.proof[&binding.endpoint_id].clone();
        assert_eq!(hash.len(), 64);
        binding.credential_context = context.proof;
        let mut data = Delivery {
            binding: Some(binding.clone()),
            ..Delivery::default()
        };
        next_batch(&mut data, &e, &binding, &session).unwrap();
        save_delivery(&inner.path, &data).unwrap();
        let stored = fs::read_to_string(&inner.path).unwrap();
        assert!(!stored.contains(token));
        let body = &data.pending.as_ref().unwrap().body;
        assert!(
            !body.to_string().contains(token)
                && !body.to_string().contains(&hash)
                && !body.to_string().contains("credentialContext")
        );
        let over = (0..=MAX_CREDENTIAL_CONTEXT)
            .map(|_| Ok((uuid::Uuid::new_v4().to_string(), token.to_owned())));
        assert!(context_from_credentials(&binding.context_salt, over).is_err());
        assert!(context_from_credentials(
            &binding.context_salt,
            [Err("credential read failed".into())]
        )
        .is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn unchanged_restart_context_and_same_owner_rotation_are_distinguished() {
        let (inner, _, mut binding, _, dir) = transport_fixture();
        let original = context_from_credentials(
            &binding.context_salt,
            [Ok((binding.endpoint_id.clone(), "credential-a-old".into()))],
        )
        .unwrap();
        binding.credential_context = original.proof.clone();
        assert!(changed_credentials(&binding, &original.proof)
            .unwrap()
            .is_empty());
        let rotated = context_from_credentials(
            &binding.context_salt,
            [Ok((binding.endpoint_id.clone(), "credential-a-new".into()))],
        )
        .unwrap();
        assert_eq!(
            changed_credentials(&binding, &rotated.proof).unwrap(),
            vec![binding.endpoint_id.clone()]
        );
        let authority = UploadAuthority::default();
        let ticket = authority.pause();
        let mut data = Delivery {
            binding: Some(binding.clone()),
            ..Delivery::default()
        };
        apply_context_check(
            &authority,
            &inner,
            &mut data,
            ticket,
            0,
            true,
            &binding,
            Some((binding.revision, binding.consent_scope_id.clone())),
            Some(rotated.proof.clone()),
        )
        .unwrap();
        assert!(!authority.paused());
        let loaded = load_delivery(&inner.path).unwrap();
        assert_eq!(loaded.binding.unwrap().credential_context, rotated.proof);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn restarted_nonoverlapping_new_owner_or_removed_credential_cannot_reuse_proof() {
        let (inner, _, mut binding, _, dir) = transport_fixture();
        let owner_a = context_from_credentials(
            &binding.context_salt,
            [Ok((
                binding.endpoint_id.clone(),
                "owner-a-credential".into(),
            ))],
        )
        .unwrap();
        binding.credential_context = owner_a.proof;
        let b = uuid::Uuid::new_v4().to_string();
        let changed = context_from_credentials(
            &binding.context_salt,
            [
                Ok((binding.endpoint_id.clone(), "owner-a-credential".into())),
                Ok((b.clone(), "owner-b-credential".into())),
            ],
        )
        .unwrap();
        assert_eq!(
            changed_credentials(&binding, &changed.proof).unwrap(),
            vec![b]
        );
        assert!(changed_credentials(&binding, &CredentialProof::new()).is_err());
        let authority = UploadAuthority::default();
        let ticket = authority.pause();
        let mut data = Delivery {
            binding: Some(binding.clone()),
            ..Delivery::default()
        };
        save_delivery(&inner.path, &data).unwrap();
        apply_context_check(
            &authority,
            &inner,
            &mut data,
            ticket,
            0,
            true,
            &binding,
            Some((binding.revision, uuid::Uuid::new_v4().to_string())),
            Some(changed.proof),
        )
        .unwrap();
        assert!(authority.paused() && data.binding.is_none() && !inner.path.exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn each_explicit_grant_reads_a_fresh_salted_context() {
        let id = uuid::Uuid::new_v4().to_string();
        let calls = std::cell::Cell::new(0);
        let read = |salt: &str| {
            calls.set(calls.get() + 1);
            context_from_credentials(salt, [Ok((id.clone(), "same-opaque-token".into()))])
        };
        let (first_salt, first) = fresh_context_with(read).unwrap();
        let (second_salt, second) = fresh_context_with(read).unwrap();
        assert_eq!(calls.get(), 2);
        assert_ne!(first_salt, second_salt);
        assert_ne!(first.proof, second.proof);
        assert!(fresh_context_with(|_| Err("failed credential read".into())).is_err());
    }
    #[tokio::test]
    async fn stale_upload_scope_failure_cannot_remove_new_grant() {
        let (inner, _, old, _, dir) = transport_fixture();
        let mut fresh = old.clone();
        fresh.consent_scope_id = uuid::Uuid::new_v4().to_string();
        let expected = fresh.clone();
        inner.epoch.fetch_add(1, Ordering::AcqRel);
        with_delivery(inner.clone(), move |transport, data| {
            data.binding = Some(fresh);
            save_delivery(&transport.path, data)
        })
        .await
        .unwrap();
        clear_current_binding(&inner, 0, old).await.unwrap();
        assert!(with_delivery(inner, move |_, data| Ok(data
            .binding
            .as_ref()
            .is_some_and(|actual| binding_matches(actual, &expected))))
        .await
        .unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
}
