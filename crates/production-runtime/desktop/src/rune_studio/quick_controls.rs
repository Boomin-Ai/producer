use super::*;
use crate::{
    model::SetLayoutPair,
    studio_audio::{Command as Audio, Kind},
    workspace::{HeaderMode, QuickControl, ShortcutColumns, ShortcutSection, Workspace},
};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct QuickControls {
    expanded: Option<QuickControl>,
    editing: bool,
    headline: Option<HeadlineDraft>,
    section_draft: Option<SectionDraft>,
    move_shortcut: Option<QuickControl>,
    sound_picker: Option<SoundPicker>,
    pub(super) publish: Option<PublishPopout>,
}

struct SectionDraft {
    id: Option<Uuid>,
    name: TextEdit,
}

#[derive(Default)]
struct SoundPicker {
    query: TextEdit,
    offset: usize,
}

impl QuickControls {
    pub(super) fn collapse(&mut self) {
        self.expanded = None;
    }

    pub(super) fn publish_settings_open(&self) -> bool {
        self.expanded == Some(QuickControl::Publish)
    }
}

pub(super) enum PublishPopout {
    SignIn { clip: Option<PathBuf> },
    Composer,
}

struct HeadlineDraft {
    set: String,
    pair: SetLayoutPair,
    original: editor::HeadlineField,
    input: TextEdit,
}

impl HeadlineDraft {
    fn changed_text(&self) -> Option<&str> {
        let text = self.input.text.trim();
        (!text.is_empty() && text != self.original.value.trim()).then_some(text)
    }
}

fn on_air_headline(snap: &Snapshot) -> Option<(String, SetLayoutPair, editor::HeadlineField)> {
    if !matches!(snap.program_kind.as_str(), "set" | "show") {
        return None;
    }
    let project = &snap.project;
    let id = project.mounted_set.as_ref()?;
    let set = project.production.sets.get(id)?;
    let pair = snap
        .program_layout
        .clone()
        .unwrap_or_else(|| project.output_layout_pair());
    let field = editor::HeadlineField::for_pair(set, &pair)?;
    Some((id.clone(), pair, field))
}

fn open_headline(s: &mut Studio) {
    s.quick_controls.headline = s.live.as_ref().and_then(|live| {
        let (set, pair, original) = on_air_headline(&live.snapshot)?;
        let input = TextEdit::new(original.value.clone());
        Some(HeadlineDraft {
            set,
            pair,
            original,
            input,
        })
    });
}

pub(super) fn dismiss_publish(s: &mut Studio) {
    if matches!(s.quick_controls.publish, Some(PublishPopout::Composer)) {
        if !s.publish.can_close_composer() {
            return;
        }
        s.publish.composing = false;
    }
    s.quick_controls.publish = None;
}

fn headline_editor(s: &Studio, snap: &Snapshot) -> El {
    let Some(draft) = &s.quick_controls.headline else {
        return hint("Take a set or show with a headline on air.");
    };
    let current = on_air_headline(snap).is_some_and(|(id, pair, field)| {
        id == draft.set && pair == draft.pair && field == draft.original
    });
    if !current {
        return col()
            .gap(4.)
            .child(hint("The on-air headline changed."))
            .child(button(
                "quick-headline-reload",
                "Load current headline",
                false,
                open_headline,
            ));
    }
    let can_update = draft.changed_text().is_some();
    let apply = button(
        "quick-headline-take",
        "Update on air",
        can_update,
        update_headline,
    )
    .self_start();
    col()
        .gap(5.)
        .child(
            field("quick-headline-field", &draft.input, |s| {
                &mut s.quick_controls.headline.as_mut().unwrap().input
            })
            .label("Headline"),
        )
        .child(if can_update {
            apply.hover_fill(color(theme::SELECTED_HOVER))
        } else {
            apply
                .opacity(0.55)
                .disabled(true)
                .help("Edit the headline to update it")
        })
}

