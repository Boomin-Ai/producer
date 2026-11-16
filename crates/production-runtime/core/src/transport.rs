use crate::{
    compile::{CuePlan, SequencePlan},
    contract::*,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::Arc;

/// Monotonic output nanoseconds, not sequence content position.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct OutputInstant(pub Counter);
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputClock {
    pub epoch: Counter,
    pub last: OutputInstant,
}
impl OutputClock {
    pub fn advance(&mut self, now: OutputInstant) -> Result<()> {
        if now < self.last {
            return Err(Error::new(
                "OUTPUT_TIME_REVERSED",
                "output",
                "recording/output time cannot seek",
            ));
        }
        self.last = now;
        Ok(())
    }
    pub fn new_epoch(&mut self, now: OutputInstant) -> Result<()> {
        self.advance(now)?;
        self.epoch.0 = self
            .epoch
            .0
            .checked_add(1)
            .ok_or_else(|| Error::new("EPOCH_EXHAUSTED", "output", "new execution required"))?;
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transport {
    pub epoch: Counter,
    pub duration: Time,
    pub looping: bool,
    anchor: OutputInstant,
    position: Time,
    playing: bool,
    pauses: BTreeSet<String>,
}
impl Transport {
    pub fn is_paused(&self) -> bool {
        !self.pauses.is_empty()
    }
    pub fn new(duration: Time, now: OutputInstant) -> Result<Self> {
        if duration <= Time::ZERO {
            return Err(Error::new(
                "RANGE",
                "transport",
                "positive duration required",
            ));
        }
        Ok(Self {
            epoch: Counter(1),
            duration,
            looping: false,
            anchor: now,
            position: Time::ZERO,
            playing: false,
            pauses: BTreeSet::new(),
        })
    }
    fn bump(&mut self) -> Result<()> {
        self.epoch.0 =
            self.epoch.0.checked_add(1).ok_or_else(|| {
                Error::new("EPOCH_EXHAUSTED", "transport", "new execution required")
            })?;
        Ok(())
    }
    pub fn position(&self, now: OutputInstant) -> Result<Time> {
        let position = self.progress(now)?;
        if self.looping {
            Ok(position.loop_offset(self.duration)?.0)
        } else {
            Ok(position.min(self.duration))
        }
    }
    /// Unwrapped content progression preserves loop occurrence identity. Display
    /// position may wrap; cue ownership must never use the wrapped UI value.
    pub fn progress(&self, now: OutputInstant) -> Result<Time> {
        let elapsed = now.0 .0.checked_sub(self.anchor.0 .0).ok_or_else(|| {
            Error::new(
                "OUTPUT_TIME_REVERSED",
                "transport",
                "output instant predates anchor",
            )
        })?;
        if !self.playing || !self.pauses.is_empty() {
            return Ok(self.position);
        }
        let dt = Time::new(
            i64::try_from(elapsed).map_err(|_| {
                Error::new(
                    "TIME_UNREPRESENTABLE",
                    "transport",
                    "output interval too large",
                )
            })?,
            1_000_000_000,
        )?;
        let position = self.position.checked_add(dt)?;
        Ok(if self.looping {
            position
        } else {
            position.min(self.duration)
        })
    }
    pub fn seek(&mut self, to: Time, now: OutputInstant) -> Result<()> {
        if to < Time::ZERO || to > self.duration || now < self.anchor {
            return Err(Error::new(
                "RANGE",
                "transport",
                "seek outside sequence/clock",
            ));
        }
        self.bump()?;
        self.position = to;
        self.anchor = now;
        Ok(())
    }
    pub fn play(&mut self, now: OutputInstant) -> Result<()> {
        let p = self.progress(now)?;
        self.bump()?;
        self.position = p;
        self.anchor = now;
        self.playing = true;
        Ok(())
    }
    pub fn pause(&mut self, reason: &str, now: OutputInstant) -> Result<()> {
        if !validate::valid_id(reason) || (!self.pauses.contains(reason) && self.pauses.len() >= 64)
        {
            return Err(Error::new(
                "PAUSE_LIMIT",
                "transport",
                "bounded owned reason required",
            ));
        }
        let p = self.progress(now)?;
        self.bump()?;
        self.position = p;
        self.anchor = now;
        self.pauses.insert(reason.into());
        Ok(())
    }
    pub fn resume(&mut self, reason: &str, now: OutputInstant) -> Result<()> {
        let p = self.progress(now)?;
        self.bump()?;
        self.position = p;
        self.anchor = now;
        self.pauses.remove(reason);
        Ok(())
    }
    pub fn stop(&mut self, now: OutputInstant) -> Result<()> {
        self.seek(Time::ZERO, now)?;
        self.playing = false;
        self.pauses.clear();
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CueIntent {
    pub run: Counter,
    pub cue: String,
    pub occurrence: Counter,
    pub path: String,
    pub ancestry: Vec<Counter>,
    pub at: Time,
}
#[derive(Debug, Clone)]
pub struct CueCursor {
    pub run: Counter,
    previous: Time,
    frontier: Time,
    duration: Time,
    cues: Arc<[CuePlan]>,
    started: bool,
    stopped: bool,
    looping: bool,
}
impl CueCursor {
    pub fn new(run: Counter, duration: Time, cues: Vec<Cue>) -> Self {
        Self {
            run,
            previous: Time::ZERO,
            frontier: Time::ZERO,
            duration,
            cues: cues
                .into_iter()
                .map(|cue| CuePlan {
                    path: cue.id.clone(),
                    cue,
                    maps: vec![],
                })
                .collect::<Vec<_>>()
                .into(),
            started: false,
            stopped: false,
            looping: true,
        }
    }
    pub fn from_sequence(run: Counter, sequence: &SequencePlan, looping: bool) -> Self {
        Self {
            cues: sequence.cues.clone().into(),
            looping,
            ..Self::new(run, sequence.duration, vec![])
        }
    }
    /// Explicit rearm starts a new effect identity; seeking never does this.
    pub fn rearm(&mut self, run: Counter) -> Result<()> {
        if run <= self.run {
            return Err(Error::new(
                "RUN_ID",
                "cue",
                "rearm requires a fresh increasing native run ID",
            ));
        }
        self.run = run;
        self.previous = Time::ZERO;
        self.frontier = Time::ZERO;
        self.started = false;
        self.stopped = false;
        Ok(())
    }
    pub fn stop(&mut self) {
        self.stopped = true;
    }
    pub fn start(&mut self) -> Result<Vec<CueIntent>> {
        if self.started || self.stopped {
            return Ok(vec![]);
        }
        let out = self.collect(Time::ZERO, Time::ZERO, true)?;
        self.started = true;
        Ok(out)
    }
    /// Silent reconstruction consumes skipped history. Rewinding retains the
    /// effect frontier, so old sound cues cannot replay without explicit rearm.
    pub fn seek_silent(&mut self, to: Time) -> Result<()> {
        if to < Time::ZERO || (!self.looping && to > self.duration) {
            return Err(Error::new("RANGE", "cue", "negative cue cursor"));
        }
        self.previous = to;
        self.frontier = self.frontier.max(to);
        self.started = true;
        Ok(())
    }
    pub fn advance(&mut self, to: Time) -> Result<Vec<CueIntent>> {
        if to < self.previous {
            return Err(Error::new(
                "CUE_SEEK_REQUIRED",
                "cue",
                "backward advance requires silent seek",
            ));
        }
        if to < Time::ZERO || (!self.looping && to > self.duration) {
            return Err(Error::new("RANGE", "cue", "cursor outside content domain"));
        }
        let out = if self.stopped || to <= self.frontier {
            vec![]
        } else {
            self.collect(self.previous.max(self.frontier), to, false)?
        };
        self.previous = to;
        self.frontier = self.frontier.max(to);
        self.started = true;
        Ok(out)
    }
    fn collect(&self, from: Time, to: Time, start: bool) -> Result<Vec<CueIntent>> {
        let (_, first) = from.loop_offset(self.duration)?;
        let (_, last) = to.loop_offset(self.duration)?;
        let mut work = 4096usize;
        let mut out = Vec::new();
        for plan in self.cues.iter() {
            let last = if self.looping { last } else { 0 };
            let begin = if plan.cue.each_loop { first } else { 0 };
            let end = if plan.cue.each_loop { last } else { 0 };
            if begin > end {
                continue;
            }
            for occurrence in begin..=end {
                cue_work(&mut work)?;
                let offset = self.duration.times(occurrence)?;
                let lo = from.checked_sub(offset)?.max(Time::ZERO);
                let hi = to.checked_sub(offset)?.min(self.duration);
                if lo > hi {
                    continue;
                }
                let mut ancestry = [Counter(0); TEMPORAL_DEPTH];
                let mut found = Vec::new();
                cue_points(plan, 0, lo, hi, &mut ancestry, &mut work, &mut found)?;
                for (local, counts) in found {
                    let at = offset.checked_add(local)?;
                    let repeated = occurrence > 0 || counts.iter().any(|c| c.0 > 0);
                    if (repeated && !plan.cue.each_loop)
                        || (plan.cue.at == Time::ZERO && !repeated && !plan.cue.at_start)
                        || (at == Time::ZERO && !plan.cue.at_start)
                        || !(if start {
                            at == Time::ZERO
                        } else {
                            at > from && at <= to
                        })
                    {
                        continue;
                    }
                    out.push(CueIntent {
                        run: self.run,
                        cue: plan.cue.id.clone(),
                        occurrence: Counter(occurrence),
                        path: plan.path.clone(),
                        ancestry: counts,
                        at,
                    });
                    if out.len() > 64 {
                        return Err(cue_limit());
                    }
                }
            }
        }
        out.sort_by(|a, b| {
            a.at.cmp(&b.at)
                .then(a.path.cmp(&b.path))
                .then(a.occurrence.cmp(&b.occurrence))
                .then(a.ancestry.cmp(&b.ancestry))
        });
        Ok(out)
    }
}
fn cue_limit() -> Error {
    Error::new(
        "CUE_CATCHUP_LIMIT",
        "cue",
        "maximum 64 intents or 4096 projection steps; explicit silent seek/rearm required",
    )
}
fn cue_work(work: &mut usize) -> Result<()> {
    *work = work.checked_sub(1).ok_or_else(cue_limit)?;
    Ok(())
}
/// Query only the current crossing window. A 24-hour loop isn't expanded just
/// to discover the next cue. Occurrences are fixed-stack until a cue is emitted.
fn cue_points(
    plan: &CuePlan,
    depth: usize,
    lo: Time,
    hi: Time,
    ancestry: &mut [Counter; TEMPORAL_DEPTH],
    work: &mut usize,
    out: &mut Vec<(Time, Vec<Counter>)>,
) -> Result<()> {
    cue_work(work)?;
    if depth == plan.maps.len() {
        if plan.cue.at < lo || plan.cue.at > hi {
            return Ok(());
        }
        let mut time = plan.cue.at;
        for (map, count) in plan.maps.iter().zip(ancestry.iter()).rev() {
            time = map.inverse(time, count.0)?;
            if map
                .map(time)
                .map_err(|_| {
                    Error::new(
                        "TIME_UNREPRESENTABLE",
                        "cue",
                        "projected time outside profile",
                    )
                })?
                .is_none_or(|(_, occurrence)| occurrence != count.0)
            {
                return Ok(());
            }
        }
        out.push((time, ancestry[..depth].to_vec()));
        if out.len() > 64 {
            return Err(cue_limit());
        }
        return Ok(());
    }
    if depth >= TEMPORAL_DEPTH {
        return Err(cue_limit());
    }
    let map = plan.maps[depth];
    let lo = lo.max(map.range.start);
    let hi = hi.min(map.range.end()?);
    if lo > hi {
        return Ok(());
    }
    let source = |time: Time| {
        map.source_in
            .checked_sub(map.source_range.start)?
            .checked_add(time.checked_sub(map.range.start)?.scale(map.speed)?)
    };
    let a = source(lo)?;
    let b = source(hi)?;
    let first = if map.looping {
        a.loop_offset(map.source_range.duration)?.1
    } else {
        0
    };
    let last = if map.looping {
        b.loop_offset(map.source_range.duration)?.1
    } else {
        0
    };
    let (first, last) = if plan.cue.each_loop {
        (first, last)
    } else {
        (0, 0)
    };
    for occurrence in first..=last {
        cue_work(work)?;
        let offset = map.source_range.duration.times(occurrence)?;
        let local_lo = a.checked_sub(offset)?.max(Time::ZERO);
        let local_hi = b.checked_sub(offset)?.min(map.source_range.duration);
        if local_lo > local_hi {
            continue;
        }
        ancestry[depth] = Counter(occurrence);
        cue_points(
            plan,
            depth + 1,
            map.source_range.start.checked_add(local_lo)?,
            map.source_range.start.checked_add(local_hi)?,
            ancestry,
            work,
            out,
        )?;
    }
    Ok(())
}
