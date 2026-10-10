//! Selected remote guest only. This never accepts the local microphone track.
//! Generation tags retire queued PCM; this is not an encoded-SDK privacy fence.
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
const CAPACITY: usize = 8;
pub struct Frame {
    pub at: Instant,
    pub generation: u64,
    pub samples: [i16; 480],
}
struct State {
    generation: u64,
    frames: VecDeque<Frame>,
    accepted: u64,
    overflow: u64,
    retired: u64,
    stale: u64,
    rejected_generation: u64,
}
pub struct Monitor {
    state: Mutex<State>,
    contention: std::sync::atomic::AtomicU64,
}
impl Monitor {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                generation: 0,
                frames: VecDeque::with_capacity(CAPACITY),
                accepted: 0,
                overflow: 0,
                retired: 0,
                stale: 0,
                rejected_generation: 0,
            }),
            contention: 0.into(),
        }
    }
    pub fn replace(&self) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.retired += state.frames.len() as u64;
        state.frames.clear();
        state.generation += 1;
        state.generation
    }
    pub fn push(&self, generation: u64, samples: [i16; 480], at: Instant) {
        let Ok(mut state) = self.state.try_lock() else {
            self.contention
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return;
        };
        if generation != state.generation {
            state.rejected_generation += 1;
            return;
        }
        if state.frames.len() == CAPACITY {
            state.overflow += 1;
            return;
        }
        state.accepted += 1;
        state.frames.push_back(Frame {
            at,
            generation,
            samples,
        });
    }
    pub fn pop(&self, now: Instant) -> (u64, Option<Frame>) {
        let mut state = self.state.lock().unwrap();
        while let Some(frame) = state.frames.pop_front() {
            if now.saturating_duration_since(frame.at) > Duration::from_millis(30) {
                state.stale += 1;
                continue;
            }
            return (state.generation, Some(frame));
        }
        (state.generation, None)
    }
    pub fn generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }
    pub fn stats(&self) -> serde_json::Value {
        let state = self.state.lock().unwrap();
        json!({"generation":state.generation,"accepted":state.accepted,"overflow_rejected":state.overflow,"retired":state.retired,"old_generation_rejected":state.rejected_generation,"stale":state.stale,"pending":state.frames.len(),"capacity_blocks":CAPACITY,"max_age_ms":30,"callback_contention_rejected":self.contention.load(std::sync::atomic::Ordering::Relaxed)})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_rejects_late_old_track_and_clears_pending_voice() {
        let m = Monitor::new();
        let now = Instant::now();
        let old = m.replace();
        m.push(old, [11; 480], now);
        let current = m.replace();
        m.push(old, [22; 480], now);
        m.push(current, [33; 480], now);
        let (generation, frame) = m.pop(now);
        assert_eq!(generation, current);
        assert_eq!(frame.unwrap().samples[0], 33);
        assert_eq!(m.stats()["retired"], 1);
        assert_eq!(m.stats()["old_generation_rejected"], 1);
        assert!(m.pop(now).1.is_none());
    }
    #[test]
    fn capacity_and_age_are_bounded_without_catchup() {
        let m = Monitor::new();
        let now = Instant::now();
        let generation = m.replace();
        for _ in 0..9 {
            m.push(generation, [11; 480], now);
        }
        assert_eq!(m.stats()["overflow_rejected"], 1);
        assert!(m.pop(now + Duration::from_millis(31)).1.is_none());
        assert_eq!(m.stats()["stale"], 8);
    }
    #[test]
    fn rtc_callback_never_waits_for_consumer_lock() {
        let m = Monitor::new();
        let _guard = m.state.lock().unwrap();
        m.push(0, [0; 480], Instant::now());
        assert_eq!(m.contention.load(std::sync::atomic::Ordering::Relaxed), 1);
    }
}
