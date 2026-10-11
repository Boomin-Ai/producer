//! Selected native playback runs independently of room events and diagnostics.
//! Control edits hold only the kernel lock; RTCP is a capacity-one mailbox.
use super::Measurements;
use crate::{delivery_worker::Producer, queue::Queue};
use cxx::UniquePtr;
use livekit::webrtc::native::new_video_frame_buffer;
use serde_json::{json, Value};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use webrtc_sys::{
    audio_track as audio_sys, video_frame as frame_sys, webrtc::ffi::DecodedAudioBlock,
};
type Frame = UniquePtr<frame_sys::ffi::VideoFrame>;
struct Kernel {
    playback: crate::presentation::SelectedPlayback,
    origins: crate::sender_clock::DecodedOrigins,
    clock: crate::playout_clock::VideoClock,
    audio: Producer<DecodedAudioBlock>,
    video: Producer<Frame>,
    video_queue: Option<Arc<Queue<Frame>>>,
    measurements: Measurements,
    timings: crate::loop_timing::Timings,
    began: Instant,
    recording_clock: (Instant, u64),
    qos: Option<(i32, i32, i32)>,
}
pub struct Worker {
    kernel: Arc<Mutex<Kernel>>,
    reports: Arc<Mutex<Option<Vec<crate::sender_clock::SenderReport>>>>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    failed: bool,
}
impl Worker {
    pub fn start(
        since: i64,
        began: Instant,
        audio: Producer<DecodedAudioBlock>,
        video: Producer<Frame>,
        queue: Arc<Queue<DecodedAudioBlock>>,
        recording_clock: (Instant, u64),
    ) -> std::io::Result<Self> {
        let kernel = Arc::new(Mutex::new(Kernel {
            playback: crate::presentation::SelectedPlayback::new(since),
            origins: crate::sender_clock::DecodedOrigins::default(),
            clock: crate::playout_clock::VideoClock::new(
                audio_sys::ffi::diagnostic_webrtc_time_us(),
                Instant::now(),
            ),
            audio,
            video,
            video_queue: None,
            measurements: Measurements::default(),
            timings: crate::loop_timing::Timings::default(),
            began,
            recording_clock,
            qos: None,
        }));
        kernel
            .lock()
            .unwrap()
            .playback
            .startup_note("binding_reset", since);
        let reports = Arc::new(Mutex::new(None));
        let state = kernel.clone();
        let mailbox = reports.clone();
        let (stop, wake) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("guest-playback-clock".into())
            .spawn(move || {
                state.lock().unwrap().qos = crate::delivery_worker::worker_qos();
                loop {
                    if !matches!(wake.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                        break;
                    }
                    let report = mailbox.lock().unwrap().take();
                    {
                        let mut k = state.lock().unwrap();
                        k.tick(&queue, report);
                    }
                    if !matches!(
                        wake.recv_timeout(Duration::from_millis(2)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ) {
                        break;
                    }
                }
            })?;
        Ok(Self {
            kernel,
            reports,
            stop: Some(stop),
            thread: Some(thread),
            failed: false,
        })
    }
    pub fn clear(&self, since: i64, audio: Producer<DecodedAudioBlock>, video: Producer<Frame>) {
        let mut k = self.kernel.lock().unwrap();
        k.playback.clear(since);
        k.playback.startup_note("binding_reset", since);
        k.audio = audio;
        k.video = video;
        k.video_queue = None;
        k.measurements.video_active = false;
    }
    pub fn bind_audio(&self, sid: String, ssrc: u32, observed: i64) {
        let mut k = self.kernel.lock().unwrap();
        k.playback.audio_binding = Some((sid, ssrc));
        k.playback.startup_note("audio_bound", observed);
    }
    pub fn bind_video(&self, sid: String, ssrc: u32, observed: i64, queue: Arc<Queue<Frame>>) {
        let mut k = self.kernel.lock().unwrap();
        k.playback.video_binding = Some((
            sid,
            ssrc,
            crate::sender_clock::SenderClock::new(ssrc, 90000),
            k.playback.since_us.saturating_sub(1),
        ));
        k.playback.startup_note("video_bound", observed);
        k.video_queue = Some(queue);
    }
    pub fn sender_reports(&self, report: Vec<crate::sender_clock::SenderReport>) {
        *self.reports.lock().unwrap() = Some(report);
    }
    pub fn shutdown(&mut self, measurements: &mut Measurements) -> (Value, Value) {
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            self.failed = thread.join().is_err();
        }
        let mut k = self.kernel.lock().unwrap_or_else(|p| p.into_inner());
        k.video_queue = None;
        let mut report = k.playback.report();
        report["dedicated_clock_worker"] = json!({"active_after_shutdown":false,"worker_failed":self.failed,"poll_interval_ms":2,"timings":k.timings.report(),"qos":k.qos});
        let m = &mut k.measurements;
        measurements.video_age = std::mem::take(&mut m.video_age);
        measurements.video_pulses = std::mem::take(&mut m.video_pulses);
        measurements.video_deadline_minus_arrival_ms =
            std::mem::take(&mut m.video_deadline_minus_arrival_ms);
        measurements.video_frames = m.video_frames;
        measurements.video_ntp_nonzero = m.video_ntp_nonzero;
        measurements.video_deadline_valid = m.video_deadline_valid;
        measurements.video_deadline_invalid = m.video_deadline_invalid;
        (report, k.origins.report())
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Kernel {
    fn tick(
        &mut self,
        queue: &Queue<DecodedAudioBlock>,
        report: Option<Vec<crate::sender_clock::SenderReport>>,
    ) {
        let start = Instant::now();
        self.timings.tick(start);
        let stage = Instant::now();
        if let Some(report) = report {
            self.origins.refresh_reports(&report);
            self.playback.note_parsed_reports(&report);
            self.playback.refresh_parsed_reports(&report);
            let now = audio_sys::ffi::diagnostic_webrtc_time_us();
            if self.playback.video_ready(now) {
                self.playback.startup_note("video_clock_ready", now);
            }
        }
        self.timings
            .observe("sender_report_refresh", stage.elapsed());
        let stage = Instant::now();
        // Preserve SDK pull timestamps and existing age/capacity policy.
        for _ in 0..192 {
            let Some(frame) = queue.pop(Instant::now()) else {
                break;
            };
            let block = frame.value;
            let now = audio_sys::ffi::diagnostic_webrtc_time_us();
            self.origins.consume(&block, now);
            let p = &mut self.playback;
            if block.pull_us < p.since_us
                || !p
                    .audio_binding
                    .as_ref()
                    .is_some_and(|(_, ssrc)| *ssrc == block.ssrc)
            {
                p.unmatched_audio += 1;
                continue;
            }
            let Some(pull) = self.clock.deadline(block.pull_us, Instant::now()) else {
                p.invalid_audio_pull += 1;
                continue;
            };
            p.startup_note("bound_audio_pcm", block.pull_us);
            let audio_origin = self.origins.origin_for(&block, now, p.bootstrap);
            if audio_origin.is_some() {
                p.startup_note("audio_clock_ready", now);
            }
            let origin = p.video_ready(now).then_some(audio_origin).flatten();
            let bootstrap = origin.is_some()
                && p.bootstrap
                && self.origins.origin_for(&block, now, false).is_none();
            if bootstrap {
                p.audio_bootstrap_blocks += 1;
            }
            let resets = p.clock.reset_count();
            let stamp = p
                .clock
                .audio(block.generation, block.sequence, origin, pull);
            if resets != p.clock.reset_count() {
                self.audio = self.audio.reset_and_renew();
                self.video = self.video.reset_and_renew();
                p.audio_reanchored();
            }
            if let Some(stamp) = stamp {
                p.startup_note("first_audio_scheduled", now);
                if let Some(origin) = origin {
                    p.audio_label(
                        block.generation,
                        block.sequence,
                        block.rtp_timestamp,
                        bootstrap,
                        origin,
                        stamp,
                    );
                }
                let pcm = &block.samples[..480 * block.channels as usize];
                let rms = (pcm.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / pcm.len() as f64)
                    .sqrt();
                p.marker(
                    false,
                    rms > 2000.0,
                    origin,
                    stamp,
                    pull,
                    timestamp(self.recording_clock, stamp),
                );
                self.audio.push(stamp, block);
            }
        }
        self.timings.observe("decoded_audio", stage.elapsed());
        let stage = Instant::now();
        if let Some(queue) = &self.video_queue {
            for _ in 0..2 {
                let now = Instant::now();
                let Some(frame) = queue.pop(now) else {
                    break;
                };
                let m = &mut self.measurements;
                m.video_age
                    .push(now.saturating_duration_since(frame.at).as_secs_f64() * 1000.0);
                if frame.value.ntp_time_ms() > 0 {
                    m.video_ntp_nonzero += 1;
                }
                if let Some(deadline) = self.clock.deadline(frame.value.timestamp_us(), frame.at) {
                    m.video_deadline_valid += 1;
                    let offset = if deadline > frame.at {
                        deadline.duration_since(frame.at).as_secs_f64() * 1000.0
                    } else {
                        -frame.at.duration_since(deadline).as_secs_f64() * 1000.0
                    };
                    m.video_deadline_minus_arrival_ms.push(offset);
                } else {
                    m.video_deadline_invalid += 1;
                }
                // SAFETY: the SDK returns an owned buffer wrapper for this frame.
                let buffer =
                    new_video_frame_buffer(unsafe { frame.value.video_frame_buffer() }).to_i420();
                let (luma, _, _) = buffer.data();
                let mean = luma.iter().map(|v| *v as u64).sum::<u64>() as f64 / luma.len() as f64;
                let rtc = audio_sys::ffi::diagnostic_webrtc_time_us();
                let sid = self.playback.video_binding.as_ref().unwrap().0.clone();
                let origin = self
                    .playback
                    .video_origin(&sid, frame.value.timestamp(), rtc);
                if let Some(stamp) = self.playback.clock.video(origin, frame.at) {
                    self.playback.startup_note("first_video_scheduled", rtc);
                    self.playback.marker(
                        true,
                        mean > 180.0,
                        origin,
                        stamp,
                        frame.at,
                        timestamp(self.recording_clock, stamp),
                    );
                    self.video.push(stamp, frame.value);
                }
                let active = mean > 180.0;
                m.video_frames += 1;
                if active && !m.video_active {
                    m.video_pulses.push(
                        frame.at.saturating_duration_since(self.began).as_secs_f64() * 1000.0,
                    );
                }
                m.video_active = active;
            }
        }
        self.timings.observe("observer_video", stage.elapsed());
        self.timings.observe("tick_work", start.elapsed());
    }
}

fn timestamp(base: (Instant, u64), at: Instant) -> u64 {
    base.1 + at.saturating_duration_since(base.0).as_nanos() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{delivery_worker::Deadline, queue::Captured};
    #[test]
    fn processing_continues_without_room_polling_and_releases_queues_over_100_cycles() {
        for _ in 0..100 {
            let mut audio =
                Deadline::start("clock-audio-test", 24, |_, _: DecodedAudioBlock| {}).unwrap();
            let mut video = Deadline::start("clock-video-test", 14, |_, _: Frame| {}).unwrap();
            let pcm = Arc::new(Queue::new(192, Duration::from_millis(100)));
            let since = audio_sys::ffi::diagnostic_webrtc_time_us();
            let mut worker = Worker::start(
                since,
                Instant::now(),
                audio.producer(),
                video.producer(),
                pcm.clone(),
                (Instant::now(), 0),
            )
            .unwrap();
            let frames = Arc::new(Queue::new(2, Duration::from_millis(50)));
            worker.bind_video("old".into(), 7, since, frames.clone());
            assert_eq!(Arc::strong_count(&frames), 2);
            pcm.push(Captured {
                at: Instant::now(),
                value: DecodedAudioBlock {
                    samples: [0; 960],
                    generation: 1,
                    sequence: 1,
                    channels: 1,
                    ssrc: 8,
                    rtp_timestamp: 480,
                    pull_us: since,
                    elapsed_ms: 0,
                    speech_type: 0,
                    muted: false,
                },
            });
            // The room performs no tick or drain call while playback consumes PCM.
            let until = Instant::now() + Duration::from_secs(1);
            while worker.kernel.lock().unwrap().playback.unmatched_audio == 0 {
                assert!(
                    Instant::now() < until,
                    "clock worker failed to process without room ticks"
                );
                thread::yield_now();
            }
            audio.reset();
            video.reset();
            worker.clear(since + 1, audio.producer(), video.producer());
            assert_eq!(Arc::strong_count(&frames), 1);
            let mut measurements = Measurements::default();
            let (report, _) = worker.shutdown(&mut measurements);
            assert_eq!(report["dedicated_clock_worker"]["worker_failed"], false);
            assert_eq!(
                report["dedicated_clock_worker"]["active_after_shutdown"],
                false
            );
            drop(worker);
            assert_eq!(Arc::strong_count(&pcm), 1);
            audio.shutdown();
            video.shutdown();
            assert_eq!(audio.report()["pending"], 0);
            assert_eq!(video.report()["pending"], 0);
        }
    }
}
