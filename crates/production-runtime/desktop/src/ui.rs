use crate::{
    engine::{Handle, RoomCommand, Snapshot},
    model::CanvasView,
    workspace::{Edge, PanelId, Workspace, WorkspaceCommand},
};
use gpui::{prelude::*, *};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
const BG: u32 = 0x080d14;
const PANEL: u32 = 0x0c141e;
const LINE: u32 = 0x243240;
const TEXT: u32 = 0xe4edf3;
const MUTED: u32 = 0x8ca2af;
const ACCENT: u32 = 0x78ddba;
fn meter_level(peak: f32, muted: bool) -> f32 {
    if muted || !peak.is_finite() || peak <= 0.000_001 {
        return 0.;
    }
    ((20. * peak.log10() + 60.) / 60.).clamp(0., 1.)
}
const DOCK_GAP: f32 = 4.;
const DOCK_BORDER: u32 = 0x1b2833;
// Shared, stroke-based toolbar artwork; GPUI caches the SVG masks on the GPU.
fn icon(name: &str) -> Svg {
    let data: &[u8] = match name {
        "plus" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>"#,
        "record" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle fill="black" cx="12" cy="12" r="7"/></svg>"#,
        "stop" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect fill="black" x="5" y="5" width="14" height="14" rx="2"/></svg>"#,
        "mic" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>"#,
        "mic-off" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5V4a3 3 0 0 1 6 0v8M9 9v3a3 3 0 0 0 5 2M5 10v2a7 7 0 0 0 12 5m2-5v-2M12 19v3m-4 0h8M3 3l18 18"/></svg>"#,
        "screen" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-4 0h8M12 13V7m-3 3 3-3 3 3"/></svg>"#,
        "settings" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 3 1-2h4l1 2 2 1 2 0 2 3-1 2v3l1 2-2 3h-2l-2 1-1 3h-4l-1-3-2-1H5l-2-3 1-2V9L3 7l2-3h2z" transform="translate(0 1)"/><circle cx="12" cy="12" r="3"/></svg>"#,
        "edit" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4 5 5-10 10-6 1 1-6zM13 6l5 5"/></svg>"#,
        "done" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>"#,
        "activity" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-8 5 16 3-8h5"/></svg>"#,
        "link" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 1) scale(.9)"/></svg>"#,
        "channels" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 20H5a2 2 0 0 1-2-2V8"/></svg>"#,
        "studio" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 3v18m0-7h11"/></svg>"#,
        "camera" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/></svg>"#,
        "live" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/></svg>"#,
        "mixer" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"><path d="M5 3v18M12 3v18M19 3v18M2 8h6m1 8h6m1-10h6"/></svg>"#,
        "timeline" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"><path d="M3 4h18M8 2v20"/><rect x="3" y="9" width="10" height="4" rx="1"/><rect x="10" y="16" width="11" height="4" rx="1"/></svg>"#,
        "panels" => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>"#,
        _ => br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg>"#,
    };
    svg().data(data).size(px(18.)).text_color(rgb(0xaab4c2))
}
struct HeaderTip(SharedString);
impl Render for HeaderTip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(260.))
            .px(px(10.))
            .py(px(7.))
            .rounded(px(6.))
            .bg(rgb(0x18222e))
            .border_1()
            .border_color(rgb(LINE))
            .text_color(rgb(TEXT))
            .text_size(px(11.))
            .child(self.0.clone())
    }
}
fn tool(id: &str, name: &str, hint: &str, active: bool, available: bool) -> Stateful<Div> {
    let hint = SharedString::from(hint.to_owned());
    div()
        .id(SharedString::from(id.to_owned()))
        .size(px(34.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(9.))
        .bg(rgb(if active { 0x16382f } else { 0x0c121b }))
        .text_color(rgb(if !available {
            0x46505d
        } else if active {
            ACCENT
        } else {
            0xaab4c2
        }))
        .cursor(if available {
            CursorStyle::PointingHand
        } else {
            CursorStyle::Arrow
        })
        .hover(move |s| s.bg(rgb(if available { 0x1a2531 } else { 0x0c121b })))
        .child(
            icon(name).text_color(rgb(if name == "record" || name == "stop" {
                0xff5b68
            } else if !available {
                0x46505d
            } else if active {
                ACCENT
            } else {
                0xaab4c2
            })),
        )
        .tooltip(move |_, cx| cx.new(|_| HeaderTip(hint.clone())).into())
}
enum Drag {
    DockSize {
        edge: Edge,
        size: f32,
        mouse: f32,
        moved: bool,
        collapsed: bool,
    },
    PanelSplit {
        edge: Edge,
        first: PanelId,
        second: PanelId,
        ratio: f32,
        span: f32,
        mouse: f32,
    },
    Panel {
        panel: PanelId,
        origin: Point<Pixels>,
        pointer: Point<Pixels>,
        moved: bool,
        original: Workspace,
        placement: Option<(Edge, Option<PanelId>)>,
    },
    Seek,
    Trim {
        clip: String,
        start: f64,
        duration: f64,
        source_in: f64,
        right: bool,
        mouse: f32,
    },
    Gain {
        start: f32,
        gain: f32,
        muted: bool,
        vertical: bool,
        span: f32,
        source: String,
    },
}
pub struct Room {
    pub handle: Arc<Handle>,
    snapshot: Snapshot,
    focus: FocusHandle,
    quick: bool,
    width: String,
    height: String,
    target: usize,
    field: Option<bool>,
    drag: Option<Drag>,
    pending_trim: Option<RoomCommand>,
    pending_gain: Option<RoomCommand>,
    gain_preview: Option<(String, f32, bool, Instant)>,
    last_gain_sent: Instant,
    last_error: Option<String>,
    workspace_preview: Option<Workspace>,
    workspace_pending_until: Option<Instant>,
    drop_edge: Option<Edge>,
    panel_menu: Option<PanelId>,
    add_panel_menu: Option<Edge>,
    edit_layout: bool,
    header_menu: Option<&'static str>,
    diagnostics_open: bool,
    timeline_details: bool,
    source_picker: Option<(String, Option<String>)>,
    source_picker_anchor: Point<Pixels>,
}
impl Room {
    pub fn new(handle: Arc<Handle>, cx: &mut Context<Self>) -> Self {
        cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(33))
                .await;
            if this
                .update(cx, |this, cx| {
                    this.snapshot = this.handle.snapshot();
                    if this.last_gain_sent.elapsed() >= Duration::from_millis(50) {
                        if let Some(command) = this.pending_gain.take() {
                            this.send(command, cx);
                            this.last_gain_sent = Instant::now();
                        }
                    }
                    if let Some((source, gain, muted, until)) = &this.gain_preview {
                        let settled = this.snapshot.project.lanes.iter().any(|l| {
                            l.source == *source
                                && (l.gain - *gain).abs() < 0.0001
                                && l.muted == *muted
                        });
                        if settled || Instant::now() >= *until {
                            this.gain_preview = None;
                        }
                    }
                    if this
                        .workspace_pending_until
                        .is_some_and(|deadline| Instant::now() >= deadline)
                        || this.workspace_preview.as_ref() == Some(&this.snapshot.project.workspace)
                    {
                        this.workspace_preview = None;
                        this.workspace_pending_until = None;
                    }
                    if this
                        .handle
                        .closed
                        .load(std::sync::atomic::Ordering::Acquire)
                    {
                        cx.quit();
                    } else {
                        cx.notify();
                    }
                })
                .is_err()
            {
                break;
            }
        })
        .detach();
        let snapshot = handle.snapshot();
        Self {
            handle,
            snapshot,
            focus: cx.focus_handle(),
            quick: false,
            width: "1920".into(),
            height: "1080".into(),
            target: 0,
            field: None,
            drag: None,
            pending_trim: None,
            pending_gain: None,
            gain_preview: None,
            last_gain_sent: Instant::now(),
            last_error: None,
            workspace_preview: None,
            workspace_pending_until: None,
            drop_edge: None,
            panel_menu: None,
            add_panel_menu: None,
            edit_layout: false,
            header_menu: None,
            diagnostics_open: false,
            timeline_details: false,
            source_picker: None,
            source_picker_anchor: point(px(0.), px(0.)),
        }
    }
    fn send(&mut self, c: RoomCommand, cx: &mut Context<Self>) {
        if matches!(
            &c,
            RoomCommand::Workspace {
                command: WorkspaceCommand::Move { .. }
                    | WorkspaceCommand::Place { .. }
                    | WorkspaceCommand::Activate { .. }
                    | WorkspaceCommand::Visibility { .. }
                    | WorkspaceCommand::Reset
            }
        ) {
            self.panel_menu = None;
            self.add_panel_menu = None;
        }
        let preview = if let RoomCommand::Workspace { command } = &c {
            let mut next = self.workspace().clone();
            match next.apply(command.clone()) {
                Ok(()) => Some(next),
                Err(e) => {
                    self.last_error = Some(e.to_string());
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        match self.handle.send(c) {
            Ok(()) => {
                if let Some(preview) = preview {
                    self.workspace_preview = Some(preview);
                    self.workspace_pending_until = Some(Instant::now() + Duration::from_secs(2));
                }
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
                self.workspace_preview = None;
                self.workspace_pending_until = None;
            }
        }
        cx.notify();
    }
    fn workspace(&self) -> &Workspace {
        self.workspace_preview
            .as_ref()
            .unwrap_or(&self.snapshot.project.workspace)
    }
    fn workspace_button(
        &self,
        id: String,
        label: impl Into<SharedString>,
        active: bool,
        command: WorkspaceCommand,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.button(&id, label, active, RoomCommand::Workspace { command }, cx)
            .h(px(26.))
            .px(px(8.))
    }
    fn toggle_edit_layout(&mut self, cx: &mut Context<Self>) {
        self.edit_layout = !self.edit_layout;
        self.panel_menu = None;
        self.add_panel_menu = None;
        self.header_menu = None;
        self.quick = false;
        self.field = None;
        self.drag = None;
        self.drop_edge = None;
        self.workspace_preview = None;
        self.workspace_pending_until = None;
        self.pending_trim = None;
        cx.notify();
    }
    fn dock_extents(&self, window: &Window) -> [f32; 4] {
        let width = window.viewport_size().width.into();
        let height = window.viewport_size().height.into();
        if self.edit_layout {
            self.workspace().layout_extents(width, height, true)
        } else {
            self.workspace().extents(width, height)
        }
    }
    /// Edit mode exposes membership, independently of the room's collapsed state.
    /// A panel owns its tile; adding another panel is a dock-level action.
    fn panel_split(
        &self,
        edge: Edge,
        first: PanelId,
        second: PanelId,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let extents = self.dock_extents(window);
        let length = if edge.side() {
            f32::from(window.viewport_size().height)
                - 74.
                - extents[2]
                - extents[3]
                - if self.edit_layout { 4. } else { 0. }
        } else {
            f32::from(window.viewport_size().width)
                - if self.edit_layout {
                    4.
                } else if self.workspace().docks[&edge].collapsed {
                    44.
                } else {
                    0.
                }
        };
        let spans = self.workspace().panel_spans(edge, length, self.edit_layout);
        let span: f32 = spans
            .iter()
            .filter(|(p, _, _)| *p == first || *p == second)
            .map(|(_, _, size)| *size)
            .sum();
        let a = self.workspace().panels[&first].weight;
        let b = self.workspace().panels[&second].weight;
        div()
            .id(SharedString::from(format!(
                "split-{}-{}",
                first.key(),
                second.key()
            )))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgb(BG))
            .when(edge.side(), |s| {
                s.h(px(4.)).w_full().cursor(CursorStyle::ResizeUpDown)
            })
            .when(!edge.side(), |s| {
                s.w(px(4.)).h_full().cursor(CursorStyle::ResizeLeftRight)
            })
            .hover(|s| s.bg(rgb(0x29404d)))
            .child(
                div()
                    .rounded_full()
                    .bg(rgb(0x38505c))
                    .w(px(if edge.side() { 24. } else { 2. }))
                    .h(px(if edge.side() { 2. } else { 16. })),
            )
            .tooltip(|_, cx| cx.new(|_| HeaderTip("Drag to resize panels".into())).into())
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    this.workspace_pending_until = None;
                    this.drag = Some(Drag::PanelSplit {
                        edge,
                        first,
                        second,
                        ratio: a / (a + b),
                        span,
                        mouse: if edge.side() {
                            e.position.y.into()
                        } else {
                            e.position.x.into()
                        },
                    });
                    cx.stop_propagation();
                }),
            )
    }
    fn edit_dock(&self, edge: Edge, extent: f32, window: &Window, cx: &mut Context<Self>) -> Div {
        let ids = self.workspace().at(edge);
        let selected = self.drop_edge == Some(edge);
        let valid = match &self.drag {
            Some(Drag::Panel { panel, .. }) => panel.accepts(edge),
            _ => true,
        };
        let add = div()
            .id(SharedString::from(format!("add-panel-{}", edge.key())))
            .flex_none()
            .when(edge.side(), |s| s.h(px(28.)).w_full())
            .when(!edge.side(), |s| s.w(px(76.)).h_full())
            .rounded(px(5.))
            .border_1()
            .border_color(rgb(0x14202a))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(10.))
            .text_color(rgb(MUTED))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(PANEL)).text_color(rgb(TEXT)))
            .child("Add panel")
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.panel_menu = None;
                this.add_panel_menu = if this.add_panel_menu == Some(edge) {
                    None
                } else {
                    Some(edge)
                };
                cx.notify();
            }));
        let mut content = div().flex_1().min_h_0().min_w_0().flex();
        if edge.side() {
            content = content.flex_col();
        }
        for (index, panel) in ids.iter().copied().enumerate() {
            if index > 0 {
                content = content.child(self.panel_split(edge, ids[index - 1], panel, window, cx));
            }
            let moving = matches!(&self.drag, Some(Drag::Panel { panel: p, moved: true, .. }) if *p == panel);
            let tile = div()
                .id(SharedString::from(format!(
                    "panel-placeholder-{}",
                    panel.key()
                )))
                .relative()
                .flex_1()
                .flex_grow(self.workspace().panels[&panel].weight)
                .min_h_0()
                .min_w_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .border_1()
                .border_color(rgb(if moving { ACCENT } else { DOCK_BORDER }))
                .bg(rgb(if moving { BG } else { PANEL }))
                .cursor(CursorStyle::OpenHand)
                .child(
                    div()
                        .px(px(8.))
                        .truncate()
                        .text_size(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(rgb(MUTED))
                        .child(panel.label()),
                )
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                        this.add_panel_menu = None;
                        this.panel_menu = None;
                        this.drag = Some(Drag::Panel {
                            panel,
                            origin: e.position,
                            pointer: e.position,
                            moved: false,
                            original: this.workspace().clone(),
                            placement: None,
                        });
                        cx.stop_propagation();
                        cx.notify();
                    }),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(4.))
                        .right(px(4.))
                        .flex()
                        .gap(px(2.))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            div()
                                .id(SharedString::from(format!("move-{}", panel.key())))
                                .w(px(22.))
                                .h(px(22.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .text_color(rgb(MUTED))
                                .cursor_pointer()
                                .hover(|s| s.bg(rgb(BG)).text_color(rgb(TEXT)))
                                .child("⋯")
                                .tooltip(|_, cx| cx.new(|_| HeaderTip("Move panel".into())).into())
                                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                    this.add_panel_menu = None;
                                    this.panel_menu = if this.panel_menu == Some(panel) {
                                        None
                                    } else {
                                        Some(panel)
                                    };
                                    cx.notify();
                                })),
                        )
                        .child(
                            self.workspace_button(
                                format!("close-{}", panel.key()),
                                "×",
                                false,
                                WorkspaceCommand::Visibility {
                                    panel,
                                    visible: false,
                                },
                                cx,
                            )
                            .w(px(22.))
                            .h(px(22.))
                            .px(px(0.))
                            .border_0()
                            .bg(rgb(PANEL))
                            .text_color(rgb(MUTED)),
                        ),
                );
            content = content.child(tile);
        }
        let mut surface = div()
            .size_full()
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .gap(px(4.))
            .rounded(px(7.))
            .bg(rgb(BG));
        if ids.is_empty() {
            surface = surface
                .border_1()
                .border_color(rgb(if selected && valid { ACCENT } else { 0x14202a }))
                .items_center()
                .justify_center()
                .child(add);
        } else {
            content = content
                .child(
                    div()
                        .flex_none()
                        .when(edge.side(), |s| s.h(px(4.)).w_full())
                        .when(!edge.side(), |s| s.w(px(4.)).h_full()),
                )
                .child(add);
            surface = surface.child(content);
        }
        if selected {
            surface = surface
                .border_1()
                .border_color(rgb(if valid { ACCENT } else { LINE }));
        }
        let outer = div().flex_none().p(px(2.));
        if edge.side() {
            outer.w(px(extent)).h_full().child(surface)
        } else {
            outer.h(px(extent)).w_full().child(surface)
        }
    }
    fn dock(&self, edge: Edge, extent: f32, window: &Window, cx: &mut Context<Self>) -> Div {
        if self.edit_layout {
            return self.edit_dock(edge, extent, window, cx);
        }
        let w = self.workspace();
        let dock = &w.docks[&edge];
        let ids = w.at(edge);
        let mut surface = div()
            .flex()
            .flex_col()
            .flex_none()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .rounded(px(7.))
            .bg(rgb(PANEL));
        if dock.collapsed {
            // Every panel keeps its own usable compact surface, as in production.
            // The dock is a layout container, not a tab switcher.
            let mut compact = div()
                .flex()
                .items_center()
                .px(px(6.))
                .h(px(36.))
                .w_full()
                .min_w_0()
                .text_size(px(11.));
            for (index, panel) in ids.iter().copied().enumerate() {
                if index > 0 {
                    compact =
                        compact.child(self.panel_split(edge, ids[index - 1], panel, window, cx));
                }
                let content = match panel {
                    PanelId::Sources => div()
                        .flex()
                        .items_center()
                        .w_full()
                        .min_w_0()
                        .gap(px(4.))
                        .child(
                            div()
                                .id("compact-source-scroll")
                                .flex_1()
                                .min_w_0()
                                .overflow_x_scroll()
                                .child(self.source_rows(true, cx)),
                        )
                        .child(self.add_source_button(cx)),
                    PanelId::Scenes => self.scene_rows(true, cx),
                    PanelId::Mixer => self.mixer_channels(true, cx),
                    PanelId::Controls => div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(icon("studio").size(px(15.)).flex_none())
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .child(self.snapshot.project.production.title.clone()),
                        ),
                    PanelId::Timeline => div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(icon("timeline").size(px(15.)).flex_none())
                        .child(
                            self.button(
                                "compact-home",
                                "|◀",
                                false,
                                RoomCommand::Seek { seconds: 0. },
                                cx,
                            )
                            .h(px(26.)),
                        )
                        .child(
                            self.button(
                                "compact-play-normal",
                                if self.snapshot.playing { "Ⅱ" } else { "▶" },
                                self.snapshot.playing,
                                if self.snapshot.playing {
                                    RoomCommand::Pause
                                } else {
                                    RoomCommand::Play
                                },
                                cx,
                            )
                            .h(px(26.)),
                        )
                        .child(div().flex_none().text_color(rgb(MUTED)).child(
                            format!("{:04.1} / {:.0}s", self.snapshot.position,
                            self.snapshot.project.production.sequences["main"].duration.as_f64()),
                        )),
                };
                compact = compact.child(
                    div()
                        .id(SharedString::from(format!("compact-panel-{}", panel.key())))
                        .px(px(3.))
                        .flex_1()
                        .flex_grow(w.panels[&panel].weight)
                        .min_w_0()
                        .h_full()
                        .flex()
                        .items_center()
                        .overflow_x_scroll()
                        .child(content),
                );
            }
            surface = surface.child(compact);
        } else {
            let mut panels = div().flex_1().min_h_0().min_w_0().flex();
            if edge.side() {
                panels = panels.flex_col();
            }
            for (index, panel) in ids.iter().copied().enumerate() {
                if index > 0 {
                    panels =
                        panels.child(self.panel_split(edge, ids[index - 1], panel, window, cx));
                }
                let panel_width = if edge.side() {
                    extent - 4.
                } else {
                    w.panel_spans(edge, f32::from(window.viewport_size().width), false)
                        .into_iter()
                        .find(|(id, _, _)| *id == panel)
                        .map(|(_, _, width)| width)
                        .unwrap_or(200.)
                };
                let shelf = !edge.side() && panel_width >= 360.;
                let body = match panel {
                    PanelId::Sources => self.sources(shelf, !edge.side() && !shelf, cx),
                    PanelId::Mixer => self.mixer(shelf, cx),
                    PanelId::Controls => self.controls(shelf, cx),
                    PanelId::Timeline => self.timeline(window, cx),
                    PanelId::Scenes => self.scenes(shelf, cx),
                };
                panels = panels.child(
                    div()
                        .id(SharedString::from(format!("dock-scroll-{}", panel.key())))
                        .flex_1()
                        .flex_grow(self.workspace().panels[&panel].weight)
                        .min_h_0()
                        .min_w_0()
                        .overflow_y_scroll()
                        .child(body),
                );
            }
            surface = surface.child(panels);
        }
        let resizable = !dock.collapsed || !edge.side();
        let collapsed = dock.collapsed;
        let grip = div()
            .id(SharedString::from(format!("resize-{}", edge.key())))
            .flex_none()
            .bg(rgb(BG))
            .flex()
            .items_center()
            .justify_center()
            .hover(|s| s.bg(rgb(0x29404d)))
            .child(
                div()
                    .rounded_full()
                    .bg(rgb(0x38505c))
                    .w(px(if edge.side() { 2. } else { 28. }))
                    .h(px(if edge.side() { 28. } else { 2. })),
            )
            .tooltip(|_, cx| {
                cx.new(|_| HeaderTip("Click to hide dock · Drag to resize or compact".into()))
                    .into()
            })
            .cursor(if !resizable {
                CursorStyle::PointingHand
            } else if edge.side() {
                CursorStyle::ResizeLeftRight
            } else {
                CursorStyle::ResizeUpDown
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    this.workspace_pending_until = None;
                    this.drag = Some(Drag::DockSize {
                        edge,
                        size: extent,
                        moved: false,
                        collapsed,
                        mouse: if edge.side() {
                            e.position.x.into()
                        } else {
                            e.position.y.into()
                        },
                    });
                    cx.stop_propagation();
                }),
            );
        if edge.side() {
            let content = surface.w(px((extent - DOCK_GAP).max(0.))).h_full();
            let row = div().flex().flex_none().w(px(extent)).min_h_0().h_full();
            if edge == Edge::Left {
                row.child(content).child(grip.w(px(DOCK_GAP)).h_full())
            } else {
                row.child(grip.w(px(DOCK_GAP)).h_full()).child(content)
            }
        } else {
            let content = surface.h(px((extent - DOCK_GAP).max(0.))).w_full();
            let col = div().flex().flex_col().flex_none().h(px(extent)).w_full();
            if edge == Edge::Top {
                col.child(content).child(grip.h(px(DOCK_GAP)).w_full())
            } else {
                col.child(grip.h(px(DOCK_GAP)).w_full()).child(content)
            }
        }
    }
    fn panel_heading(label: impl Into<SharedString>, detail: impl Into<SharedString>) -> Div {
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .min_w_0()
            .h(px(26.))
            .flex_none()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_size(px(12.))
                    .child(label.into()),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(10.))
                    .text_color(rgb(MUTED))
                    .child(detail.into()),
            )
    }
    fn scene_rows(&self, horizontal: bool, cx: &mut Context<Self>) -> Div {
        let project = &self.snapshot.project;
        let entries: Vec<_> = if project.room_scenes.is_empty() {
            vec![("studio".to_owned(), "Studio".to_owned())]
        } else {
            project
                .room_scenes
                .iter()
                .map(|(id, scene)| (id.clone(), scene.name.clone()))
                .collect()
        };
        let mut rows = div().flex().gap(px(5.)).min_w_0();
        if !horizontal {
            rows = rows.flex_col();
        }
        for (id, name) in entries {
            let active = id == project.active_scene;
            let mut chip = self
                .button(
                    &format!("scene-{id}"),
                    name,
                    active,
                    RoomCommand::SceneSelect { id: id.clone() },
                    cx,
                )
                .h(px(30.))
                .min_w_0()
                .gap(px(7.))
                .child(icon("screen").size(px(14.)).flex_none());
            if active {
                chip = chip.child(
                    div()
                        .flex_none()
                        .rounded(px(4.))
                        .px(px(5.))
                        .bg(rgb(ACCENT))
                        .text_color(rgb(0x092119))
                        .text_size(px(9.))
                        .child("On"),
                );
            }
            let scene_id = id.clone();
            chip = chip.child(
                div()
                    .id(SharedString::from(format!("scene-menu-{id}")))
                    .size(px(20.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child("⋯")
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.source_picker_anchor = event.position();
                        this.source_picker = Some(("scene".into(), Some(scene_id.clone())));
                        cx.notify();
                    })),
            );
            rows = rows.child(chip);
        }
        div()
            .flex()
            .items_center()
            .w_full()
            .min_w_0()
            .gap(px(5.))
            .child(
                div()
                    .id("scene-list")
                    .flex_1()
                    .min_w_0()
                    .when(horizontal, |d| d.overflow_x_scroll())
                    .child(rows),
            )
            .child(
                tool(
                    "scene-add",
                    "plus",
                    "Add scene · Copy current setup",
                    false,
                    project.room_scenes.len() < 32,
                )
                .size(px(28.))
                .flex_none()
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    if this.snapshot.project.room_scenes.len() < 32 {
                        this.send(RoomCommand::SceneAdd, cx);
                    }
                })),
            )
    }
    fn scenes(&self, shelf: bool, cx: &mut Context<Self>) -> Div {
        div()
            .w_full()
            .min_w_0()
            .p(px(8.))
            .child(self.scene_rows(shelf, cx))
    }
    fn source_rows(&self, horizontal: bool, cx: &mut Context<Self>) -> Div {
        let s = &self.snapshot;
        let seq = &s.project.production.sequences["main"];
        let mut rows = div().min_w_0().flex().gap(px(5.));
        if !horizontal {
            rows = rows.flex_col();
        }
        for lane in s.project.lanes.iter().filter(|l| l.kind != "graphics") {
            let kind = s
                .project
                .inputs
                .get(&lane.source)
                .map(|b| b.kind.as_str())
                .unwrap_or(&lane.source);
            let (symbol, ready) = match kind {
                "camera" => (
                    "camera",
                    if lane.source == "camera" {
                        s.source_frames[0] > 0 && s.frame_age_ms[0] < 1000.
                    } else {
                        s.input_status
                            .get(&lane.source)
                            .is_some_and(|v| v.frames > 0 && v.age_ms < 1000.)
                    },
                ),
                "screen" => (
                    "screen",
                    s.source_frames[1] > 0 && s.frame_age_ms[1] < 1000.,
                ),
                "movie" => ("studio", s.source_frames[2] > 0),
                "microphone" => (
                    "mic",
                    if lane.source == "microphone" {
                        s.audio_frames > 0
                    } else {
                        s.input_status
                            .get(&lane.source)
                            .is_some_and(|v| v.frames > 0)
                    },
                ),
                _ => ("studio", true),
            };
            let clip = seq
                .placements
                .iter()
                .find(|p| p.source == lane.source)
                .map(|p| p.id.clone());
            let selected = clip.is_some() && s.selected_clip == clip;
            let mut row = div()
                .id(SharedString::from(format!("source-row-{}", lane.id)))
                .h(px(32.))
                .min_w_0()
                .when(horizontal, |d| d.flex_none().max_w(px(240.)))
                .flex()
                .items_center()
                .gap(px(7.))
                .px(px(8.))
                .rounded(px(6.))
                .border_1()
                .border_color(rgb(if selected { 0x387360 } else { 0x1b2b38 }))
                .bg(rgb(if selected { 0x112b24 } else { 0x0a1722 }))
                .cursor_pointer()
                .hover(|d| d.bg(rgb(0x152733)))
                .child(icon(symbol).size(px(15.)).flex_none())
                .child(
                    div()
                        .min_w_0()
                        .when(!horizontal, |d| d.flex_1())
                        .truncate()
                        .text_size(px(12.))
                        .child(lane.label.clone()),
                )
                .child(
                    div()
                        .size(px(4.))
                        .flex_none()
                        .rounded_full()
                        .bg(rgb(if ready { ACCENT } else { 0x52636f })),
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.send(RoomCommand::Select { clip: clip.clone() }, cx)
                }));
            {
                let kind = kind.to_owned();
                let source = lane.source.clone();
                row = row.child(
                    tool(
                        &format!("device-{}", lane.source),
                        "settings",
                        "Source settings",
                        false,
                        true,
                    )
                    .size(px(22.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(
                        move |this, event: &ClickEvent, _, cx| {
                            this.source_picker_anchor = event.position();
                            this.source_picker = Some((kind.clone(), Some(source.clone())));
                            cx.stop_propagation();
                            cx.notify();
                        },
                    )),
                );
            }
            rows = rows.child(row);
        }
        rows
    }
    fn add_source_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        div()
            .id("add-source")
            .size(px(28.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(5.))
            .text_color(rgb(MUTED))
            .text_size(px(18.))
            .cursor_pointer()
            .hover(|d| d.bg(rgb(0x1a2531)).text_color(rgb(TEXT)))
            .child("+")
            .tooltip(|_, cx| cx.new(|_| HeaderTip("Add source".into())).into())
            .on_click(cx.listener(|this, event: &ClickEvent, _, cx| {
                this.source_picker_anchor = event.position();
                this.source_picker = Some((String::new(), None));
                cx.notify();
            }))
    }
    fn import_video(&mut self, cx: &mut Context<Self>) {
        self.source_picker = None;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose a video".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                if let Some(path) = paths.first() {
                    let path = path.clone();
                    let _ = this.update(cx, |this, cx| {
                        this.send(RoomCommand::ImportMov { path }, cx)
                    });
                }
            }
        })
        .detach();
    }
    fn button(
        &self,
        id: &str,
        label: impl Into<SharedString>,
        active: bool,
        command: RoomCommand,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        div()
            .id(SharedString::from(id.to_owned()))
            .h(px(32.))
            .px(px(12.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(7.))
            .border_1()
            .border_color(rgb(if active { ACCENT } else { LINE }))
            .bg(rgb(if active { 0x15382f } else { 0x101c27 }))
            .text_color(rgb(if active { ACCENT } else { TEXT }))
            .text_size(px(12.))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(0x1b2b37)))
            .child(label.into())
            .on_click(
                cx.listener(move |this, _: &ClickEvent, _, cx| this.send(command.clone(), cx)),
            )
    }
    fn toolbar(&self, cx: &mut Context<Self>) -> Div {
        let error = self.last_error.as_ref().or(self.snapshot.error.as_ref());
        let mut bar = div()
            .h(px(48.))
            .flex_none()
            .px(px(12.))
            .flex()
            .items_center()
            .gap(px(7.))
            .bg(rgb(0x040911))
            .border_b_1()
            .border_color(rgb(0x151e29))
            .child(tool(
                "room-home",
                "chevron",
                "Room navigation is not available in Native Dev yet",
                false,
                false,
            ))
            .child(
                tool(
                    "edit-layout",
                    if self.edit_layout { "done" } else { "edit" },
                    if self.edit_layout {
                        "Done editing layout"
                    } else {
                        "Edit room layout · ⌘E"
                    },
                    self.edit_layout,
                    true,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                    this.toggle_edit_layout(cx);
                    window.focus(&this.focus, cx);
                    cx.notify();
                })),
            );
        if self.edit_layout {
            bar = bar.child(
                tool(
                    "panels-menu",
                    "panels",
                    "Add or hide panels",
                    self.header_menu == Some("panels"),
                    true,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.header_menu = if this.header_menu == Some("panels") {
                        None
                    } else {
                        Some("panels")
                    };
                    cx.notify();
                })),
            );
        }
        if !self.edit_layout {
            bar = bar.child(
                div()
                    .id("activity-menu")
                    .h(px(34.))
                    .flex_1()
                    .min_w_0()
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(9.))
                    .cursor_pointer()
                    .text_color(rgb(if error.is_some() { 0xff929d } else { 0x9ba6b6 }))
                    .child(icon("activity"))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(error.cloned().unwrap_or_else(|| {
                                if self.snapshot.recording {
                                    "Recording locally".into()
                                } else {
                                    "Activity".into()
                                }
                            })),
                    )
                    .child(icon("chevron").size(px(12.)))
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.header_menu = if this.header_menu == Some("activity") {
                            None
                        } else {
                            Some("activity")
                        };
                        cx.notify();
                    })),
            );
        } else {
            bar = bar.child(div().flex_1());
        }
        bar.child(tool(
            "guest-link",
            "link",
            "Guest links will return with the native Network integration",
            false,
            false,
        ))
        .child(tool(
            "channels",
            "channels",
            "Channels are not connected in Native Dev yet",
            false,
            false,
        ))
        .child(tool(
            "studio",
            "studio",
            "Studio presentation is not connected in Native Dev yet",
            false,
            false,
        ))
        .child(tool(
            "virtual-camera",
            "camera",
            "Use your output as a webcam anywhere · Native integration coming next",
            false,
            false,
        ))
        .child(div().h(px(20.)).w(px(1.)).mx(px(4.)).bg(rgb(LINE)))
        .child(
            tool(
                "record-menu",
                if self.snapshot.recording {
                    "stop"
                } else {
                    "record"
                },
                if self.snapshot.recording {
                    "Review and stop recording"
                } else {
                    "Record locally"
                },
                self.header_menu == Some("record"),
                true,
            )
            .text_color(rgb(0xff5b68))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.header_menu = if this.header_menu == Some("record") {
                    None
                } else {
                    Some("record")
                };
                cx.notify();
            })),
        )
        .child(
            tool(
                "go-live",
                "live",
                "Streaming destinations are not connected in Native Dev yet",
                false,
                false,
            )
            .bg(rgb(0x241419))
            .text_color(rgb(0x8a515c)),
        )
    }
    fn header_sheet(&self, cx: &mut Context<Self>) -> Div {
        let mode = self.header_menu.unwrap();
        let mut sheet = div()
            .absolute()
            .top(px(48.))
            .w(px(312.))
            .p(px(14.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .rounded(px(10.))
            .bg(rgb(0x0b141f))
            .border_1()
            .border_color(rgb(0x2a394a));
        sheet = if mode == "activity" {
            sheet.left(px(60.))
        } else if mode == "panels" {
            sheet.left(px(94.))
        } else {
            sheet.right(px(12.))
        };
        sheet = sheet.child(
            div()
                .flex()
                .justify_between()
                .items_center()
                .child(div().font_weight(FontWeight::SEMIBOLD).child(match mode {
                    "record" => {
                        if self.snapshot.recording {
                            "Recording in progress"
                        } else {
                            "Ready to record?"
                        }
                    }
                    "panels" => "Room panels",
                    _ => "Room activity",
                }))
                .child(
                    div()
                        .id("close-header-sheet")
                        .px(px(6.))
                        .cursor_pointer()
                        .text_color(rgb(MUTED))
                        .child("×")
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                            this.header_menu = None;
                            cx.notify();
                        })),
                ),
        );
        match mode {
            "panels" => {
                for p in PanelId::ALL {
                    let w = self.workspace();
                    let edge = w.panels[&p].edge;
                    let shown = w.visible(p)
                        && !w.docks[&edge].hidden
                        && !(edge.side() && w.docks[&edge].collapsed);
                    sheet = sheet.child(self.workspace_button(
                        format!("toggle-{}", p.key()),
                        p.label(),
                        shown,
                        if shown {
                            WorkspaceCommand::Visibility {
                                panel: p,
                                visible: false,
                            }
                        } else {
                            WorkspaceCommand::Activate { panel: p }
                        },
                        cx,
                    ));
                }
                sheet = sheet.child(self.workspace_button(
                    "workspace-reset".into(),
                    "Reset room layout",
                    false,
                    WorkspaceCommand::Reset,
                    cx,
                ));
            }
            "record" => {
                let c = &self.snapshot.project.canvas;
                let description = match c.view {
                    CanvasView::Both => format!(
                        "Landscape {} × {} + vertical {} × {}",
                        c.landscape.width, c.landscape.height, c.vertical.width, c.vertical.height
                    ),
                    CanvasView::Landscape => {
                        format!("Landscape · {} × {}", c.landscape.width, c.landscape.height)
                    }
                    CanvasView::Vertical => {
                        format!("Vertical · {} × {}", c.vertical.width, c.vertical.height)
                    }
                };
                sheet = sheet
                    .child(
                        div()
                            .text_color(rgb(MUTED))
                            .text_size(px(11.))
                            .child(description),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
                            .child("Records Live output, even while viewing Preview. Saves to this room’s recording folder."),
                    )
                    .child(
                        self.button(
                            "record-confirm",
                            if self.snapshot.recording {
                                "Stop and save"
                            } else {
                                "Start recording"
                            },
                            true,
                            RoomCommand::Record {
                                enabled: !self.snapshot.recording,
                            },
                            cx,
                        )
                        .on_click(cx.listener(
                            |this, _: &ClickEvent, _, cx| {
                                this.header_menu = None;
                                cx.notify();
                            },
                        )),
                    );
            }
            _ => {
                sheet = sheet.child(
                    div().text_size(px(12.)).child(
                        self.last_error
                            .as_ref()
                            .or(self.snapshot.error.as_ref())
                            .cloned()
                            .unwrap_or_else(|| {
                                if self.snapshot.recording {
                                    "Recording locally. Your output remains live.".into()
                                } else {
                                    "No new room activity.".into()
                                }
                            }),
                    ),
                );
            }
        }
        sheet
    }
    fn sources(&self, shelf: bool, dense: bool, cx: &mut Context<Self>) -> Div {
        div()
            .w_full()
            .min_w_0()
            .p(px(if dense { 6. } else { 8. }))
            .flex()
            .flex_col()
            .gap(px(5.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Sources"),
                    )
                    .child(self.add_source_button(cx)),
            )
            .child(
                div()
                    .id("source-list-scroll")
                    .min_w_0()
                    .overflow_x_scroll()
                    .child(self.source_rows(shelf, cx)),
            )
    }
    fn mixer_channel(&self, source: &str, compact: bool, cx: &mut Context<Self>) -> Div {
        let s = &self.snapshot;
        let Some(lane) = s.project.lanes.iter().find(|l| l.source == source) else {
            return div()
                .text_size(px(11.))
                .text_color(rgb(MUTED))
                .child("No audio sources");
        };
        let peak = if source == "microphone" {
            s.microphone_peak
        } else {
            s.input_status.get(source).map_or(0., |v| v.peak)
        };
        let source = source.to_owned();
        let mute_source = source.clone();
        let drag_source = source.clone();
        let (gain, muted) = self
            .gain_preview
            .as_ref()
            .filter(|(id, _, _, _)| id == &source)
            .map_or((lane.gain, lane.muted), |(_, g, m, _)| (*g, *m));
        let db = if gain <= 0. {
            "−∞ dB".into()
        } else {
            format!("{:+.1} dB", 20. * gain.log10())
        };
        let mute = div()
            .id(SharedString::from(format!("mute-{source}")))
            .h(px(26.))
            .w(px(if compact { 26. } else { 96. }))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .rounded(px(6.))
            .border_1()
            .border_color(rgb(if muted { 0x613d43 } else { LINE }))
            .bg(rgb(if muted { 0x2b1d25 } else { 0x111b25 }))
            .text_color(rgb(if muted { 0xf3a59b } else { TEXT }))
            .text_size(px(11.))
            .cursor_pointer()
            .hover(|d| d.bg(rgb(if muted { 0x402730 } else { 0x1b2b37 })))
            .child(icon(if muted { "mic-off" } else { "mic" }).size(px(15.)))
            .when(!compact, |d| d.child(if muted { "Unmute" } else { "Mute" }))
            .tooltip(move |_, cx| {
                cx.new(move |_| {
                    HeaderTip(
                        if muted {
                            "Unmute microphone"
                        } else {
                            "Mute microphone"
                        }
                        .into(),
                    )
                })
                .into()
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.send(
                    RoomCommand::Gain {
                        source: mute_source.clone(),
                        gain,
                        muted: !muted,
                    },
                    cx,
                );
            }));
        let mut channel = div().flex().flex_none().gap(px(8.));
        let vertical = !compact;
        let span = if vertical { 84. } else { 96. };
        let level = meter_level(peak * gain, muted);
        let mut rail = div()
            .absolute()
            .overflow_hidden()
            .rounded_full()
            .bg(rgb(LINE))
            .when(vertical, |d| {
                d.left(px(9.)).top(px(6.)).w(px(8.)).h(px(84.))
            })
            .when(!vertical, |d| {
                d.left(px(6.)).top(px(9.)).w(px(84.)).h(px(8.))
            });
        // One meter/fader surface. Fixed color zones show headroom; level and
        // handle are separate values inside the same hit target.
        for (offset, length, color) in [
            (0., 0.7, 0x34d6a5),
            (0.7, 0.2, 0xedc25b),
            (0.9, 0.1, 0xff6269),
        ] {
            rail = rail.child(
                div()
                    .absolute()
                    .bg(rgb(color))
                    .when(vertical, |d| {
                        d.bottom(relative(offset)).h(relative(length)).w_full()
                    })
                    .when(!vertical, |d| {
                        d.left(relative(offset)).w(relative(length)).h_full()
                    }),
            );
        }
        rail = rail.child(
            div()
                .absolute()
                .bg(rgb(LINE))
                .when(vertical, |d| d.top_0().w_full().h(relative(1. - level)))
                .when(!vertical, |d| d.right_0().h_full().w(relative(1. - level))),
        );
        let fader = div()
            .id(SharedString::from(format!("gain-{source}")))
            .relative()
            .flex_none()
            .w(px(if vertical { 26. } else { 96. }))
            .h(px(if vertical { 96. } else { 26. }))
            .cursor(if vertical {
                CursorStyle::ResizeUpDown
            } else {
                CursorStyle::ResizeLeftRight
            })
            .child(rail)
            .child(
                div()
                    .absolute()
                    .rounded(px(3.))
                    .bg(rgb(TEXT))
                    .when(vertical, |d| {
                        d.left(px(3.))
                            .top(px((1. - gain / 2.) * 84.))
                            .w(px(20.))
                            .h(px(12.))
                    })
                    .when(!vertical, |d| {
                        d.left(px(gain / 2. * 84.))
                            .top(px(5.))
                            .w(px(12.))
                            .h(px(16.))
                    }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    this.drag = Some(Drag::Gain {
                        start: if vertical {
                            e.position.y.into()
                        } else {
                            e.position.x.into()
                        },
                        gain,
                        muted,
                        vertical,
                        span,
                        source: drag_source.clone(),
                    });
                    cx.stop_propagation();
                }),
            );
        if compact {
            channel = channel
                .items_center()
                .child(mute)
                .child(
                    div()
                        .max_w(px(120.))
                        .min_w_0()
                        .truncate()
                        .text_size(px(11.))
                        .child(lane.label.clone()),
                )
                .child(fader)
                .child(div().text_size(px(10.)).text_color(rgb(MUTED)).child(db));
        } else {
            let full_name = lane.label.clone();
            channel = channel
                .w(px(112.))
                .min_w_0()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .id(SharedString::from(format!("mixer-name-{source}")))
                        .w_full()
                        .min_w_0()
                        .truncate()
                        .text_center()
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(lane.label.clone())
                        .tooltip(move |_, cx| {
                            cx.new(|_| HeaderTip(full_name.clone().into())).into()
                        }),
                )
                .child(div().text_size(px(10.)).text_color(rgb(MUTED)).child(db))
                .child(fader)
                .child(mute);
        }
        channel
    }
    fn mixer_channels(&self, compact: bool, cx: &mut Context<Self>) -> Div {
        let count = self
            .snapshot
            .project
            .lanes
            .iter()
            .filter(|l| l.kind == "audio")
            .count();
        div()
            .flex()
            .gap(px(10.))
            .when(!compact && count == 1, |d| d.w_full().justify_center())
            .children(
                self.snapshot
                    .project
                    .lanes
                    .iter()
                    .filter(|l| l.kind == "audio")
                    .map(|l| self.mixer_channel(&l.source, compact, cx)),
            )
    }
    fn mixer(&self, _shelf: bool, cx: &mut Context<Self>) -> Div {
        div()
            .w_full()
            .min_w_0()
            .p(px(10.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(Self::panel_heading("Audio mixer", "48 kHz"))
            .child(
                div()
                    .id("mixer-channel-scroll")
                    .min_w_0()
                    .overflow_x_scroll()
                    .child(self.mixer_channels(false, cx)),
            )
    }
    fn preview(&self, index: usize, w: f32, h: f32) -> Div {
        let frame = (if self.snapshot.previewing {
            &self.handle.preview_media
        } else {
            &self.handle.media
        })
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.frame(index + 3));
        let mut output = div()
            .w(px(w))
            .h(px(h))
            .bg(rgb(0x03070c))
            .border_1()
            .border_color(rgb(LINE))
            .overflow_hidden();
        if let Some(frame) = frame {
            output = output.child(surface(frame.surface()).w_full().h_full());
        } else {
            output = output.flex().items_center().justify_center().child(
                div()
                    .text_color(rgb(MUTED))
                    .text_size(px(12.))
                    .child("Preparing GPU output…"),
            );
        }
        output
    }
    fn canvas(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let extents = self.dock_extents(window);
        let available_w =
            (f32::from(window.viewport_size().width) - extents[0] - extents[1] - 8.).max(1.);
        let available_h =
            (f32::from(window.viewport_size().height) - 48. - 26. - extents[2] - extents[3] - 54.)
                .max(1.);
        let canvas = &self.snapshot.project.canvas;
        let a0 = canvas.landscape.aspect() as f32;
        let a1 = canvas.vertical.aspect() as f32;
        let h = match canvas.view {
            CanvasView::Both => available_h.min((available_w - 8.).max(1.) / (a0 + a1)),
            CanvasView::Landscape => available_h.min(available_w / a0),
            CanvasView::Vertical => available_h.min(available_w / a1),
        };
        let mut outputs = div()
            .flex()
            .items_start()
            .justify_center()
            .gap(px(8.))
            .flex_1()
            .min_h_0()
            .w_full();
        if canvas.view != CanvasView::Vertical {
            outputs = outputs.child(self.preview(0, h * a0, h));
        }
        if canvas.view != CanvasView::Landscape {
            outputs = outputs.child(self.preview(1, h * a1, h));
        }
        let mut outer = div()
            .relative()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .items_center()
            .p(px(4.))
            .child(outputs)
            .child(self.room_controller(cx));
        if self.quick {
            let size = if self.target == 0 {
                canvas.landscape
            } else {
                canvas.vertical
            };
            let mut quick = div()
                .absolute()
                .bottom(px(62.))
                .w(px(352.))
                .p(px(14.))
                .bg(rgb(0x0a1119))
                .border_1()
                .border_color(rgb(0x3a4b59))
                .rounded(px(10.))
                .shadow_lg()
                .flex()
                .flex_col()
                .gap(px(12.));
            let mut modes = div().flex().gap(px(6.));
            for (label, view) in [
                ("Landscape", CanvasView::Landscape),
                ("Vertical", CanvasView::Vertical),
                ("Both", CanvasView::Both),
            ] {
                modes = modes.child(self.button(
                    &format!("view-{label}"),
                    label,
                    canvas.view == view,
                    RoomCommand::CanvasView { view },
                    cx,
                ));
            }
            quick = quick.child(modes).child(
                div()
                    .text_size(px(10.))
                    .text_color(rgb(MUTED))
                    .child("ROOM OUTPUT SIZE"),
            );
            let mut targets = div().flex().gap(px(6.));
            for (i, label) in ["Landscape", "Vertical"].iter().enumerate() {
                targets = targets.child(
                    div()
                        .id(SharedString::from(format!("size-target-{i}")))
                        .px(px(8.))
                        .py(px(4.))
                        .rounded(px(5.))
                        .bg(rgb(if self.target == i { 0x233d38 } else { BG }))
                        .cursor_pointer()
                        .child(*label)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.target = i;
                            let size = if i == 0 {
                                this.snapshot.project.canvas.landscape
                            } else {
                                this.snapshot.project.canvas.vertical
                            };
                            this.width = size.width.to_string();
                            this.height = size.height.to_string();
                            cx.notify();
                        })),
                );
            }
            quick = quick.child(targets);
            let mut fields = div().flex().items_center().gap(px(8.));
            for (which, value) in [(true, self.width.clone()), (false, self.height.clone())] {
                fields = fields.child(
                    div()
                        .id(if which {
                            "custom-width"
                        } else {
                            "custom-height"
                        })
                        .w(px(90.))
                        .h(px(32.))
                        .px(px(9.))
                        .flex()
                        .items_center()
                        .border_1()
                        .border_color(rgb(if self.field == Some(which) {
                            ACCENT
                        } else {
                            LINE
                        }))
                        .rounded(px(5.))
                        .cursor_text()
                        .child(value)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.field = Some(which);
                            window.focus(&this.focus, cx);
                            cx.notify();
                        })),
                );
            }
            fields = fields.child(
                div()
                    .id("apply-size")
                    .h(px(32.))
                    .px(px(10.))
                    .bg(rgb(0x1b4537))
                    .rounded(px(5.))
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .child("Apply")
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.apply_size(cx))),
            );
            quick = quick
                .child(fields)
                .child(
                    div()
                        .flex()
                        .gap(px(6.))
                        .child(
                            self.button(
                                "size-square",
                                "1080 square",
                                size.width == 1080 && size.height == 1080,
                                RoomCommand::CanvasSize {
                                    target: if self.target == 0 {
                                        "landscape"
                                    } else {
                                        "vertical"
                                    }
                                    .into(),
                                    width: 1080,
                                    height: 1080,
                                },
                                cx,
                            ),
                        )
                        .child(
                            self.button(
                                "size-default",
                                "1080 default",
                                false,
                                RoomCommand::CanvasSize {
                                    target: if self.target == 0 {
                                        "landscape"
                                    } else {
                                        "vertical"
                                    }
                                    .into(),
                                    width: if self.target == 0 { 1920 } else { 1080 },
                                    height: if self.target == 0 { 1080 } else { 1920 },
                                },
                                cx,
                            ),
                        ),
                )
                .child(
                    div()
                        .text_size(px(10.))
                        .text_color(rgb(MUTED))
                        .child("Only this room. Sets adapt to these dimensions."),
                );
            outer = outer.child(quick);
        }
        outer
    }
    fn room_controller(&self, cx: &mut Context<Self>) -> Div {
        let mic = self
            .snapshot
            .project
            .lanes
            .iter()
            .find(|l| l.source == "microphone");
        let mic_ready = self.snapshot.audio_frames > 0;
        let mic_muted = mic.is_some_and(|l| l.muted);
        let mic_command = if mic_ready {
            RoomCommand::Gain {
                source: "microphone".into(),
                gain: mic.map_or(1., |l| l.gain),
                muted: !mic_muted,
            }
        } else {
            RoomCommand::Capture {
                camera: false,
                screen: false,
                mic: true,
            }
        };
        let circle = |id: &str, name: &str, hint: &str, active: bool| {
            tool(id, name, hint, active, true)
                .size(px(34.))
                .rounded_full()
        };
        div()
            .h(px(42.))
            .mt(px(4.))
            .px(px(5.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(5.))
            .rounded_full()
            .bg(rgb(0x05090e))
            .border_1()
            .border_color(rgb(0x202932))
            .child(
                circle(
                    "room-microphone",
                    "mic",
                    if !mic_ready {
                        "Enable microphone"
                    } else if mic_muted {
                        "Unmute microphone"
                    } else {
                        "Mute microphone"
                    },
                    mic_ready && !mic_muted,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.send(mic_command.clone(), cx)
                })),
            )
            .child(
                circle(
                    "room-camera",
                    "camera",
                    "Connect camera",
                    self.snapshot.source_frames[0] > 0,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.send(
                        RoomCommand::Capture {
                            camera: true,
                            screen: false,
                            mic: false,
                        },
                        cx,
                    )
                })),
            )
            .child(
                circle(
                    "room-screen",
                    "screen",
                    "Share your screen",
                    self.snapshot.source_frames[1] > 0,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.send(
                        RoomCommand::Capture {
                            camera: false,
                            screen: true,
                            mic: false,
                        },
                        cx,
                    )
                })),
            )
            .child(
                circle(
                    "canvas-options",
                    "settings",
                    "Room output · Orientation and dimensions",
                    self.quick,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.quick = !this.quick;
                    this.header_menu = None;
                    this.field = None;
                    let size = if this.target == 0 {
                        this.snapshot.project.canvas.landscape
                    } else {
                        this.snapshot.project.canvas.vertical
                    };
                    this.width = size.width.to_string();
                    this.height = size.height.to_string();
                    cx.notify();
                })),
            )
            .child(
                div().flex().gap(px(2.)).children([
                    self.button(
                        "monitor-live",
                        "Live",
                        !self.snapshot.previewing,
                        RoomCommand::Monitor { preview: false },
                        cx,
                    )
                    .h(px(26.))
                    .px(px(8.)),
                    self.button(
                        "monitor-preview",
                        "Preview",
                        self.snapshot.previewing,
                        RoomCommand::Monitor { preview: true },
                        cx,
                    )
                    .h(px(26.))
                    .px(px(8.)),
                ]),
            )
            .child(
                circle(
                    "room-record",
                    "record",
                    if self.snapshot.recording {
                        "Review and stop recording"
                    } else {
                        "Record live output · Preview stays private"
                    },
                    self.snapshot.recording,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.header_menu = if this.header_menu == Some("record") {
                        None
                    } else {
                        Some("record")
                    };
                    this.quick = false;
                    this.source_picker = None;
                    cx.notify();
                })),
            )
    }
    fn apply_size(&mut self, cx: &mut Context<Self>) {
        match (self.width.parse(), self.height.parse()) {
            (Ok(width), Ok(height)) => self.send(
                RoomCommand::CanvasSize {
                    target: if self.target == 0 {
                        "landscape"
                    } else {
                        "vertical"
                    }
                    .into(),
                    width,
                    height,
                },
                cx,
            ),
            _ => self.last_error = Some("Enter width and height in pixels".into()),
        };
        self.field = None;
    }
    fn controls(&self, _shelf: bool, cx: &mut Context<Self>) -> Div {
        let s = &self.snapshot;
        let mounted = s.project.mounted_set.as_deref();
        let label = if s.program_kind == "timeline" {
            "Timeline on output"
        } else if mounted.is_some() {
            "Set on output"
        } else {
            "Room scene"
        };
        let mut body = div()
            .w_full()
            .min_w_0()
            .p(px(10.))
            .flex()
            .flex_col()
            .gap(px(9.))
            .child(Self::panel_heading("Set Controls", label));
        if mounted.is_some() || s.program_kind == "timeline" {
            body = body.child(self.button(
                "unmount-set",
                "Show room scene",
                false,
                RoomCommand::SetMount { id: None },
                cx,
            ));
        }
        body = body.child(
            div()
                .text_size(px(10.))
                .text_color(rgb(MUTED))
                .child("YOUR SETS"),
        );
        for id in s
            .project
            .production
            .sets
            .keys()
            .filter(|id| id.as_str() != "room-scene")
        {
            let active = mounted == Some(id.as_str()) && s.program_kind == "set";
            let name = if id == &s.project.scene {
                s.project.production.title.clone()
            } else {
                id.clone()
            };
            body = body.child(self.button(
                &format!("mount-set-{id}"),
                format!("{}{}", if active { "●  " } else { "" }, name),
                active,
                RoomCommand::SetMount {
                    id: Some(id.clone()),
                },
                cx,
            ));
        }
        body
    }
    fn timeline_tools(&self, shelf: bool, cx: &mut Context<Self>) -> Div {
        let s = &self.snapshot;
        let mut body = div()
            .w_full()
            .min_w_0()
            .p(px(10.))
            .flex()
            .flex_col()
            .gap(px(9.));
        let mut content = div().flex().min_w_0().gap(px(12.));
        content = if shelf {
            content.flex_row()
        } else {
            content.flex_col()
        };
        let mut layout = div().min_w_0().flex_1().flex().flex_col().gap(px(8.));
        if let Some(id) = &s.selected_clip {
            if let Some(p) = s.project.production.sequences["main"]
                .placements
                .iter()
                .find(|p| &p.id == id)
            {
                layout=layout.child(div().border_t_1().border_color(rgb(LINE)).pt(px(14.)).flex().flex_col().gap(px(8.))
                .child(div().font_weight(FontWeight::SEMIBOLD).child(id.clone()))
                .child(format!("Start {:0.2}s  ·  Length {:0.2}s",p.range.start.as_f64(),p.range.duration.as_f64()))
                .child(div().text_size(px(11.)).text_color(rgb(MUTED)).child("Drag either clip handle to trim. Use the CLI to reposition individual clips.")));
            }
        }
        let mut record=div().min_w_0().flex_1().flex().flex_col().gap(px(7.))
            .child(div().text_color(rgb(MUTED)).text_size(px(10.)).child("RECORD ORIGINALS · OPTIONAL"))
            .child(div().text_color(rgb(MUTED)).text_size(px(11.)).child("Separate source takes. Mic original includes audio even when its output fader is muted."));
        let mut original_buttons = div().flex().flex_wrap().gap(px(4.));
        for (id, label, value, options) in [
            (
                "original-camera",
                "Camera",
                s.originals.camera,
                RoomCommand::RecordOriginals {
                    camera: !s.originals.camera,
                    screen: s.originals.screen,
                    microphone: s.originals.microphone,
                },
            ),
            (
                "original-screen",
                "Screen",
                s.originals.screen,
                RoomCommand::RecordOriginals {
                    camera: s.originals.camera,
                    screen: !s.originals.screen,
                    microphone: s.originals.microphone,
                },
            ),
            (
                "original-mic",
                "Microphone",
                s.originals.microphone,
                RoomCommand::RecordOriginals {
                    camera: s.originals.camera,
                    screen: s.originals.screen,
                    microphone: !s.originals.microphone,
                },
            ),
        ] {
            original_buttons = original_buttons.child(self.button(
                id,
                format!("{}  {}", if value { "✓" } else { "○" }, label),
                value,
                options,
                cx,
            ));
        }
        record = record.child(original_buttons);
        if !s.take.phase.is_empty() {
            record = record.child(format!("Take · {}", s.take.phase));
            if let Some(head) = &s.take.head {
                if let Ok(end) = head.common_end() {
                    record = record.child(format!("Committed through {:0.2}s", end.as_f64()));
                }
            }
        }
        if let Some(name) = s
            .record_path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
        {
            if s.take
                .head
                .as_ref()
                .and_then(|h| h.tracks.first())
                .is_some_and(Option::is_some)
            {
                record = record.child(self.button(
                    "take-place",
                    "＋ Edit committed take",
                    false,
                    RoomCommand::TakePlace {
                        name: name.into(),
                        track: 0,
                        start: 0.,
                        duration: None,
                        source_in: None,
                    },
                    cx,
                ));
            }
        }
        if !s.take_playback.is_null() {
            record = record
                .child(self.button(
                    "take-refresh",
                    "Refresh committed footage",
                    false,
                    RoomCommand::TakeRefresh,
                    cx,
                ))
                .child(
                    div()
                        .text_size(px(10.))
                        .text_color(rgb(MUTED))
                        .child(format!(
                            "Frozen take · {} decoded frames",
                            s.take_playback["decodedFrames"]
                        )),
                );
            if let Some(error) = s.take_playback["error"].as_str() {
                record = record.child(error.to_owned());
            }
        }
        content = content.child(layout).child(record);
        body = body.child(content).child(
            div()
                .id("panel-diagnostics")
                .flex()
                .gap(px(6.))
                .items_center()
                .py(px(5.))
                .text_size(px(10.))
                .text_color(rgb(MUTED))
                .cursor_pointer()
                .child(if self.diagnostics_open {
                    "⌄ Diagnostics"
                } else {
                    "› Diagnostics"
                })
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.diagnostics_open = !this.diagnostics_open;
                    cx.notify();
                })),
        );
        if self.diagnostics_open {
            body = body.child(
                div()
                    .text_size(px(10.))
                    .text_color(rgb(MUTED))
                    .child(format!(
                        "GPU {} · CPU p99 {:.2} ms · Mic {} · Refused {}",
                        s.render_frames, s.cpu_p99_ms, s.audio_frames, s.refused_frames
                    )),
            );
            for status in &s.native_status {
                if !status.is_empty() {
                    body = body.child(
                        div()
                            .text_size(px(10.))
                            .text_color(rgb(MUTED))
                            .child(status.clone()),
                    );
                }
            }
        }
        body
    }
    fn timeline(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let s = &self.snapshot;
        let seq = &s.project.production.sequences["main"];
        let duration = seq.duration.as_f64();
        let (_, available) = self.timeline_geometry(window);
        let label_width = self.timeline_label_width(window);
        let mut panel = div()
            .h(px(74.
                + s.project.lanes.len() as f32 * 33.
                + if self.timeline_details { 260. } else { 0. }))
            .w_full()
            .min_w_0()
            .flex_none()
            .bg(rgb(0x0d1721))
            .flex()
            .flex_col();
        panel = panel.child(
            div()
                .h(px(42.))
                .px(px(16.))
                .flex()
                .items_center()
                .gap(px(8.))
                .child(self.button(
                    "timeline-home",
                    "|◀",
                    false,
                    RoomCommand::Seek { seconds: 0. },
                    cx,
                ))
                .child(self.button(
                    "timeline-play",
                    if s.playing { "Ⅱ" } else { "▶" },
                    s.playing,
                    if s.playing {
                        RoomCommand::Pause
                    } else {
                        RoomCommand::Play
                    },
                    cx,
                ))
                .child(
                    div()
                        .text_size(px(11.))
                        .child(format!("{:05.2} / {:0.0}s", s.position, duration)),
                )
                .child(div().flex_1())
                .child(
                    self.button(
                        "send-timeline-output",
                        "Send to output",
                        false,
                        RoomCommand::SendToOutput,
                        cx,
                    )
                    .h(px(28.)),
                )
                .child(
                    tool(
                        "timeline-tools",
                        "settings",
                        "Recording originals and committed takes",
                        self.timeline_details,
                        true,
                    )
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.timeline_details = !this.timeline_details;
                        cx.notify();
                    })),
                )
                .when(available >= 400., |d| {
                    d.child(
                        div()
                            .text_color(rgb(MUTED))
                            .text_size(px(10.))
                            .child("Timeline"),
                    )
                })
                .when(self.edit_layout, |row| {
                    row.child(
                        self.button(
                            "timeline-edge",
                            if s.project.workspace.panels[&PanelId::Timeline].edge == Edge::Top {
                                "Dock bottom"
                            } else {
                                "Dock top"
                            },
                            false,
                            RoomCommand::TimelineDock {
                                edge: if s.project.workspace.panels[&PanelId::Timeline].edge
                                    == Edge::Top
                                {
                                    "bottom"
                                } else {
                                    "top"
                                }
                                .into(),
                            },
                            cx,
                        ),
                    )
                }),
        );
        if self.timeline_details {
            panel = panel.child(self.timeline_tools(true, cx));
        }
        let mut ruler = div()
            .id("timeline-ruler")
            .h(px(22.))
            .ml(px(label_width + 24.))
            .mr(px(16.))
            .relative()
            .cursor_pointer()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                    this.drag = Some(Drag::Seek);
                    this.seek_mouse(e.position.x.into(), window, cx);
                }),
            );
        for n in 0..=6 {
            ruler = ruler.child(
                div()
                    .absolute()
                    .left(px((available * n as f32 / 6.
                        - if n == 6 { 22. } else { 0. })
                    .max(0.)))
                    .text_size(px(9.))
                    .text_color(rgb(MUTED))
                    .child(format!("{}s", n as f64 * duration / 6.)),
            );
        }
        panel = panel.child(ruler);
        for lane in &s.project.lanes {
            let color = match lane.kind.as_str() {
                "audio" => 0x265349,
                "graphics" => 0x4d4166,
                _ => 0x29475c,
            };
            let mut track = div()
                .relative()
                .flex_1()
                .h(px(30.))
                .bg(rgb(0x101e2b))
                .rounded(px(4.));
            for p in seq.placements.iter().filter(|p| p.source == lane.source) {
                let (start, length) = match &self.pending_trim {
                    Some(RoomCommand::Trim {
                        clip,
                        start,
                        duration,
                        ..
                    }) if clip == &p.id => (*start, *duration),
                    _ => (p.range.start.as_f64(), p.range.duration.as_f64()),
                };
                let left = (start / duration) as f32 * available;
                let width = (length / duration) as f32 * available;
                let selected = s.selected_clip.as_ref() == Some(&p.id);
                let id = p.id.clone();
                let pc = p.clone();
                let mut clip = div()
                    .id(SharedString::from(format!("clip-{}", p.id)))
                    .absolute()
                    .left(px(left))
                    .top(px(1.))
                    .h(px(27.))
                    .w(px(width.max(12.)))
                    .rounded(px(4.))
                    .bg(rgb(color))
                    .border_1()
                    .border_color(rgb(if selected { ACCENT } else { 0x446077 }))
                    .flex()
                    .items_center()
                    .justify_between()
                    .overflow_hidden()
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.send(
                            RoomCommand::Select {
                                clip: Some(id.clone()),
                            },
                            cx,
                        )
                    }));
                for right in [false, true] {
                    let p = pc.clone();
                    clip = clip.child(
                        div()
                            .id(SharedString::from(format!("trim-{}-{right}", p.id)))
                            .w(px(8.))
                            .h_full()
                            .flex_none()
                            .cursor_col_resize()
                            .bg(rgb(0x708491))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                                    this.drag = Some(Drag::Trim {
                                        clip: p.id.clone(),
                                        start: p.range.start.as_f64(),
                                        duration: p.range.duration.as_f64(),
                                        source_in: p.source_in.as_f64(),
                                        right,
                                        mouse: e.position.x.into(),
                                    });
                                    cx.stop_propagation();
                                }),
                            ),
                    );
                    if !right {
                        clip = clip.child(
                            div()
                                .px(px(5.))
                                .flex_1()
                                .text_size(px(10.))
                                .overflow_hidden()
                                .child(lane.label.clone()),
                        );
                    }
                }
                track = track.child(clip);
            }
            if lane.kind == "graphics" {
                track = track.child(
                    div()
                        .h(px(27.))
                        .px(px(12.))
                        .flex()
                        .items_center()
                        .rounded(px(4.))
                        .bg(rgb(color))
                        .text_size(px(10.))
                        .child("Title · Camera motion"),
                );
            }
            track = track.child(
                div()
                    .absolute()
                    .left(px((s.position / duration) as f32 * available))
                    .w(px(1.))
                    .top_0()
                    .bottom_0()
                    .bg(rgb(ACCENT)),
            );
            panel = panel.child(
                div()
                    .h(px(33.))
                    .px(px(16.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .w(px(label_width))
                            .flex_none()
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
                            .min_w_0()
                            .truncate()
                            .child(format!("{}  {}", lane.id.to_uppercase(), lane.label)),
                    )
                    .child(track),
            );
        }
        panel
    }
    fn timeline_label_width(&self, window: &Window) -> f32 {
        let edge = self.workspace().panels[&PanelId::Timeline].edge;
        let width = self
            .workspace()
            .panel_spans(edge, f32::from(window.viewport_size().width), false)
            .into_iter()
            .find(|(p, _, _)| *p == PanelId::Timeline)
            .map(|(_, _, width)| width)
            .unwrap_or(0.);
        if width - 168. < 400. {
            80.
        } else {
            128.
        }
    }
    fn timeline_geometry(&self, window: &Window) -> (f32, f32) {
        let edge = self.workspace().panels[&PanelId::Timeline].edge;
        let width = f32::from(window.viewport_size().width);
        let (_, offset, width) = self
            .workspace()
            .panel_spans(edge, width, false)
            .into_iter()
            .find(|(p, _, _)| *p == PanelId::Timeline)
            .unwrap_or((PanelId::Timeline, 0., width));
        let label = if width - 168. < 400. { 80. } else { 128. };
        (offset + label + 24., (width - label - 40.).max(1.))
    }
    fn seek_mouse(&mut self, x: f32, window: &Window, cx: &mut Context<Self>) {
        let (left, available) = self.timeline_geometry(window);
        let seconds = ((x - left) / available).clamp(0., 1.) as f64
            * self.snapshot.project.production.sequences["main"]
                .duration
                .as_f64();
        self.send(RoomCommand::Seek { seconds }, cx);
    }
    fn finish_drag(&mut self, cx: &mut Context<Self>) {
        let drag = self.drag.take();
        if let Some(command) = self.pending_gain.take() {
            self.send(command, cx);
            self.last_gain_sent = Instant::now();
        }
        if let Some(Drag::DockSize {
            edge, moved: false, ..
        }) = drag
        {
            self.workspace_preview = None;
            self.send(
                RoomCommand::Workspace {
                    command: WorkspaceCommand::HideDock { edge, hidden: true },
                },
                cx,
            );
            return;
        }
        if let Some(Drag::Panel {
            panel,
            moved,
            placement,
            ..
        }) = drag
        {
            // Cancel the local preview before committing exactly one operation.
            self.workspace_preview = None;
            self.workspace_pending_until = None;
            self.drop_edge = None;
            if moved {
                if let Some((edge, before)) = placement {
                    self.send(
                        RoomCommand::Workspace {
                            command: WorkspaceCommand::Place {
                                panel,
                                edge,
                                before,
                            },
                        },
                        cx,
                    );
                }
            }
            cx.notify();
            return;
        }
        if let Some(preview) = self.workspace_preview.take() {
            if let Some(Drag::PanelSplit { first, second, .. }) = drag {
                let a = preview.panels[&first].weight;
                let b = preview.panels[&second].weight;
                self.send(
                    RoomCommand::Workspace {
                        command: WorkspaceCommand::ResizeSplit {
                            first,
                            second,
                            ratio: a / (a + b),
                        },
                    },
                    cx,
                );
            } else if let Some(Drag::DockSize { edge, .. }) = drag {
                self.send(
                    RoomCommand::Workspace {
                        command: WorkspaceCommand::ResizeDock {
                            edge,
                            size: preview.docks[&edge].size,
                            collapsed: preview.docks[&edge].collapsed,
                        },
                    },
                    cx,
                );
            } else {
                self.workspace_preview = Some(preview);
            }
        }
        if let Some(command) = self.pending_trim.take() {
            self.send(command, cx);
        }
        cx.notify();
    }
    fn mouse_move(&mut self, e: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if e.pressed_button != Some(MouseButton::Left) && self.drag.is_some() {
            self.finish_drag(cx);
            return;
        }
        self.drag_position(e.position, window, cx);
    }
    fn drag_position(&mut self, position: Point<Pixels>, window: &Window, cx: &mut Context<Self>) {
        let x: f32 = position.x.into();
        let y: f32 = position.y.into();
        // A short click toggles the dock; crossing this threshold commits to a resize
        // even if the pointer returns to its starting point before release.
        if let Some(Drag::DockSize {
            edge, mouse, moved, ..
        }) = &mut self.drag
        {
            let current: f32 = if edge.side() {
                position.x.into()
            } else {
                position.y.into()
            };
            *moved |= (current - *mouse).abs() >= 3.;
        }
        if let Some(Drag::Panel {
            origin,
            pointer,
            moved,
            ..
        }) = &mut self.drag
        {
            *pointer = position;
            let dx: f32 = (position.x - origin.x).into();
            let dy: f32 = (position.y - origin.y).into();
            *moved |= dx.abs() + dy.abs() > 8.;
        }
        match &self.drag {
            Some(Drag::PanelSplit {
                edge,
                first,
                second,
                ratio,
                span,
                mouse,
            }) => {
                let current: f32 = if edge.side() {
                    position.y.into()
                } else {
                    position.x.into()
                };
                let min = (64. / span.max(1.)).clamp(0.05, 0.45);
                let ratio = (ratio + (current - mouse) / span.max(1.)).clamp(min, 1. - min);
                let mut next = self.snapshot.project.workspace.clone();
                if next
                    .apply(WorkspaceCommand::ResizeSplit {
                        first: *first,
                        second: *second,
                        ratio,
                    })
                    .is_ok()
                {
                    self.workspace_preview = Some(next);
                }
                cx.notify();
            }
            Some(Drag::DockSize {
                edge,
                size,
                mouse,
                moved,
                collapsed,
            }) => {
                if !*moved || (*collapsed && edge.side()) {
                    return;
                }
                let edge = *edge;
                let current: f32 = if edge.side() {
                    position.x.into()
                } else {
                    position.y.into()
                };
                let sign = if matches!(edge, Edge::Right | Edge::Bottom) {
                    -1.
                } else {
                    1.
                };
                let command =
                    Workspace::dock_drag(edge, *size, *collapsed, (current - *mouse) * sign);
                let mut next = self.snapshot.project.workspace.clone();
                if next.apply(command).is_ok() {
                    self.workspace_preview = Some(next);
                }
                cx.notify();
            }
            Some(Drag::Panel {
                panel,
                moved,
                original,
                ..
            }) => {
                let width: f32 = window.viewport_size().width.into();
                let height: f32 = window.viewport_size().height.into();
                let extents = original.layout_extents(width, height, true);
                let edge = moved
                    .then(|| Workspace::drop_target(x, y, width, height, extents))
                    .flatten();
                self.drop_edge = edge;
                let placement = edge.filter(|e| panel.accepts(*e)).map(|edge| {
                    let coordinate = if edge.side() {
                        y - 50. - extents[2]
                    } else {
                        x - 2.
                    };
                    let length = if edge.side() {
                        height - 78. - extents[2] - extents[3]
                    } else {
                        width - 4.
                    };
                    (
                        edge,
                        original.insertion_before(*panel, edge, coordinate, length),
                    )
                });
                let mut next = original.clone();
                if let Some((edge, before)) = placement {
                    if next
                        .apply(WorkspaceCommand::Place {
                            panel: *panel,
                            edge,
                            before,
                        })
                        .is_ok()
                    {
                        self.workspace_preview = Some(next);
                    }
                } else {
                    self.workspace_preview = None;
                }
                if let Some(Drag::Panel {
                    placement: target, ..
                }) = &mut self.drag
                {
                    *target = placement;
                }
                cx.notify();
            }

            Some(Drag::Seek) => self.seek_mouse(x, window, cx),
            Some(Drag::Gain {
                start,
                gain,
                muted,
                vertical,
                span,
                source,
            }) => {
                let delta = if *vertical { *start - y } else { x - *start };
                let value = (*gain + delta / *span * 2.).clamp(0., 2.);
                let source = source.clone();
                let muted = *muted;
                self.gain_preview = Some((
                    source.clone(),
                    value,
                    muted,
                    Instant::now() + Duration::from_secs(2),
                ));
                self.pending_gain = Some(RoomCommand::Gain {
                    source,
                    gain: value,
                    muted,
                });
                cx.notify();
            }
            Some(Drag::Trim {
                clip,
                start,
                duration,
                source_in,
                right,
                mouse,
            }) => {
                let total = self.snapshot.project.production.sequences["main"]
                    .duration
                    .as_f64();
                let (_, available) = self.timeline_geometry(window);
                let delta = (x - *mouse) as f64 / available as f64 * total;
                let (new_start, new_duration, new_in) = if *right {
                    (
                        *start,
                        (*duration + delta).clamp(0.05, total - *start),
                        *source_in,
                    )
                } else {
                    let d = delta.clamp(-*start, (*duration - 0.05).min(*source_in));
                    (*start + d, *duration - d, *source_in + d)
                };
                // Preview locally; commit one durable edit when the handle is released.
                self.pending_trim = Some(RoomCommand::Trim {
                    clip: clip.clone(),
                    start: new_start,
                    duration: new_duration,
                    source_in: new_in,
                });
                cx.notify();
            }
            None => {}
        }
    }
}
impl Render for Room {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let error = self
            .last_error
            .as_ref()
            .or(self.snapshot.error.as_ref())
            .cloned();
        let mut root = div()
            .id("native-room")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .bg(rgb(BG))
            .text_color(rgb(TEXT))
            .font_family("Helvetica Neue")
            .text_size(px(12.))
            .flex()
            .flex_col()
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, e: &MouseUpEvent, window, cx| {
                    this.drag_position(e.position, window, cx);
                    this.finish_drag(cx);
                }),
            )
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                let m = &e.keystroke.modifiers;
                if e.keystroke.key == "e" && m.secondary(cx) && !m.alt && !m.shift {
                    this.toggle_edit_layout(cx);
                    cx.stop_propagation();
                    return;
                }
                if e.keystroke.key == "escape" {
                    if this.drag.take().is_some() {
                        this.drop_edge = None;
                        this.workspace_preview = None;
                        this.pending_trim = None;
                        cx.notify();
                        return;
                    }
                    this.drag = None;
                    this.drop_edge = None;
                    this.workspace_preview = None;
                    this.workspace_pending_until = None;
                    this.pending_trim = None;
                    this.panel_menu = None;
                    this.add_panel_menu = None;
                    this.quick = false;
                    this.field = None;
                    this.edit_layout = false;
                    this.header_menu = None;
                    cx.notify();
                    return;
                }
                if let Some(which) = this.field {
                    let value = if which {
                        &mut this.width
                    } else {
                        &mut this.height
                    };
                    let key = &e.keystroke.key;
                    if key == "backspace" {
                        value.pop();
                    } else if key == "enter" {
                        this.apply_size(cx);
                    } else if key.len() == 1
                        && key.bytes().all(|b| b.is_ascii_digit())
                        && value.len() < 5
                    {
                        value.push_str(key);
                    }
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .child(self.toolbar(cx));
        let extents = self.dock_extents(window);
        if extents[2] > 0. {
            root = root.child(self.dock(Edge::Top, extents[2], window, cx));
        }
        let mut middle = div().flex_1().min_h_0().w_full().flex().relative();
        if extents[0] > 0. {
            middle = middle.child(self.dock(Edge::Left, extents[0], window, cx));
        }
        middle = middle.child(self.canvas(window, cx));
        if extents[1] > 0. {
            middle = middle.child(self.dock(Edge::Right, extents[1], window, cx));
        }
        root = root.child(middle);
        if extents[3] > 0. {
            root = root.child(self.dock(Edge::Bottom, extents[3], window, cx));
        }
        // A fully hidden dock leaves only an edge affordance, never a panel rail.
        if !self.edit_layout {
            for edge in Edge::ALL {
                let members = self.workspace().at(edge);
                let dock = &self.workspace().docks[&edge];
                if members.is_empty() || !(dock.hidden || (edge.side() && dock.collapsed)) {
                    continue;
                }
                let bounds = Workspace::restore_bounds(
                    edge,
                    f32::from(window.viewport_size().width),
                    f32::from(window.viewport_size().height),
                    extents,
                );
                let hint = SharedString::from(format!(
                    "Open {} dock · {}",
                    edge.key(),
                    members
                        .iter()
                        .map(|p| p.label())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
                root = root.child(deferred(
                    div()
                        .id(SharedString::from(format!("reopen-dock-{}", edge.key())))
                        .absolute()
                        .left(px(bounds[0]))
                        .top(px(bounds[1]))
                        .w(px(bounds[2]))
                        .h(px(bounds[3]))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(5.))
                        .bg(rgb(0x0e1c27))
                        .cursor_pointer()
                        .hover(|d| d.bg(rgb(0x253c49)))
                        .child(
                            div()
                                .rounded_full()
                                .bg(rgb(0x64818f))
                                .w(px(if edge.side() { 3. } else { 32. }))
                                .h(px(if edge.side() { 32. } else { 3. })),
                        )
                        .tooltip(move |_, cx| cx.new(|_| HeaderTip(hint.clone())).into())
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.send(
                                RoomCommand::Workspace {
                                    command: WorkspaceCommand::Collapse {
                                        edge,
                                        collapsed: false,
                                    },
                                },
                                cx,
                            );
                        })),
                ));
            }
        }
        if let Some(Drag::Panel {
            panel,
            pointer,
            moved: true,
            ..
        }) = &self.drag
        {
            let valid = self.drop_edge.is_some_and(|e| panel.accepts(e));
            let x: f32 = pointer.x.into();
            let y: f32 = pointer.y.into();
            let width: f32 = window.viewport_size().width.into();
            let height: f32 = window.viewport_size().height.into();
            root = root.child(deferred(
                div()
                    .absolute()
                    .left(px((x + 14.).clamp(0., (width - 202.).max(0.))))
                    .top(px((y + 14.).clamp(48., (height - 74.).max(48.))))
                    .w(px(190.))
                    .p(px(12.))
                    .rounded(px(7.))
                    .bg(rgb(PANEL))
                    .border_1()
                    .border_color(rgb(if valid { ACCENT } else { LINE }))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(panel.label()))
                    .child(div().text_size(px(10.)).text_color(rgb(MUTED)).child(
                        match self.drop_edge {
                            Some(e) if valid => format!("Release to place here · {} dock", e.key()),
                            Some(_) => "Timeline needs a top or bottom dock".into(),
                            None => "Drag to a dock · Esc to cancel".into(),
                        },
                    )),
            ));
        }
        if let Some(error) = error {
            root = root.child(
                div()
                    .px(px(16.))
                    .py(px(6.))
                    .bg(rgb(0x35251f))
                    .text_size(px(11.))
                    .text_color(rgb(0xf4b59f))
                    .child(error),
            );
        }
        if let Some(panel) = self.panel_menu.filter(|_| self.edit_layout) {
            let edge = self.workspace().panels[&panel].edge;
            let width = f32::from(window.viewport_size().width);
            let height = f32::from(window.viewport_size().height);
            let length = if edge.side() {
                height - 78. - extents[2] - extents[3]
            } else {
                width - 4.
            };
            let (_, offset, size) = self
                .workspace()
                .panel_spans(edge, length, true)
                .into_iter()
                .find(|(p, _, _)| *p == panel)
                .unwrap_or((panel, 0., 0.));
            let (left, top) = if edge.side() {
                (
                    if edge == Edge::Left {
                        6.
                    } else {
                        width - extents[1] + 6.
                    },
                    48. + extents[2] + offset + 28.,
                )
            } else {
                (
                    offset + size - 176.,
                    if edge == Edge::Top {
                        76.
                    } else {
                        height - 26. - extents[3] + 28.
                    },
                )
            };
            let mut menu = div()
                .absolute()
                .left(px(left.clamp(6., (width - 182.).max(6.))))
                .top(px(top.min(height - 180.).max(48.)))
                .w(px(176.))
                .p(px(8.))
                .flex()
                .flex_col()
                .gap(px(5.))
                .rounded(px(6.))
                .bg(rgb(BG))
                .border_1()
                .border_color(rgb(LINE))
                .child(
                    div()
                        .text_size(px(10.))
                        .text_color(rgb(MUTED))
                        .child(format!("Move {} to", panel.label())),
                );
            for target in Edge::ALL {
                if panel.accepts(target) && target != edge {
                    menu = menu.child(self.workspace_button(
                        format!("move-{}-{}", panel.key(), target.key()),
                        target.key(),
                        false,
                        WorkspaceCommand::Move {
                            panel,
                            edge: target,
                        },
                        cx,
                    ));
                }
            }
            root = root.child(deferred(menu));
        }
        if let Some(edge) = self.add_panel_menu.filter(|_| self.edit_layout) {
            let width = f32::from(window.viewport_size().width);
            let height = f32::from(window.viewport_size().height);
            let existing = self.workspace().at(edge);
            let candidates: Vec<_> = PanelId::ALL
                .into_iter()
                .filter(|p| p.accepts(edge) && !existing.contains(p))
                .collect();
            let (anchor, bounds) =
                self.workspace()
                    .panel_picker(edge, width, height, extents, candidates.len());
            let mut list = div()
                .id("dock-panel-options")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .flex()
                .flex_col();
            for panel in candidates.iter().copied() {
                let state = &self.workspace().panels[&panel];
                let location = if state.visible {
                    format!("Move from {} dock", state.edge.key())
                } else {
                    "Not in room".into()
                };
                let artwork = match panel {
                    PanelId::Sources => "channels",
                    PanelId::Scenes => "studio",
                    PanelId::Mixer => "mixer",
                    PanelId::Controls => "settings",
                    PanelId::Timeline => "timeline",
                };
                list = list.child(
                    div()
                        .id(SharedString::from(format!(
                            "add-{}-{}",
                            edge.key(),
                            panel.key()
                        )))
                        .h(px(44.))
                        .w_full()
                        .flex_none()
                        .px(px(10.))
                        .rounded(px(5.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .cursor_pointer()
                        .hover(|s| s.bg(rgb(0x1b2b37)))
                        .child(icon(artwork).size(px(18.)).flex_none())
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(rgb(TEXT))
                                        .child(panel.label()),
                                )
                                .child(
                                    div()
                                        .text_size(px(10.))
                                        .text_color(rgb(MUTED))
                                        .child(location),
                                ),
                        )
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.send(
                                RoomCommand::Workspace {
                                    command: WorkspaceCommand::Move { panel, edge },
                                },
                                cx,
                            );
                        })),
                );
            }
            if candidates.is_empty() {
                list = list.child(
                    div()
                        .p(px(10.))
                        .text_size(px(11.))
                        .text_color(rgb(MUTED))
                        .child("All available panels are already here."),
                );
            }
            let picker = div()
                .id("dock-panel-picker")
                .absolute()
                .left(px(bounds[0]))
                .top(px(bounds[1]))
                .w(px(bounds[2]))
                .h(px(bounds[3]))
                .p(px(6.))
                .flex()
                .flex_col()
                .rounded(px(9.))
                .bg(rgb(0x111c27))
                .border_1()
                .border_color(rgb(0x344856))
                .shadow_lg()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down_out(cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    let x = f32::from(e.position.x);
                    let y = f32::from(e.position.y);
                    if !(x >= anchor[0]
                        && x <= anchor[0] + anchor[2]
                        && y >= anchor[1]
                        && y <= anchor[1] + anchor[3])
                    {
                        this.add_panel_menu = None;
                        cx.notify();
                    }
                }))
                .child(
                    div()
                        .h(px(28.))
                        .flex_none()
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(format!("Add to {} dock", edge.key())),
                        )
                        .child(
                            div()
                                .id("close-panel-picker")
                                .w(px(22.))
                                .h(px(22.))
                                .rounded(px(4.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_color(rgb(MUTED))
                                .cursor_pointer()
                                .hover(|s| s.bg(rgb(LINE)).text_color(rgb(TEXT)))
                                .child("×")
                                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                    this.add_panel_menu = None;
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .h(px(26.))
                        .flex_none()
                        .px(px(10.))
                        .text_size(px(10.))
                        .text_color(rgb(MUTED))
                        .child("Choose a panel to place here"),
                )
                .child(list);
            root = root.child(deferred(picker));
        }
        if let Some((kind, source)) = &self.source_picker {
            let width = f32::from(window.viewport_size().width);
            let height = f32::from(window.viewport_size().height);
            let edge = self.workspace().panels[&PanelId::Sources].edge;
            let menu_width = 300_f32.min((width - 16.).max(1.));
            let menu_height = if kind.is_empty() { 206. } else { 284. };
            let anchor = self.source_picker_anchor;
            let x = f32::from(anchor.x)
                + if edge == Edge::Right {
                    -menu_width - 12.
                } else {
                    12.
                };
            let y = f32::from(anchor.y)
                + if edge == Edge::Bottom {
                    -menu_height - 12.
                } else {
                    12.
                };
            let bounds = [
                x.clamp(8., (width - menu_width - 8.).max(8.)),
                y.clamp(56., (height - menu_height - 34.).max(56.)),
                menu_width,
            ];
            let title = match kind.as_str() {
                "camera" => "Choose camera",
                "microphone" => "Choose microphone",
                "scene" => "Scene",
                _ if source.is_some() => "Source",
                _ => "Add source",
            };
            let mut menu = div()
                .absolute()
                .left(px(bounds[0]))
                .top(px(bounds[1]))
                .w(px(bounds[2]))
                .max_h(px((height - bounds[1] - 34.).max(100.)))
                .p(px(8.))
                .rounded(px(9.))
                .bg(rgb(0x0b151f))
                .border_1()
                .border_color(rgb(LINE))
                .flex()
                .flex_col()
                .gap(px(4.))
                .occlude()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .px(px(6.))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
                        .child(
                            div()
                                .id("close-source-picker")
                                .size(px(24.))
                                .cursor_pointer()
                                .child("×")
                                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                    this.source_picker = None;
                                    cx.notify();
                                })),
                        ),
                );
            if kind.is_empty() {
                for (id, label, symbol) in [
                    ("camera", "Camera", "camera"),
                    ("microphone", "Microphone", "mic"),
                    ("screen", "Screen share", "screen"),
                    ("video", "Video file", "studio"),
                ] {
                    menu = menu.child(
                        div()
                            .id(SharedString::from(format!("source-type-{id}")))
                            .h(px(36.))
                            .px(px(8.))
                            .rounded(px(5.))
                            .flex()
                            .items_center()
                            .gap(px(9.))
                            .cursor_pointer()
                            .hover(|d| d.bg(rgb(0x182a36)))
                            .child(icon(symbol))
                            .child(label)
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| match id {
                                "screen" => {
                                    this.source_picker = None;
                                    this.send(
                                        RoomCommand::Capture {
                                            camera: false,
                                            screen: true,
                                            mic: false,
                                        },
                                        cx,
                                    );
                                }
                                "video" => this.import_video(cx),
                                _ => {
                                    this.source_picker = Some((id.into(), None));
                                    cx.notify();
                                }
                            })),
                    );
                }
            } else if matches!(kind.as_str(), "camera" | "microphone") {
                let devices = if kind == "camera" {
                    &self.snapshot.cameras
                } else {
                    &self.snapshot.microphones
                };
                let mut list = div()
                    .id("input-device-list")
                    .max_h(px(230.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(3.));
                if let Some(devices) = devices.as_array() {
                    for device in devices {
                        let (Some(id), Some(name)) =
                            (device["id"].as_str(), device["name"].as_str())
                        else {
                            continue;
                        };
                        let current = self
                            .snapshot
                            .project
                            .inputs
                            .get(source.as_deref().unwrap_or(""))
                            .is_some_and(|b| b.device == id);
                        let used = self.snapshot.project.inputs.iter().any(|(s, b)| {
                            Some(s) != source.as_ref() && b.kind == *kind && b.device == id
                        }) || (source.as_deref() != Some(kind.as_str())
                            && !self.snapshot.project.inputs.contains_key(kind)
                            && device["default"].as_bool() == Some(true));
                        let id = id.to_owned();
                        let kind = kind.clone();
                        let source = source.clone();
                        list = list.child(
                            div()
                                .id(SharedString::from(format!("input-device-{id}")))
                                .min_h(px(40.))
                                .px(px(8.))
                                .py(px(5.))
                                .rounded(px(5.))
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(8.))
                                .text_color(rgb(if used { MUTED } else { TEXT }))
                                .cursor(if used {
                                    CursorStyle::Arrow
                                } else {
                                    CursorStyle::PointingHand
                                })
                                .hover(|d| d.bg(rgb(0x182a36)))
                                .child(div().min_w_0().truncate().child(name.to_owned()))
                                .child(div().text_size(px(10.)).text_color(rgb(MUTED)).child(
                                    if current {
                                        "Current"
                                    } else if used {
                                        "In Sources"
                                    } else {
                                        "Add"
                                    },
                                ))
                                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                    if used {
                                        return;
                                    }
                                    let command = if let Some(source) = &source {
                                        RoomCommand::ConfigureInput {
                                            source: source.clone(),
                                            kind: kind.clone(),
                                            device: id.clone(),
                                        }
                                    } else {
                                        RoomCommand::AddInput {
                                            kind: kind.clone(),
                                            device: id.clone(),
                                        }
                                    };
                                    this.source_picker = None;
                                    this.send(command, cx);
                                })),
                        );
                    }
                }
                menu = menu.child(list);
            }
            if let Some(id) = source {
                let command = if kind == "scene" {
                    RoomCommand::SceneRemove { id: id.clone() }
                } else {
                    RoomCommand::SourceRemove { source: id.clone() }
                };
                let disabled = if kind == "scene" {
                    self.snapshot.project.room_scenes.len() <= 1
                } else {
                    self.snapshot.recording || self.snapshot.take.busy()
                };
                let label = if kind == "scene" {
                    "Remove scene"
                } else {
                    "Remove source"
                };
                menu = menu.child(div().h(px(1.)).my(px(3.)).bg(rgb(LINE))).child(
                    div()
                        .id("remove-room-item")
                        .h(px(32.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .rounded(px(5.))
                        .text_color(rgb(if disabled { MUTED } else { 0xff9b93 }))
                        .cursor(if disabled {
                            CursorStyle::Arrow
                        } else {
                            CursorStyle::PointingHand
                        })
                        .child(if disabled && kind == "scene" {
                            "Keep at least one scene"
                        } else if disabled {
                            "Stop recording to remove source"
                        } else {
                            label
                        })
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            if !disabled {
                                this.source_picker = None;
                                this.send(command.clone(), cx);
                            }
                        })),
                );
            }
            root = root.child(deferred(menu));
        }

        if self.header_menu.is_some() {
            root = root.child(deferred(self.header_sheet(cx)));
        }
        root.child(
            div()
                .h(px(26.))
                .flex_none()
                .px(px(16.))
                .border_t_1()
                .border_color(rgb(LINE))
                .flex()
                .items_center()
                .justify_between()
                .text_size(px(10.))
                .text_color(rgb(MUTED))
                .child("LOCAL / NATIVE DEVELOPMENT")
                .child(format!(
                    "{} · 30 fps outputs · CPU submit p99 {:0.2} ms",
                    if self.snapshot.recording {
                        "● RECORDING"
                    } else {
                        "Idle"
                    },
                    self.snapshot.cpu_p99_ms
                ))
                .child("Metal · GPUI · Rust runtime"),
        )
    }
}

#[cfg(test)]
mod mixer_tests {
    #[test]
    fn meter_has_logarithmic_headroom_and_handles_silence_mute_and_clip() {
        assert_eq!(super::meter_level(0., false), 0.);
        assert_eq!(super::meter_level(1., true), 0.);
        assert_eq!(super::meter_level(f32::NAN, false), 0.);
        assert!((super::meter_level(0.1, false) - 2. / 3.).abs() < 0.0001);
        assert_eq!(super::meter_level(1., false), 1.);
        assert_eq!(super::meter_level(2., false), 1.);
    }
}
