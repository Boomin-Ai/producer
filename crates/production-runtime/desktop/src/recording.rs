//! Encoded-segment handoff. Disk IO and durable publication never run on media callbacks.
use anyhow::{anyhow, bail, Result};
use producer_native_media::recording::{
    RecordingHead, RecordingHeader, RecordingStore, SampleSpan, MAX_SEGMENT_BYTES, MAX_TRACKS,
};
use producer_production_contract::Time;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::Duration,
};

const QUEUED_BYTES: usize = 16 * 1024 * 1024;
const QUEUED_MEDIA: usize = 8;
// Finishing five encoders can deliver five final fragments and five completion
// notices together. Keep the media limit unchanged; reserve one payload-free
// completion slot per track in the same FIFO, behind that track's last fragment.
const QUEUED_EVENTS: usize = QUEUED_MEDIA + MAX_TRACKS;
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct NativeSpan {
    pub start: i64,
    pub duration: i64,
    pub rate: i32,
    pub duration_rate: i32,
    pub media: u32,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub session: u64,
    pub phase: String,
    pub path: Option<PathBuf>,
    pub head: Option<RecordingHead>,
    pub error: Option<String>,
    pub queued_bytes: usize,
    pub peak_queued_bytes: usize,
}
impl Progress {
    pub fn busy(&self) -> bool {
        matches!(self.phase.as_str(), "starting" | "recording" | "finalizing")
    }
}
enum Message {
    Start(u64, PathBuf, RecordingHeader, SyncSender<Result<()>>),
    Segment {
        session: u64,
        track: u32,
        kind: u32,
        bytes: Vec<u8>,
        spans: [NativeSpan; 2],
        count: usize,
    },
}
pub struct Recorder {
    tx: SyncSender<Message>,
    start_gate: Mutex<()>,
    session: AtomicU64,
    failed: Arc<AtomicBool>,
    bytes: Arc<AtomicUsize>,
    media_slots: Arc<AtomicUsize>,
    completed: AtomicU32,
    track_mask: AtomicU32,
    peak: AtomicUsize,
    progress: Arc<Mutex<Progress>>,
}
impl Recorder {
    pub fn new() -> Result<Self> {
        let (tx, rx) = mpsc::sync_channel(QUEUED_EVENTS);
        let progress = Arc::new(Mutex::new(Progress::default()));
        let failed = Arc::new(AtomicBool::new(false));
        let bytes = Arc::new(AtomicUsize::new(0));
        let media_slots = Arc::new(AtomicUsize::new(0));
        let slots = media_slots.clone();
        let (p, f, b) = (progress.clone(), failed.clone(), bytes.clone());
        std::thread::Builder::new().name("producer-take-store".into()).spawn(move || {
            let mut store:Option<RecordingStore>=None;
            let mut current=0;
            let mut finished=Vec::new();
            loop {
                let msg=match rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(m)=>m,
                    Err(mpsc::RecvTimeoutError::Timeout)=> {
                        if f.load(Ordering::Acquire) && store.is_some() {
                            fail(&mut store,&p,"Recording handoff exceeded its bounded queue; committed footage retained");
                        }
                        continue;
                    }
                    Err(_)=>break,
                };
                match msg {
                    Message::Start(session,path,header,reply)=> {
                        if store.is_some() { let _=reply.send(Err(anyhow!("Previous take is still finalizing"))); continue; }
                        let count=header.tracks.len();
                        let result:Result<()>=RecordingStore::create(&path,header).map_err(Into::into).map(|s| {
                            current=session; finished=vec![false;count];
                            *p.lock().unwrap()=Progress { session,phase:"starting".into(),path:Some(path),head:Some(s.head().clone()),..Default::default() };
                            store=Some(s);
                        });
                        match result {
                            Ok(())=> {
                                // A rendezvous ACK cannot be left buffered after its caller
                                // times out. Never leave an unowned take waiting for frames.
                                if reply.send(Ok(())).is_err() {
                                    f.store(true,Ordering::Release);
                                    fail(&mut store,&p,"Recording start was cancelled before encoder admission");
                                }
                            }
                            Err(e)=> {
                                let mut p=p.lock().unwrap();p.phase="failed".into();p.error=Some(e.to_string());
                                let _=reply.send(Err(e));
                            }
                        }
                    }
                    Message::Segment { session,track,kind,bytes,spans,count }=> {
                        let charge=bytes.len();
                        if session==current && store.is_some() {
                            let result=(|| -> Result<()> {
                                if f.load(Ordering::Acquire) { bail!("Recording handoff failed; committed footage retained"); }
                                let s=store.as_mut().unwrap();
                                match kind {
                                    0=>s.initialize(track,&bytes)?,
                                    1=> {
                                        let spans=spans[..count].iter().map(|s| Ok(SampleSpan {
                                            media:match s.media {0=>"video",1=>"audio",_=>bail!("Unknown encoder stream")}.into(),
                                            start:Time::new(s.start,s.rate.try_into()?)?,
                                            duration:Time::new(s.duration,s.duration_rate.try_into()?)?,
                                        })).collect::<Result<Vec<_>>>()?;
                                        s.append(track,&bytes,spans.clone()).map_err(|e|anyhow!("{e}; track {track}, reported spans {spans:?}"))?;
                                        let mut p=p.lock().unwrap(); p.head=Some(s.head().clone());
                                        if p.phase=="starting" {p.phase="recording".into();}
                                    }
                                    2=> {
                                        *finished.get_mut(track as usize).ok_or_else(||anyhow!("Unknown finished track"))?=true;
                                        if finished.iter().all(|v|*v) {s.finish()?;}
                                    }
                                    3=>bail!("{}",String::from_utf8_lossy(&bytes)),
                                    _=>bail!("Unknown recorder event"),
                                }
                                Ok(())
                            })();
                            if let Err(e)=result { f.store(true,Ordering::Release); fail(&mut store,&p,&e.to_string()); }
                            else if kind==2 && finished.iter().all(|v|*v) {
                                let s=store.take().unwrap();let head=s.head().clone();drop(s);
                                let mut p=p.lock().unwrap();p.phase="saved".into();p.head=Some(head);
                            }
                        }
                        b.fetch_sub(charge,Ordering::AcqRel);
                        if kind!=2 {slots.fetch_sub(1,Ordering::AcqRel);}
                    }
                }
            }
            if store.is_some() {fail(&mut store,&p,"Recorder closed before finalization; committed chunks retained");}
        })?;
        Ok(Self {
            tx,
            start_gate: Mutex::new(()),
            session: AtomicU64::new(0),
            failed,
            bytes,
            media_slots,
            completed: AtomicU32::new(0),
            track_mask: AtomicU32::new(0),
            peak: AtomicUsize::new(0),
            progress,
        })
    }
    pub fn start(&self, path: PathBuf, header: RecordingHeader) -> Result<u64> {
        let _admission = self
            .start_gate
            .try_lock()
            .map_err(|_| anyhow!("Recording start is already pending"))?;
        if self.snapshot().busy() {
            bail!("Previous take is still recording or finalizing");
        }
        let session = self.session.fetch_add(1, Ordering::AcqRel) + 1;
        self.failed.store(false, Ordering::Release);
        self.peak.store(0, Ordering::Release);
        self.completed.store(0, Ordering::Release);
        self.track_mask.store(
            if header.tracks.len() <= MAX_TRACKS {
                (1u32 << header.tracks.len()) - 1
            } else {
                0
            },
            Ordering::Release,
        );
        let (tx, rx) = mpsc::sync_channel(0);
        let previous = {
            let mut p = self.progress.lock().unwrap();
            std::mem::replace(
                &mut *p,
                Progress {
                    session,
                    phase: "starting".into(),
                    path: Some(path.clone()),
                    ..Default::default()
                },
            )
        };
        // Keep admission reserved even if filesystem IO outlives the caller's
        // timeout. The worker releases it only after cancelling that take.
        if self
            .tx
            .try_send(Message::Start(session, path, header, tx))
            .is_err()
        {
            *self.progress.lock().unwrap() = previous;
            bail!("Recording worker busy");
        }
        rx.recv_timeout(Duration::from_secs(5))??;
        Ok(session)
    }
    /// Called only by encoded-segment delegates, never the camera/audio device callback.
    pub fn event(
        &self,
        session: u64,
        track: u32,
        kind: u32,
        data: &[u8],
        spans: [NativeSpan; 2],
        count: usize,
    ) -> bool {
        if session != self.session.load(Ordering::Acquire) || self.failed.load(Ordering::Acquire) {
            return false;
        }
        if kind == 2 {
            if track as usize >= MAX_TRACKS
                || count != 0
                || !data.is_empty()
                || self.track_mask.load(Ordering::Acquire) & (1 << track) == 0
                || self.completed.fetch_or(1 << track, Ordering::AcqRel) & (1 << track) != 0
            {
                self.failed.store(true, Ordering::Release);
                return false;
            }
        } else if self
            .media_slots
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < QUEUED_MEDIA).then_some(n + 1)
            })
            .is_err()
        {
            self.failed.store(true, Ordering::Release);
            return false;
        }
        if count > 2
            || data.len() > MAX_SEGMENT_BYTES
            || self
                .bytes
                .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    n.checked_add(data.len()).filter(|n| *n <= QUEUED_BYTES)
                })
                .is_err()
        {
            if kind != 2 {
                self.media_slots.fetch_sub(1, Ordering::AcqRel);
            }
            self.failed.store(true, Ordering::Release);
            return false;
        }
        self.peak
            .fetch_max(self.bytes.load(Ordering::Relaxed), Ordering::Relaxed);
        if self
            .tx
            .try_send(Message::Segment {
                session,
                track,
                kind,
                bytes: data.to_vec(),
                spans,
                count,
            })
            .is_err()
        {
            self.bytes.fetch_sub(data.len(), Ordering::AcqRel);
            if kind != 2 {
                self.media_slots.fetch_sub(1, Ordering::AcqRel);
            }
            self.failed.store(true, Ordering::Release);
            return false;
        }
        true
    }
    pub fn finalizing(&self) {
        let mut p = self.progress.lock().unwrap();
        if p.busy() {
            p.phase = "finalizing".into();
        }
    }
    pub fn snapshot(&self) -> Progress {
        let mut p = self.progress.lock().unwrap().clone();
        p.queued_bytes = self.bytes.load(Ordering::Relaxed);
        p.peak_queued_bytes = self.peak.load(Ordering::Relaxed);
        p
    }
}
fn fail(store: &mut Option<RecordingStore>, progress: &Mutex<Progress>, message: &str) {
    if let Some(mut s) = store.take() {
        s.fail(message);
        let head = s.head().clone();
        drop(s);
        let mut p = progress.lock().unwrap();
        p.phase = "failed".into();
        p.error = Some(message.chars().take(400).collect());
        p.head = Some(head);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use producer_native_media::recording::{RecordingTrack, TakeState};
    fn held_ingress() -> (Recorder, mpsc::Receiver<Message>) {
        // No worker: deterministically model a slow disk while encoders finish.
        let (tx, rx) = mpsc::sync_channel(QUEUED_EVENTS);
        (
            Recorder {
                tx,
                start_gate: Mutex::new(()),
                session: AtomicU64::new(1),
                failed: Arc::new(AtomicBool::new(false)),
                bytes: Arc::new(AtomicUsize::new(0)),
                media_slots: Arc::new(AtomicUsize::new(0)),
                completed: AtomicU32::new(0),
                track_mask: AtomicU32::new((1 << MAX_TRACKS) - 1),
                peak: AtomicUsize::new(0),
                progress: Arc::new(Mutex::new(Progress::default())),
            },
            rx,
        )
    }
    #[test]
    fn five_completions_have_reserved_capacity_behind_full_media_queue() {
        let (r, rx) = held_ingress();
        for i in 0..QUEUED_MEDIA {
            assert!(r.event(
                1,
                (i % MAX_TRACKS) as u32,
                1,
                b"fragment",
                Default::default(),
                0
            ));
        }
        for track in 0..MAX_TRACKS {
            assert!(r.event(1, track as u32, 2, &[], Default::default(), 0));
        }
        assert_eq!(r.media_slots.load(Ordering::Acquire), QUEUED_MEDIA);
        assert_eq!(r.snapshot().queued_bytes, QUEUED_MEDIA * 8);
        for i in 0..QUEUED_EVENTS {
            match rx.try_recv().unwrap() {
                Message::Segment { kind, .. } => {
                    assert_eq!(kind, if i < QUEUED_MEDIA { 1 } else { 2 })
                }
                _ => panic!("unexpected start"),
            }
        }
        assert!(rx.try_recv().is_err());
        assert!(!r.failed.load(Ordering::Acquire));
        // A duplicate cannot consume another track's reserved capacity.
        assert!(!r.event(1, 0, 2, &[], Default::default(), 0));
    }
    #[test]
    fn reserved_completion_capacity_does_not_expand_media_admission() {
        let (r, _rx) = held_ingress();
        for _ in 0..QUEUED_MEDIA {
            assert!(r.event(1, 0, 1, b"fragment", Default::default(), 0));
        }
        assert!(!r.event(1, 0, 1, b"ninth fragment", Default::default(), 0));
        assert_eq!(r.snapshot().queued_bytes, QUEUED_MEDIA * 8);
        assert_eq!(r.media_slots.load(Ordering::Acquire), QUEUED_MEDIA);
    }
    fn header() -> RecordingHeader {
        RecordingHeader {
            version: 1,
            room: "test".into(),
            host_origin_ns: 1,
            asset_refs: Default::default(),
            tracks: (0..2)
                .map(|id| RecordingTrack {
                    id,
                    source: format!("program-{id}"),
                    incarnation: 1,
                    width: 1920,
                    height: 1080,
                    audio: false,
                })
                .collect(),
        }
    }
    fn wait(r: &Recorder, phase: &str) {
        let end = std::time::Instant::now() + Duration::from_secs(4);
        while r.snapshot().phase != phase && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(r.snapshot().phase, phase);
    }
    #[test]
    fn all_track_finalization_and_old_session_rejection() {
        let path = std::env::temp_dir().join(format!(
            "native-recorder-{}-{}",
            std::process::id(),
            crate::platform::host_time()
        ));
        let r = Recorder::new().unwrap();
        let session = r.start(path.clone(), header()).unwrap();
        assert!(r.start(path.clone(), header()).is_err());
        let span = [
            NativeSpan {
                start: 0,
                duration: 2,
                rate: 1,
                duration_rate: 1,
                media: 0,
            },
            NativeSpan::default(),
        ];
        for track in 0..2 {
            assert!(r.event(session, track, 0, b"init", Default::default(), 0));
            assert!(r.event(session, track, 1, b"encoded", span, 1));
        }
        assert!(r.event(session, 0, 2, &[], Default::default(), 0));
        std::thread::sleep(Duration::from_millis(40));
        assert_ne!(r.snapshot().phase, "saved");
        assert!(r.event(session, 1, 2, &[], Default::default(), 0));
        wait(&r, "saved");
        assert_eq!(
            RecordingStore::inspect(&path).unwrap().1.state,
            TakeState::Saved
        );
        assert!(!r.event(session + 1, 0, 0, b"stale", Default::default(), 0));
        assert_eq!(r.snapshot().queued_bytes, 0);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn oversized_handoff_fails_closed_without_allocating_oversized_segment() {
        let path = std::env::temp_dir().join(format!(
            "native-recorder-limit-{}-{}",
            std::process::id(),
            crate::platform::host_time()
        ));
        let r = Recorder::new().unwrap();
        let session = r.start(path.clone(), header()).unwrap();
        assert!(!r.event(session, 0, 1, &[], Default::default(), 3));
        wait(&r, "failed");
        assert_eq!(r.snapshot().queued_bytes, 0);
        assert!(!r.event(session, 0, 0, b"late", Default::default(), 0));
        assert_eq!(
            RecordingStore::inspect(&path).unwrap().1.state,
            TakeState::Failed
        );
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn abandoned_start_releases_its_take_lock() {
        let path = std::env::temp_dir().join(format!(
            "native-recorder-abandoned-{}-{}",
            std::process::id(),
            crate::platform::host_time()
        ));
        let r = Recorder::new().unwrap();
        let (tx, rx) = mpsc::sync_channel(0);
        drop(rx);
        r.tx.send(Message::Start(1, path.clone(), header(), tx))
            .unwrap();
        wait(&r, "failed");
        assert_eq!(
            RecordingStore::recover(&path).unwrap().state,
            TakeState::Failed
        );
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn simultaneous_starts_admit_exactly_one_session() {
        let path = std::env::temp_dir().join(format!(
            "native-recorder-concurrent-{}-{}",
            std::process::id(),
            crate::platform::host_time()
        ));
        let r = Arc::new(Recorder::new().unwrap());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let (r, barrier, path) = (r.clone(), barrier.clone(), path.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    r.start(path, header())
                })
            })
            .collect();
        barrier.wait();
        let sessions: Vec<_> = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap().ok())
            .collect();
        assert_eq!(sessions.len(), 1);
        assert!(r.event(sessions[0], 0, 3, b"test finished", Default::default(), 0));
        wait(&r, "failed");
        std::fs::remove_dir_all(path).unwrap();
    }
}
