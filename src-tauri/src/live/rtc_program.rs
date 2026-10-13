//! Opt-in OBS program publication. Callbacks only copy into bounded queues.
//! Stage bus 1 excludes remote voices; this is not a substitute for host AEC.
use super::ffi;
use producer_guest_runtime::program::{Sources, HEIGHT, WIDTH};
use std::{
    collections::VecDeque,
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// Leave scheduling headroom while retaining the strict stale-audio cutoff.
const LEAD_NS: u64 = 120_000_000;
const MAX_LATE_NS: u64 = 20_000_000;
static RECOVERIES: AtomicU64 = AtomicU64::new(0);
#[cfg(debug_assertions)]
static INJECTED: AtomicBool = AtomicBool::new(false);
static AUDIO_SUBMITTED: AtomicU64 = AtomicU64::new(0);
static VIDEO_SUBMITTED: AtomicU64 = AtomicU64::new(0);
static MAX_AUDIO_LATE: AtomicU64 = AtomicU64::new(0);
static MIN_AUDIO_SPACING: AtomicU64 = AtomicU64::new(u64::MAX);
static MAX_AUDIO_CALL: AtomicU64 = AtomicU64::new(0);
static MAX_VIDEO_CALL: AtomicU64 = AtomicU64::new(0);
pub fn note_recovery() {
    RECOVERIES.fetch_add(1, Ordering::Relaxed);
}
pub fn reset_diagnostics() {
    RECOVERIES.store(0, Ordering::Release);
    #[cfg(debug_assertions)]
    INJECTED.store(false, Ordering::Release);
    AUDIO_SUBMITTED.store(0, Ordering::Release);
    VIDEO_SUBMITTED.store(0, Ordering::Release);
    MAX_AUDIO_LATE.store(0, Ordering::Release);
    MIN_AUDIO_SPACING.store(u64::MAX, Ordering::Release);
    MAX_AUDIO_CALL.store(0, Ordering::Release);
    MAX_VIDEO_CALL.store(0, Ordering::Release);
}
pub fn counts() -> (u64, u64) {
    (
        AUDIO_SUBMITTED.load(Ordering::Acquire),
        VIDEO_SUBMITTED.load(Ordering::Acquire),
    )
}
pub fn timing() -> serde_json::Value {
    let spacing = MIN_AUDIO_SPACING.load(Ordering::Acquire);
    serde_json::json!({"publisher_recoveries":RECOVERIES.load(Ordering::Acquire),"maximum_audio_late_us":MAX_AUDIO_LATE.load(Ordering::Acquire)/1000,"minimum_audio_spacing_us":(spacing!=u64::MAX).then_some(spacing/1000),"maximum_audio_call_us":MAX_AUDIO_CALL.load(Ordering::Acquire),"maximum_video_call_us":MAX_VIDEO_CALL.load(Ordering::Acquire)})
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
}
struct Picture {
    timestamp: u64,
    planes: (Vec<u8>, Vec<u8>, Vec<u8>),
}
#[derive(Default)]
struct Queues {
    audio: VecDeque<(u64, Vec<i16>)>,
    video: VecDeque<Picture>,
}
struct Shared {
    audio: SyncSender<(u64, Vec<i16>)>,
    video: SyncSender<Picture>,
    failed: AtomicBool,
}
struct Tap {
    shared: Box<Shared>,
    audio_frames: Receiver<(u64, Vec<i16>)>,
    video_frames: Receiver<Picture>,
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
    let Some(data) = (unsafe { data.as_ref() }) else {
        shared.failed.store(true, Ordering::Release);
        return;
    };
    if bus != 1
        || data.frames == 0
        || data.frames > 4096
        || data.timestamp == 0
        || data.data[0].is_null()
        || data.data[1].is_null()
    {
        shared.failed.store(true, Ordering::Release);
        return;
    }
    let (left, right) = unsafe {
        (
            std::slice::from_raw_parts(data.data[0] as *const f32, data.frames as usize),
            std::slice::from_raw_parts(data.data[1] as *const f32, data.frames as usize),
        )
    };
    let mut samples = Vec::with_capacity(left.len());
    for (left, right) in left.iter().zip(right) {
        if !left.is_finite() || !right.is_finite() {
            shared.failed.store(true, Ordering::Release);
            return;
        }
        samples.push(((left + right) * 0.5 * 32767.).clamp(-32768., 32767.) as i16);
    }
    if shared.audio.try_send((data.timestamp, samples)).is_err() {
        shared.failed.store(true, Ordering::Release);
    }
}
extern "C" fn video_callback(param: *mut c_void, data: *mut ffi::video_data) {
    if param.is_null() {
        return;
    }
    let shared = unsafe { &*(param as *const Shared) };
    let Some(data) = (unsafe { data.as_ref() }) else {
        shared.failed.store(true, Ordering::Release);
        return;
    };
    if data.timestamp == 0 {
        shared.failed.store(true, Ordering::Release);
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
            shared.failed.store(true, Ordering::Release);
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
        shared.failed.store(true, Ordering::Release);
    }
}
impl Tap {
    fn start() -> Result<Self, &'static str> {
        let (audio_sender, audio_frames) = sync_channel(8);
        let (video_sender, video_frames) = sync_channel(2);
        let mut tap = Self {
            shared: Box::new(Shared {
                audio: audio_sender,
                video: video_sender,
                failed: AtomicBool::new(false),
            }),
            audio_frames,
            video_frames,
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
            audio: self.audio_frames.try_iter().take(8).collect(),
            video: self.video_frames.try_iter().take(2).collect(),
        })
    }
}
impl Drop for Tap {
    fn drop(&mut self) {
        let param = (&*self.shared as *const Shared).cast_mut().cast();
        unsafe {
            if self.video_connected {
                ffi::obs_remove_raw_video_callback(video_callback, param);
            }
            if self.audio_connected {
                audio_output_disconnect(self.audio as *mut _, 1, audio_callback, param);
            }
        }
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
        let tap = Tap::start()?;
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
                let result = publish_loop(&tap, &sources, &done, &expires);
                sources.clear();
                if result == Err("Native program audio publication deadline missed") {
                    recovery_fault.store(true, Ordering::Release);
                }
                if result.is_err() {
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
    #[ignore = "requires the bundled native engine and graphics device"]
    fn obs_program_tap_copies_timestamped_video_and_stage_audio_then_disconnects() {
        let temp =
            std::env::temp_dir().join(format!("producer-program-tap-{}", std::process::id()));
        super::super::engine::bootstrap_with_config(&temp);
        let mut graph = super::super::graph::SceneGraph::create().unwrap();
        graph
            .add_extra(
                "program-tap-color",
                "Synthetic program",
                &super::super::graph::ExtraSpec::Color {
                    color: "#ff0000".into(),
                },
            )
            .unwrap();
        graph
            .set_transform(
                "program-tap-color",
                &super::super::graph::TransformPatch {
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
        let until = std::time::Instant::now() + Duration::from_secs(2);
        let (mut audio, mut video, mut audio_timestamp, mut video_timestamp) = (0, 0, 0, 0);
        while std::time::Instant::now() < until {
            let queues = tap.drain().unwrap();
            for (timestamp, samples) in queues.audio {
                assert!(timestamp > audio_timestamp && !samples.is_empty());
                audio_timestamp = timestamp;
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
    }
}
fn publish_loop(
    tap: &Tap,
    sources: &Sources,
    stop: &AtomicBool,
    lease: &AtomicU64,
) -> Result<(), &'static str> {
    let mut carry = VecDeque::new();
    let mut carry_at = 0;
    let mut audio_end = None;
    let mut audio = VecDeque::<(u64, [i16; 480])>::new();
    let mut video = VecDeque::<Picture>::new();
    let mut last_audio = None;
    let mut last_video = 0;
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
        if wall_ms() >= lease.load(Ordering::Acquire) {
            return Err("Native program lease expired");
        }
        let mut captured = tap.drain()?;
        for (timestamp, samples) in captured.audio.drain(..) {
            if audio_end.is_some_and(|end: u64| timestamp.abs_diff(end) > 2_000_000) {
                return Err("Native program audio timestamp discontinuity");
            }
            audio_end = Some(
                timestamp
                    .checked_add(samples.len() as u64 * 1_000_000_000 / 48000)
                    .ok_or("Native program timestamp overflow")?,
            );
            if carry.is_empty() {
                carry_at = timestamp;
            }
            carry.extend(samples);
            while carry.len() >= 480 {
                if audio.len() >= 32 {
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
        for frame in captured.video.drain(..) {
            if frame.timestamp <= last_video {
                return Err("Native program video timestamp regressed");
            }
            last_video = frame.timestamp;
            video.push_back(frame);
            while video.len() > 4 {
                video.pop_front();
            }
        }
        let now = unsafe { os_gettime_ns() };
        if audio.front().is_some_and(|(due, _)| *due <= now)
            && last_audio.is_none_or(|last| now - last >= 8_000_000)
        {
            let (due, block) = audio.pop_front().unwrap();
            MAX_AUDIO_LATE.fetch_max(now - due, Ordering::Relaxed);
            if now - due > MAX_LATE_NS {
                return Err("Native program audio publication deadline missed");
            }
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
            last_audio = Some(now);
        }
        let mut latest = None;
        while video.front().is_some_and(|frame| {
            frame
                .timestamp
                .checked_add(LEAD_NS)
                .is_some_and(|due| due <= now)
        }) {
            latest = video.pop_front();
        }
        if let Some(frame) = latest {
            if now - (frame.timestamp + LEAD_NS) <= MAX_LATE_NS && !stop.load(Ordering::Acquire) {
                let call = std::time::Instant::now();
                if sources.video(
                    (&frame.planes.0, &frame.planes.1, &frame.planes.2),
                    frame.timestamp,
                )? {
                    VIDEO_SUBMITTED.fetch_add(1, Ordering::Relaxed);
                }
                MAX_VIDEO_CALL.fetch_max(call.elapsed().as_micros() as u64, Ordering::Relaxed);
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}
