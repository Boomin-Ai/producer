//! Application-owned bounded handoff, stamped before an async task wakes.
//! Callback delivery time is not an RTP/capture timestamp.
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

pub struct Captured<T> {
    pub at: Instant,
    pub value: T,
}
pub struct Queue<T> {
    entries: Mutex<VecDeque<Captured<T>>>,
    capacity: usize,
    max_age: Duration,
    received: AtomicU64,
    overflow: AtomicU64,
    contention: AtomicU64,
    stale: AtomicU64,
    consumed: AtomicU64,
}
impl<T> Queue<T> {
    pub fn new(capacity: usize, max_age: Duration) -> Self {
        assert!(capacity > 0);
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
            max_age,
            received: AtomicU64::new(0),
            overflow: AtomicU64::new(0),
            contention: AtomicU64::new(0),
            stale: AtomicU64::new(0),
            consumed: AtomicU64::new(0),
        }
    }
    pub fn push(&self, frame: Captured<T>) {
        self.received.fetch_add(1, Ordering::Relaxed);
        // Never block the WebRTC callback behind the consumer.
        if let Ok(mut entries) = self.entries.try_lock() {
            if entries.len() == self.capacity {
                entries.pop_front();
                self.overflow.fetch_add(1, Ordering::Relaxed);
            }
            entries.push_back(frame);
        } else {
            self.contention.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn pop(&self, now: Instant) -> Option<Captured<T>> {
        let mut entries = self.entries.lock().unwrap();
        while let Some(frame) = entries.pop_front() {
            if now.saturating_duration_since(frame.at) > self.max_age {
                self.stale.fetch_add(1, Ordering::Relaxed);
            } else {
                self.consumed.fetch_add(1, Ordering::Relaxed);
                return Some(frame);
            }
        }
        None
    }
    pub fn stats(&self) -> serde_json::Value {
        json!({"capacity_frames":self.capacity,"max_age_ms":self.max_age.as_millis(),
            "received":self.received.load(Ordering::Relaxed),"overflow_oldest_dropped":self.overflow.load(Ordering::Relaxed),
            "callback_contention_dropped":self.contention.load(Ordering::Relaxed),
            "stale_dropped":self.stale.load(Ordering::Relaxed),
            "consumed":self.consumed.load(Ordering::Relaxed),"pending_frames":self.entries.lock().unwrap().len()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalled_consumer_drops_backlog_and_resumes_with_fresh_frames() {
        let q = Queue::new(3, Duration::from_millis(30));
        let began = Instant::now();
        for value in 0..100 {
            q.push(Captured { at: began, value });
        }
        assert_eq!(q.stats()["overflow_oldest_dropped"], 97);
        assert!(q.pop(began + Duration::from_millis(31)).is_none());
        assert_eq!(q.stats()["stale_dropped"], 3);
        q.push(Captured {
            at: began + Duration::from_millis(32),
            value: 100,
        });
        assert_eq!(q.pop(began + Duration::from_millis(33)).unwrap().value, 100);
    }
    #[test]
    fn busy_consumer_cannot_block_media_callback() {
        let q = Queue::new(3, Duration::from_millis(30));
        let _guard = q.entries.lock().unwrap();
        q.push(Captured {
            at: Instant::now(),
            value: 1,
        });
        assert_eq!(q.contention.load(Ordering::Relaxed), 1);
    }
}
