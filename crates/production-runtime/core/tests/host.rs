use producer_production_core::{
    bounded::Message,
    commands::{Command, Operation},
    contract::*,
    coordinator::Status,
    host::*,
    storage::*,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

fn edit(title: &str) -> Command {
    Command::Transaction {
        operations: vec![Operation::SetTitle {
            title: title.into(),
        }],
    }
}
fn empty(id: &str) -> Document {
    Document::empty(id, "Initial")
}
fn open(h: &mut ProductionHost<MemoryStore>, id: &str) {
    h.open(id, || {
        Ok((MemoryStore::default(), Snapshot::new(empty(id))?))
    })
    .unwrap();
}
fn wait(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !predicate() {
        assert!(Instant::now() < deadline, "bounded test deadline expired");
        thread::sleep(Duration::from_millis(1));
    }
}

// Storage deliberately blocks after the commit authorization point. Other
// document services, stop, disconnect and close must remain independent of it.
#[derive(Default)]
struct Gate {
    entered: AtomicUsize,
    appends: AtomicUsize,
    release: (Mutex<bool>, Condvar),
    data: Mutex<MemoryStore>,
    panic_after_write: bool,
    drops: AtomicUsize,
}
impl Gate {
    fn release(&self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
}
struct Guard(Arc<Gate>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.release();
    }
}
struct BlockingStore(Arc<Gate>);
impl Drop for BlockingStore {
    fn drop(&mut self) {
        self.0.drops.fetch_add(1, Ordering::SeqCst);
    }
}
impl Storage for BlockingStore {
    fn append(&mut self, r: &Record) -> std::result::Result<(), AppendError> {
        self.0.appends.fetch_add(1, Ordering::SeqCst);
        self.0.entered.fetch_add(1, Ordering::SeqCst);
        let released = self.0.release.0.lock().unwrap();
        let (released, timeout) = self
            .0
            .release
            .1
            .wait_timeout_while(released, Duration::from_secs(20), |v| !*v)
            .unwrap();
        assert!(*released && !timeout.timed_out(), "test IO gate timed out");
        drop(released);
        let result = self.0.data.lock().unwrap().append(r);
        assert!(
            !self.0.panic_after_write,
            "injected writer panic after potential durable append"
        );
        result
    }
    fn checkpoint(&mut self, state: &Snapshot) -> Result<()> {
        self.0.data.lock().unwrap().checkpoint(state)
    }
}
fn blocking(id: &str, gate: Arc<Gate>) -> (ProductionHost<BlockingStore>, String) {
    let mut h = ProductionHost::new().unwrap();
    h.open(id, || Ok((BlockingStore(gate), Snapshot::new(empty(id))?)))
        .unwrap();
    let s = h.session(id, true).unwrap();
    (h, s)
}

#[test]
fn process_admission_precedes_store_open_and_rolls_back_failed_factories() {
    let mut h = ProductionHost::<MemoryStore>::new().unwrap();
    assert!(h
        .open("bad/id", || panic!("invalid ID must not open IO"))
        .is_err());
    assert!(h
        .open("a", || Err(Error::new("IO", "test", "failed")))
        .is_err());
    assert_eq!(h.services().documents, 0);
    assert!(h
        .open("a", || Ok((
            MemoryStore::default(),
            Snapshot::new(empty("other"))?
        )))
        .is_err());
    assert_eq!(h.services().retained_encoded_allowance, 0);
    open(&mut h, "a");
    open(&mut h, "b");
    assert_eq!(h.services().documents, 2);
    assert_eq!(
        h.services().retained_encoded_allowance,
        2 * RETAINED_ENCODED_PER_DOCUMENT
    );
    assert_eq!(
        h.open("c", || panic!("saturated host must not open IO"))
            .unwrap_err()
            .code,
        "SERVICE_LIMIT"
    );
    assert_eq!(
        h.open("a", || panic!("must not create duplicate writer"))
            .unwrap_err()
            .code,
        "DOCUMENT_OPEN"
    );
    h.close("a").unwrap();
    assert_eq!(
        h.open("c", || panic!(
            "logical close cannot release writer reservation"
        ))
        .unwrap_err()
        .code,
        "SERVICE_LIMIT"
    );
    h.finish_close("a").unwrap();
    open(&mut h, "c");
}

#[test]
fn global_sessions_and_observers_are_bounded_and_reusable_across_documents() {
    let mut h = ProductionHost::new().unwrap();
    open(&mut h, "a");
    open(&mut h, "b");
    let a: Vec<_> = (0..4).map(|_| h.session("a", true).unwrap()).collect();
    assert_eq!(h.session("a", true).unwrap_err().code, "SERVICE_LIMIT");
    let b: Vec<_> = (0..4).map(|_| h.session("b", true).unwrap()).collect();
    assert_eq!(h.services().sessions, SESSIONS);
    let oa: Vec<_> = (0..4).map(|_| h.observe(&a[0]).unwrap()).collect();
    assert_eq!(h.observe(&a[0]).unwrap_err().code, "SERVICE_LIMIT");
    let _: Vec<_> = (0..4).map(|_| h.observe(&b[0]).unwrap()).collect();
    assert_eq!(h.services().observers, OBSERVERS);
    assert_eq!(
        h.observer_poll(&a[1], &oa[0]).unwrap_err().code,
        "AUTH_REQUIRED"
    );
    assert_eq!(
        h.unobserve(&b[0], &oa[0]).unwrap_err().code,
        "AUTH_REQUIRED"
    );
    h.disconnect(&a[0]).unwrap();
    assert_eq!(h.services().sessions, 7);
    assert_eq!(h.services().observers, 4);
    let s = h.session("a", false).unwrap();
    assert!(h.author_grant(&s).is_err());
    assert!(h.issue(&s, Counter(0), &edit("denied"), 0).is_err());
    h.observe(&s).unwrap();
    h.close("a").unwrap();
    h.finish_close("a").unwrap();
    h.close("b").unwrap();
    h.finish_close("b").unwrap();
    assert_eq!(
        h.services().documents + h.services().sessions + h.services().observers,
        0
    );
}

#[test]
fn admitted_observer_snapshots_are_redacted_and_track_durable_receipts() {
    let mut h = ProductionHost::new().unwrap();
    open(&mut h, "a");
    let s = h.session("a", true).unwrap();
    let o = h.observe(&s).unwrap();
    let Message::Snapshot {
        cursor,
        digest: hash,
        bytes,
        ..
    } = h.observer_poll(&s, &o).unwrap().unwrap()
    else {
        panic!()
    };
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        json.get("document").is_none()
            && json.get("metadata").is_none()
            && json.get("title").is_none()
    );
    assert_eq!(json["documentId"], "a");
    assert!(h.observer_complete(&s, &o, cursor, "wrong").is_err());
    h.observer_complete(&s, &o, cursor, &hash).unwrap();
    let cmd = edit("private title");
    let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
    let receipt = h.submitter(&s).unwrap().submit(&t, &cmd, 1).unwrap();
    let Message::Delta { value } = h.observer_poll(&s, &o).unwrap().unwrap() else {
        panic!()
    };
    assert_eq!(value.revision, receipt.revision);
    assert_eq!(value.digest, receipt.digest);
    h.observer_snapshot(&s, &o).unwrap();
    let t = h.issue(&s, Counter(1), &edit("another"), 2).unwrap();
    h.submitter(&s)
        .unwrap()
        .submit(&t, &edit("another"), 3)
        .unwrap();
    assert!(matches!(
        h.observer_poll(&s, &o).unwrap(),
        Some(Message::ResnapshotRequired)
    ));
    h.unobserve(&s, &o).unwrap();
    assert_eq!(h.services().observers, 0);
}

