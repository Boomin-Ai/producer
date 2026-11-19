//! Headless Show execution. A segment entry is a fresh occurrence, even when
//! returning to the same definition. This is a control-lane state machine, not
//! an effect dispatcher or a media adapter.
use crate::{
    compile::{self, CompactValue, EvalError, Plan, Sample},
    contract::*,
    coordinator::RevokeFence,
    dependencies::{ResourceBinding, ResourceKind},
    drivers::{DriverLease, LeaseScope, Overrides},
    ownership::{
        Cleanup, Disposal, Lane, Ownership, OwnershipStatus, ReadId, Relation, ResourceId, ScopeId,
        ScopeKind,
    },
    timeline::{Timeline, TimelineEvent, TimelineSample},
    transport::{OutputClock, OutputInstant},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionScope {
    Set,
    Run,
    Segment,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum ShowEvent {
    Start {
        at: Counter,
        #[serde(default)]
        segment: Option<Id>,
    },
    Enter {
        at: Counter,
        segment: Id,
    },
    Next {
        at: Counter,
    },
    Previous {
        at: Counter,
    },
    Advance {
        at: Counter,
    },
    Seek {
        at: Counter,
        to: Time,
    },
    Pause {
        at: Counter,
        scope: ExecutionScope,
        owner: Id,
        reason: Id,
    },
    Resume {
        at: Counter,
        scope: ExecutionScope,
        owner: Id,
        reason: Id,
    },
    Override {
        at: Counter,
        scope: ExecutionScope,
        owner: Id,
        target: Target,
        value: Value,
    },
    Release {
        at: Counter,
        owner: Id,
        target: Target,
        token: Counter,
    },
    Stop {
        at: Counter,
    },
    Close {
        at: Counter,
    },
}
impl ShowEvent {
    fn at(&self) -> OutputInstant {
        OutputInstant(match self {
            Self::Start { at, .. }
            | Self::Enter { at, .. }
            | Self::Next { at }
            | Self::Previous { at }
            | Self::Advance { at }
            | Self::Seek { at, .. }
            | Self::Pause { at, .. }
            | Self::Resume { at, .. }
            | Self::Override { at, .. }
            | Self::Release { at, .. }
            | Self::Stop { at }
            | Self::Close { at } => *at,
        })
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowSample {
    pub execution: String,
    pub document: String,
    pub digest: String,
    pub show: String,
    pub run: Counter,
    pub occurrence: Counter,
    pub epoch: Counter,
    pub output: OutputInstant,
    pub active: bool,
    pub closed: bool,
    pub segment: Option<String>,
    pub landscape: Option<String>,
    pub vertical: Option<String>,
    pub paused: bool,
    pub overrides: usize,
    pub override_token: Option<Counter>,
    pub ownership: OwnershipStatus,
    pub set_resource: ResourceId,
    pub cleanup: Option<Cleanup>,
    pub timeline: Option<TimelineSample>,
}
#[derive(Clone)]
struct FrameDriver {
    target: usize,
    lease: DriverLease,
    tracks: Vec<usize>,
    fallback: usize,
}
#[derive(Clone)]
pub struct ShowRun {
    execution: String,
    document: String,
    id: String,
    definition: Show,
    plan: Arc<Plan>,
    grant: RevokeFence,
    output: OutputClock,
    run: Counter,
    occurrence: Counter,
    epoch: Counter,
    active: bool,
    closed: bool,
    selected: Option<usize>,
    ownership: Ownership,
    resources: Arc<BTreeMap<String, ResourceBinding>>,
    preparation: Option<Arc<crate::resources::Reservation>>,
    set_scope: ScopeId,
    set_resource: ResourceId,
    run_scope: Option<ScopeId>,
    segment_scope: Option<ScopeId>,
    timeline: Option<Timeline>,
    overrides: Overrides,
    drivers: Vec<FrameDriver>,
    frame_slots: usize,
    effect_slots: usize,
    pauses: BTreeMap<(ScopeId, String, String), String>,
    next_pause: u64,
}
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "show", message)
}
fn bump(n: Counter) -> Result<Counter> {
    n.0.checked_add(1)
        .map(Counter)
        .ok_or_else(|| fail("RUN_EXHAUSTED", "new Show execution required"))
}
impl ShowRun {
    /// Validates/compiles off callback. Native authority is never deserialized.
    pub fn compile(
        document: &Document,
        id: &str,
        grant: RevokeFence,
        now: OutputInstant,
    ) -> Result<Self> {
        let plan = compile::compile(document)?;
        Self::from_plan(document, plan, id, grant, now)
    }
    /// Only the already-validated synthetic prepare host may reuse this path.
    pub(crate) fn from_plan(
        document: &Document,
        plan: Plan,
        id: &str,
        grant: RevokeFence,
        now: OutputInstant,
    ) -> Result<Self> {
        if !grant.is_current() {
            return Err(fail("FORBIDDEN", "current native author grant required"));
        }
        let definition = document
            .shows
            .get(id)
            .ok_or_else(|| fail("SHOW_MISSING", "Show definition missing"))?
            .clone();
        if definition.authority != Authority::Local {
            return Err(fail("FORBIDDEN", "hosted Show is read-only"));
        }
        let installed = plan.dependencies.install()?;
        let set_path = format!("sets/{}", definition.set);
        let set_scope = installed.scopes[&set_path];
        let set_resource = installed.resources[&set_path].resource;
        let frame_slots = definition
            .segments
            .iter()
            .filter_map(|s| s.sequence.as_ref())
            .map(|id| plan.sequences[id].tracks.len())
            .max()
            .unwrap_or(0)
            + 256;
        let effect_slots = definition
            .segments
            .iter()
            .filter_map(|s| s.sequence.as_ref())
            .map(|id| plan.sequences[id].effects.len())
            .max()
            .unwrap_or(0);
        Ok(Self {
            execution: uuid::Uuid::new_v4().to_string(),
            document: document.id.clone(),
            id: id.into(),
            definition,
            drivers: Vec::with_capacity(256),
            frame_slots,
            effect_slots,
            plan: Arc::new(plan),
            grant,
            output: OutputClock {
                epoch: Counter(1),
                last: now,
            },
            run: Counter(0),
            occurrence: Counter(0),
            epoch: Counter(0),
            active: false,
            closed: false,
            selected: None,
            ownership: installed.ownership,
            resources: installed.resources,
            preparation: None,
            set_scope,
            set_resource,
            run_scope: None,
            segment_scope: None,
            timeline: None,
            overrides: Overrides::default(),
            pauses: BTreeMap::new(),
            next_pause: 0,
        })
    }
    fn scope(&self, scope: ExecutionScope) -> Result<ScopeId> {
        if !self.active {
            return Err(fail("RUN_STOPPED", "start a Show run first"));
        }
        match scope {
            ExecutionScope::Set => Ok(self.set_scope),
            ExecutionScope::Run => self
                .run_scope
                .ok_or_else(|| fail("RUN_STOPPED", "run scope absent")),
            ExecutionScope::Segment => self
                .segment_scope
                .ok_or_else(|| fail("SEGMENT_MISSING", "enter a segment first")),
        }
    }
    fn clear_scope(&mut self, scope: ScopeId) -> Result<Cleanup> {
        let cleanup = self.ownership.leave(&[scope])?;
        self.overrides.clear_scopes(&cleanup.scopes);
        self.pauses
            .retain(|(s, _, _), _| !cleanup.scopes.contains(s));
        Ok(cleanup)
    }
    /// Independent stop/close lane: never waits for cue capacity, compilation,
    /// a current author grant or a counter increment. It cannot revive output.
    pub fn halt(&mut self, close: bool) -> Option<Cleanup> {
        let root = if close {
            Some(self.ownership.root())
        } else {
            self.run_scope
        };
        let cleanup = root.filter(|s| self.ownership.active(*s)).map(|s| {
            self.clear_scope(s)
                .expect("exit includes all Show-owned logical users")
        });
        self.active = false;
        self.closed |= close;
        self.timeline = None;
        self.epoch = Counter(self.epoch.0.saturating_add(1));
        self.overrides.clear();
        self.drivers.clear();
        self.pauses.clear();
        self.run_scope = None;
        self.segment_scope = None;
        cleanup
    }
    fn stop_scope(&mut self, close: bool) -> Option<Cleanup> {
        self.halt(close)
    }
    fn enter_segment(
        &mut self,
        index: usize,
        at: OutputInstant,
    ) -> Result<(Option<Cleanup>, Option<TimelineSample>)> {
        let cleanup = self
            .segment_scope
            .take()
            .map(|s| self.clear_scope(s))
            .transpose()?;
        let run = self
            .run_scope
            .ok_or_else(|| fail("RUN_STOPPED", "start a Show run first"))?;
        let scope = self.ownership.enter(run, ScopeKind::Segment)?;
        self.ownership
            .relate(scope, self.set_resource, Relation::Borrow)?;
        let segment = &self.definition.segments[index];
        for layout in [&segment.landscape, &segment.vertical] {
            let path = format!("sets/{}/layouts/{layout}", self.definition.set);
            self.ownership.relate(
                scope,
                self.resources[&path].resource,
                Relation::Presentation,
            )?;
        }
        if let Some(sequence) = &segment.sequence {
            let path = format!("sequences/{sequence}");
            self.ownership
                .relate(scope, self.resources[&path].resource, Relation::Borrow)?;
            for key in &self.plan.dependencies.resources[&path].dependencies {
                let binding = &self.resources[key];
                if binding.kind == ResourceKind::AudioRoute {
                    self.ownership
                        .relate(scope, binding.resource, Relation::Audio)?;
                }
            }
        }
        self.segment_scope = Some(scope);
        self.occurrence = bump(self.occurrence)?;
        self.selected = Some(index);
        self.timeline = self.definition.segments[index]
            .sequence
            .as_ref()
            .map(|id| Timeline::new(self.plan.sequences[id].clone(), false, at))
            .transpose()?;
        let mut sample = self
            .timeline
            .as_mut()
            .map(|t| t.apply(TimelineEvent::Start { at: at.0 }))
            .transpose()?;
        if let Some(t) = &mut self.timeline {
            // Restore only persistent, explicitly owned pause reasons.
            let mut cues = sample
                .as_mut()
                .map(|s| std::mem::take(&mut s.cues))
                .unwrap_or_default();
            for reason in self.pauses.values() {
                let mut next = t.apply(TimelineEvent::Pause {
                    at: at.0,
                    owner: reason.clone(),
                })?;
                cues.append(&mut next.cues);
                sample = Some(next);
            }
            if let Some(s) = &mut sample {
                s.cues = cues;
            }
        }
        Ok((cleanup, sample))
    }
    /// Atomic control-lane transition. Sampling is the separate evaluate_into path.
    pub fn apply(&mut self, event: ShowEvent) -> Result<ShowSample> {
        let stopping = matches!(event, ShowEvent::Stop { .. } | ShowEvent::Close { .. });
        let clock = matches!(event, ShowEvent::Advance { .. });
        let mut next = self.clone();
        let mut sample = next.apply_inner(event)?;
        if !stopping && self.grant.is_revoked() {
            let cleanup = next.halt(false);
            sample = next.sample(next.output.last, None, None, cleanup);
        } else if !stopping && !clock && !self.grant.is_current() {
            return Err(fail(
                "FORBIDDEN",
                "grant changed before transition publication",
            ));
        }
        next.refresh_drivers();
        *self = next;
        Ok(sample)
    }
    fn refresh_drivers(&mut self) {
        self.drivers.clear();
        let tracks = self
            .selected
            .and_then(|i| self.definition.segments[i].sequence.as_ref())
            .map(|id| self.plan.sequences[id].tracks.as_slice())
            .unwrap_or(&[]);
        for (target, description) in self.plan.targets.iter().enumerate() {
            if let Some(lease) = self.overrides.snapshot(description, Counter(1)) {
                self.drivers.push(FrameDriver {
                    target,
                    lease,
                    tracks: tracks
                        .iter()
                        .enumerate()
                        .filter_map(|(i, t)| (t.target == target).then_some(i))
                        .collect(),
                    fallback: tracks.len() + self.drivers.len(),
                });
            }
        }
    }
    /// The trusted transport calls this at the disconnect instant, alongside
    /// revoking its writable connection. Clock sampling may continue afterward.
    pub fn controller_disconnected(&mut self, owner: &str, at: OutputInstant) -> Result<()> {
        if self.closed || !validate::valid_id(owner) {
            return Err(fail("SCOPE_CLOSED", "active bounded controller required"));
        }
        let mut next = self.clone();
        next.output.advance(at)?;
        next.overrides.disconnect(owner, at)?;
        next.refresh_drivers();
        *self = next;
        Ok(())
    }
    /// Conservative work bound for a headless CLI rehearsal, not a frame cost.
    pub fn work_per_event(&self) -> usize {
        self.definition
            .segments
            .iter()
            .filter_map(|s| s.sequence.as_ref())
            .map(|id| {
                let s = &self.plan.sequences[id];
                s.tracks.len() + s.players.len() + s.cues.len() + s.effects.len() + 1
            })
            .max()
            .unwrap_or(1)
            + self.plan.dependencies.work()
    }
    fn apply_inner(&mut self, event: ShowEvent) -> Result<ShowSample> {
        let at = event.at();
        self.output.advance(at)?;
        if self.closed {
            return Err(fail("DOCUMENT_CLOSED", "Show execution is closed"));
        }
        let cleanup_event = matches!(event, ShowEvent::Stop { .. } | ShowEvent::Close { .. });
        if !cleanup_event && !matches!(event, ShowEvent::Advance { .. }) && !self.grant.is_current()
        {
            return Err(fail(
                "FORBIDDEN",
                "disconnected/revoked controller cannot write",
            ));
        }
        if self.grant.is_revoked() && !cleanup_event {
            let cleanup = self.stop_scope(false);
            return Ok(self.sample(at, None, None, cleanup));
        }
        let mut cleanup = None;
        let mut token = None;
        let mut timeline_event = None;
        let mut timeline_sample = None;
        match event {
            ShowEvent::Start { segment, .. } => {
                let index = segment.map(|id| self.index(&id)).transpose()?.unwrap_or(0);
                cleanup = self.stop_scope(false);
                self.run = bump(self.run)?;
                let run = self
                    .ownership
                    .enter(self.ownership.root(), ScopeKind::Run)?;
                self.ownership
                    .relate(run, self.set_resource, Relation::Borrow)?;
                self.run_scope = Some(run);
                self.active = true;
                (_, timeline_sample) = self.enter_segment(index, at)?;
                self.epoch = bump(self.epoch)?;
            }
            ShowEvent::Enter { segment, .. } => {
                let index = self.index(&segment)?;
                self.scope(ExecutionScope::Run)?;
                (cleanup, timeline_sample) = self.enter_segment(index, at)?;
                self.epoch = bump(self.epoch)?;
            }
            ShowEvent::Next { .. } | ShowEvent::Previous { .. } => {
                self.scope(ExecutionScope::Run)?;
                let current = self.selected.unwrap();
                let index = if matches!(event, ShowEvent::Next { .. }) {
                    current.checked_add(1)
                } else {
                    current.checked_sub(1)
                }
                .filter(|i| *i < self.definition.segments.len())
                .ok_or_else(|| {
                    fail(
                        "SEGMENT_BOUNDARY",
                        "no neighboring segment; no implicit restart",
                    )
                })?;
                (cleanup, timeline_sample) = self.enter_segment(index, at)?;
                self.epoch = bump(self.epoch)?;
            }
            ShowEvent::Advance { .. } => {
                timeline_event = Some(TimelineEvent::Advance { at: at.0 });
            }
            ShowEvent::Seek { to, .. } => {
                self.scope(ExecutionScope::Segment)?;
                if self.timeline.is_none() {
                    return Err(fail("SEQUENCE_MISSING", "this segment has no sequence"));
                }
                timeline_event = Some(TimelineEvent::Seek { at: at.0, to });
                self.epoch = bump(self.epoch)?;
            }
            ShowEvent::Pause {
                scope,
                owner,
                reason,
                ..
            } => {
                let s = self.scope(scope)?;
                if !validate::valid_id(&owner) || !validate::valid_id(&reason) {
                    return Err(fail(
                        "PAUSE_OWNER",
                        "bounded controller and reason IDs required",
                    ));
                }
                let key = (s, owner, reason);
                if !self.pauses.contains_key(&key) {
                    if self.pauses.len() >= 64 {
                        return Err(fail("PAUSE_LIMIT", "64 scoped pause reasons maximum"));
                    }
                    self.next_pause = self
                        .next_pause
                        .checked_add(1)
                        .ok_or_else(|| fail("RUN_EXHAUSTED", "pause counter exhausted"))?;
                    let name = format!("pause-{}", self.next_pause);
                    self.pauses.insert(key, name.clone());
                    timeline_event = Some(TimelineEvent::Pause {
                        at: at.0,
                        owner: name,
                    });
                    self.epoch = bump(self.epoch)?;
                }
            }
            ShowEvent::Resume {
                scope,
                owner,
                reason,
                ..
            } => {
                let s = self.scope(scope)?;
                let name = self.pauses.remove(&(s, owner, reason)).ok_or_else(|| {
                    fail(
                        "PAUSE_OWNER",
                        "only this controller's scoped reason can resume",
                    )
                })?;
                timeline_event = Some(TimelineEvent::Resume {
                    at: at.0,
                    owner: name,
                });
                self.epoch = bump(self.epoch)?;
            }
            ShowEvent::Override {
                scope,
                owner,
                target,
                value,
                ..
            } => {
                let lifetime = self.scope(scope)?;
                token = Some(self.overrides.acquire_scoped(
                    &owner,
                    target,
                    Counter(1),
                    value,
                    at,
                    &self.grant,
                    &self.plan.inventory,
                    LeaseScope {
                        lifetime,
                        run: self.run_scope.unwrap(),
                    },
                )?);
                self.epoch = bump(self.epoch)?;
            }
            ShowEvent::Release {
                owner,
                target,
                token,
                ..
            } => {
                self.overrides.release(&owner, &target, token)?;
                self.epoch = bump(self.epoch)?;
            }
            ShowEvent::Stop { .. } => {
                cleanup = self.stop_scope(false);
            }
            ShowEvent::Close { .. } => {
                cleanup = self.stop_scope(true);
            }
        }
        if timeline_sample.is_none() {
            if let Some(t) = &mut self.timeline {
                let event = timeline_event.unwrap_or(TimelineEvent::Advance { at: at.0 });
                // A manual segment can remain on output after its finite
                // sequence ends. Its owned pause reasons remain meaningful,
                // without trying to restart or pause that ended sequence.
                let event = if !t.is_active()
                    && matches!(
                        event,
                        TimelineEvent::Pause { .. } | TimelineEvent::Resume { .. }
                    ) {
                    TimelineEvent::Advance { at: at.0 }
                } else {
                    event
                };
                timeline_sample = Some(t.apply(event)?);
            }
        }
        if let Some(s) = &mut timeline_sample {
            for sample in s.values.iter_mut().flatten() {
                sample.value = self.overrides.resolve(
                    &self.plan.targets[sample.target],
                    Counter(1),
                    at,
                    sample.value,
                );
            }
        }
        Ok(self.sample(at, timeline_sample, token, cleanup))
    }
    fn index(&self, id: &str) -> Result<usize> {
        self.definition
            .segments
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| fail("SEGMENT_MISSING", "unknown segment"))
    }
    fn sample(
        &self,
        at: OutputInstant,
        timeline: Option<TimelineSample>,
        token: Option<Counter>,
        cleanup: Option<Cleanup>,
    ) -> ShowSample {
        let s = self.selected.map(|i| &self.definition.segments[i]);
        ShowSample {
            execution: self.execution.clone(),
            document: self.document.clone(),
            digest: self.plan.digest.clone(),
            show: self.id.clone(),
            run: self.run,
            occurrence: self.occurrence,
            epoch: self.epoch,
            output: at,
            active: self.active,
            closed: self.closed,
            segment: s.map(|s| s.id.clone()),
            landscape: s.map(|s| s.landscape.clone()),
            vertical: s.map(|s| s.vertical.clone()),
            paused: !self.pauses.is_empty(),
            overrides: self.overrides.count(),
            override_token: token,
            ownership: self.ownership.status(),
            set_resource: self.set_resource,
            cleanup,
            timeline,
        }
    }
    /// Control-lane inspection remains available after close so the adapter
    /// can identify and acknowledge a resource even if no run was started.
    pub fn status(&self) -> ShowSample {
        self.sample(self.output.last, None, None, None)
    }
    /// Preallocated numeric sampling; no JSON, strings, locks, IO or allocation.
    pub fn scratch_len(&self) -> usize {
        self.frame_slots
    }
    /// Preallocate for the largest segment; static Set adapters bind their own
    /// explicit content clock. This method samples only the scheduled sequence.
    pub fn effect_scratch_len(&self) -> usize {
        self.effect_slots
    }
    pub fn evaluate_effects_into(
        &self,
        at: OutputInstant,
        out: &mut [Option<crate::analytic::EffectInputs>],
    ) -> std::result::Result<(), EvalError> {
        if out.len() < self.effect_scratch_len() {
            return Err(EvalError::ScratchTooSmall);
        }
        out.fill(None);
        if !self.active || self.grant.is_revoked() {
            return Ok(());
        }
        if let Some(t) = &self.timeline {
            t.evaluate_effects_into(at, out)?;
        }
        Ok(())
    }
    pub fn evaluate_into(
        &self,
        at: OutputInstant,
        out: &mut [Option<Sample>],
    ) -> std::result::Result<(), EvalError> {
        out.fill(None);
        if !self.active || self.grant.is_revoked() {
            return Ok(());
        }
        if out.len() < self.frame_slots {
            return Err(EvalError::ScratchTooSmall);
        }
        if let Some(t) = &self.timeline {
            t.evaluate_into(at, out)?;
        }
        // An override is itself a driver, including in a static segment or
        // where no timeline track currently contributes a value.
        for driver in &self.drivers {
            if let Some(value) = driver.lease.value(at) {
                let mut found = false;
                for slot in &driver.tracks {
                    if let Some(sample) = &mut out[*slot] {
                        sample.value = value;
                        found = true;
                    }
                }
                if !found {
                    // Each lease has a reserved slot beyond this sequence's
                    // track slots, so inactive/static targets need no search.
                    out[driver.fallback] = Some(Sample {
                        target: driver.target,
                        value,
                    });
                }
            }
        }
        Ok(())
    }
    pub fn resolve(
        &self,
        target: &Target,
        at: OutputInstant,
        underlying: CompactValue,
    ) -> CompactValue {
        if !self.active || self.grant.is_revoked() {
            return underlying;
        }
        self.overrides.resolve(target, Counter(1), at, underlying)
    }
    pub fn accepts_completion(
        &self,
        execution: &str,
        run: Counter,
        occurrence: Counter,
        epoch: Counter,
    ) -> bool {
        self.active
            && !self.grant.is_revoked()
            && self.execution == execution
            && self.run == run
            && self.occurrence == occurrence
            && self.epoch == epoch
    }
    pub fn disposed(&mut self, resource: ResourceId, lane: Lane) -> Result<()> {
        self.ownership.disposed(resource, lane)?;
        if self.closed_and_disposed() {
            self.preparation = None;
        }
        Ok(())
    }
    pub(crate) fn pin_preparation(&mut self, reservation: Arc<crate::resources::Reservation>) {
        self.preparation = Some(reservation);
    }
    pub(crate) fn preparation_token(&self) -> Option<Counter> {
        self.preparation.as_ref().map(|r| Counter(r.id()))
    }
    /// Bounded, control-lane catalog. Handles are execution-specific and never
    /// supplied by the authored document or inferred from a source's asset hash.
    pub fn resources(&self) -> &BTreeMap<String, ResourceBinding> {
        &self.resources
    }
    pub fn disposal_ready(&self) -> Vec<Disposal> {
        self.ownership.disposal_ready()
    }
    /// Read a current layout/sequence/route and protect its transitive inputs.
    /// These model acknowledgments are not a real native callback fence yet.
    pub fn begin_read(&mut self, path: &str) -> Result<ReadId> {
        if !self.active || self.closed || self.grant.is_revoked() {
            return Err(fail("RUN_STOPPED", "active unrevoked segment required"));
        }
        let scope = self
            .segment_scope
            .ok_or_else(|| fail("SEGMENT_MISSING", "segment absent"))?;
        let resource = self
            .resources
            .get(path)
            .ok_or_else(|| fail("RESOURCE_RETIRED", "unknown compiled resource"))?
            .resource;
        self.ownership.read(scope, resource)
    }
    pub fn finish_read(&mut self, read: ReadId) -> Result<()> {
        self.ownership.finish_read(read)
    }
    pub fn closed_and_disposed(&self) -> bool {
        self.closed && self.ownership.status().resources == 0
    }
}
