//! Opt-in, local performance evidence. This module never controls the engine,
//! opens a device, captures media, or sends data over the network.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, OpenOptions},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const SCHEMA: &str = "producer.performance-trace/1";
const MAX_BATCH: usize = 64;
const MAX_FIELDS: usize = 24;
const ACTIVE_LIMIT: u64 = 4 * 1024 * 1024;
const MAX_EVENTS_PER_SECOND: usize = 512;
const MAX_PENDING: usize = 8;
const NATIVE_STAGE_CAPACITY: usize = 128;
static NATIVE_STAGE_ENABLED: AtomicBool = AtomicBool::new(false);
static NATIVE_STAGE_DROPPED: AtomicU64 = AtomicU64::new(0);
static NATIVE_STAGE_QUEUE: OnceLock<Mutex<VecDeque<NativeStage>>> = OnceLock::new();
static ENGINE_METRIC_ORIGIN: OnceLock<Instant> = OnceLock::new();
static ENGINE_METRIC_UPDATED_US: AtomicU64 = AtomicU64::new(0);

/// Called only after the engine's existing performance snapshot assignment.
/// An independent sampler must distinguish a stalled engine from fresh data.
pub fn engine_metrics_updated() {
    if !NATIVE_STAGE_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(origin) = ENGINE_METRIC_ORIGIN.get() else {
        return;
    };
    ENGINE_METRIC_UPDATED_US.store(
        origin.elapsed().as_micros().min(u64::MAX as u128 - 1) as u64 + 1,
        Ordering::Release,
    );
}
fn engine_metric_age() -> Option<f64> {
    let updated = ENGINE_METRIC_UPDATED_US.load(Ordering::Acquire);
    if updated == 0 {
        return None;
    }
    Some(
        (ENGINE_METRIC_ORIGIN.get()?.elapsed().as_secs_f64() * 1000.0
            - (updated - 1) as f64 / 1000.0)
            .max(0.0),
    )
}

