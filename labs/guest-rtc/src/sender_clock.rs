//! Diagnostic RTP origin mapping from authenticated sender reports.
//! Does not schedule OBS or claim a sender-to-local clock offset.
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct SenderReport {
    pub ssrc: u32,
    pub ntp_seconds: u32,
    pub ntp_fraction: u32,
    pub rtp_timestamp: u32,
    pub observed_us: i64,
}
impl SenderReport {
    fn ntp_ticks(self) -> i128 {
        (i128::from(self.ntp_seconds) << 32) | i128::from(self.ntp_fraction)
    }
}
pub struct SenderClock {
    ssrc: u32,
    rate: u32,
    previous: Option<SenderReport>,
    latest: Option<SenderReport>,
    pub resets: u64,
    pub rejected: u64,
}
impl SenderClock {
    pub fn new(ssrc: u32, rate: u32) -> Self {
        assert!(rate > 0);
        Self {
            ssrc,
            rate,
            previous: None,
            latest: None,
            resets: 0,
            rejected: 0,
        }
    }
    pub fn observe(&mut self, report: SenderReport) {
        if report.ssrc != self.ssrc || report.ntp_seconds == 0 || report.observed_us < 0 {
            self.rejected += 1;
            return;
        }
        if let Some(old) = self.latest {
            if old.rtp_timestamp == report.rtp_timestamp && old.ntp_ticks() == report.ntp_ticks() {
                return; // Repeated reports must not refresh mapping freshness.
            }
            let ticks = report.rtp_timestamp.wrapping_sub(old.rtp_timestamp);
            let ntp = report.ntp_ticks() - old.ntp_ticks();
            let plausible = ntp > 0
                && ticks > 0
                && ticks < (1u32 << 31)
                && report.observed_us >= old.observed_us
                && ntp <= (60i128 << 32)
                && ((i128::from(ticks) << 32) - ntp * i128::from(self.rate)).abs() * 100
                    <= ntp * i128::from(self.rate);
            if plausible {
                self.previous = Some(old);
            } else {
                self.previous = None;
                self.resets += 1;
            }
        }
        self.latest = Some(report);
    }
    /// Lab-only first-report bootstrap at the explicit fixture clock rate.
    /// Never use it to bypass a detected discontinuity; a fresh pair is then required.
    #[cfg(any(feature = "obs-proof", test))]
    pub fn playback_origin(&self, rtp: u32, now_us: i64, bootstrap: bool) -> Option<i64> {
        if self.previous.is_some() {
            return self.origin_ntp_us(rtp, now_us);
        }
        if !bootstrap || self.resets != 0 {
            return None;
        }
        let last = self.latest?;
        let age = now_us.checked_sub(last.observed_us)?;
        let delta = i64::from(rtp.wrapping_sub(last.rtp_timestamp) as i32);
        if !(0..=5_000_000).contains(&age) || delta.abs() > i64::from(self.rate) * 5 {
            return None;
        }
        let ntp = last.ntp_ticks() + (i128::from(delta) << 32) / i128::from(self.rate);
        if ntp <= 0 {
            return None;
        }
        i64::try_from(ntp * 1_000_000 / (1i128 << 32)).ok()
    }
    #[cfg(any(feature = "obs-proof", test))]
    pub fn playback_ready(&self, now_us: i64, bootstrap: bool) -> bool {
        self.latest.is_some_and(|last| {
            self.playback_origin(last.rtp_timestamp, now_us, bootstrap)
                .is_some()
        })
    }
    pub fn origin_ntp_us(&self, rtp: u32, now_us: i64) -> Option<i64> {
        let (first, last) = (self.previous?, self.latest?);
        let age = now_us.checked_sub(last.observed_us)?;
        if !(0..=10_000_000).contains(&age) {
            return None;
        }
        let delta = i64::from(rtp.wrapping_sub(last.rtp_timestamp) as i32);
        if delta.abs() > i64::from(self.rate) * 10 {
            return None;
        }
        let span = i128::from(last.rtp_timestamp.wrapping_sub(first.rtp_timestamp));
        let ntp =
            last.ntp_ticks() + i128::from(delta) * (last.ntp_ticks() - first.ntp_ticks()) / span;
        if ntp <= 0 {
            return None;
        }
        i64::try_from(ntp * 1_000_000 / (1i128 << 32)).ok()
    }
}

