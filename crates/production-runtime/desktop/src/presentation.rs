//! Nonblocking, bounded video presentation. Decoder handoff misses must not
//! become black output. A seek/source replacement always invalidates the cache.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
#[derive(Clone)]
pub struct Decoded<T> {
    pub at: f64,
    pub generation: u64,
    pub published: Instant,
    pub frame: Arc<T>,
}
pub struct Presentation<T> {
    generation: u64,
    last: Option<Decoded<T>>,
}
impl<T> Default for Presentation<T> {
    fn default() -> Self {
        Self {
            generation: 0,
            last: None,
        }
    }
}
impl<T> Presentation<T> {
    pub fn frame(
        &mut self,
        generation: u64,
        at: Option<f64>,
        update: Option<Decoded<T>>,
        now: Instant,
    ) -> Option<Arc<T>> {
        let Some(at) = at else {
            self.last = None;
            return None;
        };
        if generation != self.generation {
            self.last = None;
            self.generation = generation;
        }
        if let Some(f) = update.filter(|f| f.generation == generation) {
            self.last = Some(f);
        }
        let f = self.last.as_ref()?;
        // Exact paused editorial time remains valid. During playback/loop handoff,
        // retain only a recently decoded frame, never an indefinitely frozen source.
        ((f.at - at).abs() < 0.1
            || now.saturating_duration_since(f.published) < Duration::from_millis(250))
        .then(|| f.frame.clone())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample(now: Instant) -> Decoded<u8> {
        Decoded {
            at: 6.40,
            generation: 1,
            published: now,
            frame: Arc::new(7),
        }
    }
    #[test]
    fn loop_and_contention_hold_are_bounded_and_do_not_cross_fences() {
        let now = Instant::now();
        let mut p = Presentation::default();
        assert_eq!(*p.frame(1, Some(6.4), Some(sample(now)), now).unwrap(), 7);
        assert!(p
            .frame(1, Some(0.01), None, now + Duration::from_millis(60))
            .is_some());
        assert!(p
            .frame(1, Some(0.01), None, now + Duration::from_millis(251))
            .is_none());
        assert!(p.frame(2, Some(0.01), Some(sample(now)), now).is_none());
        assert!(p.frame(1, None, Some(sample(now)), now).is_none());
        assert!(p.frame(1, Some(6.4), None, now).is_none());
    }
    #[test]
    fn pause_keeps_exact_frame_without_extending_decode_freshness() {
        let now = Instant::now();
        let mut p = Presentation::default();
        p.frame(1, Some(6.4), Some(sample(now)), now);
        assert!(p
            .frame(1, Some(6.4), None, now + Duration::from_secs(60))
            .is_some());
        assert!(p
            .frame(1, Some(1.), None, now + Duration::from_secs(60))
            .is_none());
    }
}
