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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    endpoint_id: String,
    installation_id: String,
    revision: u64,
    consent_scope_id: String,
    sessions: BTreeMap<String, f64>,
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
    inner: Arc<Transport>,
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
    inner.epoch.load(Ordering::Acquire) == epoch && performance_trace::sharing_enabled(app)
}
async fn send_allowed(
    app: &tauri::AppHandle,
    inner: &Transport,
    epoch: u64,
    builder: reqwest::RequestBuilder,
) -> Result<Option<reqwest::Response>, String> {
    if !allowed(app, inner, epoch) {
        return Ok(None);
    }
    let pending = builder.send();
    tokio::pin!(pending);
    loop {
        tokio::select! {
            response=&mut pending=>return response.map(Some).map_err(|_|"Diagnostic service could not be reached".into()),
            _=tokio::time::sleep(Duration::from_millis(100))=>if !allowed(app,inner,epoch){return Ok(None);}
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
fn clear_binding(inner: &Transport) -> Result<Option<Binding>, String> {
    let mut data = inner
        .data
        .lock()
        .map_err(|_| "Diagnostic delivery unavailable")?;
    inner.epoch.fetch_add(1, Ordering::AcqRel);
    let old = data.binding.take();
    data.cursors.clear();
    data.pending = None;
    save_delivery(&inner.path, &data)?;
    Ok(old)
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
        && at - duration.max(window) - uncertainty >= cutoff
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
fn prune_retained(data: &mut Delivery, export: &TraceExport) {
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
}
pub fn pruned_sessions(app: &tauri::AppHandle) -> Option<u64> {
    let state = app.try_state::<PerformanceShareState>()?;
    let data = state.inner.data.try_lock().ok()?;
    Some(data.pruned_sessions)
}

/// Init is best effort. No automatic enrollment or upload without an explicit
/// saved enrollment AND current local sharing permission.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    if app.try_state::<PerformanceShareState>().is_some() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Diagnostic storage unavailable")?
        .join("performance-traces");
    fs::create_dir_all(&dir).map_err(|_| "Diagnostic storage unavailable")?;
    let path = dir.join("sharing.json");
    let mut data = load_delivery(&path).unwrap_or_default();
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
    app.manage(PerformanceShareState {
        inner: inner.clone(),
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            if performance_trace::sharing_enabled(&app) {
                let _ = upload_internal(&app, &inner, None).await;
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
    Ok(())
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
    let binding = inner
        .data
        .lock()
        .map_err(|_| "Diagnostic delivery unavailable")?
        .binding
        .clone();
    let Some(binding) = binding else {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
    };
    if endpoint.is_some_and(|id| id != binding.endpoint_id) {
        return Err("Diagnostic sharing is enrolled to another workspace".into());
    }
    let auth = match access(app, &binding.endpoint_id) {
        Ok(a) => a,
        Err(_) => {
            return Ok(ShareReceipt {
                accepted: 0,
                available: false,
            })
        }
    };
    let export = snapshot(app).await?;
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
        let _ = clear_binding(inner);
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
        let pending = {
            let mut data = inner
                .data
                .lock()
                .map_err(|_| "Diagnostic delivery unavailable")?;
            if !allowed(app, inner, epoch) {
                break;
            }
            let mut candidate = data.clone();
            prune_retained(&mut candidate, &export);
            let selected = next_batch(&mut candidate, &export, &binding, &session);
            // Persist exact pending bytes before a request can reach the
            // server, preserving its batchId through crashes and ACK loss.
            save_delivery(&inner.path, &candidate)?;
            *data = candidate;
            selected
        };
        let Some(Pending {
            session: delivery_session,
            body,
            cursors: next,
            count,
        }) = pending
        else {
            break;
        };
        let auth = match access(app, &binding.endpoint_id) {
            Ok(auth) => auth,
            Err(_) => {
                return Ok(ShareReceipt {
                    accepted,
                    available: false,
                })
            }
        };
        let bytes = serde_json::to_vec(&body).map_err(|_| "Could not encode diagnostic batch")?;
        {
            let mut data = inner
                .data
                .lock()
                .map_err(|_| "Diagnostic delivery unavailable")?;
            // Count attempts, including failed/unknown ACKs, across automatic
            // and manual calls. Retried pending payloads cannot form a burst.
            if !take_attempt(&mut data, Instant::now()) {
                break;
            }
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
        let mut data = inner
            .data
            .lock()
            .map_err(|_| "Diagnostic delivery unavailable")?;
        if data.binding.as_ref().is_none_or(|b| {
            b.endpoint_id != binding.endpoint_id
                || b.revision != binding.revision
                || b.consent_scope_id != binding.consent_scope_id
        }) {
            break;
        }
        let mut candidate = data.clone();
        candidate.cursors.insert(delivery_session, next);
        candidate.pending = None;
        save_delivery(&inner.path, &candidate)?;
        *data = candidate;
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
    state: tauri::State<'_, PerformanceShareState>,
    endpoint_id: String,
) -> Result<ShareReceipt, String> {
    upload_internal(&app, &state.inner, Some(&endpoint_id)).await
}
#[tauri::command]
pub async fn performance_trace_configure_sharing(
    app: tauri::AppHandle,
    state: tauri::State<'_, PerformanceShareState>,
    endpoint_id: String,
) -> Result<ShareReceipt, String> {
    if !performance_trace::sharing_enabled(&app) {
        return Err("Enable diagnostic sharing before enrollment".into());
    }
    let inner = state.inner.clone();
    clear_binding(&inner)?;
    let Some(_busy) = acquire(&inner) else {
        return Err("Diagnostic transport is busy; retry enrollment".into());
    };
    let epoch = inner.epoch.load(Ordering::Acquire);
    let auth = access(&app, &endpoint_id)?;
    let export = snapshot(&app).await?;
    let (installation, _) = export_ids(&export)?;
    let Some(response) = send_allowed(
        &app,
        &inner,
        epoch,
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
    if !allowed(&app, &inner, epoch) {
        return Ok(ShareReceipt {
            accepted: 0,
            available: false,
        });
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
    };
    {
        let mut data = inner
            .data
            .lock()
            .map_err(|_| "Diagnostic delivery unavailable")?;
        if !allowed(&app, &inner, epoch) {
            return Ok(ShareReceipt {
                accepted: 0,
                available: false,
            });
        }
        let mut candidate = data.clone();
        candidate.binding = Some(binding);
        candidate.cursors.clear();
        candidate.pending = None;
        candidate.pruned_sessions = 0;
        save_delivery(&inner.path, &candidate)?;
        *data = candidate;
    }
    Ok(ShareReceipt {
        accepted: 0,
        available: true,
    })
}
#[tauri::command]
pub async fn performance_trace_revoke(
    app: tauri::AppHandle,
    state: tauri::State<'_, PerformanceShareState>,
    endpoint_id: String,
) -> Result<ShareReceipt, String> {
    // Remove local enrollment before network I/O, even if signed out/offline.
    let Some(old) = clear_binding(&state.inner)? else {
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
        if let Some(busy) = acquire(&state.inner) {
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

    let auth = match access(&app, &old.endpoint_id) {
        Ok(a) => a,
        Err(_) => {
            return Ok(ShareReceipt {
                accepted: 0,
                available: false,
            })
        }
    };
    let response = request(&state.inner, &auth, reqwest::Method::DELETE, "/performance")
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
        let b = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
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
        let b = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
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
        let b = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
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
        assert_eq!(saved.as_object().unwrap().len(), 5);
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
        let b = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
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
        let binding = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install.clone(),
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(old_session.clone(), 50.0)]),
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
        let a = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
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
    fn eligibility_manifest_is_bounded_and_protects_pending_session() {
        let e = export();
        let (install, session) = export_ids(&e).unwrap();
        let b = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
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
    #[test]
    fn revocation_invalidates_pending_upload_before_transport_releases() {
        let dir =
            std::env::temp_dir().join(format!("producer-cancel-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let e = export();
        let (install, session) = export_ids(&e).unwrap();
        let b = Binding {
            endpoint_id: uuid::Uuid::new_v4().to_string(),
            installation_id: install,
            revision: 1,
            consent_scope_id: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::from([(session.clone(), 0.0)]),
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
        assert!(clear_binding(&inner).unwrap().is_some());
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
}
