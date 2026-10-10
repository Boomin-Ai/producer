//! Explicit opt-in native microphone to loopback SFU publication prototype.
//! Final speaker reference is the lab clip only; RTC return playout is not wired.
use crate::{
    capture_fixture::Evidence,
    capture_handoff::{Handoff, MicrophoneProcessor, ProcessedBlock},
    physical_device::{Block, Device},
};
use anyhow::{ensure, Result};
use livekit::webrtc::{
    audio_source::native::NativeAudioSource, prelude::*, video_source::native::NativeVideoSource,
};
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
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
}
pub fn enabled() -> bool {
    std::env::var("LIVEKIT_LAB_PHYSICAL_CAPTURE").as_deref() == Ok("1")
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
}
impl Drop for Owner {
    fn drop(&mut self) {
        // First stop callbacks, then retire all voice pending for this generation.
        let lifecycle = self.device.close();
        self.handoff.retire();
        let target = (self.published * 95).div_ceil(100);
        let mut count = 0;
        let p95 = self.sdk_age_ms.iter().position(|n| {
            count += n;
            self.published > 0 && count >= target
        });
        *self.evidence.lock().unwrap_or_else(|p| p.into_inner()) = json!({
            "enabled":true,"input":"physical native I/O microphone","hardware_capture_used":self.processed>0,
            "physical_speaker_playout_used":self.render_blocks>0,"reference_scope":"bundled lab clip final output; remote RTC audio is not played or included",
            "physical_microphone_published_to_loopback_only":self.published>0,"sdk_aec_ns_agc":false,
            "aec_enforced_high_pass":self.processor.high_pass_filter_enforced(),"processed":self.processed,"published":self.published,
            "render_blocks":self.render_blocks,"maximum_sdk_capture_us":self.max_sdk_us,"maximum_owner_tick_gap_us":self.max_tick_us,
            "capture_to_sdk_p95_ms_upper_bucket":p95,"maximum_capture_to_sdk_us":self.maximum_sdk_age_us,
            "capture_hold_retired":self.pending_retired,
            "capture_timing_last_blocks":self.capture_timing,"capture_timing_capacity":64,
            "first_capture_age_before_apm_us":self.first_capture_age_us,
            "maximum_reverse_apm_us":self.max_reverse_us,"maximum_capture_apm_us":self.max_capture_us,"sdk_submission_unconfirmed_at_shutdown":self.sdk_submission_unconfirmed,"handoff":self.handoff.report(),"native_lifecycle":lifecycle,
            "video":"generated black frame, not a physical camera","capture_rtp_alignment_qualified":false,
            "full_monitor_reference_qualified":false,"physical_aec_qualified":false,"g1_complete":false});
    }
}
pub async fn run(
    audio: NativeAudioSource,
    video: NativeVideoSource,
    evidence: Evidence,
) -> Result<()> {
    preflight()?;
    let processor = MicrophoneProcessor::new()?;
    let (device, _) = Device::new(&speech()?, true)?;
    let mut owner = Owner {
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
    };
    let mut pending: Option<Block> = None;
    let mut pending_since = Instant::now();
    let mut latest_render: Option<u64> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let began = Instant::now();
    let mut last_tick = began;
    let mut last_video = None;
    loop {
        tick.tick().await;
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
            latest_render = Some(block.host_ns);
            owner.render_blocks += 1;
        }
        if let Some(render) = latest_render {
            for _ in 0..32 {
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
                owner.handoff.push(
                    ProcessedBlock {
                        host_ns: block.host_ns,
                        samples,
                    },
                    Instant::now(),
                )?;
            }
        }
        if let Some(block) = owner.handoff.pop_due(Instant::now())? {
            let host_now = unsafe { lab_audio_now_ns() };
            ensure!(
                host_now >= block.host_ns,
                "Capture timestamp is in the future"
            );
            let age = (host_now - block.host_ns) / 1000;
            let sdk_started = Instant::now();
            owner.sdk_submission_unconfirmed = true;
            audio
                .capture_frame(&AudioFrame {
                    data: Cow::Borrowed(&block.samples),
                    sample_rate: 48000,
                    num_channels: 1,
                    samples_per_channel: 480,
                })
                .await?;
            owner.sdk_submission_unconfirmed = false;
            owner.max_sdk_us = owner
                .max_sdk_us
                .max(sdk_started.elapsed().as_micros() as u64);
            owner.maximum_sdk_age_us = owner.maximum_sdk_age_us.max(age);
            owner.sdk_age_ms[(age.div_ceil(1000) as usize).min(349)] += 1;
            owner.published += 1;
        }
        let slot = (began.elapsed().as_secs_f64() * 30.0) as u64;
        if last_video != Some(slot) {
            last_video = Some(slot);
            let mut buffer = I420Buffer::new(320, 180);
            let (y, u, v) = buffer.data_mut();
            y.fill(16);
            u.fill(128);
            v.fill(128);
            video.capture_frame(&VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: began.elapsed().as_micros() as i64,
                frame_metadata: None,
                buffer,
            });
        }
    }
}
