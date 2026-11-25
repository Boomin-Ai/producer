//! Bounded native control service. No UI/media/GPU linkage or listening socket.
pub mod frame;
pub mod protocol;
use producer_production_core::{
    contract::*,
    host::{ProductionHost, SessionControl, Submitter},
    storage::Storage,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    io::{self, Write},
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const FRAME_BYTES: usize = DOCUMENT_BYTES + 64 * 1024;
pub const REPLY_BYTES: usize = DOCUMENT_BYTES + 64 * 1024;
pub const CLIENTS: usize = 8;
pub const REQUESTS: usize = 16;
pub const REQUESTS_PER_CLIENT: usize = 4;
pub const INPUT_BYTES: usize = 18 * 1024 * 1024;
pub const WRITER_QUEUE: usize = 4;
const PENDING: u8 = 0;
const RUNNING: u8 = 1;
const DONE: u8 = 2;
const CANCELLED: u8 = 3;
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "service", message)
}
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub requests: usize,
    pub input_bytes: usize,
    pub reply_allowance: usize,
    pub cached_reply_bytes: usize,
    pub writer_pending: usize,
    pub stops_applied: usize,
    pub accepting: bool,
}
struct Document {
    id: String,
    stop: AtomicBool,
    closing: AtomicBool,
    stops: AtomicUsize,
    pending: AtomicUsize,
    bytes: AtomicUsize,
}
struct Context {
    document: usize,
    author: bool,
    closed: AtomicBool,
    pending: AtomicUsize,
    sessions: Mutex<BTreeMap<String, SessionControl>>,
}
impl Context {
    fn retired(&self) -> bool {
        self.closed.load(Ordering::Acquire)
            && self.pending.load(Ordering::Acquire) == 0
            && lock(&self.sessions).is_empty()
    }
    fn disconnect(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for control in lock(&self.sessions).values() {
            control.disconnect();
        }
    }
}
struct Queued {
    bytes: Box<[u8]>,
    work: Arc<Work>,
}
#[derive(Default)]
struct Queue {
    items: VecDeque<Queued>,
    // Keep disconnected scopes until the owner has removed their host sessions.
    clients: Vec<Arc<Context>>,
}
struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    accepting: AtomicBool,
    requests: AtomicUsize,
    bytes: AtomicUsize,
    io_pending: AtomicUsize,
    reply_buffers: Mutex<Vec<Vec<u8>>>,
    cached_reply_bytes: AtomicUsize,
    documents: Vec<Document>,
}
impl Shared {
    fn status(&self) -> ServiceStatus {
        ServiceStatus {
            requests: self.requests.load(Ordering::Acquire),
            input_bytes: self.bytes.load(Ordering::Acquire),
            reply_allowance: self.requests.load(Ordering::Acquire) * REPLY_BYTES,
            cached_reply_bytes: self.cached_reply_bytes.load(Ordering::Acquire),
            writer_pending: self.io_pending.load(Ordering::Acquire),
            stops_applied: self
                .documents
                .iter()
                .map(|d| d.stops.load(Ordering::Acquire))
                .sum(),
            accepting: self.accepting.load(Ordering::Acquire),
        }
    }
    fn shutdown(&self) {
        self.accepting.store(false, Ordering::SeqCst);
        let clients: Vec<_> = lock(&self.queue).clients.to_vec();
        for c in clients {
            c.disconnect();
        }
        self.wake.notify_all();
    }
}
/// At most REQUESTS buffers exist across active serialization, unread replies
/// and the free pool. Buffers return before the request permit can be released.
struct ReplyBytes {
    bytes: Vec<u8>,
    shared: Arc<Shared>,
}
impl Drop for ReplyBytes {
    fn drop(&mut self) {
        self.bytes.clear();
        // Consumer/UI drop must not wait for a worker. Contention discards the
        // capacity; the next checkout may replace it with an empty buffer.
        if let Ok(mut pool) = self.shared.reply_buffers.try_lock() {
            if pool.len() < REQUESTS {
                self.shared
                    .cached_reply_bytes
                    .fetch_add(self.bytes.capacity(), Ordering::AcqRel);
                pool.push(std::mem::take(&mut self.bytes));
            }
        }
    }
}
struct ReplyWriter<'a>(&'a mut Vec<u8>);
impl Write for ReplyWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let len = self
            .0
            .len()
            .checked_add(bytes.len())
            .filter(|n| *n <= REPLY_BYTES)
            .ok_or_else(|| io::Error::other("response exceeds transport budget"))?;
        if len > self.0.capacity() {
            let capacity = len.next_power_of_two().min(REPLY_BYTES);
            self.0
                .try_reserve_exact(capacity - self.0.len())
                .map_err(io::Error::other)?;
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct Permit {
    shared: Arc<Shared>,
    client: Arc<Context>,
    bytes: usize,
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.shared.requests.fetch_sub(1, Ordering::AcqRel);
        self.shared.bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        self.client.pending.fetch_sub(1, Ordering::AcqRel);
        self.shared.documents[self.client.document]
            .pending
            .fetch_sub(1, Ordering::AcqRel);
        self.shared.documents[self.client.document]
            .bytes
            .fetch_sub(self.bytes, Ordering::AcqRel);
        self.shared.wake.notify_all();
    }
}
struct Work {
    phase: AtomicU8,
    reply: Mutex<Option<ReplyBytes>>,
    ready: Condvar,
    permit: Permit,
}
impl Work {
    fn start(&self) -> bool {
        if self.permit.client.closed.load(Ordering::Acquire)
            || !self.permit.shared.accepting.load(Ordering::Acquire)
            || self.permit.shared.documents[self.permit.client.document]
                .closing
                .load(Ordering::Acquire)
        {
            return false;
        }
        self.phase
            .compare_exchange(PENDING, RUNNING, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    fn finish(&self, r: Result<serde_json::Value>) {
        match r {
            Ok(value) => self.finish_ok(&value),
            Err(error) => self.finish_error(&error),
        }
    }
    fn finish_ok<T: Serialize>(&self, value: &T) {
        if self.permit.client.closed.load(Ordering::Acquire) {
            self.finish_error(&fail(
                "AUTH_REQUIRED",
                "transport disconnected; recover native ticket outcome after reconnect",
            ));
            return;
        }
        #[derive(Serialize)]
        struct Success<'a, T> {
            ok: bool,
            result: &'a T,
        }
        self.publish(&Success {
            ok: true,
            result: value,
        });
    }
    fn finish_error(&self, error: &Error) {
        #[derive(Serialize)]
        struct Failure<'a> {
            ok: bool,
            error: &'a Error,
        }
        self.publish(&Failure { ok: false, error });
    }
    fn publish<T: Serialize>(&self, value: &T) {
        let shared = &self.permit.shared;
        let mut bytes = {
            let mut pool = lock(&shared.reply_buffers);
            let bytes = pool.pop().unwrap_or_default();
            shared
                .cached_reply_bytes
                .fetch_sub(bytes.capacity(), Ordering::AcqRel);
            bytes
        };
        bytes.clear();
        if serde_json::to_writer(ReplyWriter(&mut bytes), value).is_err() {
            bytes.clear();
            bytes.extend_from_slice(br#"{"ok":false,"error":{"code":"REPLY_LIMIT","path":"service","message":"response exceeds transport budget"}}"#);
        }
        *lock(&self.reply) = Some(ReplyBytes {
            bytes,
            shared: shared.clone(),
        });
        self.phase.store(DONE, Ordering::Release);
        self.ready.notify_all();
    }
    fn cancelled(&self) {
        self.finish(Err(fail("CANCELLED", "request did not begin execution")));
    }
}
/// One bounded reply slot. Poll from the UI; wait only on a non-UI transport.
/// Dropping/cancelling a pending task prevents execution; running durable work
/// cannot be undone by dropping this handle. Recover its native ticket outcome.
pub struct Task(Option<Arc<Work>>);
impl Task {
    pub fn cancel(&self) -> bool {
        self.0.as_ref().is_some_and(|w| {
            w.phase
                .compare_exchange(PENDING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        })
    }
    pub fn try_take(&mut self) -> Option<Reply> {
        let work = self.0.as_ref()?;
        let bytes = lock(&work.reply).take()?;
        Some(Reply {
            bytes,
            _work: self.0.take().unwrap(),
        })
    }
    pub fn wait(mut self) -> Result<Reply> {
        let work = self
            .0
            .as_ref()
            .ok_or_else(|| fail("TASK_CONSUMED", "reply already taken"))?;
        let mut reply = lock(&work.reply);
        while reply.is_none() {
            reply = work.ready.wait(reply).unwrap_or_else(|e| e.into_inner());
        }
        drop(reply);
        self.try_take()
            .ok_or_else(|| fail("TASK_CONSUMED", "reply already taken"))
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        self.cancel();
    }
}
/// Retains its count/input/reply reservations until the consumer drops it.
pub struct Reply {
    bytes: ReplyBytes,
    _work: Arc<Work>,
}
impl Reply {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes.bytes
    }
}
/// A native-granted transport scope. Never deserialized from JSON. One client
/// cannot reuse another client's sessions, choose another document or mint roles.
pub struct Client {
    context: Arc<Context>,
    shared: Arc<Shared>,
}
/// Rejected admission returns the original allocation for off-callback retry.
pub struct Rejected {
    pub error: Error,
    pub bytes: Box<[u8]>,
}
impl Client {
    pub fn request(&self, bytes: Box<[u8]>) -> Result<Task> {
        self.try_request(bytes).map_err(|rejected| rejected.error)
    }
    pub fn try_request(&self, bytes: Box<[u8]>) -> std::result::Result<Task, Rejected> {
        match self.admit(bytes.len()) {
            Ok(mut queue) => {
                let work = Arc::new(Work {
                    phase: AtomicU8::new(PENDING),
                    reply: Mutex::new(None),
                    ready: Condvar::new(),
                    permit: Permit {
                        shared: self.shared.clone(),
                        client: self.context.clone(),
                        bytes: bytes.len(),
                    },
                });
                queue.items.push_back(Queued {
                    bytes,
                    work: work.clone(),
                });
                drop(queue);
                self.shared.wake.notify_one();
                Ok(Task(Some(work)))
            }
            Err(error) => Err(Rejected { error, bytes }),
        }
    }
    fn admit(&self, bytes: usize) -> Result<std::sync::MutexGuard<'_, Queue>> {
        if bytes > FRAME_BYTES {
            return Err(fail("RAW_LIMIT", "RPC envelope exceeds byte limit"));
        }
        if self.context.closed.load(Ordering::Acquire)
            || !self.shared.accepting.load(Ordering::Acquire)
            || self.shared.documents[self.context.document]
                .closing
                .load(Ordering::Acquire)
        {
            return Err(fail("SERVICE_CLOSED", "transport or document closed"));
        }
        let queue = self
            .shared
            .queue
            .try_lock()
            .map_err(|_| fail("EXECUTOR_BUSY", "control ingress busy; retry"))?;
        // Linearize admission against shutdown while holding the queue lock.
        // A caller may have passed the fast check just before shutdown drained it.
        if self.context.closed.load(Ordering::Acquire)
            || !self.shared.accepting.load(Ordering::Acquire)
            || self.shared.documents[self.context.document]
                .closing
                .load(Ordering::Acquire)
        {
            return Err(fail("SERVICE_CLOSED", "transport or document closed"));
        }
        if self.shared.documents[self.context.document]
            .pending
            .load(Ordering::Acquire)
            >= 8
            || bytes
                > INPUT_BYTES / 2
                    - self.shared.documents[self.context.document]
                        .bytes
                        .load(Ordering::Acquire)
            || self.shared.requests.load(Ordering::Acquire) >= REQUESTS
            || self.context.pending.load(Ordering::Acquire) >= REQUESTS_PER_CLIENT
            || bytes > INPUT_BYTES - self.shared.bytes.load(Ordering::Acquire)
        {
            return Err(fail(
                "EXECUTOR_FULL",
                "bounded request/reply or input allowance exhausted",
            ));
        }
        self.shared.requests.fetch_add(1, Ordering::AcqRel);
        self.shared.bytes.fetch_add(bytes, Ordering::AcqRel);
        self.context.pending.fetch_add(1, Ordering::AcqRel);
        self.shared.documents[self.context.document]
            .pending
            .fetch_add(1, Ordering::AcqRel);
        self.shared.documents[self.context.document]
            .bytes
            .fetch_add(bytes, Ordering::AcqRel);
        Ok(queue)
    }
    /// Coalesced priority intent, independent of normal request/reply capacity.
    /// Applied by the owner at its next control boundary, not a realtime promise.
    pub fn stop(&self) -> Result<()> {
        if !self.context.author {
            return Err(fail("FORBIDDEN", "native author scope required"));
        }
        if self.context.closed.load(Ordering::Acquire)
            || !self.shared.accepting.load(Ordering::Acquire)
            || self.shared.documents[self.context.document]
                .closing
                .load(Ordering::Acquire)
        {
            return Err(fail("SERVICE_CLOSED", "transport closed"));
        }
        self.shared.documents[self.context.document]
            .stop
            .store(true, Ordering::Release);
        self.shared.wake.notify_one();
        Ok(())
    }
    pub fn disconnect(&self) {
        self.context.disconnect();
        self.shared.wake.notify_one();
    }
    pub fn status(&self) -> ServiceStatus {
        self.shared.status()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.disconnect();
    }
}
struct WriterJob<S: Storage> {
    work: Arc<Work>,
    handle: Submitter<S>,
    command: Option<(String, producer_production_core::commands::Command)>,
}
fn writer<S: Storage>(rx: mpsc::Receiver<WriterJob<S>>, shared: Arc<Shared>, start: Instant) {
    while let Ok(job) = rx.recv() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if !job.work.start() {
                return Err(fail("CANCELLED", "writer request did not begin execution"));
            }
            let c = &job.work.permit.client;
            if c.closed.load(Ordering::Acquire)
                || shared.documents[c.document].closing.load(Ordering::Acquire)
                || !shared.accepting.load(Ordering::Acquire)
            {
                return Err(fail("CANCELLED", "writer request revoked before execution"));
            }
            match &job.command {
                Some((ticket, command)) => serde_json::to_value(job.handle.submit(
                    ticket,
                    command,
                    start.elapsed().as_millis() as u64,
                )?)
                .map_err(|_| fail("SERIALIZE", "receipt serialization failed")),
                None => {
                    job.handle.checkpoint()?;
                    Ok(serde_json::json!({"saved":true}))
                }
            }
        }))
        .unwrap_or_else(|_| {
            Err(fail(
                "RECOVERY_REQUIRED",
                "writer failed; recover native ticket outcome",
            ))
        });
        job.work.finish(result);
        shared.io_pending.fetch_sub(1, Ordering::AcqRel);
        shared.wake.notify_one();
    }
}
fn process<S: Storage>(
    host: &mut ProductionHost<S>,
    queued: Queued,
    writers: &[SyncSender<WriterJob<S>>],
    start: Instant,
) {
    let work = &queued.work;
    if !work.start() {
        work.cancelled();
        return;
    }
    let r = ingress::parse_envelope(&queued.bytes, FRAME_BYTES).and_then(|v| {
        serde_json::from_value::<protocol::Request>(v)
            .map_err(|e| Error::new("STRUCTURE", "service", e.to_string()))
    });
    drop(queued.bytes);
    let result = (|| {
        let r = r?;
        let c = &work.permit.client;
        if c.closed.load(Ordering::Acquire) {
            return Err(fail("AUTH_REQUIRED", "transport disconnected"));
        }
        let document = &work.permit.shared.documents[c.document].id;
        if let protocol::Request::Hello {} = r {
            let mut sessions = lock(&c.sessions);
            if c.closed.load(Ordering::Acquire) {
                return Err(fail("AUTH_REQUIRED", "transport disconnected"));
            }
            let session = host.session(document, c.author)?;
            let control = host.session_control(&session)?;
            sessions.insert(session.clone(), control);
            drop(sessions);
            let result = protocol::rpc_hello(host, &session);
            if result.is_err() || c.closed.load(Ordering::Acquire) {
                let _ = host.disconnect(&session);
                lock(&c.sessions).remove(&session);
                return result.and(Err(fail("AUTH_REQUIRED", "transport disconnected")));
            }
            return result;
        }
        let session = r.session();
        if !lock(&c.sessions).contains_key(session) {
            return Err(fail(
                "AUTH_REQUIRED",
                "session belongs to another transport",
            ));
        }
        if let protocol::Request::Inspect { session } = &r {
            // Stream the admitted immutable view directly. Constructing a second
            // Value tree and cloning an 8 MiB scratch output per read causes
            // large transient allocations and unnecessary serialized work.
            work.finish_ok(&host.inspect(session)?);
            return Ok(None);
        }
        if matches!(
            r,
            protocol::Request::Submit { .. } | protocol::Request::Checkpoint { .. }
        ) {
            let handle = host.submitter(session)?;
            let command = match r {
                protocol::Request::Submit {
                    ticket, command, ..
                } => Some((ticket, command)),
                _ => None,
            };
            let job = WriterJob {
                work: work.clone(),
                handle,
                command,
            };
            work.phase.store(PENDING, Ordering::Release);
            work.permit.shared.io_pending.fetch_add(1, Ordering::AcqRel);
            if writers[c.document].try_send(job).is_err() {
                work.permit.shared.io_pending.fetch_sub(1, Ordering::AcqRel);
                return Err(fail(
                    "EXECUTOR_FULL",
                    "document writer queue full; request did not execute",
                ));
            }
            return Ok(None);
        }
        let disconnected = if let protocol::Request::Disconnect { session } = &r {
            Some(session.clone())
        } else {
            None
        };
        let v = protocol::rpc(
            host,
            document,
            c.author,
            r,
            start.elapsed().as_millis() as u64,
        )?;
        if let Some(session) = disconnected {
            lock(&c.sessions).remove(&session);
        }
        Ok(Some(v))
    })();
    match result {
        Ok(None) => {}
        Ok(Some(v)) => work.finish(Ok(v)),
        Err(e) => work.finish(Err(e)),
    }
}
/// Thread ownership lives here, outside the pure document/runtime crates.
pub struct Executor {
    shared: Arc<Shared>,
    handles: Vec<JoinHandle<()>>,
}
impl Executor {
    /// Trusted native startup opens stores on the owner thread. No paths, roles
    /// or arbitrary callbacks can be supplied by a protocol request.
    pub fn spawn<S, F>(documents: Vec<String>, factory: F) -> Result<Self>
    where
        S: Storage + Send + 'static,
        F: FnOnce() -> Result<ProductionHost<S>> + Send + 'static,
    {
        if documents.is_empty()
            || documents.len() > 2
            || documents.iter().any(|d| !validate::valid_id(d))
            || documents
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != documents.len()
        {
            return Err(fail(
                "ID",
                "one or two unique native document scopes required",
            ));
        }
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::default()),
            wake: Condvar::new(),
            accepting: AtomicBool::new(true),
            requests: AtomicUsize::new(0),
            bytes: AtomicUsize::new(0),
            io_pending: AtomicUsize::new(0),
            reply_buffers: Mutex::new((0..REQUESTS).map(|_| Vec::new()).collect()),
            cached_reply_bytes: AtomicUsize::new(0),
            documents: documents
                .into_iter()
                .map(|id| Document {
                    id,
                    stop: AtomicBool::new(false),
                    closing: AtomicBool::new(false),
                    stops: AtomicUsize::new(0),
                    pending: AtomicUsize::new(0),
                    bytes: AtomicUsize::new(0),
                })
                .collect(),
        });
        let start = Instant::now();
        let mut writers = Vec::new();
        let mut handles = Vec::new();
        for n in 0..shared.documents.len() {
            let (tx, rx) = mpsc::sync_channel(WRITER_QUEUE);
            let s = shared.clone();
            handles.push(
                thread::Builder::new()
                    .name(format!("production-writer-{n}"))
                    .spawn(move || writer::<S>(rx, s, start))
                    .map_err(|_| fail("THREAD", "cannot start bounded writer lane"))?,
            );
            writers.push(tx);
        }
        let s = shared.clone();
        handles.push(
            thread::Builder::new()
                .name("production-control".into())
                .spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        owner(s.clone(), writers, factory, start)
                    }));
                    if result.is_err() {
                        s.shutdown();
                        cancel_queue(
                            &s,
                            "RECOVERY_REQUIRED",
                            "control owner failed; recover store/ticket outcome",
                        );
                    }
                })
                .map_err(|_| fail("THREAD", "cannot start control owner"))?,
        );
        Ok(Self { shared, handles })
    }
    pub fn connect(&self, document: &str, author: bool) -> Result<Client> {
        let document = self
            .shared
            .documents
            .iter()
            .position(|d| d.id == document)
            .ok_or_else(|| fail("AUTH_REQUIRED", "native document scope absent"))?;
        if !self.shared.accepting.load(Ordering::Acquire)
            || self.shared.documents[document]
                .closing
                .load(Ordering::Acquire)
        {
            return Err(fail("SERVICE_CLOSED", "service/document closing"));
        }
        let mut q = self
            .shared
            .queue
            .try_lock()
            .map_err(|_| fail("EXECUTOR_BUSY", "control ingress busy; retry"))?;
        if !self.shared.accepting.load(Ordering::Acquire)
            || self.shared.documents[document]
                .closing
                .load(Ordering::Acquire)
        {
            return Err(fail("SERVICE_CLOSED", "service/document closing"));
        }
        q.clients.retain(|c| !c.retired());
        if q.clients.len() >= CLIENTS
            || q.clients.iter().filter(|c| c.document == document).count() >= 4
        {
            return Err(fail("SERVICE_LIMIT", "eight retained transport scopes"));
        }
        let context = Arc::new(Context {
            document,
            author,
            closed: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            sessions: Mutex::new(BTreeMap::new()),
        });
        q.clients.push(context.clone());
        Ok(Client {
            context,
            shared: self.shared.clone(),
        })
    }
    pub fn status(&self) -> ServiceStatus {
        self.shared.status()
    }
    pub fn close_document(&self, document: &str) -> Result<()> {
        let n = self
            .shared
            .documents
            .iter()
            .position(|d| d.id == document)
            .ok_or_else(|| fail("ID", "document scope absent"))?;
        self.shared.documents[n]
            .closing
            .store(true, Ordering::SeqCst);
        let clients: Vec<_> = lock(&self.shared.queue)
            .clients
            .iter()
            .filter(|c| c.document == n)
            .cloned()
            .collect();
        for c in clients {
            c.disconnect();
        }
        self.shared.wake.notify_one();
        Ok(())
    }
    /// Explicit off-UI drain. Drop only signals shutdown and never joins IO.
    pub fn shutdown(mut self) -> Shutdown {
        self.shared.shutdown();
        Shutdown {
            handles: std::mem::take(&mut self.handles),
        }
    }
}
impl Drop for Executor {
    fn drop(&mut self) {
        self.shared.shutdown();
    }
}
pub struct Shutdown {
    handles: Vec<JoinHandle<()>>,
}
impl Shutdown {
    pub fn join(self) -> Result<()> {
        for h in self.handles {
            h.join()
                .map_err(|_| fail("THREAD", "control service thread failed"))?;
        }
        Ok(())
    }
}
fn cancel_queue(s: &Shared, code: &str, message: &str) {
    let items: Vec<_> = lock(&s.queue).items.drain(..).collect();
    for q in items {
        q.work.finish(Err(fail(code, message)));
    }
}
fn owner<S, F>(
    shared: Arc<Shared>,
    writers: Vec<SyncSender<WriterJob<S>>>,
    factory: F,
    start: Instant,
) where
    S: Storage + Send + 'static,
    F: FnOnce() -> Result<ProductionHost<S>>,
{
    let mut host = match factory() {
        Ok(h) => h,
        Err(_) => {
            shared.shutdown();
            cancel_queue(
                &shared,
                "STARTUP_FAILED",
                "native store startup failed; inspect local startup diagnostics",
            );
            return;
        }
    };
    let mut closed = std::collections::BTreeSet::new();
    loop {
        let clients: Vec<_> = lock(&shared.queue).clients.to_vec();
        for c in clients.iter().filter(|c| c.closed.load(Ordering::Acquire)) {
            let sessions: Vec<_> = lock(&c.sessions).keys().cloned().collect();
            for session in sessions {
                let _ = host.disconnect(&session);
                lock(&c.sessions).remove(&session);
            }
        }
        lock(&shared.queue).clients.retain(|c| !c.retired());
        for d in &shared.documents {
            if d.stop.swap(false, Ordering::AcqRel) && host.stop(&d.id).is_ok() {
                d.stops.fetch_add(1, Ordering::Release);
            }
            if (!shared.accepting.load(Ordering::Acquire) || d.closing.load(Ordering::Acquire))
                && !closed.contains(&d.id)
            {
                let _ = host.close(&d.id);
                closed.insert(d.id.clone());
            }
        }
        host.maintain();
        if !shared.accepting.load(Ordering::Acquire) {
            cancel_queue(
                &shared,
                "CANCELLED",
                "service shutting down; queued request did not execute",
            );
            if shared.io_pending.load(Ordering::Acquire) == 0 {
                break;
            }
        }
        let queued = lock(&shared.queue).items.pop_front();
        if let Some(q) = queued {
            let work = q.work.clone();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                process(&mut host, q, &writers, start)
            }))
            .is_err()
            {
                work.finish(Err(fail(
                    "RECOVERY_REQUIRED",
                    "control request failed; recover ticket outcome",
                )));
                shared.shutdown();
            }
        } else {
            let q = lock(&shared.queue);
            let _ = shared
                .wake
                .wait_timeout(q, Duration::from_millis(5))
                .unwrap_or_else(|e| e.into_inner());
        }
    }
    for d in &shared.documents {
        let _ = host.finish_close(&d.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use producer_production_core::storage::{MemoryStore, Snapshot};
    #[test]
    fn reply_writer_never_grows_over_budget_or_appends_a_partial_overlimit_write() {
        let mut bytes = Vec::new();
        let payload = vec![b'x'; REPLY_BYTES - 1];
        ReplyWriter(&mut bytes).write_all(&payload).unwrap();
        assert!(bytes.capacity() <= REPLY_BYTES);
        let len = bytes.len();
        assert!(ReplyWriter(&mut bytes).write_all(b"xx").is_err());
        assert_eq!(bytes.len(), len);
        bytes.clear();
        ReplyWriter(&mut bytes).write_all(b"{}").unwrap();
        assert_eq!(bytes, b"{}");
        assert!(bytes.capacity() <= REPLY_BYTES);
    }
    #[test]
    fn dropped_connections_are_retained_until_host_session_cleanup_then_released() {
        let executor = Executor::spawn(vec!["a".into()], || {
            let mut host = ProductionHost::new()?;
            host.open("a", || {
                Ok((
                    MemoryStore::default(),
                    Snapshot::new(producer_production_core::contract::Document::empty(
                        "a", "Initial",
                    ))?,
                ))
            })?;
            Ok(host)
        })
        .unwrap();
        fn connect(executor: &Executor, author: bool) -> Client {
            loop {
                match executor.connect("a", author) {
                    Ok(c) => return c,
                    Err(e) if e.code == "EXECUTOR_BUSY" => thread::yield_now(),
                    Err(e) => panic!("{e}"),
                }
            }
        }
        fn call(client: &Client, value: serde_json::Value) -> serde_json::Value {
            let bytes = serde_json::to_vec(&value).unwrap();
            let task = loop {
                match client.request(bytes.clone().into_boxed_slice()) {
                    Ok(t) => break t,
                    Err(e) if e.code == "EXECUTOR_BUSY" => thread::yield_now(),
                    Err(e) => panic!("{e}"),
                }
            };
            let reply = task.wait().unwrap();
            let value: serde_json::Value = serde_json::from_slice(reply.bytes()).unwrap();
            assert_eq!(value["ok"], true, "{value}");
            value["result"].clone()
        }
        let monitor = connect(&executor, false);
        let session = call(&monitor, serde_json::json!({"method":"hello"}))["session"].clone();
        for _ in 0..128 {
            let client = connect(&executor, true);
            call(&client, serde_json::json!({"method":"hello"}));
            let weak = Arc::downgrade(&client.context);
            drop(client);
            let end = Instant::now() + Duration::from_secs(15);
            while weak.strong_count() > 0 {
                assert!(Instant::now() < end, "closed transport scope retained");
                thread::yield_now();
            }
            assert_eq!(lock(&executor.shared.queue).clients.len(), 1);
            // Capacity counters alone could look correct even while stale map
            // entries accumulated. Verify the actual host registries too.
            let status = call(
                &monitor,
                serde_json::json!({"method":"services","session":session}),
            );
            assert_eq!(status["registeredSessions"], 1);
            assert_eq!(status["registeredObservers"], 0);
        }
        executor.shutdown().join().unwrap();
    }
}
