//! Lab audio-master clock. Sender origin labels the current PCM position;
//! it never replaces the continuous sample clock or claims capture time.
use crate::sender_clock::{SenderClock, SenderReport};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

pub struct Presentation {
    delay: Duration,
    max_video_lead: Duration,
    video_lead_total_us: u128,
    video_lead_max_us: u128,
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
            max_video_lead: Duration::from_millis(250),
            video_lead_total_us: 0,
            video_lead_max_us: 0,
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
    fn with_video_buffer(delay: Duration, extended: bool) -> Self {
        let mut clock = Self::new(delay);
        if extended {
            clock.max_video_lead = Duration::from_millis(400);
        }
        clock
    }
    pub fn video_capacity(&self) -> usize {
        if self.max_video_lead > Duration::from_millis(250) {
            14
        } else {
            8
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
            if lead > self.max_video_lead.as_micros() {
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
                let lead = stamp.saturating_duration_since(arrival).as_micros();
                self.video_lead_total_us += lead;
                self.video_lead_max_us = self.video_lead_max_us.max(lead);
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
            "video_max_lead_ms":self.max_video_lead.as_millis(),"video_mean_lead_us":self.video_lead_total_us.checked_div(u128::from(self.video_submitted)),"video_observed_max_lead_us":self.video_lead_max_us,"sender_capture_time_qualified":false})
    }
}
/// Bounded numeric observations; never changes scheduling or retains media.
#[derive(serde::Serialize)]
struct AudioLabelPoint {
    generation: u64,
    sequence: u64,
    rtp: u32,
    bootstrap: bool,
    origin_us: i64,
    local_us: u128,
    label_step_error_us: i128,
    label_shift_since_start_us: i128,
}
struct AudioLabels {
    began: Instant,
    first: Option<(u64, i64, Instant)>,
    previous: Option<(i64, Instant, bool)>,
    last_saved: Option<Instant>,
    points: VecDeque<AudioLabelPoint>,
    observations: u64,
    transitions: u64,
    max_step_error_us: u128,
    max_shift_us: u128,
}
impl AudioLabels {
    fn new() -> Self {
        Self {
            began: Instant::now(),
            first: None,
            previous: None,
            last_saved: None,
            points: VecDeque::with_capacity(192),
            observations: 0,
            transitions: 0,
            max_step_error_us: 0,
            max_shift_us: 0,
        }
    }
    fn clear(&mut self) {
        self.first = None;
        self.previous = None;
        self.last_saved = None;
    }
    fn observe(
        &mut self,
        generation: u64,
        sequence: u64,
        rtp: u32,
        bootstrap: bool,
        origin: i64,
        stamp: Instant,
    ) {
        if self.first.is_some_and(|(old, _, _)| old != generation) {
            self.clear();
        }
        let (_, first_origin, first_stamp) = *self.first.get_or_insert((generation, origin, stamp));
        let shift =
            i128::from(origin) - i128::from(first_origin) - signed_micros(stamp, first_stamp);
        let (step, transition) = self.previous.map_or(
            (0, false),
            |(previous, previous_stamp, previous_bootstrap)| {
                (
                    i128::from(origin)
                        - i128::from(previous)
                        - signed_micros(stamp, previous_stamp),
                    bootstrap != previous_bootstrap,
                )
            },
        );
        self.observations += 1;
        self.transitions += u64::from(transition);
        self.max_step_error_us = self.max_step_error_us.max(step.unsigned_abs());
        self.max_shift_us = self.max_shift_us.max(shift.unsigned_abs());
        if transition
            || step.unsigned_abs() > 30_000
            || self.last_saved.is_none_or(|last| {
                stamp.saturating_duration_since(last) >= Duration::from_millis(250)
            })
        {
            if self.points.len() == 192 {
                self.points.pop_front();
            }
            self.points.push_back(AudioLabelPoint {
                generation,
                sequence,
                rtp,
                bootstrap,
                origin_us: origin,
                local_us: stamp.saturating_duration_since(self.began).as_micros(),
                label_step_error_us: step,
                label_shift_since_start_us: shift,
            });
            self.last_saved = Some(stamp);
        }
        self.previous = Some((origin, stamp, bootstrap));
    }
    fn report(&self) -> Value {
        json!({"observations":self.observations,"bootstrap_transitions":self.transitions,
            "max_label_step_error_us":self.max_step_error_us,"max_label_shift_us":self.max_shift_us,
            "capacity":192,"points":self.points,"observations_only":true})
    }
}
fn signed_micros(left: Instant, right: Instant) -> i128 {
    if left >= right {
        left.duration_since(right).as_micros() as i128
    } else {
        -(right.duration_since(left).as_micros() as i128)
    }
}
pub struct SelectedPlayback {
    pub clock: Presentation,
    labels: AudioLabels,
    pub bootstrap: bool,
    pub audio_bootstrap_blocks: u64,
    video_bootstrap_frames: u64,
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
            clock: Presentation::with_video_buffer(
                Duration::from_millis(120),
                std::env::var("LIVEKIT_LAB_EXTENDED_VIDEO_BUFFER").as_deref() == Ok("1"),
            ),
            labels: AudioLabels::new(),
            bootstrap: std::env::var("LIVEKIT_LAB_FIRST_REPORT_BOOTSTRAP").as_deref() == Ok("1"),
            audio_bootstrap_blocks: 0,
            video_bootstrap_frames: 0,
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
        self.labels.clear();
        self.audio_binding = None;
        self.video_binding = None;
        self.since_us = since_us;
        self.audio_marker_active = false;
        self.video_marker_active = false;
    }
    pub fn audio_label(
        &mut self,
        generation: u64,
        sequence: u64,
        rtp: u32,
        bootstrap: bool,
        origin: i64,
        stamp: Instant,
    ) {
        self.labels
            .observe(generation, sequence, rtp, bootstrap, origin, stamp);
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
            .is_some_and(|(_, _, clock, _)| clock.playback_ready(now_us, self.bootstrap))
    }
    pub fn video_origin(&mut self, sid: &str, rtp: u32, now_us: i64) -> Option<i64> {
        let (bound, _, clock, _) = self.video_binding.as_ref()?;
        if bound != sid {
            return None;
        }
        let origin = clock.playback_origin(rtp, now_us, self.bootstrap);
        if origin.is_some() && clock.origin_ntp_us(rtp, now_us).is_none() {
            self.video_bootstrap_frames += 1;
        }
        origin
    }
    pub fn report(&self) -> Value {
        json!({"clock":self.clock.report(),"audio_labels":self.labels.report(),"audio_binding":self.audio_binding,
            "video_binding":self.video_binding.as_ref().map(|(sid,ssrc,clock,_)|json!({
                "sid":sid,"ssrc":ssrc,"clock_resets":clock.resets,"rejected_reports":clock.rejected})),
            "input_marker_deadlines":self.markers,"unmatched_audio_blocks":self.unmatched_audio,"invalid_audio_pull":self.invalid_audio_pull,
            "startup_policy":if self.bootstrap {"lab first-report nominal-rate bootstrap, five-second bound; discontinuities require fresh pair"} else {"wait for fresh audio and video two-report maps; no arrival fallback"},"first_report_bootstrap":self.bootstrap,"audio_bootstrap_blocks":self.audio_bootstrap_blocks,"video_bootstrap_frames":self.video_bootstrap_frames,
            "obs_sync_qualified":false})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extended_buffer_retains_early_frames_but_keeps_a_hard_bound() {
        let now = Instant::now();
        let mut normal = Presentation::new(Duration::from_millis(120));
        let mut extended = Presentation::with_video_buffer(Duration::from_millis(120), true);
        normal.audio(1, 1, Some(1_000_000), now);
        extended.audio(1, 1, Some(1_000_000), now);
        assert_eq!(normal.video(Some(1_240_000), now), None);
        assert_eq!(
            extended.video(Some(1_240_000), now),
            Some(now + Duration::from_millis(360))
        );
        assert_eq!(extended.video(Some(1_281_000), now), None);
        assert_eq!(extended.video_capacity(), 14);
        assert_eq!(normal.video_capacity(), 8);
        assert_eq!(extended.report()["video_observed_max_lead_us"], 360_000);
    }
    #[test]
    fn label_trace_distinguishes_transition_jump_from_accumulated_drift() {
        let now = Instant::now();
        let mut labels = AudioLabels::new();
        labels.observe(1, 1, 0, true, 1_000_000, now);
        labels.observe(1, 2, 480, false, 1_050_000, now + Duration::from_millis(10));
        assert_eq!(labels.transitions, 1);
        assert_eq!(labels.max_step_error_us, 40_000);
        assert_eq!(labels.max_shift_us, 40_000);
        labels.observe(2, 1, 0, true, 10_000_000, now + Duration::from_secs(1));
        assert_eq!(labels.points.back().unwrap().label_shift_since_start_us, 0);
        for sequence in 2..1000 {
            labels.observe(
                2,
                sequence,
                0,
                true,
                10_000_000 + sequence as i64 * 1000,
                now + Duration::from_secs(1) + Duration::from_millis(sequence * 10),
            );
        }
        assert!(labels.max_shift_us > 8_000_000);
        assert!(labels.points.len() <= 192);
    }
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
