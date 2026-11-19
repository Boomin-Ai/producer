//! Process-owned control services. Blocking submission/IO is for a bounded native
//! control executor, never the UI, renderer or audio callback. No media is opened.
use crate::{
    bounded::{Message, Observers},
    commands::Command,
    contract::*,
    coordinator::{Coordinator, HistoryStatus, RevokeFence, Status},
    storage::*,
    workspace::{Workspace, WorkspaceStatus},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    io::Write,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex, MutexGuard, TryLockError, Weak,
    },
};

pub const DOCUMENTS: usize = 2;
pub const SESSIONS: usize = 8;
pub const SESSIONS_PER_DOCUMENT: usize = 4;
pub const OBSERVERS: usize = 8;
pub const OBSERVERS_PER_DOCUMENT: usize = 4;
pub const SUBMISSIONS: usize = 16;
pub const FLIGHTS: usize = 8;
pub const WAITERS: usize = 8;
pub const WIRE_BYTES: usize = 32 * 1024 * 1024;
pub const READ_BYTES: usize = 64 * 1024 * 1024;
/// Conservative *encoded* retained allowance, not allocated RSS/VRAM. Includes
/// bounded document/history/receipts, test-memory journal and observer projection.
pub const RETAINED_ENCODED_PER_DOCUMENT: usize = 272 * 1024 * 1024;
/// Two writer-owned scratch pools (coordinator and FileStore). This allowance
/// is separate from retained documents and from short-lived request wire bytes.
pub const WRITER_SCRATCH_PER_DOCUMENT: usize = 2 * wire::SCRATCH_BYTES;
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "host", message)
}
#[derive(Debug, Default, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicesStatus {
    pub documents: usize,
    pub sessions: usize,
    pub observers: usize,
    pub submissions: usize,
    pub flights: usize,
    pub waiters: usize,
    pub wire_bytes: usize,
    pub read_bytes: usize,
    pub readers: usize,
    pub retained_encoded_allowance: usize,
    pub writer_scratch_allowance: usize,
}
#[derive(Clone, Copy)]
enum Kind {
    Document,
    Session,
    Observer,
    Submission,
    Flight,
    Waiter,
    Reader,
}
#[derive(Clone, Default)]
struct Quota(Arc<Mutex<ServicesStatus>>);
struct Permit {
    quota: Quota,
    kind: Kind,
    bytes: usize,
}
fn counter(s: &mut ServicesStatus, kind: Kind) -> (&mut usize, usize) {
    match kind {
        Kind::Document => (&mut s.documents, DOCUMENTS),
        Kind::Session => (&mut s.sessions, SESSIONS),
        Kind::Observer => (&mut s.observers, OBSERVERS),
        Kind::Submission => (&mut s.submissions, SUBMISSIONS),
        Kind::Flight => (&mut s.flights, FLIGHTS),
        Kind::Waiter => (&mut s.waiters, WAITERS),
        Kind::Reader => (&mut s.readers, 4),
    }
}
impl Quota {
    fn acquire(&self, kind: Kind) -> Result<Permit> {
        let mut s = self.0.lock().unwrap();
        let (n, limit) = counter(&mut s, kind);
        if *n >= limit {
            return Err(fail("SERVICE_LIMIT", "process service count exhausted"));
        }
        *n += 1;
        if matches!(kind, Kind::Document) {
            s.retained_encoded_allowance += RETAINED_ENCODED_PER_DOCUMENT;
            s.writer_scratch_allowance += WRITER_SCRATCH_PER_DOCUMENT;
        }
        Ok(Permit {
            quota: self.clone(),
            kind,
            bytes: 0,
        })
    }
    fn status(&self) -> ServicesStatus {
        *self.0.lock().unwrap()
    }
}
impl Permit {
    fn bytes(&mut self, bytes: usize) -> Result<()> {
        let mut s = self.quota.0.lock().unwrap();
        let (used, limit) = if matches!(self.kind, Kind::Reader) {
            (&mut s.read_bytes, READ_BYTES)
        } else {
            (&mut s.wire_bytes, WIRE_BYTES)
        };
        let next = used
            .checked_sub(self.bytes)
            .and_then(|n| n.checked_add(bytes))
            .ok_or_else(|| fail("SERVICE_LIMIT", "byte reservation overflow"))?;
        if next > limit {
            return Err(fail(
                "SERVICE_LIMIT",
                "process service byte budget exhausted",
            ));
        }
        *used = next;
        self.bytes = bytes;
        Ok(())
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut s = self.quota.0.lock().unwrap();
        *counter(&mut s, self.kind).0 -= 1;
        if matches!(self.kind, Kind::Document) {
            s.retained_encoded_allowance -= RETAINED_ENCODED_PER_DOCUMENT;
            s.writer_scratch_allowance -= WRITER_SCRATCH_PER_DOCUMENT;
        }
        if matches!(self.kind, Kind::Reader) {
            s.read_bytes -= self.bytes;
        } else {
            s.wire_bytes -= self.bytes;
        }
    }
}
struct CountBytes {
    len: usize,
    max: usize,
}
impl Write for CountBytes {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.len = self
            .len
            .checked_add(b.len())
            .filter(|n| *n <= self.max)
            .ok_or_else(|| std::io::Error::other("encoded byte limit"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encoded<T: Serialize>(v: &T, max: usize) -> Result<usize> {
    let mut w = CountBytes { len: 0, max };
    serde_json::to_writer(&mut w, v)
        .map_err(|_| fail("SERVICE_LIMIT", "encoded payload exceeds service profile"))?;
    Ok(w.len)
}
fn try_lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    match m.try_lock() {
        Ok(g) => Ok(g),
        Err(TryLockError::WouldBlock) => Err(fail(
            "DOCUMENT_BUSY",
            "control work is in progress; retry without blocking the UI",
        )),
        Err(TryLockError::Poisoned(_)) => Err(fail(
            "RECOVERY_REQUIRED",
            "control worker failed; close and recover this document",
        )),
    }
}
struct Session {
    id: String,
    document: String,
    incarnation: u64,
    author: bool,
    active: AtomicBool,
    fence: RevokeFence,
    permit: Mutex<Option<Permit>>,
}
impl Session {
    fn current(&self) -> Result<()> {
        if self.active.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(fail("AUTH_REQUIRED", "session disconnected"))
        }
    }
    fn disconnect(&self) {
        self.active.store(false, Ordering::Release);
        self.fence.disconnect();
    }
    fn release(&self) {
        self.permit.lock().unwrap().take();
    }
}
struct ObserverLink {
    owner: String,
    document: String,
    incarnation: u64,
    active: AtomicBool,
    permit: Mutex<Option<Permit>>,
}
struct Projection {
    observers: Observers,
    links: BTreeMap<String, Arc<ObserverLink>>,
    stale: bool,
}
struct Flight {
    owner: String,
    hash: Digest,
    result: Mutex<Option<Result<Receipt>>>,
    done: Condvar,
}
struct DocumentService<S: Storage> {
    incarnation: u64,
    closing: AtomicBool,
    calls: AtomicUsize,
    failed: AtomicBool,
    coordinator: Mutex<Option<Coordinator<S>>>,
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    projection: Mutex<Projection>,
    flights: Mutex<BTreeMap<String, Arc<Flight>>>,
    permit: Mutex<Option<Permit>>,
}
/// Keeps a service borrow alive through a concurrent submit. Closing revokes
/// session grants first and will not destroy its writer until calls reach zero.
struct Call<'a>(&'a AtomicUsize);
impl Drop for Call<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
impl<S: Storage> DocumentService<S> {
    fn enter(&self) -> Result<Call<'_>> {
        self.calls
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 8).then_some(n + 1)
            })
            .map_err(|_| fail("SERVICE_LIMIT", "eight admitted calls per document"))?;
        let guard = Call(&self.calls);
        if self.closing.load(Ordering::Acquire) {
            return Err(fail("DOCUMENT_CLOSING", "document is closing"));
        }
        if self.failed.load(Ordering::Acquire) {
            return Err(fail(
                "RECOVERY_REQUIRED",
                "submission worker failed; recover the store",
            ));
        }
        Ok(guard)
    }
    fn maintain(&self) {
        if let Ok(mut guard) = self.coordinator.try_lock() {
            if let Some(c) = guard.as_mut() {
                self.sessions.lock().unwrap().retain(|id, s| {
                    if !s.active.load(Ordering::Acquire) {
                        c.disconnect(id);
                        s.release();
                        false
                    } else {
                        true
                    }
                });
            }
        }
        if let Ok(mut p) = self.projection.try_lock() {
            let inactive: Vec<_> = p
                .links
                .iter()
                .filter(|(_, l)| !l.active.load(Ordering::Acquire))
                .map(|(id, _)| id.clone())
                .collect();
            for id in inactive {
                p.observers.disconnect(&id);
                p.links.remove(&id).unwrap().permit.lock().unwrap().take();
            }
        }
    }
}
impl<S: Storage> Drop for DocumentService<S> {
    fn drop(&mut self) {
        // External submit handles may retain a disconnected Session, but must
        // not retain its quota after the last actual document call is gone.
        for s in self
            .sessions
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            s.disconnect();
            s.release();
        }
        for l in self
            .projection
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .links
            .values()
        {
            l.active.store(false, Ordering::Release);
            l.permit.lock().unwrap().take();
        }
    }
}
/// A retained, admitted immutable document read. Holding it keeps its encoded
/// allowance charged even if the source document closes. Not a write authority.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub revision: Counter,
    pub cursor: Counter,
    pub digest: Digest,
    pub read_only: bool,
    pub history: HistoryStatus,
    document: Document,
    #[serde(skip)]
    _permit: Permit,
}
impl Inspection {
    pub fn document(&self) -> &Document {
        &self.document
    }
}
/// Cloneable native control handle; does not keep a closed writer alive. Calls
/// block only on this document's writer or a matching in-flight result. Run it on
/// a bounded control executor. The core never spawns a thread per request.
pub struct Submitter<S: Storage> {
    document: Weak<DocumentService<S>>,
    session: Arc<Session>,
    quota: Quota,
}
/// Trusted transport cleanup capability. Not serializable and not an author
/// grant. Revocation is atomic, including while the writer is blocked in IO.
#[derive(Clone)]
pub struct SessionControl(Arc<Session>);
impl SessionControl {
    pub fn disconnect(&self) {
        self.0.disconnect();
    }
}
impl<S: Storage> Clone for Submitter<S> {
    fn clone(&self) -> Self {
        Self {
            document: self.document.clone(),
            session: self.session.clone(),
            quota: self.quota.clone(),
        }
    }
}
impl<S: Storage> Submitter<S> {
    /// Run only on a bounded writer lane, never the UI or control owner.
    pub fn checkpoint(&self) -> Result<()> {
        self.session.current()?;
        let d = self
            .document
            .upgrade()
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "document closed"))?;
        let _call = d.enter()?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = d
                .coordinator
                .lock()
                .map_err(|_| fail("RECOVERY_REQUIRED", "writer failed"))?;
            self.session.current()?;
            c.as_mut()
                .ok_or_else(|| fail("DOCUMENT_CLOSED", "writer closed"))?
                .checkpoint(&self.session.id)
        }))
        .unwrap_or_else(|_| {
            d.failed.store(true, Ordering::SeqCst);
            Err(fail(
                "RECOVERY_REQUIRED",
                "checkpoint worker failed; recover the store",
            ))
        })
    }
    pub fn submit(&self, ticket: &str, command: &Command, now_ms: u64) -> Result<Receipt> {
        self.session.current()?;
        if uuid::Uuid::parse_str(ticket).is_err() {
            return Err(fail(
                "OUTCOME_EXPIRED_OR_UNKNOWN",
                "native-issued ticket required",
            ));
        }
        let d = self
            .document
            .upgrade()
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "document service closed"))?;
        let _call = d.enter()?;
        let mut request = self.quota.acquire(Kind::Submission)?;
        request.bytes(encoded(
            command,
            if matches!(command, Command::Import { .. } | Command::Restore { .. }) {
                DOCUMENT_BYTES + 1024
            } else {
                COMMAND_BYTES
            },
        )?)?;
        let hash = digest(command)?;
        let (flight, leader, waiter, flight_permit) = {
            let mut flights = d.flights.lock().unwrap();
            if let Some(f) = flights.get(ticket) {
                if f.hash != hash || f.owner != self.session.id {
                    return Err(fail(
                        "PAYLOAD_MISMATCH",
                        "in-flight ticket belongs to another payload/session",
                    ));
                }
                (
                    f.clone(),
                    false,
                    Some(self.quota.acquire(Kind::Waiter)?),
                    None,
                )
            } else {
                if flights.len() >= 4 {
                    return Err(fail("SERVICE_LIMIT", "four in-flight tickets per document"));
                }
                let permit = self.quota.acquire(Kind::Flight)?;
                let f = Arc::new(Flight {
                    owner: self.session.id.clone(),
                    hash,
                    result: Mutex::new(None),
                    done: Condvar::new(),
                });
                flights.insert(ticket.into(), f.clone());
                (f, true, None, Some(permit))
            }
        };
        if !leader {
            let _waiter = waiter;
            let mut result = flight.result.lock().unwrap();
            while result.is_none() {
                result = flight.done.wait(result).unwrap();
            }
            self.session.current()?;
            return result.as_ref().unwrap().clone();
        }
        // Always publish a terminal wakeup, including a panic from a trusted
        // storage adapter after a potentially completed write. Never retry that
        // unknown write in this process; recovery reads its durable receipt.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut guard = d
                .coordinator
                .lock()
                .map_err(|_| fail("RECOVERY_REQUIRED", "writer lock poisoned"))?;
            self.session.current()?;
            let c = guard
                .as_mut()
                .ok_or_else(|| fail("DOCUMENT_CLOSED", "writer closed"))?;
            let before = c.state.cursor;
            let result = c.submit(&self.session.id, ticket, command, now_ms);
            if c.state.cursor != before {
                let mut p = d.projection.lock().unwrap();
                // Observer failure never changes a durable commit to a rejection.
                p.stale = p
                    .observers
                    .publish_with_scratch(
                        &c.state.document,
                        c.state.revision,
                        vec!["document".into()],
                        &mut c.scratch,
                    )
                    .is_err();
            }
            result
        }));
        let result = match result {
            Ok(r) => r,
            Err(_) => {
                d.failed.store(true, Ordering::Release);
                Err(fail(
                    "SAVE_OUTCOME_UNKNOWN",
                    "writer panicked; close and recover before further writes",
                ))
            }
        };
        *flight.result.lock().unwrap() = Some(result.clone());
        flight.done.notify_all();
        {
            let mut flights = d.flights.lock().unwrap();
            flights.remove(ticket);
            // Pending-ticket capacity is released with table removal. Completed
            // results retained by delayed followers are separately bounded by
            // their submission/waiter permits; they must not starve the other
            // document of pending writer capacity.
            drop(flight_permit);
        }
        d.maintain();
        result
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    /// Actual registry lengths, distinct from live capacity reservations.
    pub registered_sessions: usize,
    pub registered_observers: usize,
    pub services: ServicesStatus,
    pub workspace: WorkspaceStatus,
}
/// One process owner. Native adapters must use this path rather than constructing
/// independent coordinators/workspaces. Standalone APIs remain test laboratories.
pub struct ProductionHost<S: Storage> {
    quota: Quota,
    workspace: Workspace,
    documents: BTreeMap<String, Arc<DocumentService<S>>>,
    sessions: BTreeMap<String, Arc<Session>>,
    observers: BTreeMap<String, Arc<ObserverLink>>,
    next: u64,
}
impl<S: Storage> ProductionHost<S> {
    pub fn new() -> Result<Self> {
        Ok(Self {
            quota: Quota::default(),
            workspace: Workspace::new()?,
            documents: BTreeMap::new(),
            sessions: BTreeMap::new(),
            observers: BTreeMap::new(),
            next: 0,
        })
    }
    /// Factory is trusted IO and is invoked only after process admission. It must
    /// target an explicit experimental store, never an ambient application profile.
    pub fn open(
        &mut self,
        id: &str,
        factory: impl FnOnce() -> Result<(S, Snapshot)>,
    ) -> Result<()> {
        if !validate::valid_id(id) {
            return Err(fail("ID", "valid explicit document ID required"));
        }
        if self.documents.contains_key(id) {
            return Err(fail("DOCUMENT_OPEN", "document open or awaiting disposal"));
        }
        let permit = self.quota.acquire(Kind::Document)?;
        let incarnation = self
            .next
            .checked_add(1)
            .ok_or_else(|| fail("GENERATION_EXHAUSTED", "new host required"))?;
        let (storage, state) = factory()?;
        if state.document.id != id {
            return Err(fail("ID", "store identity differs from requested document"));
        }
        encoded(&state, CHECKPOINT_BYTES)?;
        state.validate_receipts()?;
        let mut coordinator = Coordinator::new(state, storage);
        validate::validate_with_scratch(&coordinator.state.document, &mut coordinator.scratch)?;
        let mut observers = Observers::default();
        observers.publish_with_scratch(
            &coordinator.state.document,
            coordinator.state.revision,
            vec![],
            &mut coordinator.scratch,
        )?;
        self.workspace.open(id)?;
        self.next = incarnation;
        self.documents.insert(
            id.into(),
            Arc::new(DocumentService {
                incarnation,
                closing: AtomicBool::new(false),
                calls: AtomicUsize::new(0),
                failed: AtomicBool::new(false),
                coordinator: Mutex::new(Some(coordinator)),
                sessions: Mutex::new(BTreeMap::new()),
                projection: Mutex::new(Projection {
                    observers,
                    links: BTreeMap::new(),
                    stale: false,
                }),
                flights: Mutex::new(BTreeMap::new()),
                permit: Mutex::new(Some(permit)),
            }),
        );
        Ok(())
    }
    fn document(&self, id: &str) -> Result<&Arc<DocumentService<S>>> {
        let d = self
            .documents
            .get(id)
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "open the document first"))?;
        if d.closing.load(Ordering::Acquire) {
            return Err(fail("DOCUMENT_CLOSING", "document closing"));
        }
        Ok(d)
    }
    fn session_link(&self, id: &str) -> Result<&Arc<Session>> {
        let s = self
            .sessions
            .get(id)
            .ok_or_else(|| fail("AUTH_REQUIRED", "authenticated native session required"))?;
        s.current()?;
        if self.document(&s.document)?.incarnation != s.incarnation {
            return Err(fail("AUTH_REQUIRED", "stale document incarnation"));
        }
        Ok(s)
    }
    fn coordinator<T>(
        &self,
        session: &str,
        f: impl FnOnce(&mut Coordinator<S>) -> Result<T>,
    ) -> Result<T> {
        let s = self.session_link(session)?;
        let d = self.document(&s.document)?;
        let _call = d.enter()?;
        let mut c = try_lock(&d.coordinator)?;
        f(c.as_mut()
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "writer closed"))?)
    }
    pub fn session(&mut self, document: &str, author: bool) -> Result<String> {
        self.maintain();
        let permit = self.quota.acquire(Kind::Session)?;
        let d = self.document(document)?;
        let _call = d.enter()?;
        let mut c = try_lock(&d.coordinator)?;
        if d.sessions.lock().unwrap().len() >= SESSIONS_PER_DOCUMENT {
            return Err(fail("SERVICE_LIMIT", "four sessions per document"));
        }
        let (id, fence) = c.as_mut().unwrap().session(author)?;
        let link = Arc::new(Session {
            id: id.clone(),
            document: document.into(),
            incarnation: d.incarnation,
            author,
            active: AtomicBool::new(true),
            fence,
            permit: Mutex::new(Some(permit)),
        });
        d.sessions.lock().unwrap().insert(id.clone(), link.clone());
        drop(c);
        drop(_call);
        self.sessions.insert(id.clone(), link);
        Ok(id)
    }
    pub fn boot(&self, session: &str) -> Result<String> {
        self.coordinator(session, |c| Ok(c.boot.clone()))
    }
    pub fn inspect(&self, session: &str) -> Result<Inspection> {
        let mut permit = self.quota.acquire(Kind::Reader)?;
        self.coordinator(session, |c| {
            permit.bytes(encoded(&c.state.document, DOCUMENT_BYTES)?)?;
            Ok(Inspection {
                revision: c.state.revision,
                cursor: c.state.cursor,
                // Inspection is serialized by this document's control owner.
                // Reuse its bounded scratch instead of allocating an entire
                // canonical document buffer for every retained reader.
                digest: c.scratch.digest(&c.state.document)?,
                read_only: c.read_only,
                history: c.history_status(session)?,
                document: c.state.document.clone(),
                _permit: permit,
            })
        })
    }
    pub fn issue(
        &self,
        session: &str,
        expected: Counter,
        command: &Command,
        now: u64,
    ) -> Result<String> {
        self.session_link(session)?;
        let mut request = self.quota.acquire(Kind::Submission)?;
        request.bytes(encoded(
            command,
            if matches!(command, Command::Import { .. } | Command::Restore { .. }) {
                DOCUMENT_BYTES + 1024
            } else {
                COMMAND_BYTES
            },
        )?)?;
        self.coordinator(session, |c| c.issue(session, expected, command, now))
    }
    pub fn status(&self, session: &str, ticket: &str) -> Result<Status> {
        self.coordinator(session, |c| c.status(session, ticket))
    }
    /// Lightweight history accounting; never clones the authored document.
    pub fn history_status(&self, session: &str) -> Result<HistoryStatus> {
        self.coordinator(session, |c| c.history_status(session))
    }
    pub fn undo_command(&self, session: &str) -> Result<Command> {
        self.coordinator(session, |c| c.undo_command(session))
    }
    pub fn checkpoint(&self, session: &str) -> Result<()> {
        self.coordinator(session, |c| c.checkpoint(session))
    }
    pub fn author_grant(&self, session: &str) -> Result<RevokeFence> {
        let s = self.session_link(session)?;
        let d = self.document(&s.document)?;
        if !s.author || !s.fence.is_current() || d.failed.load(Ordering::Acquire) {
            return Err(fail("FORBIDDEN", "current author capability required"));
        }
        // An uncertain append is checked in the coordinator too; do not lend a
        // runtime capability while its save state is unknown.
        self.coordinator(session, |c| c.author_grant(session))
    }
    pub fn submitter(&self, session: &str) -> Result<Submitter<S>> {
        let s = self.session_link(session)?;
        Ok(Submitter {
            document: Arc::downgrade(self.document(&s.document)?),
            session: s.clone(),
            quota: self.quota.clone(),
        })
    }
    pub fn session_control(&self, session: &str) -> Result<SessionControl> {
        Ok(SessionControl(self.session_link(session)?.clone()))
    }
    pub fn observe(&mut self, session: &str) -> Result<String> {
        self.maintain();
        let s = self.session_link(session)?;
        let d = self.document(&s.document)?;
        let permit = self.quota.acquire(Kind::Observer)?;
        let mut p = try_lock(&d.projection)?;
        if p.stale {
            return Err(fail(
                "OBSERVER_STALE",
                "inspect the document; projection unavailable",
            ));
        }
        if p.links.len() >= OBSERVERS_PER_DOCUMENT {
            return Err(fail("SERVICE_LIMIT", "four observers per document"));
        }
        let id = p.observers.connect()?;
        let link = Arc::new(ObserverLink {
            owner: session.into(),
            document: s.document.clone(),
            incarnation: s.incarnation,
            active: AtomicBool::new(true),
            permit: Mutex::new(Some(permit)),
        });
        p.links.insert(id.clone(), link.clone());
        drop(p);
        self.observers.insert(id.clone(), link);
        Ok(id)
    }
    fn projection<T>(
        &self,
        session: &str,
        observer: &str,
        f: impl FnOnce(&mut Observers) -> Result<T>,
    ) -> Result<T> {
        let s = self.session_link(session)?;
        let l = self
            .observers
            .get(observer)
            .filter(|l| {
                l.owner == session
                    && l.document == s.document
                    && l.incarnation == s.incarnation
                    && l.active.load(Ordering::Acquire)
            })
            .ok_or_else(|| {
                fail(
                    "AUTH_REQUIRED",
                    "observer belongs to another session/incarnation",
                )
            })?;
        let mut p = try_lock(&self.document(&l.document)?.projection)?;
        if p.stale {
            return Err(fail(
                "OBSERVER_STALE",
                "inspect the document; projection unavailable",
            ));
        }
        f(&mut p.observers)
    }
    pub fn observer_poll(&self, session: &str, observer: &str) -> Result<Option<Message>> {
        self.projection(session, observer, |p| p.poll(observer))
    }
    pub fn observer_snapshot(&self, session: &str, observer: &str) -> Result<()> {
        self.projection(session, observer, |p| p.begin_snapshot(observer))
    }
    pub fn observer_complete(
        &self,
        session: &str,
        observer: &str,
        cursor: Counter,
        digest: &str,
    ) -> Result<()> {
        self.projection(session, observer, |p| {
            p.snapshot_complete(observer, cursor, digest)
        })
    }
    pub fn unobserve(&mut self, session: &str, observer: &str) -> Result<()> {
        let s = self.session_link(session)?;
        if !self.observers.get(observer).is_some_and(|l| {
            l.owner == session && l.document == s.document && l.incarnation == s.incarnation
        }) {
            return Err(fail(
                "AUTH_REQUIRED",
                "observer belongs to another session/incarnation",
            ));
        }
        self.observers
            .remove(observer)
            .unwrap()
            .active
            .store(false, Ordering::Release);
        self.maintain();
        Ok(())
    }
    /// Logical disconnect never waits for storage or an observer receiver.
    pub fn disconnect(&mut self, session: &str) -> Result<()> {
        let s = self
            .sessions
            .remove(session)
            .ok_or_else(|| fail("AUTH_REQUIRED", "session absent"))?;
        s.disconnect();
        self.observers.retain(|_, o| {
            if o.owner == session {
                o.active.store(false, Ordering::Release);
                false
            } else {
                true
            }
        });
        self.maintain();
        Ok(())
    }
    pub fn maintain(&mut self) {
        for d in self.documents.values() {
            d.maintain();
        }
    }
    pub fn services(&self) -> ServicesStatus {
        self.quota.status()
    }
    pub fn host_status(&self) -> HostStatus {
        HostStatus {
            registered_sessions: self.sessions.len(),
            registered_observers: self.observers.len(),
            services: self.services(),
            workspace: self.workspace.status(),
        }
    }
    pub fn inspect_services(&self, session: &str) -> Result<HostStatus> {
        self.session_link(session)?;
        Ok(self.host_status())
    }
    /// Compile/prepare through this host's sole workspace and native grant.
    pub fn prepare(
        &mut self,
        session: &str,
        inputs: Option<LayoutInputs>,
        now: u64,
    ) -> Result<Counter> {
        let grant = self.author_grant(session)?;
        let read = self.inspect(session)?;
        let d = read.document.clone();
        self.workspace.submit_with_layout_inputs(
            d.clone(),
            inputs.unwrap_or_else(|| LayoutInputs::empty(&d.id)),
            read.revision,
            now,
            grant,
        )
    }
    pub fn dispatch(&mut self) -> Result<usize> {
        self.workspace.dispatch()
    }
    pub fn poll(&mut self, now: u64) -> Vec<crate::workspace::CompileOutcome> {
        self.maintain();
        self.workspace.poll(now)
    }
    pub fn stop(&mut self, document: &str) -> Result<()> {
        self.workspace.stop(document)
    }
    /// Close admission first. Do not drop a writer or return its allowance while
    /// its in-flight write, observation or media retirement can still own work.
    pub fn close(&mut self, document: &str) -> Result<()> {
        let d = self
            .documents
            .get(document)
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "document absent"))?;
        d.closing.store(true, Ordering::SeqCst);
        let ids: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.document == document)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.disconnect(&id)?;
        }
        self.workspace.close(document)?;
        self.maintain();
        Ok(())
    }
    pub fn finish_close(&mut self, document: &str) -> Result<()> {
        let d = self
            .documents
            .get(document)
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "document absent"))?;
        if !d.closing.load(Ordering::Acquire) || d.calls.load(Ordering::SeqCst) != 0 {
            return Err(fail(
                "DOCUMENT_CLOSING",
                "wait for admitted calls and exact media disposal",
            ));
        }
        self.workspace.finish_close(document)?;
        // Mutex poison cannot make a failed writer immortal. Admission is closed
        // and all admitted calls have returned; drop its possibly-written store.
        d.coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        for s in d.sessions.lock().unwrap().values() {
            s.release();
        }
        d.sessions.lock().unwrap().clear();
        let mut p = d.projection.lock().unwrap_or_else(|e| e.into_inner());
        for l in p.links.values() {
            l.permit.lock().unwrap().take();
        }
        p.links.clear();
        p.observers = Observers::default();
        drop(p);
        d.permit.lock().unwrap().take();
        self.documents.remove(document);
        Ok(())
    }
}
impl<S: Storage> Drop for ProductionHost<S> {
    fn drop(&mut self) {
        for s in self.sessions.values() {
            s.disconnect();
        }
        for o in self.observers.values() {
            o.active.store(false, Ordering::Release);
        }
        for d in self.documents.values() {
            d.closing.store(true, Ordering::SeqCst);
        }
        // Active submitters retain the writer reservation until their call exits.
        // Workspace Drop fences and joins compile workers independently.
    }
}