#[derive(Clone, Copy)]
struct NativeStage {
    name: &'static str,
    at: Instant,
    duration: Duration,
    success: Option<bool>,
}
/// Fixed-name engine landmarks only. The disabled path is one atomic load;
/// the enabled path never waits, allocates, formats text, or performs I/O.
pub fn native_stage(name: &'static str, duration: Duration, success: Option<bool>) {
    if !NATIVE_STAGE_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    native_stage_at(name, Instant::now(), duration, success);
}
pub fn native_stage_at(name: &'static str, at: Instant, duration: Duration, success: Option<bool>) {
    if !NATIVE_STAGE_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(queue) = NATIVE_STAGE_QUEUE.get() else {
        return;
    };
    if let Ok(mut queue) = queue.try_lock() {
        if !NATIVE_STAGE_ENABLED.load(Ordering::Acquire) {
            return;
        }
        if queue.len() < NATIVE_STAGE_CAPACITY {
            queue.push_back(NativeStage {
                name,
                at,
                duration,
                success,
            });
            return;
        }
    }
    NATIVE_STAGE_DROPPED.fetch_add(1, Ordering::Relaxed);
}
fn native_collection(enabled: bool) {
    NATIVE_STAGE_ENABLED.store(false, Ordering::Release);
    let queue = NATIVE_STAGE_QUEUE
        .get_or_init(|| Mutex::new(VecDeque::with_capacity(NATIVE_STAGE_CAPACITY)));
    ENGINE_METRIC_ORIGIN.get_or_init(Instant::now);
    ENGINE_METRIC_UPDATED_US.store(0, Ordering::Release);
    if let Ok(mut queue) = queue.lock() {
        queue.clear();
    }
    NATIVE_STAGE_ENABLED.store(enabled, Ordering::Release);
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Consent {
    installation_id: String,
    #[serde(default)]
    local: bool,
    #[serde(default)]
    sharing: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceConfig {
    pub enabled: bool,
    pub sharing: bool,
    pub session_id: String,
    pub version: String,
    pub debug_build: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    pub logical_cores: usize,
    pub session_elapsed_ms: f64,
    pub wall_clock_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    installation_id: String,
    session_id: String,
    version: String,
    debug_build: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_revision: Option<String>,
    os: String,
    arch: String,
    logical_cores: usize,
    started_unix_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceEvent {
    seq: u64,
    at_ms: f64,
    kind: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(default)]
    fields: BTreeMap<String, Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceBatch {
    schema: String,
    session_id: String,
    events: Vec<TraceEvent>,
    #[serde(default)]
    dropped_events: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    accepted: usize,
    dropped: usize,
    enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceExport {
    pub schema: String,
    pub metadata: Value,
    pub records: Vec<Value>,
    pub dropped_events: u64,
    pub truncated: bool,
}

struct Writer {
    dir: PathBuf,
    file: Option<BufWriter<std::fs::File>>,
    header_written: bool,
    bytes: u64,
    history_truncated: bool,
    dropped: u64,
    rate_start: Instant,
    rate_events: usize,
}
struct Inner {
    enabled: AtomicBool,
    sharing: AtomicBool,
    pending: AtomicUsize,
    native_seq: AtomicU64,
    overflow_dropped: AtomicU64,
    started: Instant,
    metadata: Metadata,
    writer: Mutex<Writer>,
}
pub struct PerformanceTrace {
    inner: Arc<Inner>,
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn valid_revision(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn safe_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !matches!(value, "__proto__" | "prototype" | "constructor")
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
}
fn safe_event_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.as_bytes()[0].is_ascii_alphabetic()
        && !value.contains("://")
        && !matches!(value, "constructor" | "prototype" | "__proto__")
        && value.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    b'.' | b'_' | b':' | b'-' | b'/' | b'|' | b'[' | b']' | b'+'
                )
        })
}
fn safe_field_name(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 40
        || !value.as_bytes()[0].is_ascii_alphabetic()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return false;
    }
    let words = value.chars().fold(String::new(), |mut out, c| {
        if c.is_ascii_uppercase() {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
        out
    });
    !words.split('_').any(|word| {
        matches!(
            word,
            "id" | "token"
                | "secret"
                | "url"
                | "path"
                | "email"
                | "text"
                | "label"
                | "value"
                | "args"
                | "result"
                | "__proto__"
                | "prototype"
                | "constructor"
        )
    })
}

fn validate(batch: &TraceBatch, session: &str) -> Result<(), String> {
    if batch.schema != SCHEMA
        || batch.session_id != session
        || batch.events.len() > MAX_BATCH
        || batch.dropped_events > 1_000_000_000
    {
        return Err("Invalid performance trace batch".into());
    }
    let mut last = None;
    for event in &batch.events {
        if event.seq > 9_007_199_254_740_991
            || last.is_some_and(|n| event.seq <= n)
            || !event.at_ms.is_finite()
            || !(0.0..=1e15).contains(&event.at_ms)
            || !safe_event_name(&event.name)
            || !matches!(
                event.kind.as_str(),
                "session"
                    | "action"
                    | "span_start"
                    | "span_end"
                    | "ipc"
                    | "presentation_opportunity"
                    | "loop_lag"
                    | "observer"
                    | "room"
                    | "set"
                    | "native_metric"
            )
            || event.span_id.as_ref().is_some_and(|s| !safe_token(s, 96))
            || event.action_id.as_ref().is_some_and(|s| !safe_token(s, 96))
            || event
                .duration_ms
                .is_some_and(|n| !n.is_finite() || !(0.0..=1e15).contains(&n))
            || event.status.as_ref().is_some_and(|s| {
                !matches!(
                    s.as_str(),
                    "ok" | "error"
                        | "cancelled"
                        | "timeout"
                        | "start"
                        | "end"
                        | "pending"
                        | "success"
                        | "failure"
                        | "observed"
                        | "unobserved"
                )
            })
            || event.fields.len() > MAX_FIELDS
        {
            return Err("Invalid performance trace event".into());
        }
        last = Some(event.seq);
        for (key, value) in &event.fields {
            if !safe_field_name(key)
                || !(value.is_boolean()
                    || value
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n.abs() <= 1e15))
            {
                return Err("Performance trace fields must be bounded numbers or booleans".into());
            }
        }
    }
    Ok(())
}
fn private_file(path: &Path, append: bool) -> std::io::Result<std::fs::File> {
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid performance trace file",
        ));
    }
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        #[cfg(target_os = "macos")]
        options.custom_flags(0x00000100); // O_NOFOLLOW, sys/fcntl.h.
    }
    options.open(path)
}
fn save_consent(dir: &Path, consent: &Consent) -> Result<(), String> {
    let pending = dir.join(format!("settings.{}.tmp", uuid::Uuid::new_v4()));
    let mut f = private_file(&pending, false).map_err(|_| "Could not save performance consent")?;
    serde_json::to_writer(&mut f, consent).map_err(|_| "Could not save performance consent")?;
    f.sync_all()
        .map_err(|_| "Could not save performance consent")?;
    fs::rename(pending, dir.join("settings.json"))
        .map_err(|_| "Could not save performance consent".into())
}
fn load_consent(dir: &Path) -> Option<Consent> {
    let path = dir.join("settings.json");
    let stat = fs::symlink_metadata(&path).ok()?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 4096 {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(4097)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    serde_json::from_slice::<Consent>(&bytes)
        .ok()
        .filter(|c| uuid::Uuid::parse_str(&c.installation_id).is_ok())
}
pub(crate) fn sanitized_record(value: Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("schema")?.as_str()? != SCHEMA {
        return None;
    }
    match object.get("type")?.as_str()? {
        "metadata" => {
            if object.len() != 3 {
                return None;
            }
            let metadata: Metadata =
                serde_json::from_value(object.get("metadata")?.clone()).ok()?;
            if uuid::Uuid::parse_str(&metadata.installation_id).is_err()
                || !safe_token(&metadata.session_id, 96)
                || !safe_token(&metadata.version, 48)
                || !safe_token(&metadata.os, 24)
                || !safe_token(&metadata.arch, 24)
                || metadata
                    .source_revision
                    .as_ref()
                    .is_some_and(|s| !valid_revision(s))
                || metadata.logical_cores == 0
                || metadata.logical_cores > 1024
            {
                return None;
            }
            Some(json!({"schema":SCHEMA,"type":"metadata","metadata":metadata}))
        }
        "event" => {
            if object.len() != 6 {
                return None;
            }
            let origin = object.get("origin")?.as_str()?;
            if !matches!(origin, "frontend" | "native") {
                return None;
            }
            let session = object.get("sessionId")?.as_str()?;
            if !safe_token(session, 96) {
                return None;
            }
            let received = object.get("receivedSessionMs")?.as_f64()?;
            if !received.is_finite() || !(0.0..=1e15).contains(&received) {
                return None;
            }
            let event: TraceEvent = serde_json::from_value(object.get("event")?.clone()).ok()?;
            let batch = TraceBatch {
                schema: SCHEMA.into(),
                session_id: session.into(),
                events: vec![event.clone()],
                dropped_events: 0,
            };
            validate(&batch, session).ok()?;
            Some(
                json!({"schema":SCHEMA,"type":"event","origin":origin,"sessionId":session,"receivedSessionMs":received,"event":event}),
            )
        }
        _ => None,
    }
}

impl Writer {
    fn new(dir: PathBuf) -> Self {
        let bytes = fs::metadata(dir.join("trace.jsonl"))
            .map(|s| s.len())
            .unwrap_or(0);
        let history_truncated = dir.join("trace.previous.jsonl").exists();
        Self {
            dir,
            file: None,
            header_written: false,
            bytes,
            history_truncated,
            dropped: 0,
            rate_start: Instant::now(),
            rate_events: 0,
        }
    }
    fn append_line(&mut self, value: &Value, metadata: &Metadata) -> Result<(), String> {
        let mut line =
            serde_json::to_vec(value).map_err(|_| "Could not encode performance event")?;
        line.push(b'\n');
        let mut header =
            serde_json::to_vec(&json!({"schema":SCHEMA,"type":"metadata","metadata":metadata}))
                .map_err(|_| "Could not encode trace metadata")?;
        header.push(b'\n');
        let needed = line.len() as u64
            + if self.header_written {
                0
            } else {
                header.len() as u64
            };
        if self.bytes > 0 && self.bytes.saturating_add(needed) > ACTIVE_LIMIT {
            if let Some(mut file) = self.file.take() {
                file.flush()
                    .map_err(|_| "Could not flush performance trace")?;
            }
            let previous = self.dir.join("trace.previous.jsonl");
            if previous.exists() {
                self.history_truncated = true;
                fs::remove_file(&previous).map_err(|_| "Could not rotate performance trace")?;
            }
            fs::rename(self.dir.join("trace.jsonl"), previous)
                .map_err(|_| "Could not rotate performance trace")?;
            self.bytes = 0;
            self.header_written = false;
        }
        if !self.header_written && header.len() as u64 + line.len() as u64 > ACTIVE_LIMIT {
            return Err("Performance trace record exceeds file limit".into());
        }
        if self.file.is_none() {
            self.file = Some(BufWriter::with_capacity(
                64 * 1024,
                private_file(&self.dir.join("trace.jsonl"), true)
                    .map_err(|_| "Could not write performance trace")?,
            ));
        }
        let file = self.file.as_mut().unwrap();
        if !self.header_written {
            file.write_all(&header)
                .map_err(|_| "Could not write performance trace")?;
            self.bytes += header.len() as u64;
            self.header_written = true;
        }
        file.write_all(&line)
            .map_err(|_| "Could not write performance trace")?;
        self.bytes += line.len() as u64;
        Ok(())
    }

    fn append_batch(
        &mut self,
        inner: &Inner,
        batch: TraceBatch,
        origin: &str,
    ) -> Result<WriteReceipt, String> {
        if !inner.enabled.load(Ordering::Acquire) {
            self.dropped = self
                .dropped
                .saturating_add(batch.events.len() as u64)
                .saturating_add(batch.dropped_events);
            return Ok(WriteReceipt {
                accepted: 0,
                dropped: batch.events.len(),
                enabled: false,
            });
        }
        self.dropped = self.dropped.saturating_add(batch.dropped_events);
        if self.rate_start.elapsed() >= Duration::from_secs(1) {
            self.rate_start = Instant::now();
            self.rate_events = 0;
        }
        let count = batch.events.len();
        let mut accepted = 0;
        for event in batch.events {
            if !inner.enabled.load(Ordering::Acquire) || self.rate_events >= MAX_EVENTS_PER_SECOND {
                self.dropped = self.dropped.saturating_add(1);
                continue;
            }
            let record = json!({"schema":SCHEMA,"type":"event","origin":origin,"sessionId":inner.metadata.session_id,"receivedSessionMs":inner.started.elapsed().as_secs_f64()*1000.0,"event":event});
            self.append_line(&record, &inner.metadata)?;
            self.rate_events += 1;
            accepted += 1;
        }
        if let Some(file) = self.file.as_mut() {
            file.flush()
                .map_err(|_| "Could not flush performance trace")?;
        }
        Ok(WriteReceipt {
            accepted,
            dropped: count - accepted,
            enabled: inner.enabled.load(Ordering::Acquire),
        })
    }
    fn export(&self, metadata: &Metadata) -> Result<TraceExport, String> {
        let mut records = Vec::new();
        let mut truncated = self.history_truncated;
        let mut total = 0;
        for name in ["trace.previous.jsonl", "trace.jsonl"] {
            let path = self.dir.join(name);
            let Ok(stat) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !stat.is_file()
                || stat.file_type().is_symlink()
                || stat.len() > ACTIVE_LIMIT
                || total + stat.len() > ACTIVE_LIMIT * 2
            {
                truncated = true;
                continue;
            }
            let mut data = Vec::new();
            fs::File::open(&path)
                .map_err(|_| "Could not export performance trace")?
                .take(ACTIVE_LIMIT + 1)
                .read_to_end(&mut data)
                .map_err(|_| "Could not export performance trace")?;
            if data.len() as u64 > ACTIVE_LIMIT {
                truncated = true;
                continue;
            }
            total += data.len() as u64;
            for line in data.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
                // Revalidate persisted bytes at export as well as ingest. Old
                // or manually modified files must not inject extra private data.
                match serde_json::from_slice::<Value>(line)
                    .ok()
                    .and_then(sanitized_record)
                {
                    Some(record) => records.push(record),
                    None => truncated = true,
                }
            }
        }
        Ok(TraceExport {
            schema: SCHEMA.into(),
            metadata: serde_json::to_value(metadata).map_err(|_| "Could not export metadata")?,
            records,
            dropped_events: self.dropped,
            truncated,
        })
    }
}
impl Inner {
    fn config(&self) -> TraceConfig {
        TraceConfig {
            enabled: self.enabled.load(Ordering::Acquire),
            sharing: self.enabled.load(Ordering::Acquire) && self.sharing.load(Ordering::Acquire),
            session_id: self.metadata.session_id.clone(),
            version: self.metadata.version.clone(),
            debug_build: self.metadata.debug_build,
            source_revision: self.metadata.source_revision.clone(),
            logical_cores: self.metadata.logical_cores,
            session_elapsed_ms: self.started.elapsed().as_secs_f64() * 1000.0,
            wall_clock_ms: wall_ms(),
        }
    }
}

