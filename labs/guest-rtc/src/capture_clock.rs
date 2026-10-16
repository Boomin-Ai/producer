//! Opt-in ACT experiment. Interpolate only a current, bounded RTP mapping.
//! A new publication/decoder generation cannot reuse its predecessor's clock.
use serde_json::{json, Value};
use webrtc_sys::webrtc::ffi::DecodedAudioBlock;

#[derive(Default)]
pub struct AudioClock {
    anchor: Option<(u64, u32, u32, i64, i64, bool)>,
    observed: u64,
    interpolated: u64,
    rejected: u64,
    discontinuities: u64,
}
impl AudioClock {
    pub fn clear(&mut self) {
        self.anchor = None;
    }
    pub fn origin(&mut self, block: &DecodedAudioBlock) -> Option<i64> {
        if self.anchor.is_some_and(|(generation, ssrc, _, _, _, _)| {
            generation != block.generation || ssrc != block.ssrc
        }) {
            self.clear();
        }
        let mapped = self
            .anchor
            .and_then(|(_, _, rtp, origin, observed, qualified)| {
                let age = block.pull_us.checked_sub(observed)?;
                let delta = i64::from(block.rtp_timestamp.wrapping_sub(rtp) as i32);
                (qualified && (0..=200_000).contains(&age) && delta.abs() <= 9600)
                    .then(|| origin.checked_add(delta * 1_000_000 / 48000))
                    .flatten()
            });
        if block.capture_sender_ntp_us > 0 {
            self.observed += 1;
            // A clock jump is quarantined until another packet proves the new
            // mapping. Never silently mix old and new capture-clock domains.
            let consistent = self.anchor.is_none_or(|(_, _, rtp, origin, _, _)| {
                let delta = i64::from(block.rtp_timestamp.wrapping_sub(rtp) as i32);
                delta.abs() <= 9600
                    && origin
                        .checked_add(delta * 1_000_000 / 48000)
                        .is_some_and(|expected| {
                            expected.abs_diff(block.capture_sender_ntp_us) <= 30_000
                        })
            });
            self.anchor = Some((
                block.generation,
                block.ssrc,
                block.rtp_timestamp,
                block.capture_sender_ntp_us,
                block.pull_us,
                consistent,
            ));
            if consistent {
                return Some(block.capture_sender_ntp_us);
            }
            self.discontinuities += 1;
        } else if let Some(origin) = mapped {
            self.interpolated += 1;
            return Some(origin);
        }
        self.rejected += 1;
        None
    }
    pub fn report(&self) -> Value {
        json!({"metadata_blocks":self.observed,"interpolated_blocks":self.interpolated,
            "rejected_blocks":self.rejected,"clock_discontinuities":self.discontinuities,
            "maximum_mapping_age_ms":200,"maximum_rtp_distance_ms":200,
            "arrival_time_fallback":false,"clock_domain":"publishing sender NTP; capture offset subtracted"})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn block(generation: u64, rtp: u32, pull: i64, origin: i64) -> DecodedAudioBlock {
        DecodedAudioBlock {
            samples: [0; 960],
            generation,
            sequence: 1,
            channels: 1,
            ssrc: 7,
            rtp_timestamp: rtp,
            pull_us: pull,
            elapsed_ms: 0,
            capture_sender_ntp_us: origin,
            speech_type: 0,
            muted: false,
        }
    }
    #[test]
    fn packet_sample_offset_wrap_and_bounded_interpolation_are_preserved() {
        let mut clock = AudioClock::default();
        let rtp = u32::MAX - 239;
        assert_eq!(
            clock.origin(&block(1, rtp, 100, 1_000_000)),
            Some(1_000_000)
        );
        assert_eq!(
            clock.origin(&block(1, rtp.wrapping_add(480), 10100, 0)),
            Some(1_010_000)
        );
        assert_eq!(
            clock.origin(&block(1, rtp.wrapping_add(480), 200101, 0)),
            None
        );
        assert_eq!(
            clock.origin(&block(1, rtp.wrapping_add(9601), 10100, 0)),
            None
        );
        assert_eq!(clock.origin(&block(1, rtp, 99, 0)), None);
    }
    #[test]
    fn generation_ssrc_and_explicit_clear_never_reuse_old_clocks() {
        let mut clock = AudioClock::default();
        clock.origin(&block(1, 0, 100, 1_000_000));
        assert_eq!(clock.origin(&block(2, 480, 10100, 0)), None);
        clock.origin(&block(2, 480, 10100, 2_000_000));
        let mut other = block(2, 960, 20100, 0);
        other.ssrc = 8;
        assert_eq!(clock.origin(&other), None);
        clock.origin(&block(2, 960, 20100, 2_010_000));
        clock.clear();
        assert_eq!(clock.origin(&block(2, 1440, 30100, 0)), None);
    }
    #[test]
    fn jump_requires_another_consistent_packet_before_requalification() {
        let mut clock = AudioClock::default();
        clock.origin(&block(1, 0, 100, 1_000_000));
        assert_eq!(clock.origin(&block(1, 480, 10100, 2_000_000)), None);
        assert_eq!(clock.origin(&block(1, 960, 20100, 0)), None);
        assert_eq!(
            clock.origin(&block(1, 960, 20100, 2_010_000)),
            Some(2_010_000)
        );
        assert_eq!(clock.report()["clock_discontinuities"], 1);
    }
}
