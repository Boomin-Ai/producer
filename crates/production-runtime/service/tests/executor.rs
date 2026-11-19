use producer_production_core::{
    commands::{Command, Operation},
    contract::*,
    host::ProductionHost,
    storage::*,
};
use producer_production_service::{frame, Client, Executor, Task, FRAME_BYTES};
use serde_json::{json, Value};
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
fn wait(mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    while !f() {
        assert!(Instant::now() < end, "test deadline exceeded");
        thread::sleep(Duration::from_millis(1));
    }
}
fn enqueue_raw(c: &Client, mut bytes: Box<[u8]>) -> Result<Task> {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        match c.try_request(bytes) {
            Ok(t) => return Ok(t),
            Err(rejected) if rejected.error.code == "EXECUTOR_BUSY" => {
                assert!(Instant::now() < end);
                bytes = rejected.bytes;
                thread::yield_now();
            }
            Err(rejected) => return Err(rejected.error),
        }
    }
}
fn enqueue(c: &Client, v: Value) -> Task {
    enqueue_raw(c, serde_json::to_vec(&v).unwrap().into_boxed_slice()).unwrap()
}
fn result(t: Task) -> Value {
    let r = t.wait().unwrap();
    serde_json::from_slice(r.bytes()).unwrap()
}
fn rpc(c: &Client, v: Value) -> Value {
    result(enqueue(c, v))
}
fn hello(c: &Client) -> String {
    let r = rpc(c, json!({"method":"hello"}));
    assert_eq!(r["ok"], true, "{r}");
    r["result"]["session"].as_str().unwrap().into()
}
fn edit(title: &str) -> Command {
    Command::Transaction {
        operations: vec![Operation::SetTitle {
            title: title.into(),
        }],
    }
}
fn ticket(c: &Client, s: &str, title: &str, expected: u64) -> String {
    let r = rpc(
        c,
        json!({"method":"issue","session":s,"expected":expected.to_string(),"command":edit(title)}),
    );
    assert_eq!(r["ok"], true, "{r}");
    r["result"]["ticket"].as_str().unwrap().into()
}
fn request(c: &Client, s: &str, t: &str, title: &str) -> Task {
    enqueue(
        c,
        json!({"method":"submit","session":s,"ticket":t,"command":edit(title)}),
    )
}
fn memory() -> Executor {
    Executor::spawn(vec!["a".into(), "b".into()], || {
        let mut h = ProductionHost::new()?;
        for id in ["a", "b"] {
            h.open(id, || {
                Ok((
                    MemoryStore::default(),
                    Snapshot::new(Document::empty(id, "Initial"))?,
                ))
            })?;
        }
        Ok(h)
    })
    .unwrap()
}
fn connect(e: &Executor, id: &str, author: bool) -> Client {
    loop {
        match e.connect(id, author) {
            Ok(c) => return c,
            Err(e) if e.code == "EXECUTOR_BUSY" => thread::yield_now(),
            Err(e) => panic!("{e}"),
        }
    }
}
#[derive(Default)]
struct Gate {
    entered: AtomicUsize,
    appends: AtomicUsize,
    dropped: AtomicUsize,
    release: (Mutex<bool>, Condvar),
    panic_after_write: bool,
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
struct Store {
    gate: Arc<Gate>,
    inner: MemoryStore,
}
impl Drop for Store {
    fn drop(&mut self) {
        self.gate.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
impl Storage for Store {
    fn append(&mut self, r: &Record) -> std::result::Result<(), AppendError> {
        assert!(thread::current()
            .name()
            .unwrap()
            .starts_with("production-writer-"));
        self.gate.entered.fetch_add(1, Ordering::SeqCst);
        let g = self.gate.release.0.lock().unwrap();
        let (g, t) = self
            .gate
            .release
            .1
            .wait_timeout_while(g, Duration::from_secs(15), |v| !*v)
            .unwrap();
        assert!(!t.timed_out());
        drop(g);
        self.inner.append(r)?;
        self.gate.appends.fetch_add(1, Ordering::SeqCst);
        assert!(!self.gate.panic_after_write, "injected after append");
        Ok(())
    }
    fn checkpoint(&mut self, s: &Snapshot) -> Result<()> {
        assert!(
            thread::current()
                .name()
                .unwrap()
                .starts_with("production-writer-")
                || thread::current().name() == Some("production-control")
        );
        self.inner.checkpoint(s)
    }
}
fn blocked(g: Arc<Gate>) -> Executor {
    Executor::spawn(vec!["a".into(), "b".into()], move || {
        assert_eq!(thread::current().name(), Some("production-control"));
        let mut h = ProductionHost::new()?;
        for id in ["a", "b"] {
            let gate = g.clone();
            h.open(id, || {
                Ok((
                    Store {
                        gate,
                        inner: MemoryStore::default(),
                    },
                    Snapshot::new(Document::empty(id, "Initial"))?,
                ))
            })?;
        }
        Ok(h)
    })
    .unwrap()
}
#[test]
fn connection_scope_role_and_raw_admission_cannot_be_forged() {
    let e = memory();
    let a = connect(&e, "a", true);
    let b = connect(&e, "b", true);
    let same = connect(&e, "a", true);
    let reader = connect(&e, "b", false);
    let sa = hello(&a);
    let sb = hello(&b);
    let sr = hello(&reader);
    for c in [&b, &same] {
        assert_eq!(
            rpc(c, json!({"method":"inspect","session":sa}))["error"]["code"],
            "AUTH_REQUIRED"
        );
    }
    assert_eq!(
        rpc(
            &reader,
            json!({"method":"issue","session":sr,"expected":"0","command":edit("bad")})
        )["error"]["code"],
        "FORBIDDEN"
    );
    assert_eq!(reader.stop().unwrap_err().code, "FORBIDDEN");
    assert_eq!(
        rpc(&a, json!({"method":"hello","author":true}))["error"]["code"],
        "STRUCTURE"
    );
    assert_eq!(
        result(
            enqueue_raw(
                &a,
                br#"{"method":"hello","method":"hello"}"#.to_vec().into_boxed_slice()
            )
            .unwrap()
        )["error"]["code"],
        "RAW_JSON"
    );
    assert_eq!(
        result(enqueue_raw(&a, vec![0xff].into_boxed_slice()).unwrap())["error"]["code"],
        "RAW_UTF8"
    );
    assert_eq!(
        rpc(&b, json!({"method":"inspect","session":sb}))["ok"],
        true
    );
    e.shutdown().join().unwrap();
}
#[test]
fn blocked_writer_keeps_other_document_stop_and_disconnect_usable() {
    let g = Arc::new(Gate::default());
    let _guard = Guard(g.clone());
    let e = blocked(g.clone());
    let a = connect(&e, "a", true);
    let b = connect(&e, "b", true);
    let sa = hello(&a);
    let sb = hello(&b);
    let t = ticket(&a, &sa, "Saved", 0);
    let job = request(&a, &sa, &t, "Saved");
    wait(|| g.entered.load(Ordering::SeqCst) == 1);
    let b_read = rpc(&b, json!({"method":"inspect","session":sb}));
    assert_eq!(b_read["result"]["document"]["title"], "Initial");
    a.stop().unwrap();
    wait(|| e.status().stops_applied == 1);
    a.disconnect();
    g.release();
    assert_eq!(result(job)["error"]["code"], "AUTH_REQUIRED");
    wait(|| e.status().writer_pending == 0);
    assert_eq!(g.appends.load(Ordering::SeqCst), 1);
    let recovered = connect(&e, "a", true);
    let s = hello(&recovered);
    let r = rpc(
        &recovered,
        json!({"method":"status","session":s,"ticket":t}),
    );
    assert_eq!(r["result"]["status"], "terminal");
    assert_eq!(
        rpc(&recovered, json!({"method":"inspect","session":s}))["result"]["document"]["title"],
        "Saved"
    );
    e.shutdown().join().unwrap();
    assert_eq!(g.dropped.load(Ordering::SeqCst), 2);
}
#[test]
fn queued_checkpoint_cancels_without_execution_and_replies_hold_capacity() {
    let g = Arc::new(Gate::default());
    let _guard = Guard(g.clone());
    let e = blocked(g.clone());
    let a = connect(&e, "a", true);
    let s = hello(&a);
    let t = ticket(&a, &s, "Saved", 0);
    let active = request(&a, &s, &t, "Saved");
    wait(|| g.entered.load(Ordering::SeqCst) == 1);
    let pending = enqueue(&a, json!({"method":"checkpoint","session":s}));
    wait(|| e.status().writer_pending == 2);
    assert!(pending.cancel());
    assert!(!active.cancel());
    g.release();
    assert_eq!(result(active)["ok"], true);
    assert_eq!(result(pending)["error"]["code"], "CANCELLED");
    wait(|| e.status().requests == 0);
    let held: Vec<_> = (0..4)
        .map(|_| {
            enqueue(&a, json!({"method":"services","session":s}))
                .wait()
                .unwrap()
        })
        .collect();
    assert_eq!(e.status().requests, 4);
    assert_eq!(
        enqueue_raw(&a, br#"{"method":"hello"}"#.to_vec().into_boxed_slice())
            .err()
            .unwrap()
            .code,
        "EXECUTOR_FULL"
    );
    assert!(e.status().reply_allowance >= 4 * FRAME_BYTES);
    drop(held);
    wait(|| e.status().requests == 0);
    assert_eq!(
        rpc(&a, json!({"method":"services","session":s}))["ok"],
        true
    );
    e.shutdown().join().unwrap();
}
#[test]
fn peer_queue_byte_budget_and_cancelled_startup_work_are_bounded() {
    let gate = Arc::new(Gate::default());
    let _guard = Guard(gate.clone());
    let wait_gate = gate.clone();
    let e = Executor::spawn(vec!["a".into(), "b".into()], move || {
        let g = wait_gate.release.0.lock().unwrap();
        let (g, t) = wait_gate
            .release
            .1
            .wait_timeout_while(g, Duration::from_secs(15), |v| !*v)
            .unwrap();
        assert!(!t.timed_out());
        drop(g);
        let mut h = ProductionHost::new()?;
        for id in ["a", "b"] {
            h.open(id, || {
                Ok((
                    MemoryStore::default(),
                    Snapshot::new(Document::empty(id, "Initial"))?,
                ))
            })?;
        }
        Ok(h)
    })
    .unwrap();
    let a = connect(&e, "a", true);
    let b = connect(&e, "b", true);
    assert_eq!(
        enqueue_raw(&a, vec![b' '; FRAME_BYTES + 1].into_boxed_slice())
            .err()
            .unwrap()
            .code,
        "RAW_LIMIT"
    );
    let first = enqueue_raw(&a, vec![b' '; FRAME_BYTES].into_boxed_slice()).unwrap();
    let second = enqueue_raw(&b, vec![b' '; FRAME_BYTES].into_boxed_slice()).unwrap();
    assert_eq!(e.status().input_bytes, 2 * FRAME_BYTES);
    assert_eq!(
        enqueue_raw(&a, vec![b' '; FRAME_BYTES].into_boxed_slice())
            .err()
            .unwrap()
            .code,
        "EXECUTOR_FULL"
    );
    assert!(first.cancel());
    assert!(second.cancel());
    a.stop().unwrap();
    gate.release();
    assert_eq!(result(first)["error"]["code"], "CANCELLED");
    assert_eq!(result(second)["error"]["code"], "CANCELLED");
    wait(|| e.status().requests == 0);
    assert!(!hello(&a).is_empty());
    e.shutdown().join().unwrap();
}
#[test]
fn transport_slots_and_document_slots_cannot_be_monopolized() {
    let e = memory();
    let mut a = Vec::new();
    for _ in 0..4 {
        a.push(connect(&e, "a", true));
    }
    wait(|| match e.connect("a", true) {
        Err(e) if e.code == "SERVICE_LIMIT" => true,
        Err(e) if e.code == "EXECUTOR_BUSY" => false,
        _ => panic!("a fifth connection was admitted"),
    });
    let b = connect(&e, "b", true);
    assert!(!hello(&b).is_empty());
    drop(a);
    let mut reused = None;
    wait(|| match e.connect("a", false) {
        Ok(c) => {
            reused = Some(c);
            true
        }
        Err(e) if e.code == "EXECUTOR_BUSY" || e.code == "SERVICE_LIMIT" => false,
        Err(e) => panic!("{e}"),
    });
    assert!(!hello(&reused.unwrap()).is_empty());
    assert_eq!(
        e.connect("not-a-native-scope", true).err().unwrap().code,
        "AUTH_REQUIRED"
    );
    e.shutdown().join().unwrap();
}
#[test]
fn shutdown_cancels_queued_writes_and_joins_only_after_in_progress_io() {
    let g = Arc::new(Gate::default());
    let _guard = Guard(g.clone());
    let e = blocked(g.clone());
    let a = connect(&e, "a", true);
    let s = hello(&a);
    let t = ticket(&a, &s, "Saved", 0);
    let active = request(&a, &s, &t, "Saved");
    wait(|| g.entered.load(Ordering::SeqCst) == 1);
    let queued = enqueue(&a, json!({"method":"checkpoint","session":s}));
    wait(|| e.status().writer_pending == 2);
    let join = e.shutdown();
    assert!(!a.status().accepting);
    assert_eq!(
        enqueue_raw(&a, Box::from(&b"{}"[..])).err().unwrap().code,
        "SERVICE_CLOSED"
    );
    g.release();
    let _ = result(active);
    assert_eq!(result(queued)["error"]["code"], "CANCELLED");
    join.join().unwrap();
    assert_eq!(g.appends.load(Ordering::SeqCst), 1);
    assert_eq!(g.dropped.load(Ordering::SeqCst), 2);
}
#[test]
fn panicked_writer_is_not_retried_and_control_owner_survives() {
    let g = Arc::new(Gate {
        panic_after_write: true,
        ..Gate::default()
    });
    let _guard = Guard(g.clone());
    g.release();
    let e = blocked(g.clone());
    let a = connect(&e, "a", true);
    let b = connect(&e, "b", true);
    let s = hello(&a);
    let sb = hello(&b);
    let t = ticket(&a, &s, "Saved", 0);
    let r = result(request(&a, &s, &t, "Saved"));
    assert!(!r["ok"].as_bool().unwrap());
    assert_eq!(g.appends.load(Ordering::SeqCst), 1);
    assert_eq!(
        rpc(&b, json!({"method":"inspect","session":sb}))["ok"],
        true
    );
    assert_eq!(
        rpc(&a, json!({"method":"inspect","session":s}))["error"]["code"],
        "RECOVERY_REQUIRED"
    );
    e.close_document("a").unwrap();
    assert_eq!(e.connect("a", true).err().unwrap().code, "SERVICE_CLOSED");
    e.shutdown().join().unwrap();
}
#[test]
fn startup_failure_wakes_pending_requests_without_exposing_native_paths() {
    let gate = Arc::new(Gate::default());
    let _guard = Guard(gate.clone());
    let g = gate.clone();
    let e = Executor::spawn::<MemoryStore, _>(vec!["a".into()], move || {
        let m = g.release.0.lock().unwrap();
        let (m, t) = g
            .release
            .1
            .wait_timeout_while(m, Duration::from_secs(15), |v| !*v)
            .unwrap();
        assert!(!t.timed_out());
        drop(m);
        Err(Error::new(
            "STORE_IO",
            "/private/path",
            "private diagnostic",
        ))
    })
    .unwrap();
    let a = connect(&e, "a", true);
    let task = enqueue(&a, json!({"method":"hello"}));
    gate.release();
    let r = result(task);
    assert_eq!(r["error"]["code"], "STARTUP_FAILED");
    assert!(!r.to_string().contains("private"));
    e.shutdown().join().unwrap();
}
#[test]
fn bounded_framing_never_reads_an_unbounded_tail_or_reinterprets_suffixes() {
    let mut r = Cursor::new(b"{}\n{}\n".to_vec());
    assert_eq!(&*frame::read(&mut r).unwrap().unwrap(), b"{}\n");
    assert_eq!(&*frame::read(&mut r).unwrap().unwrap(), b"{}\n");
    assert!(frame::read(&mut r).unwrap().is_none());
    let mut r = Cursor::new(vec![b'x'; FRAME_BYTES + 100]);
    assert_eq!(frame::read(&mut r).unwrap_err().code, "RAW_LIMIT");
    assert_eq!(r.position(), (FRAME_BYTES + 1) as u64);
}

#[test]
fn racing_shutdown_finishes_every_accepted_request() {
    for _ in 0..64 {
        let executor = memory();
        let client = connect(&executor, "a", true);
        let admitted = Arc::new(AtomicUsize::new(0));
        let count = admitted.clone();
        let sender = thread::spawn(move || {
            let mut accepted = Vec::new();
            for _ in 0..10000 {
                match client.request(Box::from(&br#"{"method":"hello"}"#[..])) {
                    Ok(task) => {
                        accepted.push(task);
                        count.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(e) if e.code == "SERVICE_CLOSED" => break,
                    Err(e) if e.code == "EXECUTOR_BUSY" || e.code == "EXECUTOR_FULL" => {
                        thread::yield_now()
                    }
                    Err(e) => panic!("{e}"),
                }
            }
            (client, accepted)
        });
        wait(|| admitted.load(Ordering::SeqCst) > 0);
        let shutdown = executor.shutdown();
        let (client, mut tasks) = sender.join().unwrap();
        assert!(!tasks.is_empty());
        wait(|| {
            tasks.retain_mut(|t| t.try_take().is_none());
            tasks.is_empty()
        });
        wait(|| client.status().requests == 0);
        shutdown.join().unwrap();
    }
}

#[test]
fn full_reply_capacity_keeps_stop_usable_and_returns_rejected_allocation() {
    let e = memory();
    let a = connect(&e, "a", true);
    let a2 = connect(&e, "a", false);
    let b = connect(&e, "b", true);
    let b2 = connect(&e, "b", false);
    let clients = [&a, &a2, &b, &b2];
    let sessions: Vec<_> = clients.iter().map(|c| hello(c)).collect();
    let mut held = Vec::new();
    for (c, session) in clients.iter().zip(sessions) {
        for _ in 0..4 {
            held.push(
                enqueue(c, json!({"method":"services","session":session}))
                    .wait()
                    .unwrap(),
            );
        }
    }
    assert_eq!(e.status().requests, 16);
    let bytes: Box<[u8]> = Box::from(&b"{}"[..]);
    let ptr = bytes.as_ptr();
    let mut bytes = bytes;
    let rejected = loop {
        match a.try_request(bytes) {
            Err(r) if r.error.code == "EXECUTOR_BUSY" => {
                bytes = r.bytes;
                thread::yield_now();
            }
            Err(r) => break r,
            Ok(_) => panic!("over-capacity request admitted"),
        }
    };
    assert_eq!(rejected.error.code, "EXECUTOR_FULL");
    assert_eq!(rejected.bytes.as_ptr(), ptr);
    a.stop().unwrap();
    b.stop().unwrap();
    wait(|| e.status().stops_applied == 2);
    drop(held);
    wait(|| e.status().requests == 0);
    e.shutdown().join().unwrap();
}

#[test]
fn reused_reply_capacity_exposes_only_the_new_payload_and_stays_bounded() {
    let executor = memory();
    let client = connect(&executor, "a", true);
    let session = hello(&client);
    let original = rpc(&client, json!({"method":"inspect","session":session}));
    assert_eq!(original["result"]["document"]["title"], "Initial");
    wait(|| executor.status().requests == 0);
    let cached = executor.status().cached_reply_bytes;
    assert!(
        cached > 0
            && cached
                <= producer_production_service::REQUESTS * producer_production_service::REPLY_BYTES
    );
    // Reuse the larger full-document response allocation for a small response.
    // Reading to the buffer's capacity instead of its length would leak a tail.
    for _ in 0..64 {
        let response = reply_bytes(&client, &session);
        let value: Value = serde_json::from_slice(response.bytes()).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["services"]["readers"], 0);
        assert!(!String::from_utf8_lossy(response.bytes()).contains("Initial"));
        drop(response);
    }
    wait(|| executor.status().requests == 0);
    assert!(
        executor.status().cached_reply_bytes
            <= producer_production_service::REQUESTS * producer_production_service::REPLY_BYTES
    );
    executor.shutdown().join().unwrap();
}
fn reply_bytes(c: &Client, session: &str) -> producer_production_service::Reply {
    enqueue(c, json!({"method":"services","session":session}))
        .wait()
        .unwrap()
}
