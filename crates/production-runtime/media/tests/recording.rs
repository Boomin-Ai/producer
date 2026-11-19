use producer_native_media::{recording::*, Error};
use producer_production_contract::Time;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "producer-take-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn header() -> RecordingHeader {
    RecordingHeader {
        asset_refs: Default::default(),
        version: 1,
        room: "test".into(),
        host_origin_ns: 42,
        tracks: (0..2)
            .map(|id| RecordingTrack {
                id,
                source: format!("output-{id}"),
                incarnation: 1,
                width: 1920,
                height: 1080,
                audio: false,
            })
            .collect(),
    }
}
fn span(at: i64) -> Vec<SampleSpan> {
    vec![SampleSpan {
        media: "video".into(),
        start: Time::seconds(at),
        duration: Time::seconds(2),
    }]
}
fn create(t: &Temp) -> RecordingStore {
    let mut w = RecordingStore::create(&t.0, header()).unwrap();
    for i in 0..2 {
        w.initialize(i, b"init").unwrap();
    }
    w
}
#[test]
fn durable_ranges_are_independent_and_snapshot_bounded() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"program-a", span(0)).unwrap();
    assert_eq!(w.head().common_end().unwrap(), Time::ZERO);
    w.append(1, b"program-b", span(0)).unwrap();
    let frozen = w.head().clone();
    assert_eq!(frozen.common_end().unwrap(), Time::seconds(2));
    w.append(0, b"later-a", span(2)).unwrap();
    w.append(1, b"later-b", span(2)).unwrap();
    assert_eq!(
        RecordingStore::read_chunk(&t.0, &frozen, 0, 1).unwrap_err(),
        Error::Unavailable
    );
    assert!(RecordingStore::read_chunk(&t.0, &frozen, 0, 0).is_ok());
    assert_eq!(RecordingStore::recover(&t.0).unwrap_err(), Error::Busy);
    w.finish().unwrap();
    drop(w);
    let (_, h) = RecordingStore::inspect(&t.0).unwrap();
    assert_eq!(h.state, TakeState::Saved);
    assert_eq!(
        RecordingStore::recover(&t.0).unwrap().state,
        TakeState::Saved
    );
}
#[test]
fn crash_recovers_only_published_chunks_and_retains_orphans() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"safe", span(0)).unwrap();
    let frozen = w.head().clone();
    drop(w);
    fs::write(t.0.join("head.pending"), b"{truncated").unwrap();
    fs::write(t.0.join("track-00-00000001.mp4"), b"uncommitted").unwrap();
    let h = RecordingStore::recover(&t.0).unwrap();
    assert_eq!(h.state, TakeState::Interrupted);
    assert_eq!(h.tracks, frozen.tracks);
    assert!(t.0.join("track-00-00000001.mp4").exists());
    assert_eq!(
        RecordingStore::read_chunk(&t.0, &h, 0, 1).unwrap_err(),
        Error::Unavailable
    );
    assert_eq!(RecordingStore::recover(&t.0).unwrap(), h);
}
#[test]
fn failed_checkpoint_stops_writer_and_preserves_durable_head() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"safe", span(0)).unwrap();
    let safe = w.head().clone();
    fs::write(t.0.join("head.pending"), b"occupied").unwrap();
    assert!(w.append(0, b"never advertised", span(2)).is_err());
    assert_eq!(w.head(), &safe);
    assert_eq!(w.append(1, b"no more", span(0)).unwrap_err(), Error::Closed);
    assert_eq!(RecordingStore::inspect(&t.0).unwrap().1, safe);
}
#[test]
fn missing_drive_never_falls_back_or_advances_ready_ranges() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"safe", span(0)).unwrap();
    let h = w.head().clone();
    let moved = t.0.with_extension("disconnected");
    fs::rename(&t.0, &moved).unwrap();
    assert!(w.append(1, b"blocked", span(0)).is_err());
    assert_eq!(w.head(), &h);
    assert!(!t.0.exists());
    fs::rename(moved, &t.0).unwrap();
}
#[test]
fn corruption_and_truncation_do_not_become_ready_footage() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"safe", span(0)).unwrap();
    let h = w.head().clone();
    drop(w);
    fs::write(t.0.join("track-00-00000000.mp4"), b"evilxxxx").unwrap();
    assert!(RecordingStore::read_chunk(&t.0, &h, 0, 0).is_err());
    assert!(RecordingStore::recover(&t.0).is_err());
}
#[test]
fn av_track_offsets_are_not_falsely_reported_as_capture_gaps() {
    let t = Temp::new();
    let mut h = header();
    for tr in &mut h.tracks {
        tr.audio = true;
    }
    let mut w = RecordingStore::create(&t.0, h).unwrap();
    w.initialize(0, b"init").unwrap();
    let report = |at| {
        vec![
            SampleSpan {
                media: "video".into(),
                start: Time::new(at * 1000 + 50, 1000).unwrap(),
                duration: Time::seconds(2),
            },
            SampleSpan {
                media: "audio".into(),
                start: Time::seconds(at),
                duration: Time::seconds(2),
            },
        ]
    };
    w.append(0, b"first", report(0)).unwrap();
    let c = w.append(0, b"next", report(2)).unwrap();
    assert!(c.gap_before.is_none());
    assert!(c.gaps_before.is_empty());
}
#[cfg(unix)]
#[test]
fn recovery_does_not_follow_take_or_chunk_symlinks() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"safe", span(0)).unwrap();
    let h = w.head().clone();
    drop(w);
    let link = Temp::new();
    std::os::unix::fs::symlink(&t.0, &link.0).unwrap();
    assert!(RecordingStore::recover(&link.0).is_err());
    fs::remove_file(&link.0).unwrap();
    let chunk = t.0.join("track-00-00000000.mp4");
    fs::remove_file(&chunk).unwrap();
    std::os::unix::fs::symlink(t.0.join("take.json"), &chunk).unwrap();
    assert!(RecordingStore::read_chunk(&t.0, &h, 0, 0).is_err());
}
#[test]
fn timestamps_and_original_identity_are_validated() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"one", span(0)).unwrap();
    let c = w.append(0, b"after reconnect", span(4)).unwrap();
    assert_eq!(c.gap_before, Some((Time::seconds(2), Time::seconds(4))));
    assert!(w.append(0, b"stale", span(3)).is_err());
    assert!(RecordingStore::create(&t.0, header()).is_err());
}
#[test]
fn bounded_metadata_and_completion_do_not_invent_missing_tracks() {
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"one", span(0)).unwrap();
    assert_eq!(w.finish().unwrap_err(), Error::Unavailable);
    assert!(w.initialize(1, b"again").is_err());
    assert!(w.append(1, b"bad", vec![]).is_err());
}

