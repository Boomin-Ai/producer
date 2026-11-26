use super::*;
use crate::{
    model::{RoomProject, SetLayoutPair},
    set_slots::Slot,
};
use producer_production_contract::{Role, Source};

#[derive(Clone)]
pub(super) enum Binding {
    Picture(Slot),
    Microphone(usize),
}

#[derive(Clone)]
pub(super) struct Picker {
    set: String,
    pair: SetLayoutPair,
    binding: Binding,
    anchor: String,
}

pub(super) fn visual_source(room: &RoomProject, id: &str) -> bool {
    matches!(
        room.production.sources.get(id),
        Some(Source::Live {
            role: Role::HostCamera | Role::Screen | Role::Guest
        })
    ) || (matches!(id, "movie" | "take")
        && matches!(room.production.sources.get(id), Some(Source::Player { .. })))
}

fn name(snap: &Snapshot, source: &str) -> String {
    if source == "rtc-guest" {
        if snap.producer_rtc["phase"] == "connected" {
            return snap.producer_rtc["verifiedBoominBrand"]
                .as_str()
                .or_else(|| snap.producer_rtc["displayName"].as_str())
                .unwrap_or("Stage guest")
                .into();
        }
        return "Waiting for guest".into();
    }
    super::editor::source_name(&snap.project, source)
}

impl Picker {
    fn source<'a>(&'a self, p: &'a RoomProject) -> &'a str {
        match &self.binding {
            Binding::Picture(slot) => &slot.source,
            Binding::Microphone(i) => &p.mfm_direction.microphones[*i],
        }
    }
    fn title(&self) -> String {
        match &self.binding {
            Binding::Picture(slot) => super::editor::control_label(&slot.name),
            Binding::Microphone(i) => format!("{} microphone", ["Shaan", "Sam"][*i]),
        }
    }
    fn assign(&self, s: &mut Studio, source: &str) {
        let Some(live) = &s.live else { return };
        let p = &live.snapshot.project;
        let cmd = match &self.binding {
            Binding::Picture(slot) => {
                let Some(set) = p.production.sets.get(&self.set) else {
                    return;
                };
                if !crate::set_slots::for_pair(p, set, &self.pair).contains(slot) {
                    s.slot_picker = None;
                    return;
                }
                let mut draft = set.clone();
                crate::set_slots::assign(&mut draft, &slot.key, source);
                RoomCommand::SetEditSave {
                    id: self.set.clone(),
                    expected: set.clone(),
                    draft,
                    layout: Some(self.pair.clone()),
                }
            }
            Binding::Microphone(i) => {
                let Some((show, segment)) = p
                    .playing_segment
                    .as_ref()
                    .filter(|(id, _)| {
                        p.production
                            .shows
                            .get(id)
                            .is_some_and(|sh| sh.set == self.set)
                    })
                    .cloned()
                    .or_else(|| {
                        p.production
                            .shows
                            .iter()
                            .find(|(_, sh)| sh.set == self.set)
                            .and_then(|(id, sh)| {
                                Some((id.clone(), sh.segments.first()?.id.clone()))
                            })
                    })
                else {
                    return;
                };
                let enabled = p
                    .speaker_segments
                    .get(&show)
                    .is_some_and(|ids| ids.contains(&segment));
                let mut settings = p.mfm_direction.clone();
                if settings.microphones[1 - *i] == source {
                    settings.microphones.swap(0, 1);
                } else {
                    source.clone_into(&mut settings.microphones[*i]);
                }
                RoomCommand::MfmDirection {
                    show,
                    segment,
                    enabled,
                    settings,
                }
            }
        };
        s.send(cmd);
        s.slot_picker = None;
    }
    fn invite(&self, s: &mut Studio) {
        panels::copy_link(
            s,
            crate::room_share::LinkKind::Guest,
            Some(PanelId::Controls),
            &self.anchor,
        );
    }
}

pub(super) fn rows(s: &Studio, set: &str, pair: &SetLayoutPair, slots: &[Slot]) -> El {
    let snap = &s.live.as_ref().unwrap().snapshot;
    let mut bindings: Vec<_> = slots.iter().cloned().map(Binding::Picture).collect();
    if set == "my-first-million" {
        bindings.extend([Binding::Microphone(0), Binding::Microphone(1)]);
    }
    let mut list = col().gap(4.).min_w(0.);
    if bindings.is_empty() {
        return list;
    }
    list = list.child(title("Sources", 12., 600., TEXT));
    let mut invited = false;
    for binding in bindings {
        let suffix = match &binding {
            Binding::Picture(slot) => slot.key.clone(),
            Binding::Microphone(i) => format!("mic-{i}"),
        };
        let anchor = format!("set-source-{suffix}");
        let pick = Picker {
            set: set.into(),
            pair: pair.clone(),
            binding,
            anchor: anchor.clone(),
        };
        let source = pick.source(&snap.project);
        let ready = match &pick.binding {
            Binding::Microphone(_) if source == "rtc-guest" => snap.guest_audio_received,
            _ => panels::slot_ready(snap, source),
        };
        let guest = source == "rtc-guest" && !ready && snap.producer_rtc["phase"] != "connected";
        let mut line = row()
            .items_center()
            .gap(5.)
            .child(title(pick.title(), 11., 560., TEXT).grow(1.).min_w(0.))
            .child(
                title(
                    name(snap, source),
                    10.,
                    500.,
                    if ready { MINT } else { MUTED },
                )
                .min_w(0.),
            );
        let edit = pick.clone();
        line = line.child(
            panels::tool(
                &anchor,
                "settings",
                &format!("Assign {}", pick.title()),
                false,
                move |s| s.slot_picker = Some(edit.clone()),
            )
            .size(24., 24.),
        );
        if guest && !invited {
            invited = true;
            line = line.child(
                button("invite-unlinked-slot", "Invite guest", false, move |s| {
                    pick.invite(s)
                })
                .disabled(s.people.busy()),
            );
        }
        list = list.child(line);
    }
    if invited && s.slot_picker.is_none() {
        if let Some(feedback) = s.people.invitation_feedback(&snap.producer_rtc) {
            list = list.child(feedback);
        }
    }
    list
}

