//! Owner-thread AEC and a bounded, timestamp-preserving publisher handoff.
//! Device callbacks never call this code. The SDK direct source still lacks an
//! external capture-timestamp argument; pacing is not proof of RTP A/V alignment.
use crate::apm::Processor;
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

pub const BLOCK_NS: u64 = 10_000_000;
const TIMELINE_TOLERANCE_NS: u64 = 2_000_000;
pub const CAPACITY: usize = 32;
const START_LEAD: Duration = Duration::from_millis(10);
const MAX_LATE: Duration = Duration::from_millis(20);
const MIN_SPACING: Duration = Duration::from_millis(8);

pub struct MicrophoneProcessor {
    apm: Processor,
}
impl MicrophoneProcessor {
    pub fn new() -> Result<Self> {
        let mut apm = Processor::new(true, 48000, 1)?;
        apm.set_high_pass_filter_enforcement(false);
        ensure!(
            !apm.high_pass_filter_enforced(),
            "AEC refinement was not applied"
        );
        Ok(Self { apm })
    }
    pub fn reverse(&mut self, final_speaker_pcm: &[i16]) -> Result<()> {
        self.apm.reverse(final_speaker_pcm)
    }
    pub fn capture(&mut self, mic: &mut [i16], delay_ms: i32) -> Result<()> {
        self.apm.capture(mic, delay_ms)
    }
    pub fn high_pass_filter_enforced(&self) -> bool {
        self.apm.high_pass_filter_enforced()
    }
}

pub struct ProcessedBlock {
    pub host_ns: u64,
    pub samples: [i16; 480],
}
struct Pending {
    block: ProcessedBlock,
    due: Instant,
    enqueued: Instant,
}