fn update_headline(s: &mut Studio) {
    let (Some(live), Some(draft)) = (&s.live, &s.quick_controls.headline) else {
        return;
    };
    let Some((id, pair, field)) = on_air_headline(&live.snapshot) else {
        return;
    };
    if id != draft.set || pair != draft.pair || field != draft.original {
        return;
    }
    let Some(value) = draft.changed_text() else {
        return;
    };
    let expected = live.snapshot.project.production.sets[&id].clone();
    let mut updated = expected.clone();
    if let Err(error) = field.apply(&mut updated, &pair, value) {
        s.error = error.to_string();
        return;
    }
    s.send(RoomCommand::SetEditSave {
        id,
        expected,
        draft: updated,
        layout: Some(pair),
    });
    s.quick_controls.expanded = None;
}

fn key(control: &QuickControl) -> String {
    match control {
        QuickControl::Camera => "camera".into(),
        QuickControl::Microphone => "mic".into(),
        QuickControl::ScreenShare => "screen".into(),
        QuickControl::Layouts => "layouts".into(),
        QuickControl::Headline => "headline".into(),
        QuickControl::SaveClip => "clip".into(),
        QuickControl::Publish => "publish".into(),
        QuickControl::Sound(id) => format!("sound-{id}"),
    }
}

fn label(control: &QuickControl) -> &str {
    match control {
        QuickControl::Camera => "Camera",
        QuickControl::Microphone => "Mic",
        QuickControl::ScreenShare => "Screen Share",
        QuickControl::Layouts => "Layouts",
        QuickControl::Headline => "Headline",
        QuickControl::SaveClip => "Save Clip",
        QuickControl::Publish => "Publish",
        QuickControl::Sound(id) => id,
    }
}

fn icon(control: &QuickControl) -> &'static str {
    match control {
        QuickControl::Camera => "camera",
        QuickControl::Microphone => "mic",
        QuickControl::ScreenShare => "screen",
        QuickControl::Layouts => "panels",
        QuickControl::Headline => "edit",
        QuickControl::SaveClip => "record",
        QuickControl::Publish => "send",
        QuickControl::Sound(_) => "volume",
    }
}

fn hint(value: impl Into<String>) -> El {
    text(value.into())
        .font(TextStyle::new(11., 500.))
        .color(color(MUTED))
        .wrap()
}

fn toggle(s: &mut Studio, control: &QuickControl) {
    let open = s.quick_controls.expanded.as_ref() != Some(control);
    s.quick_controls.expanded = open.then(|| control.clone());
    if open {
        s.source = None;
        match control {
            QuickControl::Headline => open_headline(s),
            QuickControl::Camera => panels::load_camera_info(s, "camera"),
            _ => {}
        }
    }
}

fn source_name(snap: &Snapshot, source: &str) -> String {
    let devices = if source == "camera" {
        &snap.cameras
    } else {
        &snap.microphones
    };
    let device = snap
        .project
        .inputs
        .get(source)
        .map(|input| input.device.as_str())
        .filter(|value| !value.is_empty());
    devices
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| {
            device.map_or(item["default"] == true, |id| {
                item["id"].as_str() == Some(id)
            })
        })
        .and_then(|item| item["name"].as_str())
        .unwrap_or("Choose input")
        .into()
}

fn camera_or_mic(snap: &Snapshot, control: &QuickControl, compact: bool, expanded: bool) -> El {
    let is_mic = *control == QuickControl::Microphone;
    let source = if is_mic { "microphone" } else { "camera" };
    let lane = snap.project.lanes.iter().find(|lane| lane.source == source);
    let key = format!("quick-{}", key(control));
    let mut r = control_row(
        &key,
        label(control),
        icon(control),
        expanded,
        compact,
        None,
    );
    let device = source_name(snap, source);
    if compact {
        r = r.help(device);
    } else if !compact {
        r = r.child(title(device, 10., 500., MUTED).max_w(124.));
    }
    let control = control.clone();
    r = r
        .child(disclosure(expanded))
        .on_press(move |s: &mut Studio| toggle(s, &control));
    if is_mic {
        if let Some(lane) = lane {
            let peak = snap.mixer_peaks.get(source).copied().unwrap_or(0.);
            let level = mixer::meter_level(peak * lane.gain, lane.muted);
            r = row()
                .items_center()
                .gap(4.)
                .child(r.w(0.).grow(1.))
                .child(
                    el().w(if compact { 13. } else { 19. })
                        .h(4.)
                        .radius(2.)
                        .fill(color(theme::SLIDER_RAIL_COMPACT))
                        .child(el().w_frac(level).h_full().radius(2.).fill(color(MINT))),
                )
                .child(
                    panels::send_tool(
                        "quick-mic-mute",
                        if lane.muted { "mic-off" } else { "mic" },
                        if lane.muted { "Unmute mic" } else { "Mute mic" },
                        lane.muted,
                        RoomCommand::Gain {
                            source: source.into(),
                            gain: lane.gain,
                            muted: !lane.muted,
                        },
                    )
                    .size(if compact { 23. } else { 29. }, 30.),
                );
        }
    }
    r
}

