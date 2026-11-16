//! Reproducible core-only profile; no renderer, browser, codec or claimed FPS gain.
use producer_production_core::{compile::*, contract::*};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Instant,
};
struct Counted;
static COUNT: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
// Benchmark-only instrumentation around the platform allocator.
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if COUNT.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if COUNT.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Counted = Counted;
fn fixture() -> Document {
    let mut d = fixture::classic_like();
    let n = validate_document(&d).unwrap().expanded_nodes;
    let root = &mut d
        .sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root;
    for i in n..1000 {
        root.children.push(Node {
            id: format!("node-{i}"),
            frame: Some(Rect {
                x: (i % 50) as f64 * 20.0,
                y: (i / 50) as f64 * 20.0,
                width: 20.0,
                height: 20.0,
            }),
            flow: Flow::Overlay,
            content: Content::Group,
            children: vec![],
            bindings: vec![],
        });
    }
    let inventory = validate_document(&d).unwrap();
    let targets: Vec<_> = inventory
        .targets
        .into_iter()
        .filter(|t| t.property == Property::Opacity)
        .take(256)
        .collect();
    let q = d.sequences.get_mut("opener").unwrap();
    q.tracks = targets
        .into_iter()
        .enumerate()
        .map(|(i, target)| Track {
            id: format!("track-{i}"),
            target,
            range: Range {
                start: Time::ZERO,
                duration: Time::seconds(8),
            },
            keys: vec![
                Key {
                    at: Time::ZERO,
                    value: Value::Number(0.0),
                },
                Key {
                    at: Time::seconds(8),
                    value: Value::Number(1.0),
                },
            ],
            interpolation: Interpolation::Linear,
        })
        .collect();
    d
}
fn percentile(ns: &mut [u128], percent: usize) -> f64 {
    ns.sort_unstable();
    ns[(ns.len() - 1) * percent / 100] as f64 / 1_000_000.0
}
fn main() {
    let d = fixture();
    let begin = Instant::now();
    let p = compile(&d).unwrap();
    let cold = begin.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(p.nodes.len(), 1000);
    let sequence = &p.sequences["opener"];
    let mut out = vec![None; sequence.tracks.len()];
    for i in 0..1000 {
        sequence
            .evaluate_into(Time::new(i % 960, 120).unwrap(), &mut out)
            .unwrap();
    }
    let mut samples = Vec::with_capacity(20_000);
    ALLOCS.store(0, Ordering::Relaxed);
    COUNT.store(true, Ordering::Relaxed);
    for i in 0..20_000 {
        let t = Time::new(i % 960, 120).unwrap();
        let begin = Instant::now();
        sequence
            .evaluate_into(t, std::hint::black_box(&mut out))
            .unwrap();
        samples.push(begin.elapsed().as_nanos());
    }
    COUNT.store(false, Ordering::Relaxed);
    let allocations = ALLOCS.load(Ordering::Relaxed);
    assert_eq!(allocations, 0, "evaluation allocated");
    let p99 = percentile(&mut samples, 99);
    let mut compiles = Vec::new();
    for _ in 0..30 {
        let begin = Instant::now();
        std::hint::black_box(compile(&d).unwrap());
        compiles.push(begin.elapsed().as_nanos());
    }
    let p95 = percentile(&mut compiles, 95);
    let result = serde_json::json!({"fixtureDigest":digest(&d).unwrap(),"nodes":p.nodes.len(),"tracks":sequence.tracks.len(),"evaluationSamples":samples.len(),"evaluationP99Ms":p99,"evaluationAllocations":allocations,"firstCompileMs":cold,"repeatedFullCompileP95Ms":p95,"evaluationGate1Ms":p99<=1.0,"coldCompileGate250Ms":cold<=250.0,"fullCompileReference50Ms":p95<=50.0,"dirtySubgraphCompile":"not implemented/qualified","nativeGpu":"not measured"});
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    assert!(
        p99 <= 1.0 && cold <= 250.0,
        "core evaluation/cold compile gate failed"
    );
}
