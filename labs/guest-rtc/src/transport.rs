#[cfg(feature = "obs-proof")]
#[path = "playback_worker.rs"]
mod playback_worker;
use crate::queue::{Captured, Queue};
use anyhow::{bail, Context, Result};
use cxx::{SharedPtr, UniquePtr};
use livekit::{
    options::TrackPublishOptions,
    prelude::*,
    webrtc::{
        audio_source::native::NativeAudioSource, native::new_video_frame_buffer, prelude::*,
        video_source::native::NativeVideoSource,
    },
};
use serde_json::json;
use std::{
    borrow::Cow,
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use webrtc_sys::{audio_track as audio_sys, video_frame as frame_sys, video_track as video_sys};

enum TimingSnapshot {
    Raw(serde_json::Value),
    #[cfg(feature = "obs-proof")]
    Prepared(Vec<crate::sender_clock::SenderReport>),
}
#[derive(Clone)]
struct AudioBlock {
    samples: [i16; 480],
    first_sample: u64,
    capture_timestamp_ms: Option<i64>,
    resampled: bool,
}
struct AudioObserver {
    queue: Arc<Queue<AudioBlock>>,
    #[cfg(feature = "physical-aec")]
    monitor: Option<(Arc<crate::guest_monitor::Monitor>, u64)>,
    sample_count: AtomicU64,
    bad_format: AtomicU64,
    #[cfg(feature = "obs-proof")]
    ingest_queue: Option<Arc<Queue<AudioBlock>>>,
}
impl audio_sys::AudioSink for AudioObserver {
    fn on_data(&self, data: &[i16], rate: i32, channels: usize, frames: usize) {
        self.on_timed_data(
            data,
            rate,
            channels,
            frames,
            audio_sys::ffi::AudioCaptureTiming {
                has_capture_timestamp: false,
                capture_timestamp_ms: 0,
                resampled: false,
            },
        );
    }
    fn on_timed_data(
        &self,
        data: &[i16],
        rate: i32,
        channels: usize,
        frames: usize,
        timing: audio_sys::ffi::AudioCaptureTiming,
    ) {
        let at = Instant::now();
        if rate != 48000 || channels != 1 || frames != 480 || data.len() != 480 {
            self.bad_format.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let first_sample = self
            .sample_count
            .fetch_add(frames as u64, Ordering::Relaxed);
        let value = AudioBlock {
            samples: data.try_into().expect("validated 10ms audio layout"),
            first_sample,
            capture_timestamp_ms: timing
                .has_capture_timestamp
                .then_some(timing.capture_timestamp_ms),
            resampled: timing.resampled,
        };
        #[cfg(feature = "obs-proof")]
        if let Some(queue) = &self.ingest_queue {
            queue.push(Captured {
                at,
                value: value.clone(),
            });
        }
        #[cfg(feature = "physical-aec")]
        if let Some((monitor, generation)) = &self.monitor {
            monitor.push(*generation, value.samples, at);
        }
        self.queue.push(Captured { at, value });
    }
}
struct AudioTap {
    registered: bool,
    sid: String,
    track: SharedPtr<audio_sys::ffi::AudioTrack>,
    sink: SharedPtr<audio_sys::ffi::NativeAudioSink>,
    observer: Arc<AudioObserver>,
    #[cfg(feature = "obs-proof")]
    ingest: Option<AudioIngest>,
}
#[cfg(feature = "obs-proof")]
static AUDIO_WORKERS_ALIVE: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "obs-proof")]
static AUDIO_WORKERS_PEAK: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "obs-proof")]
struct AudioIngest {
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    resets: Arc<AtomicU64>,
}
#[cfg(feature = "obs-proof")]
impl AudioIngest {
    fn new(queue: Arc<Queue<AudioBlock>>, writer: crate::obs_proof::AudioWriter) -> Self {
        use std::sync::atomic::AtomicBool;
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let resets = Arc::new(AtomicU64::new(0));
        let count = resets.clone();
        let smooth = std::env::var("LIVEKIT_LAB_PLAYOUT_CLOCK").as_deref() == Ok("1");
        let worker = std::thread::spawn(move || {
            struct Lifetime;
            impl Drop for Lifetime {
                fn drop(&mut self) {
                    AUDIO_WORKERS_ALIVE.fetch_sub(1, Ordering::AcqRel);
                }
            }
            let alive = AUDIO_WORKERS_ALIVE.fetch_add(1, Ordering::AcqRel) + 1;
            AUDIO_WORKERS_PEAK.fetch_max(alive, Ordering::Relaxed);
            let _lifetime = Lifetime;
            let mut clock = crate::playout_clock::AudioClock::default();
            while !done.load(Ordering::Acquire) {
                while let Some(frame) = queue.pop(Instant::now()) {
                    let at = if smooth {
                        clock.stamp(frame.value.first_sample, frame.at)
                    } else {
                        frame.at
                    };
                    writer.write(&frame.value.samples, at);
                    count.store(clock.resets, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        Self {
            stop,
            worker: Some(worker),
            resets,
        }
    }
}
#[cfg(feature = "obs-proof")]
impl Drop for AudioIngest {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl AudioTap {
    fn new(
        track: &RemoteAudioTrack,
        #[cfg(feature = "physical-aec")] monitor: Option<(Arc<crate::guest_monitor::Monitor>, u64)>,
        #[cfg(feature = "obs-proof")] writer: Option<crate::obs_proof::AudioWriter>,
    ) -> Self {
        let sid = track.sid().to_string();
        // SAFETY: the SDK RemoteAudioTrack supplies an audio MediaStreamTrack.
        let native =
            unsafe { audio_sys::ffi::media_to_audio(track.rtc_track().native_sys_handle()) };
        Self::from_native(
            native,
            sid,
            #[cfg(feature = "physical-aec")]
            monitor,
            #[cfg(feature = "obs-proof")]
            writer,
        )
    }
    fn from_native(
        track: SharedPtr<audio_sys::ffi::AudioTrack>,
        sid: String,
        #[cfg(feature = "physical-aec")] monitor: Option<(Arc<crate::guest_monitor::Monitor>, u64)>,
        #[cfg(feature = "obs-proof")] writer: Option<crate::obs_proof::AudioWriter>,
    ) -> Self {
        #[cfg(feature = "obs-proof")]
        let ingest_queue = writer
            .as_ref()
            .map(|_| Arc::new(Queue::new(3, Duration::from_millis(30))));
        #[cfg(feature = "obs-proof")]
        let ingest = writer
            .zip(ingest_queue.clone())
            .map(|(writer, queue)| AudioIngest::new(queue, writer));
        let observer = Arc::new(AudioObserver {
            queue: Arc::new(Queue::new(3, Duration::from_millis(30))),
            #[cfg(feature = "physical-aec")]
            monitor,
            sample_count: AtomicU64::new(0),
            bad_format: AtomicU64::new(0),
            #[cfg(feature = "obs-proof")]
            ingest_queue,
        });
        let sink = audio_sys::ffi::new_native_audio_sink(
            Box::new(audio_sys::AudioSinkWrapper::new(observer.clone())),
            48000,
            1,
        );
        track.add_sink(&sink);
        Self {
            registered: true,
            sid,
            track,
            sink,
            observer,
            #[cfg(feature = "obs-proof")]
            ingest,
        }
    }
}
impl AudioTap {
    fn retire_evidence(mut self) -> serde_json::Value {
        self.track.remove_sink(&self.sink);
        self.registered = false;
        #[cfg(feature = "obs-proof")]
        let ingest = self.ingest.take().map(|mut worker| {
            worker.stop.store(true, Ordering::Release);
            let worker_exit_ok = worker.worker.take().is_none_or(|handle| handle.join().is_ok());
            json!({"clock_resets":worker.resets.load(Ordering::Relaxed),
                "queue":self.observer.ingest_queue.as_ref().map(|q| q.stats()),"worker_joined":true,"worker_exit_ok":worker_exit_ok})
        });
        #[cfg(not(feature = "obs-proof"))]
        let ingest: Option<serde_json::Value> = None;
        json!({"kind":"audio","sid":self.sid,"stats":self.observer.queue.stats(),"ingest":ingest,"sink_removed":true})
    }
}
impl Drop for AudioTap {
    fn drop(&mut self) {
        if self.registered {
            self.track.remove_sink(&self.sink);
        }
        #[cfg(feature = "obs-proof")]
        {
            self.ingest.take();
        }
    }
}
struct VideoObserver {
    queue: Arc<Queue<UniquePtr<frame_sys::ffi::VideoFrame>>>,
    discarded: AtomicU64,
    ingress: Option<crate::video_ingress::Trace>,
}
impl video_sys::VideoSink for VideoObserver {
    fn on_frame(&self, frame: UniquePtr<frame_sys::ffi::VideoFrame>) {
        let at = Instant::now();
        if !frame.is_null() {
            if let Some(trace) = &self.ingress {
                if frame.width() == 320 && frame.height() == 180 {
                    // SAFETY: the owned wrapper remains local to this callback.
                    let buffer =
                        new_video_frame_buffer(unsafe { frame.video_frame_buffer() }).to_i420();
                    let label = crate::video_ingress::pulse_label(
                        buffer.data().0,
                        buffer.width(),
                        buffer.height(),
                        buffer.strides().0,
                    );
                    trace.observe(
                        label,
                        audio_sys::ffi::diagnostic_webrtc_time_us(),
                        frame.packet_capture_ntp_us(),
                    );
                }
            }
            self.queue.push(Captured { at, value: frame });
        }
    }
    fn on_discarded_frame(&self) {
        self.discarded.fetch_add(1, Ordering::Relaxed);
    }
    fn on_constraints_changed(&self, _: video_sys::ffi::VideoTrackSourceConstraints) {}
}
struct VideoTap {
    registered: bool,
    sid: String,
    track: SharedPtr<video_sys::ffi::VideoTrack>,
    sink: SharedPtr<video_sys::ffi::NativeVideoSink>,
    observer: Arc<VideoObserver>,
}
impl VideoTap {
    fn new(track: &RemoteVideoTrack, selected: bool) -> Self {
        let observer = Arc::new(VideoObserver {
            queue: Arc::new(Queue::new(2, Duration::from_millis(50))),
            discarded: AtomicU64::new(0),
            ingress: (selected
                && std::env::var("LIVEKIT_LAB_VIDEO_INGRESS_TRACE").as_deref() == Ok("1")
                && std::env::var("LIVEKIT_LAB_MARKER_IDS").as_deref() == Ok("1"))
            .then(crate::video_ingress::Trace::new),
        });
        let sink = video_sys::ffi::new_native_video_sink(Box::new(
            video_sys::VideoSinkWrapper::new(observer.clone()),
        ));
        // SAFETY: the SDK's RemoteVideoTrack supplies a video MediaStreamTrack.
        let sid = track.sid().to_string();
        let track =
            unsafe { video_sys::ffi::media_to_video(track.rtc_track().native_sys_handle()) };
        track.add_sink(&sink);
        Self {
            registered: true,
            sid,
            track,
            sink,
            observer,
        }
    }
    fn retire_evidence(mut self) -> serde_json::Value {
        self.track.remove_sink(&self.sink);
        self.registered = false;
        json!({"kind":"video","sid":self.sid,"stats":self.observer.queue.stats(),
            "decoder_ingress":self.observer.ingress.as_ref().map(|t|t.report()),"sink_removed":true})
    }
}
impl Drop for VideoTap {
    fn drop(&mut self) {
        if self.registered {
            self.track.remove_sink(&self.sink);
        }
    }
}

#[derive(Default)]
struct Measurements {
    audio_age: Vec<f64>,
    video_age: Vec<f64>,
    audio_pulses: Vec<f64>,
    video_pulses: Vec<f64>,
    audio_active: bool,
    video_active: bool,
    video_deadline_valid: u64,
    video_deadline_invalid: u64,
    video_deadline_minus_arrival_ms: Vec<f64>,
    audio_blocks: u64,
    audio_capture_timestamps: u64,
    audio_resampled_blocks: u64,
    capture_time_regressions: u64,
    last_capture_timestamp_ms: Option<i64>,
    capture_step_ms: Vec<f64>,
    video_frames: u64,
    audio_gaps: u64,
    next_sample: Option<u64>,
    video_ntp_nonzero: u64,
    video_packet_capture_nonzero: u64,
    retired_queues: Vec<serde_json::Value>,
}
fn p95(values: &[f64]) -> Option<f64> {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    (!v.is_empty()).then(|| v[((v.len() - 1) as f64 * 0.95).round() as usize])
}
fn pulse_offsets(audio: &[f64], video: &[f64]) -> Vec<f64> {
    audio
        .iter()
        .filter_map(|a| {
            video
                .iter()
                .min_by(|x, y| (*x - a).abs().total_cmp(&(*y - a).abs()))
                .filter(|v| (*v - a).abs() < 400.0)
                .map(|v| v - a)
        })
        .collect()
}

async fn publish(room: &Room) -> Result<(NativeAudioSource, NativeVideoSource)> {
    let stream = if std::env::var("LIVEKIT_LAB_SYNC_STREAMS").as_deref() == Ok("1") {
        "program-av".to_owned()
    } else {
        String::new()
    };
    let audio = NativeAudioSource::new(
        AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        },
        48000,
        1,
        0,
    );
    // The installed SDK's no-keepalive constructor creates the same raw-capable
    // source. Avoid epoch-time black frames before host-clock camera frames.
    let video = if std::env::var("LIVEKIT_LAB_PHYSICAL_CAMERA").as_deref() == Ok("1") {
        NativeVideoSource::new_encoded(VideoResolution {
            width: 640,
            height: 480,
        })
    } else {
        NativeVideoSource::new(
            VideoResolution {
                width: 320,
                height: 180,
            },
            false,
        )
    };
    room.local_participant()
        .publish_track(
            LocalTrack::Audio(LocalAudioTrack::create_audio_track(
                if physical_capture_enabled() {
                    "physical-microphone-lab"
                } else {
                    "synthetic-program"
                },
                RtcAudioSource::Native(audio.clone()),
            )),
            TrackPublishOptions {
                source: TrackSource::Microphone,
                stream: stream.clone(),
                dtx: false,
                red: false,
                ..Default::default()
            },
        )
        .await?;
    room.local_participant()
        .publish_track(
            LocalTrack::Video(LocalVideoTrack::create_video_track(
                if std::env::var("LIVEKIT_LAB_PHYSICAL_CAMERA").as_deref() == Ok("1") {
                    "physical-camera-lab"
                } else {
                    "synthetic-stage"
                },
                RtcVideoSource::Native(video.clone()),
            )),
            TrackPublishOptions {
                source: TrackSource::Camera,
                stream,
                simulcast: false,
                ..Default::default()
            },
        )
        .await?;
    Ok((audio, video))
}

async fn source_loop(
    audio: NativeAudioSource,
    video: NativeVideoSource,
    capture_evidence: crate::capture_fixture::Evidence,
) -> Result<()> {
    if std::env::var("LIVEKIT_LAB_BATCHED_CAPTURE").as_deref() == Ok("1") {
        return crate::capture_fixture::run(audio, video, capture_evidence).await;
    }
    let numbered_markers = std::env::var("LIVEKIT_LAB_MARKER_IDS").as_deref() == Ok("1");
    let began = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_video = 0;
    loop {
        tick.tick().await;
        let elapsed = began.elapsed().as_secs_f64();
        let start_sample = (elapsed * 48000.0 / 480.0).floor() as usize * 480;
        let data: Vec<i16> = (start_sample..start_sample + 480)
            .map(|n| {
                let t = n as f64 / 48000.0;
                let phase = t % 2.0;
                if (0.5..0.62).contains(&phase) {
                    let hz = 997.0
                        + if numbered_markers {
                            128.0 * ((t / 2.0).floor() as u64 % 16) as f64
                        } else {
                            0.0
                        };
                    (13100.0 * (2.0 * std::f64::consts::PI * hz * t).sin()) as i16
                } else {
                    0
                }
            })
            .collect();
        audio
            .capture_frame(&AudioFrame {
                data: Cow::Owned(data),
                sample_rate: 48000,
                num_channels: 1,
                samples_per_channel: 480,
            })
            .await?;
        let slot = (elapsed * 30.0) as u64;
        if slot != last_video {
            last_video = slot;
            let mut buffer = I420Buffer::new(320, 180);
            let (y, u, v) = buffer.data_mut();
            y.fill(if (0.5..0.62).contains(&(elapsed % 2.0)) {
                235
            } else {
                16
            });
            if numbered_markers {
                let marker = (elapsed / 2.0).floor() as u64 % 256;
                for bit in 0..8 {
                    for row in 0..16 {
                        y[row * 320 + bit * 40..row * 320 + (bit + 1) * 40]
                            .fill(if marker & (1 << bit) != 0 { 235 } else { 16 });
                    }
                }
            }
            u.fill(128);
            v.fill(128);
            video.capture_frame(&VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: elapsed.mul_add(1e6, 0.0) as i64,
                frame_metadata: None,
                buffer,
            });
        }
    }
}

/// The direct SDK source is synchronous. Keep its pacing owner off the room's
/// shared Tokio workers, and join it on success, failure and cancellation.
struct Publisher {
    physical_stop: Arc<AtomicBool>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<Result<()>>>,
}
impl Publisher {
    fn start(
        audio: NativeAudioSource,
        video: NativeVideoSource,
        evidence: crate::capture_fixture::Evidence,
        #[cfg(feature = "physical-aec")] monitor: Arc<crate::guest_monitor::Monitor>,
    ) -> Result<Self> {
        let (stop, stopping) = tokio::sync::oneshot::channel();
        let physical_stop = Arc::new(AtomicBool::new(false));
        #[cfg(feature = "physical-aec")]
        let thread_stop = physical_stop.clone();
        let thread = std::thread::Builder::new()
            .name("guest-capture-publisher".into())
            .spawn(move || {
                #[cfg(feature = "physical-aec")]
                if crate::physical_publication::enabled() {
                    return crate::physical_publication::run(
                        audio,
                        video,
                        evidence,
                        thread_stop,
                        monitor,
                    );
                }
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(async {
                        tokio::select! {
                            result = source_loop(audio, video, evidence) => result,
                            _ = stopping => Ok(()),
                        }
                    })
            })?;
        Ok(Self {
            physical_stop,
            stop: Some(stop),
            thread: Some(thread),
        })
    }
    fn shutdown(&mut self) -> Result<()> {
        self.physical_stop.store(true, Ordering::Release);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("Capture publisher thread panicked"))??;
        }
        Ok(())
    }
}
impl Drop for Publisher {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn physical_capture_enabled() -> bool {
    std::env::var("LIVEKIT_LAB_PHYSICAL_CAPTURE").as_deref() == Ok("1")
}
pub async fn run(token_path: &Path, output: &Path, seconds: u64, pressure: bool) -> Result<()> {
    if !(5..=300).contains(&seconds) {
        bail!("Fixture duration must be 5..300 seconds");
    }
    let generated_reconnect_count: usize = std::env::var("LIVEKIT_LAB_GENERATED_RECONNECT_COUNT")
        .unwrap_or_else(|_| "1".into())
        .parse()
        .context("Generated reconnect count must be an integer")?;
    if !(1..=3).contains(&generated_reconnect_count) {
        bail!("Generated reconnect count must be 1..3");
    }
    let generated_reconnect = std::env::var("LIVEKIT_LAB_GENERATED_RECONNECT").ok();
    let reconnect_on_input_pulse =
        std::env::var("LIVEKIT_LAB_RECONNECT_ON_INPUT_PULSE").as_deref() == Ok("1");
    let reconnect_on_queued_pulse =
        std::env::var("LIVEKIT_LAB_RECONNECT_ON_QUEUED_PULSE").as_deref() == Ok("1");
    let audio_transition_tail =
        std::env::var("LIVEKIT_LAB_AUDIO_TRANSITION_TAIL").as_deref() == Ok("1");
    let preserve_reconnect_output =
        std::env::var("LIVEKIT_LAB_PRESERVE_RECONNECT_OUTPUT").as_deref() == Ok("1");
    if audio_transition_tail && !preserve_reconnect_output {
        bail!("Audio tail requires the fixed-authority preservation fixture");
    }
    if preserve_reconnect_output
        && (generated_reconnect.as_deref() != Some("full") || !cfg!(feature = "obs-proof"))
    {
        bail!("Preserved output is restricted to the fixed-authority generated full reconnect fixture");
    }
    if (reconnect_on_input_pulse || reconnect_on_queued_pulse)
        && (generated_reconnect.is_none() || !cfg!(feature = "obs-proof"))
    {
        bail!("Pulse-overlap reconnect requires generated reconnect and OBS playback");
    }
    if let Some(mode) = generated_reconnect.as_deref() {
        if physical_capture_enabled() || !["signal", "full"].contains(&mode) {
            bail!("Generated reconnect requires generated capture and signal|full mode");
        }
    }
    let token = std::fs::read_to_string(token_path)
        .context("Read fixture token file; start web/server.mjs first")?;
    let url = std::env::var("LIVEKIT_LAB_URL").unwrap_or_else(|_| "ws://127.0.0.1:7880".into());
    let cloud_test = std::env::var("LIVEKIT_LAB_CLOUD_TEST").as_deref() == Ok("1");
    if cloud_test
        && (physical_capture_enabled()
            || std::env::var("LIVEKIT_LAB_PHYSICAL_CAMERA").as_deref() == Ok("1"))
    {
        bail!("Cloud compatibility fixture is generated-media only");
    }
    if ![
        "ws://127.0.0.1:7880",
        "ws://127.0.0.1:7885",
        "wss://localhost:7884",
    ]
    .contains(&url.as_str())
        && !crate::cloud_config::allowed_url(&url, cloud_test)
    {
        bail!("Fixture URL must be loopback or an explicitly enabled LiveKit Cloud project");
    }
    if physical_capture_enabled() {
        #[cfg(not(feature = "physical-aec"))]
        bail!("Physical publication requires the physical-aec feature");
        #[cfg(feature = "physical-aec")]
        crate::physical_publication::preflight()?;
    }
    #[cfg(feature = "obs-proof")]
    let recorder = std::env::var("LIVEKIT_LAB_OBS_RECORDING")
        .ok()
        .map(|path| crate::obs_proof::Recorder::start(Path::new(&path)))
        .transpose()?;
    let (room, mut events) = Room::connect(&url, token.trim(), RoomOptions::default()).await?;
    println!(
        "Native host connected to {}; {}",
        if cloud_test {
            "LiveKit Cloud"
        } else {
            "local SFU"
        },
        if physical_capture_enabled() {
            "explicit physical microphone publication enabled; reference scope recorded in evidence"
        } else {
            "synthetic tracks only"
        }
    );
    let (source_audio, source_video) = publish(&room).await?;
    let capture_evidence = Arc::new(std::sync::Mutex::new(json!({"enabled":false})));
    #[cfg(feature = "physical-aec")]
    let monitor = Arc::new(crate::guest_monitor::Monitor::new());
    let mut publisher = Publisher::start(
        source_audio.clone(),
        source_video,
        capture_evidence.clone(),
        #[cfg(feature = "physical-aec")]
        monitor.clone(),
    )?;
    let (mut audio, mut video, mut metrics) = (
        HashMap::<String, AudioTap>::new(),
        HashMap::<String, VideoTap>::new(),
        HashMap::<String, Measurements>::new(),
    );
    let began = Instant::now();
    let video_clock = crate::playout_clock::VideoClock::new(
        audio_sys::ffi::diagnostic_webrtc_time_us(),
        Instant::now(),
    );
    let use_playout_clock = std::env::var("LIVEKIT_LAB_PLAYOUT_CLOCK").as_deref() == Ok("1");
    #[cfg(feature = "obs-proof")]
    let use_sender_clock = std::env::var("LIVEKIT_LAB_AUDIO_MASTER").as_deref() == Ok("1");
    #[cfg(feature = "obs-proof")]
    if use_sender_clock
        && (recorder.is_none()
            || std::env::var("LIVEKIT_LAB_TIMED_MIXER").as_deref() != Ok("1")
            || std::env::var("LIVEKIT_LAB_RTCP_PROBE").as_deref() != Ok("1"))
    {
        bail!("Audio-master experiment requires OBS recording and both native timing probes");
    }
    #[cfg(feature = "obs-proof")]
    let mut playback =
        crate::presentation::SelectedPlayback::new(audio_sys::ffi::diagnostic_webrtc_time_us());
    #[cfg(feature = "obs-proof")]
    let mut next_binding_refresh = Instant::now();
    #[cfg(feature = "obs-proof")]
    let mut binding_discovery = crate::binding_discovery::Discovery::default();
    #[cfg(feature = "obs-proof")]
    let scheduled_handoff = std::env::var("LIVEKIT_LAB_SCHEDULE_HANDOFF").as_deref() == Ok("1");
    #[cfg(feature = "obs-proof")]
    if scheduled_handoff && !use_sender_clock {
        bail!("Scheduled handoff requires audio-master mode");
    }
    #[cfg(feature = "obs-proof")]
    let audio_continuity = Arc::new(std::sync::Mutex::new(
        crate::audio_continuity::Continuity::default(),
    ));
    #[cfg(feature = "obs-proof")]
    let scheduled_trace_clock = recorder.as_ref().map(|r| r.video_writer().timestamp_base());
    #[cfg(feature = "obs-proof")]
    let mut scheduled_audio = if scheduled_handoff {
        let writer = recorder.as_ref().unwrap().audio_writer();
        let continuity = audio_continuity.clone();
        Some(crate::delivery_worker::Deadline::start(
            "guest-audio-output",
            24,
            move |stamp, block: webrtc_sys::webrtc::ffi::DecodedAudioBlock| {
                continuity.lock().unwrap().submit(
                    block.generation,
                    block.sequence,
                    stamp,
                    &block.samples[..480 * block.channels as usize],
                    block.channels,
                    |pcm, channels, at| writer.write_interleaved(pcm, channels, at),
                );
            },
        )?)
    } else {
        None
    };
    #[cfg(feature = "obs-proof")]
    let mut scheduled_video = if scheduled_handoff {
        let writer = recorder.as_ref().unwrap().video_writer();
        Some(crate::delivery_worker::Deadline::start(
            "guest-video-output",
            playback.clock.video_capacity(),
            move |stamp, frame: UniquePtr<frame_sys::ffi::VideoFrame>| {
                let buffer =
                    new_video_frame_buffer(unsafe { frame.video_frame_buffer() }).to_i420();
                let (y, u, v) = buffer.data();
                let (ys, us, vs) = buffer.strides();
                writer.video(
                    (y, u, v),
                    buffer.width(),
                    buffer.height(),
                    (ys, us, vs),
                    stamp,
                );
            },
        )?)
    } else {
        None
    };
    #[cfg(feature = "obs-proof")]
    let mut audio_producer = scheduled_audio.as_ref().map(|worker| worker.producer());
    #[cfg(feature = "obs-proof")]
    let mut video_producer = scheduled_video.as_ref().map(|worker| worker.producer());
    #[cfg(feature = "obs-proof")]
    let mut decoded_drain = {
        let pull_clock = crate::playout_clock::VideoClock::new(
            audio_sys::ffi::diagnostic_webrtc_time_us(),
            Instant::now(),
        );
        crate::delivery_worker::Drain::start(
            "guest-decoded-pcm",
            64 * 3,
            Duration::from_millis(100),
            move || {
                webrtc_sys::webrtc::ffi::diagnostic_take_decoded_audio()
                    .into_iter()
                    .filter_map(|block| {
                        // Preserve original SDK pull time; delivery age never becomes a new origin.
                        pull_clock
                            .deadline(block.pull_us, Instant::now())
                            .map(|at| Captured { at, value: block })
                    })
                    .collect()
            },
        )?
    };
    #[cfg(feature = "obs-proof")]
    let mut isolated_playback = if scheduled_handoff
        && std::env::var("LIVEKIT_LAB_ROOM_LOOP_PLAYBACK").as_deref() != Ok("1")
    {
        Some(playback_worker::Worker::start(
            playback.since_us,
            began,
            audio_producer.as_ref().unwrap().clone(),
            video_producer.as_ref().unwrap().clone(),
            decoded_drain.queue(),
            recorder.as_ref().unwrap().video_writer().timestamp_base(),
        )?)
    } else {
        None
    };
    #[cfg(feature = "obs-proof")]
    if (reconnect_on_input_pulse || reconnect_on_queued_pulse)
        && (isolated_playback.is_none()
            || std::env::var("LIVEKIT_LAB_MARKER_IDS").as_deref() != Ok("1"))
    {
        bail!("Pulse-overlap reconnect requires isolated numbered-marker playback");
    }
    #[cfg(feature = "obs-proof")]
    let mut isolated_reports = None;
    #[cfg(feature = "obs-proof")]
    let mut scheduled_output_drain = None;
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut lifecycle = Vec::new();
    let mut video_observer_owners = Vec::with_capacity(256);
    let mut video_observer_owner_overflow = 0u64;
    let mut decoded_origins = crate::sender_clock::DecodedOrigins::default();
    #[cfg(feature = "obs-proof")]
    let isolated_clock_enabled = isolated_playback.is_some();
    let mut report_worker =
        crate::report_worker::Worker::start(Duration::from_millis(100), move || {
            #[cfg(feature = "obs-proof")]
            if isolated_clock_enabled {
                let mut reports: Vec<_> =
                    webrtc_sys::webrtc::ffi::diagnostic_incoming_clock_reports()
                        .into_iter()
                        .map(|r| crate::sender_clock::SenderReport {
                            ssrc: r.ssrc,
                            ntp_seconds: r.ntp_seconds,
                            ntp_fraction: r.ntp_fraction,
                            rtp_timestamp: r.rtp_timestamp,
                            observed_us: r.observed_us,
                        })
                        .collect();
                reports.sort_by_key(|r| r.observed_us);
                return Ok(TimingSnapshot::Prepared(reports));
            }
            let value: serde_json::Value =
                serde_json::from_str(&webrtc_sys::webrtc::ffi::diagnostic_rtcp_exchange_report())
                    .map_err(|e| e.to_string())?;
            Ok(TimingSnapshot::Raw(value))
        });
    let mut loop_timing = crate::loop_timing::Timings::default();
    let mut reconnect_injected = 0usize;
    #[cfg(feature = "obs-proof")]
    let mut transport_recovery_until: Option<Instant> = None;
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { break; };
                match event {
                    RoomEvent::TrackSubscribed { track, participant, .. } => {
                        let id = participant.identity().to_string();
                        let sid = track.sid().to_string();
                        let m = metrics.entry(id.clone()).or_default();
                        #[cfg(feature = "obs-proof")]
                        if use_sender_clock && id == "guest-1" {
                            playback.clear(audio_sys::ffi::diagnostic_webrtc_time_us());
                            next_binding_refresh=Instant::now();
                            binding_discovery.invalidate();
                            let preserve = preserve_reconnect_output && transport_recovery_until.is_some_and(|until| Instant::now()<until);
                            if preserve && audio_transition_tail {if let Some(worker)=&isolated_playback {worker.finish_transport_audio();}}
                            if let Some(worker)=&scheduled_audio {if preserve {worker.retire_preserving_queued();} else {worker.reset();} audio_producer=Some(worker.producer());}
                            if let Some(worker)=&scheduled_video {if preserve {worker.retire_preserving_queued();} else {worker.reset();} video_producer=Some(worker.producer());}
                            if let Some(worker)=&isolated_playback {
                                worker.clear(playback.since_us,audio_producer.as_ref().unwrap().clone(),video_producer.as_ref().unwrap().clone());
                            }
                        }
                        match track {
                            RemoteTrack::Audio(track) => {
                                // Retire/join the old writer before a replacement can feed this OBS source.
                                if let Some(old) = audio.remove(&id) { m.retired_queues.push(old.retire_evidence()); }
                                audio.insert(id.clone(), AudioTap::new(&track, #[cfg(feature = "physical-aec")] if crate::physical_publication::monitor_enabled() && id=="guest-1" {Some((monitor.clone(),monitor.replace()))} else {None}, #[cfg(feature = "obs-proof")] if id == "guest-1" && !use_sender_clock { recorder.as_ref().map(|r| r.audio_writer()) } else { None }));
                                m.next_sample = None; m.last_capture_timestamp_ms = None; m.audio_active = false;
                            },
                            RemoteTrack::Video(track) => {
                                let tap=VideoTap::new(&track, id=="guest-1");
                                if video_observer_owners.len()<256 {video_observer_owners.push(Arc::downgrade(&tap.observer));}
                                else {video_observer_owner_overflow+=1;}
                                if let Some(old) = video.insert(id.clone(), tap) {
                                    m.retired_queues.push(old.retire_evidence());
                                }
                                m.video_active = false;
                            },
                        }
                        lifecycle.push(json!({"event":"subscribed","identity":id,"sid":sid,"at_ms":began.elapsed().as_millis()}));
                    }
                    RoomEvent::TrackUnsubscribed { track, participant, .. } => {
                        let id = participant.identity().to_string();
                        let sid = track.sid().to_string();
                        let m = metrics.entry(id.clone()).or_default();
                        #[cfg(feature = "obs-proof")]
                        if use_sender_clock && id == "guest-1"
                            && (audio.get(&id).is_some_and(|tap| tap.sid==sid)
                                || video.get(&id).is_some_and(|tap| tap.sid==sid)) {
                            playback.clear(audio_sys::ffi::diagnostic_webrtc_time_us());
                            next_binding_refresh=Instant::now();
                            binding_discovery.invalidate();
                            let preserve = preserve_reconnect_output && transport_recovery_until.is_some_and(|until| Instant::now()<until);
                            if preserve && audio_transition_tail {if let Some(worker)=&isolated_playback {worker.finish_transport_audio();}}
                            if let Some(worker)=&scheduled_audio {if preserve {worker.retire_preserving_queued();} else {worker.reset();} audio_producer=Some(worker.producer());}
                            if let Some(worker)=&scheduled_video {if preserve {worker.retire_preserving_queued();} else {worker.reset();} video_producer=Some(worker.producer());}
                            if let Some(worker)=&isolated_playback {
                                worker.clear(playback.since_us,audio_producer.as_ref().unwrap().clone(),video_producer.as_ref().unwrap().clone());
                            }
                        }
                        // A late teardown from the old publication cannot retire its replacement.
                        match track {
                            RemoteTrack::Audio(_) if audio.get(&id).is_some_and(|tap| tap.sid == sid) => {
                                #[cfg(feature = "physical-aec")]
                                if id=="guest-1" {monitor.replace();}
                                let old = audio.remove(&id).unwrap();
                                m.retired_queues.push(old.retire_evidence());
                            },
                            RemoteTrack::Video(_) if video.get(&id).is_some_and(|tap| tap.sid == sid) => {
                                let old = video.remove(&id).unwrap();
                                m.retired_queues.push(old.retire_evidence());
                            },
                            _ => {}
                        }
                        lifecycle.push(json!({"event":"unsubscribed","identity":id,"sid":sid,"at_ms":began.elapsed().as_millis()}));
                    }
                    RoomEvent::Reconnecting => {
                        #[cfg(feature = "physical-aec")]
                        {monitor.suspend();}
                        lifecycle.push(json!({"event":"reconnecting","at_ms":began.elapsed().as_millis()}));
                    },
                    RoomEvent::Reconnected => {
                        #[cfg(feature = "physical-aec")]
                        if crate::physical_publication::monitor_enabled() {
                            let generation=monitor.resume();
                            if let Some(old)=audio.remove("guest-1") {
                                let track=old.track.clone();let sid=old.sid.clone();
                                let m=metrics.entry("guest-1".into()).or_default();
                                m.retired_queues.push(old.retire_evidence());
                                // Remove the old sink before installing a fresh observer;
                                // callbacks holding the old observer retain its retired epoch.
                                audio.insert("guest-1".into(),AudioTap::from_native(track,sid.clone(),Some((monitor.clone(),generation)), #[cfg(feature = "obs-proof")] if !use_sender_clock {recorder.as_ref().map(|r|r.audio_writer())} else {None}));
                                m.next_sample=None;m.last_capture_timestamp_ms=None;m.audio_active=false;
                                lifecycle.push(json!({"event":"guest_monitor_rebound","sid":sid,"generation":generation,"at_ms":began.elapsed().as_millis()}));
                            }
                        }
                        lifecycle.push(json!({"event":"reconnected","at_ms":began.elapsed().as_millis()}));
                    },
                    _ => {}
                }
            }
            _ = tick.tick() => {
                let now = Instant::now(); let elapsed = now.duration_since(began).as_secs_f64();
                loop_timing.tick(now);
                let work_started = Instant::now();
                if elapsed >= seconds as f64 { break; }
                let reconnect_limit = if generated_reconnect.is_some() { generated_reconnect_count } else { 1 };
                let next_reconnect_at = if generated_reconnect.is_some() { 12.0 + 40.0 * reconnect_injected as f64 } else { 5.0 };
                #[cfg(feature = "obs-proof")]
                let input_pulse = isolated_playback.as_ref().and_then(|worker| worker.latest_input_pulse()).filter(|(_,at)| {
                    let age=audio_sys::ffi::diagnostic_webrtc_time_us().saturating_sub(*at);
                    (0..=20_000).contains(&age)
                });
                #[cfg(not(feature = "obs-proof"))]
                let input_pulse: Option<(u8,i64)> = None;
                #[cfg(feature = "obs-proof")]
                let queued_pulse = isolated_playback.as_ref().and_then(|worker| worker.latest_queued_av_pulse()).filter(|(_,v,a)| {
                    let age=audio_sys::ffi::diagnostic_webrtc_time_us().saturating_sub((*v).max(*a));
                    (0..=20_000).contains(&age)
                });
                #[cfg(not(feature = "obs-proof"))]
                let queued_pulse: Option<(u8,i64,i64)> = None;
                if reconnect_injected < reconnect_limit && elapsed >= next_reconnect_at
                    && (!reconnect_on_input_pulse || input_pulse.is_some())
                    && (!reconnect_on_queued_pulse || queued_pulse.is_some())
                    && (physical_capture_enabled() || generated_reconnect.is_some()) {
                    let requested = generated_reconnect.clone().unwrap_or_else(||
                        std::env::var("LIVEKIT_LAB_MONITOR_RECONNECT").unwrap_or_default());
                    let scenario=match requested.as_str() {
                        "signal"=>Some(livekit::SimulateScenario::SignalReconnect),
                        "full"=>Some(livekit::SimulateScenario::FullReconnect),
                        _=>None,
                    };
                    if let Some(scenario)=scenario {
                        reconnect_injected += 1;
                        #[cfg(feature = "obs-proof")]
                        if preserve_reconnect_output {transport_recovery_until=Some(Instant::now()+Duration::from_millis(1500));}
                        // Timeout bounds the fixture control call, not reconnection itself.
                        tokio::time::timeout(Duration::from_secs(2),room.simulate_scenario(scenario)).await??;
                        lifecycle.push(json!({"event":"reconnect_injected","mode":requested,"at_ms":began.elapsed().as_millis(),"input_pulse_trigger":if reconnect_on_input_pulse {input_pulse}else{None},"queued_av_pulse_trigger":if reconnect_on_queued_pulse {queued_pulse}else{None}}));
                    }
                }
                if physical_capture_enabled() && publisher.thread.as_ref().is_some_and(|thread|thread.is_finished()) {
                    println!("Physical publisher ended early; stopping room and saving diagnostics");
                    break;
                }
                #[cfg(feature = "obs-proof")]
                if use_sender_clock {
                    if let Some(bindings)=binding_discovery.poll(playback.since_us) {
                        for binding in bindings {
                            let observed=audio_sys::ffi::diagnostic_webrtc_time_us();
                            if binding.kind=="audio" && audio.get("guest-1").is_some_and(|tap|tap.sid==binding.sid)
                                && playback.audio_binding.is_none() {
                                if let Some(worker)=&isolated_playback {worker.bind_audio(binding.sid.clone(),binding.ssrc,observed);}
                                playback.audio_binding=Some((binding.sid,binding.ssrc));
                                playback.startup_note("audio_bound",observed);
                            } else if binding.kind=="video" && video.get("guest-1").is_some_and(|tap|tap.sid==binding.sid)
                                && playback.video_binding.is_none() {
                                if let Some(worker)=&isolated_playback {worker.bind_video(binding.sid.clone(),binding.ssrc,observed,video.get("guest-1").unwrap().observer.queue.clone());}
                                playback.video_binding=Some((binding.sid,binding.ssrc,crate::sender_clock::SenderClock::new(binding.ssrc,90000),playback.since_us.saturating_sub(1)));
                                playback.startup_note("video_bound",observed);
                            }
                        }
                    }
                    if now >= next_binding_refresh && binding_discovery.idle()
                        && (playback.audio_binding.is_none() || playback.video_binding.is_none()) {
                        // At most the selected publisher's current audio/video tracks.
                        // The owned job drops track clones on timeout, invalidation or shutdown.
                        let mut tracks=Vec::with_capacity(2);
                        for participant in room.remote_participants().values().filter(|p|p.identity().as_str()=="guest-1") {
                            for publication in participant.track_publications().values() {
                                let sid=publication.sid().to_string();
                                let needed=audio.get("guest-1").is_some_and(|tap|tap.sid==sid) && playback.audio_binding.is_none()
                                    || video.get("guest-1").is_some_and(|tap|tap.sid==sid) && playback.video_binding.is_none();
                                if needed && tracks.len()<2 {if let Some(track)=publication.track() {tracks.push((sid,track));}}
                            }
                        }
                        if !tracks.is_empty() {
                            binding_discovery.request(playback.since_us,async move {
                                let mut bindings=Vec::with_capacity(2);
                                for (sid,track) in tracks {
                                    let Ok(Ok(stats))=tokio::time::timeout(Duration::from_millis(100),track.get_stats()).await else {continue;};
                                    let inbound:Vec<_>=stats.into_iter().filter_map(|stat| {
                                        if let livekit::webrtc::stats::RtcStats::InboundRtp(stat)=stat {Some(stat.stream)} else {None}
                                    }).collect();
                                    if inbound.len()==1 {
                                        let stat=&inbound[0];
                                        bindings.push(crate::binding_discovery::Binding{sid,kind:stat.kind.clone(),ssrc:stat.ssrc});
                                    }
                                }
                                bindings
                            });
                            // Retry missing receiver stats promptly; capacity remains one owned job.
                            next_binding_refresh=now+Duration::from_millis(100);
                        }
                    }
                }
                let reports_started = Instant::now();
                if let Some(rtcp) = report_worker.take() {
                    let rtcp=match rtcp {
                        TimingSnapshot::Raw(value)=>Some(value),
                        #[cfg(feature = "obs-proof")]
                        TimingSnapshot::Prepared(reports)=>{isolated_playback.as_ref().unwrap().sender_reports(reports);None}
                    };
                    if let Some(rtcp)=rtcp {
                    decoded_origins.refresh(&rtcp);
                    #[cfg(feature = "obs-proof")]
                    if use_sender_clock {
                        playback.note_sender_reports(&rtcp);
                        playback.refresh(&rtcp);
                        let observed=audio_sys::ffi::diagnostic_webrtc_time_us();
                        if playback.video_ready(observed) {playback.startup_note("video_clock_ready",observed);}
                    }
                }
                }
                loop_timing.observe("sender_report_refresh", reports_started.elapsed());
                let audio_started = Instant::now();
                let decoded_at = audio_sys::ffi::diagnostic_webrtc_time_us();
                #[cfg(feature = "obs-proof")]
                let mut decoded_blocks=std::iter::from_fn(||if isolated_playback.is_some(){None}else{decoded_drain.pop().map(|frame|frame.value)});
                #[cfg(not(feature = "obs-proof"))]
                let mut decoded_blocks=webrtc_sys::webrtc::ffi::diagnostic_take_decoded_audio().into_iter();
                for block in &mut decoded_blocks {
                    decoded_origins.consume(&block, decoded_at);
                    #[cfg(feature = "obs-proof")]
                    if use_sender_clock {
                        if block.pull_us >= playback.since_us && playback.audio_binding.as_ref().is_some_and(|(_,ssrc)|*ssrc==block.ssrc) {
                            if let Some(pull)=video_clock.deadline(block.pull_us,Instant::now()) {
                                playback.startup_note("bound_audio_pcm",block.pull_us);
                                let audio_origin=decoded_origins.origin_for(&block,decoded_at,playback.bootstrap);
                                if audio_origin.is_some() {playback.startup_note("audio_clock_ready",decoded_at);}
                                let origin=playback.video_ready(decoded_at).then_some(audio_origin).flatten();
                                let bootstrap_used=origin.is_some() && playback.bootstrap && decoded_origins.origin_for(&block,decoded_at,false).is_none();
                                if bootstrap_used {playback.audio_bootstrap_blocks+=1;}
                                let resets=playback.clock.reset_count();
                                let stamp=playback.clock.audio(block.generation,block.sequence,origin,pull);
                                if resets!=playback.clock.reset_count() {if let Some(worker)=&scheduled_audio {worker.reset(); audio_producer=Some(worker.producer());}
                            if let Some(worker)=&scheduled_video {worker.reset(); video_producer=Some(worker.producer());}playback.audio_reanchored();}
                                if let Some(stamp)=stamp {
                                    playback.startup_note("first_audio_scheduled",decoded_at);
                                    if let Some(origin)=origin {playback.audio_label(block.generation,block.sequence,block.rtp_timestamp,bootstrap_used,origin,stamp);}
                                    let pcm=&block.samples[..480*block.channels as usize];
                                    let rms=(pcm.iter().map(|sample|(*sample as f64).powi(2)).sum::<f64>()/pcm.len() as f64).sqrt();
                                    playback.marker(false,rms>2000.0,origin,stamp,pull,recorder.as_ref().unwrap().timestamp(stamp));
                                    if let Some(worker)=&audio_producer {worker.push(stamp,block);}
                                    else {recorder.as_ref().unwrap().audio_writer().write_interleaved(&block.samples[..480*block.channels as usize],block.channels,stamp);}
                                }
                            } else {playback.invalid_audio_pull+=1;}
                        } else {playback.unmatched_audio+=1;}
                    }
                }
                loop_timing.observe("decoded_audio", audio_started.elapsed());
                // Stall the receiving application for 200 ms every five seconds,
                // while WebRTC callbacks and publication continue independently.
                #[cfg(feature = "obs-proof")]
                if let Some(recorder) = &recorder { recorder.pump(); }
                if pressure && elapsed >= 5.0 && elapsed % 5.0 < 0.2 { continue; }
                let observer_audio_started=Instant::now();
                for (id, tap) in &audio {
                    let m = metrics.entry(id.clone()).or_default();
                    while let Some(frame) = tap.observer.queue.pop(now) {
                        m.audio_age.push(now.saturating_duration_since(frame.at).as_secs_f64() * 1000.0);
                        if m.next_sample.is_some_and(|sample| sample != frame.value.first_sample) { m.audio_gaps += 1; }
                        m.next_sample = Some(frame.value.first_sample + 480); m.audio_blocks += 1;
                        if frame.value.resampled { m.audio_resampled_blocks += 1; }
                        if let Some(capture) = frame.value.capture_timestamp_ms {
                            m.audio_capture_timestamps += 1;
                            if let Some(previous) = m.last_capture_timestamp_ms {
                                if capture < previous { m.capture_time_regressions += 1; }
                                m.capture_step_ms.push((capture - previous) as f64);
                            }
                            m.last_capture_timestamp_ms = Some(capture);
                        } else { m.last_capture_timestamp_ms = None; }
                        let rms = (frame.value.samples.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / 480.0).sqrt();
                        let active = rms > 2000.0;
                        if active && !m.audio_active { m.audio_pulses.push(frame.at.duration_since(began).as_secs_f64() * 1000.0); }
                        m.audio_active = active;
                    }
                }
                loop_timing.observe("observer_audio",observer_audio_started.elapsed());
                let observer_video_started=Instant::now();
                for (id, tap) in &video {
                    #[cfg(feature = "obs-proof")]
                    if id=="guest-1" && isolated_playback.is_some(){continue;}
                    let m = metrics.entry(id.clone()).or_default();
                    while let Some(frame) = tap.observer.queue.pop(now) {
                        m.video_age.push(now.saturating_duration_since(frame.at).as_secs_f64() * 1000.0);
                        if frame.value.ntp_time_ms() > 0 { m.video_ntp_nonzero += 1; }
                        let deadline = video_clock.deadline(frame.value.timestamp_us(), frame.at);
                        if let Some(time) = deadline {
                            m.video_deadline_valid += 1;
                            let offset = if time > frame.at { time.duration_since(frame.at).as_secs_f64()*1000.0 } else { -frame.at.duration_since(time).as_secs_f64()*1000.0 };
                            m.video_deadline_minus_arrival_ms.push(offset);
                        } else { m.video_deadline_invalid += 1; }
                        // SAFETY: video_frame_buffer returns an owned wrapper for this frame.
                        let buffer = new_video_frame_buffer(unsafe { frame.value.video_frame_buffer() });
                        let buffer = buffer.to_i420();
                        let (luma,_,_)=buffer.data();
                        let mean=luma.iter().map(|v|*v as u64).sum::<u64>() as f64/luma.len() as f64;
                        #[cfg(feature = "obs-proof")]
                        if id == "guest-1" { if let Some(recorder) = &recorder {
                            let (y,u,v) = buffer.data(); let (ys,us,vs) = buffer.strides();
                            if use_sender_clock {
                                let origin=playback.video_origin(&tap.sid,frame.value.timestamp(),audio_sys::ffi::diagnostic_webrtc_time_us());
                                if let Some(stamp)=playback.clock.video(origin,frame.at) {
                                    playback.startup_note("first_video_scheduled",audio_sys::ffi::diagnostic_webrtc_time_us());
                                    playback.marker(true,mean>180.0,origin,stamp,frame.at,recorder.timestamp(stamp));
                                    if let Some(worker)=&video_producer {worker.push(stamp,frame.value);} else {
                                        recorder.video((y,u,v),buffer.width(),buffer.height(),(ys,us,vs),stamp);
                                    }
                                }
                            } else {
                                recorder.video((y,u,v),buffer.width(),buffer.height(),(ys,us,vs),if use_playout_clock { deadline.unwrap_or(frame.at) } else { frame.at });
                            }
                        } }
                        let active = mean > 180.0; m.video_frames += 1;
                        if active && !m.video_active { m.video_pulses.push(frame.at.duration_since(began).as_secs_f64() * 1000.0); }
                        m.video_active = active;
                    }
                }
                loop_timing.observe("observer_video",observer_video_started.elapsed());
                loop_timing.observe("tick_work", work_started.elapsed());
            }
        }
    }
    #[cfg(feature = "obs-proof")]
    if std::env::var("LIVEKIT_LAB_CAPTURE_SHUTDOWN_TAIL").as_deref() == Ok("1") {
        if let Some(worker) = &isolated_playback {
            // Keep the decoder and audio clock alive long enough to cover video
            // already accepted. New video is closed before the bounded wait.
            worker.begin_finish_input();
            while !worker.finish_input_ready() {
                crate::obs_proof::pump_main();
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            worker.end_finish_input();
        }
    }
    #[cfg(feature = "obs-proof")]
    binding_discovery.shutdown().await;
    report_worker.shutdown();
    #[cfg(feature = "obs-proof")]
    {
        if let Some(worker) = &mut isolated_playback {
            isolated_reports =
                Some(worker.shutdown(metrics.entry("guest-1".to_owned()).or_default()));
        }
        decoded_drain.shutdown();
        if scheduled_handoff {
            // The clock producer is joined before sealing either output. Both
            // output threads continue concurrently; no new input can extend drain.
            let audio = scheduled_audio.as_ref().unwrap();
            let video = scheduled_video.as_ref().unwrap();
            audio.seal();
            video.seal();
            let before = [audio.pending(), video.pending()];
            let started = Instant::now();
            let budget = Duration::from_millis(450); // existing 400 ms maximum lead + bounded scheduling slack
            while (audio.pending() > 0 || video.pending() > 0) && started.elapsed() < budget {
                crate::obs_proof::pump_main();
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            let after = [audio.pending(), video.pending()];
            scheduled_output_drain = Some(
                json!({"budget_ms":450,"elapsed_us":started.elapsed().as_micros(),
                "pending_before_audio_video":before,"pending_after_audio_video":after,
                "timed_out":after!=[0,0],"new_input_sealed":true}),
            );
        }

        if let Some(worker) = &mut scheduled_audio {
            worker.shutdown();
        }
        if let Some(worker) = &mut scheduled_video {
            worker.shutdown();
        }
    }
    let publisher_join_started = Instant::now();
    let publisher_error = publisher.shutdown().err().map(|e| e.to_string());
    let publisher_join_ms = publisher_join_started.elapsed().as_secs_f64() * 1000.0;
    source_audio.clear_buffer();
    let mut receiver_stats = Vec::new();
    let mut remote_sender_reports = Vec::new();
    for participant in room.remote_participants().values() {
        for publication in participant.track_publications().values() {
            if let Some(track) = publication.track() {
                let result = tokio::time::timeout(Duration::from_secs(2), track.get_stats()).await;
                if let Ok(Ok(stats)) = result {
                    for stat in stats {
                        if let livekit::webrtc::stats::RtcStats::InboundRtp(s) = stat {
                            receiver_stats.push(json!({"identity":participant.identity().to_string(),
                                "sid":publication.sid().to_string(), "kind":s.stream.kind, "ssrc":s.stream.ssrc,
                                "estimated_playout_timestamp_ms":s.inbound.estimated_playout_timestamp,
                                "packets_received":s.received.packets_received,"packets_lost":s.received.packets_lost,"jitter_seconds":s.received.jitter,
                                "estimated_playout_presence_preserved":false,
                                "jitter_buffer_delay_seconds":s.inbound.jitter_buffer_delay,
                                "jitter_buffer_emitted_count":s.inbound.jitter_buffer_emitted_count,
                                "concealed_samples":s.inbound.concealed_samples,
                                "inserted_samples_for_deceleration":s.inbound.inserted_samples_for_deceleration,
                                "removed_samples_for_acceleration":s.inbound.removed_samples_for_acceleration,
                                "frames_dropped":s.inbound.frames_dropped}));
                        } else if let livekit::webrtc::stats::RtcStats::RemoteOutboundRtp(s) = stat
                        {
                            remote_sender_reports.push(json!({"identity":participant.identity().to_string(),
                                "sid":publication.sid().to_string(),"kind":s.stream.kind,"ssrc":s.stream.ssrc,
                                "remote_timestamp":s.remote_outbound.remote_timestamp,
                                "reports_sent":s.remote_outbound.reports_sent,
                                "round_trip_time":s.remote_outbound.round_trip_time,
                                "round_trip_time_measurements":s.remote_outbound.round_trip_time_measurements,
                                "optional_field_presence_preserved":false}));
                        }
                    }
                }
            }
        }
    }
    let participants: Vec<_> = metrics.iter().map(|(id, m)| {
        let offsets = pulse_offsets(&m.audio_pulses, &m.video_pulses);
        let abs: Vec<_> = offsets.iter().map(|v| v.abs()).collect();
        json!({"identity":id,"audio_blocks":m.audio_blocks,"video_frames":m.video_frames,
            "audio_callback_to_consumer_p95_ms":p95(&m.audio_age),"video_callback_to_consumer_p95_ms":p95(&m.video_age),
            "audio_sample_discontinuities":m.audio_gaps,"audio_queue":audio.get(id).map(|tap| tap.observer.queue.stats()),
            "video_queue":video.get(id).map(|tap| tap.observer.queue.stats()),
            "video_decoder_ingress":video.get(id).and_then(|tap|tap.observer.ingress.as_ref()).map(|t|t.report()),
            "audio_bad_format":audio.get(id).map(|tap| tap.observer.bad_format.load(Ordering::Relaxed)),
            "audio_pulses_ms":m.audio_pulses,"video_pulses_ms":m.video_pulses,
            "paired_callback_video_minus_audio_ms":offsets,"callback_av_abs_p95_ms":p95(&abs),
            "video_frames_with_ntp_metadata":m.video_ntp_nonzero,
            "video_frames_with_packet_capture_metadata":m.video_packet_capture_nonzero,
            "video_local_deadline_valid":m.video_deadline_valid,"video_local_deadline_invalid":m.video_deadline_invalid,
            "video_deadline_minus_arrival_p95_ms":p95(&m.video_deadline_minus_arrival_ms),

            "retired_queues":m.retired_queues,
            "audio_blocks_with_capture_timestamp":m.audio_capture_timestamps,
            "audio_resampled_blocks":m.audio_resampled_blocks,
            "capture_timestamp_clock_domain":"WebRTC TimeMillis (unmapped to OBS)",
            "capture_timestamp_regressions":m.capture_time_regressions,
            "capture_timestamp_step_p95_ms":p95(&m.capture_step_ms),
            "original_audio_capture_timestamp_available":m.audio_capture_timestamps > 0})
    }).collect();
    let mut audio_ingest_stats = Vec::new();
    for (id, m) in &metrics {
        for evidence in &m.retired_queues {
            if !evidence["ingest"].is_null() {
                audio_ingest_stats
                    .push(json!({"identity":id,"generation":"retired","evidence":evidence}));
            }
        }
    }
    for (id, tap) in audio.drain() {
        let evidence = tap.retire_evidence();
        if !evidence["ingest"].is_null() {
            audio_ingest_stats
                .push(json!({"identity":id,"generation":"final","evidence":evidence}));
        }
    }
    let mut audio_ingest_totals = json!({"received":0u64,"overflow_oldest_dropped":0u64,"callback_contention_dropped":0u64,"stale_dropped":0u64,"consumed":0u64,"pending_frames":0u64,"clock_resets":0u64});
    for generation in &audio_ingest_stats {
        let ingest = &generation["evidence"]["ingest"];
        for key in [
            "received",
            "overflow_oldest_dropped",
            "callback_contention_dropped",
            "stale_dropped",
            "consumed",
            "pending_frames",
        ] {
            audio_ingest_totals[key] = json!(
                audio_ingest_totals[key].as_u64().unwrap()
                    + ingest["queue"][key].as_u64().unwrap_or(0)
            );
        }
        audio_ingest_totals["clock_resets"] = json!(
            audio_ingest_totals["clock_resets"].as_u64().unwrap()
                + ingest["clock_resets"].as_u64().unwrap_or(0)
        );
    }
    #[cfg(feature = "obs-proof")]
    let obs_recording = recorder.as_ref().map(|r| r.finish()).transpose()?;
    #[cfg(feature = "obs-proof")]
    drop(recorder);
    #[cfg(not(feature = "obs-proof"))]
    let obs_recording: Option<serde_json::Value> = None;
    audio.clear();
    video.clear();
    room.close().await?;
    drop(room); // Release native peer owners before collecting observer destruction evidence.
    let video_observer_lifecycle = json!({"tracked":video_observer_owners.len(),
        "expired":video_observer_owners.iter().filter(|owner|owner.upgrade().is_none()).count(),
        "untracked_overflow":video_observer_owner_overflow,"capacity":256,"weak_references_only":true});
    let mut rtcp_exchange_probe: serde_json::Value =
        serde_json::from_str(&webrtc_sys::webrtc::ffi::diagnostic_rtcp_exchange_report())?;
    rtcp_exchange_probe["scope"] = json!("factory event-log instances; one instance may cover multiple peer connections; factory lifetime extends beyond room close");
    let timed_mixer_probe: serde_json::Value =
        serde_json::from_str(&webrtc_sys::webrtc::ffi::diagnostic_timed_mixer_report())?;
    let sender_report_origin_maps = crate::sender_clock::diagnostic_maps(
        &rtcp_exchange_probe,
        &timed_mixer_probe,
        &receiver_stats,
        audio_sys::ffi::diagnostic_webrtc_time_us(),
    );
    let timing_report_status = report_worker.report();
    #[cfg(feature = "obs-proof")]
    let timing_report_status = {
        let mut timing_report_status = timing_report_status;
        timing_report_status["typed_incoming_clock_snapshot"] = json!(isolated_clock_enabled);
        timing_report_status["clock_snapshot_capacity"] = json!(16 * 64);
        timing_report_status["snapshot_retains_native_owner"] = json!(false);
        timing_report_status
    };
    #[cfg(feature = "obs-proof")]
    let worker_lifecycle = json!({"alive_after_retirement":AUDIO_WORKERS_ALIVE.load(Ordering::Acquire),
        "peak_alive":AUDIO_WORKERS_PEAK.load(Ordering::Relaxed),"scope":"application OBS audio ingest workers only","pipeline_probe_lifecycle":crate::obs_proof::pipeline_probe_lifecycle()});
    #[cfg(not(feature = "obs-proof"))]
    let worker_lifecycle: Option<serde_json::Value> = None;
    #[cfg(feature = "obs-proof")]
    let audio_master_playback = if use_sender_clock {
        let mut report = isolated_reports
            .as_ref()
            .map(|(p, _)| p.clone())
            .unwrap_or_else(|| playback.report());
        report["clock_on_dedicated_thread"] = json!(isolated_playback.is_some());
        report["scheduled_output_drain_required"] = json!(scheduled_handoff);
        report["scheduled_output_drain"] = json!(scheduled_output_drain);
        report["scheduled_handoff"] = json!(scheduled_handoff);
        report["transport_audio_silence_tail_requested"] = json!(audio_transition_tail);
        report["same_authority_reconnect_output_preserved"] = json!(preserve_reconnect_output);
        report["loop_timing"] = loop_timing.report();
        report["timing_report_worker_after_shutdown"] = timing_report_status.clone();
        report["binding_discovery_after_shutdown"] = binding_discovery.report();
        report["binding_refresh_interval_ms"] = json!(100);
        report["audio_presentation_queue"] = json!(scheduled_audio.as_ref().map(|w| w.report()));
        report["video_presentation_queue"] = json!(scheduled_video.as_ref().map(|w| w.report()));
        report["audio_output_marker_trace"] = json!(scheduled_audio
            .as_ref()
            .map(|w| w.marker_trace(scheduled_trace_clock.unwrap())));
        report["video_output_marker_trace"] = json!(scheduled_video
            .as_ref()
            .map(|w| w.marker_trace(scheduled_trace_clock.unwrap())));
        report["audio_presentation_queue_after_shutdown"] =
            report["audio_presentation_queue"].clone();
        report["video_presentation_queue_after_shutdown"] =
            report["video_presentation_queue"].clone();
        report["decoded_audio_drain_after_shutdown"] = decoded_drain.report();
        report["delivery_on_dedicated_threads"] = json!(scheduled_handoff);
        report["audio_continuity"] = audio_continuity.lock().unwrap().report();
        Some(report)
    } else {
        None
    };
    #[cfg(not(feature = "obs-proof"))]
    let audio_master_playback: Option<serde_json::Value> = None;
    let mut decoded_pcm_origin_handoff = decoded_origins.report();
    #[cfg(feature = "obs-proof")]
    if let Some((_, origins)) = isolated_reports {
        decoded_pcm_origin_handoff = origins;
    }
    #[cfg(feature = "obs-proof")]
    {
        decoded_pcm_origin_handoff["obs_connected"] = json!(use_sender_clock);
    }
    #[cfg(not(feature = "obs-proof"))]
    {
        decoded_pcm_origin_handoff["obs_connected"] = json!(false);
    }
    let report = json!({"generated_reconnect_requested":generated_reconnect,"generated_reconnect_count":if generated_reconnect.is_some(){generated_reconnect_count}else{0},"numbered_generated_markers":std::env::var("LIVEKIT_LAB_MARKER_IDS").as_deref()==Ok("1"),"audio_master_playback":audio_master_playback,"schema_version":1,"livekit":"0.9.4","topology":if cloud_test {"generated browser guests to native host through LiveKit Cloud"} else {"local browser guests to native host through loopback SFU"},
        "signaling_url":url,"publisher_error":publisher_error,
        "receiver_loop_timing":loop_timing.report(),"timing_report_worker_after_shutdown":timing_report_status,
        "capture_publication":capture_evidence.lock().unwrap_or_else(|p|p.into_inner()).clone(),
        "capture_publisher_owner":{"named_thread":true,"joined":publisher.thread.is_none(),"shutdown_ms":publisher_join_ms},
        "sync_streams_requested":std::env::var("LIVEKIT_LAB_SYNC_STREAMS").as_deref() == Ok("1"),
        "decoded_pcm_origin_handoff":decoded_pcm_origin_handoff,"sender_report_origin_maps":sender_report_origin_maps,"rtcp_exchange_probe":rtcp_exchange_probe,"rrtr_lab_experiment_requested":std::env::var("LIVEKIT_LAB_RRTR").as_deref()==Ok("1"),"timed_mixer_probe":timed_mixer_probe,"remote_sender_reports":remote_sender_reports,"receiver_stats":receiver_stats,"obs_recording":obs_recording,"local_playout_clock_requested":use_playout_clock,"audio_ingest_generation_reports":audio_ingest_stats,"audio_ingest_session_totals":audio_ingest_totals,"audio_worker_lifecycle":worker_lifecycle,
        "duration_seconds":seconds,"actual_duration_seconds":began.elapsed().as_secs_f64(),"consumer_stall_ms":if pressure {200} else {0},"stall_period_seconds":5,
        "native_publish_audio_internal_queue_ms":0,"callback_timestamps_are_capture_timestamps":false,
        "obs_recorded_av_qualified":false,"physical_speaker_reference_connected":false,"g1_complete":false,
        "participants":participants,"lifecycle":lifecycle,"video_observer_lifecycle":video_observer_lifecycle,
        "capture_shutdown_tail_requested":std::env::var("LIVEKIT_LAB_CAPTURE_SHUTDOWN_TAIL").as_deref()==Ok("1")});
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    println!("Transport evidence written to {}", output.display());
    if let Some(error) = publisher_error {
        bail!("Native publisher failed: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_capture_time_is_distinct_from_zero_and_preserves_pcm() {
        use audio_sys::AudioSink;
        let observer = AudioObserver {
            #[cfg(feature = "physical-aec")]
            monitor: None,
            queue: Arc::new(Queue::new(3, Duration::from_millis(30))),
            sample_count: AtomicU64::new(0),
            bad_format: AtomicU64::new(0),
            #[cfg(feature = "obs-proof")]
            ingest_queue: None,
        };
        let pcm = [123i16; 480];
        observer.on_data(&pcm, 48000, 1, 480);
        observer.on_timed_data(
            &pcm,
            48000,
            1,
            480,
            audio_sys::ffi::AudioCaptureTiming {
                has_capture_timestamp: true,
                capture_timestamp_ms: 0,
                resampled: false,
            },
        );
        let missing = observer.queue.pop(Instant::now()).unwrap().value;
        let present = observer.queue.pop(Instant::now()).unwrap().value;
        assert_eq!(missing.capture_timestamp_ms, None);
        assert_eq!(present.capture_timestamp_ms, Some(0));
        assert_eq!(missing.samples, present.samples);
        assert_eq!(present.first_sample, 480);
    }

    #[test]
    fn separated_periods_cannot_be_paired_as_synchronized() {
        assert!(pulse_offsets(&[500.0], &[1500.0]).is_empty());
        assert_eq!(
            pulse_offsets(&[500.0, 2500.0], &[520.0, 2525.0]),
            vec![20.0, 25.0]
        );
    }
}