fn disclosure(expanded: bool) -> El {
    panels::glyph(if expanded { "chevron-up" } else { "chevron-down" }, 11., MUTED)
}

fn with_settings(action: El, control: QuickControl, expanded: bool) -> El {
    let name = label(&control);
    let settings = panels::tool(
        &format!("quick-{}-settings", key(&control)),
        if expanded { "chevron-up" } else { "chevron-down" },
        &format!("{} {name} settings", if expanded { "Hide" } else { "Show" }),
        false,
        move |s| toggle(s, &control),
    ).size(22., 32.)
        .fill(color(SURFACE))
        .hover_fill(color(theme::GRIP_HOVER));
    let settings = if expanded { settings.border(1., color(theme::GRIP)) } else { settings };
    row().w_full().min_w(0.).gap(2.)
        .child(action.w(0.).grow(1.))
        .child(settings)
}

fn control_row(
    key: &str,
    name: &str,
    glyph: &str,
    expanded: bool,
    compact: bool,
    unavailable: Option<&str>,
) -> El {
    let tile = row()
        .key(key.to_owned())
        .role("button")
        .label(name)
        .focusable(true)
        .w_full()
        .h(32.)
        .min_w(0.)
        .px(if compact { 4. } else { 8. })
        .gap(if compact { 3. } else { 7. })
        .items_center()
        .radius(6.)
        .fill(color(SURFACE))
        .border(
            1.,
            if expanded {
                color(theme::GRIP)
            } else {
                color(SURFACE).alpha(0.)
            },
        )
        .child(panels::glyph(glyph, if compact { 11. } else { 14. }, MUTED))
        .child(title(name, if compact { 10.5 } else { 12. }, 600., TEXT).grow(1.));
    if let Some(reason) = unavailable {
        tile.opacity(0.55).disabled(true).help(reason)
    } else {
        tile.hover_fill(color(theme::GRIP_HOVER))
    }
}

fn save_clip(live: &Live, compact: bool) -> El {
    let Some((status, _)) = &live.clip_view else {
        return control_row(
            "quick-clip",
            "Save Clip",
            "clip",
            false,
            compact,
            Some("Clips unavailable"),
        );
    };
    if !status.enabled {
        return control_row(
            "quick-clip-enable",
            if compact { "Clips off" } else { "Enable Clips" },
            "clip",
            false,
            compact,
            None,
        ).label("Enable Clips").help("Enable rolling capture")
        .on_press(|s: &mut Studio| s.send(RoomCommand::ClipsEnable { enabled: true }));
    }
    let (name, unavailable) = if status.saving {
        (
            if compact { "Saving…" } else { "Saving clip…" }.into(),
            Some("Wait for this clip to finish saving"),
        )
    } else if !status.ready {
        (
            if compact { "Buffering…" } else { "Buffering clips…" }.into(),
            Some("Waiting for frames to buffer"),
        )
    } else if compact {
        (format!("Save {}s", status.settings.seconds), None)
    } else {
        (format!("Save last {}s", status.settings.seconds), None)
    };
    control_row("quick-clip", &name, "clip", false, compact, unavailable)
        .on_press(|s: &mut Studio| s.send(RoomCommand::ClipsSave))
}

fn clip_editor(s: &Studio, live: &Live) -> El {
    let Some((status, _)) = &live.clip_view else {
        return hint("Clips unavailable");
    };
    let mut settings = col().gap(6.)
        .child(row().items_center().gap(6.)
            .child(title("Rolling capture", 11., 550., TEXT).grow(1.))
            .child(panels::clip_switch("quick-clips-enabled", status.enabled).disabled(status.saving)))
        .child(panels::clip_settings(s, status, "quick-"));
    if let Some(error) = &status.error {
        settings = settings.child(title(error, 11., 500., 0xffadb3).wrap());
    }
    settings
}

