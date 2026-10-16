//! Generated 100 ms capture batches through the same AEC owner and paced SDK
//! handoff intended for hardware. No microphone or speaker device is opened.
use crate::capture_handoff::{Handoff, MicrophoneProcessor, ProcessedBlock, BLOCK_NS};
use anyhow::{ensure, Result};
use livekit::webrtc::{
    audio_source::native::NativeAudioSource, prelude::*, video_source::native::NativeVideoSource,
};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub type Evidence = Arc<Mutex<Value>>;
struct Owner {
    processor: MicrophoneProcessor,
    handoff: Handoff,
    evidence: Evidence,
    processed: u64,
    published: u64,
    max_processing_us: u64,
    max_sdk_capture_us: u64,
    max_video_capture_us: u64,
    max_batch_processing_us: u64,
    max_owner_tick_gap_us: u64,
}
impl Drop for Owner {
    fn drop(&mut self) {
        // Also runs on async cancellation/error. No voice remains queued for a
        // later destination or publication generation.
        self.handoff.retire();
        *self.evidence.lock().unwrap_or_else(|p| p.into_inner()) = json!({
            "enabled":true,"input":"generated 48k mono PCM in ten-block batches",
            "hardware_capture_used":false,"physical_speaker_playout_used":false,
            "aec_reference":"generated silence; no physical AEC claim",
            "aec_enforced_high_pass":self.processor.high_pass_filter_enforced(),
            "sdk_aec_ns_agc":false,"processed":self.processed,"published":self.published,
            "maximum_apm_processing_us":self.max_processing_us,
            "maximum_sdk_capture_us":self.max_sdk_capture_us,
            "maximum_video_capture_us":self.max_video_capture_us,
            "maximum_batch_processing_us":self.max_batch_processing_us,
            "maximum_owner_tick_gap_us":self.max_owner_tick_gap_us,
            "handoff":self.handoff.report(),"fixture_content_delay_ms":110,
            "capture_rtp_alignment_qualified":false,"g1_complete":false});
    }
}
pub async fn run(
    audio: NativeAudioSource,
    video: NativeVideoSource,
    evidence: Evidence,
) -> Result<()> {
    let mut owner = Owner {
        processor: MicrophoneProcessor::new()?,
        handoff: Handoff::new(),
        evidence,
        processed: 0,
        published: 0,
        max_processing_us: 0,
        max_sdk_capture_us: 0,
        max_video_capture_us: 0,
        max_batch_processing_us: 0,
        max_owner_tick_gap_us: 0,
    };
    let began = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut batch = 0u64;
    let mut last_video = 0;
    let mut previous_tick = began;
    loop {
        tick.tick().await;
        let now = Instant::now();
        owner.max_owner_tick_gap_us = owner
            .max_owner_tick_gap_us
            .max(now.duration_since(previous_tick).as_micros() as u64);
        previous_tick = now;
        let elapsed = now.duration_since(began);
        let batch_due = Duration::from_millis((batch + 1) * 100);
        if elapsed >= batch_due {
            let batch_started = Instant::now();
            ensure!(
                elapsed <= batch_due + Duration::from_millis(20),
                "Synthetic capture owner stalled; no catch-up batch"
            );
            for n in batch * 10..batch * 10 + 10 {
                let mut block = ProcessedBlock {
                    host_ns: n * BLOCK_NS,
                    samples: [0; 480],
                };
                for (i, sample) in block.samples.iter_mut().enumerate() {
                    let t = (n as usize * 480 + i) as f64 / 48000.0;
                    if (0.5..0.62).contains(&(t % 2.0)) {
                        *sample = (13100.0 * (2.0 * std::f64::consts::PI * 997.0 * t).sin()) as i16;
                    }
                }
                let processing = Instant::now();
                owner.processor.reverse(&[0; 480])?;
                owner.processor.capture(&mut block.samples, 0)?;
                owner.max_processing_us = owner
                    .max_processing_us
                    .max(processing.elapsed().as_micros() as u64);
                owner.processed += 1;
                owner.handoff.push(block, Instant::now())?;
            }
            batch += 1;
            owner.max_batch_processing_us = owner
                .max_batch_processing_us
                .max(batch_started.elapsed().as_micros() as u64);
        }
        if let Some(block) = owner.handoff.pop_due(Instant::now())? {
            let sdk_started = Instant::now();
            audio
                .capture_frame(&AudioFrame {
                    data: Cow::Borrowed(&block.samples),
                    sample_rate: 48000,
                    num_channels: 1,
                    samples_per_channel: 480,
                })
                .await?;
            owner.max_sdk_capture_us = owner
                .max_sdk_capture_us
                .max(sdk_started.elapsed().as_micros() as u64);
            owner.published += 1;
        }
        // Match generated video content to the fixture's deliberate 110 ms
        // startup offset. This is not a hardware camera/capture-clock mapping.
        let content = elapsed.as_secs_f64() - 0.110;
        if content >= 0.0 {
            let slot = (content * 30.0) as u64;
            if slot != last_video {
                last_video = slot;
                let mut buffer = I420Buffer::new(320, 180);
                let (y, u, v) = buffer.data_mut();
                y.fill(if (0.5..0.62).contains(&(content % 2.0)) {
                    235
                } else {
                    16
                });
                u.fill(128);
                v.fill(128);
                let sdk_started = Instant::now();
                video.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: content.mul_add(1e6, 0.0) as i64,
                    frame_metadata: None,
                    buffer,
                });
                owner.max_video_capture_us = owner
                    .max_video_capture_us
                    .max(sdk_started.elapsed().as_micros() as u64);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_failed_processing_clear_generation_and_release_owner_edges() {
        for failure in [false, true] {
            for _ in 0..20 {
                let evidence = Arc::new(Mutex::new(json!({})));
                {
                    let mut owner = Owner {
                        processor: MicrophoneProcessor::new().unwrap(),
                        handoff: Handoff::new(),
                        evidence: evidence.clone(),
                        processed: 0,
                        published: 0,
                        max_processing_us: 0,
                        max_sdk_capture_us: 0,
                        max_video_capture_us: 0,
                        max_batch_processing_us: 0,
                        max_owner_tick_gap_us: 0,
                    };
                    let now = Instant::now();
                    for n in 0..10 {
                        let mut samples = [0; 480];
                        owner.processor.reverse(&samples).unwrap();
                        owner.processor.capture(&mut samples, 0).unwrap();
                        owner
                            .handoff
                            .push(
                                ProcessedBlock {
                                    host_ns: n * BLOCK_NS,
                                    samples,
                                },
                                now,
                            )
                            .unwrap();
                        owner.processed += 1;
                    }
                    if failure {
                        assert!(owner.processor.capture(&mut [0; 479], 0).is_err());
                    }
                    // Scope drop models cancellation/error before publication.
                }
                assert_eq!(Arc::strong_count(&evidence), 1);
                let r = evidence.lock().unwrap();
                assert_eq!(r["handoff"]["pending"], 0);
                assert_eq!(r["handoff"]["retired_pending"], 10);
                assert_eq!(r["aec_enforced_high_pass"], false);
            }
        }
    }
}