#[test]
fn concurrent_identical_retries_share_exactly_one_durable_append() {
    let gate = Arc::new(Gate::default());
    let (h, s) = blocking("a", gate.clone());
    let _guard = Guard(gate.clone());
    let cmd = edit("once");
    let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
    let handle = h.submitter(&s).unwrap();
    thread::scope(|scope| {
        let leader = scope.spawn(|| handle.submit(&t, &cmd, 1));
        wait(|| gate.entered.load(Ordering::Acquire) == 1);
        let followers: Vec<_> = (0..3)
            .map(|_| scope.spawn(|| handle.submit(&t, &cmd, 2)))
            .collect();
        wait(|| h.services().waiters == 3);
        assert_eq!(h.services().flights, 1);
        assert_eq!(h.services().submissions, 4);
        assert_eq!(h.inspect(&s).err().unwrap().code, "DOCUMENT_BUSY");
        gate.release();
        let r = leader.join().unwrap().unwrap();
        for f in followers {
            assert_eq!(f.join().unwrap().unwrap(), r);
        }
        assert_eq!(handle.submit(&t, &cmd, 3).unwrap(), r);
    });
    assert_eq!(gate.appends.load(Ordering::Acquire), 1);
    assert_eq!(h.inspect(&s).unwrap().revision, Counter(1));
    assert_eq!(
        h.services().flights
            + h.services().waiters
            + h.services().submissions
            + h.services().wire_bytes,
        0
    );
}

