//! Reproducible core-only profile; no renderer, browser, codec or claimed FPS gain.
use producer_production_core::{compile::*, contract::*, incremental::Compiler};
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
fn fixture(nested: bool) -> Document {
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
            style: None,
            id: format!("node-{i}"),
            placement: None,
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
    if nested {
        let template = q.tracks[0].clone();
        let targets = q
            .tracks
            .iter()
            .map(|t| t.target.clone())
            .collect::<Vec<_>>();
        q.tracks.clear();
        let instance = |id: String, sequence: &str| SequenceInstance {
            id,
            sequence: sequence.into(),
            range: Range {
                start: Time::ZERO,
                duration: Time::seconds(8),
            },
            source_in: Time::ZERO,
            speed: Speed::default(),
            looping: true,
            target_bindings: vec![],
            source_bindings: vec![],
        };
        q.instances = targets
            .into_iter()
            .enumerate()
            .map(|(i, target)| {
                let mut i = instance(format!("placement-{i}"), "motif");
                i.target_bindings.push(TargetBinding {
                    from: template.target.clone(),
                    to: target,
                });
                i
            })
            .collect();
        let mut leaf = Sequence {
            duration: Time::seconds(8),
            tracks: vec![template],
            instances: vec![],
            placements: vec![],
            cues: vec![],
            audio_routes: vec![],
        };
        d.sequences.insert("leaf".into(), leaf.clone());
        leaf.tracks.clear();
        let mut twice = instance("double-speed".into(), "leaf");
        twice.speed = Speed {
            numerator: 2,
            denominator: 1,
        };
        leaf.instances.push(twice);
        d.sequences.insert("motif".into(), leaf);
    }
    d
}
fn percentile(ns: &mut [u128], percent: usize) -> f64 {
    ns.sort_unstable();
    ns[(ns.len() - 1) * percent / 100] as f64 / 1_000_000.0
}
fn boundary_profile(d: &Document) -> serde_json::Value {
    // These are independent, overlapping public boundaries, not an additive
    // breakdown of compile(). Validation itself includes serialization/ingress.
    let bytes = serde_json::to_vec(d).unwrap();
    let names = [
        "typedClone",
        "serializeDocument",
        "rawIngress",
        "semanticAdmission",
        "canonicalDigest",
    ];
    let mut samples: [Vec<u128>; 5] = std::array::from_fn(|_| Vec::with_capacity(30));
    for i in 0..30 {
        // Rotate sample order; do not pretend this isolates OS/thermal load.
        for offset in 0..5 {
            let stage = (i + offset) % 5;
            let begin = Instant::now();
            match stage {
                0 => {
                    std::hint::black_box(d.clone());
                }
                1 => {
                    std::hint::black_box(serde_json::to_vec(d).unwrap());
                }
                2 => {
                    std::hint::black_box(ingress::parse(&bytes, DOCUMENT_BYTES).unwrap());
                }
                3 => {
                    std::hint::black_box(validate_document(d).unwrap());
                }
                4 => {
                    std::hint::black_box(digest(d).unwrap());
                }
                _ => unreachable!(),
            }
            samples[stage].push(begin.elapsed().as_nanos());
        }
    }
    let mut result = serde_json::Map::new();
    for (name, mut values) in names.into_iter().zip(samples) {
        let p50 = percentile(&mut values, 50);
        let p95 = percentile(&mut values, 95);
        result.insert(name.into(), serde_json::json!({"samples":30,"p50Ms":p50,"p95Ms":p95,"maxMs":values.last().unwrap().to_owned() as f64/1_000_000.0}));
    }
    serde_json::json!({"standaloneOverlappingBoundaries":true,"notAdditive":true,"hostLoadIsolated":false,"encodedDocumentBytes":bytes.len(),"measurements":result})
}
fn main() {
    let nested = std::env::args().any(|a| a == "--nested");
    let d = fixture(nested);
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
    // Same graph, now through Show + nested Timeline + 256 held overrides.
    // All controller publication/allocation stays outside this sampling loop.
    let grant = producer_production_core::coordinator::Coordinator::new(
        producer_production_core::storage::Snapshot::new(Document::empty("profile", "Profile"))
            .unwrap(),
        producer_production_core::storage::MemoryStore::default(),
    )
    .session(true)
    .unwrap()
    .1;
    let mut show = producer_production_core::show::ShowRun::compile(
        &d,
        "pilot",
        grant,
        producer_production_core::transport::OutputInstant(Counter(0)),
    )
    .unwrap();
    show.apply(producer_production_core::show::ShowEvent::Start {
        at: Counter(0),
        segment: None,
    })
    .unwrap();
    for track in &sequence.tracks {
        show.apply(producer_production_core::show::ShowEvent::Override {
            at: Counter(0),
            scope: producer_production_core::show::ExecutionScope::Run,
            owner: "profile".into(),
            target: p.targets[track.target].clone(),
            value: Value::Number(0.5),
        })
        .unwrap();
    }
    let mut show_out = vec![None; show.scratch_len()];
    let mut show_samples = Vec::with_capacity(20_000);
    for i in 0..1000 {
        show.evaluate_into(
            producer_production_core::transport::OutputInstant(Counter((i % 960) * 8_333_333)),
            &mut show_out,
        )
        .unwrap();
    }
    ALLOCS.store(0, Ordering::Relaxed);
    COUNT.store(true, Ordering::Relaxed);
    for i in 0..20_000 {
        let at = producer_production_core::transport::OutputInstant(Counter((i % 960) * 8_333_333));
        let begin = Instant::now();
        show.evaluate_into(at, std::hint::black_box(&mut show_out))
            .unwrap();
        show_samples.push(begin.elapsed().as_nanos());
    }
    COUNT.store(false, Ordering::Relaxed);
    let show_allocations = ALLOCS.load(Ordering::Relaxed);
    assert_eq!(show_allocations, 0, "Show numeric sampling allocated");
    let show_p99 = percentile(&mut show_samples, 99);
    let mut compiles = Vec::new();
    for _ in 0..30 {
        let begin = Instant::now();
        std::hint::black_box(compile(&d).unwrap());
        compiles.push(begin.elapsed().as_nanos());
    }
    let p95 = percentile(&mut compiles, 95);
    let mut compiler = Compiler::default();
    compiler.compile(&d).unwrap();
    let mut changed = d.clone();
    let mut incremental = Vec::with_capacity(30);
    let mut controls = Vec::with_capacity(30);
    for i in 0..30 {
        changed
            .sets
            .get_mut("classic")
            .unwrap()
            .layouts
            .get_mut("wide")
            .unwrap()
            .root
            .children[2]
            .bindings = vec![Binding {
            property: Property::Opacity,
            expression: Expr::Literal {
                value: Value::Number(if i % 2 == 0 { 0.9 } else { 0.8 }),
            },
        }];
        let begin = Instant::now();
        let (plan, stats) = compiler.compile(&changed).unwrap();
        assert_eq!(stats.layouts_built, 1);
        assert_eq!(stats.layouts_reused, 1);
        assert_eq!(stats.sequences_built, 0);
        std::hint::black_box(plan);
        incremental.push(begin.elapsed().as_nanos());
        changed.title = format!("Authoring edit {i}");
        let begin = Instant::now();
        let (plan, stats) = compiler.compile(&changed).unwrap();
        assert_eq!(stats.layouts_built, 0);
        assert_eq!(stats.sequences_built, 0);
        std::hint::black_box(plan);
        controls.push(begin.elapsed().as_nanos());
    }
    let incremental_p95 = percentile(&mut incremental, 95);
    let controls_p95 = percentile(&mut controls, 95);
    let mut result = serde_json::json!({"nested":nested,"temporalDepth":if nested {2} else {0},"fixtureDigest":digest(&d).unwrap(),"nodes":p.nodes.len(),"tracks":sequence.tracks.len(),"evaluationSamples":samples.len(),"evaluationP99Ms":p99,"evaluationAllocations":allocations,"showEvaluationSamples":show_samples.len(),"showEvaluationP99Ms":show_p99,"showEvaluationAllocations":show_allocations,"showOverrides":sequence.tracks.len(),"showEvaluationGate1Ms":show_p99<=1.0,"firstCompileMs":cold,"repeatedFullCompileP95Ms":p95,"evaluationGate1Ms":p99<=1.0,"coldCompileGate250Ms":cold<=250.0,"fullCompileReference50Ms":p95<=50.0,"dirtyLayoutCompileP95Ms":incremental_p95,"authoringOnlyCompileP95Ms":controls_p95,"dirtyCompileGate50Ms":incremental_p95<=50.0,"admission":"full validation and canonical digest on every build","nativeGpu":"not measured"});
    if std::env::args().any(|a| a == "--boundaries") {
        result["compileBoundaries"] = boundary_profile(&d);
    }
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    assert!(
        p99 <= 1.0 && show_p99 <= 1.0 && cold <= 250.0,
        "core evaluation/cold compile gate failed"
    );
}