fn snapshot_fields(
    snapshot: &Value,
    cores: usize,
    metric_age: Option<f64>,
) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    let fresh = metric_age.is_some_and(|age| age <= 2000.0);
    fields.insert("engineMetricsAvailable".into(), json!(metric_age.is_some()));
    fields.insert("engineMetricsFresh".into(), json!(fresh));
    if let Some(age) = metric_age {
        fields.insert("engineMetricsAgeMs".into(), json!(age));
    }
    for (from, to) in [
        ("fps", "fps"),
        ("total_frames", "totalFrames"),
        ("skipped_frames", "skippedFrames"),
        ("render_time_us", "renderTimeUs"),
        ("video_height", "videoHeight"),
        ("video_fps", "videoFps"),
        ("cpu", "cpuMachinePercent"),
    ] {
        if !fresh && !matches!(from, "video_height" | "video_fps") {
            continue;
        }
        if let Some(n) = snapshot
            .get(from)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
        {
            fields.insert(to.into(), json!(n));
        }
    }
    if cfg!(target_os = "macos") && fresh {
        if let Some(cpu) = snapshot
            .get("cpu")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
        {
            fields.insert("cpuCorePercent".into(), json!(cpu * cores as f64));
        }
    }
    for (from, to) in [
        ("engine_ready", "engineReady"),
        ("bootstrap_ok", "bootstrapOk"),
        ("preview_attached", "previewAttached"),
        ("room_mic_pending", "micPending"),
        ("room_mic_failed", "micFailed"),
    ] {
        if let Some(b) = snapshot.get(from).and_then(Value::as_bool) {
            fields.insert(to.into(), json!(b));
        }
    }
    if let Some(items) = snapshot.pointer("/sources/items").and_then(Value::as_array) {
        fields.insert("sourceCount".into(), json!(items.len()));
    }

    fields
}
fn add_capture_health(
    fields: &mut BTreeMap<String, Value>,
    inner: &Inner,
    writer: &Writer,
    pruned_sessions: Option<u64>,
) {
    fields.insert(
        "writerDroppedEvents".into(),
        json!(writer
            .dropped
            .saturating_add(inner.overflow_dropped.load(Ordering::Relaxed))),
    );
    fields.insert("historyTruncated".into(), json!(writer.history_truncated));
    fields.insert(
        "nativeStageDropped".into(),
        json!(NATIVE_STAGE_DROPPED.load(Ordering::Relaxed)),
    );
    fields.insert(
        "writerQueuedBatches".into(),
        json!(inner.pending.load(Ordering::Relaxed)),
    );
    // Engine construction starts before trace initialization. Missing
    // early bootstrap markers cannot be interpreted as a zero cost.
    fields.insert("bootstrapEarlyGapPossible".into(), json!(true));
    if let Some(count) = pruned_sessions {
        fields.insert("sharingPrunedSessions".into(), json!(count));
    }
}

