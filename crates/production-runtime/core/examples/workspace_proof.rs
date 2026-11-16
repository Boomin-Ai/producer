//! 100k synthetic field edits through command application and the bounded host.
//! Live requested heap bytes are tracked independently of reservation estimates.
use producer_production_core::{
    commands::{self, Command, Operation},
    contract::*,
    coordinator::*,
    lifecycle::Cost,
    storage::*,
    workspace::*,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};
struct Tracked;
static LIVE: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Tracked {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            LIVE.fetch_sub(l.size(), Ordering::Relaxed);
            LIVE.fetch_add(n, Ordering::Relaxed);
        }
        q
    }
}
#[global_allocator]
static A: Tracked = Tracked;
fn drain(w: &mut Workspace) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        w.dispatch().unwrap();
        for out in w.poll(1) {
            match out {
                CompileOutcome::Prepared {
                    document, token, ..
                } => w.cancel(&document, token).unwrap(),
                CompileOutcome::Discarded { .. } => {}
                other => panic!("{other:?}"),
            }
        }
        let s = w.status();
        if s.pending + s.running == 0 {
            return;
        }
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
}
// Test-process-only memory sampling. No desktop process or GPU is inspected.
#[cfg(target_os = "macos")]
#[allow(
    deprecated,
    reason = "Test-process-only RSS sampling uses the already locked libc Mach bindings"
)]
fn rss() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::mach_task_basic_info_data_t>::zeroed();
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    // SAFETY: self task, correct flavor, buffer type/size and writable count.
    let result = unsafe {
        libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            info.as_mut_ptr().cast(),
            &mut count,
        )
    };
    if result != libc::KERN_SUCCESS || count != libc::MACH_TASK_BASIC_INFO_COUNT {
        return None;
    }
    Some(unsafe { info.assume_init() }.resident_size)
}
#[cfg(target_os = "linux")]
fn rss() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages = stat.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    // SAFETY: read-only sysconf query, no pointers.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    pages.checked_mul(u64::try_from(size).ok()?)
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn rss() -> Option<u64> {
    None
}
fn main() {
    let before = LIVE.load(Ordering::Relaxed);
    let mut w = Workspace::new().unwrap();
    let mut docs = [Document::empty("alpha", "A"), Document::empty("beta", "B")];
    let mut authority = Coordinator::new(
        Snapshot::new(docs[0].clone()).unwrap(),
        MemoryStore::default(),
    );
    let grant = authority.session(true).unwrap().1;
    for d in &docs {
        w.open(&d.id).unwrap();
    }
    let mut samples = Vec::with_capacity(10);
    let mut rss_samples = Vec::with_capacity(10);
    let begin = Instant::now();
    for i in 0..100_000 {
        let n = i as usize % 2;
        let command = Command::Transaction {
            operations: vec![Operation::SetTitle {
                title: format!("Edit {i:06}"),
            }],
        };
        docs[n] = commands::apply(&docs[n], &command).unwrap();
        w.submit(docs[n].clone(), Counter(i + 1), 0, grant.clone())
            .unwrap();
        if i % 100 == 99 {
            drain(&mut w);
        }
        let s = w.status();
        assert!(s.documents <= 2 && s.running <= 2 && s.pending <= 2 && s.reservations <= 8);
        if i % 10_000 == 9_999 {
            drain(&mut w);
            samples.push(LIVE.load(Ordering::Relaxed));
            rss_samples.push(rss());
        }
    }
    let elapsed = begin.elapsed().as_secs_f64();
    let plateau = samples[1..].iter().max().unwrap() - samples[1..].iter().min().unwrap();
    assert!(
        plateau < 1024 * 1024,
        "retained requested heap must plateau after warmup"
    );
    let resident: Option<Vec<u64>> = rss_samples[1..].iter().copied().collect();
    let rss_span = resident.map(|v| v.iter().max().unwrap() - v.iter().min().unwrap());
    assert!(
        rss_span.is_none_or(|span| span < 16 * 1024 * 1024),
        "small-workload RSS must plateau after warmup"
    );
    for d in &docs {
        w.close(&d.id).unwrap();
        w.finish_close(&d.id).unwrap();
    }
    assert_eq!(w.status().used, Cost::default());
    assert_eq!(w.status().reservations, 0);
    drop(w);
    drop(docs);
    drop(authority);
    drop(grant);
    let after = LIVE.load(Ordering::Relaxed);
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({
        "synthetic":true,"commandsApplied":100000,"documents":2,"compileWorkers":2,
        "workload":"small field edits; coalescing, compile/release every 100 edits",
        "elapsedSeconds":elapsed,"liveRequestedHeapBytesEvery10000":samples,
        "postWarmupHeapSpanBytes":plateau,"baselineHeapBytes":before,"afterDropHeapBytes":after,
        "finalReservations":0,"residentBytesEvery10000":rss_samples,"postWarmupRssSpanBytes":rss_span,
        "rssScope":"current test process on macOS/Linux when available; no VRAM or native driver workload",
        "durableJournal":"not part of this workload; application and scheduling only"
    })).unwrap());
}
