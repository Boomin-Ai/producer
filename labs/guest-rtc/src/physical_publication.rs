//! Explicit opt-in native microphone to loopback SFU publication prototype.
//! Opt-in selected guest monitor uses final native output as its AEC reference.
use crate::{
    capture_fixture::Evidence,
    capture_handoff::{Handoff, MicrophoneProcessor, ProcessedBlock},
    physical_device::{Block, Device},
};
use anyhow::{ensure, Result};
use futures_util::FutureExt;
use livekit::webrtc::{
    audio_source::native::NativeAudioSource, prelude::*, video_source::native::NativeVideoSource,
};
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    borrow::Cow,
    ffi::{c_char, c_void, CStr},
    path::PathBuf,
    time::{Duration, Instant},
};
unsafe extern "C" {
    fn lab_permission(request: i32) -> i32;
    fn lab_audio_faults(handle: *mut c_void) -> u64;
    fn lab_audio_fault_detail(handle: *mut c_void, message: *mut c_char, length: usize);
    fn lab_audio_now_ns() -> u64;
    fn lab_publisher_thread_qos(previous: *mut i32, effective: *mut i32) -> i32;
    fn lab_publisher_wait_until_ns(host_ns: u64) -> i32;
}
pub fn enabled() -> bool {
    std::env::var("LIVEKIT_LAB_PHYSICAL_CAPTURE").as_deref() == Ok("1")
}
pub fn monitor_enabled() -> bool {
    enabled() && std::env::var("LIVEKIT_LAB_GUEST_MONITOR").as_deref() == Ok("1")
}
fn speech() -> Result<Vec<i16>> {
    let path = PathBuf::from(
        std::env::var_os("LIVEKIT_LAB_PHYSICAL_SPEECH").ok_or_else(|| {
            anyhow::anyhow!("Physical capture requires explicit LIVEKIT_LAB_PHYSICAL_SPEECH")
        })?,
    );
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    ensure!(
        spec.sample_rate == 48000
            && spec.channels == 1
            && spec.bits_per_sample == 16
            && spec.sample_format == hound::SampleFormat::Int,
        "Physical reference must be 48 kHz mono PCM16"
    );
    ensure!(
        reader.len() > 0 && reader.len() <= 48000 * 120,
        "Reference must be at most 120 seconds"
    );
    Ok(reader
        .samples::<i16>()
        .collect::<std::result::Result<Vec<_>, _>>()?)
}
pub fn preflight() -> Result<()> {
    ensure!(
        std::env::var("LIVEKIT_LAB_BATCHED_CAPTURE").as_deref() != Ok("1"),
        "Physical and synthetic batched capture cannot both be enabled"
    );
    ensure!(unsafe {lab_permission(0)}==1,"Physical microphone permission is required before connecting; this command will not prompt or start capture implicitly");
    speech()?;
    Ok(())
}
#[derive(Serialize)]
struct CaptureTiming {
    host_ns: u64,
    age_before_apm_us: i64,
    processing_us: u64,
}
struct Owner {
    device: Device,
    processor: MicrophoneProcessor,
    handoff: Handoff,
    evidence: Evidence,
    processed: u64,
    published: u64,
    render_blocks: u64,
    max_sdk_us: u64,
    max_tick_us: u64,
    sdk_age_ms: [u64; 350],
    maximum_sdk_age_us: u64,
    pending_retired: bool,
    capture_timing: VecDeque<CaptureTiming>,
    first_capture_age_us: Option<i64>,
    max_reverse_us: u64,
    max_capture_us: u64,
    sdk_submission_unconfirmed: bool,
    previous_qos: i32,
    effective_qos: i32,
    max_video_us: u64,
    generations: Vec<serde_json::Value>,
    awaiting_fresh_capture: bool,
    discarded_stale_capture: u64,
    rejected_processed_blocks: u64,
    last_reference: Option<[i16; 480]>,
    monitor_evidence: Option<Arc<crate::guest_monitor::Monitor>>,
    monitor_progress: Vec<serde_json::Value>,
}
impl Owner {
    fn new(device: Device, processor: MicrophoneProcessor, evidence: Evidence) -> Self {
        Self {
            device,
            processor,
            handoff: Handoff::new(),
            evidence,
            processed: 0,
            published: 0,
            render_blocks: 0,
            max_sdk_us: 0,
            max_tick_us: 0,
            sdk_age_ms: [0; 350],
            maximum_sdk_age_us: 0,
            pending_retired: false,
            capture_timing: VecDeque::with_capacity(64),
            first_capture_age_us: None,
            max_reverse_us: 0,
            max_capture_us: 0,
            sdk_submission_unconfirmed: false,
            previous_qos: 0,
            effective_qos: 0,
            max_video_us: 0,
            generations: Vec::with_capacity(32),
            awaiting_fresh_capture: true,
            discarded_stale_capture: 0,
            rejected_processed_blocks: 0,
            last_reference: None,
            monitor_evidence: None,
            monitor_progress: Vec::with_capacity(301),
        }
    }

