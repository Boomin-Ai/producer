//! Serialized, headless sequence transport. This emits cue intents and sampled
//! values only. It never opens a decoder/capture or dispatches an external effect.
use crate::{compile::*, contract::*, transport::*};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum TimelineEvent {
    Start { at: Counter },
    Advance { at: Counter },
    Seek { at: Counter, to: Time },
    Pause { at: Counter, owner: Id },
    Resume { at: Counter, owner: Id },
    Stop { at: Counter },
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSample {
    pub path: String,
    pub source: String,
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<ClipControls>,
    pub source_time: Option<Time>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSample {
    pub execution: String,
    pub run: Counter,
    pub epoch: Counter,
    pub output: OutputInstant,
    pub position: Time,
    pub progress: Time,
    pub active: bool,
    pub paused: bool,
    pub cues: Vec<CueIntent>,
    pub values: Vec<Option<Sample>>,
    pub players: Vec<PlayerSample>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Option<crate::analytic::EffectInputs>>,
}
#[derive(Debug, Clone)]
pub struct Timeline {
    execution: String,
    run: Counter,
    plan: Arc<SequencePlan>,
    transport: Transport,
    cues: CueCursor,
    active: bool,
    output: OutputClock,
}
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "timeline", message)
}
impl Timeline {
    pub fn position(&self, at: OutputInstant) -> Result<Time> { self.transport.position(at) }
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn new(plan: Arc<SequencePlan>, looping: bool, now: OutputInstant) -> Result<Self> {
        let mut transport = Transport::new(plan.duration, now)?;
        transport.looping = looping;
        Ok(Self {
            execution: uuid::Uuid::new_v4().to_string(),
            run: Counter(0),
            cues: CueCursor::from_sequence(Counter(0), &plan, looping),
            plan,
            transport,
            active: false,
            output: OutputClock {
                epoch: Counter(1),
                last: now,
            },
        })
    }
    /// A failed operation leaves transport, effect cursor and output clock intact.
    /// This control-lane transaction may allocate; numeric evaluate_into does not.
    pub fn apply(&mut self, event: TimelineEvent) -> Result<TimelineSample> {
        let mut next = self.clone();
        let sample = next.apply_inner(event)?;
        *self = next;
        Ok(sample)
    }
    fn apply_inner(&mut self, event: TimelineEvent) -> Result<TimelineSample> {
        let at = match &event {
            TimelineEvent::Start { at }
            | TimelineEvent::Advance { at }
            | TimelineEvent::Seek { at, .. }
            | TimelineEvent::Pause { at, .. }
            | TimelineEvent::Resume { at, .. }
            | TimelineEvent::Stop { at } => OutputInstant(*at),
        };
        self.output.advance(at)?;
        let mut cues = vec![];
        match event {
            TimelineEvent::Start { .. } => {
                self.run = Counter(
                    self.run
                        .0
                        .checked_add(1)
                        .ok_or_else(|| fail("RUN_EXHAUSTED", "new execution required"))?,
                );
                self.transport.stop(at)?;
                self.transport.play(at)?;
                self.cues.rearm(self.run)?;
                cues = self.cues.start()?;
                self.active = true;
            }
            TimelineEvent::Advance { .. } if self.active => {
                let progress = self.transport.progress(at)?;
                cues = self.cues.advance(progress)?;
                if !self.transport.looping && progress >= self.plan.duration {
                    self.active = false;
                    self.cues.stop();
                }
            }
            TimelineEvent::Advance { .. } => {}
            TimelineEvent::Seek { to, .. } => {
                self.transport.seek(to, at)?;
                self.cues.seek_silent(to)?;
            }
            TimelineEvent::Pause { owner, .. } => {
                if !self.active {
                    return Err(fail("RUN_STOPPED", "start a run before pausing"));
                }
                cues = self.cues.advance(self.transport.progress(at)?)?;
                self.transport.pause(&owner, at)?;
            }
            TimelineEvent::Resume { owner, .. } => {
                if !self.active {
                    return Err(fail("RUN_STOPPED", "start a run before resuming"));
                }
                self.transport.resume(&owner, at)?;
            }
            TimelineEvent::Stop { .. } => {
                self.transport.stop(at)?;
                self.cues.stop();
                self.active = false;
            }
        }
        let position = self.transport.position(at)?;
        let mut values = vec![None; self.plan.tracks.len()];
        self.evaluate_into(at, &mut values).map_err(|_| {
            fail(
                "TIME_UNREPRESENTABLE",
                "mapped sample outside exact time profile",
            )
        })?;
        let players = self
            .plan
            .players
            .iter()
            .map(|p| {
                Ok(PlayerSample {
                    path: p.path.clone(),
                    source: p.source.clone(),
                    live: p.available.is_none(),
                    controls: if self.active && !p.envelopes.is_empty() { p.controls_at(position).map_err(|_| fail("TIME_UNREPRESENTABLE","clip automation time"))? } else { None },
                    source_time: if self.active {
                        p.sample(position).map_err(|_| {
                            fail("TIME_UNREPRESENTABLE", "file source time outside profile")
                        })?
                    } else {
                        None
                    },
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut effects = vec![None; self.plan.effects.len()];
        self.evaluate_effects_into(at, &mut effects).map_err(|_| {
            fail(
                "TIME_UNREPRESENTABLE",
                "analytic inputs outside exact time profile",
            )
        })?;
        Ok(TimelineSample {
            effects,
            execution: self.execution.clone(),
            run: self.run,
            epoch: self.transport.epoch,
            output: at,
            position,
            progress: self.transport.progress(at)?,
            active: self.active,
            paused: self.transport.is_paused(),
            cues,
            values,
            players,
        })
    }
    /// Callers preallocate the scratch buffer. It is not an authoring transaction.
    pub fn evaluate_into(
        &self,
        now: OutputInstant,
        values: &mut [Option<Sample>],
    ) -> std::result::Result<(), EvalError> {
        if values.len() < self.plan.tracks.len() {
            return Err(EvalError::ScratchTooSmall);
        }
        if !self.active {
            values.fill(None);
            return Ok(());
        }
        self.plan.evaluate_into(
            self.transport
                .position(now)
                .map_err(|_| EvalError::TimeRange)?,
            values,
        )
    }
    pub fn accepts_completion(&self, execution: &str, run: Counter, epoch: Counter) -> bool {
        self.active
            && execution == self.execution
            && run == self.run
            && epoch == self.transport.epoch
    }
    pub fn effect_scratch_len(&self) -> usize {
        self.plan.effects.len()
    }
    pub fn evaluate_effects_into(
        &self,
        at: OutputInstant,
        out: &mut [Option<crate::analytic::EffectInputs>],
    ) -> std::result::Result<(), EvalError> {
        if out.len() < self.effect_scratch_len() {
            return Err(EvalError::ScratchTooSmall);
        }
        if !self.active {
            out.fill(None);
            return Ok(());
        }
        self.plan.evaluate_effects_into(
            self.transport
                .position(at)
                .map_err(|_| EvalError::TimeRange)?,
            out,
        )
    }
}
