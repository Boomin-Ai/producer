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
}
