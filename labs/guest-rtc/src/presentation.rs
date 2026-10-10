//! Lab audio-master clock. Sender origin labels the current PCM position;
//! it never replaces the continuous sample clock or claims capture time.
use crate::sender_clock::{SenderClock, SenderReport};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

pub struct Presentation {
    delay: Duration,
    audio: Option<(u64, u64, Instant)>,
    origin: Option<(i64, Instant, Instant)>,
    last_video: Option<Instant>,
    audio_submitted: u64,
    audio_startup_dropped: u64,
    video_submitted: u64,
    video_rejected: u64,
    resets: u64,
    began: Instant,
    reasons: BTreeMap<&'static str, u64>,
    diagnostics: VecDeque<Value>,
}
impl Presentation {
    pub fn new(delay: Duration) -> Self {
        assert!(delay <= Duration::from_millis(200));
        Self {
            delay,
            audio: None,
            origin: None,
            last_video: None,
            audio_submitted: 0,
            audio_startup_dropped: 0,
            video_submitted: 0,
            video_rejected: 0,
            resets: 0,
            began: Instant::now(),
            reasons: BTreeMap::new(),
            diagnostics: VecDeque::with_capacity(64),
        }
    }
    pub fn reset_count(&self) -> u64 {
        self.resets
    }
    fn note(&mut self, reason: &'static str, at: Instant, details: Value) {
        *self.reasons.entry(reason).or_default() += 1;
        // Keep representative transitions and the latest failure, rather than
        // letting a per-frame startup failure overwrite the whole history.
        if self
            .diagnostics
            .back()
            .is_some_and(|last| last["reason"] == reason)
        {
            let last = self.diagnostics.back_mut().unwrap();
            last["last_local_us"] = json!(at.saturating_duration_since(self.began).as_micros());
            last["repetitions"] = json!(last["repetitions"].as_u64().unwrap() + 1);
            last["details"] = details;
            return;
        }
        if self.diagnostics.len() == 64 {
            self.diagnostics.pop_front();
        }
        self.diagnostics.push_back(json!({"reason":reason,
            "first_local_us":at.saturating_duration_since(self.began).as_micros(),
            "last_local_us":at.saturating_duration_since(self.began).as_micros(),
            "repetitions":1,"details":details}));
    }
    fn reset(&mut self, reason: &'static str, at: Instant, details: Value) {
        self.note(reason, at, details);
        self.audio = None;
        self.origin = None;
        self.last_video = None;
        self.resets += 1;
    }
    pub fn clear(&mut self) {
        self.reset("binding_clear", Instant::now(), Value::Null);
    }
    pub fn audio(
        &mut self,
        generation: u64,
        sequence: u64,
        origin_us: Option<i64>,
        pull: Instant,
    ) -> Option<Instant> {
        if self.audio.is_some_and(|(old, _, _)| old != generation) {
            self.reset(
                "audio_generation_changed",
                pull,
                json!({"generation":generation,"sequence":sequence}),
            );
        }
        let stamp = match self.audio {
            Some((_, previous, at)) if sequence > previous => {
                let delta = sequence.checked_sub(previous)?.checked_mul(10_000)?;
                let stamp = at.checked_add(Duration::from_micros(delta))?;
                // A callback/consumer stall cannot build an unbounded audio backlog.
                if pull.saturating_duration_since(stamp) > Duration::from_millis(30)
                    || stamp.saturating_duration_since(pull) > Duration::from_millis(250)
                {
                    self.reset(
                        "audio_deadline_out_of_bounds",
                        pull,
                        json!({
                        "generation":generation,"sequence":sequence,"previous_sequence":previous,
                        "late_us":pull.saturating_duration_since(stamp).as_micros(),
                        "lead_us":stamp.saturating_duration_since(pull).as_micros()}),
                    );
                    if origin_us.is_none() {
                        self.audio_startup_dropped += 1;
                        return None;
                    }
                    pull.checked_add(self.delay)?
                } else {
                    stamp
                }
            }
            Some(_) => {
                self.reset(
                    "audio_sequence_regressed",
                    pull,
                    json!({"generation":generation,"sequence":sequence}),
                );
                if origin_us.is_none() {
                    self.audio_startup_dropped += 1;
                    return None;
                }
                pull.checked_add(self.delay)?
            }
            None => {
                if origin_us.is_none() {
                    self.audio_startup_dropped += 1;
                    self.note(
                        "audio_waiting_for_maps",
                        pull,
                        json!({"generation":generation,"sequence":sequence}),
                    );
                    return None;
                }
                pull.checked_add(self.delay)?
            }
        };
        self.audio = Some((generation, sequence, stamp));
        if let Some(origin) = origin_us {
            self.origin = Some((origin, stamp, pull));
        }
        self.audio_submitted += 1;
        Some(stamp)
    }
    pub fn video(&mut self, sender_us: Option<i64>, arrival: Instant) -> Option<Instant> {
        let result: Result<Instant, (&'static str, Value)> = (|| {
            let (audio_origin, audio_stamp, observed) =
                self.origin.ok_or(("video_no_audio_origin", Value::Null))?;
            let age = arrival.saturating_duration_since(observed).as_micros();
            if age > 200_000 {
                return Err(("video_stale_audio_origin", json!({"age_us":age})));
            }
            let sender = sender_us.ok_or(("video_no_sender_map", Value::Null))?;
            let delta = sender
                .checked_sub(audio_origin)
                .ok_or(("video_arithmetic_overflow", Value::Null))?;
            let details = json!({"sender_us":sender,"audio_origin_us":audio_origin,"delta_us":delta,"origin_age_us":age});
            if delta.unsigned_abs() > 500_000 {
                return Err(("video_origin_delta_out_of_bounds", details));
            }
            let stamp = if delta >= 0 {
                audio_stamp.checked_add(Duration::from_micros(delta as u64))
            } else {
                audio_stamp.checked_sub(Duration::from_micros(delta.unsigned_abs()))
            }
            .ok_or(("video_arithmetic_overflow", Value::Null))?;
            let mut details = details;
            let late = arrival.saturating_duration_since(stamp).as_micros();
            let lead = stamp.saturating_duration_since(arrival).as_micros();
            details["late_us"] = json!(late);
            details["lead_us"] = json!(lead);
            if late > 30_000 {
                return Err(("video_deadline_late", details));
            }
            if lead > 250_000 {
                return Err(("video_deadline_too_early", details));
            }
            if let Some(last) = self.last_video {
                if stamp <= last {
                    details["regression_us"] =
                        json!(last.saturating_duration_since(stamp).as_micros());
                    return Err(("video_deadline_nonmonotonic", details));
                }
            }
            Ok(stamp)
        })();
        match result {
            Ok(stamp) => {
                self.video_submitted += 1;
                self.last_video = Some(stamp);
                Some(stamp)
            }
            Err((reason, details)) => {
                self.video_rejected += 1;
                self.note(reason, arrival, details);
                None
            }
        }
    }
    pub fn report(&self) -> Value {
        json!({"audio_master":true,"presentation_delay_ms":self.delay.as_millis(),
            "audio_submitted":self.audio_submitted,"audio_startup_dropped":self.audio_startup_dropped,
            "video_submitted":self.video_submitted,"video_rejected":self.video_rejected,"clock_resets":self.resets,"failure_reasons":self.reasons,"diagnostics":self.diagnostics,
            "sender_capture_time_qualified":false})
    }
}
pub struct SelectedPlayback {
    pub clock: Presentation,
    pub audio_binding: Option<(String, u32)>,
    pub video_binding: Option<(String, u32, SenderClock, i64)>,
    pub since_us: i64,
    pub unmatched_audio: u64,
    pub invalid_audio_pull: u64,
    began: Instant,
    audio_marker_active: bool,
    video_marker_active: bool,
    markers: Vec<Value>,
}
impl SelectedPlayback {
    pub fn new(since_us: i64) -> Self {
        Self {
            clock: Presentation::new(Duration::from_millis(120)),
            audio_binding: None,
            video_binding: None,
            since_us,
            unmatched_audio: 0,
            invalid_audio_pull: 0,
            began: Instant::now(),
            audio_marker_active: false,
            video_marker_active: false,
            markers: Vec::with_capacity(64),
        }
    }
    pub fn clear(&mut self, since_us: i64) {
        self.clock.clear();
        self.audio_binding = None;
        self.video_binding = None;
        self.since_us = since_us;
        self.audio_marker_active = false;
        self.video_marker_active = false;
    }
    pub fn refresh(&mut self, rtcp: &Value) {
        let Some((_, ssrc, clock, seen)) = &mut self.video_binding else {
            return;
        };
        let mut reports: Vec<SenderReport> = rtcp["peers"]
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
            .filter_map(|report| serde_json::from_value(report.clone()).ok())
            .collect();
        reports.sort_by_key(|report| report.observed_us);
        for report in reports {
            if report.ssrc == *ssrc && report.observed_us > *seen {
                clock.observe(report);
                *seen = report.observed_us;
            }
        }
    }
    pub fn marker(
        &mut self,
        video: bool,
        active: bool,
        origin: Option<i64>,
        stamp: Instant,
        arrived: Instant,
        obs_target_ns: u64,
    ) {
        let previous = if video {
            &mut self.video_marker_active
        } else {
            &mut self.audio_marker_active
        };
        if active && !*previous && self.markers.len() < 64 {
            self.markers.push(json!({"kind":if video {"video"} else {"audio"},"origin_ntp_us":origin,"obs_target_ns":obs_target_ns,
                "scheduled_local_us":stamp.saturating_duration_since(self.began).as_micros(),
                "arrival_local_us":arrived.saturating_duration_since(self.began).as_micros(),"binding_since_us":self.since_us}));
        }
        *previous = active;
    }
    pub fn video_ready(&self, now_us: i64) -> bool {
        self.video_binding
            .as_ref()
            .is_some_and(|(_, _, clock, _)| clock.ready(now_us))
    }
    pub fn video_origin(&self, sid: &str, rtp: u32, now_us: i64) -> Option<i64> {
        let (bound, _, clock, _) = self.video_binding.as_ref()?;
        if bound != sid {
            return None;
        }
        clock.origin_ntp_us(rtp, now_us)
    }
    pub fn report(&self) -> Value {
        json!({"clock":self.clock.report(),"audio_binding":self.audio_binding,
            "video_binding":self.video_binding.as_ref().map(|(sid,ssrc,clock,_)|json!({
                "sid":sid,"ssrc":ssrc,"clock_resets":clock.resets,"rejected_reports":clock.rejected})),
            "input_marker_deadlines":self.markers,"unmatched_audio_blocks":self.unmatched_audio,"invalid_audio_pull":self.invalid_audio_pull,
            "startup_policy":"wait for fresh audio and video two-report maps; no arrival fallback",
            "obs_sync_qualified":false})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_deadlines_are_explained_without_unbounding_history() {
        let now = Instant::now();
        let mut clock = Presentation::new(Duration::from_millis(120));
        for _ in 0..1000 {
            assert_eq!(clock.video(Some(1_000_000), now), None);
        }
        assert_eq!(clock.diagnostics.len(), 1);
        assert_eq!(
            clock.report()["failure_reasons"]["video_no_audio_origin"],
            1000
        );
        clock.audio(1, 1, Some(1_000_000), now).unwrap();
        assert_eq!(clock.video(Some(1_140_000), now), None);
        assert_eq!(
            clock.report()["failure_reasons"]["video_deadline_too_early"],
            1
        );
        assert_eq!(clock.video(Some(840_000), now), None);
        assert_eq!(clock.report()["failure_reasons"]["video_deadline_late"], 1);
        for _ in 0..100 {
            clock.video(None, now);
            clock.video(Some(1_140_000), now);
        }
        assert_eq!(clock.diagnostics.len(), 64);
        assert_eq!(
            clock.video(Some(1_000_000), now),
            Some(now + Duration::from_millis(120))
        );
        assert_eq!(clock.video(Some(1_000_000), now), None);
        assert_eq!(
            clock.report()["failure_reasons"]["video_deadline_nonmonotonic"],
            1
        );
    }
    #[test]
    fn audio_stays_continuous_while_video_follows_current_sender_origin() {
        let now = Instant::now();
        let mut clock = Presentation::new(Duration::from_millis(120));
        let first = clock.audio(1, 1, Some(1_000_000), now).unwrap();
        assert_eq!(
            clock.audio(1, 2, Some(1_000_000), now + Duration::from_millis(10)),
            Some(first + Duration::from_millis(10))
        );
        assert_eq!(
            clock.video(Some(1_005_000), now + Duration::from_millis(10)),
            Some(first + Duration::from_millis(15))
        );
        assert_eq!(
            clock.audio(1, 3, Some(1_027_500), now + Duration::from_millis(20)),
            Some(first + Duration::from_millis(20))
        );
        assert_eq!(
            clock.audio(1, 6, None, now + Duration::from_millis(50)),
            Some(first + Duration::from_millis(50))
        );
    }
    #[test]
    fn generations_startup_stalls_and_stale_video_cannot_reuse_old_clock() {
        let now = Instant::now();
        let mut clock = Presentation::new(Duration::from_millis(120));
        assert_eq!(clock.audio(1, 1, None, now), None);
        let first = clock.audio(1, 2, Some(1_000_000), now).unwrap();
        assert_eq!(clock.video(Some(1_000_000), now), Some(first));
        assert_eq!(clock.video(Some(999_999), now), None);
        assert_eq!(
            clock.video(Some(1_000_000), now + Duration::from_millis(201)),
            None
        );
        assert_eq!(clock.audio(2, 1, None, now), None);
        assert_eq!(clock.video(Some(1_000_000), now), None);
        clock.audio(2, 2, Some(2_000_000), now);
        assert_eq!(clock.audio(2, 3, None, now + Duration::from_secs(1)), None);
        assert_eq!(
            clock.video(Some(2_000_000), now + Duration::from_secs(1)),
            None
        );
        assert_eq!(
            clock.audio(2, 4, Some(3_000_000), now + Duration::from_secs(1)),
            Some(now + Duration::from_millis(1120))
        );
    }
}

/// Application owns the short presentation queue; OBS receives due frames only.
pub struct Scheduled<T> {
    entries: std::collections::VecDeque<(Instant, T)>,
    capacity: usize,
    pushed: u64,
    submitted: u64,
    overflow: u64,
    late: u64,
    flushed: u64,
}
impl<T> Scheduled<T> {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0);
        Self {
            entries: std::collections::VecDeque::with_capacity(capacity),
            capacity,
            pushed: 0,
            submitted: 0,
            overflow: 0,
            late: 0,
            flushed: 0,
        }
    }
    pub fn push(&mut self, stamp: Instant, value: T) {
        self.pushed += 1;
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
            self.overflow += 1;
        }
        self.entries.push_back((stamp, value));
    }
    pub fn pop_due(&mut self, now: Instant) -> Option<(Instant, T)> {
        while self.entries.front().is_some_and(|(stamp, _)| *stamp <= now) {
            let (stamp, value) = self.entries.pop_front().unwrap();
            if now.duration_since(stamp) > Duration::from_millis(30) {
                self.late += 1;
            } else {
                self.submitted += 1;
                return Some((stamp, value));
            }
        }
        None
    }
    pub fn clear(&mut self) {
        self.flushed += self.entries.len() as u64;
        self.entries.clear();
    }
    pub fn report(&self) -> Value {
        json!({"capacity":self.capacity,"pushed":self.pushed,"submitted":self.submitted,
            "overflow":self.overflow,"late":self.late,"flushed":self.flushed,"pending":self.entries.len()})
    }
}
#[cfg(test)]
mod scheduled_tests {
    use super::*;
    #[test]
    fn presentation_queue_waits_for_deadline_and_discards_stalled_or_cancelled_frames() {
        let now = Instant::now();
        let mut q = Scheduled::new(2);
        q.push(now + Duration::from_millis(120), 1);
        assert!(q.pop_due(now).is_none());
        q.push(now + Duration::from_millis(130), 2);
        q.push(now + Duration::from_millis(140), 3);
        assert_eq!(q.report()["overflow"], 1);
        assert_eq!(q.pop_due(now + Duration::from_millis(130)).unwrap().1, 2);
        assert!(q.pop_due(now + Duration::from_millis(180)).is_none());
        assert_eq!(q.report()["late"], 1);
        q.push(now + Duration::from_millis(200), 4);
        q.clear();
        assert!(q.pop_due(now + Duration::from_millis(200)).is_none());
        let r = q.report();
        assert_eq!(
            r["pushed"].as_u64().unwrap(),
            ["submitted", "overflow", "late", "flushed", "pending"]
                .iter()
                .map(|key| r[key].as_u64().unwrap())
                .sum::<u64>()
        );
    }
}