#[test]
fn committed_view_freezes_identity_ranges_and_rejects_future_or_gap_samples() {
    use producer_native_media::committed::CommittedTrack;
    let t = Temp::new();
    let mut w = create(&t);
    w.append(0, b"first", span(0)).unwrap();
    let frozen = CommittedTrack::open(&t.0, 0).unwrap();
    w.append(0, b"after gap", span(4)).unwrap();
    assert_eq!(frozen.chunk_count(), 1);
    assert!(frozen.locate("video", Time::seconds(2)).is_none());
    assert!(frozen.verified_path(1).is_err());
    let restored = CommittedTrack::at_head(&t.0, 0, frozen.head.clone()).unwrap();
    assert_eq!(frozen.hash, restored.hash);
    let grown = CommittedTrack::open(&t.0, 0).unwrap();
    assert_ne!(frozen.hash, grown.hash);
    assert_eq!(grown.available.end().unwrap(), Time::seconds(6));
    for n in [2, 3, 6] {
        assert!(grown.locate("video", Time::seconds(n)).is_none());
    }
    assert_eq!(grown.locate("video", Time::seconds(4)).unwrap().index, 1);
    assert!(grown.locate("audio", Time::ZERO).is_none());
    assert!(grown.locate("nonsense", Time::ZERO).is_none());
    assert!(grown.verified_path(0).is_ok());
    fs::write(t.0.join("track-00-00000000.mp4"), b"tamper").unwrap();
    assert!(grown.verified_path(0).is_err());
}
#[test]
fn committed_av_view_keeps_media_specific_endpoints() {
    use producer_native_media::committed::CommittedTrack;
    let t = Temp::new();
    let mut h = header();
    h.tracks[0].audio = true;
    let mut w = RecordingStore::create(&t.0, h).unwrap();
    w.initialize(0, b"init").unwrap();
    w.append(
        0,
        b"av",
        vec![
            SampleSpan {
                media: "video".into(),
                start: Time::new(1, 10).unwrap(),
                duration: Time::seconds(2),
            },
            SampleSpan {
                media: "audio".into(),
                start: Time::ZERO,
                duration: Time::seconds(2),
            },
        ],
    )
    .unwrap();
    let v = CommittedTrack::open(&t.0, 0).unwrap();
    assert!(v.locate("video", Time::ZERO).is_none());
    assert!(v.locate("audio", Time::ZERO).is_some());
    assert!(v.locate("video", Time::seconds(2)).is_some());
    assert!(v.locate("audio", Time::seconds(2)).is_none());
}

