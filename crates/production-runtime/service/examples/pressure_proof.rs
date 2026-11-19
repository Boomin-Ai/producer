//! Bounded whole-service CPU/heap/IO laboratory. No app, media or GPU adapter.
#[path = "../../core/examples/support/memory.rs"]
mod memory;
#[path = "../../core/examples/support/pressure.rs"]
mod pressure;
use producer_production_core::{
    commands::{Command, Operation},
    contract::*,
    host::ProductionHost,
    retention,
    storage::*,
};
use producer_production_service::{Client, Executor, Reply, Task, REPLY_BYTES, REQUESTS};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "producer-service-pressure-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&p).unwrap();
        assert!(fs2::available_space(&p).unwrap() > 192 * 1024 * 1024);
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn size(p: &Path) -> u64 {
    fs::read_dir(p)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            if p.is_dir() {
                size(&p)
            } else {
                p.metadata().unwrap().len()
            }
        })
        .sum()
}
fn enqueue(c: &Client, v: Value) -> Task {
    let mut bytes = serde_json::to_vec(&v).unwrap().into_boxed_slice();
    let end = Instant::now() + Duration::from_secs(120);
    loop {
        match c.try_request(bytes) {
            Ok(t) => return t,
            Err(r) if r.error.code == "EXECUTOR_BUSY" => {
                assert!(Instant::now() < end);
                bytes = r.bytes;
                thread::yield_now();
            }
            Err(r) => panic!("{}", r.error),
        }
    }
}
fn reply(mut task: Task) -> Reply {
    let end = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(r) = task.try_take() {
            return r;
        }
        assert!(Instant::now() < end, "response deadline");
        thread::sleep(Duration::from_millis(1));
    }
}
fn rpc(c: &Client, v: Value) -> Value {
    let r = reply(enqueue(c, v));
    let v: Value = serde_json::from_slice(r.bytes()).unwrap();
    assert_eq!(v["ok"], true, "{v}");
    v["result"].clone()
}
fn drained(c: &Client) {
    // Reply publication precedes the control owner's final Arc drop. Wait for
    // that bounded handoff; polling once here would assert an invalid ordering.
    let end = Instant::now() + Duration::from_secs(120);
    while c.status().requests != 0 {
        assert!(Instant::now() < end, "request reservations did not drain");
        thread::sleep(Duration::from_millis(1));
    }
}
fn connect(e: &Executor, id: &str) -> Client {
    let end = Instant::now() + Duration::from_secs(120);
    loop {
        match e.connect(id, true) {
            Ok(c) => return c,
            Err(e) if e.code == "EXECUTOR_BUSY" => {
                assert!(Instant::now() < end);
                thread::yield_now();
            }
            Err(e) => panic!("{e}"),
        }
    }
}
fn start(temp: &Temp, nested: bool, initial: bool) -> Executor {
    let root = temp.0.clone();
    Executor::spawn(vec!["alpha".into(), "beta".into()], move || {
        let mut h = ProductionHost::new()?;
        for id in ["alpha", "beta"] {
            let d = if initial {
                pressure::document(id, nested)
            } else {
                Document::empty(id, "unused")
            };
            h.open(id, || FileStore::open(&root.join(id), d))?;
        }
        Ok(h)
    })
    .unwrap()
}
fn open(e: &Executor) -> (Vec<Client>, Vec<String>) {
    let clients: Vec<_> = (0..8)
        .map(|n| connect(e, if n < 4 { "alpha" } else { "beta" }))
        .collect();
    let sessions = clients
        .iter()
        .map(|c| {
            rpc(c, json!({"method":"hello"}))["session"]
                .as_str()
                .unwrap()
                .into()
        })
        .collect();
    (clients, sessions)
}
fn edit(round: usize) -> Command {
    Command::Transaction {
        operations: vec![Operation::SetTitle {
            title: format!("Pressure {round:06}"),
        }],
    }
}
fn frame_profile(d: &Document) -> Value {
    let p = producer_production_core::compile::compile(d).unwrap();
    let q = &p.sequences["timeline"];
    let mut values = vec![None; q.tracks.len()];
    let mut effects = vec![None; q.effects.len()];
    let mut ns = vec![0u64; 4000];
    let frame = |i: usize, values: &mut [_], effects: &mut [_]| {
        let t = Time::new((i % 1800) as i64, 240).unwrap();
        q.evaluate_into(t, values).unwrap();
        q.evaluate_effects_into(t, effects).unwrap();
        std::hint::black_box((&values, &effects));
    };
    for i in 0..1000 {
        frame(i, &mut values, &mut effects);
    }
    let before = memory::thread_allocations();
    for (i, elapsed) in ns.iter_mut().enumerate() {
        let at = Instant::now();
        frame(i, &mut values, &mut effects);
        *elapsed = at.elapsed().as_nanos() as u64;
    }
    let allocations = memory::thread_allocations().wrapping_sub(before);
    assert_eq!(allocations, 0);
    ns.sort_unstable();
    let p99 = ns[ns.len() * 99 / 100];
    let passed = p99 < 1_000_000;
    json!({"scope":"numeric tracks and effect-clock inputs only; no GPU, noise kernel or transport serialization", "samples":ns.len(),"tracks":q.tracks.len(),"effects":q.effects.len(),"allocationsOnEvaluationThread":allocations,"p99Ms":p99 as f64/1e6,"maxMs":ns[ns.len()-1] as f64/1e6,"p99GatePassed":passed})
}
fn full_replies(clients: &[Client], sessions: &[String]) -> Vec<Reply> {
    let tasks: Vec<_> = [0, 1, 4, 5]
        .into_iter()
        .flat_map(|n| (0..4).map(move |_| n))
        .map(|n| {
            enqueue(
                &clients[n],
                json!({"method":"inspect","session":sessions[n]}),
            )
        })
        .collect();
    tasks.into_iter().map(reply).collect()
}
fn main() {
    let nested = std::env::args().any(|a| a == "--nested");
    let temp = Temp::new();
    let baseline = memory::live();
    memory::reset_peak();
    let begin = Instant::now();
    let mut e = start(&temp, nested, true);
    let (mut clients, mut sessions) = open(&e);
    let mut shapes = Vec::new();
    let mut evaluation = Vec::new();
    for n in [0, 4] {
        let r = rpc(
            &clients[n],
            json!({"method":"inspect","session":sessions[n]}),
        );
        let d: Document = serde_json::from_value(r["document"].clone()).unwrap();
        evaluation.push(frame_profile(&d));
        let p = producer_production_core::compile::compile(&d).unwrap();
        shapes.push(json!({"weight":retention::measure(&d).unwrap(),"nodes":p.nodes.len(),"declaredTracks":p.inventory.tracks,"aggregateExpandedTracks":p.inventory.expanded_tracks,"rootTracks":p.sequences["timeline"].tracks.len(),"keysPerDeclaredTrack":d.sequences.values().flat_map(|s|&s.tracks).next().unwrap().keys.len(),"rootEffects":p.sequences["timeline"].effects.len(),"aggregateEffects":p.sequences.values().map(|s|s.effects.len()).sum::<usize>(),"componentPlacements":128,"sources":d.sources.len()}));
    }
    let times = [
        Time::new(7, 2).unwrap(),
        Time::new(1, 4).unwrap(),
        Time::seconds(5),
    ];
    let reference: Vec<Vec<_>> = [0, 4].into_iter().map(|n| times.iter().map(|time|rpc(&clients[n],json!({"method":"evaluate","session":sessions[n],"sequence":"timeline","time":time}))).collect()).collect();
    let mut samples = Vec::new();
    let mut historical = Vec::new();
    let mut recovery_ms = Vec::new();
    let mut peaks = Vec::new();
    for round in 1..=12 {
        for n in [0, 4] {
            let command = edit(round);
            let t=rpc(&clients[n],json!({"method":"issue","session":sessions[n],"expected":(round-1).to_string(),"command":command}))["ticket"].as_str().unwrap().to_string();
            let r = rpc(
                &clients[n],
                json!({"method":"submit","session":sessions[n],"ticket":t,"command":command}),
            );
            assert_eq!(r["outcome"]["status"], "saved");
            if round == 1 {
                historical.push((t, r));
            }
            if round % 4 == 0 {
                rpc(
                    &clients[n],
                    json!({"method":"checkpoint","session":sessions[n]}),
                );
            }
        }
        // Maximum 16 admitted requests/held replies, 8 per document, 4 per client.
        let held = full_replies(&clients, &sessions);
        assert_eq!(e.status().requests, REQUESTS);
        assert_eq!(e.status().reply_allowance, REQUESTS * REPLY_BYTES);
        let raw = br#"{"method":"hello"}"#.to_vec().into_boxed_slice();
        let ptr = raw.as_ptr();
        let r = clients[2]
            .try_request(raw)
            .err()
            .expect("saturation must reject");
        assert_eq!(r.error.code, "EXECUTOR_FULL");
        assert_eq!(ptr, r.bytes.as_ptr());
        drop(r);
        let held_bytes = held.iter().map(|r| r.bytes().len()).sum::<usize>();
        assert!(held_bytes > REQUESTS * (DOCUMENT_BYTES - 8192));
        peaks.push(json!({"round":round,"heldReplyBytes":held_bytes,"requestedHeapBytes":memory::live(),"residentBytes":memory::rss(),"service":e.status()}));
        if round == 12 {
            // Shutdown revokes/joins store ownership; unread replies remain charged.
            e.shutdown().join().unwrap();
            assert_eq!(clients[0].status().requests, REQUESTS);
            drop(held);
            assert_eq!(clients[0].status().requests, 0);
            assert_eq!(clients[0].status().reply_allowance, 0);
            drop(clients);
            drop(sessions);
            e = start(&temp, nested, false);
            (clients, sessions) = open(&e);
        } else {
            drop(held);
            drained(&clients[0]);
            assert_eq!(e.status().requests, 0);
        }
        if round % 4 == 0 && round < 12 {
            e.shutdown().join().unwrap();
            drop(clients);
            drop(sessions);
            let at = Instant::now();
            e = start(&temp, nested, false);
            (clients, sessions) = open(&e);
            recovery_ms.push(at.elapsed().as_secs_f64() * 1000.0);
        }
        if round % 4 == 0 {
            // Reopen creates an empty response pool. Compare steady samples at
            // equal cache occupancy, not 16 warm buffers against a cold cache.
            drop(full_replies(&clients, &sessions));
            drained(&clients[0]);
            for n in [0, 4] {
                for (i, time) in times.iter().enumerate() {
                    assert_eq!(
                        digest(&rpc(
                            &clients[n],
                            json!({"method":"evaluate","session":sessions[n],"sequence":"timeline","time":time})
                        )).unwrap(),
                        digest(&reference[n / 4][i]).unwrap(),
                        "document recovery must preserve its own seed namespace"
                    );
                }
                let (t, r) = &historical[n / 4];
                let before = size(&temp.0);
                assert_eq!(
                    rpc(
                        &clients[n],
                        json!({"method":"submit","session":sessions[n],"ticket":t,"command":edit(1)})
                    ),
                    *r
                );
                assert_eq!(size(&temp.0), before, "historical retry must not append");
            }
        }
        drained(&clients[0]);
        let used = size(&temp.0);
        assert!(used < 192 * 1024 * 1024);
        samples.push(json!({"round":round,"liveRequestedHeapBytes":memory::live(),"residentBytes":memory::rss(),"allocationCalls":memory::allocations(),"largeAllocationCalls":memory::large_calls(),"largeAllocationBytes":memory::large_bytes(),"service":e.status(),"storeBytes":used}));
        eprintln!("measurement: {}", samples.last().unwrap());
    }
    e.shutdown().join().unwrap();
    drop(clients);
    drop(sessions);
    drop(reference);
    drop(historical);
    let released = memory::live();
    let warm = &samples[4..];
    let heap: Vec<_> = warm
        .iter()
        .map(|v| v["liveRequestedHeapBytes"].as_u64().unwrap())
        .collect();
    let heap_span = heap.iter().max().unwrap() - heap.iter().min().unwrap();
    let rss: Option<Vec<_>> = warm.iter().map(|v| v["residentBytes"].as_u64()).collect();
    let rss_span = rss.map(|v| v.iter().max().unwrap() - v.iter().min().unwrap());
    let pass = heap_span < 1024 * 1024
        && rss_span.is_none_or(|v| v < 64 * 1024 * 1024)
        && released < baseline + 1024 * 1024
        && evaluation.iter().all(|v| v["p99GatePassed"] == true);
    println!(
        "{}",
        json!({"scope":"Isolated service + real FileStore; synthetic graph/effect inputs, no physical GPU/media or UI", "nested":nested,"shapes":shapes,"evaluation":evaluation,"commits":24,"recoveries":3,"recoveryCacheWarmupBursts":3,"historicalRetryNoAppend":true,"deterministicRecoverySamples":18,"heldRepliesSurviveShutdown":true,"peakRequestedHeapBytes":memory::peak(),"baselineHeapBytes":baseline,"releasedHeapBytes":released,"allocatorAfterRelease":memory::allocator(),"postWarmupHeapSpanBytes":heap_span,"postWarmupResidentSpanBytes":rss_span,"recoveryMs":recovery_ms,"samples":samples,"saturatedSamples":peaks,"qualificationPassed":pass,"elapsedSeconds":begin.elapsed().as_secs_f64()})
    );
    assert!(pass, "unchanged heap/RSS plateau/release gates failed");
}
