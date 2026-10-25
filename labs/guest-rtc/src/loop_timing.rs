//! Fixed-size timing counters: never retain a per-tick trace or media.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
#[derive(Default)]
struct Counter {
    count: u64,
    total_us: u128,
    max_us: u128,
    over_10_ms: u64,
    over_30_ms: u64,
    over_100_ms: u64,
}
impl Counter {
    fn observe(&mut self, elapsed: Duration) {
        let us = elapsed.as_micros();
        self.count += 1;
        self.total_us += us;
        self.max_us = self.max_us.max(us);
        self.over_10_ms += u64::from(us > 10_000);
        self.over_30_ms += u64::from(us > 30_000);
        self.over_100_ms += u64::from(us > 100_000);
    }
    fn report(&self) -> Value {
        json!({"count":self.count,"mean_us":if self.count==0 {0} else {self.total_us/self.count as u128},"max_us":self.max_us,"over_10_ms":self.over_10_ms,"over_30_ms":self.over_30_ms,"over_100_ms":self.over_100_ms})
    }
}
#[derive(Default)]
pub struct Timings {
    previous: Option<Instant>,
    counters: BTreeMap<&'static str, Counter>,
}
impl Timings {
    pub fn tick(&mut self, at: Instant) {
        if let Some(previous) = self.previous.replace(at) {
            self.observe("tick_gap", at.saturating_duration_since(previous));
        }
    }
    pub fn observe(&mut self, stage: &'static str, elapsed: Duration) {
        // Only these compile-time stage names are supported, bounding storage.
        assert!(matches!(
            stage,
            "tick_gap"
                | "tick_work"
                | "sender_report_refresh"
                | "decoded_audio"
                | "observer_audio"
                | "observer_video"
                | "due_handoff"
        ));
        self.counters.entry(stage).or_default().observe(elapsed);
    }
    pub fn report(&self) -> Value {
        Value::Object(
            self.counters
                .iter()
                .map(|(name, c)| ((*name).into(), c.report()))
                .collect(),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counters_keep_stalls_without_unbounded_tick_history() {
        let mut timings = Timings::default();
        let start = Instant::now();
        for n in 0..10_000 {
            timings.tick(start + Duration::from_millis(n * 10));
        }
        timings.tick(start + Duration::from_millis(100_100));
        timings.observe("sender_report_refresh", Duration::from_millis(31));
        let report = timings.report();
        assert_eq!(report["tick_gap"]["count"], 10_000);
        assert_eq!(report["tick_gap"]["max_us"], 110_000);
        assert_eq!(report["tick_gap"]["over_100_ms"], 1);
        assert_eq!(report["sender_report_refresh"]["over_30_ms"], 1);
        assert_eq!(timings.counters.len(), 2);
    }
}
