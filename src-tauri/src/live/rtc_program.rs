//! Opt-in OBS program publication. Callbacks only copy into bounded queues.
//! Stage bus 1 excludes remote voices; this is not a substitute for host AEC.
use super::ffi;
use producer_guest_runtime::program::{Sources, HEIGHT, WIDTH};
use std::{
    collections::VecDeque,
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// Leave scheduling headroom while retaining the strict stale-audio cutoff.
const LEAD_NS: u64 = 400_000_000;
// Covers the shared lead at up to 60 fps, with bounded scheduling headroom.
const VIDEO_QUEUE_CAPACITY: usize = 26;
// Holds a 400 ms catch-up burst of standard 1024-sample OBS blocks,
// plus one block of headroom. Publication still enforces its own deadlines.
const CAPTURE_AUDIO_BLOCKS: usize = 20;
const MAX_LATE_NS: u64 = 20_000_000;
static CAPTURE_DROPPED: AtomicU64 = AtomicU64::new(0);
static SILENCE_SUBMITTED: AtomicU64 = AtomicU64::new(0);
#[cfg(debug_assertions)]
static CAPTURE_GAP_PROOF: AtomicBool = AtomicBool::new(false);
#[cfg(debug_assertions)]
static CAPTURE_GAP_UNTIL: AtomicU64 = AtomicU64::new(0);
static RECOVERIES: AtomicU64 = AtomicU64::new(0);
#[cfg(debug_assertions)]
static INJECTED: AtomicBool = AtomicBool::new(false);
#[cfg(debug_assertions)]
static VIDEO_INJECTED: AtomicBool = AtomicBool::new(false);
static AUDIO_SUBMITTED: AtomicU64 = AtomicU64::new(0);
static VIDEO_SUBMITTED: AtomicU64 = AtomicU64::new(0);
static MAX_AUDIO_LATE: AtomicU64 = AtomicU64::new(0);
static MIN_AUDIO_SPACING: AtomicU64 = AtomicU64::new(u64::MAX);
static MAX_AUDIO_CALL: AtomicU64 = AtomicU64::new(0);
static CAPTURE_FAULT: AtomicU64 = AtomicU64::new(0);
static STARTUP_DROPPED: AtomicU64 = AtomicU64::new(0);
static MAX_WORK: AtomicU64 = AtomicU64::new(0);
static REALTIME: AtomicBool = AtomicBool::new(false);
static MAX_LOOP_GAP: AtomicU64 = AtomicU64::new(0);
static MAX_CAPTURE_AGE: AtomicU64 = AtomicU64::new(0);
static MAX_CALLBACK_AGE: AtomicU64 = AtomicU64::new(0);
static CAPTURE_PRIORITY: AtomicBool = AtomicBool::new(false);
static MAX_CAPTURE_QUEUE_WAIT: AtomicU64 = AtomicU64::new(0);
static MAX_VIDEO_CALL: AtomicU64 = AtomicU64::new(0);
pub fn note_recovery() {
    RECOVERIES.fetch_add(1, Ordering::Relaxed);
}
pub fn reset_diagnostics() {
    RECOVERIES.store(0, Ordering::Release);
    CAPTURE_DROPPED.store(0, Ordering::Release);
    SILENCE_SUBMITTED.store(0, Ordering::Release);
    #[cfg(debug_assertions)]
    CAPTURE_GAP_UNTIL.store(0, Ordering::Release);
    #[cfg(debug_assertions)]
    INJECTED.store(false, Ordering::Release);
    #[cfg(debug_assertions)]
    VIDEO_INJECTED.store(false, Ordering::Release);
    AUDIO_SUBMITTED.store(0, Ordering::Release);
    VIDEO_SUBMITTED.store(0, Ordering::Release);
    MAX_AUDIO_LATE.store(0, Ordering::Release);
    MIN_AUDIO_SPACING.store(u64::MAX, Ordering::Release);
    MAX_AUDIO_CALL.store(0, Ordering::Release);
    MAX_VIDEO_CALL.store(0, Ordering::Release);
    MAX_LOOP_GAP.store(0, Ordering::Release);
    MAX_WORK.store(0, Ordering::Release);
    STARTUP_DROPPED.store(0, Ordering::Release);
    CAPTURE_FAULT.store(0, Ordering::Release);
    REALTIME.store(false, Ordering::Release);
    MAX_CAPTURE_AGE.store(0, Ordering::Release);
    MAX_CALLBACK_AGE.store(0, Ordering::Release);
    CAPTURE_PRIORITY.store(false, Ordering::Release);
    MAX_CAPTURE_QUEUE_WAIT.store(0, Ordering::Release);
}
pub fn counts() -> (u64, u64) {
    (
        AUDIO_SUBMITTED.load(Ordering::Acquire),
        VIDEO_SUBMITTED.load(Ordering::Acquire),
    )
}
pub fn timing() -> serde_json::Value {
    let spacing = MIN_AUDIO_SPACING.load(Ordering::Acquire);
    #[cfg(debug_assertions)]
    let video_stall_injected = VIDEO_INJECTED.load(Ordering::Acquire);
    #[cfg(not(debug_assertions))]
    let video_stall_injected = false;
    #[cfg(debug_assertions)]
    let capture_gap_injected = CAPTURE_GAP_UNTIL.load(Ordering::Acquire) != 0;
    #[cfg(not(debug_assertions))]
    let capture_gap_injected = false;
    serde_json::json!({"capture_priority_enabled":CAPTURE_PRIORITY.load(Ordering::Acquire),"capture_gap_injected":capture_gap_injected,"capture_blocks_discarded":CAPTURE_DROPPED.load(Ordering::Acquire),"silence_blocks_submitted":SILENCE_SUBMITTED.load(Ordering::Acquire),"video_worker_stall_injected":video_stall_injected,"capture_fault_code":CAPTURE_FAULT.load(Ordering::Acquire),"program_buffer_ms":LEAD_NS/1_000_000,"publisher_recoveries":RECOVERIES.load(Ordering::Acquire),"maximum_audio_late_us":MAX_AUDIO_LATE.load(Ordering::Acquire)/1000,"minimum_audio_spacing_us":(spacing!=u64::MAX).then_some(spacing/1000),"maximum_audio_call_us":MAX_AUDIO_CALL.load(Ordering::Acquire),"startup_audio_blocks_discarded":STARTUP_DROPPED.load(Ordering::Acquire),"time_constrained_scheduling":REALTIME.load(Ordering::Acquire),"maximum_work_us":MAX_WORK.load(Ordering::Acquire)/1000,"maximum_loop_gap_us":MAX_LOOP_GAP.load(Ordering::Acquire)/1000,"maximum_callback_age_us":MAX_CALLBACK_AGE.load(Ordering::Acquire)/1000,"maximum_capture_queue_wait_us":MAX_CAPTURE_QUEUE_WAIT.load(Ordering::Acquire)/1000,"maximum_capture_age_us":MAX_CAPTURE_AGE.load(Ordering::Acquire)/1000,"maximum_video_call_us":MAX_VIDEO_CALL.load(Ordering::Acquire)})
}
#[repr(C)]
struct VideoScale {
    format: i32,
    width: u32,
    height: u32,
    range: i32,
    colorspace: i32,
}
#[repr(C)]
struct AudioConvert {
    rate: u32,
    format: i32,
    speakers: i32,
    allow_clipping: bool,
}
extern "C" {
    fn os_gettime_ns() -> u64;
    fn audio_output_connect(
        audio: *mut ffi::audio_t,
        bus: usize,
        conversion: *const AudioConvert,
        callback: extern "C" fn(*mut c_void, usize, *mut ffi::audio_data),
        param: *mut c_void,
    ) -> bool;
    fn audio_output_disconnect(
        audio: *mut ffi::audio_t,
        bus: usize,
        callback: extern "C" fn(*mut c_void, usize, *mut ffi::audio_data),
        param: *mut c_void,
    );
}
#[cfg(target_os = "macos")]
extern "C" {
    fn pthread_set_qos_class_self_np(class: u32, relative_priority: i32) -> i32;
    fn mach_thread_self() -> u32;
    static mach_task_self_: u32;
    fn mach_port_deallocate(task: u32, name: u32) -> i32;
    fn thread_policy_set(thread: u32, flavor: i32, policy: *const i32, count: u32) -> i32;
    fn mach_absolute_time() -> u64;
    fn mach_timebase_info(info: *mut MachTimebase) -> i32;
    fn mach_wait_until(deadline: u64) -> i32;

}
#[cfg(target_os = "macos")]
#[repr(C)]
struct MachTimebase {
    numer: u32,
    denom: u32,
}
#[cfg(target_os = "macos")]
fn configure_publisher_schedule() -> Result<(), &'static str> {
    let mut info = MachTimebase { numer: 0, denom: 0 };
    if unsafe { mach_timebase_info(&mut info) } != 0 || info.numer == 0 || info.denom == 0 {
        return Err("Native program clock setup failed");
    }
    let ticks = |ns: u64| -> Result<i32, &'static str> {
        let value = ns * u64::from(info.denom) / u64::from(info.numer);
        i32::try_from(value).map_err(|_| "Native program scheduling period invalid")
    };
    // Four integer fields from THREAD_TIME_CONSTRAINT_POLICY: period,
    // computation, constraint and preemptible. The loop sleeps between work,
    // drains bounded queues, and never performs network requests.
    let policy = [ticks(10_000_000)?, ticks(4_000_000)?, ticks(8_000_000)?, 1];
    let thread = unsafe { mach_thread_self() };
    let result = unsafe { thread_policy_set(thread, 2, policy.as_ptr(), 4) };
    unsafe {
        mach_port_deallocate(mach_task_self_, thread);
    }
    if result != 0 {
        return Err("Native program time-constrained scheduling unavailable");
    }
    REALTIME.store(true, Ordering::Release);
    Ok(())
}
/// Use the kernel absolute clock directly instead of the generic relative
/// nanosleep timer used by thread::sleep on macOS.
fn wait_publisher_tick() -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    {
        static TIMEBASE: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
        let &(numer, denom) = TIMEBASE.get_or_init(|| {
            let mut info = MachTimebase { numer: 0, denom: 0 };
            if unsafe { mach_timebase_info(&mut info) } != 0 {
                return (0, 0);
            }
            (info.numer, info.denom)
        });
        if numer == 0 || denom == 0 {
            return Err("Native program clock setup failed");
        }
        let ticks = 1_000_000u64 * u64::from(denom) / u64::from(numer);
        let deadline = unsafe { mach_absolute_time() }
            .checked_add(ticks)
            .ok_or("Native program clock overflow")?;
        // Interrupts are harmless: the loop checks authority and due frames again.
        unsafe {
            mach_wait_until(deadline);
        }
    }
    #[cfg(not(target_os = "macos"))]
    thread::sleep(Duration::from_millis(1));
    Ok(())
}
struct Picture {
    timestamp: u64,
    planes: (Vec<u8>, Vec<u8>, Vec<u8>),
}
#[derive(Clone, Copy)]
struct AudioCapture {
    timestamp: u64,
    received_at: u64,
    frames: usize,
    samples: [i16; 4096],
}
// OBS serializes this tap's audio callback on its single audio-output thread.
// The publisher is the only consumer. A slot becomes visible only AFTER the
// entire PCM copy, so preempting a producer cannot make the real-time consumer
// spin waiting for an incomplete reservation. Both methods have bounded work.
struct AudioCaptureQueue {
    slots:
        Box<[std::cell::UnsafeCell<std::mem::MaybeUninit<AudioCapture>>; CAPTURE_AUDIO_BLOCKS + 1]>,
    read: AtomicUsize,
    write: AtomicUsize,
    reader_busy: AtomicBool,
    writer_busy: AtomicBool,
}
// SAFETY: only the OBS callback writes slots; only the publisher reads slots.
// Non-waiting ownership guards serialize accidental concurrent callers too.
// Release/Acquire indices hand off initialized slots and prevent reuse until
// the reader finishes copying. Tap disconnect quiesces callbacks before drop.
unsafe impl Sync for AudioCaptureQueue {}
struct QueueOwnership<'a>(&'a AtomicBool);
impl Drop for QueueOwnership<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl AudioCaptureQueue {
    fn new() -> Self {
        Self {
            slots: Box::new(std::array::from_fn(|_| {
                std::cell::UnsafeCell::new(std::mem::MaybeUninit::uninit())
            })),
            read: AtomicUsize::new(0),
            write: AtomicUsize::new(0),
            reader_busy: AtomicBool::new(false),
            writer_busy: AtomicBool::new(false),
        }
    }
    fn try_push(&self, frame: AudioCapture) -> bool {
        self.push_with(frame, || {})
    }
    fn push_with(&self, frame: AudioCapture, before_publish: impl FnOnce()) -> bool {
        if self
            .writer_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return false;
        }
        let _guard = QueueOwnership(&self.writer_busy);
        let write = self.write.load(Ordering::Relaxed);
        let next = (write + 1) % self.slots.len();
        if next == self.read.load(Ordering::Acquire) {
            return false;
        }
        // SAFETY: sole producer, and this slot is outside the reader's owned
        // interval until the completed payload is published below.
        unsafe {
            (*self.slots[write].get()).write(frame);
        }
        before_publish();
        self.write.store(next, Ordering::Release);
        true
    }
    fn try_pop(&self) -> Option<AudioCapture> {
        if self
            .reader_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return None;
        }
        let _guard = QueueOwnership(&self.reader_busy);
        let read = self.read.load(Ordering::Relaxed);
        if read == self.write.load(Ordering::Acquire) {
            return None;
        }
        // SAFETY: the acquired index proves initialization. The producer cannot
        // reuse this slot until the copy completes and the read index advances.
        let frame = unsafe { (*self.slots[read].get()).assume_init_read() };
        self.read
            .store((read + 1) % self.slots.len(), Ordering::Release);
        Some(frame)
    }
}
#[derive(Default)]
struct Queues {
    audio: VecDeque<AudioCapture>,
    video: VecDeque<Picture>,
}
/// A slow video SDK call must never hold the audio publication clock.
/// Capacity one bounds pending video; the worker drops late pictures.
struct VideoLane {
    sender: Option<SyncSender<Picture>>,
    worker: Option<JoinHandle<Result<(), &'static str>>>,
    capture_worker: Option<JoinHandle<Result<(), &'static str>>>,
    audio_ready: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}
