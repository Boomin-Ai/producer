//! Conservative control-lane accounting shared by every document in a Workspace.
//! These are synthetic reservations, not measurements of physical RSS or VRAM.
use crate::{
    contract::*,
    lifecycle::{Cost, CAP},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

fn fail(message: &str) -> Error {
    Error::new("RESOURCE_LIMIT", "resources", message)
}
#[derive(Default)]
struct State {
    next: u64,
    next_scope: u64,
    scopes: BTreeSet<u64>,
    entries: BTreeMap<u64, (u64, Cost)>,
}
#[derive(Clone)]
pub(crate) struct Budget {
    state: Arc<Mutex<State>>,
    documents: usize,
}
impl Budget {
    pub(crate) fn new(documents: usize) -> Self {
        assert!((1..=2).contains(&documents));
        Self {
            state: Arc::new(Mutex::new(State::default())),
            documents,
        }
    }
    pub(crate) fn ledger(&self) -> Result<Ledger> {
        let mut s = self.state.lock().unwrap();
        if s.scopes.len() >= self.documents {
            return Err(fail("two open/closing documents maximum"));
        }
        let scope = s
            .next_scope
            .checked_add(1)
            .ok_or_else(|| fail("scope counter exhausted"))?;
        s.next_scope = scope;
        s.scopes.insert(scope);
        Ok(Ledger {
            budget: self.clone(),
            scope,
        })
    }
    pub(crate) fn used(&self) -> Cost {
        self.state
            .lock()
            .unwrap()
            .entries
            .values()
            .try_fold(Cost::default(), |a, (_, b)| a.checked_add(*b))
            .expect("bounded admitted costs")
    }
    pub(crate) fn count(&self) -> usize {
        self.state.lock().unwrap().entries.len()
    }
}
/// Dropping a CPU-only compile reservation releases it. Prepared/native-model
/// slots own theirs until explicit cancellation or confirmed disposal removes them.
pub(crate) struct Reservation {
    budget: Budget,
    scope: u64,
    id: u64,
}
impl Reservation {
    pub(crate) fn id(&self) -> u64 {
        self.id
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut s = self.budget.state.lock().unwrap();
        if s.entries
            .get(&self.id)
            .is_some_and(|(scope, _)| *scope == self.scope)
        {
            s.entries.remove(&self.id);
        }
    }
}
pub struct Ledger {
    budget: Budget,
    scope: u64,
}
impl Default for Ledger {
    fn default() -> Self {
        Budget::new(1).ledger().expect("first scope")
    }
}
impl Ledger {
    pub fn used(&self) -> Cost {
        self.budget
            .state
            .lock()
            .unwrap()
            .entries
            .values()
            .filter(|(id, _)| *id == self.scope)
            .try_fold(Cost::default(), |a, (_, b)| a.checked_add(*b))
            .expect("bounded admitted costs")
    }
    pub fn reservation_count(&self) -> usize {
        self.budget
            .state
            .lock()
            .unwrap()
            .entries
            .values()
            .filter(|(id, _)| *id == self.scope)
            .count()
    }
    pub fn reserve(&mut self, cost: Cost) -> Result<u64> {
        let mut s = self.budget.state.lock().unwrap();
        let local: Vec<_> = s
            .entries
            .values()
            .filter(|(id, _)| *id == self.scope)
            .collect();
        if local.len() >= 160 || s.entries.len() >= 160 * self.budget.documents {
            return Err(fail("reservation handle limit"));
        }
        let used = local
            .iter()
            .try_fold(Cost::default(), |a, (_, b)| a.checked_add(*b))?;
        let total = used.checked_add(cost)?;
        // Check component caps before summing arbitrary caller-supplied u32s.
        if !total.fits(CAP) || total.retire_slots() > 152 {
            return Err(fail(
                "document includes active, incoming, cached, uncertain and retiring allocations",
            ));
        }
        let global = s
            .entries
            .values()
            .try_fold(Cost::default(), |a, (_, b)| a.checked_add(*b))?
            .checked_add(cost)?;
        let cap = if self.budget.documents == 2 {
            CAP.checked_add(CAP)?
        } else {
            CAP
        };
        if !global.fits(cap) || global.retire_slots() > 152 * self.budget.documents as u64 {
            return Err(fail(
                "workspace capacity includes closing documents and unfinished work",
            ));
        }
        let id = s
            .next
            .checked_add(1)
            .ok_or_else(|| fail("reservation counter exhausted"))?;
        s.next = id;
        s.entries.insert(id, (self.scope, cost));
        Ok(id)
    }
    pub(crate) fn lease(&mut self, cost: Cost) -> Result<Reservation> {
        let id = self.reserve(cost)?;
        Ok(Reservation {
            budget: self.budget.clone(),
            scope: self.scope,
            id,
        })
    }
    pub(crate) fn close(&self) -> Result<()> {
        let mut s = self.budget.state.lock().unwrap();
        if s.entries.values().any(|(scope, _)| *scope == self.scope) {
            return Err(fail("disposal/worker completion required before closing"));
        }
        s.scopes.remove(&self.scope);
        Ok(())
    }
}
