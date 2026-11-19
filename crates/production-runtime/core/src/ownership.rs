//! Bounded logical ownership on the serialized control lane. Logical users,
//! exclusive control, presentation/audio contribution and in-flight reads are
//! separate from lifetime ownership. No native objects are allocated here.
use crate::contract::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const SCOPES: usize = 256;
pub const RESOURCES: usize = 1024;
pub const RELATIONS: usize = 4096;
pub const READS: usize = 1024;
pub const READ_HOLDS: usize = 4096;

macro_rules! handle {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
        pub struct $name {
            execution: [Counter; 2],
            number: Counter,
        }
    };
}
handle!(ScopeId);
handle!(ResourceId);
handle!(ReadId);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScopeKind {
    Document,
    Component,
    Run,
    Segment,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    Borrow,
    Control,
    Presentation,
    Audio,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    Control,
    Video,
    Audio,
    Renderer,
}
#[derive(Debug, Clone)]
struct Scope {
    parent: Option<ScopeId>,
    kind: ScopeKind,
}
#[derive(Debug, Clone)]
struct Resource {
    owner: ScopeId,
    lane: Lane,
    retiring: bool,
    users: BTreeSet<(ScopeId, Relation)>,
    dependencies: BTreeSet<ResourceId>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Disposal {
    pub resource: ResourceId,
    pub lane: Lane,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    pub scopes: Vec<ScopeId>,
    pub retiring: Vec<ResourceId>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipStatus {
    pub scopes: usize,
    pub resources: usize,
    pub retiring: usize,
    pub relations: usize,
    pub dependencies: usize,
    pub reads: usize,
    pub read_holds: usize,
}
#[derive(Debug, Clone)]
pub struct Ownership {
    next: u64,
    execution: [Counter; 2],
    root: ScopeId,
    scopes: BTreeMap<ScopeId, Scope>,
    resources: BTreeMap<ResourceId, Resource>,
    reads: BTreeMap<ReadId, BTreeSet<ResourceId>>,
}
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "ownership", message)
}
impl Default for Ownership {
    fn default() -> Self {
        Self::new()
    }
}
impl Ownership {
    pub fn new() -> Self {
        let nonce = uuid::Uuid::new_v4().as_u128();
        let execution = [Counter((nonce >> 64) as u64), Counter(nonce as u64)];
        let root = ScopeId {
            execution,
            number: Counter(1),
        };
        Self {
            next: 1,
            execution,
            root,
            scopes: [(
                root,
                Scope {
                    parent: None,
                    kind: ScopeKind::Document,
                },
            )]
            .into(),
            resources: BTreeMap::new(),
            reads: BTreeMap::new(),
        }
    }
    pub fn root(&self) -> ScopeId {
        self.root
    }
    pub fn active(&self, scope: ScopeId) -> bool {
        self.scopes.contains_key(&scope)
    }
    fn issue(&mut self) -> Result<Counter> {
        let next = self
            .next
            .checked_add(1)
            .ok_or_else(|| fail("SCOPE_EXHAUSTED", "new document execution required"))?;
        self.next = next;
        Ok(Counter(next))
    }
    pub fn enter(&mut self, parent: ScopeId, kind: ScopeKind) -> Result<ScopeId> {
        let p = self
            .scopes
            .get(&parent)
            .ok_or_else(|| fail("SCOPE_CLOSED", "parent scope is closed"))?;
        let valid = matches!(
            (p.kind, kind),
            (
                ScopeKind::Document | ScopeKind::Component,
                ScopeKind::Component
            ) | (ScopeKind::Document, ScopeKind::Run)
                | (ScopeKind::Run, ScopeKind::Segment)
        );
        if !valid || self.scopes.len() >= SCOPES {
            return Err(fail("SCOPE_LIMIT", "invalid hierarchy or scope capacity"));
        }
        let id = ScopeId {
            execution: self.execution,
            number: self.issue()?,
        };
        self.scopes.insert(
            id,
            Scope {
                parent: Some(parent),
                kind,
            },
        );
        Ok(id)
    }
    pub fn own(&mut self, owner: ScopeId, lane: Lane) -> Result<ResourceId> {
        if !self.active(owner) {
            return Err(fail("SCOPE_CLOSED", "lifetime owner is closed"));
        }
        if self.resources.len() >= RESOURCES {
            return Err(fail(
                "RESOURCE_LIMIT",
                "logical resource capacity includes retirement",
            ));
        }
        let id = ResourceId {
            execution: self.execution,
            number: self.issue()?,
        };
        self.resources.insert(
            id,
            Resource {
                owner,
                lane,
                retiring: false,
                users: BTreeSet::new(),
                dependencies: BTreeSet::new(),
            },
        );
        Ok(id)
    }
    pub fn relate(
        &mut self,
        user: ScopeId,
        resource: ResourceId,
        relation: Relation,
    ) -> Result<()> {
        if !self.active(user) {
            return Err(fail("SCOPE_CLOSED", "logical user is closed"));
        }
        let r = self
            .resources
            .get(&resource)
            .filter(|r| !r.retiring)
            .ok_or_else(|| fail("RESOURCE_RETIRED", "no new users during retirement"))?;
        if r.users.contains(&(user, relation)) {
            return Ok(());
        }
        if relation == Relation::Control
            && r.users
                .iter()
                .any(|(s, k)| *s != user && *k == Relation::Control)
        {
            return Err(fail(
                "CONTROL_CONFLICT",
                "another scope controls this resource",
            ));
        }
        if self
            .resources
            .values()
            .map(|r| r.users.len() + r.dependencies.len())
            .sum::<usize>()
            >= RELATIONS
        {
            return Err(fail("RELATION_LIMIT", "logical relation capacity"));
        }
        self.resources
            .get_mut(&resource)
            .unwrap()
            .users
            .insert((user, relation));
        Ok(())
    }
    /// A dependent must be disposed before the resource it uses. Acyclic,
    /// bounded edges are separate from user scopes and survive logical close.
    pub fn depend(&mut self, resource: ResourceId, dependency: ResourceId) -> Result<()> {
        let r = self
            .resources
            .get(&resource)
            .filter(|r| !r.retiring)
            .ok_or_else(|| fail("RESOURCE_RETIRED", "dependent is absent or retiring"))?;
        if r.dependencies.contains(&dependency) {
            return Ok(());
        }
        if !self.resources.get(&dependency).is_some_and(|r| !r.retiring) {
            return Err(fail("RESOURCE_RETIRED", "dependency is absent or retiring"));
        }
        if self.closure(dependency)?.contains(&resource) {
            return Err(fail(
                "DEPENDENCY_CYCLE",
                "resource dependency graph must be acyclic",
            ));
        }
        if self
            .resources
            .values()
            .map(|r| r.users.len() + r.dependencies.len())
            .sum::<usize>()
            >= RELATIONS
        {
            return Err(fail("RELATION_LIMIT", "dependency and user capacity"));
        }
        self.resources
            .get_mut(&resource)
            .unwrap()
            .dependencies
            .insert(dependency);
        Ok(())
    }
    fn closure(&self, resource: ResourceId) -> Result<BTreeSet<ResourceId>> {
        let mut pending = vec![resource];
        let mut visited = BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            let r = self
                .resources
                .get(&id)
                .ok_or_else(|| fail("RESOURCE_RETIRED", "dependency is absent"))?;
            pending.extend(r.dependencies.iter().copied());
        }
        Ok(visited)
    }
    pub fn unrelate(
        &mut self,
        user: ScopeId,
        resource: ResourceId,
        relation: Relation,
    ) -> Result<()> {
        let r = self
            .resources
            .get_mut(&resource)
            .ok_or_else(|| fail("RESOURCE_RETIRED", "unknown resource"))?;
        r.users.remove(&(user, relation));
        Ok(())
    }
    pub fn read(&mut self, user: ScopeId, resource: ResourceId) -> Result<ReadId> {
        if !self.active(user) {
            return Err(fail("SCOPE_CLOSED", "reader scope is closed"));
        }
        let r = self
            .resources
            .get(&resource)
            .filter(|r| !r.retiring)
            .ok_or_else(|| fail("RESOURCE_RETIRED", "no new reads during retirement"))?;
        if r.owner != user && !r.users.iter().any(|(s, _)| *s == user) {
            return Err(fail("BORROW_REQUIRED", "reader must be a logical user"));
        }
        if self.reads.len() >= READS {
            return Err(fail("READ_LIMIT", "in-flight read capacity"));
        }
        let held = self.closure(resource)?;
        if held.len() + self.reads.values().map(BTreeSet::len).sum::<usize>() > READ_HOLDS {
            return Err(fail("READ_LIMIT", "transitive in-flight resource capacity"));
        }
        let id = ReadId {
            execution: self.execution,
            number: self.issue()?,
        };
        self.reads.insert(id, held);
        Ok(id)
    }
    pub fn finish_read(&mut self, read: ReadId) -> Result<()> {
        self.reads.remove(&read).ok_or_else(|| {
            fail(
                "STALE_READ",
                "read already finished or belongs to another execution",
            )
        })?;
        Ok(())
    }
    /// Removal is atomic. Dependencies must leave in this same transaction;
    /// surviving borrowers never become implicit lifetime owners.
    pub fn leave(&mut self, roots: &[ScopeId]) -> Result<Cleanup> {
        if roots.is_empty() || roots.len() > SCOPES || roots.iter().any(|s| !self.active(*s)) {
            return Err(fail("SCOPE_CLOSED", "active bounded roots required"));
        }
        let mut closing: BTreeSet<_> = roots.iter().copied().collect();
        loop {
            let before = closing.len();
            for (id, s) in &self.scopes {
                if s.parent.is_some_and(|p| closing.contains(&p)) {
                    closing.insert(*id);
                }
            }
            if closing.len() == before {
                break;
            }
        }
        if self.resources.values().any(|r| {
            !r.retiring
                && closing.contains(&r.owner)
                && r.users.iter().any(|(s, _)| !closing.contains(s))
        }) {
            return Err(fail(
                "OWNER_BORROWED",
                "remove surviving logical dependencies in the same transaction",
            ));
        }
        if self.resources.values().any(|r| {
            !r.retiring
                && !closing.contains(&r.owner)
                && r.dependencies
                    .iter()
                    .any(|id| closing.contains(&self.resources[id].owner))
        }) {
            return Err(fail(
                "OWNER_BORROWED",
                "surviving compiled dependency requires its lifetime owner",
            ));
        }
        let mut retiring = vec![];
        for (id, r) in &mut self.resources {
            r.users.retain(|(s, _)| !closing.contains(s));
            if !r.retiring && closing.contains(&r.owner) {
                r.retiring = true;
                retiring.push(*id);
            }
        }
        for s in &closing {
            self.scopes.remove(s);
        }
        Ok(Cleanup {
            scopes: closing.into_iter().collect(),
            retiring,
        })
    }
    /// This is an adapter acknowledgment, not permission to destroy on any thread.
    pub fn disposed(&mut self, resource: ResourceId, lane: Lane) -> Result<()> {
        let r = self
            .resources
            .get(&resource)
            .ok_or_else(|| fail("STALE_DISPOSAL", "unknown resource"))?;
        if !r.retiring
            || r.lane != lane
            || self.reads.values().any(|held| held.contains(&resource))
            || self
                .resources
                .values()
                .any(|r| r.dependencies.contains(&resource))
        {
            return Err(fail(
                "DISPOSAL_FENCE",
                "owner lane, dependent disposal and all transitive reads required",
            ));
        }
        self.resources.remove(&resource);
        Ok(())
    }
    /// Only eligibility, never a destruction acknowledgment. An adapter must
    /// complete actual disposal on the matching lane before calling disposed.
    pub fn disposal_ready(&self) -> Vec<Disposal> {
        let used: BTreeSet<_> = self
            .resources
            .values()
            .flat_map(|r| &r.dependencies)
            .chain(self.reads.values().flat_map(|r| r.iter()))
            .copied()
            .collect();
        self.resources
            .iter()
            .filter(|(id, r)| r.retiring && !used.contains(id))
            .map(|(id, r)| Disposal {
                resource: *id,
                lane: r.lane,
            })
            .collect()
    }
    pub fn status(&self) -> OwnershipStatus {
        OwnershipStatus {
            scopes: self.scopes.len(),
            resources: self.resources.len(),
            retiring: self.resources.values().filter(|r| r.retiring).count(),
            relations: self.resources.values().map(|r| r.users.len()).sum(),
            dependencies: self.resources.values().map(|r| r.dependencies.len()).sum(),
            reads: self.reads.len(),
            read_holds: self.reads.values().map(BTreeSet::len).sum(),
        }
    }
}
