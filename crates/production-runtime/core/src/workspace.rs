//! Two-document synthetic runtime host and bounded off-callback compile workers.
//! The desktop app, storage authority, sockets and native adapters are not wired here.
use crate::{
    compile::Plan,
    contract::*,
    coordinator::RevokeFence,
    incremental::{CompileStats, Compiler},
    lifecycle::*,
    ownership::{Lane, ResourceId},
    resources::{Budget, Reservation},
    show::{ShowEvent, ShowRun, ShowSample},
    transport::OutputInstant,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
};

pub const COMPILE_WORKERS: usize = 2;
pub const PENDING_JOBS: usize = 4;
pub const DESCRIPTORS: usize = 16;
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "workspace", message)
}
struct Job {
    id: u64,
    incarnation: u64,
    generation: u64,
    revision: Counter,
    expires: u64,
    document: Document,
    compiler: Compiler,
    cost: Reservation,
    cache_cost: Cost,
    _base_lease: Option<Arc<Reservation>>,
    cancel: Arc<AtomicBool>,
    grant: RevokeFence,
}
struct Finished {
    job: Job,
    result: Result<(Plan, CompileStats)>,
}
struct Running {
    document: String,
    cancel: Arc<AtomicBool>,
}
struct Entry {
    incarnation: u64,
    generation: u64,
    newest: u64,
    desired: Option<(Counter, String)>,
    runtime: Runtime,
    compiler: Compiler,
    cache: Option<Arc<Reservation>>,
    pending: Option<Job>,
    closing: bool,
    show: Option<(ShowRun, Reservation)>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CompileOutcome {
    Prepared {
        job: Counter,
        document: String,
        revision: Counter,
        token: Counter,
        digest: String,
        stats: CompileStats,
    },
    Rejected {
        job: Counter,
        document: String,
        error: Error,
    },
    Discarded {
        job: Counter,
        document: String,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub documents: usize,
    pub closing: usize,
    pub pending: usize,
    pub running: usize,
    pub descriptors: usize,
    pub reservations: usize,
    pub used: Cost,
}
pub struct Workspace {
    budget: Budget,
    entries: BTreeMap<String, Entry>,
    order: VecDeque<String>,
    descriptors: VecDeque<String>,
    running: BTreeMap<u64, Running>,
    next: u64,
    next_incarnation: u64,
    jobs: Option<SyncSender<Job>>,
    finished: Receiver<Finished>,
    workers: Vec<JoinHandle<()>>,
}
impl Workspace {
    pub fn new() -> Result<Self> {
        let (jobs, rx) = mpsc::sync_channel::<Job>(COMPILE_WORKERS);
        let (tx, finished) = mpsc::sync_channel(COMPILE_WORKERS);
        let rx = Arc::new(Mutex::new(rx));
        let mut workers = vec![];
        for i in 0..COMPILE_WORKERS {
            let rx = rx.clone();
            let tx = tx.clone();
            match thread::Builder::new()
                .name(format!("production-compile-{i}"))
                .spawn(move || loop {
                    let Ok(mut job) = rx.lock().unwrap().recv() else {
                        break;
                    };
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        job.compiler.compile_cancellable(&job.document, &job.cancel)
                    }))
                    .unwrap_or_else(|_| {
                        Err(fail(
                            "COMPILE_FAILED",
                            "worker panicked; candidate discarded",
                        ))
                    });
                    if tx.send(Finished { job, result }).is_err() {
                        break;
                    }
                }) {
                Ok(worker) => workers.push(worker),
                Err(_) => {
                    drop(jobs);
                    for worker in workers {
                        let _ = worker.join();
                    }
                    return Err(fail(
                        "WORKER_START",
                        "could not start bounded compile workers",
                    ));
                }
            }
        }
        Ok(Self {
            budget: Budget::new(2),
            entries: BTreeMap::new(),
            order: VecDeque::new(),
            descriptors: VecDeque::new(),
            running: BTreeMap::new(),
            next: 0,
            next_incarnation: 0,
            jobs: Some(jobs),
            finished,
            workers,
        })
    }
    pub fn open(&mut self, id: &str) -> Result<()> {
        // Use native document validation to bound/validate IDs, not an unbounded
        // descriptor string supplied by a UI adapter.
        validate_document(&Document::empty(id, "Workspace"))?;
        if self.entries.contains_key(id) {
            return Err(fail("DOCUMENT_OPEN", "already open or awaiting disposal"));
        }
        let incarnation = self
            .next_incarnation
            .checked_add(1)
            .ok_or_else(|| fail("GENERATION_EXHAUSTED", "new workspace required"))?;
        let ledger = self.budget.ledger()?;
        self.next_incarnation = incarnation;
        self.descriptors.retain(|d| d != id);
        self.entries.insert(
            id.into(),
            Entry {
                incarnation,
                generation: 0,
                newest: 0,
                desired: None,
                runtime: Runtime::with_ledger(ledger),
                compiler: Compiler::default(),
                cache: None,
                pending: None,
                closing: false,
                show: None,
            },
        );
        Ok(())
    }
    fn entry(&self, id: &str) -> Result<&Entry> {
        self.entries
            .get(id)
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "open the document first"))
    }
    fn entry_mut(&mut self, id: &str) -> Result<&mut Entry> {
        self.entries
            .get_mut(id)
            .ok_or_else(|| fail("DOCUMENT_CLOSED", "open the document first"))
    }
    /// At most one latest pending intent per document; replacing it does not
    /// mutate an active/prepared plan. Authority is checked again on completion.
    pub fn submit(
        &mut self,
        document: Document,
        revision: Counter,
        now_ms: u64,
        grant: RevokeFence,
    ) -> Result<Counter> {
        if !grant.is_current() {
            return Err(fail("FORBIDDEN", "current native grant required"));
        }
        let id = document.id.clone();
        let entry = self.entry(&id)?;
        if entry.closing {
            return Err(fail(
                "DOCUMENT_CLOSING",
                "wait for exact disposal before reopening",
            ));
        }
        entry.runtime.check_prepare(&document)?;
        let running = self.running.values().filter(|r| r.document == id).count();
        if entry.runtime.pending_count() + running >= 4 {
            return Err(fail(
                "PREPARE_LIMIT",
                "four prepared/unknown/in-flight plans maximum",
            ));
        }
        if entry.pending.is_none() && self.order.len() >= PENDING_JOBS {
            return Err(fail("COMPILE_QUEUE_FULL", "pending compile capacity"));
        }
        let expires = now_ms
            .checked_add(30_000)
            .ok_or_else(|| fail("TIME_UNREPRESENTABLE", "deadline overflow"))?;
        let cost = crate::lifecycle::estimate(&document)?;
        let digest = digest(&document)?;
        if let Some((old, hash)) = &entry.desired {
            if revision < *old || (revision == *old && hash != &digest) {
                return Err(fail(
                    "STALE_REVISION",
                    "revision cannot rewind or change content at the same revision",
                ));
            }
        }
        let job_id = self
            .next
            .checked_add(1)
            .ok_or_else(|| fail("GENERATION_EXHAUSTED", "new workspace required"))?;
        let entry = self.entries.get_mut(&id).unwrap();
        // Admit before cancelling the previous pending intent. Saturation leaves
        // that intent intact; no temporary uncharged allocation window.
        let lease = entry.runtime.ledger.lease(cost)?;
        let compiler = entry.compiler.clone();
        let cache_cost = Cost {
            cpu: cost.cpu,
            ..Cost::default()
        };
        let job = Job {
            id: job_id,
            incarnation: entry.incarnation,
            generation: entry.generation,
            revision,
            expires,
            document,
            compiler,
            cost: lease,
            cache_cost,
            _base_lease: entry.cache.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            grant,
        };
        if entry.pending.is_none() {
            self.order.push_back(id.clone());
        }
        entry.pending = Some(job);
        entry.newest = job_id;
        entry.desired = Some((revision, digest));
        for running in self.running.values().filter(|r| r.document == id) {
            running.cancel.store(true, Ordering::Release);
        }
        self.next = job_id;
        Ok(Counter(job_id))
    }
    /// Nonblocking dispatch. A completed but unpolled job still occupies its
    /// worker slot, so result memory cannot accumulate behind the control lane.
    pub fn dispatch(&mut self) -> Result<usize> {
        let mut count = 0;
        while self.running.len() < COMPILE_WORKERS {
            let Some(id) = self.order.pop_front() else {
                break;
            };
            let job = self.entries.get_mut(&id).unwrap().pending.take().unwrap();
            let number = job.id;
            let running = Running {
                document: id.clone(),
                cancel: job.cancel.clone(),
            };
            self.jobs
                .as_ref()
                .unwrap()
                .try_send(job)
                .map_err(|_| fail("WORKER_STOPPED", "compile workers unavailable"))?;
            self.running.insert(number, running);
            count += 1;
        }
        Ok(count)
    }
    /// Exact job/incarnation/generation/revision/authority fences precede cache
    /// publication and prepare installation. No worker can directly take output.
    pub fn poll(&mut self, now_ms: u64) -> Vec<CompileOutcome> {
        let mut outcomes = vec![];
        while let Ok(Finished { job, result }) = self.finished.try_recv() {
            self.running.remove(&job.id);
            let id = job.document.id.clone();
            let current = self.entries.get(&id).is_some_and(|e| {
                !e.closing
                    && e.incarnation == job.incarnation
                    && e.generation == job.generation
                    && e.newest == job.id
            });
            if !current || job.cancel.load(Ordering::Acquire) {
                outcomes.push(CompileOutcome::Discarded {
                    job: Counter(job.id),
                    document: id,
                });
                continue;
            }
            let entry = self.entries.get_mut(&id).unwrap();
            let outcome = (|| {
                if !job.grant.is_current() {
                    return Err(fail("FORBIDDEN", "grant changed during compilation"));
                }
                if now_ms > job.expires {
                    return Err(fail("PREPARE_EXPIRED", "compile intent expired"));
                }
                let (plan, stats) = result?;
                let digest = plan.digest.clone();
                let cache = Arc::new(entry.runtime.ledger.lease(job.cache_cost)?);
                let token = entry.runtime.install(
                    &job.document,
                    job.revision,
                    job.expires,
                    job.cost,
                    plan,
                )?;
                entry.compiler = job.compiler;
                entry.cache = Some(cache);
                Ok(CompileOutcome::Prepared {
                    job: Counter(job.id),
                    document: id.clone(),
                    revision: job.revision,
                    token,
                    digest,
                    stats,
                })
            })();
            outcomes.push(outcome.unwrap_or_else(|error| CompileOutcome::Rejected {
                job: Counter(job.id),
                document: id,
                error,
            }));
        }
        outcomes
    }
    /// Independent of pending job capacity. Physical/in-flight reservations stay
    /// charged until workers finish and adapters confirm exact-token disposal.
    pub fn stop(&mut self, id: &str) -> Result<()> {
        let entry = self.entry_mut(id)?;
        if let Some((show, _)) = &mut entry.show {
            show.halt(false);
        }
        if let Some(generation) = entry.generation.checked_add(1) {
            entry.generation = generation;
        } else {
            entry.closing = true;
        }
        entry.pending = None;
        entry.runtime.stop();
        self.order.retain(|d| d != id);
        for r in self.running.values().filter(|r| r.document == id) {
            r.cancel.store(true, Ordering::Release);
        }
        Ok(())
    }
    pub fn close(&mut self, id: &str) -> Result<()> {
        self.stop(id)?;
        let e = self.entry_mut(id)?;
        e.closing = true;
        if let Some((show, _)) = &mut e.show {
            show.halt(true);
        }
        e.compiler.clear();
        e.cache = None;
        e.runtime.discard_superseded();
        Ok(())
    }
    pub fn finish_close(&mut self, id: &str) -> Result<()> {
        let e = self.entry(id)?;
        if !e.closing || e.pending.is_some() || self.running.values().any(|r| r.document == id) {
            return Err(fail(
                "DOCUMENT_CLOSING",
                "stop and await worker/disposal completion",
            ));
        }
        if e.show
            .as_ref()
            .is_some_and(|(show, _)| !show.closed_and_disposed())
        {
            return Err(fail(
                "DOCUMENT_CLOSING",
                "Show ownership disposal acknowledgment required",
            ));
        }
        // Its plan/ownership metadata remains charged through logical close
        // and the exact disposal acknowledgment, then releases before ledger close.
        self.entry_mut(id)?.show = None;
        self.entry(id)?.runtime.ledger.close()?;
        self.entries.remove(id);
        if self.descriptors.len() == DESCRIPTORS {
            self.descriptors.pop_front();
        }
        self.descriptors.push_back(id.into());
        Ok(())
    }
    pub fn status(&self) -> WorkspaceStatus {
        WorkspaceStatus {
            documents: self.entries.len(),
            closing: self.entries.values().filter(|e| e.closing).count(),
            pending: self.order.len(),
            running: self.running.len(),
            descriptors: self.descriptors.len(),
            reservations: self.budget.count(),
            used: self.budget.used(),
        }
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Keep native grant and both clock domains explicit"
    )]
    pub fn load_show(
        &mut self,
        id: &str,
        token: Counter,
        show: &str,
        now_ms: u64,
        at: OutputInstant,
        grant: RevokeFence,
    ) -> Result<()> {
        let e = self.entry_mut(id)?;
        if e.closing
            || e.show
                .as_ref()
                .is_some_and(|(show, _)| !show.closed_and_disposed())
        {
            return Err(fail(
                "SHOW_OPEN",
                "close and dispose the previous execution before replacement",
            ));
        }
        let (revision, digest) = e
            .desired
            .as_ref()
            .ok_or_else(|| fail("PREPARE_STATE", "submit a document first"))?;
        // Fixed conservative CPU-only reservation for pinned immutable plan,
        // Show definition, bounded control transactions and ownership metadata.
        // This creates no additional native players/captures/surfaces.
        let cost = e.runtime.ledger.lease(Cost {
            cpu: 64 << 20,
            ..Cost::default()
        })?;
        let execution = e
            .runtime
            .show_execution(token, *revision, digest, show, now_ms, at, grant)?;
        e.show = Some((execution, cost));
        Ok(())
    }
    pub fn show_event(&mut self, id: &str, event: ShowEvent) -> Result<ShowSample> {
        let e = self.entry_mut(id)?;
        if e.closing {
            return Err(fail("DOCUMENT_CLOSING", "no new Show events while closing"));
        }
        e.show
            .as_mut()
            .ok_or_else(|| fail("SHOW_MISSING", "load a Show first"))?
            .0
            .apply(event)
    }
    pub fn show_disposed(&mut self, id: &str, resource: ResourceId, lane: Lane) -> Result<()> {
        self.entry_mut(id)?
            .show
            .as_mut()
            .ok_or_else(|| fail("SHOW_MISSING", "Show execution absent"))?
            .0
            .disposed(resource, lane)
    }
    pub fn show_status(&self, id: &str) -> Result<ShowSample> {
        self.entry(id)?
            .show
            .as_ref()
            .map(|(show, _)| show.status())
            .ok_or_else(|| fail("SHOW_MISSING", "Show execution absent"))
    }
    /// Only bounded unopened descriptors, not documents/plans, are retained.
    pub fn descriptors(&self, offset: usize, limit: usize) -> Vec<&str> {
        self.descriptors
            .iter()
            .skip(offset)
            .take(limit.min(DESCRIPTORS))
            .map(String::as_str)
            .collect()
    }
    pub fn state(&self, id: &str, token: Counter) -> Result<Option<TakeState>> {
        Ok(self.entry(id)?.runtime.state(token))
    }
    pub fn fence(
        &self,
        id: &str,
        token: Counter,
        source: &str,
        transport: Counter,
        context: Counter,
    ) -> Result<FrameFence> {
        self.entry(id)?
            .runtime
            .fence(token, source, transport, context)
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Do not synthesize native readiness fences from the current token"
    )]
    pub fn ready(
        &mut self,
        id: &str,
        token: Counter,
        source: &str,
        frame: FrameFence,
        transport: Counter,
        context: Counter,
    ) -> Result<()> {
        self.entry_mut(id)?
            .runtime
            .ready(token, source, frame, transport, context)
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Native fences remain explicit on the serialized control lane"
    )]
    pub fn take(
        &mut self,
        id: &str,
        token: Counter,
        now_ms: u64,
        grant: &RevokeFence,
        transport: Counter,
        context: Counter,
        outputs: &[Output],
        swap: Swap,
    ) -> Result<()> {
        let e = self.entry_mut(id)?;
        if e.closing {
            return Err(fail("DOCUMENT_CLOSING", "no new output while closing"));
        }
        let revision = e
            .desired
            .as_ref()
            .ok_or_else(|| fail("PREPARE_STATE", "submit first"))?
            .0;
        e.runtime.take(
            token, revision, now_ms, grant, transport, context, outputs, swap,
        )
    }
    pub fn presentation(&self, id: &str, output: Output) -> Result<Option<&Presentation>> {
        Ok(self.entry(id)?.runtime.presentation(output))
    }
    pub fn cancel(&mut self, id: &str, token: Counter) -> Result<()> {
        self.entry_mut(id)?.runtime.cancel(token)
    }
    pub fn reconcile(&mut self, id: &str, token: Counter, presented: bool) -> Result<()> {
        self.entry_mut(id)?.runtime.reconcile(token, presented)
    }
    pub fn disposal_complete(&mut self, id: &str, token: Counter) -> Result<()> {
        self.entry_mut(id)?.runtime.disposal_complete(token)
    }
    pub fn expire(&mut self, now_ms: u64) {
        for e in self.entries.values_mut() {
            e.runtime.expire(now_ms);
            if e.pending.as_ref().is_some_and(|p| now_ms > p.expires) {
                e.pending = None;
            }
        }
        self.order.retain(|id| self.entries[id].pending.is_some());
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        for r in self.running.values() {
            r.cancel.store(true, Ordering::Release);
        }
        for e in self.entries.values_mut() {
            e.pending = None;
        }
        self.jobs.take();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}
