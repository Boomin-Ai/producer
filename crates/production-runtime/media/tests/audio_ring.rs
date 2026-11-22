use producer_native_media::boundary::*;
use producer_native_media::Error;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct CountAlloc;
thread_local! { static ALLOCS: Cell<Option<usize>> = const { Cell::new(None) }; }
unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.with(|v| {
            if let Some(n) = v.get() {
                v.set(Some(n + 1));
            }
        });
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCS.with(|v| {
            if let Some(n) = v.get() {
                v.set(Some(n + 1));
            }
        });
        System.realloc(ptr, layout, size)
    }
}
#[global_allocator]
static ALLOCATOR: CountAlloc = CountAlloc;
fn fence() -> MediaFence {
    MediaFence {
        execution: 1,
        epoch: 1,
        source_incarnation: 1,
        request: 1,
    }
}

#[test]
fn partial_future_stale_and_capacity_remain_sample_accurate() {
    let f = fence();
    let (mut tx, mut rx) = audio_ring(f, 2).unwrap();
    let mut b = AudioBlock::silence(f, 240);
    b.samples.fill(0.5);
    tx.push(&b).unwrap();
    assert_eq!(tx.push(&b), Err(AudioPushError::Overlap));
    b.start = 720;
    tx.push(&b).unwrap();
    b.start = 1200;
    assert_eq!(tx.push(&b), Err(AudioPushError::Full));
    let mut out = [0.; BLOCK_SAMPLES];
    let mut stale = f;
    stale.request += 1;
    assert_eq!(rx.mix(stale, 0, &mut out, 1.), Err(Error::Superseded));
    assert_eq!(rx.mix(f, 0, &mut out, 0.5).unwrap(), 240);
    assert!(out[..480].iter().all(|&v| v == 0.));
    assert!(out[480..].iter().all(|&v| v == 0.25));
    out.fill(0.);
    assert_eq!(rx.mix(f, 480, &mut out, 1.).unwrap(), 480);
    assert!(out.iter().all(|&v| v == 0.5));
    assert_eq!(
        rx.mix(f, 480, &mut out, 1.),
        Err(Error::Invalid("nonmonotonic device block"))
    );
    b.fence = stale;
    assert_eq!(tx.push(&b), Err(AudioPushError::Superseded));
    b.fence = f;
    b.samples[0] = f32::NAN;
    assert_eq!(tx.push(&b), Err(AudioPushError::Invalid));
}

#[test]
fn odd_capture_packet_sizes_have_no_sample_loss_or_callback_allocations() {
    let f = fence();
    let (mut tx, mut rx) = audio_ring(f, 32).unwrap();
    let mut b = AudioBlock::silence(f, 0);
    let mut out = [0.; BLOCK_SAMPLES];
    let mut next = 0;
    let mut mixed = 0;
    ALLOCS.with(|v| v.set(Some(0)));
    for packet in 0..3000 {
        // AVCapture's 1024-frame packets split into 480 + 480 + 64;
        // the mixer works on independent 480-frame output boundaries.
        let mut offset = 0;
        while offset < 1024 {
            b.start = packet * 1024 + offset;
            b.frames = (1024 - offset).min(480) as usize;
            b.samples.fill(0.25);
            tx.push(&b).unwrap();
            offset += b.frames as i64;
        }
        while next + 480 <= (packet + 1) * 1024 {
            out.fill(0.);
            mixed += rx.mix(f, next, &mut out, 1.).unwrap();
            next += 480;
            assert!(out.iter().all(|&v| v == 0.25));
        }
    }
    let allocations = ALLOCS.with(|v| v.replace(None)).unwrap();
    assert_eq!(allocations, 0);
    assert_eq!(mixed, 3_072_000);
}

#[test]
fn concurrent_capture_and_mix_preserve_order_without_shared_lock() {
    let f = fence();
    let (mut tx, mut rx) = audio_ring(f, 32).unwrap();
    let writer = std::thread::spawn(move || {
        let mut block = AudioBlock::silence(f, 0);
        for i in 0..20_000 {
            block.start = i * 480;
            block.samples.fill((i % 16) as f32 / 16.);
            loop {
                match tx.push(&block) {
                    Ok(()) => break,
                    Err(AudioPushError::Full) => std::thread::yield_now(), // test pacing only
                    error => panic!("unexpected capture failure: {error:?}"),
                }
            }
        }
    });
    // The test waits for availability without advancing the mixer clock. Actual
    // callbacks never spin/retry and a missing block remains explicit silence.
    for i in 0..20_000 {
        while rx.available_blocks() == 0 {
            std::thread::yield_now();
        }
        let mut out = [0.; BLOCK_SAMPLES];
        assert_eq!(rx.mix(f, i * 480, &mut out, 1.).unwrap(), 480);
        assert!(out.iter().all(|&v| v == (i % 16) as f32 / 16.));
    }
    writer.join().unwrap();
}