#[test]
fn in_flight_payload_or_session_mismatch_does_not_wait_on_storage() {
    let gate = Arc::new(Gate::default());
    let (mut h, s) = blocking("a", gate.clone());
    let _guard = Guard(gate.clone());
    let other = h.session("a", true).unwrap();
    let a = h.submitter(&s).unwrap();
    let b = h.submitter(&other).unwrap();
    let cmd = edit("once");
    let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
    thread::scope(|scope| {
        let leader = scope.spawn(|| a.submit(&t, &cmd, 1));
        wait(|| gate.entered.load(Ordering::Acquire) == 1);
        assert_eq!(
            a.submit(&t, &edit("different"), 1).unwrap_err().code,
            "PAYLOAD_MISMATCH"
        );
        assert_eq!(b.submit(&t, &cmd, 1).unwrap_err().code, "PAYLOAD_MISMATCH");
        assert_eq!(h.services().waiters, 0);
        gate.release();
        let r = leader.join().unwrap().unwrap();
        assert_eq!(b.submit(&t, &cmd, 2).unwrap(), r); // Authorized historical read, not a second effect.
    });
    assert_eq!(gate.appends.load(Ordering::Acquire), 1);
}

#[test]
fn saturated_document_cannot_block_another_document_or_stop_and_close() {
    let gate = Arc::new(Gate::default());
    let (mut h, s) = blocking("a", gate.clone());
    let _guard = Guard(gate.clone());
    let free = Arc::new(Gate::default());
    free.release();
    h.open("b", || {
        Ok((BlockingStore(free.clone()), Snapshot::new(empty("b"))?))
    })
    .unwrap();
    let sb = h.session("b", true).unwrap();
    let ob = h.observe(&sb).unwrap();
    let handle = h.submitter(&s).unwrap();
    let cmd = edit("a");
    let tickets: Vec<_> = (0..5)
        .map(|_| h.issue(&s, Counter(0), &cmd, 0).unwrap())
        .collect();
    thread::scope(|scope| {
        let leader = scope.spawn(|| handle.submit(&tickets[0], &cmd, 1));
        wait(|| gate.entered.load(Ordering::Acquire) == 1);
        let followers: Vec<_> = tickets[1..4]
            .iter()
            .map(|t| scope.spawn(|| handle.submit(t, &cmd, 1)))
            .collect();
        wait(|| h.services().flights == 4);
        assert_eq!(
            handle.submit(&tickets[4], &cmd, 1).unwrap_err().code,
            "SERVICE_LIMIT"
        );
        let t = h.issue(&sb, Counter(0), &edit("b"), 0).unwrap();
        assert_eq!(
            h.submitter(&sb)
                .unwrap()
                .submit(&t, &edit("b"), 1)
                .unwrap()
                .outcome,
            Outcome::Saved
        );
        assert!(h.observer_poll(&sb, &ob).is_ok());
        h.stop("a").unwrap();
        h.close("a").unwrap();
        assert!(h.finish_close("a").is_err());
        assert_eq!(h.services().documents, 2);
        assert_eq!(
            handle.submit(&tickets[0], &cmd, 2).unwrap_err().code,
            "AUTH_REQUIRED"
        );
        gate.release();
        assert_eq!(leader.join().unwrap().unwrap().outcome, Outcome::Saved);
        for f in followers {
            assert_eq!(f.join().unwrap().unwrap_err().code, "AUTH_REQUIRED");
        }
    });
    h.finish_close("a").unwrap();
    assert_eq!(h.services().sessions, 1);
    assert_eq!(h.services().flights, 0);
    assert_eq!(h.inspect(&sb).unwrap().revision, Counter(1));
}

