//! Operator time is independent of the duration of a media sequence and of GPU frames.
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct RunClock {
    show: String,
    total: Duration,
    segment: Duration,
    anchor: Option<Instant>,
}

impl RunClock {
    pub fn enter(&mut self, show: &str, restart: bool, playing: bool, now: Instant) {
        let (elapsed, _) = self.elapsed(now);
        self.total = if self.show == show && !restart {
            elapsed
        } else {
            Duration::ZERO
        };
        self.segment = Duration::ZERO;
        self.show.clear();
        self.show.push_str(show);
        self.anchor = playing.then_some(now);
    }

    pub fn set_playing(&mut self, playing: bool, now: Instant) {
        (self.total, self.segment) = self.elapsed(now);
        self.anchor = playing.then_some(now);
    }

    pub fn elapsed(&self, now: Instant) -> (Duration, Duration) {
        let advance = self
            .anchor
            .map_or(Duration::ZERO, |at| now.saturating_duration_since(at));
        (self.total + advance, self.segment + advance)
    }

    pub fn leave(&mut self) {
        if !self.show.is_empty() {
            *self = Self::default();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untimed_segments_pause_navigation_and_restart() {
        let start = Instant::now();
        let at = |sec| start + Duration::from_secs(sec);
        let mut clock = RunClock::default();
        clock.enter("live", false, true, at(0));
        clock.set_playing(false, at(80));
        assert_eq!(clock.elapsed(at(120)).1.as_secs(), 80);
        clock.enter("live", false, false, at(120));
        clock.set_playing(true, at(130));
        let (total, segment) = clock.elapsed(at(133));
        assert_eq!((total.as_secs(), segment.as_secs()), (83, 3));
        clock.enter("live", true, true, at(134));
        assert_eq!(clock.elapsed(at(135)).0.as_secs(), 1);
        clock.leave();
        assert_eq!(clock.elapsed(at(150)).0, Duration::ZERO);
    }
}
