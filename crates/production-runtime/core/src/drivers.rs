//! Explicit control-lane leases. Releasing an override reveals the current
//! timeline value, not the value that happened to exist when it was acquired.
use crate::{
    compile::CompactValue, contract::*, coordinator::RevokeFence, transport::OutputInstant,
};
use std::collections::BTreeMap;

struct Override {
    token: Counter,
    owner: String,
    incarnation: Counter,
    value: CompactValue,
    until: Option<OutputInstant>,
    grant: RevokeFence,
}
#[derive(Default)]
pub struct Overrides {
    entries: BTreeMap<Target, Override>,
    next: u64,
}
impl Overrides {
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
            },
        );
        Ok(token)
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