impl VideoLane {
    fn start(sources: Sources) -> Result<Self, &'static str> {
        Self::start_with(move |frame| {
            sources.video(
                (&frame.planes.0, &frame.planes.1, &frame.planes.2),
                frame.timestamp,
            )
        })
    }
    fn start_with(
        mut publish: impl FnMut(Picture) -> Result<bool, &'static str> + Send + 'static,
    ) -> Result<Self, &'static str> {
        let (sender, receiver) = sync_channel::<Picture>(1);
        let failed = Arc::new(AtomicBool::new(false));
        let fault = failed.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = thread::Builder::new()
            .name("rtc-program-video".into())
            .spawn(move || {
                #[cfg(debug_assertions)]
                let inject_video = std::env::var("PRODUCER_RTC_PROGRAM_PROOF").as_deref()
                    == Ok("1")
                    && std::env::var("PRODUCER_RTC_VIDEO_DELAY_PROOF").as_deref() == Ok("1");
                while let Ok(frame) = receiver.recv() {
                    #[cfg(debug_assertions)]
                    if inject_video
                        && AUDIO_SUBMITTED.load(Ordering::Acquire) > 1500
                        && !VIDEO_INJECTED.swap(true, Ordering::AcqRel)
                    {
                        thread::sleep(Duration::from_millis(120));
                    }
                    if stopped.load(Ordering::Acquire) {
                        break;
                    }
                    let now = unsafe { os_gettime_ns() };
                    let Some(due) = frame.timestamp.checked_add(LEAD_NS) else {
                        fault.store(true, Ordering::Release);
                        return Err("Native program video timestamp overflow");
                    };
                    if now.saturating_sub(due) > MAX_LATE_NS {
                        continue;
                    }
                    let call = std::time::Instant::now();
                    let result = publish(frame);
                    MAX_VIDEO_CALL.fetch_max(call.elapsed().as_micros() as u64, Ordering::Relaxed);
                    match result {
                        Ok(true) => {
                            VIDEO_SUBMITTED.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(false) => {}
                        Err(error) => {
                            fault.store(true, Ordering::Release);
                            return Err(error);
                        }
                    }
                }
                Ok(())
            })
            .map_err(|_| "Native program video worker creation failed")?;
        Ok(Self {
            sender: Some(sender),
            worker: Some(worker),
            capture_worker: None,
            audio_ready: Arc::new(AtomicBool::new(false)),
            failed,
            stop,
        })
    }
    fn capture(&mut self, receiver: Receiver<Picture>) -> Result<(), &'static str> {
        let sender = self
            .sender
            .as_ref()
            .ok_or("Native video lane closed")?
            .clone();
        let stop = self.stop.clone();
        let failed = self.failed.clone();
        let audio_ready = self.audio_ready.clone();
        self.capture_worker = Some(
            thread::Builder::new()
                .name("rtc-program-video-capture".into())
                .spawn(move || {
                    let result = (|| {
                        let mut frames = VecDeque::new();
                        let mut last_timestamp = 0;
                        while !stop.load(Ordering::Acquire) {
                            match receiver.recv_timeout(Duration::from_millis(1)) {
                                Ok(frame) => {
                                    if frame.timestamp <= last_timestamp {
                                        return Err("Native program video timestamp regressed");
                                    }
                                    last_timestamp = frame.timestamp;
                                    frames.push_back(frame);
                                    while frames.len() > VIDEO_QUEUE_CAPACITY {
                                        frames.pop_front();
                                    }
                                }
                                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                            }
                            let now = unsafe { os_gettime_ns() };
                            let mut latest = None;
                            while frames.front().is_some_and(|frame: &Picture| {
                                frame.timestamp.saturating_add(LEAD_NS) <= now
                            }) {
                                latest = frames.pop_front();
                            }
                            if let Some(frame) = latest {
                                let due = frame
                                    .timestamp
                                    .checked_add(LEAD_NS)
                                    .ok_or("Native program video timestamp overflow")?;
                                if audio_ready.load(Ordering::Acquire)
                                    && now.saturating_sub(due) <= MAX_LATE_NS
                                    && !stop.load(Ordering::Acquire)
                                {
                                    // Only the video dispatcher handles capture queue locks,
                                    // frame destruction and video backlog. Audio never enters it.
                                    let _ = sender.try_send(frame);
                                }
                            }
                        }
                        Ok(())
                    })();
                    if result.is_err() {
                        failed.store(true, Ordering::Release);
                    }
                    result
                })
                .map_err(|_| "Native video capture worker unavailable")?,
        );
        Ok(())
    }
    fn submit(&self, frame: Picture) -> bool {
        self.sender
            .as_ref()
            .is_some_and(|sender| sender.try_send(frame).is_ok())
    }
    fn close(&mut self) -> Result<(), &'static str> {
        self.stop.store(true, Ordering::Release);
        self.sender.take();
        let capture = self
            .capture_worker
            .take()
            .map(|worker| {
                worker
                    .join()
                    .unwrap_or(Err("Native video capture worker failed"))
            })
            .unwrap_or(Ok(()));
        let publication = self
            .worker
            .take()
            .map(|worker| {
                worker
                    .join()
                    .unwrap_or(Err("Native program video worker failed"))
            })
            .unwrap_or(Ok(()));
        capture.and(publication)
    }
}
impl Drop for VideoLane {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

struct Shared {
    raise_priority: bool,
    priority_attempted: AtomicBool,
    audio: Arc<AudioCaptureQueue>,
    video: SyncSender<Picture>,
    failed: AtomicBool,
    ready: AtomicBool,
}
struct Tap {
    shared: Box<Shared>,
    audio_frames: Arc<AudioCaptureQueue>,
    video_frames: Option<Receiver<Picture>>,
    audio: usize,
    video: usize,
    audio_connected: bool,
    video_connected: bool,
}
extern "C" fn audio_callback(param: *mut c_void, bus: usize, data: *mut ffi::audio_data) {
    if param.is_null() {
        return;
    }
    let shared = unsafe { &*(param as *const Shared) };
    if !shared.ready.load(Ordering::Acquire) {
        return;
    }
    let Some(data) = (unsafe { data.as_ref() }) else {
        CAPTURE_FAULT
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        shared
            .failed
            .store(true, Ordering::Release /* classified */);
        return;
    };
    if bus != 1
        || data.frames == 0
        || data.frames > 4096
        || data.timestamp == 0
        || data.data[0].is_null()
        || data.data[1].is_null()
    {
        CAPTURE_FAULT
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        shared
            .failed
            .store(true, Ordering::Release /* classified */);
        return;
    }
    #[cfg(target_os = "macos")]
    if shared.raise_priority && !shared.priority_attempted.swap(true, Ordering::AcqRel) {
        // This callback executes on OBS's audio-output thread, not the RTC
        // publisher thread. Keep its capture clock responsive too; priority
        // applies only to the explicitly enabled native RTC pilot.
        let success = unsafe { pthread_set_qos_class_self_np(0x21, 0) } == 0;
        CAPTURE_PRIORITY.store(success, Ordering::Release);
        if !success {
            CAPTURE_FAULT
                .compare_exchange(0, 9, Ordering::AcqRel, Ordering::Acquire)
                .ok();
            shared.failed.store(true, Ordering::Release);
            return;
        }
    }
    let received_at = unsafe { os_gettime_ns() };
    #[cfg(debug_assertions)]
    if CAPTURE_GAP_PROOF.load(Ordering::Relaxed) && AUDIO_SUBMITTED.load(Ordering::Relaxed) > 1500 {
        let _ = CAPTURE_GAP_UNTIL.compare_exchange(
            0,
            received_at + 1_300_000_000,
            Ordering::AcqRel,
            Ordering::Relaxed,
        );
        if received_at < CAPTURE_GAP_UNTIL.load(Ordering::Relaxed) {
            return;
        }
    }
    MAX_CALLBACK_AGE.fetch_max(
        received_at.saturating_sub(data.timestamp),
        Ordering::Relaxed,
    );
    // A delayed OBS catch-up burst must not fill the bounded capture queue
    // with PCM whose original publication slots have already elapsed.
    if received_at.saturating_sub(data.timestamp) > LEAD_NS + MAX_LATE_NS {
        CAPTURE_DROPPED.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let (left, right) = unsafe {
        (
            std::slice::from_raw_parts(data.data[0] as *const f32, data.frames as usize),
            std::slice::from_raw_parts(data.data[1] as *const f32, data.frames as usize),
        )
    };
    let mut samples = [0; 4096];
    for (index, (left, right)) in left.iter().zip(right).enumerate() {
        if !left.is_finite() || !right.is_finite() {
            CAPTURE_FAULT
                .compare_exchange(0, 3, Ordering::AcqRel, Ordering::Acquire)
                .ok();
            shared
                .failed
                .store(true, Ordering::Release /* classified */);
            return;
        }
        samples[index] = ((left + right) * 0.5 * 32767.).clamp(-32768., 32767.) as i16;
    }
    if !shared.audio.try_push(AudioCapture {
        timestamp: data.timestamp,
        received_at,
        frames: data.frames as usize,
        samples,
    }) {
        CAPTURE_FAULT
            .compare_exchange(0, 4, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        shared
            .failed
            .store(true, Ordering::Release /* classified */);
    }
}
extern "C" fn video_callback(param: *mut c_void, data: *mut ffi::video_data) {
    if param.is_null() {
        return;
    }
    let shared = unsafe { &*(param as *const Shared) };
    if !shared.ready.load(Ordering::Acquire) {
        return;
    }
    let Some(data) = (unsafe { data.as_ref() }) else {
        CAPTURE_FAULT
            .compare_exchange(0, 5, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        shared
            .failed
            .store(true, Ordering::Release /* classified */);
        return;
    };
    if data.timestamp == 0 {
        CAPTURE_FAULT
            .compare_exchange(0, 6, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        shared
            .failed
            .store(true, Ordering::Release /* classified */);
        return;
    }
    let mut planes = Vec::with_capacity(3);
    for (index, width, height) in [
        (0, WIDTH, HEIGHT),
        (1, WIDTH / 2, HEIGHT / 2),
        (2, WIDTH / 2, HEIGHT / 2),
    ] {
        let stride = data.linesize[index];
        if data.data[index].is_null() || stride < width || stride > 8192 {
            CAPTURE_FAULT
                .compare_exchange(0, 7, Ordering::AcqRel, Ordering::Acquire)
                .ok();
            shared
                .failed
                .store(true, Ordering::Release /* classified */);
            return;
        }
        let mut plane = Vec::with_capacity((width * height) as usize);
        for row in 0..height {
            unsafe {
                plane.extend_from_slice(std::slice::from_raw_parts(
                    data.data[index].add((row * stride) as usize),
                    width as usize,
                ));
            }
        }
        planes.push(plane);
    }
    let picture = Picture {
        timestamp: data.timestamp,
        planes: (planes.remove(0), planes.remove(0), planes.remove(0)),
    };
    if let Err(TrySendError::Disconnected(_)) = shared.video.try_send(picture) {
        CAPTURE_FAULT
            .compare_exchange(0, 8, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        shared
            .failed
            .store(true, Ordering::Release /* classified */);
    }
}
impl Tap {
    fn start() -> Result<Self, &'static str> {
        #[cfg(debug_assertions)]
        CAPTURE_GAP_PROOF.store(
            std::env::var("PRODUCER_RTC_CAPTURE_GAP_PROOF").as_deref() == Ok("1")
                && std::env::var("PRODUCER_RTC_PROGRAM_PROOF").as_deref() == Ok("1"),
            Ordering::Release,
        );
        let audio_sender = Arc::new(AudioCaptureQueue::new());
        let audio_frames = audio_sender.clone();
        let (video_sender, video_frames) = sync_channel(2);
        let mut tap = Self {
            shared: Box::new(Shared {
                audio: audio_sender,
                video: video_sender,
                failed: AtomicBool::new(false),
                ready: AtomicBool::new(false),
                raise_priority: cfg!(target_os = "macos")
                    && (cfg!(feature = "guest-rtc-production") || std::env::var("PRODUCER_RTC_PROGRAM_PILOT").as_deref() == Ok("1")),
                priority_attempted: AtomicBool::new(false),
            }),
            audio_frames,
            video_frames: Some(video_frames),
            audio: unsafe { ffi::obs_get_audio() } as usize,
            video: unsafe { ffi::obs_get_video() } as usize,
            audio_connected: false,
            video_connected: false,
        };
        if tap.audio == 0 || tap.video == 0 {
            return Err("Native program requires the running OBS engine");
        }
        let param = (&*tap.shared as *const Shared).cast_mut().cast();
        let audio = AudioConvert {
            rate: 48000,
            format: 8,
            speakers: 2,
            allow_clipping: false,
        };
        tap.audio_connected =
            unsafe { audio_output_connect(tap.audio as *mut _, 1, &audio, audio_callback, param) };
        if !tap.audio_connected {
            return Err("Native stage audio capture failed");
        }
        let video = VideoScale {
            format: 1,
            width: WIDTH,
            height: HEIGHT,
            range: 1,
            // VP8's default decoded color matrix is BT.601. Match the raw
            // conversion instead of sending unlabelled BT.709 I420 pixels.
            colorspace: 1,
        };
        // The OBS core wrapper activates the main compositor's raw output.
        // Connecting directly to video_output alone does not activate it.
        unsafe {
            ffi::obs_add_raw_video_callback(
                (&video as *const VideoScale).cast(),
                video_callback,
                param,
            );
        }
        tap.video_connected = true;
        Ok(tap)
    }
    fn drain(&self) -> Result<Queues, &'static str> {
        if self.shared.failed.load(Ordering::Acquire) {
            return Err("Native program capture queue or format fault");
        }
        Ok(Queues {
            audio: std::iter::from_fn(|| self.audio_frames.try_pop())
                .take(CAPTURE_AUDIO_BLOCKS)
                .collect(),
            video: self
                .video_frames
                .as_ref()
                .map(|frames| frames.try_iter().take(2).collect())
                .unwrap_or_default(),
        })
    }
}
impl Tap {
    fn disconnect(&mut self) {
        self.shared.ready.store(false, Ordering::Release);
        let param = (&*self.shared as *const Shared).cast_mut().cast();
        unsafe {
            if self.video_connected {
                ffi::obs_remove_raw_video_callback(video_callback, param);
                self.video_connected = false;
            }
            if self.audio_connected {
                audio_output_disconnect(self.audio as *mut _, 1, audio_callback, param);
                self.audio_connected = false;
            }
        }
    }
}
impl Drop for Tap {
    fn drop(&mut self) {
        self.disconnect();
    }
}
fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}
pub struct Publisher {
    stop: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    lease: Arc<AtomicU64>,
    recoverable: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<(), &'static str>>>,
}
impl Publisher {
    pub fn start(sources: Sources, deadline: u64) -> Result<Self, &'static str> {
        let mut tap = Tap::start()?;
        let stop = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let recoverable = Arc::new(AtomicBool::new(false));
        let recovery_fault = recoverable.clone();
        let lease = Arc::new(AtomicU64::new(deadline));
        let (done, fault, expires) = (stop.clone(), failed.clone(), lease.clone());
        let worker = thread::Builder::new()
            .name("native-rtc-program".into())
            .spawn(move || {
                #[cfg(target_os = "macos")]
                if unsafe { pthread_set_qos_class_self_np(0x21, 0) } != 0 {
                    fault.store(true, Ordering::Release);
                    return Err("Native program scheduling setup failed");
                }
                #[cfg(target_os = "macos")]
                if let Err(error) = configure_publisher_schedule() {
                    fault.store(true, Ordering::Release);
                    return Err(error);
                }
                // Both callbacks are registered before accepting a timeline.
                // Audio produced while video registration/thread setup blocks is
                // startup pre-roll, not queued live program audio.
                tap.shared.ready.store(true, Ordering::Release);
                let mut video_lane = VideoLane::start(sources.clone())?;
                video_lane.capture(
                    tap.video_frames
                        .take()
                        .ok_or("Native video capture receiver absent")?,
                )?;
                let result = publish_loop(&tap, &sources, &video_lane, &done, &expires);
                // Retire pending video and join its SDK call before clearing
                // sources or releasing capture callbacks.
                // Quiesce callbacks before retiring their receiving queues.
                // Otherwise an intentional close is misclassified as capture failure.
                tap.disconnect();
                let video_closed = video_lane.close();
                let result = result.and(video_closed);
                sources.clear();
                if result == Err("Native program audio publication deadline missed") {
                    recovery_fault.store(true, Ordering::Release);
                }
                if let Err(error) = result {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "Native program publisher failed: {error}; timing={}",
                        timing()
                    );
                    fault.store(true, Ordering::Release);
                }
                // Tap disconnects both callbacks before its stable userdata dies.
                result
            })
            .map_err(|_| "Native program worker creation failed")?;
        Ok(Self {
            stop,
            failed,
            lease,
            recoverable,
            worker: Some(worker),
        })
    }
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
            || self
                .worker
                .as_ref()
                .is_some_and(|worker| worker.is_finished())
    }
    pub fn recoverable(&self) -> bool {
        self.recoverable.load(Ordering::Acquire)
    }
    pub fn renew(&self, deadline: u64) {
        self.lease.store(deadline, Ordering::Release);
    }
    pub fn close(&mut self) -> Result<(), &'static str> {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "Native program worker failed")??;
        }
        Ok(())
    }
}
impl Drop for Publisher {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_video_sdk_call_cannot_block_audio_lane_and_pending_video_is_retired() {
        let (entered, entered_rx) = sync_channel(1);
        let (release, release_rx) = sync_channel(1);
        let calls = Arc::new(AtomicU64::new(0));
        let observed = calls.clone();
        let mut lane = VideoLane::start_with(move |_| {
            entered.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            observed.fetch_add(1, Ordering::Relaxed);
            Ok(true)
        })
        .unwrap();
        let frame = || Picture {
            timestamp: unsafe { os_gettime_ns() },
            planes: (vec![], vec![], vec![]),
        };
        assert!(lane.submit(frame()));
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(lane.submit(frame()));
        // The third picture is discarded immediately while the SDK callback
        // is deliberately held. The audio publisher never waits for this lane.
        assert!(!lane.submit(frame()));
        lane.stop.store(true, Ordering::Release);
        release.send(()).unwrap();
        lane.close().unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn captured_video_waits_for_audio_and_capture_worker_joins_on_close() {
        let (published, observed) = sync_channel(2);
        let mut lane = VideoLane::start_with(move |_| {
            published.send(()).unwrap();
            Ok(true)
        })
        .unwrap();
        let (capture, receiver) = sync_channel(2);
        lane.capture(receiver).unwrap();
        let frame = || Picture {
            timestamp: unsafe { os_gettime_ns() }.saturating_sub(LEAD_NS),
            planes: (vec![], vec![], vec![]),
        };
        capture.send(frame()).unwrap();
        assert!(
            observed.recv_timeout(Duration::from_millis(40)).is_err(),
            "Video published before the audio timeline started"
        );
        lane.audio_ready.store(true, Ordering::Release);
        capture.send(frame()).unwrap();
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        lane.close().unwrap();
        assert!(lane.capture_worker.is_none());
        assert!(lane.worker.is_none());
        assert!(capture.send(frame()).is_err());
    }
    #[test]
    fn preempted_capture_producer_never_makes_audio_consumer_wait() {
        let queue = Arc::new(AudioCaptureQueue::new());
        let producer = queue.clone();
        let (entered, checkpoint) = sync_channel(1);
        let (release, resume) = sync_channel(1);
        let worker = thread::spawn(move || {
            assert!(producer.push_with(
                AudioCapture {
                    timestamp: 42,
                    received_at: 43,
                    frames: 480,
                    samples: [7; 4096]
                },
                || {
                    entered.send(()).unwrap();
                    resume.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            ));
        });
        checkpoint.recv_timeout(Duration::from_secs(5)).unwrap();
        let consumer = queue.clone();
        let (finished, result) = sync_channel(1);
        let reader = thread::spawn(move || {
            finished.send(consumer.try_pop().is_none()).unwrap();
        });
        assert!(
            result.recv_timeout(Duration::from_secs(2)).unwrap(),
            "Consumer waited behind an unfinished producer slot"
        );
        release.send(()).unwrap();
        worker.join().unwrap();
        reader.join().unwrap();
        let frame = queue.try_pop().unwrap();
        assert_eq!(frame.timestamp, 42);
        assert_eq!(frame.frames, 480);
        assert!(frame.samples[..480].iter().all(|sample| *sample == 7));
        assert!(queue.try_pop().is_none());
    }
    #[test]
    fn capture_ring_preserves_pcm_and_order_across_concurrent_wraparound() {
        let queue = Arc::new(AudioCaptureQueue::new());
        let producer = queue.clone();
        let worker = thread::spawn(move || {
            for sequence in 1..=1000 {
                let frame = AudioCapture {
                    timestamp: sequence,
                    received_at: sequence + 1,
                    frames: 1024,
                    samples: [sequence as i16; 4096],
                };
                while !producer.try_push(frame) {
                    thread::yield_now();
                }
            }
        });
        for sequence in 1..=1000 {
            let frame = loop {
                if let Some(frame) = queue.try_pop() {
                    break frame;
                }
                thread::yield_now();
            };
            assert_eq!(frame.timestamp, sequence);
            assert_eq!(frame.received_at, sequence + 1);
            assert!(frame.samples[..1024]
                .iter()
                .all(|sample| *sample == sequence as i16));
        }
        worker.join().unwrap();
        assert!(queue.try_pop().is_none());
    }
    #[test]
    fn audio_capture_accepts_a_burst_within_the_program_latency_budget() {
        let sender = Arc::new(AudioCaptureQueue::new());
        let receiver = sender.clone();
        let (video, _) = sync_channel(2);
        let shared = Shared {
            audio: sender,
            video,
            failed: AtomicBool::new(false),
            ready: AtomicBool::new(true),
            raise_priority: false,
            priority_attempted: AtomicBool::new(false),
        };
        let mut left = [0.25f32; 1024];
        let mut right = [0.25f32; 1024];
        let mut data = ffi::audio_data {
            data: [std::ptr::null_mut(); 8],
            frames: 1024,
            timestamp: unsafe { os_gettime_ns() },
        };
        data.data[0] = left.as_mut_ptr().cast();
        data.data[1] = right.as_mut_ptr().cast();
        // Nineteen OBS blocks cover 405 ms, within the 400 ms lead plus 20 ms
        // late cutoff. Callback catch-up can deliver this as a single burst.
        for _ in 0..19 {
            audio_callback((&shared as *const Shared).cast_mut().cast(), 1, &mut data);
            data.timestamp += 21_333_333;
        }
        assert!(
            !shared.failed.load(Ordering::Acquire),
            "Valid OBS callback burst overflowed the capture queue"
        );
        let blocks: Vec<_> = std::iter::from_fn(|| receiver.try_pop()).collect();
        assert_eq!(blocks.len(), 19);
        assert!(blocks.iter().all(|frame| frame.frames == 1024
            && frame.samples[..frame.frames]
                .iter()
                .all(|sample| *sample == 8191)));
    }
    #[test]
    fn audio_capture_still_fails_closed_on_excessive_backlog() {
        let sender = Arc::new(AudioCaptureQueue::new());
        let (video, _) = sync_channel(2);
        let shared = Shared {
            audio: sender,
            video,
            failed: AtomicBool::new(false),
            ready: AtomicBool::new(true),
            raise_priority: false,
            priority_attempted: AtomicBool::new(false),
        };
        let mut plane = [0.0f32; 1024];
        let mut data = ffi::audio_data {
            data: [std::ptr::null_mut(); 8],
            frames: 1024,
            timestamp: unsafe { os_gettime_ns() },
        };
        data.data[0] = plane.as_mut_ptr().cast();
        data.data[1] = plane.as_mut_ptr().cast();
        for _ in 0..100 {
            audio_callback((&shared as *const Shared).cast_mut().cast(), 1, &mut data);
            data.timestamp += 21_333_333;
        }
        assert!(shared.failed.load(Ordering::Acquire));
    }
    #[test]
    fn capture_gap_keeps_cadence_discards_backlog_and_recovers_without_replay() {
        let began = 1_000_000_000;
        let mut timeline = AudioTimeline::default();
        let mut queue = VecDeque::from([(began, [7; 480])]);
        assert_eq!(
            timeline.next(began, &mut queue).unwrap().unwrap(),
            (began, [7; 480], false)
        );
        for tick in 1..=130 {
            let at = began + tick * 10_000_000;
            let (due, block, silence) = timeline.next(at, &mut queue).unwrap().unwrap();
            assert_eq!(due, at);
            assert!(silence);
            assert_eq!(block, [0; 480]);
        }
        let recovered = began + 131 * 10_000_000;
        // Simulate delayed PCM plus fresh PCM after a 1.3 second capture stall.
        queue.push_back((began + 10_000_000, [99; 480]));
        queue.push_back((recovered, [11; 480]));
        assert_eq!(
            timeline.next(recovered, &mut queue).unwrap().unwrap(),
            (recovered, [11; 480], false)
        );
        assert!(queue.is_empty());
        assert_eq!(timeline.missing, 0);
    }
    #[test]
    fn prolonged_capture_loss_and_publisher_clock_stalls_remain_bounded() {
        let began = 1_000_000_000;
        let mut queue = VecDeque::from([(began, [7; 480])]);
        let mut timeline = AudioTimeline::default();
        timeline.next(began, &mut queue).unwrap();
        for tick in 1..=300 {
            timeline
                .next(began + tick * 10_000_000, &mut queue)
                .unwrap();
        }
        assert_eq!(
            timeline.next(began + 301 * 10_000_000, &mut queue),
            Err("Native program audio capture remained absent")
        );
        let mut timeline = AudioTimeline::default();
        let mut queue = VecDeque::from([(began, [7; 480])]);
        timeline.next(began, &mut queue).unwrap();
        assert_eq!(
            timeline.next(began + 40_000_000, &mut queue),
            Err("Native program audio publication deadline missed")
        );
    }
    #[test]
    #[ignore = "requires the bundled native engine and graphics device"]
    fn obs_program_tap_copies_timestamped_video_and_stage_audio_then_disconnects() {
        super::tap_selftest();
    }
}
#[cfg(debug_assertions)]
pub fn tap_selftest() {
    let temp = std::env::temp_dir().join(format!("producer-program-tap-{}", std::process::id()));
    super::engine::bootstrap_with_config(&temp);
    let mut graph = super::graph::SceneGraph::create().unwrap();
    graph
        .add_extra(
            "program-tap-color",
            "Synthetic program",
            &super::graph::ExtraSpec::Color {
                color: "#ff0000".into(),
            },
        )
        .unwrap();
    graph
        .set_transform(
            "program-tap-color",
            &super::graph::TransformPatch {
                x: Some(0.),
                y: Some(0.),
                w: Some(1920.),
                h: Some(1080.),
                visible: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    let tap = Tap::start().unwrap();
    tap.shared.ready.store(true, Ordering::Release);
    let until = std::time::Instant::now() + Duration::from_secs(2);
    let (mut audio, mut video, mut audio_timestamp, mut video_timestamp) = (0, 0, 0, 0);
    while std::time::Instant::now() < until {
        let queues = tap.drain().unwrap();
        for frame in queues.audio {
            assert!(frame.timestamp > audio_timestamp && frame.frames > 0);
            audio_timestamp = frame.timestamp;
            audio += 1;
        }
        for picture in queues.video {
            assert!(picture.timestamp > video_timestamp);
            video_timestamp = picture.timestamp;
            video += 1;
            assert_eq!(picture.planes.0.len(), (WIDTH * HEIGHT) as usize);
            assert_eq!(picture.planes.1.len(), (WIDTH * HEIGHT / 4) as usize);
            assert_eq!(picture.planes.2.len(), picture.planes.1.len());
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        audio >= 20 && video >= 10,
        "Program callbacks absent: audio={audio}, video={video}"
    );
    drop(tap);
    // SceneGraph is engine-owned and has no Drop teardown. Explicitly
    // release its sources before forcing global shutdown in this fixture.
    graph.clear_room().unwrap();
    unsafe {
        ffi::obs_shutdown();
    }
    println!(
        "{}",
        serde_json::json!({"passed":true,"audio_blocks":audio,"video_frames":video})
    );
    let _ = std::fs::remove_dir_all(temp);
}

// Preserve one 10 ms RTP cadence even when OBS capture pauses. Late PCM is
// discarded; missing slots carry silence, and recovered PCM keeps its original
// position within 5 ms of the established timeline. Never replay a backlog.
#[derive(Default)]
struct AudioTimeline {
    next_due: Option<u64>,
    missing: u32,
}
impl AudioTimeline {
    fn next(
        &mut self,
        now: u64,
        audio: &mut VecDeque<(u64, [i16; 480])>,
    ) -> Result<Option<(u64, [i16; 480], bool)>, &'static str> {
        if self.next_due.is_none() {
            while audio
                .front()
                .is_some_and(|(due, _)| now.saturating_sub(*due) > MAX_LATE_NS)
            {
                audio.pop_front();
                STARTUP_DROPPED.fetch_add(1, Ordering::Relaxed);
            }
            self.next_due = audio.front().map(|(due, _)| *due);
        }
        let Some(due) = self.next_due else {
            return Ok(None);
        };
        if now < due {
            return Ok(None);
        }
        MAX_AUDIO_LATE.fetch_max(now - due, Ordering::Relaxed);
        if now - due > MAX_LATE_NS {
            return Err("Native program audio publication deadline missed");
        }
        while audio
            .front()
            .is_some_and(|(at, _)| at.saturating_add(5_000_000) < due)
        {
            audio.pop_front();
            CAPTURE_DROPPED.fetch_add(1, Ordering::Relaxed);
        }
        let present = audio
            .front()
            .is_some_and(|(at, _)| *at <= due.saturating_add(5_000_000));
        let block = if present {
            audio.pop_front().unwrap().1
        } else {
            [0; 480]
        };
        self.missing = if present { 0 } else { self.missing + 1 };
        // Short capture stalls retain the owned media session. A capture that
        // stays absent for three seconds still fails closed, rather than hiding
        // a permanently broken audio device behind unbounded silence.
        if self.missing > 300 {
            return Err("Native program audio capture remained absent");
        }
        self.next_due = Some(
            due.checked_add(10_000_000)
                .ok_or("Native program timestamp overflow")?,
        );
        Ok(Some((due, block, !present)))
    }
}

fn publish_loop(
    tap: &Tap,
    sources: &Sources,
    video_lane: &VideoLane,
    stop: &AtomicBool,
    lease: &AtomicU64,
) -> Result<(), &'static str> {
    let startup_deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut carry = VecDeque::with_capacity(4096 + 480);
    let mut carry_at = 0;
    let mut audio_end = None;
    let mut audio = VecDeque::<(u64, [i16; 480])>::with_capacity(64);
    let mut last_audio = None;
    let mut timeline = AudioTimeline::default();
    let mut last_loop = unsafe { os_gettime_ns() };
    #[cfg(debug_assertions)]
    let delay_proof = std::env::var("PRODUCER_RTC_PROGRAM_DELAY_PROOF").as_deref() == Ok("1")
        && std::env::var("PRODUCER_RTC_PROGRAM_PROOF").as_deref() == Ok("1");
    while !stop.load(Ordering::Acquire) {
        #[cfg(debug_assertions)]
        if delay_proof
            && AUDIO_SUBMITTED.load(Ordering::Acquire) > 1500
            && !INJECTED.swap(true, Ordering::AcqRel)
        {
            thread::sleep(Duration::from_millis(120));
        }
        if video_lane.failed.load(Ordering::Acquire) {
            return Err("Native program video publication stopped");
        }
        if wall_ms() >= lease.load(Ordering::Acquire) {
            return Err("Native program lease expired");
        }
        let loop_now = unsafe { os_gettime_ns() };
        MAX_LOOP_GAP.fetch_max(loop_now.saturating_sub(last_loop), Ordering::Relaxed);
        last_loop = loop_now;
        if tap.shared.failed.load(Ordering::Acquire) {
            return Err("Native program capture queue or format fault");
        }
        // The audio worker consumes inline fixed-size PCM directly. It never
        // allocates a callback batch or frees an OBS-owned PCM vector.
        for frame in std::iter::from_fn(|| tap.audio_frames.try_pop()).take(CAPTURE_AUDIO_BLOCKS) {
            let AudioCapture {
                timestamp,
                received_at,
                frames,
                samples,
            } = frame;
            MAX_CAPTURE_QUEUE_WAIT
                .fetch_max(loop_now.saturating_sub(received_at), Ordering::Relaxed);
            MAX_CAPTURE_AGE.fetch_max(loop_now.saturating_sub(timestamp), Ordering::Relaxed);
            if let Some(end) = audio_end {
                if timestamp + 2_000_000 < end {
                    return Err("Native program audio timestamp discontinuity");
                }
                if timestamp > end + 2_000_000 {
                    // Forward gaps follow discarded stale capture. Do not splice
                    // the remaining partial old block into fresh PCM.
                    carry.clear();
                }
            }
            audio_end = Some(
                timestamp
                    .checked_add(frames as u64 * 1_000_000_000 / 48000)
                    .ok_or("Native program timestamp overflow")?,
            );
            if carry.is_empty() {
                carry_at = timestamp;
            }
            carry.extend(samples[..frames].iter().copied());
            while carry.len() >= 480 {
                if audio.len() >= 64 {
                    return Err("Native program audio publication queue overflow");
                }
                let mut block = [0; 480];
                for sample in &mut block {
                    *sample = carry.pop_front().unwrap();
                }
                audio.push_back((
                    carry_at
                        .checked_add(LEAD_NS)
                        .ok_or("Native program timestamp overflow")?,
                    block,
                ));
                carry_at += 10_000_000;
            }
        }
        let now = unsafe { os_gettime_ns() };
        if timeline.next_due.is_none() && std::time::Instant::now() >= startup_deadline {
            return Err("Native program audio startup remained stale");
        }
        if last_audio.is_none_or(|last| now - last >= 8_000_000) {
            if let Some((due, block, silence)) =
                timeline.next(now, &mut audio).map_err(|error| {
                    MAX_WORK.fetch_max(
                        unsafe { os_gettime_ns() }.saturating_sub(loop_now),
                        Ordering::Relaxed,
                    );
                    error
                })?
            {
                MAX_AUDIO_LATE.fetch_max(now - due, Ordering::Relaxed);
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let call = std::time::Instant::now();
                sources.audio(&block)?;
                MAX_AUDIO_CALL.fetch_max(call.elapsed().as_micros() as u64, Ordering::Relaxed);
                if let Some(last) = last_audio {
                    MIN_AUDIO_SPACING.fetch_min(now - last, Ordering::Relaxed);
                }
                AUDIO_SUBMITTED.fetch_add(1, Ordering::Relaxed);
                if silence {
                    SILENCE_SUBMITTED.fetch_add(1, Ordering::Relaxed);
                }
                last_audio = Some(now);
                video_lane.audio_ready.store(true, Ordering::Release);
            }
        }
        MAX_WORK.fetch_max(
            unsafe { os_gettime_ns() }.saturating_sub(loop_now),
            Ordering::Relaxed,
        );
        wait_publisher_tick()?;
    }
    Ok(())
}