#[test]
fn waiter_saturation_is_fail_fast_and_disconnect_revokes_while_write_is_blocked() {
    let gate = Arc::new(Gate::default());
    let (mut h, s) = blocking("a", gate.clone());
    let _guard = Guard(gate.clone());
    let grant = h.author_grant(&s).unwrap();
    let handle = h.submitter(&s).unwrap();
    let cmd = edit("once");
    let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
    thread::scope(|scope| {
        let leader = scope.spawn(|| handle.submit(&t, &cmd, 1));
        wait(|| gate.entered.load(Ordering::Acquire) == 1);
        let followers: Vec<_> = (0..7)
            .map(|_| scope.spawn(|| handle.submit(&t, &cmd, 1)))
            .collect();
        wait(|| h.services().waiters == 7);
        assert_eq!(
            handle.submit(&t, &cmd, 2).unwrap_err().code,
            "SERVICE_LIMIT"
        );
        h.disconnect(&s).unwrap();
        assert!(!grant.is_current());
        assert_eq!(h.services().sessions, 1); // Still physically retained in the blocked coordinator.
        gate.release();
        assert_eq!(leader.join().unwrap().unwrap().outcome, Outcome::Saved);
        for f in followers {
            assert_eq!(f.join().unwrap().unwrap_err().code, "AUTH_REQUIRED");
        }
    });
    h.maintain();
    assert_eq!(
        h.services().sessions + h.services().submissions + h.services().wire_bytes,
        0
    );
}

#[test]
fn writer_panic_wakes_followers_and_recovery_returns_saved_receipt_without_reexecution() {
    let gate = Arc::new(Gate {
        panic_after_write: true,
        ..Gate::default()
    });
    let (mut h, s) = blocking("a", gate.clone());
    let _guard = Guard(gate.clone());
    let cmd = edit("durable");
    let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
    let handle = h.submitter(&s).unwrap();
    thread::scope(|scope| {
        let a = scope.spawn(|| handle.submit(&t, &cmd, 1));
        wait(|| gate.entered.load(Ordering::Acquire) == 1);
        let b = scope.spawn(|| handle.submit(&t, &cmd, 2));
        wait(|| h.services().waiters == 1);
        gate.release();
        assert_eq!(a.join().unwrap().unwrap_err().code, "SAVE_OUTCOME_UNKNOWN");
        assert_eq!(b.join().unwrap().unwrap_err().code, "SAVE_OUTCOME_UNKNOWN");
    });
    assert_eq!(
        handle.submit(&t, &cmd, 3).unwrap_err().code,
        "RECOVERY_REQUIRED"
    );
    assert!(h.author_grant(&s).is_err());
    h.close("a").unwrap();
    h.finish_close("a").unwrap();
    assert_eq!(
        h.services().documents + h.services().sessions + h.services().submissions,
        0
    );
    let state = MemoryStore::recover(empty("a"), &gate.data.lock().unwrap().records).unwrap();
    let mut recovered = ProductionHost::new().unwrap();
    recovered
        .open("a", || Ok((MemoryStore::default(), state)))
        .unwrap();
    let s = recovered.session("a", true).unwrap();
    assert_eq!(
        recovered
            .submitter(&s)
            .unwrap()
            .submit(&t, &cmd, 4)
            .unwrap()
            .outcome,
        Outcome::Saved
    );
    assert_eq!(recovered.inspect(&s).unwrap().revision, Counter(1));
    assert_eq!(gate.appends.load(Ordering::Acquire), 1);
}