/// Best-effort setup after AppState has been managed. Collection is off by
/// default. An environment switch enables local collection only, never sharing.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    if app.try_state::<PerformanceTrace>().is_some() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Performance storage unavailable")?
        .join("performance-traces");
    fs::create_dir_all(&dir).map_err(|_| "Performance storage unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Performance storage unavailable")?;
    }
    let mut consent = load_consent(&dir).unwrap_or(Consent {
        installation_id: uuid::Uuid::new_v4().to_string(),
        local: false,
        sharing: false,
    });
    consent.sharing &= consent.local;
    save_consent(&dir, &consent)?;
    let inner = Arc::new(Inner {
        enabled: AtomicBool::new(
            consent.local || std::env::var("PRODUCER_PROFILE").as_deref() == Ok("1"),
        ),
        sharing: AtomicBool::new(consent.sharing),
        pending: AtomicUsize::new(0),
        native_seq: AtomicU64::new(0),
        overflow_dropped: AtomicU64::new(0),
        started: Instant::now(),
        metadata: Metadata {
            installation_id: consent.installation_id,
            session_id: uuid::Uuid::new_v4().to_string(),
            version: app.package_info().version.to_string(),
            debug_build: cfg!(debug_assertions),
            source_revision: option_env!("PRODUCER_SOURCE_SHA")
                .filter(|s| valid_revision(s))
                .map(str::to_owned),
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            logical_cores: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1),
            started_unix_ms: wall_ms(),
        },
        writer: Mutex::new(Writer::new(dir)),
    });
    app.manage(PerformanceTrace {
        inner: inner.clone(),
    });
    native_collection(inner.enabled.load(Ordering::Acquire));
    let handle = app.clone();
    std::thread::Builder::new()
        .name("performance-sampler".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            if !inner.enabled.load(Ordering::Acquire) {
                continue;
            }
            let Some(state) = handle.try_state::<crate::AppState>() else {
                continue;
            };
            // This facade reads a cached snapshot. Never invoke live_set_v2 status,
            // whose poll warms surfaces and would change the measured workload.
            let snapshot = state.live.status();
            let mut fields =
                snapshot_fields(&snapshot, inner.metadata.logical_cores, engine_metric_age());
            // Thumbnail counters currently refresh only while streaming, so omit
            // them rather than report stale zeroes as room-preview evidence.
            let Ok(mut writer) = inner.writer.try_lock() else {
                inner.overflow_dropped.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            add_capture_health(
                &mut fields,
                &inner,
                &writer,
                crate::performance_share::pruned_sessions(&handle),
            );
            let mut events = Vec::with_capacity(MAX_BATCH);
            if let Some(queue) = NATIVE_STAGE_QUEUE.get() {
                if let Ok(mut queue) = queue.try_lock() {
                    let count = queue.len().min(MAX_BATCH - 1);
                    for stage in queue.drain(..count) {
                        events.push(TraceEvent {
                            seq: inner.native_seq.fetch_add(1, Ordering::Relaxed),
                            at_ms: stage
                                .at
                                .checked_duration_since(inner.started)
                                .unwrap_or_default()
                                .as_secs_f64()
                                * 1000.0,
                            kind: "native_metric".into(),
                            name: stage.name.into(),
                            span_id: None,
                            action_id: None,
                            duration_ms: Some(stage.duration.as_secs_f64() * 1000.0),
                            status: stage
                                .success
                                .map(|ok| if ok { "ok" } else { "error" }.into()),
                            fields: BTreeMap::new(),
                        });
                    }
                    fields.insert("nativeStageQueued".into(), json!(queue.len()));
                }
            }
            events.push(TraceEvent {
                seq: inner.native_seq.fetch_add(1, Ordering::Relaxed),
                at_ms: inner.started.elapsed().as_secs_f64() * 1000.0,
                kind: "native_metric".into(),
                name: "engine.snapshot".into(),
                span_id: None,
                action_id: None,
                duration_ms: None,
                status: None,
                fields,
            });
            let batch = TraceBatch {
                schema: SCHEMA.into(),
                session_id: inner.metadata.session_id.clone(),
                events,
                dropped_events: 0,
            };
            let _ = writer.append_batch(&inner, batch, "native");
        })
        .map_err(|_| "Could not start performance sampler")?;
    Ok(())
}

