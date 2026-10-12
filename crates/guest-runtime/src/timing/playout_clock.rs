//! Map native render deadlines to one local timeline; never infer sender capture.
use std::time::{Duration, Instant};

pub struct VideoClock {
    rtc_us: i64,
    local: Instant,
}
impl VideoClock {
    pub fn new(rtc_us: i64, local: Instant) -> Self {
        Self { rtc_us, local }
    }
    pub fn deadline(&self, render_us: i64, arrival: Instant) -> Option<Instant> {
        let delta = render_us.checked_sub(self.rtc_us)?;
        let time = if delta >= 0 {
            self.local
                .checked_add(Duration::from_micros(delta as u64))?
        } else {
            self.local
                .checked_sub(Duration::from_micros(delta.unsigned_abs()))?
        };
        // Reject missing/stale or implausibly future metadata rather than silently
        // treating a capture timestamp as a valid render deadline.
        if time > arrival.checked_add(Duration::from_millis(250))?
            || arrival.saturating_duration_since(time) > Duration::from_millis(100)
        {
            return None;
        }
        Some(time)
    }
}
#[derive(Default)]
pub struct AudioClock {
    origin: Option<(u64, Instant)>,
    pub resets: u64,
}
impl AudioClock {
    pub fn stamp(&mut self, first_sample: u64, arrival: Instant) -> Instant {
        if let Some((sample, at)) = self.origin {
            if let Some(delta) = first_sample.checked_sub(sample) {
                if let Some(time) = at.checked_add(Duration::from_micros(
                    delta.saturating_mul(1_000_000) / 48_000,
                )) {
                    let error = if time > arrival {
                        time.duration_since(arrival)
                    } else {
                        arrival.duration_since(time)
                    };
                    if error <= Duration::from_millis(30) {
                        return time;
                    }
                }
            }
            self.resets += 1;
        }
        self.origin = Some((first_sample, arrival));
        arrival
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_clock_preserves_sample_gaps_and_bounds_arrival_drift() {
        let mut clock = AudioClock::default();
        let now = Instant::now();
        assert_eq!(clock.stamp(0, now), now);
        assert_eq!(
            clock.stamp(480, now + Duration::from_millis(13)),
            now + Duration::from_millis(10)
        );
        assert_eq!(
            clock.stamp(1920, now + Duration::from_millis(44)),
            now + Duration::from_millis(40)
        );
        let late = now + Duration::from_millis(150);
        assert_eq!(clock.stamp(2400, late), late);
        assert_eq!(clock.resets, 1);
        assert_eq!(clock.stamp(0, late), late);
        assert_eq!(clock.resets, 2);
    }
    #[test]
    fn video_clock_rejects_missing_old_and_far_future_deadlines() {
        let now = Instant::now();
        let clock = VideoClock::new(1_000_000, now);
        assert_eq!(
            clock.deadline(1_020_000, now),
            Some(now + Duration::from_millis(20))
        );
        assert_eq!(clock.deadline(0, now), None);
        assert_eq!(clock.deadline(1_300_000, now), None);
        assert_eq!(clock.deadline(800_000, now), None);
    }
}