#[test]
fn known_and_uncertain_io_failures_have_distinct_retry_behavior() {
    for (failure, known) in [(Failure::BeforeWrite, true), (Failure::AfterWrite, false)] {
        let mut h = ProductionHost::new().unwrap();
        h.open("a", || {
            Ok((
                MemoryStore {
                    failure: Some(failure),
                    ..MemoryStore::default()
                },
                Snapshot::new(empty("a"))?,
            ))
        })
        .unwrap();
        let s = h.session("a", true).unwrap();
        let cmd = edit("change");
        let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
        let handle = h.submitter(&s).unwrap();
        let result = handle.submit(&t, &cmd, 1);
        if known {
            let r = result.unwrap();
            assert!(matches!(r.outcome, Outcome::Rejected(_)));
            assert_eq!(handle.submit(&t, &cmd, 2).unwrap(), r);
            assert!(h.author_grant(&s).is_ok());
        } else {
            assert_eq!(result.unwrap_err().code, "SAVE_OUTCOME_UNKNOWN");
            assert_eq!(
                handle.submit(&t, &cmd, 2).unwrap_err().code,
                "RECOVERY_REQUIRED"
            );
            assert!(h.author_grant(&s).is_err());
            assert!(h.issue(&s, Counter(0), &cmd, 2).is_err());
        }
        assert_eq!(h.inspect(&s).unwrap().revision, Counter(0));
        h.close("a").unwrap();
        h.finish_close("a").unwrap();
        assert_eq!(
            h.services().documents + h.services().sessions + h.services().wire_bytes,
            0
        );
    }
}

