//! Core-only effect input/noise profile. No graphics pipeline or rendered FPS.
use producer_production_core::{analytic::EffectInputs, compile::compile, contract::*};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    hint::black_box,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Instant,
};
struct Counted;
static COUNT: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNT.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) }
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, n: usize) -> *mut u8 {
        if COUNT.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.realloc(p, layout, n) }
    }
}
#[global_allocator]
static ALLOCATOR: Counted = Counted;
fn main() {
    let nested = std::env::args().any(|a| a == "--nested");
    let mut d = fixture::analytic_reconstruction();
    let (sequence, placements) = if nested {
        ("timeline", "pulse")
    } else {
        ("opener", "opener")
    };
    let count = if nested { 128 } else { 256 };
    let duration = d.sequences[placements].duration;
    d.sequences.get_mut(placements).unwrap().placements = (0..count)
        .map(|i| Placement {
            id: format!("fx-{i}"),
            source: "stage".into(),
            range: Range {
                start: Time::ZERO,
                duration,
            },
            source_in: Time::ZERO,
            speed: Speed::default(),
            looping: false,
        })
        .collect();
    let p = compile(&d).unwrap();
    let q = &p.sequences[sequence];
    assert_eq!(q.effects.len(), 256);
    let mut slots: Vec<Option<EffectInputs>> = vec![None; q.effects.len()];
    let mut elapsed = vec![0u64; 20_000];
    let frame = |i: usize, out: &mut [Option<EffectInputs>]| {
        q.evaluate_effects_into(Time::new((i % 1800) as i64, 240).unwrap(), out)
            .unwrap();
        let mut sum = 0u32;
        for input in out.iter().flatten() {
            for instance in 0..16 {
                sum = sum.wrapping_add(input.random_word(1, instance, 3));
            }
        }
        black_box(sum)
    };
    for i in 0..1000 {
        frame(i, &mut slots);
    }
    ALLOCS.store(0, Ordering::SeqCst);
    COUNT.store(true, Ordering::SeqCst);
    let mut checksum = 0u32;
    for (i, ns) in elapsed.iter_mut().enumerate() {
        let at = Instant::now();
        checksum = checksum.wrapping_add(frame(black_box(i), &mut slots));
        *ns = at.elapsed().as_nanos() as u64;
    }
    COUNT.store(false, Ordering::SeqCst);
    let allocations = ALLOCS.load(Ordering::SeqCst);
    elapsed.sort_unstable();
    println!(
        "{}",
        serde_json::json!({"scope":"effect input/seed/noise arithmetic only; no renderer", "nested":nested,"effects":q.effects.len(),"noiseSamplesPerFrame":4096,"samples":elapsed.len(),"allocations":allocations,"p50Ms":elapsed[elapsed.len()/2] as f64/1e6,"p99Ms":elapsed[elapsed.len()*99/100] as f64/1e6,"maxMs":elapsed[elapsed.len()-1] as f64/1e6,"checksum":checksum})
    );
    assert_eq!(allocations, 0);
    assert!(
        elapsed[elapsed.len() * 99 / 100] < 1_000_000,
        "core-only p99 exceeds 1 ms laboratory gate"
    );
}
