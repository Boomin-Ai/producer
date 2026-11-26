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
    let display = super::editor::source_name(&snap.project, source);
    if display == source {
        super::editor::control_label(source)
    } else {
        display
    }
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
            Binding::Picture(slot) => RoomCommand::SetBindSource {
                id: self.set.clone(),
                layout: self.pair.clone(),
                key: slot.key.clone(),
                source: source.to_owned(),
            },
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
        let expanded = s
            .slot_picker
            .as_ref()
            .is_some_and(|open| open.0 == set && open.1 == anchor);
        let label = pick.title();
        let row_key = (set.to_owned(), anchor.clone());
        let line = row()
            .key(anchor)
            .role("button")
            .label(format!(
                "{} {label} source",
                if expanded { "Collapse" } else { "Expand" }
            ))
            .focusable(true)
            .items_center()
            .gap(6.)
            .h(29.)
            .px(5.)
            .min_w(0.)
            .radius(5.)
            .hover_fill(color(SURFACE))
            .child(title(label, 11., 580., TEXT).grow(1.).min_w(0.))
            .child(
                title(
                    name(snap, source),
                    10.,
                    500.,
                    if ready { MINT } else { MUTED },
                )
                .min_w(0.),
            )
            .child(panels::glyph(
                if expanded {
                    "chevron-up"
                } else {
                    "chevron-down"
                },
                13.,
                MUTED,
            ))
            .on_press(move |s| {
                s.slot_picker = if expanded {
                    None
                } else {
                    Some(row_key.clone())
                }
            });
        list = list.child(line);
        if expanded {
            list = list.child(choices(s, &pick));
        }
    }
    list
}

fn choice(
    key: impl Into<String>,
    icon: &str,
    label: String,
    selected: bool,
    press: impl Fn(&mut Studio) + 'static,
) -> El {
    let tint = if selected { MINT } else { TEXT };
    row()
        .key(key.into())
        .role("button")
        .label(label.clone())
        .focusable(true)
        .h(24.)
        .max_w(190.)
        .min_w(0.)
        .items_center()
        .px(6.)
        .gap(4.)
        .radius(5.)
        .fill(color(if selected {
            theme::TOOL_SELECTED
        } else {
            PANEL
        }))
        .child(panels::glyph(icon, 12., tint))
        .child(title(label, 10., 550., tint).min_w(0.))
        .on_press(press)
}

fn choices(s: &Studio, pick: &Picker) -> El {
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
                && (p.inputs.contains_key(*id)
                    || p.lanes.iter().any(|lane| lane.source == id.as_str()))
                && if mic {
                    matches!(
                        p.production.sources.get(*id),
                        Some(Source::Live {
                            role: Role::Microphone
                        })
                    )
                } else {
                    crate::set_slots::visual_source(p, id)
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
        if !choices.is_empty() {
            let mut inputs = row().min_w(0.).flex_wrap().gap(4.);
            for id in choices {
                let edit = pick.clone();
                let icon = if mic {
                    "mic"
                } else {
                    match id.as_str() {
                        "screen" => "screen",
                        "movie" | "take" => "clip",
                        _ => "camera",
                    }
                };
                inputs = inputs.child(choice(
                    format!("bind-{id}"),
                    icon,
                    name(snap, &id),
                    current == id,
                    move |s| edit.assign(s, &id),
                ));
            }
            content = content
                .child(title("Studio inputs", 10., 550., MUTED))
                .child(inputs);
        }
        let edit = pick.clone();
        let connected = snap.producer_rtc["phase"] == "connected";
        let guest_label = if connected {
            name(snap, "rtc-guest")
        } else {
            "Stage guest".into()
        };
        let mut people = row().min_w(0.).flex_wrap().gap(4.).child(choice(
            "bind-rtc-guest",
            "profile",
            guest_label,
            current == "rtc-guest",
            move |s| edit.assign(s, "rtc-guest"),
        ));
        if !connected {
            let edit = pick.clone();
            people = people.child(
                choice(
                    "invite-slot-guest",
                    "link",
                    "Copy invite".into(),
                    false,
                    move |s| edit.invite(s),
                )
                .disabled(s.people.busy()),
            );
        }
        content = content
            .child(title("People", 10., 550., MUTED))
            .child(people);
        if let Some(feedback) = s.people.invitation_feedback(&snap.producer_rtc) {
            content = content.child(feedback);
        }
    }
    let anchor = pick.anchor.clone();
    let mut actions = row().min_w(0.).flex_wrap().gap(4.).child(choice(
        "slot-add-input",
        "plus",
        "Add input".into(),
        false,
        move |s| panels::open_source(s, "add", PanelId::Controls, anchor.clone()),
    ));
    if current != "rtc-guest" {
        let anchor = pick.anchor.clone();
        let src = current.to_owned();
        actions = actions.child(choice(
            "slot-input-settings",
            "mixer",
            "Input settings".into(),
            false,
            move |s| panels::open_source(s, &src, PanelId::Controls, anchor.clone()),
        ));
    }
    let default = match &pick.binding {
        Binding::Microphone(i) => {
            Some(crate::model::HostDirection::default().microphones[*i].clone())
        }
        Binding::Picture(slot) => {
            let authored = (pick.set == "my-first-million")
                .then(|| match slot.name.as_str() {
                    "shaan" => Some("camera"),
                    "sam" => Some("camera-2"),
                    "guest" => Some("rtc-guest"),
                    "screen-share" => Some("screen"),
                    _ => None,
                })
                .flatten();
            authored.map(str::to_owned).or_else(|| {
                p.set_source_defaults
                    .get(&pick.set)
                    .and_then(|defaults| defaults.get(&slot.key))
                    .cloned()
            })
        }
    };
    if let Some(default) = default.filter(|id| id != current) {
        let edit = pick.clone();
        actions = actions.child(choice(
            "reset-slot-source",
            "restart",
            "Reset".into(),
            false,
            move |s| edit.assign(s, &default),
        ));
    }
    content
        .child(el().w_full().h(1.).fill(color(theme::SEAM)))
        .child(actions)
        .key("set-source-picker")
        .role("group")
        .label(format!("{} sources", pick.title()))
        .min_w(0.)
        .radius(6.)
        .fill(color(SURFACE))
        .padding(6.)
}
