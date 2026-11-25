//! Actual isolated FileStore workload, not desktop/media/VRAM qualification.
#[path = "support/memory.rs"]
mod memory;
use producer_production_core::{
    commands::{Command, Operation},
    contract::*,
    coordinator::*,
    host::*,
    retention,
    storage::*,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p =
            std::env::temp_dir().join(format!("producer-durable-proof-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        assert!(
            fs2::available_space(&p).unwrap() > 192 * 1024 * 1024,
            "test requires bounded temporary-file reserve"
        );
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
fn edit(n: usize) -> Command {
    Command::Transaction {
        operations: vec![Operation::SetTitle {
            title: format!("Edit {n:06}"),
        }],
    }
}
fn document(id: &str, dense: bool) -> Document {
    let mut d = Document::empty(id, "Edit 000000");
    if dense {
        d.metadata.insert(
            "dense".into(),
            Value::Array(vec![Value::Null; RAW_VALUES - 512]),
        );
    }
    // Leave 4KiB for later title/frame/schema growth; each individual string
    // respects the 64KiB ingress limit. Exact final encoded size is measured.
    let target = DOCUMENT_BYTES - 4096;
    let mut left = target - serde_json::to_vec(&d).unwrap().len();
    let mut n = 0;
    while left > 64 {
        let key = format!("padding-{n:04}");
        let overhead = key.len() + 6; // comma, two key quotes, colon, two value quotes
        let len = (left - overhead).min(STRING_BYTES);
        d.metadata.insert(key, Value::String("x".repeat(len)));
        left -= len + overhead;
        n += 1;
    }
    validate_document(&d).unwrap();
    let bytes = serde_json::to_vec(&d).unwrap().len();
    assert!((target - 64..=target).contains(&bytes));
    d
}
fn close(h: &mut ProductionHost<FileStore>, ids: &[&str]) {
    for id in ids {
        h.close(id).unwrap();
        h.finish_close(id).unwrap();
    }
}
fn normal(dense: bool) -> Value {
    let temp = Temp::new();
    let baseline = memory::live();
    memory::reset_peak();
    let mut h = ProductionHost::<FileStore>::new().unwrap();
    let ids = ["alpha", "beta"];
    let mut shape = Vec::new();
    for id in ids {
        let d = document(id, dense);
        shape.push(retention::measure(&d).unwrap());
        h.open(id, || FileStore::open(&temp.0.join(id), d)).unwrap();
    }
    let sessions: Vec<_> = ids.iter().map(|id| h.session(id, true).unwrap()).collect();
    let submitters: Vec<_> = sessions.iter().map(|s| h.submitter(s).unwrap()).collect();
    let mut revisions = [Counter(0); 2];
    let mut last = Vec::new();
    let mut samples = Vec::new();
    let begin = Instant::now();
    for round in 1..=24 {
        for n in 0..2 {
            let cmd = edit(round);
            let t = h.issue(&sessions[n], revisions[n], &cmd, 0).unwrap();
            let r = submitters[n].submit(&t, &cmd, 1).unwrap();
            assert_eq!(r.outcome, Outcome::Saved);
            revisions[n] = r.revision;
            if round == 24 {
                last.push((t, r));
            }
            let history = h.history_status(&sessions[n]).unwrap();
            assert!(
                history.entries <= HISTORY_ENTRIES
                    && history.encoded_bytes <= HISTORY_BYTES
                    && history.structural_units <= HISTORY_UNITS
            );
            if round % 8 == 0 {
                h.checkpoint(&sessions[n]).unwrap();
            }
        }
        if round % 4 == 0 {
            let used = size(&temp.0);
            assert!(used < 192 * 1024 * 1024);
            samples.push(json!({"round":round,"liveRequestedHeapBytes":memory::live(),"largeAllocationCalls":memory::large_calls(),"largeAllocationBytes":memory::large_bytes(),"residentBytes":memory::rss(),"allocator":memory::allocator(),"storeBytes":used,"history":[h.history_status(&sessions[0]).unwrap(),h.history_status(&sessions[1]).unwrap()]}));
            eprintln!("measurement: {}", samples.last().unwrap());
        }
    }
    let warm: Vec<_> = samples[2..]
        .iter()
        .map(|v| v["liveRequestedHeapBytes"].as_u64().unwrap())
        .collect();
    let heap_span = warm.iter().max().unwrap() - warm.iter().min().unwrap();
    let heap_gate = heap_span < 1024 * 1024;
    let rss: Option<Vec<_>> = samples[2..]
        .iter()
        .map(|v| v["residentBytes"].as_u64())
        .collect();
    let rss_span = rss.map(|v| v.iter().max().unwrap() - v.iter().min().unwrap());
    eprintln!(
        "plateau: {}",
        json!({"heapSpanBytes":heap_span,"rssSpanBytes":rss_span,"peakRequestedHeapBytes":memory::peak()})
    );
    let rss_gate = rss_span.is_none_or(|v| v < 64 * 1024 * 1024);
    assert_eq!(
        h.history_status(&sessions[0]).unwrap().entries,
        if dense { 2 } else { 4 }
    );
    // Four retained full-document reads remain charged across exact close.
    let held: Vec<_> = (0..4)
        .map(|n| h.inspect(&sessions[n % 2]).unwrap())
        .collect();
    assert_eq!(h.inspect(&sessions[0]).err().unwrap().code, "SERVICE_LIMIT");
    let held_heap = memory::live();
    let held_rss = memory::rss();
    close(&mut h, &ids);
    let closed = h.services();
    assert_eq!(
        closed.documents
            + closed.sessions
            + closed.observers
            + closed.submissions
            + closed.flights
            + closed.waiters,
        0
    );
    assert_eq!(closed.readers, 4);
    let with_reads = memory::live();
    drop(held);
    assert_eq!(h.services().read_bytes + h.services().readers, 0);
    let released = memory::live();
    // Real checkpoint load + journal replay + historical receipt retry on a new
    // writer. Stale handles must not hold writer locks or authority after close.
    for (n, id) in ids.iter().enumerate() {
        h.open(id, || {
            FileStore::open(&temp.0.join(id), Document::empty(id, "unused"))
        })
        .unwrap();
        let s = h.session(id, true).unwrap();
        let inspect = h.inspect(&s).unwrap();
        assert_eq!(inspect.revision, revisions[n]);
        assert_eq!(inspect.document().title, "Edit 000024");
        drop(inspect);
        assert_eq!(h.history_status(&s).unwrap().entries, 0);
        assert_eq!(
            h.submitter(&s)
                .unwrap()
                .submit(&last[n].0, &edit(24), 2)
                .unwrap(),
            last[n].1
        );
        assert_eq!(
            submitters[n]
                .submit(&last[n].0, &edit(24), 2)
                .unwrap_err()
                .code,
            "AUTH_REQUIRED"
        );
    }
    close(&mut h, &ids);
    let final_services = h.services();
    drop(h);
    drop(submitters);
    drop(sessions);
    drop(last);
    let after = memory::live();
    let release_gate = after < baseline + 1024 * 1024;
    json!({"shape":if dense {"near-byte-and-value-limit"}else{"near-byte-limit"},"documents":2,"weight":shape,"durableCommits":48,"checkpointEveryCommitsPerDocument":8,"samples":samples,"elapsedSeconds":begin.elapsed().as_secs_f64(),"postWarmupHeapSpanBytes":heap_span,"postWarmupResidentSpanBytes":rss_span,"peakRequestedHeapBytes":memory::peak(),"baselineHeapBytes":baseline,"allocationCalls":memory::allocations(),"callingThreadAllocationCalls":memory::thread_allocations(),"heapWithFourReads":held_heap,"residentWithFourReads":held_rss,"heapAfterCloseWithReads":with_reads,"heapAfterReadRelease":released,"afterHostDropHeapBytes":after,"residentAfterHostDrop":memory::rss(),"allocatorAfterHostDrop":memory::allocator(),"servicesAfterCloseWithHeldReads":closed,"finalServices":final_services,"requestedHeapGatePassed":heap_gate,"rssGatePassed":rss_gate,"ownerReleaseGatePassed":release_gate,"qualificationPassed":heap_gate && rss_gate && release_gate,"recoveryAndExactlyOnceRetry":true,"readersReleasedAfterDrop":true})
}
fn journal_full() -> Value {
    let temp = Temp::new();
    let mut h = ProductionHost::<FileStore>::new().unwrap();
    h.open("bulk", || {
        FileStore::open(&temp.0.join("bulk"), Document::empty("bulk", "initial"))
    })
    .unwrap();
    let s = h.session("bulk", true).unwrap();
    let submit = h.submitter(&s).unwrap();
    let mut rev = Counter(0);
    let mut cmd = Command::Import {
        document: document("bulk", false),
    };
    let mut saved = 0;
    let before = Instant::now();
    let rejected;
    loop {
        if let Command::Import { document } = &mut cmd {
            document.title = format!("Bulk {saved:06}");
        }
        let t = h.issue(&s, rev, &cmd, 0).unwrap();
        let r = submit.submit(&t, &cmd, 1).unwrap();
        if r.outcome == Outcome::Saved {
            rev = r.revision;
            saved += 1;
            assert!(saved <= 8);
        } else {
            assert_eq!(r.revision, rev);
            rejected = r;
            break;
        }
    }
    assert_eq!(saved, 8);
    assert!(matches!(&rejected.outcome,Outcome::Rejected(e) if e.message.contains("journal full")));
    let history = h.history_status(&s).unwrap();
    assert_eq!(submit.submit(&rejected.ticket, &cmd, 2).unwrap(), rejected);
    assert_eq!(h.history_status(&s).unwrap(), history);
    let journal_bytes = fs::metadata(temp.0.join("bulk/journal.jsonl"))
        .unwrap()
        .len();
    assert!(journal_bytes <= JOURNAL_BYTES);
    h.checkpoint(&s).unwrap();
    assert_eq!(
        fs::metadata(temp.0.join("bulk/journal.jsonl"))
            .unwrap()
            .len(),
        0
    );
    let t = h.issue(&s, rev, &cmd, 2).unwrap();
    let r = submit.submit(&t, &cmd, 3).unwrap();
    assert_eq!(r.outcome, Outcome::Saved);
    close(&mut h, &["bulk"]);
    h.open("bulk", || {
        FileStore::open(&temp.0.join("bulk"), Document::empty("bulk", "unused"))
    })
    .unwrap();
    let new = h.session("bulk", true).unwrap();
    assert_eq!(h.inspect(&new).unwrap().revision, r.revision);
    assert_eq!(h.submitter(&new).unwrap().submit(&t, &cmd, 4).unwrap(), r);
    close(&mut h, &["bulk"]);
    json!({"shape":"journal-pressure","largeImportsSavedBeforeFull":saved,"journalBytesAtRejection":journal_bytes,"journalLimit":JOURNAL_BYTES,"notWrittenPreservedHistory":true,"newTicketSucceededAfterCheckpoint":true,"recoveryAndExactlyOnceRetry":true,"elapsedSeconds":before.elapsed().as_secs_f64(),"finalServices":h.services()})
}
fn main() {
    let shape = std::env::args().nth(1).unwrap_or_default();
    let result = if shape == "--journal" {
        journal_full()
    } else {
        normal(shape == "--dense")
    };
    let passed = result
        .get("qualificationPassed")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    println!("{}",serde_json::to_string_pretty(&json!({"synthetic":true,"storage":"actual isolated FileStore with sync","rssScope":"current proof process on macOS/Linux when available; no media, GPU, GPUI or desktop measurement","result":result})).unwrap());
    if !passed {
        std::process::exit(1);
    }
}