#[test]
fn partial_fragments_keep_sparse_media_lookup_and_cross_fragment_cursors() {
    use producer_native_media::committed::CommittedTrack;
    let t = Temp::new();
    let mut h = header();
    h.tracks[0].audio = true;
    let mut w = RecordingStore::create(&t.0, h).unwrap();
    for i in 0..2 {
        w.initialize(i, b"init").unwrap();
    }
    let av = |at| {
        let mut spans = span(at);
        spans.push(SampleSpan {
            media: "audio".into(),
            start: Time::seconds(at),
            duration: Time::seconds(2),
        });
        spans
    };
    w.append(0, b"both", av(0)).unwrap();
    w.append(0, b"video-only", span(2)).unwrap();
    let resumed = w.append(0, b"both-again", av(4)).unwrap();
    assert_eq!(
        resumed.gaps_before,
        vec![SampleGap {
            media: "audio".into(),
            start: Time::seconds(2),
            end: Time::seconds(4)
        }]
    );
    let view = CommittedTrack::open(&t.0, 0).unwrap();
    assert_eq!(view.locate("video", Time::seconds(3)).unwrap().index, 1);
    assert!(view.locate("audio", Time::seconds(3)).is_none());
    assert_eq!(view.locate("audio", Time::seconds(5)).unwrap().index, 2);
    assert!(view.locate("audio", Time::seconds(6)).is_none());
    w.append(1, b"other-program", span(0)).unwrap();
    w.finish().unwrap();

    let t = Temp::new();
    let mut h = header();
    h.tracks[0].audio = true;
    let mut w = RecordingStore::create(&t.0, h).unwrap();
    for i in 0..2 {
        w.initialize(i, b"init").unwrap();
    }
    w.append(0, b"video-without-audio", span(0)).unwrap();
    w.append(1, b"other-program", span(0)).unwrap();
    assert_eq!(w.finish().unwrap_err(), Error::Unavailable);
    w.append(0, b"video-only", span(2)).unwrap();
    // An absent medium does not reset its monotonic cursor.
    w.append(
        0,
        b"audio-arrives",
        vec![SampleSpan {
            media: "audio".into(),
            start: Time::seconds(4),
            duration: Time::seconds(2),
        }],
    )
    .unwrap();
    w.append(0, b"video-only", span(4)).unwrap();
    assert!(w
        .append(
            0,
            b"stale-audio",
            vec![SampleSpan {
                media: "audio".into(),
                start: Time::seconds(5),
                duration: Time::seconds(2)
            }]
        )
        .is_err());
}