/// One generation owns one timeline. Overflow, discontinuity and missed
/// deadlines retire it; no drop-oldest, catch-up burst or arrival-clock reset.
pub struct Handoff {
    pending: VecDeque<Pending>,
    anchor: Option<(u64, Instant)>,
    capture_clock_anchored: bool,
    last_capture: Option<u64>,
    last_emit: Option<Instant>,
    closed: bool,
    deadline_missed: bool,
    accepted: u64,
    emitted: u64,
    retired: u64,
    peak: usize,
    faults: u64,
    maximum_late_us: u64,
    minimum_spacing_us: Option<u64>,
    queue_age_ms: [u64; 350],
    maximum_queue_age_us: u64,
}
impl Handoff {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::with_capacity(CAPACITY),
            anchor: None,
            capture_clock_anchored: false,
            last_capture: None,
            last_emit: None,
            closed: false,
            deadline_missed: false,
            accepted: 0,
            emitted: 0,
            retired: 0,
            peak: 0,
            faults: 0,
            maximum_late_us: 0,
            minimum_spacing_us: None,
            queue_age_ms: [0; 350],
            maximum_queue_age_us: 0,
        }
    }
    /// Install one calibrated capture-clock deadline before the generation starts.
    /// The caller maps its device host clock to Instant; never change it midstream.
    pub fn with_capture_anchor(first_host_ns: u64, first_due: Instant) -> Self {
        let mut handoff = Self::new();
        handoff.anchor = Some((first_host_ns, first_due));
        handoff.capture_clock_anchored = true;
        handoff
    }
    fn fault<T>(&mut self, message: &str) -> Result<T> {
        self.faults += 1;
        self.retire();
        anyhow::bail!("{message}")
    }
    pub fn push(&mut self, block: ProcessedBlock, arrival: Instant) -> Result<()> {
        ensure!(!self.closed, "Capture generation is retired");
        if let Some(previous) = self.last_capture {
            if block.host_ns <= previous
                || (block.host_ns - previous).abs_diff(BLOCK_NS) > TIMELINE_TOLERANCE_NS
            {
                return self.fault("Microphone timeline discontinuity; restart generation");
            }
        }
        if self.pending.len() == CAPACITY {
            return self.fault("Microphone publication queue overflow; restart generation");
        }
        let (first, due) = *self
            .anchor
            .get_or_insert((block.host_ns, arrival + START_LEAD));
        if block.host_ns < first {
            return self.fault("Microphone timestamp predates this generation's capture anchor");
        }
        let due = due + Duration::from_nanos(block.host_ns - first);
        if arrival > due + MAX_LATE {
            self.deadline_missed = true;
            let late = arrival.duration_since(due).as_micros() as u64;
            self.maximum_late_us = self.maximum_late_us.max(late);
            return self.fault(&format!("Microphone block arrived after its publication deadline ({late} us late; limit {} us)", MAX_LATE.as_micros()));
        }
        self.last_capture = Some(block.host_ns);
        self.pending.push_back(Pending {
            block,
            due,
            enqueued: arrival,
        });
        self.accepted += 1;
        self.peak = self.peak.max(self.pending.len());
        Ok(())
    }
    pub fn pop_due(&mut self, now: Instant) -> Result<Option<ProcessedBlock>> {
        ensure!(!self.closed, "Capture generation is retired");
        if self.last_emit.is_some_and(|previous| now < previous) {
            return self.fault("Microphone publication clock regressed");
        }
        let Some(next) = self.pending.front() else {
            return Ok(None);
        };
        if now < next.due {
            return Ok(None);
        }
        let late = now.duration_since(next.due);
        self.maximum_late_us = self.maximum_late_us.max(late.as_micros() as u64);
        if late > MAX_LATE {
            self.deadline_missed = true;
            return self.fault("Microphone publisher missed its bounded deadline");
        }
        if self
            .last_emit
            .is_some_and(|last| now.duration_since(last) < MIN_SPACING)
        {
            return Ok(None);
        }
        if let Some(previous) = self.last_emit {
            let spacing = now.duration_since(previous).as_micros() as u64;
            self.minimum_spacing_us =
                Some(self.minimum_spacing_us.map_or(spacing, |s| s.min(spacing)));
        }
        self.last_emit = Some(now);
        let age = now.duration_since(next.enqueued).as_micros() as u64;
        self.maximum_queue_age_us = self.maximum_queue_age_us.max(age);
        // Fixed-size 1 ms histogram; its last bucket includes higher ages.
        self.queue_age_ms[(age.div_ceil(1000) as usize).min(349)] += 1;
        self.emitted += 1;
        Ok(self.pending.pop_front().map(|p| p.block))
    }
    pub fn deadline_missed(&self) -> bool {
        self.deadline_missed
    }
    pub fn retire(&mut self) {
        self.retired += self.pending.len() as u64;
        self.pending.clear();
        self.closed = true;
    }
    pub fn report(&self) -> Value {
        let target = (self.emitted * 95).div_ceil(100);
        let mut cumulative = 0;
        let p95 = self.queue_age_ms.iter().position(|count| {
            cumulative += count;
            self.emitted > 0 && cumulative >= target
        });
        json!({"capacity_blocks":CAPACITY,"capture_clock_anchored":self.capture_clock_anchored,"accepted":self.accepted,
            "emitted":self.emitted,"pending":self.pending.len(),"retired_pending":self.retired,
            "peak_pending":self.peak,"faults":self.faults,"deadline_missed":self.deadline_missed,"closed":self.closed,
            "maximum_lateness_us":self.maximum_late_us,"minimum_spacing_us":self.minimum_spacing_us,
            "maximum_lateness_ms":MAX_LATE.as_millis(),"minimum_spacing_ms":MIN_SPACING.as_millis(),
            "maximum_adapter_queue_age_us":self.maximum_queue_age_us,
            "adapter_queue_age_p95_ms_upper_bucket":p95,
            "adapter_queue_age_histogram_bins":350,"adapter_queue_age_target_ms":30,
            "adapter_queue_age_target_met":p95.is_some_and(|p|p<=30),
            "sdk_internal_queue_ms":0,"sdk_external_capture_timestamp_supported":false})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn block(n: u64) -> ProcessedBlock {
        ProcessedBlock {
            host_ns: 123_000_000 + n * BLOCK_NS,
            samples: [n as i16; 480],
        }
    }
    #[test]
    fn physical_capture_anchor_keeps_deadlines_independent_of_first_arrival_age() {
        let start = Instant::now();
        for age in [15, 23] {
            let mut q =
                Handoff::with_capture_anchor(block(0).host_ns, start + Duration::from_millis(25));
            q.push(block(0), start + Duration::from_millis(age))
                .unwrap();
            assert!(q
                .pop_due(start + Duration::from_millis(24))
                .unwrap()
                .is_none());
            assert_eq!(
                q.pop_due(start + Duration::from_millis(25))
                    .unwrap()
                    .unwrap()
                    .host_ns,
                block(0).host_ns
            );
            q.push(block(1), start + Duration::from_millis(age + 10))
                .unwrap();
            assert_eq!(
                q.pop_due(start + Duration::from_millis(35))
                    .unwrap()
                    .unwrap()
                    .host_ns,
                block(1).host_ns
            );
            assert_eq!(q.report()["capture_clock_anchored"], true);
        }
    }
    #[test]
    fn capture_anchor_rejects_an_older_first_block_without_clock_underflow() {
        let now = Instant::now();
        let mut q = Handoff::with_capture_anchor(block(1).host_ns, now);
        assert!(q.push(block(0), now).is_err());
        assert!(!q.deadline_missed());
        assert_eq!(q.report()["pending"], 0);
    }
    #[test]
    fn batched_capture_is_paced_without_losing_samples_or_timestamps() {
        let start = Instant::now();
        let mut q = Handoff::new();
        let mut emitted = 0;
        for ms in 0..1100 {
            let now = start + Duration::from_millis(ms);
            if ms < 1000 && ms % 100 == 0 {
                for n in ms / 10..ms / 10 + 10 {
                    q.push(block(n), now).unwrap();
                }
            }
            if let Some(out) = q.pop_due(now).unwrap() {
                assert_eq!(out.host_ns, block(emitted).host_ns);
                assert_eq!(out.samples, [emitted as i16; 480]);
                emitted += 1;
                assert!(q.pop_due(now).unwrap().is_none(), "same-instant burst");
            }
        }
        assert_eq!(emitted, 100);
        q.retire();
        let r = q.report();
        assert_eq!(r["faults"], 0);
        assert_eq!(r["minimum_spacing_us"], 10000);
        assert_eq!(r["pending"], 0);
        assert_eq!(r["adapter_queue_age_target_met"], false);
        assert_eq!(r["adapter_queue_age_p95_ms_upper_bucket"], 100);
    }
    #[test]
    fn stalls_gaps_and_overflow_retire_instead_of_catching_up() {
        let now = Instant::now();
        let mut stall = Handoff::new();
        stall.push(block(0), now).unwrap();
        assert!(stall.pop_due(now + Duration::from_millis(31)).is_err());
        assert!(stall.push(block(1), now).is_err());
        assert_eq!(stall.report()["retired_pending"], 1);
        let mut gap = Handoff::new();
        gap.push(block(0), now).unwrap();
        assert!(gap.push(block(2), now).is_err());
        let mut full = Handoff::new();
        for n in 0..CAPACITY {
            full.push(block(n as u64), now).unwrap();
        }
        assert!(full.push(block(CAPACITY as u64), now).is_err());
        assert_eq!(full.report()["retired_pending"], CAPACITY);
        let mut regression = Handoff::new();
        regression.push(block(0), now).unwrap();
        regression.pop_due(now + START_LEAD).unwrap();
        assert!(regression.pop_due(now).is_err());
    }
    #[test]
    fn ten_millisecond_input_meets_the_queue_budget_without_batch_backlog() {
        let start = Instant::now();
        let mut q = Handoff::new();
        for n in 0..100 {
            let now = start + Duration::from_millis(n * 10);
            q.push(block(n), now).unwrap();
            if let Some(out) = q.pop_due(now).unwrap() {
                assert_eq!(out.host_ns, block(n - 1).host_ns);
            }
        }
        q.pop_due(start + Duration::from_millis(1000))
            .unwrap()
            .unwrap();
        q.retire();
        let r = q.report();
        assert_eq!(r["emitted"], 100);
        assert_eq!(r["adapter_queue_age_p95_ms_upper_bucket"], 10);
        assert_eq!(r["adapter_queue_age_target_met"], true);
        assert_eq!(r["peak_pending"], 2);
    }
    #[test]
    fn destination_change_cannot_reuse_previous_pending_voice() {
        let now = Instant::now();
        for _ in 0..20 {
            let mut old = Handoff::new();
            for n in 0..10 {
                old.push(block(n), now).unwrap();
            }
            old.retire();
            assert!(old.pop_due(now + Duration::from_millis(100)).is_err());
            assert_eq!(old.report()["pending"], 0);
            let mut next = Handoff::new();
            next.push(block(500), now).unwrap();
            assert_eq!(
                next.pop_due(now + START_LEAD).unwrap().unwrap().host_ns,
                block(500).host_ns
            );
        }
    }
}