fn layout_editor(s: &Studio, snap: &Snapshot, columns: usize) -> El {
    let Some(target) = panels::set_control_target(s, snap) else {
        return col()
            .gap(5.)
            .child(hint("Choose a set from the set library."))
            .child(
                command(
                    "quick-open-set-controls",
                    "Open Set Controls",
                    false,
                    RoomCommand::Workspace {
                        command: WorkspaceCommand::Activate {
                            panel: PanelId::Controls,
                        },
                    },
                )
                .self_start(),
            );
    };
    let p = &snap.project;
    let mut editor = col().gap(5.);
    if let Some((id, show)) = target
        .show_id
        .and_then(|id| p.production.shows.get(id).map(|show| (id, show)))
    {
        if let Some(player) =
            panels::show_controller(s, snap, id, show, &p.production.sets[&target.key], "quick-")
        {
            editor = editor.child(player);
        }
        if let Some((show, segment)) = p
            .playing_segment
            .clone()
            .filter(|_| target.running && p.shot_override.is_some())
        {
            editor = editor.child(
                command(
                    "quick-follow-show",
                    "Follow rundown",
                    false,
                    RoomCommand::ShowLayout {
                        show,
                        segment,
                        layout: None,
                    },
                )
                .self_start(),
            );
        }
    } else if !target.set_on_output {
        editor = editor.child(
            command(
                "quick-take-set",
                "Take set",
                true,
                RoomCommand::SetMount {
                    id: Some(target.key.clone()),
                    layout: Some(target.pair.clone()),
                },
            )
            .self_start(),
        );
    }
    editor.child(panels::layout_buttons(s, snap, &target, 0., Some(columns)))
}

pub(super) fn open_publish(s: &mut Studio, file: Option<PathBuf>) {
    if !s.publish.can_open_composer() {
        return;
    }
    s.quick_controls.expanded = None;
    if s.publish.scope.is_none() {
        s.quick_controls.publish = Some(PublishPopout::SignIn { clip: file });
        return;
    }
    if let Some(file) = file {
        s.publish.attach_clip(file);
    }
    super::publish::new_post(s);
    s.quick_controls.publish = Some(PublishPopout::Composer);
}

pub(super) fn publish_open(s: &Studio) -> bool {
    match s.quick_controls.publish {
        Some(PublishPopout::SignIn { .. }) => true,
        Some(PublishPopout::Composer) => s.publish.composing,
        None => false,
    }
}

pub(super) fn publish_popout(s: &Studio, edge: Edge, w: f32, h: f32) -> Option<El> {
    if !publish_open(s) {
        return None;
    }
    let signing_in = matches!(s.quick_controls.publish, Some(PublishPopout::SignIn { .. }));
    let width = (w - 20.).clamp(0., if signing_in { 336. } else { 410. });
    let height = (h - 90.).clamp(0., if signing_in { 360. } else { 570. });
    let x = match edge {
        Edge::Left => 10.,
        Edge::Right => w - width - 10.,
        Edge::Top | Edge::Bottom => (w - width) / 2.,
    };
    let y = if edge == Edge::Bottom {
        h - height - 32.
    } else {
        51.
    };
    let dialog = col()
        .role("dialog")
        .absolute(x, y)
        .w(width)
        .padding(8.)
        .radius(8.)
        .fill(color(PANEL))
        .border(1., color(theme::TAB_BORDER))
        .modal(true, dismiss_publish);
    Some(if signing_in {
        dialog
            .key("quick-publish-sign-in")
            .label("Boomin account")
            .max_h(height)
            .gap(5.)
            .child(super::settings::account_form(s).scroll(Default::default()))
            .child(button("quick-publish-sign-in-close", "Close", false, dismiss_publish).self_start())
    } else {
        dialog
            .key("quick-publish-popout")
            .label("New post")
            .h(height)
            .child(super::publish::shortcut_composer(s))
    })
}

