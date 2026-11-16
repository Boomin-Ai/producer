use crate::contract::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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
        if self.looping {
            Ok(position.loop_offset(self.duration)?.0)
        } else {
            Ok(position.min(self.duration))
        }
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
        let p = self.position(now)?;
        self.seek(p, now)?;
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
        let p = self.position(now)?;
        self.seek(p, now)?;
        self.pauses.insert(reason.into());
        Ok(())
    }
    pub fn resume(&mut self, reason: &str, now: OutputInstant) -> Result<()> {
        let p = self.position(now)?;
        self.seek(p, now)?;
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
}
#[derive(Debug, Clone)]
pub struct CueCursor {
    pub run: Counter,
    previous: Time,
    duration: Time,
    cues: Vec<Cue>,
    started: bool,
}
impl CueCursor {
    pub fn new(run: Counter, duration: Time, mut cues: Vec<Cue>) -> Self {
        cues.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
        Self {
            run,
            previous: Time::ZERO,
            duration,
            cues,
            started: false,
        }
    }
    pub fn start(&mut self) -> Result<Vec<CueIntent>> {
        if self.started {
            return Ok(vec![]);
        }
        let out: Vec<_> = self
            .cues
            .iter()
            .filter(|c| c.at == Time::ZERO && c.at_start)
            .map(|c| CueIntent {
                run: self.run,
                cue: c.id.clone(),
                occurrence: Counter(0),
            })
            .take(65)
            .collect();
        if out.len() > 64 {
            return Err(Error::new(
                "CUE_CATCHUP_LIMIT",
                "cue",
                "too many start cues",
            ));
        }
        self.started = true;
        Ok(out)
    }
    /// Silent reconstruction never emits an action. The cursor itself is the dedupe state.
    pub fn seek_silent(&mut self, to: Time) -> Result<()> {
        if to < Time::ZERO {
            return Err(Error::new("RANGE", "cue", "negative cue cursor"));
        }
        self.previous = to;
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
        let (_, first) = self.previous.loop_offset(self.duration)?;
        let (_, last) = to.loop_offset(self.duration)?;
        if last.saturating_sub(first) > 64 && self.cues.iter().any(|c| c.each_loop) {
            return Err(Error::new(
                "CUE_CATCHUP_LIMIT",
                "cue",
                "explicit silent seek/rearm required",
            ));
        }
        let mut out = Vec::new();
        for occurrence in first..=last.min(first.saturating_add(64)) {
            if occurrence > 0 && self.cues.iter().all(|c| !c.each_loop) {
                break;
            }
            let offset = self.duration.times(occurrence)?;
            for c in &self.cues {
                if (occurrence > 0 && !c.each_loop) || (occurrence == 0 && c.at == Time::ZERO) {
                    continue;
                }
                let at = offset.checked_add(c.at)?;
                if at > self.previous && at <= to {
                    out.push(CueIntent {
                        run: self.run,
                        cue: c.id.clone(),
                        occurrence: Counter(occurrence),
                    });
                    if out.len() > 64 {
                        return Err(Error::new(
                            "CUE_CATCHUP_LIMIT",
                            "cue",
                            "explicit silent seek/rearm required",
                        ));
                    }
                }
            }
        }
        self.previous = to;
        Ok(out)
    }
}