#[tauri::command]
pub fn performance_trace_config(state: tauri::State<'_, PerformanceTrace>) -> TraceConfig {
    state.inner.config()
}

#[tauri::command]
pub async fn performance_trace_set_consent(
    state: tauri::State<'_, PerformanceTrace>,
    local: bool,
    sharing: bool,
) -> Result<TraceConfig, String> {
    let sharing = local && sharing;
    let inner = state.inner.clone();
    // Revoke before waiting for any queued writer. A successful return also
    // means all prior writes have left the writer critical section.
    if !sharing {
        inner.sharing.store(false, Ordering::Release);
    }
    if !local {
        inner.enabled.store(false, Ordering::Release);
        native_collection(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = inner
            .writer
            .lock()
            .map_err(|_| "Performance writer unavailable")?;
        if let Some(file) = writer.file.as_mut() {
            file.flush()
                .map_err(|_| "Could not flush performance trace")?;
        }
        save_consent(
            &writer.dir,
            &Consent {
                installation_id: inner.metadata.installation_id.clone(),
                local,
                sharing,
            },
        )?;
        let was_enabled = inner.enabled.swap(local, Ordering::AcqRel);
        if was_enabled != local {
            native_collection(local);
        }
        inner.sharing.store(sharing, Ordering::Release);
        Ok(inner.config())
    })
    .await
    .map_err(|_| "Performance consent task failed".to_string())?
}
#[tauri::command]
pub async fn performance_trace_write(
    state: tauri::State<'_, PerformanceTrace>,
    batch: TraceBatch,
) -> Result<WriteReceipt, String> {
    let inner = state.inner.clone();
    validate(&batch, &inner.metadata.session_id)?;
    let count = batch.events.len();
    if !inner.enabled.load(Ordering::Acquire) {
        inner.overflow_dropped.fetch_add(
            (count as u64).saturating_add(batch.dropped_events),
            Ordering::Relaxed,
        );
        return Ok(WriteReceipt {
            accepted: 0,
            dropped: count,
            enabled: false,
        });
    }
    if inner
        .pending
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < MAX_PENDING).then_some(n + 1)
        })
        .is_err()
    {
        inner
            .overflow_dropped
            .fetch_add(count as u64, Ordering::Relaxed);
        return Ok(WriteReceipt {
            accepted: 0,
            dropped: count,
            enabled: true,
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        struct Pending(Arc<Inner>);
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.pending.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _pending = Pending(inner.clone());
        let mut writer = inner
            .writer
            .lock()
            .map_err(|_| "Performance writer unavailable")?;
        writer.append_batch(&inner, batch, "frontend")
    })
    .await
    .map_err(|_| "Performance writer task failed".to_string())?
}
/// Call from a later authenticated, fixed-endpoint sharing command. No upload
/// is implemented here, and an environment flag cannot grant this permission.
pub fn sharing_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<PerformanceTrace>().is_some_and(|s| {
        s.inner.enabled.load(Ordering::Acquire) && s.inner.sharing.load(Ordering::Acquire)
    })
}
/// Native receipt-clock cutoff for consent-scoped sharing. No wall-clock or
/// room/account identity is used to enroll a capture session.
pub fn capture_position(app: &tauri::AppHandle) -> Option<(String, f64)> {
    app.try_state::<PerformanceTrace>().map(|state| {
        (
            state.inner.metadata.session_id.clone(),
            state.inner.started.elapsed().as_secs_f64() * 1000.0,
        )
    })
}
pub fn export_snapshot(app: &tauri::AppHandle) -> Result<TraceExport, String> {
    let state = app
        .try_state::<PerformanceTrace>()
        .ok_or("Performance diagnostics unavailable")?;
    let writer = state
        .inner
        .writer
        .lock()
        .map_err(|_| "Performance writer unavailable")?;
    let mut export = writer.export(&state.inner.metadata)?;
    export.dropped_events = export
        .dropped_events
        .saturating_add(state.inner.overflow_dropped.load(Ordering::Relaxed));
    export.dropped_events = export
        .dropped_events
        .saturating_add(NATIVE_STAGE_DROPPED.load(Ordering::Relaxed));
    Ok(export)
}
#[tauri::command]
pub async fn performance_trace_export(
    state: tauri::State<'_, PerformanceTrace>,
) -> Result<TraceExport, String> {
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let writer = inner
            .writer
            .lock()
            .map_err(|_| "Performance writer unavailable")?;
        let mut export = writer.export(&inner.metadata)?;
        export.dropped_events = export
            .dropped_events
            .saturating_add(inner.overflow_dropped.load(Ordering::Relaxed));
        export.dropped_events = export
            .dropped_events
            .saturating_add(NATIVE_STAGE_DROPPED.load(Ordering::Relaxed));
        Ok(export)
    })
    .await
    .map_err(|_| "Performance export task failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event() -> TraceEvent {
        TraceEvent {
            seq: 1,
            at_ms: 12.0,
            kind: "action".into(),
            name: "room.open".into(),
            span_id: Some("span-1".into()),
            action_id: None,
            duration_ms: Some(3.0),
            status: Some("ok".into()),
            fields: BTreeMap::from([("count".into(), json!(1))]),
        }
    }
    fn batch() -> TraceBatch {
        TraceBatch {
            schema: SCHEMA.into(),
            session_id: "session-1".into(),
            events: vec![event()],
            dropped_events: 0,
        }
    }
    fn fixture() -> (Arc<Inner>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "producer-performance-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let inner = Arc::new(Inner {
            enabled: AtomicBool::new(true),
            sharing: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            native_seq: AtomicU64::new(0),
            overflow_dropped: AtomicU64::new(0),
            started: Instant::now(),
            metadata: Metadata {
                installation_id: uuid::Uuid::new_v4().to_string(),
                session_id: "session-1".into(),
                version: "test".into(),
                debug_build: true,
                source_revision: None,
                os: "test".into(),
                arch: "test".into(),
                logical_cores: 8,
                started_unix_ms: 1,
            },
            writer: Mutex::new(Writer::new(dir.clone())),
        });
        (inner, dir)
    }
    fn full_snapshot() -> Value {
        json!({"fps":30.0,"total_frames":120,"skipped_frames":2,"render_time_us":516.0,"video_height":720,"video_fps":30,"cpu":23.6,"engine_ready":true,"bootstrap_ok":true,"preview_attached":true,"room_mic_pending":false,"room_mic_failed":false,"sources":{"items":[{},{},{}]}})
    }
    fn full_metric_fields(inner: &Inner, writer: &Writer) -> BTreeMap<String, Value> {
        let mut fields = snapshot_fields(&full_snapshot(), 8, Some(10.0));
        add_capture_health(&mut fields, inner, writer, Some(0));
        fields.insert("nativeStageQueued".into(), json!(0));
        fields
    }
    #[test]
    fn full_snapshot_is_bounded_and_stale_metrics_are_omitted() {
        let (inner, dir) = fixture();
        let fields = full_metric_fields(&inner, &inner.writer.lock().unwrap());
        assert!(fields.len() <= MAX_FIELDS);
        #[cfg(target_os = "macos")]
        assert_eq!(fields.len(), 24);
        let mut b = batch();
        b.events[0].fields = fields;
        assert!(validate(&b, "session-1").is_ok());
        for age in [None, Some(2501.0)] {
            let fields = snapshot_fields(&full_snapshot(), 8, age);
            for name in [
                "fps",
                "totalFrames",
                "skippedFrames",
                "cpuMachinePercent",
                "cpuCorePercent",
                "renderTimeUs",
            ] {
                assert!(!fields.contains_key(name));
            }
            assert_eq!(fields["engineMetricsFresh"], false);
            assert_eq!(fields["engineMetricsAvailable"], age.is_some());
            assert_eq!(fields.contains_key("engineMetricsAgeMs"), age.is_some());
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn validates_privacy_and_bounds() {
        assert!(validate(&batch(), "session-1").is_ok());
        for value in [
            json!("rtmp-secret"),
            json!([1]),
            json!({"token":1}),
            Value::Null,
        ] {
            let mut b = batch();
            b.events[0].fields.insert("durationMs".into(), value);
            assert!(validate(&b, "session-1").is_err());
        }
        for name in ["user@example.com", "https://private/path", "__proto__", ""] {
            let mut b = batch();
            b.events[0].name = name.into();
            assert!(validate(&b, "session-1").is_err());
        }
        let mut b = batch();
        b.events = vec![event(); 65];
        assert!(validate(&b, "session-1").is_err());
        let mut b = batch();
        b.events[0].at_ms = f64::NAN;
        assert!(validate(&b, "session-1").is_err());
        let mut b = batch();
        b.events[0].duration_ms = Some(f64::INFINITY);
        assert!(validate(&b, "session-1").is_err());
        let mut b = batch();
        b.events[0].fields = (0..25).map(|i| (format!("n{i}"), json!(i))).collect();
        assert!(validate(&b, "session-1").is_err());
        assert!(validate(&batch(), "other-session").is_err());
        assert!(serde_json::from_value::<TraceEvent>(
            json!({"seq":1,"atMs":0,"kind":"action","name":"room.open","args":{"secret":"x"}})
        )
        .is_err());
    }
    #[test]
    fn off_stops_writes_and_blocks_sharing() {
        let (inner, dir) = fixture();
        inner.enabled.store(false, Ordering::Release);
        inner.sharing.store(true, Ordering::Release);
        let r = inner
            .writer
            .lock()
            .unwrap()
            .append_batch(&inner, batch(), "frontend")
            .unwrap();
        assert_eq!(r.accepted, 0);
        assert!(!dir.join("trace.jsonl").exists());
        assert!(!inner.config().sharing);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn capped_rate_resumes_without_session_ceiling() {
        let (inner, dir) = fixture();
        let mut w = inner.writer.lock().unwrap();
        w.rate_events = MAX_EVENTS_PER_SECOND;
        assert_eq!(
            w.append_batch(&inner, batch(), "frontend")
                .unwrap()
                .accepted,
            0
        );
        w.rate_start = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            w.append_batch(&inner, batch(), "frontend")
                .unwrap()
                .accepted,
            1
        );
        assert_eq!(w.dropped, 1);
        drop(w);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rotates_bounded_files_and_exports_no_paths() {
        let (inner, dir) = fixture();
        {
            let mut w = inner.writer.lock().unwrap();
            w.append_batch(&inner, batch(), "frontend").unwrap();
            private_file(&dir.join("trace.jsonl"), true)
                .unwrap()
                .set_len(ACTIVE_LIMIT)
                .unwrap();
            w.bytes = ACTIVE_LIMIT;
            w.append_batch(&inner, batch(), "frontend").unwrap();
            assert!(
                fs::metadata(dir.join("trace.previous.jsonl"))
                    .unwrap()
                    .len()
                    <= ACTIVE_LIMIT
            );
            assert!(fs::metadata(dir.join("trace.jsonl")).unwrap().len() <= ACTIVE_LIMIT);
            let e = w.export(&inner.metadata).unwrap();
            assert!(e.records.iter().any(|r| r["type"] == "event"));
            assert!(!serde_json::to_string(&e)
                .unwrap()
                .contains(dir.to_str().unwrap()));
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn export_rejects_injected_private_fields() {
        let (inner, dir) = fixture();
        {
            let mut w = inner.writer.lock().unwrap();
            w.append_batch(&inner, batch(), "frontend").unwrap();
            let mut bad = json!({"schema":SCHEMA,"type":"event","origin":"frontend","sessionId":"session-1","receivedSessionMs":1,"event":event()});
            bad["event"]["fields"]["email"] = json!("private@example.com");
            let mut f = private_file(&dir.join("trace.jsonl"), true).unwrap();
            writeln!(f, "{}", bad).unwrap();
            writeln!(
                f,
                "{}",
                json!({"schema":SCHEMA,"type":"event","secret":"stream-key"})
            )
            .unwrap();
            let export = w.export(&inner.metadata).unwrap();
            assert!(export.truncated);
            let text = serde_json::to_string(&export).unwrap();
            assert!(!text.contains("private@example.com") && !text.contains("stream-key"));
            assert_eq!(
                export
                    .records
                    .iter()
                    .filter(|r| r["type"] == "event")
                    .count(),
                1
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rotation_counts_metadata_header_and_reuses_writer() {
        let (inner, dir) = fixture();
        {
            let mut w = inner.writer.lock().unwrap();
            let record = json!({"schema":SCHEMA,"type":"event","origin":"frontend","sessionId":"session-1","receivedSessionMs":1,"event":event()});
            let line_bytes = serde_json::to_vec(&record).unwrap().len() as u64 + 1;
            private_file(&dir.join("trace.jsonl"), false)
                .unwrap()
                .set_len(ACTIVE_LIMIT - line_bytes)
                .unwrap();
            w.bytes = ACTIVE_LIMIT - line_bytes;
            w.append_line(&record, &inner.metadata).unwrap();
            w.file.as_mut().unwrap().flush().unwrap();
            assert!(
                dir.join("trace.previous.jsonl").exists(),
                "header must be counted before checking capacity"
            );
            assert!(fs::metadata(dir.join("trace.jsonl")).unwrap().len() <= ACTIVE_LIMIT);
            w.append_batch(&inner, batch(), "frontend").unwrap();
            let text = fs::read_to_string(dir.join("trace.jsonl")).unwrap();
            assert_eq!(
                text.lines()
                    .filter(|l| serde_json::from_str::<Value>(l).unwrap()["type"] == "metadata")
                    .count(),
                1
            );
            assert!(w.file.is_some());
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn consent_defaults_and_unknown_fields() {
        let c: Consent =
            serde_json::from_value(json!({"installationId":uuid::Uuid::new_v4().to_string()}))
                .unwrap();
        assert!(!c.local && !c.sharing);
        assert!(serde_json::from_value::<Consent>(
            json!({"installationId":"id","sharing":true,"endpoint":"https://evil"})
        )
        .is_err());
    }
    #[test]
    fn consent_load_and_trace_files_are_bounded_regular_files() {
        let (inner, dir) = fixture();
        let consent = Consent {
            installation_id: inner.metadata.installation_id.clone(),
            local: true,
            sharing: false,
        };
        save_consent(&dir, &consent).unwrap();
        assert!(load_consent(&dir).unwrap().local);
        fs::write(dir.join("settings.json"), vec![b'x'; 4097]).unwrap();
        assert!(load_consent(&dir).is_none());
        #[cfg(unix)]
        {
            let target = dir.join("target.json");
            fs::write(&target, b"unchanged").unwrap();
            fs::remove_file(dir.join("settings.json")).unwrap();
            std::os::unix::fs::symlink(&target, dir.join("settings.json")).unwrap();
            assert!(load_consent(&dir).is_none());
            assert!(private_file(&dir.join("settings.json"), false).is_err());
            assert_eq!(fs::read(target).unwrap(), b"unchanged");
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn native_stages_are_bounded_nonblocking_and_stop_on_opt_out() {
        native_collection(false);
        NATIVE_STAGE_DROPPED.store(0, Ordering::Release);
        native_stage("native.mic.prepare.start", Duration::ZERO, None);
        let queue = NATIVE_STAGE_QUEUE.get().unwrap();
        assert!(queue.lock().unwrap().is_empty());
        native_collection(true);
        let occurred = Instant::now();
        native_stage_at(
            "native.mic.first_packet",
            occurred,
            Duration::from_millis(17),
            Some(true),
        );
        {
            let q = queue.lock().unwrap();
            assert_eq!(q[0].at, occurred);
            assert_eq!(q[0].duration, Duration::from_millis(17));
            assert_eq!(q[0].name, "native.mic.first_packet");
            assert_eq!(q[0].success, Some(true));
            // The callback drops under contention instead of waiting for sampler.
            native_stage("native.mic.attached", Duration::ZERO, Some(true));
            assert_eq!(NATIVE_STAGE_DROPPED.load(Ordering::Acquire), 1);
        }
        for _ in 0..NATIVE_STAGE_CAPACITY {
            native_stage("native.room.restore.start", Duration::ZERO, None);
        }
        assert_eq!(queue.lock().unwrap().len(), NATIVE_STAGE_CAPACITY);
        assert_eq!(NATIVE_STAGE_DROPPED.load(Ordering::Acquire), 2);
        native_collection(false);
        assert!(queue.lock().unwrap().is_empty());
        native_stage("native.room.restore.complete", Duration::ZERO, Some(true));
        assert!(queue.lock().unwrap().is_empty());
    }
    #[test]
    fn native_export_contract_fixture() {
        let (mut inner, dir) = fixture();
        {
            let state = Arc::get_mut(&mut inner).unwrap();
            state.metadata.session_id = uuid::Uuid::new_v4().to_string();
            state.metadata.version = "0.4.83".into();
            state.metadata.os = std::env::consts::OS.into();
            state.metadata.arch = std::env::consts::ARCH.into();
            state.metadata.debug_build = false;
            state.metadata.source_revision = Some("a".repeat(40));
        }
        let mut e = event();
        e.kind = "native_metric".into();
        e.name = "engine.snapshot".into();
        e.fields = full_metric_fields(&inner, &inner.writer.lock().unwrap());
        let b = TraceBatch {
            schema: SCHEMA.into(),
            session_id: inner.metadata.session_id.clone(),
            events: vec![e],
            dropped_events: 0,
        };
        validate(&b, &inner.metadata.session_id).unwrap();
        let mut w = inner.writer.lock().unwrap();
        w.append_batch(&inner, b, "native").unwrap();
        let export = w.export(&inner.metadata).unwrap();
        assert_eq!(
            export
                .records
                .iter()
                .filter(|r| r["type"] == "event")
                .count(),
            1
        );
        if let Ok(path) = std::env::var("PRODUCER_TRACE_FIXTURE_PATH") {
            fs::write(path, serde_json::to_vec_pretty(&export).unwrap()).unwrap();
        }
        drop(w);
        fs::remove_dir_all(dir).unwrap();
    }
}
