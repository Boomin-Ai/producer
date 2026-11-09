//! One process broker drains timestamped SDK PCM and routes each block to
//! at most one authorized receiver. Native observers retain only queues.
use crate::{
    authority::{Permission, Snapshot},
    timing::{
        playout_clock::VideoClock,
        presentation::Presentation,
        queue::{Captured, Queue},
        sender_clock::{SenderClock, SenderReport},
    },
    GuestMedia,
};
use cxx::{SharedPtr, UniquePtr};
use livekit::{
    prelude::RemoteTrack,
    webrtc::{native::new_video_frame_buffer, video_frame::VideoBuffer},
};
use producer_guest_session::PublishSource;
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use webrtc_sys::{
    audio_track as audio_sys, video_frame as frame_sys, video_track as video_sys,
    webrtc::ffi::DecodedAudioBlock,
};
type Frame = UniquePtr<frame_sys::ffi::VideoFrame>;
#[path = "media_routes.rs"]
mod routes;
#[cfg(test)]
use routes::MAX_RECEIVERS;
use routes::{registration_allowed, Routes};

pub struct Video<'a> {
    pub planes: (&'a [u8], &'a [u8], &'a [u8]),
    pub width: u32,
    pub height: u32,
    pub strides: (u32, u32, u32),
}
/// The implementation synchronously copies media. `invalidate` must fence all
/// older deliveries and clear displayed video; the scene retains ownership.
pub trait Output: Send + Sync {
    fn video(&self, frame: Video<'_>, scheduled: Instant) -> bool;
    fn audio(&self, samples: &[i16], channels: u32, scheduled: Instant) -> bool;
    fn invalidate(&self);
}
pub trait Outputs: Send + Sync + 'static {
    fn available(&self, source_id: &str) -> bool;
    fn open(&self, source_id: &str) -> Option<Arc<dyn Output>>;
}
#[derive(Default)]
pub struct Counters {
    pub video: AtomicU64,
    pub audio: AtomicU64,
    pub rejected: AtomicU64,
    pub observers: AtomicU64,
    pub workers: AtomicU64,
    pub bindings: AtomicU64,
    pub sender_reports: AtomicU64,
    pub pcm_received: AtomicU64,
    pub video_received: AtomicU64,
}
impl Counters {
    pub fn report(&self) -> serde_json::Value {
        serde_json::json!({"video_submitted":self.video.load(Ordering::Acquire),
            "audio_submitted":self.audio.load(Ordering::Acquire),
            "rejected":self.rejected.load(Ordering::Acquire),
            "video_observers":self.observers.load(Ordering::Acquire),
            "workers":self.workers.load(Ordering::Acquire),
            "bindings":self.bindings.load(Ordering::Acquire),"sender_reports":self.sender_reports.load(Ordering::Acquire),
            "pcm_received":self.pcm_received.load(Ordering::Acquire),"video_received":self.video_received.load(Ordering::Acquire)})
    }
}
struct Observer {
    queue: Arc<Queue<Frame>>,
    counters: Arc<Counters>,
}
impl video_sys::VideoSink for Observer {
    fn on_frame(&self, frame: Frame) {
        if !frame.is_null() {
            self.counters.video_received.fetch_add(1, Ordering::Relaxed);
            self.queue.push(Captured {
                at: Instant::now(),
                value: frame,
            });
        }
    }
    fn on_discarded_frame(&self) {}
    fn on_constraints_changed(&self, _: video_sys::ffi::VideoTrackSourceConstraints) {}
}
struct VideoTap {
    track: SharedPtr<video_sys::ffi::VideoTrack>,
    sink: SharedPtr<video_sys::ffi::NativeVideoSink>,
    queue: Arc<Queue<Frame>>,
    counters: Arc<Counters>,
}
impl VideoTap {
    fn new(track: &livekit::prelude::RemoteVideoTrack, counters: Arc<Counters>) -> Self {
        let queue = Arc::new(Queue::new(2, Duration::from_millis(50)));
        let sink = video_sys::ffi::new_native_video_sink(Box::new(
            video_sys::VideoSinkWrapper::new(Arc::new(Observer {
                queue: queue.clone(),
                counters: counters.clone(),
            })),
        ));
        // SDK guarantees this remote track is video; the callback owns no track.
        let track =
            unsafe { video_sys::ffi::media_to_video(track.rtc_track().native_sys_handle()) };
        track.add_sink(&sink);
        counters.observers.fetch_add(1, Ordering::AcqRel);
        Self {
            track,
            sink,
            queue,
            counters,
        }
    }
}
impl Drop for VideoTap {
    fn drop(&mut self) {
        self.track.remove_sink(&self.sink);
        self.counters.observers.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Track {
    sid: String,
    source: PublishSource,
    ssrc: Arc<AtomicU32>,
    bound: u32,
    last_ssrc: u32,
    stop: Arc<AtomicBool>,
    stats: Option<JoinHandle<()>>,
    video: Option<VideoTap>,
}
impl Track {
    fn bind(&mut self, ssrc: u32, retired: &mut HashSet<u32>) -> bool {
        if ssrc == self.bound {
            return false;
        }
        // A missing/timeout stats result disables delivery and clears its clock;
        // it does not retire the still-owned track's SSRC. Fresh stats may prove
        // that same binding again. Actual replacement remains quarantined.
        if ssrc != 0 {
            if self.last_ssrc != 0 && self.last_ssrc != ssrc {
                retired.insert(self.last_ssrc);
            }
            self.last_ssrc = ssrc;
        }
        self.bound = ssrc;
        true
    }
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}
impl Drop for Track {
    fn drop(&mut self) {
        self.stop();
        self.video.take(); // unregister before releasing the retained SDK track
        if let Some(thread) = self.stats.take() {
            let _ = thread.join();
        }
    }
}
struct Guest {
    permission: Permission,
    output: Arc<dyn Output>,
    tracks: Vec<Track>,
    since: i64,
    clock: Presentation,
    audio_clock: Option<SenderClock>,
    video_clock: Option<SenderClock>,
    audio: VecDeque<(Instant, DecodedAudioBlock)>,
    video: VecDeque<(Instant, Frame)>,
    routing_fenced: bool,
}
impl Guest {
    fn clear(&mut self) {
        self.output.invalidate();
        self.audio.clear();
        self.video.clear();
        self.clock.clear();
        self.audio_clock = None;
        self.video_clock = None;
    }
}
struct State {
    guests: HashMap<String, Guest>,
    retired_ssrc: HashSet<u32>,
    outputs: Option<Arc<dyn Outputs>>,
    counters: Arc<Counters>,
    rtc_clock: VideoClock,
}
impl State {
    fn remove(&mut self, id: &str) -> Option<Guest> {
        let mut guest = self.guests.remove(id)?;
        for track in &guest.tracks {
            track.stop();
            if track.last_ssrc != 0 {
                self.retired_ssrc.insert(track.last_ssrc);
            }
            let observed = track.ssrc.load(Ordering::Acquire);
            if observed != 0 {
                self.retired_ssrc.insert(observed);
            }
        }
        guest.clear();
        Some(guest)
    }
    fn prepare_bindings(&mut self, rtc: i64, reports: &[SenderReport]) {
        self.counters
            .sender_reports
            .store(reports.len() as u64, Ordering::Relaxed);
        for guest in self.guests.values_mut() {
            let mut changed = false;
            for track in &mut guest.tracks {
                let ssrc = track.ssrc.load(Ordering::Acquire);
                changed |= track.bind(ssrc, &mut self.retired_ssrc);
            }
            if changed {
                #[cfg(debug_assertions)]
                eprintln!("Native RTC receiver clock reset: binding changed");
                guest.clear();
                if let Some(output) = self
                    .outputs
                    .as_ref()
                    .and_then(|outputs| outputs.open(&guest.permission.source_id()))
                {
                    guest.output = output;
                }
                guest.since = rtc;
                for track in &guest.tracks {
                    if track.bound != 0 {
                        if track.source == PublishSource::Camera {
                            guest.video_clock = Some(SenderClock::new(track.bound, 90000));
                        } else {
                            guest.audio_clock = Some(SenderClock::new(track.bound, 48000));
                        }
                    }
                }
            }
            for track in &guest.tracks {
                if track.bound != 0 {
                    if track.source == PublishSource::Camera && guest.video_clock.is_none() {
                        guest.video_clock = Some(SenderClock::new(track.bound, 90000));
                    } else if track.source == PublishSource::Microphone
                        && guest.audio_clock.is_none()
                    {
                        guest.audio_clock = Some(SenderClock::new(track.bound, 48000));
                    }
                }
            }
            for report in reports.iter().filter(|r| r.observed_us >= guest.since) {
                if let Some(clock) = &mut guest.audio_clock {
                    clock.observe(*report);
                }
                if let Some(clock) = &mut guest.video_clock {
                    clock.observe(*report);
                }
            }
        }
    }
    fn tick(
        &mut self,
        now: Instant,
        rtc: i64,
        blocks: Vec<DecodedAudioBlock>,
        counts: &HashMap<u32, usize>,
        retired: &HashSet<u32>,
    ) {
        self.counters.bindings.store(
            self.guests
                .values()
                .flat_map(|g| g.tracks.iter().map(|t| t.bound))
                .filter(|s| *s != 0)
                .collect::<HashSet<_>>()
                .len() as u64,
            Ordering::Relaxed,
        );
        for guest in self.guests.values_mut() {
            let ambiguous = guest.tracks.iter().any(|track| {
                track.bound != 0
                    && (counts.get(&track.bound) != Some(&1) || retired.contains(&track.bound))
            });
            if ambiguous && !guest.routing_fenced {
                guest.clear();
                guest.since = rtc;
            }
            guest.routing_fenced = ambiguous;
        }
        self.counters
            .pcm_received
            .fetch_add(blocks.len() as u64, Ordering::Relaxed);
        for block in blocks {
            if !matches!(block.channels, 1 | 2)
                || block.pull_us <= 0
                || block.ssrc == 0
                || counts.get(&block.ssrc) != Some(&1)
                || retired.contains(&block.ssrc)
            {
                continue;
            }
            let Some(guest) = self.guests.values_mut().find(|g| {
                g.tracks
                    .iter()
                    .any(|t| t.source == PublishSource::Microphone && t.bound == block.ssrc)
            }) else {
                continue;
            };
            if block.pull_us < guest.since
                || !guest.permission.allows(
                    guest.permission.rtc_identity(),
                    PublishSource::Microphone,
                    now,
                )
            {
                continue;
            }
            let Some(pull) = self.rtc_clock.deadline(block.pull_us, now) else {
                continue;
            };
            let origin = guest
                .audio_clock
                .as_ref()
                .and_then(|c| c.playback_origin(block.rtp_timestamp, rtc, true));
            if origin.is_none() {
                continue;
            }
            if let Some(at) = guest
                .clock
                .audio(block.generation, block.sequence, origin, pull)
            {
                if guest.audio.len() < 24 {
                    guest.audio.push_back((at, block));
                } else {
                    self.counters.rejected.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        for guest in self.guests.values_mut() {
            for track in &guest.tracks {
                if track.source != PublishSource::Camera
                    || track.bound == 0
                    || counts.get(&track.bound) != Some(&1)
                    || retired.contains(&track.bound)
                {
                    continue;
                }
                let Some(tap) = &track.video else {
                    continue;
                };
                for _ in 0..2 {
                    let Some(frame) = tap.queue.pop(now) else {
                        break;
                    };
                    if !guest.permission.allows(
                        guest.permission.rtc_identity(),
                        PublishSource::Camera,
                        now,
                    ) {
                        continue;
                    }
                    let origin = guest
                        .video_clock
                        .as_ref()
                        .and_then(|c| c.playback_origin(frame.value.timestamp(), rtc, true));
                    // A camera-only grant has no audio master. Use its actual SDK
                    // render deadline only after its sender mapping is qualified.
                    let at = if guest.permission.allows(
                        guest.permission.rtc_identity(),
                        PublishSource::Microphone,
                        now,
                    ) {
                        guest.clock.video(origin, frame.at)
                    } else {
                        origin
                            .and_then(|_| {
                                self.rtc_clock
                                    .deadline(frame.value.timestamp_us(), frame.at)
                            })
                            .and_then(|at| at.checked_add(Duration::from_millis(120)))
                    };
                    if let Some(at) = at {
                        if guest.video.len() < 8 {
                            guest.video.push_back((at, frame.value));
                        } else {
                            self.counters.rejected.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
            while guest.audio.front().is_some_and(|(at, _)| *at <= now) {
                let (at, block) = guest.audio.pop_front().unwrap();
                // Keep the audio clock warm for preview synchronization, but
                // never submit backstage PCM to OBS/program/recording mixers.
                if !guest.permission.on_stage() {
                    continue;
                }
                if now.saturating_duration_since(at) <= Duration::from_millis(30)
                    && guest.permission.allows(
                        guest.permission.rtc_identity(),
                        PublishSource::Microphone,
                        now,
                    )
                    && submit_program_audio(
                        &guest.permission,
                        guest.output.as_ref(),
                        &block.samples[..480 * block.channels as usize],
                        block.channels,
                        at,
                        now,
                    )
                {
                    self.counters.audio.fetch_add(1, Ordering::Relaxed);
                } else {
                    self.counters.rejected.fetch_add(1, Ordering::Relaxed);
                }
            }
            while guest.video.front().is_some_and(|(at, _)| *at <= now) {
                let (at, frame) = guest.video.pop_front().unwrap();
                if now.saturating_duration_since(at) > Duration::from_millis(30)
                    || !guest.permission.allows(
                        guest.permission.rtc_identity(),
                        PublishSource::Camera,
                        now,
                    )
                {
                    continue;
                }
                let buffer =
                    new_video_frame_buffer(unsafe { frame.video_frame_buffer() }).to_i420();
                if guest.output.video(
                    Video {
                        planes: buffer.data(),
                        width: buffer.width(),
                        height: buffer.height(),
                        strides: buffer.strides(),
                    },
                    at,
                ) {
                    self.counters.video.fetch_add(1, Ordering::Relaxed);
                } else {
                    self.counters.rejected.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }
}
struct BrokerState {
    receivers: BTreeMap<u64, Weak<Mutex<State>>>,
    next_id: u64,
    routes: Routes,
    shared: Option<bool>,
    retiring: usize,
}
struct ReceiveBroker {
    state: Mutex<BrokerState>,
    wake: Condvar,
    failed: AtomicBool,
    drains: AtomicU64,
}
impl ReceiveBroker {
    fn shared() -> Result<Arc<Self>, &'static str> {
        static BROKER: OnceLock<Result<Arc<ReceiveBroker>, &'static str>> = OnceLock::new();
        BROKER
            .get_or_init(|| {
                let broker = Arc::new(Self {
                    state: Mutex::new(BrokerState {
                        receivers: BTreeMap::new(),
                        next_id: 1,
                        routes: Routes::default(),
                        shared: None,
                        retiring: 0,
                    }),
                    wake: Condvar::new(),
                    failed: AtomicBool::new(false),
                    drains: AtomicU64::new(0),
                });
                let worker = broker.clone();
                thread::Builder::new()
                    .name("rtc-native-receive-broker".into())
                    .spawn(move || worker.run())
                    .map_err(|_| "Native receive broker unavailable")?;
                Ok(broker)
            })
            .clone()
    }
    fn register(&self, state: &Arc<Mutex<State>>, shared: bool) -> Result<u64, &'static str> {
        let mut broker = self
            .state
            .lock()
            .map_err(|_| "Native receive broker unavailable")?;
        if broker.retiring != 0 {
            return Err("Native receive pipeline already owned");
        }
        registration_allowed(broker.receivers.len(), broker.shared, shared)?;
        if broker.receivers.is_empty() && !shared {
            // Preserve the default receiver's old fresh-owner quarantine epoch.
            // This cannot reset bindings underneath any shared/live receiver.
            broker.routes = Routes::default();
            self.failed.store(false, Ordering::Release);
        }
        if self.failed.load(Ordering::Acquire) || broker.routes.failed() {
            return Err("Native receive broker requires a process restart");
        }
        let id = broker.next_id;
        broker.next_id = id
            .checked_add(1)
            .ok_or("Native receive owner generation exhausted")?;
        broker.receivers.insert(id, Arc::downgrade(state));
        broker.shared = Some(shared);
        self.wake.notify_one();
        Ok(id)
    }
    fn unregister(&self, id: u64, state: &Arc<Mutex<State>>) {
        // Same lock order as the worker: broker, then receiver state. Joining
        // track workers and releasing output factories happens outside both.
        let (retired, outputs) = if let Ok(mut broker) = self.state.lock() {
            broker.retiring += 1;
            broker.receivers.remove(&id);
            broker.routes.remove(id);
            {
                let mut state = match state.lock() {
                    Ok(state) => state,
                    Err(poisoned) => {
                        self.failed.store(true, Ordering::Release);
                        poisoned.into_inner()
                    }
                };
                let ids: Vec<_> = state.guests.keys().cloned().collect();
                let retired: Vec<_> = ids.into_iter().filter_map(|id| state.remove(&id)).collect();
                for ssrc in state.retired_ssrc.drain() {
                    broker.routes.retire(ssrc);
                }
                (retired, state.outputs.take())
            }
        } else {
            self.failed.store(true, Ordering::Release);
            (Vec::new(), None)
        };
        self.wake.notify_one();
        drop(retired);
        drop(outputs);
        if let Ok(mut broker) = self.state.lock() {
            broker.retiring = broker.retiring.saturating_sub(1);
        }
    }
    fn run(&self) {
        loop {
            let Ok(mut broker) = self.state.lock() else {
                self.failed.store(true, Ordering::Release);
                return;
            };
            while broker.receivers.is_empty() {
                let Ok(waiting) = self.wake.wait(broker) else {
                    self.failed.store(true, Ordering::Release);
                    return;
                };
                broker = waiting;
            }
            let expired: Vec<_> = broker
                .receivers
                .iter()
                .filter_map(|(&id, state)| state.upgrade().is_none().then_some(id))
                .collect();
            for id in expired {
                broker.receivers.remove(&id);
                broker.routes.remove(id);
            }
            let owners: Vec<_> = broker
                .receivers
                .iter()
                .filter_map(|(&id, state)| state.upgrade().map(|state| (id, state)))
                .collect();
            let mut states = Vec::with_capacity(owners.len());
            for (id, state) in &owners {
                match state.lock() {
                    Ok(state) => states.push((*id, state)),
                    Err(_) => self.failed.store(true, Ordering::Release),
                }
            }
            if !self.failed.load(Ordering::Acquire) && !states.is_empty() {
                let now = Instant::now();
                let rtc = audio_sys::ffi::diagnostic_webrtc_time_us();
                let reports: Vec<_> = webrtc_sys::webrtc::ffi::diagnostic_incoming_clock_reports()
                    .into_iter()
                    .map(|r| SenderReport {
                        ssrc: r.ssrc,
                        ntp_seconds: r.ntp_seconds,
                        ntp_fraction: r.ntp_fraction,
                        rtp_timestamp: r.rtp_timestamp,
                        observed_us: r.observed_us,
                    })
                    .collect();
                for (_, state) in &mut states {
                    state.prepare_bindings(rtc, &reports);
                }
                let bindings: Vec<_> = states
                    .iter()
                    .flat_map(|(id, state)| {
                        state
                            .guests
                            .values()
                            .flat_map(move |g| g.tracks.iter().map(move |t| (*id, t.bound)))
                    })
                    .collect();
                for (_, state) in &mut states {
                    for ssrc in state.retired_ssrc.drain() {
                        broker.routes.retire(ssrc);
                    }
                }
                broker.routes.update(bindings);
                if broker.routes.failed() {
                    self.failed.store(true, Ordering::Release);
                }
                if !self.failed.load(Ordering::Acquire) {
                    // The only process-wide drain. Every live state is gated
                    // until delivery finishes, so close cannot race routing.
                    let mut batches = broker.routes.drain(
                        || {
                            self.drains.fetch_add(1, Ordering::Relaxed);
                            webrtc_sys::webrtc::ffi::diagnostic_take_decoded_audio()
                        },
                        |block| block.ssrc,
                    );
                    for (id, state) in &mut states {
                        state.tick(
                            now,
                            rtc,
                            batches.remove(id).unwrap_or_default(),
                            broker.routes.counts(),
                            broker.routes.retired(),
                        );
                    }
                }
            }
            if self.failed.load(Ordering::Acquire) {
                for (_, state) in &mut states {
                    for guest in state.guests.values_mut() {
                        if !guest.routing_fenced {
                            guest.clear();
                            guest.routing_fenced = true;
                        }
                    }
                }
            }
            drop(states);
            drop(owners);
            let _ = self.wake.wait_timeout(broker, Duration::from_millis(2));
        }
    }
}
pub struct Receiver {
    state: Arc<Mutex<State>>,
    broker: Arc<ReceiveBroker>,
    registration: Option<u64>,
    counters: Arc<Counters>,
}
impl Receiver {
    /// Default host behavior: one active receive owner and a fresh SSRC
    /// quarantine epoch once the previous owner has completely closed.
    pub fn new(outputs: Arc<dyn Outputs>) -> Result<Self, &'static str> {
        Self::new_mode(outputs, false)
    }
    /// Explicit candidate mode. Independent authorized rooms share the single
    /// process drain and keep a global quarantine across concurrent owners.
    pub fn new_shared(outputs: Arc<dyn Outputs>) -> Result<Self, &'static str> {
        Self::new_mode(outputs, true)
    }
    fn new_mode(outputs: Arc<dyn Outputs>, shared: bool) -> Result<Self, &'static str> {
        if std::env::var("LIVEKIT_LAB_TIMED_MIXER").as_deref() != Ok("1")
            || std::env::var("LIVEKIT_LAB_RTCP_PROBE").as_deref() != Ok("1")
        {
            return Err("Timestamped native receive pipeline is not configured");
        }
        let counters = Arc::new(Counters::default());
        let state = Arc::new(Mutex::new(State {
            guests: HashMap::new(),
            retired_ssrc: HashSet::new(),
            outputs: Some(outputs),
            counters: counters.clone(),
            rtc_clock: VideoClock::new(audio_sys::ffi::diagnostic_webrtc_time_us(), Instant::now()),
        }));
        let broker = ReceiveBroker::shared()?;
        let registration = Some(broker.register(&state, shared)?);
        Ok(Self {
            state,
            broker,
            registration,
            counters,
        })
    }
    pub fn counters(&self) -> Arc<Counters> {
        self.counters.clone()
    }
}
impl GuestMedia for Receiver {
    fn can_receive(&self, p: &Permission, _: PublishSource) -> bool {
        self.registration.is_some()
            && !self.broker.failed.load(Ordering::Acquire)
            && self.state.lock().is_ok_and(|s| {
                s.outputs
                    .as_ref()
                    .is_some_and(|outputs| outputs.available(&p.source_id()))
            })
    }
    fn reconcile(&mut self, authority: Option<&Snapshot>, now: Instant) {
        let mut retired = Vec::new();
        if let Ok(mut state) = self.state.lock() {
            let ids: Vec<_> = state.guests.keys().cloned().collect();
            for id in ids {
                let guest = state.guests.get_mut(&id).unwrap();
                let next = authority.and_then(|a| {
                    guest
                        .tracks
                        .first()
                        .and_then(|t| a.permission(guest.permission.rtc_identity(), t.source, now))
                });
                let valid = next.is_some_and(|p| {
                    guest
                        .tracks
                        .iter()
                        .all(|t| p.allows(p.rtc_identity(), t.source, now))
                });
                if valid {
                    guest.permission = next.unwrap().clone();
                } else if let Some(guest) = state.remove(&id) {
                    #[cfg(debug_assertions)]
                    eprintln!("Native RTC receive permission retired");
                    retired.push(guest);
                }
            }
        }
        drop(retired); // joins outside the media state gate
    }
    fn attach(
        &mut self,
        p: &Permission,
        source: PublishSource,
        sid: &str,
        track: RemoteTrack,
    ) -> Result<(), &'static str> {
        if self.registration.is_none() || self.broker.failed.load(Ordering::Acquire) {
            return Err("Native receive owner is closed");
        }
        if !p.allows(p.rtc_identity(), source, Instant::now()) {
            return Err("Native receive permission expired");
        }
        let video = match (&track, source) {
            (RemoteTrack::Video(v), PublishSource::Camera) => {
                Some(VideoTap::new(v, self.counters.clone()))
            }
            (RemoteTrack::Audio(_), PublishSource::Microphone) => None,
            _ => return Err("Native receive track type mismatch"),
        };
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| "Native receive runtime unavailable")?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let ssrc = Arc::new(AtomicU32::new(0));
        let binding = ssrc.clone();
        let kind = if source == PublishSource::Camera {
            "video"
        } else {
            "audio"
        };
        let counters = self.counters.clone();
        let stats = thread::Builder::new()
            .name("rtc-receiver-binding".into())
            .spawn(move || {
                counters.workers.fetch_add(1, Ordering::AcqRel);
                while !stopped.load(Ordering::Acquire) {
                    let result = runtime.block_on(async {
                        // Stats are a decoder-binding proof, not a 4 Hz media poll.
                        // Eight concurrent tracks otherwise overload the SDK stats lane.
                        // Deadline/failure still invalidates the binding below.
                        tokio::time::timeout(Duration::from_millis(1500), track.get_stats()).await
                    });
                    if let Ok(Ok(stats)) = result {
                        let streams: Vec<_> = stats
                            .into_iter()
                            .filter_map(|s| match s {
                                livekit::webrtc::stats::RtcStats::InboundRtp(s) => Some(s.stream),
                                _ => None,
                            })
                            .collect();
                        let next = if streams.len() == 1 && streams[0].kind == kind { streams[0].ssrc } else { 0 };
                        let previous = binding.swap(next, Ordering::AcqRel);
                        #[cfg(debug_assertions)]
                        if previous != next {
                            eprintln!("Native RTC binding observed: kind={kind} available={} inbound={}", next != 0, streams.len());
                        }
                    } else {
                        let previous = binding.swap(0, Ordering::AcqRel);
                        #[cfg(debug_assertions)]
                        if previous != 0 { eprintln!("Native RTC receiver binding unavailable: stats deadline or failure"); }
                    }
                    for _ in 0..100 {
                        if stopped.load(Ordering::Acquire) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                }
                counters.workers.fetch_sub(1, Ordering::AcqRel);
            })
            .map_err(|_| "Native receiver binding worker unavailable")?;
        let owned = Track {
            sid: sid.into(),
            source,
            ssrc,
            bound: 0,
            last_ssrc: 0,
            stop,
            stats: Some(stats),
            video,
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native receive state unavailable")?;
        let id = p.participant_id().to_owned();
        if !state.guests.contains_key(&id) {
            let output = state
                .outputs
                .as_ref()
                .and_then(|outputs| outputs.open(&p.source_id()))
                .ok_or("Native guest scene unavailable")?;
            state.guests.insert(
                id.clone(),
                Guest {
                    permission: p.clone(),
                    output,
                    tracks: Vec::new(),
                    since: audio_sys::ffi::diagnostic_webrtc_time_us(),
                    clock: Presentation::new(Duration::from_millis(120)),
                    audio_clock: None,
                    video_clock: None,
                    audio: VecDeque::with_capacity(24),
                    video: VecDeque::with_capacity(8),
                    routing_fenced: false,
                },
            );
        }
        let guest = state.guests.get_mut(&id).unwrap();
        if guest.permission.rtc_identity() != p.rtc_identity()
            || guest
                .tracks
                .iter()
                .any(|t| t.sid == sid || t.source == source)
        {
            return Err("Native guest publication already owned");
        }
        guest.tracks.push(owned);
        Ok(())
    }
    fn detach(&mut self, sid: &str) {
        let (retired, orphan) = if let Ok(mut state) = self.state.lock() {
            let id = state
                .guests
                .iter()
                .find(|(_, g)| g.tracks.iter().any(|t| t.sid == sid))
                .map(|(id, _)| id.clone());
            if let Some(id) = id {
                let mut guest = state.guests.remove(&id).unwrap();
                guest.clear();
                let index = guest.tracks.iter().position(|t| t.sid == sid).unwrap();
                let retired = guest.tracks.remove(index);
                retired.stop();
                for ssrc in [retired.last_ssrc, retired.ssrc.load(Ordering::Acquire)] {
                    if ssrc != 0 {
                        state.retired_ssrc.insert(ssrc);
                    }
                }
                let output = if guest.tracks.is_empty() {
                    None
                } else {
                    state
                        .outputs
                        .as_ref()
                        .and_then(|outputs| outputs.open(&guest.permission.source_id()))
                };
                if !guest.tracks.is_empty() && output.is_some() {
                    guest.output = output.unwrap();
                    guest.since = audio_sys::ffi::diagnostic_webrtc_time_us();
                    for track in &guest.tracks {
                        if track.bound != 0 {
                            if track.source == PublishSource::Camera {
                                guest.video_clock = Some(SenderClock::new(track.bound, 90000));
                            } else {
                                guest.audio_clock = Some(SenderClock::new(track.bound, 48000));
                            }
                        }
                    }
                    state.guests.insert(id, guest);
                    (Some(retired), None)
                } else {
                    // Reopening can fail while the owner retires. Quarantine
                    // every remaining binding, then join outside the gate.
                    for track in &guest.tracks {
                        track.stop();
                        for ssrc in [track.last_ssrc, track.ssrc.load(Ordering::Acquire)] {
                            if ssrc != 0 {
                                state.retired_ssrc.insert(ssrc);
                            }
                        }
                    }
                    (Some(retired), Some(guest))
                }
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
        drop(retired);
        drop(orphan);
    }
    fn close(&mut self) {
        if let Some(id) = self.registration.take() {
            self.broker.unregister(id, &self.state);
        }
    }
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct EmptyOutputs;
    #[test]
    fn temporary_stats_loss_requires_a_fresh_clock_without_permanently_retiring_the_owned_track() {
        let mut track = Track {
            sid: "owned".into(),
            source: PublishSource::Microphone,
            ssrc: Arc::new(AtomicU32::new(0)),
            bound: 0,
            last_ssrc: 0,
            stop: Arc::new(AtomicBool::new(false)),
            stats: None,
            video: None,
        };
        let mut retired = HashSet::new();
        assert!(track.bind(7, &mut retired));
        assert!(track.bind(0, &mut retired));
        assert!(retired.is_empty());
        assert!(track.bind(7, &mut retired));
        assert!(!track.bind(7, &mut retired));
        assert!(retired.is_empty());
        assert!(track.bind(8, &mut retired));
        assert!(retired.contains(&7));
        assert_eq!(track.last_ssrc, 8);
        assert!(track.bind(0, &mut retired));
        assert_eq!(track.last_ssrc, 8); // cancellation still retires this binding
    }
    impl Outputs for EmptyOutputs {
        fn available(&self, _: &str) -> bool {
            false
        }
        fn open(&self, _: &str) -> Option<Arc<dyn Output>> {
            None
        }
    }
    #[test]
    fn repeated_receive_owner_close_drop_and_partial_setup_release_only_its_registration() {
        let previous = ["LIVEKIT_LAB_TIMED_MIXER", "LIVEKIT_LAB_RTCP_PROBE"]
            .map(|name| (name, std::env::var_os(name)));
        std::env::remove_var("LIVEKIT_LAB_TIMED_MIXER");
        assert!(Receiver::new_shared(Arc::new(EmptyOutputs)).is_err());
        for name in ["LIVEKIT_LAB_TIMED_MIXER", "LIVEKIT_LAB_RTCP_PROBE"] {
            std::env::set_var(name, "1");
        }
        let mut exclusive = Receiver::new(Arc::new(EmptyOutputs)).unwrap();
        assert!(Receiver::new(Arc::new(EmptyOutputs)).is_err());
        assert!(Receiver::new_shared(Arc::new(EmptyOutputs)).is_err());
        let broker = ReceiveBroker::shared().unwrap();
        broker.state.lock().unwrap().routes.retire(7);
        exclusive.close();
        let mut fresh = Receiver::new(Arc::new(EmptyOutputs)).unwrap();
        assert!(
            !broker.state.lock().unwrap().routes.retired().contains(&7),
            "a fresh default owner retains its original quarantine reset behavior"
        );
        fresh.close();
        struct RetiringOutputs {
            entered: std::sync::mpsc::SyncSender<()>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl Outputs for RetiringOutputs {
            fn available(&self, _: &str) -> bool {
                false
            }
            fn open(&self, _: &str) -> Option<Arc<dyn Output>> {
                None
            }
        }
        impl Drop for RetiringOutputs {
            fn drop(&mut self) {
                self.entered.send(()).unwrap();
                self.release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
            }
        }
        let (entered, retiring) = std::sync::mpsc::sync_channel(1);
        let (release, released) = std::sync::mpsc::sync_channel(1);
        let mut retiring_owner = Receiver::new(Arc::new(RetiringOutputs {
            entered,
            release: Mutex::new(released),
        }))
        .unwrap();
        let close = thread::spawn(move || retiring_owner.close());
        retiring.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            Receiver::new(Arc::new(EmptyOutputs)).is_err(),
            "a fresh exclusive epoch cannot begin while old outputs retire"
        );
        assert!(Receiver::new_shared(Arc::new(EmptyOutputs)).is_err());
        release.send(()).unwrap();
        close.join().unwrap();
        Receiver::new(Arc::new(EmptyOutputs)).unwrap().close();
        for cycle in 0..50 {
            let outputs = Arc::new(EmptyOutputs);
            let weak = Arc::downgrade(&outputs);
            let mut receiver = Receiver::new_shared(outputs).unwrap();
            let mut other = Receiver::new_shared(Arc::new(EmptyOutputs)).unwrap();
            assert!(Receiver::new(Arc::new(EmptyOutputs)).is_err());
            let counters = receiver.counters();
            receiver.reconcile(None, Instant::now());
            if cycle % 2 == 0 {
                receiver.close();
                receiver.close();
                assert!(
                    weak.upgrade().is_none(),
                    "close releases its output factory"
                );
            }
            drop(receiver);
            assert!(other.registration.is_some());
            other.close();
            assert_eq!(counters.workers.load(Ordering::Acquire), 0);
            assert_eq!(counters.observers.load(Ordering::Acquire), 0);
            assert!(weak.upgrade().is_none());
        }
        let broker = ReceiveBroker::shared().unwrap();
        let mut owners: Vec<_> = (0..MAX_RECEIVERS)
            .map(|_| Receiver::new_shared(Arc::new(EmptyOutputs)).unwrap())
            .collect();
        let failed_factory = Arc::new(EmptyOutputs);
        let failed_weak = Arc::downgrade(&failed_factory);
        assert!(Receiver::new_shared(failed_factory).is_err());
        assert!(
            failed_weak.upgrade().is_none(),
            "partial setup retains no factory"
        );
        owners[0].close();
        let replacement = Receiver::new_shared(Arc::new(EmptyOutputs)).unwrap();
        assert!(owners[1..].iter().all(|owner| owner.registration.is_some()));
        drop(replacement);
        drop(owners);
        assert!(broker.state.lock().unwrap().receivers.is_empty());
        let drains = broker.drains.load(Ordering::Acquire);
        thread::sleep(Duration::from_millis(10));
        assert_eq!(
            broker.drains.load(Ordering::Acquire),
            drains,
            "idle broker never drains SDK PCM"
        );
        for (name, value) in previous {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

fn submit_program_audio(
    permission: &Permission,
    output: &dyn Output,
    samples: &[i16],
    channels: u32,
    at: Instant,
    now: Instant,
) -> bool {
    permission.on_stage()
        && permission.allows(permission.rtc_identity(), PublishSource::Microphone, now)
        && output.audio(samples, channels, at)
}

#[cfg(test)]
mod backstage_audio_tests {
    use super::*;
    use crate::authority::{HostReceipt, Snapshot};
    use serde_json::json;
    struct Probe(std::sync::atomic::AtomicUsize);
    impl Output for Probe {
        fn video(&self, _: Video<'_>, _: Instant) -> bool {
            true
        }
        fn audio(&self, _: &[i16], _: u32, _: Instant) -> bool {
            self.0.fetch_add(1, Ordering::Relaxed);
            true
        }
        fn invalidate(&self) {}
    }
    #[test]
    fn backstage_pcm_never_reaches_program_output_but_on_stage_pcm_does() {
        let id = "11111111-1111-4111-8111-111111111111";
        let now = Instant::now();
        let wall = 1791800000000u64;
        let receipt = json!({"brand_id":id,"room_id":id,"run_id":id,"host_process_id":id,"host_participant_id":id,
          "transport":"livekit","endpoint":"wss://fixture.livekit.cloud","state":"active","host_lease_epoch":1,"control_revision":1,"host_lease_expires_at_ms":wall+45000});
        let expected: HostReceipt = serde_json::from_value(receipt.clone()).unwrap();
        let identity = format!("guest-{id}-e1-g1");
        let probe = Probe(std::sync::atomic::AtomicUsize::new(0));
        for on_stage in [false, true] {
            let wire = json!({"schema_version":1,"receipt":receipt,"observed_at_ms":wall,"guests":[{"participant_id":id,"rtc_identity":identity,"authorization_generation":1,"publish_sources":["camera","microphone"],"on_stage":on_stage,"expires_at_ms":wall+45000}]});
            let snapshot = Snapshot::parse(
                &serde_json::to_vec(&wire).unwrap(),
                &expected,
                wall,
                now,
                now,
            )
            .unwrap();
            let permission = snapshot
                .permission(&identity, PublishSource::Microphone, now)
                .unwrap();
            assert_eq!(
                submit_program_audio(permission, &probe, &[123; 480], 1, now, now),
                on_stage
            );
            assert!(!submit_program_audio(
                permission,
                &probe,
                &[123; 480],
                1,
                now,
                now + Duration::from_secs(5)
            ));
        }
        assert_eq!(probe.0.load(Ordering::Relaxed), 1);
    }
}