fn action(s: &Studio, live: &Live, control: &QuickControl, compact: bool) -> El {
    let snap = &live.snapshot;
    let key = format!("quick-{}", key(control));
    let expanded = s.quick_controls.expanded.as_ref() == Some(control);
    match control {
        QuickControl::Camera | QuickControl::Microphone => {
            return camera_or_mic(snap, control, compact, expanded)
        }
        QuickControl::ScreenShare => {
            let sharing = panels::slot_ready(snap, "screen");
            let status = if sharing { "Sharing" } else { "Off" };
            let mut tile = control_row(
                &key,
                label(control),
                icon(control),
                expanded,
                compact,
                None,
            );
            if compact {
                tile = tile.help(format!("Screen share · {status}"));
            } else if !compact {
                tile = tile.child(title(status, 10., 500., MUTED));
            }
            return tile.child(disclosure(expanded))
                .on_press(|s: &mut Studio| toggle(s, &QuickControl::ScreenShare));
        }
        QuickControl::SaveClip => return with_settings(save_clip(live, compact), QuickControl::SaveClip, expanded),
        QuickControl::Publish => {
            let unavailable = (!s.publish.can_open_composer()).then_some("Publish is busy");
            let action = control_row(
                &key,
                label(control),
                icon(control),
                false,
                compact,
                unavailable,
            )
            .on_press(|s: &mut Studio| open_publish(s, None));
            return with_settings(action, QuickControl::Publish, expanded);
        }
        QuickControl::Sound(id) => {
            let name = live.handle.studio_audio.sound_name(id);
            let id = id.clone();
            return control_row(
                &key, name.as_deref().unwrap_or("Sound unavailable"), icon(control), false, compact,
                name.is_none().then_some("This sound is no longer in the studio library"),
            )
            .on_press(move |s: &mut Studio| s.send(RoomCommand::StudioAudio {
                command: Audio::Trigger { id: id.clone(), mode: None },
            }));
        }
        QuickControl::Layouts | QuickControl::Headline => {}
    }
    let is_show = *control == QuickControl::Layouts
        && panels::set_control_target(s, snap).is_some_and(|target| target.show_id.is_some());
    let name = if is_show {
        "Show Player"
    } else {
        label(control)
    };
    let unavailable = (*control == QuickControl::Headline && on_air_headline(snap).is_none())
        .then_some("Take a layout with an editable headline on air");
    let opened_control = control.clone();
    control_row(
        &key,
        name,
        if is_show { "play" } else { icon(control) },
        expanded,
        compact,
        unavailable,
    )
    .child(disclosure(expanded))
    .on_press(move |s: &mut Studio| toggle(s, &opened_control))
}

fn expanded_editor(s: &Studio, live: &Live, control: &QuickControl, columns: usize) -> El {
    let snap = &live.snapshot;
    let editor = match control {
        QuickControl::Camera => panels::source_settings(s, "camera", true),
        QuickControl::Microphone => {
            let settings = panels::source_settings(s, "microphone", true);
            match mixer::shortcut_mic_gain(snap) {
                Some(gain) => settings.child(gain),
                None => settings,
            }
        }
        QuickControl::ScreenShare => panels::source_settings(s, "screen", true),
        QuickControl::Layouts => layout_editor(s, snap, columns),
        QuickControl::Headline => headline_editor(s, snap),
        QuickControl::SaveClip => clip_editor(s, live),
        QuickControl::Publish => super::publish::shortcut_settings(s),
        QuickControl::Sound(_) => return el(),
    };
    editor
        .key(format!("quick-{}-editor", key(control)))
        .w_full()
        .padding(6.)
        .min_w(0.)
        .radius(5.)
        .fill(color(theme::TOOL))
}

pub(super) fn column_picker(s: &Studio) -> El {
    let current = s
        .live
        .as_ref()
        .unwrap()
        .snapshot
        .project
        .workspace
        .shortcut_columns;
    row()
        .gap(3.)
        .items_center()
        .child(column_button(ShortcutColumns::One, current))
        .child(column_button(ShortcutColumns::Two, current))
}