#[test]
fn inspected_identity_tracks_edits_undo_and_recovery_while_old_reads_stay_immutable() {
    let path = std::env::temp_dir().join(format!("producer-inspection-{}", uuid::Uuid::new_v4()));
    let mut h = ProductionHost::<FileStore>::new().unwrap();
    h.open("a", || FileStore::open(&path, empty("a"))).unwrap();
    let s = h.session("a", true).unwrap();
    let initial = h.inspect(&s).unwrap();
    assert_eq!(initial.digest, digest(initial.document()).unwrap());
    let command = edit("Changed");
    let ticket = h.issue(&s, Counter(0), &command, 0).unwrap();
    let receipt = h
        .submitter(&s)
        .unwrap()
        .submit(&ticket, &command, 1)
        .unwrap();
    let changed = h.inspect(&s).unwrap();
    assert_eq!(changed.digest, receipt.digest);
    assert_eq!(changed.digest, digest(changed.document()).unwrap());
    assert_ne!(initial.digest, changed.digest);
    assert_eq!(initial.document().title, "Initial");
    let undo = h.undo_command(&s).unwrap();
    let ticket = h.issue(&s, Counter(1), &undo, 2).unwrap();
    h.submitter(&s).unwrap().submit(&ticket, &undo, 3).unwrap();
    let restored = h.inspect(&s).unwrap();
    assert_eq!(restored.digest, initial.digest);
    assert_eq!(restored.revision, Counter(2));
    h.close("a").unwrap();
    h.finish_close("a").unwrap();
    h.open("a", || FileStore::open(&path, empty("a"))).unwrap();
    let s = h.session("a", false).unwrap();
    let recovered = h.inspect(&s).unwrap();
    assert_eq!(recovered.digest, restored.digest);
    assert_eq!(recovered.revision, Counter(2));
    assert_eq!(changed.document().title, "Changed");
    h.close("a").unwrap();
    h.finish_close("a").unwrap();
    drop((initial, changed, restored, recovered));
    assert_eq!(h.services().read_bytes + h.services().readers, 0);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn immutable_read_leases_remain_charged_across_close_and_cannot_be_used_as_authority() {
    let mut h = ProductionHost::new().unwrap();
    open(&mut h, "a");
    let s = h.session("a", true).unwrap();
    let reads: Vec<_> = (0..4).map(|_| h.inspect(&s).unwrap()).collect();
    assert_eq!(h.inspect(&s).err().unwrap().code, "SERVICE_LIMIT");
    let retained = h.services().read_bytes;
    assert!(retained > 0);
    let stale = h.submitter(&s).unwrap();
    h.close("a").unwrap();
    h.finish_close("a").unwrap();
    assert_eq!(h.services().read_bytes, retained);
    assert_eq!(h.services().sessions, 0);
    open(&mut h, "a");
    assert_eq!(
        stale
            .submit(&uuid::Uuid::new_v4().to_string(), &edit("bad"), 0)
            .unwrap_err()
            .code,
        "AUTH_REQUIRED"
    );
    drop(reads);
    assert_eq!(h.services().read_bytes + h.services().readers, 0);
}

#[test]
fn stale_handles_do_not_retain_the_file_writer_after_exact_close() {
    let path = std::env::temp_dir().join(format!("producer-host-{}", uuid::Uuid::new_v4()));
    let mut h = ProductionHost::<FileStore>::new().unwrap();
    h.open("a", || FileStore::open(&path, empty("a"))).unwrap();
    let s = h.session("a", true).unwrap();
    let stale = h.submitter(&s).unwrap();
    assert!(FileStore::open(&path, empty("a")).is_err());
    h.close("a").unwrap();
    h.finish_close("a").unwrap();
    let (_writer, _) = FileStore::open(&path, empty("a")).unwrap();
    assert!(stale
        .submit(&uuid::Uuid::new_v4().to_string(), &edit("bad"), 0)
        .is_err());
    drop(_writer);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn host_owned_compile_is_fenced_by_close_and_reader_cannot_prepare() {
    let mut h = ProductionHost::new().unwrap();
    let d = fixture::classic_like();
    let id = d.id.clone();
    h.open(&id, || Ok((MemoryStore::default(), Snapshot::new(d)?)))
        .unwrap();
    let author = h.session(&id, true).unwrap();
    let reader = h.session(&id, false).unwrap();
    assert!(h.prepare(&reader, None, 0).is_err());
    h.prepare(&author, None, 0).unwrap();
    h.dispatch().unwrap();
    h.close(&id).unwrap();
    wait(|| {
        h.poll(1);
        h.finish_close(&id).is_ok()
    });
    assert_eq!(h.host_status().workspace.documents, 0);
    assert_eq!(h.services().documents, 0);
}

#[test]
fn rejected_payloads_and_oversized_storage_errors_do_not_leak_admission() {
    struct BadStore;
    impl Storage for BadStore {
        fn append(&mut self, _: &Record) -> std::result::Result<(), AppendError> {
            Err(AppendError::NotWritten(Error::new(
                &"x".repeat(100_000),
                "é".repeat(100_000),
                "é".repeat(100_000),
            )))
        }
        fn checkpoint(&mut self, _: &Snapshot) -> Result<()> {
            Ok(())
        }
    }
    let mut h = ProductionHost::new().unwrap();
    h.open("a", || Ok((BadStore, Snapshot::new(empty("a"))?)))
        .unwrap();
    let s = h.session("a", true).unwrap();
    assert_eq!(
        h.issue(&s, Counter(0), &edit(&"x".repeat(COMMAND_BYTES)), 0)
            .unwrap_err()
            .code,
        "SERVICE_LIMIT"
    );
    let cmd = edit("small");
    let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
    let r = h.submitter(&s).unwrap().submit(&t, &cmd, 1).unwrap();
    assert!(serde_json::to_vec(&r).unwrap().len() < 64 * 1024);
    assert!(matches!(h.status(&s, &t).unwrap(), Status::Terminal(_)));
    assert_eq!(
        h.services().submissions + h.services().flights + h.services().wire_bytes,
        0
    );
}

#[test]
fn dropping_host_revokes_handles_but_preserves_an_admitted_writer_until_completion() {
    let gate = Arc::new(Gate::default());
    let (h, s) = blocking("a", gate.clone());
    let _guard = Guard(gate.clone());
    let cmd = edit("already ordered");
    let t = h.issue(&s, Counter(0), &cmd, 0).unwrap();
    let handle = h.submitter(&s).unwrap();
    let grant = h.author_grant(&s).unwrap();
    thread::scope(|scope| {
        let worker = scope.spawn(|| handle.submit(&t, &cmd, 1));
        wait(|| gate.entered.load(Ordering::Acquire) == 1);
        drop(h);
        assert!(!grant.is_current());
        assert_eq!(gate.drops.load(Ordering::Acquire), 0);
        gate.release();
        assert_eq!(worker.join().unwrap().unwrap().outcome, Outcome::Saved);
    });
    assert_eq!(gate.drops.load(Ordering::Acquire), 1);
    assert_eq!(
        handle.submit(&t, &cmd, 2).unwrap_err().code,
        "AUTH_REQUIRED"
    );
}

#[test]
fn both_documents_share_one_eight_flight_pool() {
    let a = Arc::new(Gate::default());
    let b = Arc::new(Gate::default());
    let _ga = Guard(a.clone());
    let _gb = Guard(b.clone());
    let (mut h, sa) = blocking("a", a.clone());
    h.open("b", || {
        Ok((BlockingStore(b.clone()), Snapshot::new(empty("b"))?))
    })
    .unwrap();
    let sb = h.session("b", true).unwrap();
    let ha = h.submitter(&sa).unwrap();
    let hb = h.submitter(&sb).unwrap();
    let cmd = edit("one revision wins");
    let ta: Vec<_> = (0..5)
        .map(|_| h.issue(&sa, Counter(0), &cmd, 0).unwrap())
        .collect();
    let tb: Vec<_> = (0..5)
        .map(|_| h.issue(&sb, Counter(0), &cmd, 0).unwrap())
        .collect();
    thread::scope(|scope| {
        let mut jobs = Vec::new();
        for ticket in &ta[..4] {
            jobs.push(scope.spawn(|| ha.submit(ticket, &cmd, 1)));
        }
        for ticket in &tb[..4] {
            jobs.push(scope.spawn(|| hb.submit(ticket, &cmd, 1)));
        }
        wait(|| h.services().flights == FLIGHTS);
        assert_eq!(
            ha.submit(&ta[4], &cmd, 1).unwrap_err().code,
            "SERVICE_LIMIT"
        );
        assert_eq!(
            hb.submit(&tb[4], &cmd, 1).unwrap_err().code,
            "SERVICE_LIMIT"
        );
        a.release();
        b.release();
        let results: Vec<_> = jobs
            .into_iter()
            .map(|j| j.join().unwrap().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|r| r.outcome == Outcome::Saved)
                .count(),
            2
        );
    });
    assert_eq!(
        h.services().flights + h.services().submissions + h.services().wire_bytes,
        0
    );
    assert_eq!(h.inspect(&sa).unwrap().revision, Counter(1));
    assert_eq!(h.inspect(&sb).unwrap().revision, Counter(1));
}

#[test]
fn writer_scratch_allowance_follows_document_ownership() {
    let mut h = ProductionHost::<MemoryStore>::new().unwrap();
    for id in ["scratch-a", "scratch-b"] {
        h.open(id, || {
            Ok((
                MemoryStore::default(),
                Snapshot::new(Document::empty(id, "Scratch"))?,
            ))
        })
        .unwrap();
    }
    assert_eq!(
        h.services().writer_scratch_allowance,
        2 * WRITER_SCRATCH_PER_DOCUMENT
    );
    h.close("scratch-a").unwrap();
    h.finish_close("scratch-a").unwrap();
    assert_eq!(
        h.services().writer_scratch_allowance,
        WRITER_SCRATCH_PER_DOCUMENT
    );
    h.close("scratch-b").unwrap();
    h.finish_close("scratch-b").unwrap();
    assert_eq!(h.services().writer_scratch_allowance, 0);
}
