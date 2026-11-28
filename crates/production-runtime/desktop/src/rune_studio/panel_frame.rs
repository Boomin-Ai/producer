//! Operator chrome. Features provide their controls; the frame owns their bounds.
use super::*;
use crate::workspace::{HeaderMode, Panel};

pub(super) fn surface(id: PanelId, panel: &Panel) -> El {
    let frame = col()
        .key(format!("dock-{}-{}", panel.edge.key(), id.key()))
        .label(id.label())
        .min_h(0.).min_w(0.).grow(panel.weight)
        .clip_rounded(5.).radius(5.).padding(6.).gap(3.).fill(color(PANEL));
    let frame = if theme::orbital() {
        frame.radius(10.).clip_rounded(10.).padding(8.).gap(5.)
            .gradient(color(0x122b2a), color(PANEL)).border(1., color(0x27423e))
    } else { frame };
    if panel.edge.side() { frame.h(0.) } else { frame.w(0.) }
}

pub(super) fn header(s: &Studio, id: PanelId, mode: HeaderMode, split: bool) -> Option<El> {
    if id == PanelId::Publish && mode == HeaderMode::Hidden { return None; }
    let action = match id {
        PanelId::Controls if mode != HeaderMode::Hidden && s.live.as_ref().is_some_and(|l| {
            let p = &l.snapshot.project;
            p.mounted_set.is_some() || p.production.sets.keys().any(|id| id != "room-scene")
        }) => Some(panels::edit_set_button()),
        PanelId::Sources | PanelId::Scenes => Some(panels::list_add(id)),
        PanelId::Publish => publish::header_actions(s, split),
        PanelId::QuickControls if mode != HeaderMode::Hidden => Some(quick_controls::column_picker(s)),
        PanelId::Assistant => Some(chat::logs_button()),
        PanelId::Clips => panels::clip_actions(s),
        PanelId::People => Some(people::trigger(s)),
        PanelId::Timeline => Some(command("close-timeline", "×", false, RoomCommand::Workspace {
            command: WorkspaceCommand::Visibility { panel: id, visible: false }
        }).label("Close Timeline").help("Close Timeline").size(24., 24.).padding(0.)),
        _ => None,
    };
    let detail = match id {
        PanelId::Mixer => Some("48 kHz"),
        PanelId::Sound if s.sound_library => Some("Add sounds"),
        _ => None,
    };
    if mode == HeaderMode::Hidden && action.is_none() { return None; }
    let mut bar = row().items_center().gap(4.).key(format!("frame-heading-{}", id.key()));
    if mode != HeaderMode::Hidden {
        let compact = mode == HeaderMode::Compact;
        if id == PanelId::Controls {
            bar = bar.h(22.).child(title(id.label(), 11., 550., MUTED));
        } else {
            bar = bar.h(if compact { 22. } else { 30. })
                .child(title(id.label(), if compact { 11. } else { 15. }, 650., TEXT));
        }
    }
    bar = bar.child(el().grow(1.));
    if mode == HeaderMode::Standard {
        if let Some(text) = detail { bar = bar.child(title(text, 11., 500., MUTED)); }
    }
    if let Some(action) = action { bar = bar.child(action); }
    Some(bar)
}

pub(super) fn scroll_body(id: PanelId, content: El) -> El {
    col().key(format!("panel-scroll-{}", id.key())).h(0.).grow(1.).min_h(0.).w_full()
        .child(content).scroll(Default::default())
}