pub fn diagnostic_maps(
    rtcp: &Value,
    mixer: &Value,
    receivers: &[Value],
    now_us: i64,
) -> Vec<Value> {
    let reports: Vec<_> = rtcp["peers"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|log| {
            log["sender_report_history"]
                .as_array()
                .into_iter()
                .flatten()
        })
        .filter(|report| report["incoming"].as_bool() == Some(true))
        .filter_map(|report| serde_json::from_value::<SenderReport>(report.clone()).ok())
        .collect();
    receivers.iter().filter_map(|receiver| {
        let ssrc = u32::try_from(receiver["ssrc"].as_u64()?).ok()?;
        // Rates are explicit fixture assumptions, checked against report pairs.
        let rate = match receiver["kind"].as_str()? { "audio"=>48000, "video"=>90000, _=>return None };
        let mut clock=SenderClock::new(ssrc,rate);
        for report in reports.iter().filter(|report| report.ssrc==ssrc) { clock.observe(*report); }
        let audio_frame = mixer["sources"].as_array().into_iter().flatten()
            .filter(|source| source["ssrc"].as_u64()==Some(u64::from(ssrc)))
            .max_by_key(|source| source["generation"].as_u64().unwrap_or(0));
        let origin = audio_frame.and_then(|frame| {
            let rtp=u32::try_from(frame["rtp_timestamp"].as_u64()?).ok()?;
            clock.origin_ntp_us(rtp,now_us)
        });
        Some(json!({"identity":receiver["identity"],"sid":receiver["sid"],"ssrc":ssrc,
            "kind":receiver["kind"],"fixture_clock_rate":rate,"resets":clock.resets,"rejected_reports":clock.rejected,
            "two_report_map_available":clock.latest.is_some_and(|last| clock.origin_ntp_us(last.rtp_timestamp,now_us).is_some()),
            "audio_source_generation":audio_frame.map(|frame|&frame["generation"]),
            "last_decoded_audio_origin_ntp_us":origin,"observations_only":true,"obs_connected":false,
            "clock_domain":"remote sender-report NTP; no sender-to-local clock offset established"}))
    }).collect()
}
/// Online lab consumer of paired PCM/RTP blocks. Maps remote sender time only;
/// no sender-to-local offset or OBS scheduling is inferred from pull arrival.
#[derive(Default)]
pub struct DecodedOrigins {
    sources: std::collections::BTreeMap<u64, DecodedSource>,
    reports: Vec<SenderReport>,
    capacity_rejected: u64,
}
struct DecodedSource {
    clock: SenderClock,
    latest_report_seen: i64,
    last_sequence: u64,
    consumed: u64,
    mapped: u64,
    unmapped: u64,
    sequence_gaps: u64,
    nonzero_pcm: u64,
    observations: Vec<Value>,
    last_mapped: Option<(u64, i64)>,
    mapped_step_pairs: u64,
    origin_step_min_us: Option<i64>,
    origin_step_max_us: Option<i64>,
    max_step_sample_error_us: u64,
    first_mapped_sequence: Option<u64>,
}
impl DecodedSource {
    fn refresh(&mut self, reports: &[SenderReport]) {
        let ssrc = self.clock.ssrc;
        for report in reports.iter().filter(|report| report.ssrc == ssrc) {
            if report.observed_us > self.latest_report_seen {
                self.clock.observe(*report);
                self.latest_report_seen = report.observed_us;
            }
        }
    }
}
impl DecodedOrigins {
    pub fn refresh(&mut self, rtcp: &Value) {
        self.reports = rtcp["peers"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|log| {
                log["sender_report_history"]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .filter(|report| report["incoming"].as_bool() == Some(true))
            .filter_map(|report| serde_json::from_value::<SenderReport>(report.clone()).ok())
            .collect();
        self.reports.sort_by_key(|report| report.observed_us);
        for source in self.sources.values_mut() {
            source.refresh(&self.reports);
        }
    }
    #[cfg(feature = "obs-proof")]
    pub fn origin_for(
        &self,
        frame: &webrtc_sys::webrtc::ffi::DecodedAudioBlock,
        now_us: i64,
        bootstrap: bool,
    ) -> Option<i64> {
        let source = self.sources.get(&frame.generation)?;
        if source.clock.ssrc != frame.ssrc {
            return None;
        }
        source
            .clock
            .playback_origin(frame.rtp_timestamp, now_us, bootstrap)
    }
    pub fn consume(&mut self, frame: &webrtc_sys::webrtc::ffi::DecodedAudioBlock, now_us: i64) {
        if !self.sources.contains_key(&frame.generation) && self.sources.len() >= 64 {
            self.capacity_rejected += 1;
            return;
        }
        let source = self
            .sources
            .entry(frame.generation)
            .or_insert_with(|| DecodedSource {
                clock: SenderClock::new(frame.ssrc, 48000),
                latest_report_seen: frame.pull_us.saturating_sub(1),
                last_sequence: 0,
                consumed: 0,
                mapped: 0,
                unmapped: 0,
                sequence_gaps: 0,
                nonzero_pcm: 0,
                observations: Vec::with_capacity(16),
                last_mapped: None,
                mapped_step_pairs: 0,
                origin_step_min_us: None,
                origin_step_max_us: None,
                max_step_sample_error_us: 0,
                first_mapped_sequence: None,
            });
        source.refresh(&self.reports);
        source.consumed += 1;
        source.nonzero_pcm += u64::from(frame.samples.iter().any(|sample| *sample != 0));
        source.sequence_gaps += frame
            .sequence
            .saturating_sub(source.last_sequence.saturating_add(1));
        source.last_sequence = frame.sequence;
        let origin = if source.clock.ssrc == frame.ssrc {
            source.clock.origin_ntp_us(frame.rtp_timestamp, now_us)
        } else {
            None
        };
        if let Some(origin) = origin {
            source.mapped += 1;
            source.first_mapped_sequence.get_or_insert(frame.sequence);
            if let Some((sequence, previous_origin)) = source.last_mapped {
                if frame.sequence == sequence + 1 {
                    let step = origin - previous_origin;
                    source.mapped_step_pairs += 1;
                    source.origin_step_min_us =
                        Some(source.origin_step_min_us.map_or(step, |old| old.min(step)));
                    source.origin_step_max_us =
                        Some(source.origin_step_max_us.map_or(step, |old| old.max(step)));
                    source.max_step_sample_error_us = source
                        .max_step_sample_error_us
                        .max((step - 10_000).unsigned_abs());
                }
            }
            source.last_mapped = Some((frame.sequence, origin));
            if source.observations.len() < 16 {
                source.observations.push(
                    json!({"sequence":frame.sequence,"rtp_timestamp":frame.rtp_timestamp,
                    "origin_ntp_us":origin,"pull_us":frame.pull_us,"elapsed_ms":frame.elapsed_ms,
                    "speech_type":frame.speech_type,"muted":frame.muted,"channels":frame.channels}),
                );
            }
        } else {
            source.unmapped += 1;
            source.last_mapped = None;
        }
    }
    pub fn report(&self) -> Value {
        json!({"online":true,"obs_connected":false,"capture_time_qualified":false,
            "fixture_clock_rate":48000,"capacity_rejected":self.capacity_rejected,
            "clock_domain":"remote sender-report NTP; no sender-to-local offset",
            "sources":self.sources.iter().map(|(generation,source)|json!({
                "generation":generation,"ssrc":source.clock.ssrc,"blocks_consumed":source.consumed,
                "origins_mapped":source.mapped,"origins_unavailable":source.unmapped,
                "sequence_gaps":source.sequence_gaps,"nonzero_pcm_blocks":source.nonzero_pcm,
                "clock_resets":source.clock.resets,"rejected_reports":source.clock.rejected,
                "origin_observations":source.observations,"first_mapped_sequence":source.first_mapped_sequence,
                "consecutive_mapped_pairs":source.mapped_step_pairs,
                "origin_step_min_us":source.origin_step_min_us,"origin_step_max_us":source.origin_step_max_us,
                "max_origin_step_error_vs_10ms_pcm_us":source.max_step_sample_error_us})).collect::<Vec<_>>()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sr(rtp: u32, seconds: u32, at: i64) -> SenderReport {
        SenderReport {
            ssrc: 7,
            ntp_seconds: seconds,
            ntp_fraction: 0,
            rtp_timestamp: rtp,
            observed_us: at,
        }
    }
    #[test]
    fn rtp_wrap_and_frame_before_latest_report_preserve_origin() {
        let mut clock = SenderClock::new(7, 48000);
        let first = u32::MAX - 23999;
        let last = first.wrapping_add(48000);
        clock.observe(sr(first, 100, 1_000_000));
        assert_eq!(clock.origin_ntp_us(first, 1_000_000), None);
        clock.observe(sr(last, 101, 2_000_000));
        assert_eq!(
            clock.origin_ntp_us(last.wrapping_sub(24000), 2_000_000),
            Some(100_500_000)
        );
    }
    #[test]
    fn stale_future_duplicate_and_far_extrapolation_do_not_become_valid_clocks() {
        let mut clock = SenderClock::new(7, 48000);
        clock.observe(sr(0, 100, 1_000_000));
        clock.observe(sr(48000, 101, 2_000_000));
        assert_eq!(clock.origin_ntp_us(48000, 1_999_999), None);
        assert_eq!(clock.origin_ntp_us(48000, 12_000_001), None);
        clock.observe(sr(48000, 101, 20_000_000));
        assert_eq!(clock.origin_ntp_us(48000, 20_000_000), None);
        assert_eq!(clock.origin_ntp_us(48000 + 480001, 2_000_000), None);
    }
    #[test]
    fn extrapolation_cannot_turn_a_valid_pair_into_a_zero_or_negative_origin() {
        let mut clock = SenderClock::new(7, 48000);
        clock.observe(sr(48000, 1, 0));
        clock.observe(sr(96000, 2, 1_000_000));
        assert_eq!(clock.origin_ntp_us(0, 1_000_000), None);
        assert_eq!(clock.origin_ntp_us(u32::MAX - 47999, 1_000_000), None);
    }
    #[test]
    fn report_discontinuity_requires_a_fresh_pair_and_new_ssrc_cannot_reuse_map() {
        let mut clock = SenderClock::new(7, 48000);
        clock.observe(sr(0, 100, 1_000_000));
        clock.observe(sr(48000, 101, 2_000_000));
        let mut wrong = sr(96000, 102, 3_000_000);
        wrong.ssrc = 8;
        clock.observe(wrong);
        assert_eq!(clock.rejected, 1);
        clock.observe(sr(96000, 103, 3_000_000));
        assert_eq!(clock.resets, 1);
        assert_eq!(clock.origin_ntp_us(96000, 3_000_000), None);
        clock.observe(sr(144000, 104, 4_000_000));
        assert_eq!(clock.origin_ntp_us(144000, 4_000_000), Some(104_000_000));
        let fresh = SenderClock::new(7, 48000);
        assert_eq!(fresh.origin_ntp_us(144000, 4_000_000), None);
    }
    #[test]
    fn bootstrap_is_opt_in_bounded_and_cannot_hide_a_discontinuity() {
        let mut clock = SenderClock::new(7, 48000);
        assert_eq!(clock.playback_origin(48000, 1_000_000, true), None);
        clock.observe(sr(u32::MAX - 23999, 100, 1_000_000));
        assert_eq!(clock.playback_origin(24000, 1_000_000, false), None);
        assert_eq!(
            clock.playback_origin(24000, 1_000_000, true),
            Some(101_000_000)
        );
        assert_eq!(clock.playback_origin(24000, 999_999, true), None);
        assert_eq!(clock.playback_origin(24000, 6_000_001, true), None);
        assert_eq!(clock.playback_origin(240001, 1_000_000, true), None);
        clock.observe(sr(24000, 101, 2_000_000));
        assert_eq!(
            clock.playback_origin(24000, 2_000_000, true),
            clock.origin_ntp_us(24000, 2_000_000)
        );
        clock.observe(sr(72000, 104, 3_000_000));
        assert_eq!(clock.playback_origin(72000, 3_000_000, true), None);
        clock.observe(sr(120000, 105, 4_000_000));
        assert_eq!(
            clock.playback_origin(120000, 4_000_000, true),
            Some(105_000_000)
        );
        assert!(!SenderClock::new(8, 48000).playback_ready(4_000_000, true));
    }
    #[test]
    fn online_pcm_mapping_waits_for_reports_and_resets_on_new_generation() {
        let frame = |generation, sequence, rtp| webrtc_sys::webrtc::ffi::DecodedAudioBlock {
            samples: [123; 960],
            channels: 2,
            generation,
            sequence,
            ssrc: 7,
            rtp_timestamp: rtp,
            pull_us: if generation == 1 { 0 } else { 3_000_000 },
            elapsed_ms: 10,
            speech_type: 0,
            muted: false,
        };
        let mut online = DecodedOrigins::default();
        online.consume(&frame(1, 1, 48000), 2_000_000);
        let reports = json!({"peers":[{"sender_report_history":[
            {"incoming":true,"ssrc":7,"ntp_seconds":100,"ntp_fraction":0,"rtp_timestamp":0,"observed_us":1_000_000},
            {"incoming":true,"ssrc":7,"ntp_seconds":101,"ntp_fraction":0,"rtp_timestamp":48000,"observed_us":2_000_000}]}]});
        online.refresh(&reports);
        online.consume(&frame(1, 3, 48960), 2_000_000);
        online.refresh(&reports); // Retained old history must not reset the clock.
        online.consume(&frame(1, 4, 49440), 2_000_000);
        online.refresh(&json!({"peers":[]}));
        online.consume(&frame(2, 1, 48000), 3_000_000);
        let report = online.report();
        assert_eq!(report["sources"][0]["origins_mapped"], 2);
        assert_eq!(report["sources"][0]["origins_unavailable"], 1);
        assert_eq!(report["sources"][0]["sequence_gaps"], 1);
        assert_eq!(report["sources"][0]["clock_resets"], 0);
        let origin = report["sources"][0]["origin_observations"][0]["origin_ntp_us"]
            .as_i64()
            .unwrap();
        assert!((origin - 101_020_000).abs() <= 1); // Fixed-point truncation is at most one microsecond.
        assert_eq!(report["sources"][1]["origins_mapped"], 0);
    }
}
