//! The local Boomin adapter preview. Directory and presence are scoped to one open studio.
#[derive(Clone, Copy)]
pub struct Brand {
    pub name: &'static str,
    pub initials: &'static str,
    pub accent: u32,
    pub studio: &'static str,
    pub host: &'static str,
    pub connected: bool,
    pub public: bool,
}

pub const BRANDS: &[Brand] = &[
    Brand {
        name: "Atlantium",
        initials: "AT",
        accent: 0x84d7c4,
        studio: "Builder Office Hours",
        host: "Ari",
        connected: true,
        public: true,
    },
    Brand {
        name: "Northline Radio",
        initials: "NR",
        accent: 0xf0b49c,
        studio: "After Hours",
        host: "Jo",
        connected: true,
        public: false,
    },
    Brand {
        name: "Signal House",
        initials: "SH",
        accent: 0xb5b3fa,
        studio: "The Listening Room",
        host: "Sam",
        connected: false,
        public: true,
    },
    Brand {
        name: "Form & Field",
        initials: "FF",
        accent: 0xe5c581,
        studio: "Design Exchange",
        host: "Ren",
        connected: false,
        public: true,
    },
];

#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    #[default]
    Connected,
    Discover,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Guest,
    Stage,
}
impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Self::Guest => "Guest",
            Self::Stage => "On stage",
        }
    }
}
#[derive(Clone, Copy)]
pub struct Visit {
    pub brand: usize,
    pub role: Role,
    pub mic: bool,
}
#[derive(Default)]
pub struct BoominNetwork {
    pub tab: Tab,
    pub selected: Option<usize>,
    pub visit: Option<Visit>,
}
#[derive(Clone, Copy)]
pub enum Action {
    Tab(Tab),
    Open(usize),
    Back,
    Join(Role),
    Mic,
    Leave,
}
impl BoominNetwork {
    pub fn brands(&self) -> impl Iterator<Item = (usize, &'static Brand)> {
        let tab = self.tab;
        BRANDS
            .iter()
            .enumerate()
            .filter(move |(_, b)| match tab {
                Tab::Connected => b.connected,
                Tab::Discover => b.public,
            })
    }
    pub fn apply(&mut self, action: Action) {
        match action {
            Action::Tab(tab) if self.visit.is_none() => {
                self.tab = tab;
                self.selected = None;
            }
            Action::Open(id) if self.visit.is_none() && self.brands().any(|(i, _)| i == id) => {
                self.selected = Some(id)
            }
            Action::Back if self.visit.is_none() => self.selected = None,
            Action::Join(role) if self.visit.is_none() => {
                if let Some(id) = self.selected.filter(|id| BRANDS[*id].public) {
                    self.visit = Some(Visit {
                        brand: id,
                        role,
                        mic: false,
                    });
                }
            }
            Action::Mic => {
                if let Some(v) = &mut self.visit {
                    v.mic = !v.mic;
                }
            }
            Action::Leave => {
                self.visit = None;
                self.selected = None;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connected_and_discover_have_distinct_access_and_people_lifecycles() {
        let mut n = BoominNetwork::default();
        assert!(n.brands().all(|(_, b)| b.connected));
        n.apply(Action::Open(1));
        n.apply(Action::Join(Role::Stage));
        assert!(n.visit.is_none());
        n.apply(Action::Tab(Tab::Discover));
        assert!(n.brands().all(|(_, b)| b.public));
        n.apply(Action::Open(1));
        assert!(n.selected.is_none());
        for role in [Role::Stage, Role::Guest] {
            n.apply(Action::Open(2));
            n.apply(Action::Join(role));
            assert_eq!(n.visit.unwrap().role, role);
            assert!(!n.visit.unwrap().mic);
            n.apply(Action::Mic);
            assert!(n.visit.unwrap().mic);
            n.apply(Action::Leave);
            assert!(n.visit.is_none() && n.selected.is_none());
        }
    }
}

impl BoominNetwork {
    pub fn detail(&self, split: bool) -> Option<usize> {
        self.selected.or_else(|| {
            if split {
                self.brands().next().map(|(i, _)| i)
            } else {
                None
            }
        })
    }
}
