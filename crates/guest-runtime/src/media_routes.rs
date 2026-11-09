//! Process-wide routing for the SDK's one decoded-PCM drain. An SSRC alone
//! cannot distinguish decoders, so collisions and retired bindings fail closed.
use std::collections::{HashMap, HashSet};

pub const MAX_RECEIVERS: usize = 8;
const MAX_RETIRED_SSRC: usize = 65_536;

/// Shared receive is a candidate-only choice. A default exclusive owner can
/// never silently join or be joined by a shared drain epoch.
pub fn registration_allowed(
    active: usize,
    current_shared: Option<bool>,
    shared: bool,
) -> Result<(), &'static str> {
    if active != 0 && (!shared || current_shared != Some(true)) {
        return Err("Native receive pipeline already owned");
    }
    if active >= MAX_RECEIVERS {
        return Err("Native receive receiver limit reached");
    }
    Ok(())
}
#[derive(Default)]
pub struct Routes {
    retired: HashSet<u32>,
    previous: HashMap<u64, HashSet<u32>>,
    owners: HashMap<u32, u64>,
    counts: HashMap<u32, usize>,
    failed: bool,
}
impl Routes {
    pub fn retire(&mut self, ssrc: u32) {
        if ssrc == 0 || self.retired.contains(&ssrc) {
            return;
        }
        if self.retired.len() == MAX_RETIRED_SSRC {
            self.failed = true;
            return;
        }
        self.retired.insert(ssrc);
    }
    pub fn remove(&mut self, owner: u64) {
        if let Some(bindings) = self.previous.remove(&owner) {
            for ssrc in bindings {
                self.retire(ssrc);
            }
        }
    }
    pub fn update(&mut self, bindings: impl IntoIterator<Item = (u64, u32)>) {
        self.owners.clear();
        self.counts.clear();
        let mut current = HashMap::<u64, HashSet<u32>>::new();
        for (owner, ssrc) in bindings {
            if ssrc == 0 {
                continue;
            }
            *self.counts.entry(ssrc).or_default() += 1;
            self.owners.insert(ssrc, owner);
            current.entry(owner).or_default().insert(ssrc);
        }
        // Missing stats may temporarily report zero. Retirement is explicit on
        // actual track replacement/removal; retain history across that gap.
        for (owner, bindings) in current {
            self.previous.entry(owner).or_default().extend(bindings);
        }
        let collisions: Vec<_> = self
            .counts
            .iter()
            .filter_map(|(&ssrc, &n)| (n != 1).then_some(ssrc))
            .collect();
        for ssrc in collisions {
            self.retire(ssrc);
        }
    }
    pub fn owner(&self, ssrc: u32) -> Option<u64> {
        (!self.failed && self.counts.get(&ssrc) == Some(&1) && !self.retired.contains(&ssrc))
            .then(|| self.owners.get(&ssrc).copied())
            .flatten()
    }
    pub fn counts(&self) -> &HashMap<u32, usize> {
        &self.counts
    }
    pub fn retired(&self) -> &HashSet<u32> {
        &self.retired
    }
    pub fn failed(&self) -> bool {
        self.failed
    }

    /// The caller holds all registered state gates. One invocation drains once
    /// and dispatches a block to at most one proven receiver.
    pub fn drain<T>(
        &self,
        take: impl FnOnce() -> Vec<T>,
        ssrc: impl Fn(&T) -> u32,
    ) -> HashMap<u64, Vec<T>> {
        let mut batches = HashMap::<u64, Vec<T>>::new();
        for block in take() {
            if let Some(owner) = self.owner(ssrc(&block)) {
                batches.entry(owner).or_default().push(block);
            }
        }
        batches
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn exclusive_default_and_candidate_shared_epochs_cannot_overlap() {
        assert!(registration_allowed(0, None, false).is_ok());
        assert!(registration_allowed(1, Some(false), false).is_err());
        assert!(registration_allowed(1, Some(false), true).is_err());
        assert!(registration_allowed(1, Some(true), false).is_err());
        assert!(registration_allowed(MAX_RECEIVERS - 1, Some(true), true).is_ok());
        assert!(registration_allowed(MAX_RECEIVERS, Some(true), true).is_err());
        assert!(registration_allowed(0, Some(true), false).is_ok());
    }
    #[test]
    fn one_drain_routes_distinct_owners_and_never_duplicates_a_block() {
        let mut routes = Routes::default();
        routes.update([(1, 7), (2, 9)]);
        let drains = Cell::new(0);
        let batches = routes.drain(
            || {
                drains.set(drains.get() + 1);
                vec![7, 9, 99, 7]
            },
            |v| *v,
        );
        assert_eq!(drains.get(), 1);
        assert_eq!(batches[&1], [7, 7]);
        assert_eq!(batches[&2], [9]);
    }
    #[test]
    fn collisions_retirement_and_owner_close_cannot_rebind_decoder_identity() {
        let mut routes = Routes::default();
        routes.update([(1, 7), (2, 9)]);
        routes.remove(1);
        routes.update([(2, 9), (3, 7)]);
        assert_eq!(routes.owner(9), Some(2));
        assert_eq!(routes.owner(7), None);
        routes.update([(2, 9), (3, 11), (4, 11)]);
        assert_eq!(routes.owner(11), None);
        routes.remove(3);
        routes.update([(2, 9), (4, 11)]);
        assert_eq!(routes.owner(11), None);
        assert_eq!(routes.owner(9), Some(2));
    }
    #[test]
    fn temporary_stats_gap_does_not_retire_but_close_remembers_the_binding() {
        let mut routes = Routes::default();
        routes.update([(1, 7)]);
        routes.update([(1, 0)]);
        routes.update([(1, 7)]);
        assert_eq!(routes.owner(7), Some(1));
        routes.update([(1, 0)]);
        routes.remove(1);
        routes.update([(2, 7)]);
        assert_eq!(routes.owner(7), None);
    }
    #[test]
    fn bounded_quarantine_fails_closed_when_exhausted() {
        let mut routes = Routes::default();
        for ssrc in 1..=MAX_RETIRED_SSRC as u32 + 1 {
            routes.retire(ssrc);
        }
        routes.update([(1, 100_000)]);
        assert!(routes.failed());
        assert_eq!(routes.owner(100_000), None);
    }
}