fn column_button(columns: ShortcutColumns, current: ShortcutColumns) -> El {
    let (key, text, label) = match columns {
        ShortcutColumns::One => ("shortcuts-one-column", "1 col", "One column"),
        ShortcutColumns::Two => ("shortcuts-two-columns", "2 col", "Two columns"),
    };
    command(
        key,
        text,
        columns == current,
        RoomCommand::Workspace {
            command: WorkspaceCommand::SetShortcutColumns { columns },
        },
    )
    .label(label)
    .help(label)
    .h(22.)
    .px(6.)
}

fn send_workspace(s: &mut Studio, command: WorkspaceCommand) {
    s.send(RoomCommand::Workspace { command });
}

fn workspace_button(key: impl Into<String>, label: impl Into<String>, command: WorkspaceCommand) -> El {
    super::command(key, label, false, RoomCommand::Workspace { command })
}

fn shortcut_tiles(s: &Studio, live: &Live, pins: &[QuickControl], columns: usize) -> El {
    let mut grid = col().min_w(0.).gap(4.);
    for controls in pins.chunks(columns) {
        if columns == 2 {
            let mut tiles = row().w_full().gap(4.);
            for control in controls {
                tiles = tiles.child(
                    col().w(0.).min_w(0.).grow(1.).child(action(s, live, control, true)),
                );
            }
            if controls.len() == 1 {
                tiles = tiles.child(el().w(0.).grow(1.));
            }
            grid = grid.child(tiles);
        } else {
            grid = grid.child(action(s, live, &controls[0], false));
        }
        if let Some(control) = s.quick_controls.expanded.as_ref().filter(|control| controls.contains(control)) {
            grid = grid.child(expanded_editor(s, live, control, columns));
        }
    }
    grid
}

fn start_section(s: &mut Studio, id: Option<Uuid>, name: &str) {
    s.quick_controls.section_draft = Some(SectionDraft { id, name: TextEdit::new(name) });
    s.quick_controls.sound_picker = None;
    s.quick_controls.move_shortcut = None;
}

fn save_section(s: &mut Studio) {
    let Some(draft) = &s.quick_controls.section_draft else { return; };
    let Some(live) = &s.live else { return; };
    let name = draft.name.text.trim().to_owned();
    if live.snapshot.project.workspace.validate_shortcut_name(&name, draft.id).is_err() {
        return;
    }
    let command = match draft.id {
        Some(section) => WorkspaceCommand::RenameShortcutSection { section, name },
        None => WorkspaceCommand::AddShortcutSection { name },
    };
    send_workspace(s, command);
    s.quick_controls.section_draft = None;
}

fn section_form(draft: &SectionDraft, workspace: &Workspace) -> El {
    let validation = workspace.validate_shortcut_name(&draft.name.text, draft.id);
    let mut form = col().gap(4.).padding(6.).radius(5.).fill(color(theme::TOOL))
        .child(field("quick-section-name", &draft.name, |s| {
            &mut s.quick_controls.section_draft.as_mut().unwrap().name
        }).label("Section name").placeholder("Section name", color(MUTED)))
        .child(row().gap(4.)
            .child(button("quick-section-save", if draft.id.is_some() { "Save name" } else { "Create section" },
                true, save_section).disabled(validation.is_err()))
            .child(button("quick-section-cancel", "Cancel", false, |s| s.quick_controls.section_draft = None)));
    if !draft.name.text.trim().is_empty() {
        if let Err(error) = validation {
            form = form.child(hint(error.to_string()));
        }
    }
    form
}

