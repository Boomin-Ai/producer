use producer_native_media::boundary::*;
use producer_native_media::Error;
fn fence() -> MediaFence { MediaFence { execution: 1, epoch: 1, source_incarnation: 1, request: 1 } }

#[test]
fn generations_reject_reentry_seek_and_other_executions() {
    let original = fence(); let mut current = original;
    current.seek().unwrap(); assert!(!current.accepts(original));
    current.reopen().unwrap(); assert!(!current.accepts(original));
    current.execution += 1; assert!(!current.accepts(original));
    let mut full = MediaFence { source_incarnation: u64::MAX, ..original };
    let before = full; assert!(full.reopen().is_err()); assert_eq!(full,before);
}
#[test]
fn audio_is_sample_scheduled_bounded_and_never_repeats_stale_samples() {
    let f = fence(); let q = AudioQueue::new(f,2).unwrap();
    let mut b = AudioBlock::silence(f,240); b.samples.fill(0.5);
    q.push(&b).unwrap(); b.start = 720; q.push(&b).unwrap();
    b.start = 1200; assert_eq!(q.push(&b),Err(Error::Busy));
    let mut output = [0.;BLOCK_SAMPLES];
    assert_eq!(q.mix(f,0,&mut output,0.5).unwrap(),240);
    assert!(output[..480].iter().all(|&x|x==0.));
    assert!(output[480..].iter().all(|&x|x==0.25));
    output.fill(0.); assert_eq!(q.mix(f,480,&mut output,1.).unwrap(),480);
    let mut next = f; next.seek().unwrap(); q.reset(next).unwrap();
    output.fill(0.); assert_eq!(q.mix(next,0,&mut output,1.).unwrap(),0);
    assert_eq!(q.push(&b),Err(Error::Superseded));
    assert!(output.iter().all(|&x|x==0.));
}
#[test]
fn audio_push_diagnostics_keep_capacity_overlap_and_identity_distinct() {
    let f = fence(); let q = AudioQueue::new(f, 2).unwrap();
    let mut b = AudioBlock::silence(f, 0);
    q.push_detailed(&b).unwrap();
    assert_eq!(q.push_detailed(&b), Err(AudioPushError::Overlap));
    b.start = 480; q.push_detailed(&b).unwrap();
    b.start = 960; assert_eq!(q.push_detailed(&b), Err(AudioPushError::Full));
    b.fence.request += 1;
    assert_eq!(q.push_detailed(&b), Err(AudioPushError::Superseded));
    b.frames = 0; assert_eq!(q.push_detailed(&b), Err(AudioPushError::Invalid));
}
#[test]
fn output_sizes_are_explicit_and_square_is_not_a_global_orientation_change() {
    assert_eq!(OutputSize::LANDSCAPE.validate().unwrap().aspect(),16./9.);
    assert_eq!(OutputSize::VERTICAL.validate().unwrap().aspect(),9./16.);
    assert_eq!(OutputSize::SQUARE.validate().unwrap().aspect(),1.);
    assert!(OutputSize{width:1921,height:1080}.validate().is_err());
    assert!(OutputSize{width:65536,height:65536}.validate().is_err());
}
