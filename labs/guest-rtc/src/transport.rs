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
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use webrtc_sys::{audio_track as audio_sys, video_frame as frame_sys, video_track as video_sys};

struct AudioBlock {
    samples: Vec<i16>,
    first_sample: u64,
    capture_timestamp_ms: Option<i64>,
    resampled: bool,
}
struct AudioObserver {
    queue: Arc<Queue<AudioBlock>>,
    sample_count: AtomicU64,
    bad_format: AtomicU64,
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
        self.queue.push(Captured {
            at,
            value: AudioBlock {
                samples: data.to_vec(),
                first_sample,
                capture_timestamp_ms: timing
                    .has_capture_timestamp
                    .then_some(timing.capture_timestamp_ms),
                resampled: timing.resampled,
            },
        });
    }
}
struct AudioTap {
    sid: String,
    track: SharedPtr<audio_sys::ffi::AudioTrack>,
    sink: SharedPtr<audio_sys::ffi::NativeAudioSink>,
    observer: Arc<AudioObserver>,
}
impl AudioTap {
    fn new(track: &RemoteAudioTrack) -> Self {
        let observer = Arc::new(AudioObserver {
            queue: Arc::new(Queue::new(3, Duration::from_millis(30))),
            sample_count: AtomicU64::new(0),
            bad_format: AtomicU64::new(0),
        });
        let sink = audio_sys::ffi::new_native_audio_sink(
            Box::new(audio_sys::AudioSinkWrapper::new(observer.clone())),
            48000,
            1,
        );
        // SAFETY: the SDK's RemoteAudioTrack supplies an audio MediaStreamTrack.
        let sid = track.sid().to_string();
        let track =
            unsafe { audio_sys::ffi::media_to_audio(track.rtc_track().native_sys_handle()) };
        track.add_sink(&sink);
        Self {
            sid,
            track,
            sink,
            observer,
        }
    }
}
impl Drop for AudioTap {
    fn drop(&mut self) {
        self.track.remove_sink(&self.sink);
    }
}
struct VideoObserver {
    queue: Arc<Queue<UniquePtr<frame_sys::ffi::VideoFrame>>>,
    discarded: AtomicU64,
}
impl video_sys::VideoSink for VideoObserver {
    fn on_frame(&self, frame: UniquePtr<frame_sys::ffi::VideoFrame>) {
        let at = Instant::now();
        if !frame.is_null() {
            self.queue.push(Captured { at, value: frame });
        }
    }
    fn on_discarded_frame(&self) {
        self.discarded.fetch_add(1, Ordering::Relaxed);
    }
    fn on_constraints_changed(&self, _: video_sys::ffi::VideoTrackSourceConstraints) {}
}
struct VideoTap {
    sid: String,
    track: SharedPtr<video_sys::ffi::VideoTrack>,
    sink: SharedPtr<video_sys::ffi::NativeVideoSink>,
    observer: Arc<VideoObserver>,
}
impl VideoTap {
    fn new(track: &RemoteVideoTrack) -> Self {
        let observer = Arc::new(VideoObserver {
            queue: Arc::new(Queue::new(2, Duration::from_millis(50))),
            discarded: AtomicU64::new(0),
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
            sid,
            track,
            sink,
            observer,
        }
    }
}
impl Drop for VideoTap {
    fn drop(&mut self) {
        self.track.remove_sink(&self.sink);
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
    let video = NativeVideoSource::new(
        VideoResolution {
            width: 320,
            height: 180,
        },
        false,
    );
    room.local_participant()
        .publish_track(
            LocalTrack::Audio(LocalAudioTrack::create_audio_track(
                "synthetic-program",
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
                "synthetic-stage",
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

async fn source_loop(audio: NativeAudioSource, video: NativeVideoSource) -> Result<()> {
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
                    (13100.0 * (2.0 * std::f64::consts::PI * 997.0 * t).sin()) as i16
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

pub async fn run(token_path: &Path, output: &Path, seconds: u64, pressure: bool) -> Result<()> {
    if !(5..=300).contains(&seconds) {
        bail!("Fixture duration must be 5..300 seconds");
    }
    let token = std::fs::read_to_string(token_path)
        .context("Read loopback-only token file; start web/server.mjs first")?;
    let url = std::env::var("LIVEKIT_LAB_URL").unwrap_or_else(|_| "ws://127.0.0.1:7880".into());
    if !["ws://127.0.0.1:7880", "wss://localhost:7884"].contains(&url.as_str()) {
        bail!("This fixture only connects to its loopback SFU");
    }
    #[cfg(feature = "obs-proof")]
    let recorder = std::env::var("LIVEKIT_LAB_OBS_RECORDING")
        .ok()
        .map(|path| crate::obs_proof::Recorder::start(Path::new(&path)))
        .transpose()?;
    let (room, mut events) = Room::connect(&url, token.trim(), RoomOptions::default()).await?;
    println!("Native host connected to local SFU; synthetic tracks only");
    let (source_audio, source_video) = publish(&room).await?;
    let publisher = tokio::spawn(source_loop(source_audio.clone(), source_video));
    let (mut audio, mut video, mut metrics) = (
        HashMap::<String, AudioTap>::new(),
        HashMap::<String, VideoTap>::new(),
        HashMap::<String, Measurements>::new(),
    );
    let began = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut lifecycle = Vec::new();
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { break; };
                match event {
                    RoomEvent::TrackSubscribed { track, participant, .. } => {
                        let id = participant.identity().to_string();
                        let sid = track.sid().to_string();
                        let m = metrics.entry(id.clone()).or_default();
                        match track {
                            RemoteTrack::Audio(track) => {
                                if let Some(old) = audio.insert(id.clone(), AudioTap::new(&track)) {
                                    m.retired_queues.push(json!({"kind":"audio","sid":old.sid,"stats":old.observer.queue.stats()}));
                                }
                                m.next_sample = None; m.last_capture_timestamp_ms = None; m.audio_active = false;
                            },
                            RemoteTrack::Video(track) => {
                                if let Some(old) = video.insert(id.clone(), VideoTap::new(&track)) {
                                    m.retired_queues.push(json!({"kind":"video","sid":old.sid,"stats":old.observer.queue.stats()}));
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
                        // A late teardown from the old publication cannot retire its replacement.
                        match track {
                            RemoteTrack::Audio(_) if audio.get(&id).is_some_and(|tap| tap.sid == sid) => {
                                let old = audio.remove(&id).unwrap();
                                m.retired_queues.push(json!({"kind":"audio","sid":old.sid,"stats":old.observer.queue.stats()}));
                            },
                            RemoteTrack::Video(_) if video.get(&id).is_some_and(|tap| tap.sid == sid) => {
                                let old = video.remove(&id).unwrap();
                                m.retired_queues.push(json!({"kind":"video","sid":old.sid,"stats":old.observer.queue.stats()}));
                            },
                            _ => {}
                        }
                        lifecycle.push(json!({"event":"unsubscribed","identity":id,"sid":sid,"at_ms":began.elapsed().as_millis()}));
                    }
                    RoomEvent::Reconnecting => lifecycle.push(json!({"event":"reconnecting","at_ms":began.elapsed().as_millis()})),
                    RoomEvent::Reconnected => lifecycle.push(json!({"event":"reconnected","at_ms":began.elapsed().as_millis()})),
                    _ => {}
                }
            }
            _ = tick.tick() => {
                let now = Instant::now(); let elapsed = now.duration_since(began).as_secs_f64();
                if elapsed >= seconds as f64 { break; }
                // Stall the receiving application for 200 ms every five seconds,
                // while WebRTC callbacks and publication continue independently.
                #[cfg(feature = "obs-proof")]
                if let Some(recorder) = &recorder { recorder.pump(); }
                if pressure && elapsed >= 5.0 && elapsed % 5.0 < 0.2 { continue; }
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
                        #[cfg(feature = "obs-proof")]
                        if id == "guest-1" { if let Some(recorder) = &recorder { recorder.audio(&frame.value.samples, frame.at); } }
                        let rms = (frame.value.samples.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / 480.0).sqrt();
                        let active = rms > 2000.0;
                        if active && !m.audio_active { m.audio_pulses.push(frame.at.duration_since(began).as_secs_f64() * 1000.0); }
                        m.audio_active = active;
                    }
                }
                for (id, tap) in &video {
                    let m = metrics.entry(id.clone()).or_default();
                    while let Some(frame) = tap.observer.queue.pop(now) {
                        m.video_age.push(now.saturating_duration_since(frame.at).as_secs_f64() * 1000.0);
                        if frame.value.ntp_time_ms() > 0 { m.video_ntp_nonzero += 1; }
                        // SAFETY: video_frame_buffer returns an owned wrapper for this frame.
                        let buffer = new_video_frame_buffer(unsafe { frame.value.video_frame_buffer() });
                        let buffer = buffer.to_i420();
                        #[cfg(feature = "obs-proof")]
                        if id == "guest-1" { if let Some(recorder) = &recorder {
                            let (y,u,v) = buffer.data(); let (ys,us,vs) = buffer.strides();
                            recorder.video((y,u,v),buffer.width(),buffer.height(),(ys,us,vs),frame.at);
                        } }
                        let (y, _, _) = buffer.data();
                        let mean = y.iter().map(|v| *v as u64).sum::<u64>() as f64 / y.len() as f64;
                        let active = mean > 180.0; m.video_frames += 1;
                        if active && !m.video_active { m.video_pulses.push(frame.at.duration_since(began).as_secs_f64() * 1000.0); }
                        m.video_active = active;
                    }
                }
            }
        }
    }
    let publisher_error = if publisher.is_finished() {
        match publisher.await {
            Ok(Err(error)) => Some(error.to_string()),
            Err(error) => Some(error.to_string()),
            _ => None,
        }
    } else {
        publisher.abort();
        let _ = publisher.await;
        None
    };
    source_audio.clear_buffer();
    let mut receiver_stats = Vec::new();
    for participant in room.remote_participants().values() {
        for publication in participant.track_publications().values() {
            if let Some(track) = publication.track() {
                let result = tokio::time::timeout(Duration::from_secs(2), track.get_stats()).await;
                if let Ok(Ok(stats)) = result {
                    for stat in stats {
                        if let livekit::webrtc::stats::RtcStats::InboundRtp(s) = stat {
                            receiver_stats.push(json!({"identity":participant.identity().to_string(),
                                "sid":publication.sid().to_string(), "kind":s.stream.kind,
                                "estimated_playout_timestamp_ms":s.inbound.estimated_playout_timestamp,
                                "estimated_playout_presence_preserved":false,
                                "jitter_buffer_delay_seconds":s.inbound.jitter_buffer_delay,
                                "jitter_buffer_emitted_count":s.inbound.jitter_buffer_emitted_count,
                                "concealed_samples":s.inbound.concealed_samples,
                                "inserted_samples_for_deceleration":s.inbound.inserted_samples_for_deceleration,
                                "removed_samples_for_acceleration":s.inbound.removed_samples_for_acceleration,
                                "frames_dropped":s.inbound.frames_dropped}));
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
            "audio_bad_format":audio.get(id).map(|tap| tap.observer.bad_format.load(Ordering::Relaxed)),
            "audio_pulses_ms":m.audio_pulses,"video_pulses_ms":m.video_pulses,
            "paired_callback_video_minus_audio_ms":offsets,"callback_av_abs_p95_ms":p95(&abs),
            "video_frames_with_ntp_metadata":m.video_ntp_nonzero,
            "retired_queues":m.retired_queues,
            "audio_blocks_with_capture_timestamp":m.audio_capture_timestamps,
            "audio_resampled_blocks":m.audio_resampled_blocks,
            "capture_timestamp_clock_domain":"WebRTC TimeMillis (unmapped to OBS)",
            "capture_timestamp_regressions":m.capture_time_regressions,
            "capture_timestamp_step_p95_ms":p95(&m.capture_step_ms),
            "original_audio_capture_timestamp_available":m.audio_capture_timestamps > 0})
    }).collect();
    #[cfg(feature = "obs-proof")]
    let obs_recording = recorder.as_ref().map(|r| r.finish()).transpose()?;
    #[cfg(not(feature = "obs-proof"))]
    let obs_recording: Option<serde_json::Value> = None;
    audio.clear();
    video.clear();
    room.close().await?;
    let report = json!({"schema_version":1,"livekit":"0.9.4","topology":"local browser guests to native host through loopback SFU",
        "signaling_url":url,"publisher_error":publisher_error,
        "sync_streams_requested":std::env::var("LIVEKIT_LAB_SYNC_STREAMS").as_deref() == Ok("1"),
        "receiver_stats":receiver_stats,"obs_recording":obs_recording,
        "duration_seconds":seconds,"consumer_stall_ms":if pressure {200} else {0},"stall_period_seconds":5,
        "native_publish_audio_internal_queue_ms":0,"callback_timestamps_are_capture_timestamps":false,
        "obs_recorded_av_qualified":false,"physical_speaker_reference_connected":false,"g1_complete":false,
        "participants":participants,"lifecycle":lifecycle});
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
            queue: Arc::new(Queue::new(3, Duration::from_millis(30))),
            sample_count: AtomicU64::new(0),
            bad_format: AtomicU64::new(0),
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