fn pick_sound(live: &Live, workspace: &Workspace, picker: &SoundPicker) -> El {
    const PAGE_SIZE: usize = 8;
    let page = live.handle.studio_audio.catalog(Some(Kind::Effect), &picker.query.text, picker.offset, PAGE_SIZE);
    let mut body = col().gap(4.).padding(6.).radius(5.).fill(color(theme::TOOL))
        .child(field("quick-sound-search", &picker.query, |s| {
            let picker = s.quick_controls.sound_picker.as_mut().unwrap();
            picker.offset = 0;
            &mut picker.query
        }).label("Search sounds").placeholder("Search sounds", color(MUTED)));
    for sound in &page.items {
        let control = QuickControl::Sound(sound.id.clone());
        let pinned = workspace.shortcuts().any(|existing| existing == &control);
        body = body.child(button(
            format!("quick-pick-sound-{}", sound.id),
            if pinned { format!("{} · Added", sound.name) } else { sound.name.clone() },
            false,
            move |s| {
                send_workspace(s, WorkspaceCommand::PinControl { control: control.clone() });
                s.quick_controls.sound_picker = None;
            },
        ).label(format!("Add {}", sound.name)).help(&sound.name).disabled(pinned));
    }
    if page.items.is_empty() {
        body = body.child(hint("No matching sounds."));
    }
    body.child(row().items_center().gap(4.).flex_wrap()
        .child(button("quick-sounds-prev", "Previous", false, |s| {
            let picker = s.quick_controls.sound_picker.as_mut().unwrap();
            picker.offset = picker.offset.saturating_sub(PAGE_SIZE);
        }).disabled(picker.offset == 0))
        .child(button("quick-sounds-next", "Next", false, |s| {
            s.quick_controls.sound_picker.as_mut().unwrap().offset += PAGE_SIZE;
        }).disabled(picker.offset + PAGE_SIZE >= page.total))
        .child(button("quick-sounds-close", "Done", false, |s| s.quick_controls.sound_picker = None)))
}

fn move_destinations(workspace: &Workspace, control: &QuickControl, current: Option<Uuid>) -> El {
    let mut destinations = col().gap(3.).padding(5.).radius(5.).fill(color(theme::TOOL))
        .child(hint("Move to section"));
    let choices = std::iter::once((None, "Unsectioned"))
        .chain(workspace.shortcut_sections.iter().map(|section| (Some(section.id), section.name.as_str())));
    for (section, name) in choices.filter(|(id, _)| *id != current) {
        let control = control.clone();
        let id = section.map_or_else(|| "unsectioned".into(), |id| id.to_string());
        destinations = destinations.child(button(format!("quick-move-to-{id}"), name, false, move |s| {
            send_workspace(s, WorkspaceCommand::MoveControlToSection { control: control.clone(), section });
            s.quick_controls.move_shortcut = None;
        }));
    }
    destinations
}

fn edit_shortcuts(s: &Studio, live: &Live, workspace: &Workspace, pins: &[QuickControl], section: Option<Uuid>) -> El {
    let mut list = col().gap(4.);
    for (index, control) in pins.iter().enumerate() {
        let key = key(control);
        let name = match control {
            QuickControl::Sound(id) => live.handle.studio_audio.sound_name(id).unwrap_or_else(|| id.clone()),
            _ => label(control).into(),
        };
        let mut edit = row().h(28.).gap(3.).items_center()
            .child(title(&name, 11., 550., TEXT).help(&name).grow(1.));
        if !workspace.shortcut_sections.is_empty() {
            let section_control = control.clone();
            let open = s.quick_controls.move_shortcut.as_ref() == Some(control);
            edit = edit.child(panels::tool(
                &format!("quick-move-{key}"), "folder", &format!("Move {name} to section"), false,
                move |s| {
                    s.quick_controls.move_shortcut = (!open).then(|| section_control.clone());
                    s.quick_controls.section_draft = None;
                    s.quick_controls.sound_picker = None;
                },
            ).size(25., 25.));
        }
        if index > 0 {
            edit = edit.child(workspace_button(
                format!("quick-up-{key}"), "↑",
                WorkspaceCommand::MoveControl { control: control.clone(), before: pins[index - 1].clone() },
            ).label(format!("Move {name} up")).size(24., 24.).padding(0.));
        }
        list = list.child(edit.child(workspace_button(
            format!("quick-remove-{key}"), "×", WorkspaceCommand::UnpinControl { control: control.clone() },
        ).label(format!("Unpin {name}")).size(24., 24.).padding(0.)));
        if s.quick_controls.move_shortcut.as_ref() == Some(control) {
            list = list.child(move_destinations(workspace, control, section));
        }
    }
    list
}

fn section_header(section: &ShortcutSection) -> El {
    row().key(format!("quick-section-{}", section.id)).items_center().gap(6.).min_w(0.)
        .child(title(&section.name, 11., 600., MUTED).help(&section.name).max_w(175.))
        .child(el().h(1.).grow(1.).fill(color(theme::TAB_BORDER)))
}

