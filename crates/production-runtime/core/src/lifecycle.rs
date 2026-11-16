//! Synthetic adapter qualification model. This does not allocate or render GPU resources.
//! All methods run on the serialized control lane; callbacks only consume compiled plans.
use crate::{
    compile::{self, Plan},
    contract::*,
    coordinator::RevokeFence,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Cost {
    pub cpu: u64,
    pub gpu: u64,
    pub players: u32,
    pub captures: u32,
    pub browsers: u32,
    pub surfaces: u32,
    pub voices: u32,
}
pub const CAP: Cost = Cost {
    cpu: 256 << 20,
    gpu: 256 << 20,
    players: 16,
    captures: 4,
    browsers: 4,
    surfaces: 64,
    voices: 64,
};
impl Cost {
    fn checked_add(self, b: Self) -> Result<Self> {
        macro_rules! sum {
            ($f:ident) => {
                self.$f
                    .checked_add(b.$f)
                    .ok_or_else(|| fail("RESOURCE_LIMIT", "reservation overflow"))?
            };
        }
        Ok(Self {
            cpu: sum!(cpu),
            gpu: sum!(gpu),
            players: sum!(players),
            captures: sum!(captures),
            browsers: sum!(browsers),
            surfaces: sum!(surfaces),
            voices: sum!(voices),
        })
    }
    fn fits(self, cap: Self) -> bool {
        self.cpu <= cap.cpu
            && self.gpu <= cap.gpu
            && self.players <= cap.players
            && self.captures <= cap.captures
            && self.browsers <= cap.browsers
            && self.surfaces <= cap.surfaces
            && self.voices <= cap.voices
    }
    pub fn retire_slots(self) -> u32 {
        self.players + self.captures + self.browsers + self.surfaces + self.voices
    }
}
fn fail(code: &str, m: &str) -> Error {
    Error::new(code, "lifecycle", m)
}
fn source_identity(d: &Document, s: &Source) -> Result<String> {
    match s {
        Source::Player { asset } => digest(&(s, &d.assets[asset])),
        Source::Graphics { scene } => {
            let parameters: BTreeMap<_, _> = scene
                .parameters
                .iter()
                .map(|(id, p)| (id, p.property))
                .collect();
            let batches: Vec<_> = scene
                .batches
                .iter()
                .map(|b| {
                    (
                        &b.id,
                        &d.assets[&b.geometry],
                        &d.assets[&b.material],
                        b.instances,
                    )
                })
                .collect();
            digest(&(parameters, batches, scene.analytic))
        }
        Source::Live { .. } => digest(s),
    }
}

/// Every current/prepared/cached/unknown/retiring reservation is retained here.
#[derive(Default)]
pub struct Ledger {
    entries: BTreeMap<u64, Cost>,
    next: u64,
}
impl Ledger {
    pub fn used(&self) -> Cost {
        self.entries
            .values()
            .try_fold(Cost::default(), |a, b| a.checked_add(*b))
            .expect("admitted costs are bounded")
    }
    pub fn reserve(&mut self, cost: Cost) -> Result<u64> {
        if self.entries.len() >= 160 {
            return Err(fail("RESOURCE_LIMIT", "reservation handle limit reached"));
        }
        let total = self.used().checked_add(cost)?;
        if !total.fits(CAP) || total.retire_slots() > 152 {
            return Err(fail(
                "RESOURCE_LIMIT",
                "capacity includes future retirement slots",
            ));
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| fail("GENERATION_EXHAUSTED", "new runtime required"))?;
        self.entries.insert(self.next, cost);
        Ok(self.next)
    }
    fn release(&mut self, id: u64) {
        self.entries.remove(&id);
    }
}
/// Conservative fake costs, intentionally distinct from future native probe costs.
fn estimate(d: &Document) -> Result<Cost> {
    let inventory = validate_document(d)?;
    let mut c = Cost {
        cpu: ((inventory.expanded_nodes * 4096 + inventory.targets.len() * 256) as u64)
            + serde_json::to_vec(d).unwrap().len() as u64,
        ..Cost::default()
    };
    for source in d.sources.values() {
        match source {
            Source::Player { .. } => {
                c.players += 1;
                c.cpu += 3 * 1280 * 720 * 4;
                c.voices += 1;
            }
            Source::Live { .. } => c.captures += 1,
            Source::Graphics { scene } => {
                c.browsers += 1;
                c.gpu += scene
                    .batches
                    .iter()
                    .map(|b| b.instances as u64 * 64)
                    .sum::<u64>();
            }
        }
    }
    for s in d.sets.values() {
        for l in s.layouts.values() {
            c.surfaces += 1;
            c.gpu += l.width as u64 * l.height as u64 * 4;
        }
    }
    Ok(c)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Instance {
    pub incarnation: Counter,
    pub state: f64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Output {
    Landscape,
    Vertical,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrameFence {
    pub plan: Counter,
    pub source: Counter,
    pub transport: Counter,
    pub context: Counter,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TakeState {
    Prepared,
    Unknown,
    Active,
    Retiring,
    Superseded,
}
struct Slot {
    generation: u64,
    revision: Counter,
    plan: Plan,
    document: Document,
    cost: u64,
    expires: u64,
    state: TakeState,
    outputs: Vec<Output>,
    fences: BTreeMap<String, FrameFence>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub token: Counter,
    pub revision: Counter,
    pub digest: String,
    pub output: Output,
    pub frame: Counter,
}
/// A fake swap can be deliberately lost after the renderer may have presented it.
pub enum Swap {
    Confirmed,
    ResponseLost,
}
#[derive(Default)]
pub struct Runtime {
    document_id: Option<String>,
    generation: u64,
    exhausted: bool,
    pub ledger: Ledger,
    slots: BTreeMap<u64, Slot>,
    active: Option<u64>,
    pub instances: BTreeMap<String, Instance>,
    next_incarnation: u64,
    presentations: BTreeMap<Output, Presentation>,
    frame: u64,
}
impl Runtime {
    pub fn prepare(&mut self, d: &Document, revision: Counter, now_ms: u64) -> Result<Counter> {
        if self.document_id.as_ref().is_some_and(|id| id != &d.id) {
            return Err(fail(
                "DOCUMENT_NAMESPACE",
                "one runtime owns one document namespace",
            ));
        }
        if self.exhausted {
            return Err(fail("GENERATION_EXHAUSTED", "new runtime required"));
        }
        if self
            .slots
            .values()
            .filter(|s| matches!(s.state, TakeState::Prepared | TakeState::Unknown))
            .count()
            >= 4
        {
            return Err(fail(
                "PREPARE_LIMIT",
                "four preparation/unknown tickets maximum",
            ));
        }
        let expires = now_ms
            .checked_add(30_000)
            .ok_or_else(|| fail("TIME_UNREPRESENTABLE", "deadline overflow"))?;
        let cost = self.ledger.reserve(estimate(d)?)?;
        let plan = match compile::compile(d) {
            Ok(p) => p,
            Err(e) => {
                self.ledger.release(cost);
                return Err(e);
            }
        };
        let slot = Slot {
            generation: self.generation,
            revision,
            plan,
            document: d.clone(),
            cost,
            expires,
            state: TakeState::Prepared,
            outputs: vec![],
            fences: BTreeMap::new(),
        };
        self.slots.insert(cost, slot);
        self.document_id = Some(d.id.clone());
        Ok(Counter(cost))
    }
    pub fn state(&self, t: Counter) -> Option<TakeState> {
        self.slots.get(&t.0).map(|s| s.state.clone())
    }
    pub fn fence(
        &self,
        t: Counter,
        source: &str,
        transport: Counter,
        context: Counter,
    ) -> Result<FrameFence> {
        let slot = self
            .slots
            .get(&t.0)
            .ok_or_else(|| fail("UNKNOWN_PREPARATION", "prepare first"))?;
        if !slot.document.sources.contains_key(source) {
            return Err(fail("STALE_SOURCE", "source is absent from prepared plan"));
        }
        // A prepared source generation is deliberately plan-specific, even when its
        // eventual compatible player identity may be reused at activation.
        Ok(FrameFence {
            plan: t,
            source: t,
            transport,
            context,
        })
    }
    pub fn ready(
        &mut self,
        t: Counter,
        source: &str,
        frame: FrameFence,
        transport: Counter,
        context: Counter,
    ) -> Result<()> {
        if frame != self.fence(t, source, transport, context)? {
            return Err(fail(
                "STALE_FRAME",
                "plan/source/transport/context generation mismatch",
            ));
        }
        let slot = self.slots.get_mut(&t.0).unwrap();
        if slot.state != TakeState::Prepared {
            return Err(fail("PREPARE_STATE", "readiness only for a prepared plan"));
        }
        slot.fences.insert(source.into(), frame);
        Ok(())
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Every native revision, authority, time and renderer fence is checked explicitly at take"
    )]
    pub fn take(
        &mut self,
        t: Counter,
        desired: Counter,
        now_ms: u64,
        grant: &RevokeFence,
        transport: Counter,
        context: Counter,
        outputs: &[Output],
        swap: Swap,
    ) -> Result<()> {
        if !grant.is_current() {
            return Err(fail("FORBIDDEN", "grant revoked before take"));
        }
        if self.slots.values().any(|s| s.state == TakeState::Unknown) {
            return Err(fail(
                "RECONCILE_REQUIRED",
                "unknown renderer ownership must be reconciled first",
            ));
        }
        if self
            .active
            .and_then(|id| self.slots.get(&id))
            .is_some_and(|s| s.outputs != outputs)
        {
            return Err(fail("OUTPUT_CONFIGURATION_CHANGE","this profile replaces all active outputs together; stop before changing output configuration"));
        }
        let slot = self
            .slots
            .get_mut(&t.0)
            .ok_or_else(|| fail("UNKNOWN_PREPARATION", "prepare again"))?;
        if slot.state != TakeState::Prepared
            || slot.revision != desired
            || now_ms > slot.expires
            || slot.generation != self.generation
            || self.exhausted
        {
            return Err(fail(
                "STALE_PREPARATION",
                "desired revision or preparation TTL changed",
            ));
        }
        if outputs.is_empty() || outputs.len() > 2 || outputs.windows(2).any(|w| w[0] >= w[1]) {
            return Err(fail(
                "OUTPUTS",
                "one or two unique ordered outputs required",
            ));
        }
        for source in slot.document.sources.keys() {
            if slot.fences.get(source)
                != Some(&FrameFence {
                    plan: t,
                    source: t,
                    transport,
                    context,
                })
            {
                return Err(fail(
                    "FRAME_NOT_READY",
                    "all referenced sources need current fenced frames",
                ));
            }
        }
        slot.outputs = outputs.to_vec();
        match swap {
            Swap::ResponseLost => {
                slot.state = TakeState::Unknown;
                Err(fail(
                    "TAKE_OUTCOME_UNKNOWN",
                    "resources retained; reconcile exact presentation token",
                ))
            }
            Swap::Confirmed => self.activate(t),
        }
    }
    fn activate(&mut self, t: Counter) -> Result<()> {
        let slot = &self.slots[&t.0];
        if slot.generation != self.generation || self.exhausted {
            return Err(fail(
                "STOPPED_GENERATION",
                "late activation cannot resume a stopped runtime",
            ));
        }
        let old = self.active.and_then(|n| self.slots.get(&n));
        let mut identities: BTreeMap<String, String> = slot
            .plan
            .inventory
            .nodes
            .iter()
            .map(|(p, n)| {
                (
                    p.clone(),
                    format!("{}:{:?}:{:?}", n.kind, n.definition, n.authority),
                )
            })
            .collect();
        for (id, s) in &slot.document.sources {
            identities.insert(format!("sources/{id}"), source_identity(&slot.document, s)?);
        }
        let mut old_ids = BTreeMap::new();
        if let Some(old) = old {
            for (p, n) in &old.plan.inventory.nodes {
                old_ids.insert(
                    p.clone(),
                    format!("{}:{:?}:{:?}", n.kind, n.definition, n.authority),
                );
            }
            for (id, s) in &old.document.sources {
                old_ids.insert(format!("sources/{id}"), source_identity(&old.document, s)?);
            }
        }
        let changed: Vec<_> = identities
            .iter()
            .filter(|(p, s)| old_ids.get(*p) != Some(*s))
            .map(|(p, _)| p.clone())
            .collect();
        let mut instances = BTreeMap::new();
        for (path, _) in identities {
            let reset = changed
                .iter()
                .any(|p| path == *p || path.strip_prefix(p).is_some_and(|s| s.starts_with('/')));
            let instance = if !reset {
                self.instances.get(&path).cloned()
            } else {
                None
            };
            let instance = match instance {
                Some(v) => v,
                None => {
                    self.next_incarnation = self
                        .next_incarnation
                        .checked_add(1)
                        .ok_or_else(|| fail("GENERATION_EXHAUSTED", "new runtime required"))?;
                    Instance {
                        incarnation: Counter(self.next_incarnation),
                        state: 0.0,
                    }
                }
            };
            instances.insert(path, instance);
        }
        self.frame = self
            .frame
            .checked_add(1)
            .ok_or_else(|| fail("GENERATION_EXHAUSTED", "new runtime required"))?;
        // These receipts come from the fake renderer, never from desired revision order.
        self.presentations.clear();
        for output in &slot.outputs {
            self.presentations.insert(
                *output,
                Presentation {
                    token: t,
                    revision: slot.revision,
                    digest: slot.plan.digest.clone(),
                    output: *output,
                    frame: Counter(self.frame),
                },
            );
        }
        self.instances = instances;
        if let Some(old) = self.active {
            self.slots.get_mut(&old).unwrap().state = TakeState::Retiring;
        }
        self.active = Some(t.0);
        self.slots.get_mut(&t.0).unwrap().state = TakeState::Active;
        Ok(())
    }
    pub fn reconcile(&mut self, t: Counter, presented: bool) -> Result<()> {
        if self.state(t) != Some(TakeState::Unknown) {
            return Err(fail("RECONCILE_STATE", "exact unknown token required"));
        }
        if presented && self.slots[&t.0].generation != self.generation {
            self.slots.get_mut(&t.0).unwrap().state = TakeState::Retiring;
            Ok(())
        } else if presented {
            self.activate(t)
        } else {
            self.slots.get_mut(&t.0).unwrap().state = TakeState::Superseded;
            Ok(())
        }
    }
    pub fn presentation(&self, output: Output) -> Option<&Presentation> {
        self.presentations.get(&output)
    }
    pub fn cancel(&mut self, t: Counter) -> Result<()> {
        match self.state(t) {
            Some(TakeState::Prepared | TakeState::Superseded) => {
                let s = self.slots.remove(&t.0).unwrap();
                self.ledger.release(s.cost);
                Ok(())
            }
            _ => Err(fail(
                "OWNERSHIP_UNKNOWN",
                "active/unknown/retiring plan cannot be cancelled or freed",
            )),
        }
    }
    pub fn expire(&mut self, now_ms: u64) {
        let ids: Vec<_> = self
            .slots
            .iter()
            .filter(|(_, s)| s.state == TakeState::Prepared && now_ms > s.expires)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let s = self.slots.remove(&id).unwrap();
            self.ledger.release(s.cost);
        }
    }
    /// Disposal is explicit and typed-thread completion is a Phase 2 adapter obligation.
    pub fn disposal_complete(&mut self, t: Counter) -> Result<()> {
        if self.state(t) != Some(TakeState::Retiring) {
            return Err(fail("RETIRE_STATE", "not retiring"));
        }
        let slot = self.slots.remove(&t.0).unwrap();
        self.ledger.release(slot.cost);
        Ok(())
    }
    /// The stop intent uses a dedicated control path, independent of admitted command load.
    pub fn stop(&mut self) {
        if let Some(next) = self.generation.checked_add(1) {
            self.generation = next;
        } else {
            self.exhausted = true;
        }
        for slot in self.slots.values_mut() {
            if slot.state == TakeState::Prepared {
                slot.state = TakeState::Superseded;
            }
        }
        if let Some(id) = self.active.take() {
            self.slots.get_mut(&id).unwrap().state = TakeState::Retiring;
        }
        self.presentations.clear();
        self.instances.clear();
    }
}
