//! Explicit control-lane leases. Releasing an override reveals the current
//! timeline value, not the value that happened to exist when it was acquired.
use crate::{
    compile::CompactValue, contract::*, coordinator::RevokeFence, ownership::ScopeId,
    transport::OutputInstant,
};
use std::collections::BTreeMap;

#[derive(Clone)]
struct Override {
    token: Counter,
    owner: String,
    incarnation: Counter,
    value: CompactValue,
    until: Option<OutputInstant>,
    grant: RevokeFence,
    scope: Option<LeaseScope>,
}
#[derive(Debug, Clone, Copy)]
pub struct LeaseScope {
    pub lifetime: ScopeId,
    pub run: ScopeId,
}
/// Numeric frame-side lease. Materialize on the control lane; frame lookup uses
/// a compiled target index rather than comparing target path strings.
#[derive(Clone)]
pub struct DriverLease {
    value: CompactValue,
    until: Option<OutputInstant>,
    grant: RevokeFence,
}
impl DriverLease {
    pub fn value(&self, now: OutputInstant) -> Option<CompactValue> {
        if !self.grant.is_revoked()
            && self
                .until
                .map_or_else(|| self.grant.is_current(), |until| until > now)
        {
            Some(self.value)
        } else {
            None
        }
    }
    pub fn resolve(&self, now: OutputInstant, underlying: CompactValue) -> CompactValue {
        self.value(now).unwrap_or(underlying)
    }
}
#[derive(Default, Clone)]
pub struct Overrides {
    entries: BTreeMap<Target, Override>,
    next: u64,
}
impl Overrides {
    pub fn snapshot(&self, target: &Target, incarnation: Counter) -> Option<DriverLease> {
        self.entries
            .get(target)
            .filter(|o| o.incarnation == incarnation)
            .map(|o| DriverLease {
                value: o.value,
                until: o.until,
                grant: o.grant.clone(),
            })
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Keep native authority and incarnation fences explicit at lease admission"
    )]
    pub fn acquire(
        &mut self,
        owner: &str,
        target: Target,
        incarnation: Counter,
        value: Value,
        now: OutputInstant,
        grant: &RevokeFence,
        inventory: &Inventory,
    ) -> Result<Counter> {
        let err = || {
            Error::new(
                "OVERRIDE_DENIED",
                &target.path,
                "invalid target, authority, owner or five-second lease",
            )
        };
        if !validate::valid_id(owner)
            || !grant.is_current()
            || !inventory.targets.contains(&target)
            || !validate::property_valid(target.property, &value)
            || inventory
                .nodes
                .get(&target.path)
                .is_some_and(|n| n.authority == Authority::Hosted)
        {
            return Err(err());
        }
        self.entries
            .retain(|_, o| o.until.is_none_or(|until| until > now) && !o.grant.is_revoked());
        if self.entries.get(&target).is_some_and(|o| o.owner != owner) {
            return Err(Error::new(
                "OVERRIDE_CONFLICT",
                &target.path,
                "another owner holds this property",
            ));
        }
        if self.entries.len() >= 256 && !self.entries.contains_key(&target) {
            return Err(Error::new(
                "OVERRIDE_LIMIT",
                &target.path,
                "maximum 256 leased overrides",
            ));
        }
        let token = Counter(self.next.checked_add(1).ok_or_else(err)?);
        self.next = token.0;
        self.entries.insert(
            target,
            Override {
                token,
                owner: owner.into(),
                incarnation,
                value: CompactValue::from_value(&value)?,
                until: None,
                grant: grant.clone(),
                scope: None,
            },
        );
        Ok(token)
    }
    /// Called only after native scope admission. A component's lifetime may
    /// outlive this run; its run-associated override must not.
    #[allow(
        clippy::too_many_arguments,
        reason = "Keep scope and native fences explicit"
    )]
    pub fn acquire_scoped(
        &mut self,
        owner: &str,
        target: Target,
        incarnation: Counter,
        value: Value,
        now: OutputInstant,
        grant: &RevokeFence,
        inventory: &Inventory,
        scope: LeaseScope,
    ) -> Result<Counter> {
        let token = self.acquire(
            owner,
            target.clone(),
            incarnation,
            value,
            now,
            grant,
            inventory,
        )?;
        self.entries.get_mut(&target).unwrap().scope = Some(scope);
        Ok(token)
    }
    pub fn clear_scopes(&mut self, closing: &[ScopeId]) {
        self.entries.retain(|_, o| {
            o.scope
                .is_none_or(|s| !closing.contains(&s.lifetime) && !closing.contains(&s.run))
        });
    }
    pub fn clear(&mut self) {
        self.entries.clear();
    }
    pub fn count(&self) -> usize {
        self.entries.len()
    }
    pub fn release(&mut self, owner: &str, target: &Target, token: Counter) -> Result<()> {
        if self
            .entries
            .get(target)
            .is_some_and(|o| o.owner != owner || o.token != token)
        {
            return Err(Error::new(
                "OVERRIDE_CONFLICT",
                &target.path,
                "only lease owner can release",
            ));
        }
        self.entries.remove(target);
        Ok(())
    }
    pub fn resolve(
        &self,
        target: &Target,
        incarnation: Counter,
        now: OutputInstant,
        underlying: CompactValue,
    ) -> CompactValue {
        self.entries
            .get(target)
            .filter(|o| {
                o.incarnation == incarnation
                    && !o.grant.is_revoked()
                    && match o.until {
                        None => o.grant.is_current(),
                        Some(until) => until > now,
                    }
            })
            .map(|o| o.value)
            .unwrap_or(underlying)
    }
    pub fn disconnect(&mut self, owner: &str, now: OutputInstant) -> Result<()> {
        let until = OutputInstant(Counter(now.0 .0.checked_add(5_000_000_000).ok_or_else(
            || Error::new("TIME_UNREPRESENTABLE", "override", "lease expiry overflow"),
        )?));
        for o in self.entries.values_mut().filter(|o| o.owner == owner) {
            if o.until.is_none() {
                o.until = Some(until);
            }
        }
        Ok(())
    }
}