    fn restart_after_deadline(&mut self) -> Result<()> {
        ensure!(
            self.handoff.deadline_missed(),
            "Only an explicitly retired deadline generation can recover"
        );
        ensure!(
            self.generations.len() < 32,
            "Physical publication exceeded its bounded recovery history; stop and inspect"
        );
        ensure!(
            !self.sdk_submission_unconfirmed,
            "Cannot recover an unconfirmed SDK submission"
        );
        self.handoff.retire();
        self.generations.push(self.handoff.report());
        self.handoff = Handoff::new();
        self.processor = MicrophoneProcessor::new()?;
        if let Some(reference) = self.last_reference {
            self.processor.reverse(&reference)?;
        }
        self.awaiting_fresh_capture = true;
        println!(
            "Physical audio deadline recovery {}: old voice retired; waiting for fresh capture",
            self.generations.len()
        );
        Ok(())
    }
    fn submit_due(&mut self, audio: &NativeAudioSource) -> Result<()> {
        let due = match self.handoff.pop_due(Instant::now()) {
            Ok(block) => block,
            Err(error) => {
                if !self.handoff.deadline_missed() {
                    return Err(error);
                }
                self.restart_after_deadline()?;
                return Ok(());
            }
        };
        if let Some(block) = due {
            let host_now = unsafe { lab_audio_now_ns() };
            ensure!(
                host_now >= block.host_ns,
                "Capture timestamp is in the future"
            );
            let age = (host_now - block.host_ns) / 1000;
            let sdk_started = Instant::now();
            self.sdk_submission_unconfirmed = true;
            audio
                .capture_frame(&AudioFrame {
                    data: Cow::Borrowed(&block.samples),
                    sample_rate: 48000,
                    num_channels: 1,
                    samples_per_channel: 480,
                })
                .now_or_never()
                .ok_or_else(|| {
                    anyhow::anyhow!("Zero-queue SDK capture unexpectedly became asynchronous")
                })??;
            self.sdk_submission_unconfirmed = false;
            self.max_sdk_us = self
                .max_sdk_us
                .max(sdk_started.elapsed().as_micros() as u64);
            self.maximum_sdk_age_us = self.maximum_sdk_age_us.max(age);
            self.sdk_age_ms[(age.div_ceil(1000) as usize).min(349)] += 1;
            self.published += 1;
        }
        Ok(())
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        // First stop callbacks, then retire all voice pending for this generation.
        let monitor_native = self
            .monitor_evidence
            .as_ref()
            .map(|_| self.device.monitor_stats());
        let monitor_inbox = self.monitor_evidence.as_ref().map(|monitor| {
            monitor.stop();
            monitor.stats()
        });
        let lifecycle = self.device.close();
        self.handoff.retire();
        let target = (self.published * 95).div_ceil(100);
        let mut count = 0;
        let p95 = self.sdk_age_ms.iter().position(|n| {
            count += n;
            self.published > 0 && count >= target
        });
        let mut report = json!({
            "enabled":true,"input":"physical native I/O microphone","hardware_capture_used":self.processed>0,
            "physical_speaker_playout_used":self.render_blocks>0,"reference_scope":if self.monitor_evidence.is_some(){"selected remote guest-1 final native output; local microphone excluded"}else{"bundled lab clip final output; remote RTC audio is not played or included"},
            "guest_monitor":{"progress":self.monitor_progress,"inbox":monitor_inbox,"native":monitor_native,"full_room_monitor_qualified":false},
            "physical_microphone_published_to_loopback_only":self.published>0,"sdk_aec_ns_agc":false,
            "aec_enforced_high_pass":self.processor.high_pass_filter_enforced(),"processed":self.processed,"published":self.published,
            "publisher_timing_owner":"dedicated native absolute-wait loop", "publisher_previous_qos":self.previous_qos,"publisher_effective_qos":self.effective_qos,"publisher_qos_scope":"only this disposable thread; joined on shutdown, not a realtime-workgroup claim","maximum_video_capture_us":self.max_video_us,
            "publication_generations_retired":self.generations,"generation_history_capacity":32,
            "deadline_recoveries":self.generations.len(),"awaiting_fresh_capture_at_shutdown":self.awaiting_fresh_capture,
            "discarded_stale_capture_blocks":self.discarded_stale_capture,"rejected_processed_blocks":self.rejected_processed_blocks,
            "deadline_recovery_qualified":false});
        let timing = json!({"render_blocks":self.render_blocks,"maximum_sdk_capture_us":self.max_sdk_us,"maximum_owner_tick_gap_us":self.max_tick_us,
            "capture_to_sdk_p95_ms_upper_bucket":p95,"capture_to_sdk_clock_target_ms":25,"maximum_capture_to_sdk_us":self.maximum_sdk_age_us,
            "capture_hold_retired":self.pending_retired,
            "capture_timing_last_blocks":self.capture_timing,"capture_timing_capacity":64,
            "first_capture_age_before_apm_us":self.first_capture_age_us,
            "maximum_reverse_apm_us":self.max_reverse_us,"maximum_capture_apm_us":self.max_capture_us,"sdk_submission_unconfirmed_at_shutdown":self.sdk_submission_unconfirmed,"handoff":self.handoff.report(),"native_lifecycle":lifecycle,
            "video":"generated black frame, not a physical camera","capture_rtp_alignment_qualified":false,
            "full_monitor_reference_qualified":false,"physical_aec_qualified":false,"g1_complete":false});
        report
            .as_object_mut()
            .unwrap()
            .extend(timing.as_object().unwrap().clone());
        *self.evidence.lock().unwrap_or_else(|p| p.into_inner()) = report;
    }
}
pub fn run(
    audio: NativeAudioSource,
    video: NativeVideoSource,
    evidence: Evidence,
    stop: Arc<AtomicBool>,
    monitor: Arc<crate::guest_monitor::Monitor>,
) -> Result<()> {
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    preflight()?;
    let reference = speech()?;
    let processor = MicrophoneProcessor::new()?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    let (device, _) = if monitor_enabled() {
        Device::new_monitor()?
    } else {
        Device::new(&reference, true)?
    };
    let mut owner = Owner::new(device, processor, evidence);
    if monitor_enabled() {
        monitor.activate();
        owner.monitor_evidence = Some(monitor.clone());
    }
    let mut pending: Option<Block> = None;
    let mut pending_since = Instant::now();
    let mut latest_render: Option<u64> = None;
    ensure!(
        unsafe { lab_publisher_thread_qos(&mut owner.previous_qos, &mut owner.effective_qos) } == 0,
        "Could not configure physical publisher thread QoS"
    );
    let mut next_wake = unsafe { lab_audio_now_ns() };
    let began = Instant::now();
    let mut last_tick = began;
    let mut last_video = None;
    let mut next_monitor_snapshot = Instant::now();
    let video_buffer = I420Buffer::new_black(320, 180);
    while !stop.load(Ordering::Acquire) {
        ensure!(
            unsafe { lab_publisher_wait_until_ns(next_wake) } == 0,
            "Native publisher wait failed"
        );
        if stop.load(Ordering::Acquire) {
            break;
        }
        let host_now = unsafe { lab_audio_now_ns() };
        // Maintain a single absolute 1 ms schedule and skip missed wakeups.
        // Neither this clock nor the handoff's capture anchor is reset on stalls.
        next_wake += ((host_now.saturating_sub(next_wake) / 1_000_000) + 1) * 1_000_000;
        let now = Instant::now();
        owner.max_tick_us = owner
            .max_tick_us
            .max(now.duration_since(last_tick).as_micros() as u64);
        last_tick = now;
        if unsafe { lab_audio_faults(owner.device.handle) } != 0 {
            let mut message = [0i8; 512];
            unsafe {
                lab_audio_fault_detail(owner.device.handle, message.as_mut_ptr(), message.len())
            };
            anyhow::bail!(
                "Native capture: {}",
                unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy()
            );
        }
        owner.submit_due(&audio)?;
        if owner.monitor_evidence.is_some() {
            // At most 30 ms queued in native output. Input callback copies only
            // the selected remote guest; hardware callback consumes lock-free.
            if owner.device.monitor_pending() < 3 {
                let (generation, frame) = monitor.pop(Instant::now());
                owner.device.monitor_generation(generation);
                if let Some(frame) = frame {
                    let now = unsafe { lab_audio_now_ns() };
                    let age = frame.at.elapsed().as_nanos() as u64;
                    ensure!(now >= age, "Monitor delivery clock could not be mapped");
                    ensure!(
                        owner.device.monitor_push(
                            &Block {
                                host_ns: now - age,
                                samples: frame.samples
                            },
                            frame.generation
                        ),
                        "Native guest monitor overflow"
                    );
                }
            } else {
                // Apply invalidation even while native output is full.
                // pop would consume PCM, so use the separately observed epoch.
                owner.device.monitor_generation(monitor.generation());
            }
        }
        if owner.monitor_evidence.is_some() && Instant::now() >= next_monitor_snapshot {
            if owner.monitor_progress.len() < 301 {
                owner.monitor_progress.push(json!({"at_ms":began.elapsed().as_millis(),"inbox":monitor.stats(),"native":owner.device.monitor_stats()}));
            }
            next_monitor_snapshot = Instant::now() + Duration::from_secs(1);
        }
        for _ in 0..32 {
            let Some(block) = owner.device.pop(true) else {
                break;
            };
            ensure!(
                latest_render.is_none_or(|previous| block.host_ns > previous),
                "Reference clock regressed"
            );
            let reverse_started = Instant::now();
            owner.processor.reverse(&block.samples)?;
            owner.max_reverse_us = owner
                .max_reverse_us
                .max(reverse_started.elapsed().as_micros() as u64);
            owner.last_reference = Some(block.samples);
            latest_render = Some(block.host_ns);
            owner.render_blocks += 1;
        }
        if let Some(render) = latest_render {
            // At most one microphone block per turn: do not age already-due
            // output by draining an APM batch before submitting it.
            for _ in 0..1 {
                let waiting = pending.is_some();
                let Some(block) = pending.take().or_else(|| owner.device.pop(false)) else {
                    break;
                };
                if !waiting {
                    pending_since = Instant::now();
                }
                owner.pending_retired = false;
                if render < block.host_ns {
                    owner.pending_retired = true;
                    ensure!(
                        pending_since.elapsed() < Duration::from_millis(80),
                        "Reference did not catch up within 80 ms"
                    );
                    pending = Some(block);
                    break;
                }
                let delay = (render - block.host_ns) / 1_000_000;
                ensure!(delay <= 500, "Invalid APM delay");
                let mut samples = block.samples;
                let age = ((i128::from(unsafe { lab_audio_now_ns() }) - i128::from(block.host_ns))
                    / 1000) as i64;
                if owner.awaiting_fresh_capture && age > 30_000 {
                    owner.discarded_stale_capture += 1;
                    continue;
                }
                owner.first_capture_age_us.get_or_insert(age);
                let processing_started = Instant::now();
                owner.processor.capture(&mut samples, delay as i32)?;
                let processing_us = processing_started.elapsed().as_micros() as u64;
                owner.max_capture_us = owner.max_capture_us.max(processing_us);
                if owner.capture_timing.len() == 64 {
                    owner.capture_timing.pop_front();
                }
                owner.capture_timing.push_back(CaptureTiming {
                    host_ns: block.host_ns,
                    age_before_apm_us: age,
                    processing_us,
                });
                owner.processed += 1;
                if owner.awaiting_fresh_capture {
                    let clock_now = unsafe { lab_audio_now_ns() };
                    ensure!(
                        clock_now >= block.host_ns,
                        "Capture host timestamp is in the future"
                    );
                    let capture_instant = Instant::now()
                        .checked_sub(Duration::from_nanos(clock_now - block.host_ns))
                        .ok_or_else(|| {
                            anyhow::anyhow!("Capture clock could not be mapped to owner Instant")
                        })?;
                    owner.handoff = Handoff::with_capture_anchor(
                        block.host_ns,
                        capture_instant + Duration::from_millis(25),
                    );
                }
                if let Err(error) = owner.handoff.push(
                    ProcessedBlock {
                        host_ns: block.host_ns,
                        samples,
                    },
                    Instant::now(),
                ) {
                    owner.rejected_processed_blocks += 1;
                    if !owner.handoff.deadline_missed() {
                        return Err(error);
                    }
                    owner.restart_after_deadline()?;
                } else {
                    owner.awaiting_fresh_capture = false;
                }
            }
        }
        let slot = (began.elapsed().as_secs_f64() * 30.0) as u64;
        if last_video != Some(slot) {
            last_video = Some(slot);
            let video_started = Instant::now();
            video.capture_frame(&VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: began.elapsed().as_micros() as i64,
                frame_metadata: None,
                buffer: &video_buffer,
            });
            owner.max_video_us = owner
                .max_video_us
                .max(video_started.elapsed().as_micros() as u64);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner_without_devices() -> Owner {
        Owner::new(
            Device {
                handle: std::ptr::null_mut(),
            },
            MicrophoneProcessor::new().unwrap(),
            Arc::new(std::sync::Mutex::new(json!({}))),
        )
    }
    #[test]
    fn deadline_recovery_clears_old_voice_and_requires_a_new_fresh_generation() {
        let mut owner = owner_without_devices();
        let now = Instant::now();
        for n in 0..2 {
            owner
                .handoff
                .push(
                    ProcessedBlock {
                        host_ns: n * 10_000_000,
                        samples: [11; 480],
                    },
                    now,
                )
                .unwrap();
        }
        assert!(owner
            .handoff
            .pop_due(now + Duration::from_millis(100))
            .is_err());
        owner.restart_after_deadline().unwrap();
        assert!(owner.awaiting_fresh_capture);
        assert_eq!(owner.generations.len(), 1);
        assert_eq!(owner.generations[0]["retired_pending"], 2);
        assert_eq!(owner.generations[0]["pending"], 0);
        owner
            .handoff
            .push(
                ProcessedBlock {
                    host_ns: 200_000_000,
                    samples: [77; 480],
                },
                now + Duration::from_millis(200),
            )
            .unwrap();
        let fresh = owner
            .handoff
            .pop_due(now + Duration::from_millis(210))
            .unwrap()
            .unwrap();
        assert_eq!(fresh.samples, [77; 480]);
        assert_eq!(fresh.host_ns, 200_000_000);
    }
    #[test]
    fn recovery_cannot_hide_timestamp_faults_or_unbounded_restarts() {
        let mut owner = owner_without_devices();
        let now = Instant::now();
        owner
            .handoff
            .push(
                ProcessedBlock {
                    host_ns: 0,
                    samples: [0; 480],
                },
                now,
            )
            .unwrap();
        assert!(owner
            .handoff
            .push(
                ProcessedBlock {
                    host_ns: 0,
                    samples: [0; 480]
                },
                now
            )
            .is_err());
        assert!(owner.restart_after_deadline().is_err());
        assert!(owner.generations.is_empty());
        owner.handoff = Handoff::new();
        owner
            .handoff
            .push(
                ProcessedBlock {
                    host_ns: 0,
                    samples: [0; 480],
                },
                now,
            )
            .unwrap();
        assert!(owner
            .handoff
            .pop_due(now + Duration::from_millis(100))
            .is_err());
        owner.generations = vec![json!({}); 32];
        assert!(owner.restart_after_deadline().is_err());
        assert_eq!(owner.generations.len(), 32);
    }
    #[test]
    fn pinned_zero_queue_sdk_capture_completes_on_its_owner_without_a_runtime() {
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
        let samples = [0i16; 480];
        for _ in 0..32 {
            audio
                .capture_frame(&AudioFrame {
                    data: Cow::Borrowed(&samples),
                    sample_rate: 48000,
                    num_channels: 1,
                    samples_per_channel: 480,
                })
                .now_or_never()
                .expect("Zero-queue source must not need an async executor")
                .unwrap();
        }
    }
    #[tokio::test]
    async fn stopped_before_start_does_not_request_permission_or_open_a_device() {
        let evidence = Arc::new(std::sync::Mutex::new(json!({"enabled":false})));
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
        run(
            audio,
            video,
            evidence.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(crate::guest_monitor::Monitor::new()),
        )
        .unwrap();
        assert_eq!(*evidence.lock().unwrap(), json!({"enabled":false}));
    }
}