fn edit_section(section: &ShortcutSection, index: usize, count: usize) -> El {
    let id = section.id;
    let name = section.name.clone();
    row().key(format!("quick-section-{id}")).w_full().min_w(0.).items_center().gap(4.)
        .child(title(&name, 11., 650., TEXT).help(&name).grow(1.))
        .child(panels::tool(&format!("quick-section-rename-{id}"), "edit", "Rename section", false,
            move |s| start_section(s, Some(id), &name)).size(24., 24.))
        .child(workspace_button(
            format!("quick-section-up-{id}"), "↑", WorkspaceCommand::ShiftShortcutSection { section: id, up: true },
        ).size(24., 24.).padding(0.).label("Move section up").disabled(index == 0))
        .child(workspace_button(
            format!("quick-section-down-{id}"), "↓", WorkspaceCommand::ShiftShortcutSection { section: id, up: false },
        ).size(24., 24.).padding(0.).label("Move section down").disabled(index + 1 == count))
        .child(workspace_button(
            format!("quick-section-remove-{id}"), "×", WorkspaceCommand::RemoveShortcutSection { section: id },
        ).size(24., 24.).padding(0.).label("Remove section").help("Move these shortcuts to Unsectioned"))
}

pub(super) fn panel(s: &Studio, width: f32) -> El {
    let live = s.live.as_ref().unwrap();
    let workspace = &live.snapshot.project.workspace;
    let mut list = col().key("quick-controls-body").min_w(0.).gap(6.);
    if s.quick_controls.editing {
        if workspace.panels[&PanelId::QuickControls].header == HeaderMode::Hidden {
            list = list.child(column_picker(s));
        }
        list = list.child(row().gap(4.).flex_wrap()
            .child(button("quick-add-section", "+ Section", false, |s| start_section(s, None, "")))
            .child(button("quick-add-sound", "+ Sound", false, |s| {
                s.quick_controls.sound_picker = Some(SoundPicker::default());
                s.quick_controls.section_draft = None;
                s.quick_controls.move_shortcut = None;
            })));
        if let Some(draft) = &s.quick_controls.section_draft {
            list = list.child(section_form(draft, workspace));
        }
        if let Some(picker) = &s.quick_controls.sound_picker {
            list = list.child(pick_sound(live, workspace, picker));
        }
        if !workspace.shortcut_sections.is_empty() && !workspace.quick_controls.is_empty() {
            list = list.child(title("Unsectioned", 11., 600., MUTED));
        }
        list = list.child(edit_shortcuts(s, live, workspace, &workspace.quick_controls, None));
        for (index, section) in workspace.shortcut_sections.iter().enumerate() {
            list = list.child(col().gap(4.).padding(6.).radius(6.).fill(color(theme::TOOL))
                .child(edit_section(section, index, workspace.shortcut_sections.len()))
                .child(if section.controls.is_empty() { hint("No shortcuts in this section.") } else {
                    edit_shortcuts(s, live, workspace, &section.controls, Some(section.id))
                }));
        }
        let mut picker = row().flex_wrap().gap(4.);
        for control in QuickControl::BUILT_INS.into_iter().filter(|control| !workspace.shortcuts().any(|pin| pin == control)) {
            picker = picker.child(workspace_button(
                format!("quick-pin-{}", key(&control)), label(&control).to_owned(),
                WorkspaceCommand::PinControl { control },
            ));
        }
        list = list.child(picker);
    } else {
        let columns = if workspace.shortcut_columns == ShortcutColumns::Two && width >= 220. { 2 } else { 1 };
        list = list.child(shortcut_tiles(s, live, &workspace.quick_controls, columns));
        for section in &workspace.shortcut_sections {
            list = list.child(col().gap(6.)
                .child(section_header(section))
                .child(shortcut_tiles(s, live, &section.controls, columns)));
        }
    }
    list.child(button(
        "quick-edit-pins", if s.quick_controls.editing { "Done" } else { "Edit shortcuts" }, false,
        |s| {
            let quick = &mut s.quick_controls;
            quick.editing = !quick.editing;
            quick.collapse();
            quick.section_draft = None;
            quick.sound_picker = None;
            quick.move_shortcut = None;
        },
    ).self_start())
}
