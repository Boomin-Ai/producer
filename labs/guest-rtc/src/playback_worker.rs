//! Selected native playback runs independently of room events and diagnostics.
//! Control edits hold only the kernel lock; RTCP is a capacity-one mailbox.
use super::Measurements;
use crate::{delivery_worker::Producer, queue::Queue};
use cxx::UniquePtr;
use livekit::webrtc::native::new_video_frame_buffer;
use livekit::webrtc::video_frame::VideoBuffer;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use webrtc_sys::{
    audio_track as audio_sys, video_frame as frame_sys, webrtc::ffi::DecodedAudioBlock,
};
type Frame = UniquePtr<frame_sys::ffi::VideoFrame>;
struct AudioTail {
    stamp: Instant,
    generation: u64,
    sequence: u64,
    channels: u32,
    epoch: u64,
}
impl AudioTail {
    fn frames(&self) -> Option<[(Instant, DecodedAudioBlock); 2]> {
        let frame = |n: u64| -> Option<(Instant, DecodedAudioBlock)> {
            Some((
                self.stamp.checked_add(Duration::from_millis(n * 10))?,
                DecodedAudioBlock {
                    samples: [0; 960],
                    generation: self.generation,
                    sequence: self.sequence.checked_add(n)?,
                    channels: self.channels,
                    ssrc: 0,
                    rtp_timestamp: 0,
                    pull_us: 0,
                    elapsed_ms: 0,
                    capture_sender_ntp_us: 0,
                    speech_type: 0,
                    muted: true,
                },
            ))
        };
        Some([frame(1)?, frame(2)?])
    }
}
struct Kernel {
    capture_clock: crate::capture_clock::AudioClock,
    capture_scheduling: bool,
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
    input_pulse: Arc<AtomicU64>,
    input_markers: Vec<Value>,
    numbered_markers: bool,
    accepted_video_pulse: Arc<AtomicU64>,
    accepted_audio_pulse: Arc<AtomicU64>,
    audio_markers: Vec<Value>,
    audio_receipt_seen: bool,
    audio_accepted_seen: bool,
    preserve_clock_output: bool,
    last_audio: Option<AudioTail>,
    transition_tail_enqueued: u64,
    transition_tail_rejected: u64,
}
pub struct Worker {
    kernel: Arc<Mutex<Kernel>>,
    reports: Arc<Mutex<Option<Vec<crate::sender_clock::SenderReport>>>>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    failed: bool,
    input_pulse: Arc<AtomicU64>,
    accepted_video_pulse: Arc<AtomicU64>,
    accepted_audio_pulse: Arc<AtomicU64>,
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
        let input_pulse = Arc::new(AtomicU64::new(0));
        let accepted_video_pulse = Arc::new(AtomicU64::new(0));
        let accepted_audio_pulse = Arc::new(AtomicU64::new(0));
        let kernel = Arc::new(Mutex::new(Kernel {
            capture_clock: crate::capture_clock::AudioClock::default(),
            capture_scheduling: std::env::var("LIVEKIT_LAB_CAPTURE_SCHEDULING").as_deref()
                == Ok("1"),
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
            input_pulse: input_pulse.clone(),
            input_markers: Vec::with_capacity(256),
            numbered_markers: std::env::var("LIVEKIT_LAB_MARKER_IDS").as_deref() == Ok("1"),
            accepted_video_pulse: accepted_video_pulse.clone(),
            accepted_audio_pulse: accepted_audio_pulse.clone(),
            audio_markers: Vec::with_capacity(512),
            audio_receipt_seen: false,
            audio_accepted_seen: false,
            last_audio: None,
            transition_tail_enqueued: 0,
            transition_tail_rejected: 0,
            preserve_clock_output: std::env::var("LIVEKIT_LAB_PRESERVE_RECONNECT_OUTPUT")
                .as_deref()
                == Ok("1"),
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
            input_pulse,
            accepted_video_pulse,
            accepted_audio_pulse,
        })
    }
    pub fn finish_transport_audio(&self) {
        let mut k = self.kernel.lock().unwrap();
        let Some(last) = k.last_audio.take() else {
            return;
        };
        if last.epoch == k.audio.epoch()
            && last
                .frames()
                .is_some_and(|tail| k.audio.push_tail_pair_and_retire(tail))
        {
            k.transition_tail_enqueued += 2;
        } else {
            k.transition_tail_rejected += 2;
        }
    }
    pub fn clear(&self, since: i64, audio: Producer<DecodedAudioBlock>, video: Producer<Frame>) {
        let mut k = self.kernel.lock().unwrap();
        k.playback.clear(since);
        k.capture_clock.clear();
        k.playback.startup_note("binding_reset", since);
        k.last_audio = None;
        k.audio = audio;
        k.video = video;
        k.video_queue = None;
        k.measurements.video_active = false;
        k.input_pulse.store(0, Ordering::Release);
        k.accepted_video_pulse.store(0, Ordering::Release);
        k.accepted_audio_pulse.store(0, Ordering::Release);
        k.audio_receipt_seen = false;
        k.audio_accepted_seen = false;
    }
    /// Numeric lab receipt, atomically published without locking the media kernel.
    pub fn latest_input_pulse(&self) -> Option<(u8, i64)> {
        let packed = self.input_pulse.load(Ordering::Acquire);
        (packed != 0).then_some((packed as u8, (packed >> 8) as i64))
    }
    pub fn latest_queued_av_pulse(&self) -> Option<(u8, i64, i64)> {
        match_queued_pulses(
            self.accepted_video_pulse.load(Ordering::Acquire),
            self.accepted_audio_pulse.load(Ordering::Acquire),
        )
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
        report["packet_capture_scheduling_requested"] = json!(k.capture_scheduling);
        report["packet_capture_audio_clock"] = k.capture_clock.report();
        report["nonoverlapping_audio_clock_preservation_requested"] =
            json!(k.preserve_clock_output);
        report["transport_audio_silence_tail"] = json!({"synthetic_blocks_enqueued":k.transition_tail_enqueued,"synthetic_blocks_rejected":k.transition_tail_rejected,"blocks_per_transition":2,"block_duration_ms":10,"fake_sender_timestamps_used":false,"missing_pcm_recovered":false});
        report["decoded_video_marker_receipts"] = json!(k.input_markers);
        report["decoded_video_marker_receipt_capacity"] = json!(256);
        report["decoded_audio_marker_receipts"] = json!(k.audio_markers);
        report["decoded_audio_marker_receipt_capacity"] = json!(512);
        report["dedicated_clock_worker"] = json!({"active_after_shutdown":false,"worker_failed":self.failed,"poll_interval_ms":2,"timings":k.timings.report(),"qos":k.qos});
        let m = &mut k.measurements;
        measurements.video_age = std::mem::take(&mut m.video_age);
        measurements.video_pulses = std::mem::take(&mut m.video_pulses);
        measurements.video_deadline_minus_arrival_ms =
            std::mem::take(&mut m.video_deadline_minus_arrival_ms);
        measurements.video_frames = m.video_frames;
        measurements.video_ntp_nonzero = m.video_ntp_nonzero;
        measurements.video_packet_capture_nonzero = m.video_packet_capture_nonzero;
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
            if !self.capture_scheduling && self.playback.video_ready(now) {
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
            let audio_origin = if self.capture_scheduling {
                self.capture_clock.origin(&block)
            } else {
                self.origins.origin_for(&block, now, p.bootstrap)
            };
            if audio_origin.is_some() {
                p.startup_note("audio_clock_ready", now);
            }
            let video_ready = if self.capture_scheduling {
                // ACT already labels audio in the shared publisher clock. Keep
                // conversation audio moving while the first video frame warms up.
                true
            } else {
                p.video_ready(now)
            };
            let origin = video_ready.then_some(audio_origin).flatten();
            let bootstrap = origin.is_some()
                && !self.capture_scheduling
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
                self.audio = match stamp.filter(|_| self.preserve_clock_output) {
                    Some(target) => self
                        .audio
                        .reanchor_and_renew(target, Duration::from_millis(10)),
                    None => self.audio.reset_and_renew(),
                };
                self.video = self.video.reset_and_renew();
                p.audio_reanchored();
            }
            let pcm = &block.samples[..480 * block.channels as usize];
            let rms =
                (pcm.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / pcm.len() as f64).sqrt();
            let tone = (self.numbered_markers && rms > 2000.0)
                .then(|| audio_label(pcm, block.channels as usize))
                .flatten();
            if rms <= 2000.0 {
                self.audio_receipt_seen = false;
                self.audio_accepted_seen = false;
            }
            let accepted = if let Some(stamp) = stamp {
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
                p.marker(
                    false,
                    rms > 2000.0,
                    origin,
                    stamp,
                    pull,
                    timestamp(self.recording_clock, stamp),
                );
                let tail = AudioTail {
                    stamp,
                    generation: block.generation,
                    sequence: block.sequence,
                    channels: block.channels,
                    epoch: self.audio.epoch(),
                };
                let accepted = self.audio.push_traced(stamp, block, tone);
                if accepted {
                    self.last_audio = Some(tail);
                }
                accepted
            } else {
                false
            };
            if let Some(label) = tone {
                if accepted && !self.audio_accepted_seen {
                    if let Some(packed) = pack_pulse(label, now) {
                        self.accepted_audio_pulse.store(packed, Ordering::Release);
                    }
                }
                if (!self.audio_receipt_seen || (accepted && !self.audio_accepted_seen))
                    && self.audio_markers.len() < 512
                {
                    self.audio_markers.push(json!({"id_mod16":label,"publication_epoch":self.audio.epoch(),"received_us":now,"binding_since_us":p.since_us,"output_accepted":accepted,"scheduled_target_ns":stamp.map(|s| timestamp(self.recording_clock,s))}));
                }
                self.audio_receipt_seen = true;
                self.audio_accepted_seen |= accepted;
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
                if frame.value.packet_capture_ntp_us() > 0 {
                    m.video_packet_capture_nonzero += 1;
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
                let label = (self.numbered_markers && mean > 180.0 && !m.video_active)
                    .then(|| {
                        decode_label(luma, buffer.width(), buffer.height(), buffer.strides().0)
                    })
                    .flatten();
                if let Some(label) = label {
                    if let Some(packed) = pack_pulse(label, rtc) {
                        self.input_pulse.store(packed, Ordering::Release);
                    }
                }
                let sid = self.playback.video_binding.as_ref().unwrap().0.clone();
                let origin = if self.capture_scheduling {
                    let ssrc = self.playback.video_binding.as_ref().unwrap().1;
                    let origin = frame.value.packet_capture_sender_ntp_us(ssrc);
                    if origin > 0 {
                        self.playback.startup_note("video_clock_ready", rtc);
                        Some(origin)
                    } else {
                        None
                    }
                } else {
                    self.playback
                        .video_origin(&sid, frame.value.timestamp(), rtc)
                };
                let target = self.playback.clock.video(origin, frame.at);
                let accepted = if let Some(stamp) = target {
                    self.playback.startup_note("first_video_scheduled", rtc);
                    self.playback.marker(
                        true,
                        mean > 180.0,
                        origin,
                        stamp,
                        frame.at,
                        timestamp(self.recording_clock, stamp),
                    );
                    self.video.push_traced(stamp, frame.value, label)
                } else {
                    false
                };
                if let Some(label) = label {
                    if accepted {
                        if let Some(packed) = pack_pulse(label, rtc) {
                            self.accepted_video_pulse.store(packed, Ordering::Release);
                        }
                    }
                    if self.input_markers.len() < 256 {
                        self.input_markers.push(json!({"label":label,"publication_epoch":self.video.epoch(),"received_us":rtc,"binding_since_us":self.playback.since_us,"scheduled_target_ns":target.map(|s| timestamp(self.recording_clock,s)),"output_accepted":accepted,"clock_rejection":self.playback.clock.last_video_rejection()}));
                    }
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

fn pack_pulse(label: u8, rtc_us: i64) -> Option<u64> {
    let rtc = u64::try_from(rtc_us).ok()?;
    (rtc > 0 && rtc <= (u64::MAX >> 8)).then_some((rtc << 8) | u64::from(label))
}

fn match_queued_pulses(video: u64, audio: u64) -> Option<(u8, i64, i64)> {
    if video == 0 || audio == 0 {
        return None;
    }
    let (v, a) = ((video >> 8) as i64, (audio >> 8) as i64);
    ((video as u8) % 16 == audio as u8 && v.abs_diff(a) <= 120_000).then_some((video as u8, v, a))
}

// Generated fixture tones only. No voice inference; ten-millisecond PCM retains
// its original timestamp and is never changed by this diagnostic.
fn audio_label(pcm: &[i16], channels: usize) -> Option<u8> {
    if ![1, 2].contains(&channels) || pcm.len() != 480 * channels {
        return None;
    }
    let mut scores = [0.0; 16];
    for (id, score) in scores.iter_mut().enumerate() {
        let coefficient =
            2.0 * (2.0 * std::f64::consts::PI * (997.0 + 128.0 * id as f64) / 48000.0).cos();
        let (mut s1, mut s2) = (0.0, 0.0);
        for frame in pcm.chunks_exact(channels) {
            let s0 = f64::from(frame[0]) + coefficient * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        *score = (s1 * s1 + s2 * s2 - coefficient * s1 * s2).max(0.0);
    }
    let mut ranked: Vec<_> = scores.iter().enumerate().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(a.1));
    (*ranked[0].1 > 0.0 && *ranked[0].1 > 2.0 * ranked[1].1).then_some(ranked[0].0 as u8)
}

fn decode_label(luma: &[u8], width: u32, height: u32, stride: u32) -> Option<u8> {
    if width != 320 || height != 180 || stride < width {
        return None;
    }
    let mut label = 0;
    for bit in 0..8 {
        if *luma.get(8 * stride as usize + bit * 40 + 20)? > 180 {
            label |= 1 << bit;
        }
    }
    Some(label)
}

fn timestamp(base: (Instant, u64), at: Instant) -> u64 {
    base.1 + at.saturating_duration_since(base.0).as_nanos() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transition_tail_contains_only_two_silent_frames_at_original_sample_positions() {
        let now = Instant::now();
        let last = AudioTail {
            stamp: now,
            generation: 7,
            sequence: 100,
            channels: 2,
            epoch: 3,
        };
        let tail = last.frames().unwrap();
        for (i, (target, block)) in tail.iter().enumerate() {
            assert_eq!(*target, now + Duration::from_millis((i as u64 + 1) * 10));
            assert_eq!(block.sequence, 101 + i as u64);
            assert_eq!(block.generation, 7);
            assert_eq!(block.channels, 2);
            assert!(block.samples.iter().all(|s| *s == 0));
            assert!(block.muted);
            assert_eq!(block.ssrc, 0);
            assert_eq!(block.rtp_timestamp, 0);
            assert_eq!(block.pull_us, 0);
        }
        assert!(AudioTail {
            sequence: u64::MAX,
            ..last
        }
        .frames()
        .is_none());
    }
    use crate::{delivery_worker::Deadline, queue::Captured};
    #[test]
    fn marker_receipt_label_honors_stride_and_rejects_invalid_buffers() {
        let mut luma = vec![16; 336 * 180];
        for bit in [0, 2, 7] {
            luma[8 * 336 + bit * 40 + 20] = 235;
        }
        assert_eq!(decode_label(&luma, 320, 180, 336), Some(133));
        assert_eq!(decode_label(&luma, 640, 180, 336), None);
        assert_eq!(decode_label(&luma[..20], 320, 180, 336), None);
        assert_eq!(decode_label(&luma, 320, 180, 319), None);
    }
    #[test]
    fn pulse_receipt_packing_is_coherent_and_rejects_invalid_time() {
        assert_eq!(
            pack_pulse(133, 9_000_000).map(|p| (p as u8, (p >> 8) as i64)),
            Some((133, 9_000_000))
        );
        assert_eq!(pack_pulse(0, 0), None);
        assert_eq!(pack_pulse(0, -1), None);
        assert_eq!(pack_pulse(0, i64::MAX), None);
    }
    #[test]
    fn queued_pulse_pairs_reject_other_labels_and_old_cycles() {
        let v = pack_pulse(23, 1_000_000).unwrap();
        assert_eq!(
            match_queued_pulses(v, pack_pulse(7, 1_080_000).unwrap()),
            Some((23, 1_000_000, 1_080_000))
        );
        assert_eq!(
            match_queued_pulses(v, pack_pulse(8, 1_080_000).unwrap()),
            None
        );
        assert_eq!(
            match_queued_pulses(v, pack_pulse(7, 33_000_000).unwrap()),
            None
        );
        assert_eq!(match_queued_pulses(v, 0), None);
    }
    #[test]
    fn generated_audio_labels_are_exact_and_do_not_modify_pcm() {
        for id in 0..16 {
            let pcm: Vec<i16> = (0..480)
                .map(|n| {
                    (12000.0
                        * (2.0 * std::f64::consts::PI * (997.0 + 128.0 * id as f64) * n as f64
                            / 48000.0)
                            .sin()) as i16
                })
                .collect();
            let original = pcm.clone();
            assert_eq!(audio_label(&pcm, 1), Some(id));
            assert_eq!(pcm, original);
            let stereo: Vec<i16> = pcm.iter().flat_map(|n| [*n, *n]).collect();
            assert_eq!(audio_label(&stereo, 2), Some(id));
        }
        assert_eq!(audio_label(&[0; 480], 1), None);
        assert_eq!(audio_label(&[0; 12], 1), None);
        assert_eq!(audio_label(&[0; 480], 0), None);
    }
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
                    capture_sender_ntp_us: 0,
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