pub(super) fn popover(s: &Studio, pick: &Picker, edge: Edge, w: f32, h: f32) -> El {
    let snap = &s.live.as_ref().unwrap().snapshot;
    let p = &snap.project;
    let current = pick.source(p);
    let mic = matches!(pick.binding, Binding::Microphone(_));
    let mut content = col().gap(4.);
    let mut choices: Vec<String> = p
        .production
        .sources
        .keys()
        .filter(|id| {
            id.as_str() != "rtc-guest"
                && if mic {
                    matches!(
                        p.production.sources.get(*id),
                        Some(Source::Live {
                            role: Role::Microphone
                        })
                    )
                } else {
                    visual_source(p, id)
                }
        })
        .cloned()
        .collect();
    if mic {
        choices.extend(
            p.inputs
                .iter()
                .filter(|(_, i)| i.kind == "microphone")
                .map(|(id, _)| id.clone()),
        );
    }
    choices.sort();
    choices.dedup();
    if !matches!(&pick.binding,Binding::Picture(slot) if slot.component) {
        content = content.child(title("Studio sources", 10., 550., MUTED));
        for id in choices {
            let edit = pick.clone();
            content = content.child(button(
                format!("bind-{id}"),
                name(snap, &id),
                current == id,
                move |s| edit.assign(s, &id),
            ));
        }
        let edit = pick.clone();
        let guest_label = if snap.producer_rtc["phase"] == "connected" {
            name(snap, "rtc-guest")
        } else {
            "Stage guest".into()
        };
        content = content
            .child(title("People", 10., 550., MUTED))
            .child(button(
                "bind-rtc-guest",
                guest_label,
                current == "rtc-guest",
                move |s| edit.assign(s, "rtc-guest"),
            ));
        if snap.producer_rtc["phase"] != "connected" {
            let edit = pick.clone();
            content = content.child(
                button("invite-slot-guest", "Copy guest invite", false, move |s| {
                    edit.invite(s)
                })
                .disabled(s.people.busy()),
            );
            if let Some(feedback) = s.people.invitation_feedback(&snap.producer_rtc) {
                content = content.child(feedback);
            }
        }
    }
    if current != "rtc-guest" {
        let anchor = pick.anchor.clone();
        let src = current.to_owned();
        content = content.child(button(
            "slot-input-settings",
            "Input settings",
            false,
            move |s| panels::open_source(s, &src, PanelId::Controls, anchor.clone()),
        ));
    }
    let anchor = pick.anchor.clone();
    content = content.child(button(
        "slot-add-input",
        "Add studio input…",
        false,
        move |s| panels::open_source(s, "add", PanelId::Controls, anchor.clone()),
    ));
    let default = match &pick.binding {
        Binding::Microphone(i) => {
            Some(crate::model::HostDirection::default().microphones[*i].clone())
        }
        Binding::Picture(slot) => p
            .set_source_defaults
            .get(&pick.set)
            .and_then(|m| m.get(&slot.key))
            .cloned()
            .or_else(|| {
                (pick.set == "my-first-million")
                    .then(|| match slot.name.as_str() {
                        "shaan" => Some("camera".into()),
                        "sam" => Some("camera-2".into()),
                        "guest" => Some("rtc-guest".into()),
                        "screen-share" => Some("screen".into()),
                        _ => None,
                    })
                    .flatten()
            }),
    };
    if let Some(default) = default.filter(|id| id != current) {
        let edit = pick.clone();
        content = content.child(button(
            "reset-slot-source",
            "Reset source",
            false,
            move |s| edit.assign(s, &default),
        ));
    }
    col()
        .key("set-source-picker")
        .role("dialog")
        .label(pick.title())
        .w(260_f32.min(w - 16.))
        .max_h((h - 68.).max(96.))
        .anchored_fit(
            pick.anchor.clone(),
            panels::dock_popover_side(edge),
            rune::Align::Start,
            5.,
        )
        .modal(true, |s: &mut Studio| s.slot_picker = None)
        .radius(8.)
        .border(1., color(theme::SEAM))
        .fill(color(PANEL))
        .padding(8.)
        .gap(6.)
        .child(
            row()
                .items_center()
                .child(title(pick.title(), 14., 600., TEXT).grow(1.))
                .child(
                    button("close-slot-picker", "×", false, |s| s.slot_picker = None)
                        .size(24., 24.),
                ),
        )
        .child(content.min_h(0.).scroll(Default::default()))
}
