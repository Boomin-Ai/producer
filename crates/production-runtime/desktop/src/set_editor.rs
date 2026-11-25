use super::*;
use crate::{
    engine::SetSlotBounds,
    model::{set_label, SetLayoutPair},
};
use gpui::ImageSource;
use producer_production_contract::{Content, Fit, Flow, Node, Rect, Set, Size};

use super::set_text_field::{Changed, SetTextField};

const OUTPUT_LABELS: [&str; 2] = ["Landscape", "Portrait"];

struct ContentField {
    path: Vec<usize>,
    label: String,
    input: Entity<SetTextField>,
    _subscription: Subscription,
}

pub(super) struct Editor {
    id: String,
    saved: Set,
    draft: Set,
    pair: SetLayoutPair,
    output: usize,
    displayed_pair: Option<SetLayoutPair>,
    selected_slot: Option<Vec<usize>>,
    fields: std::collections::BTreeMap<String, Vec<ContentField>>,
    preview_waiting: bool,
    preview_scheduled: bool,
    picker_open: bool,
    slot_bounds: SetSlotBounds,
    ready: bool,
    busy: bool,
    error: Option<String>,
}

impl Editor {
    pub(super) fn review_state(&self)->serde_json::Value{
        serde_json::json!({"set":self.id,"layout":self.pair,"displayed":self.displayed_pair,"ready":self.ready,"error":self.error})
    }
    fn layout_id(&self) -> &str {
        self.pair.ids()[self.output]
    }
}

fn node_at<'a>(set: &'a Set, layout: &str, path: &[usize]) -> Option<&'a Node> {
    let mut node = &set.layouts.get(layout)?.root;
    for &index in path {
        node = node.children.get(index)?;
    }
    Some(node)
}

fn node_at_mut<'a>(set: &'a mut Set, layout: &str, path: &[usize]) -> Option<&'a mut Node> {
    let mut node = &mut set.layouts.get_mut(layout)?.root;
    for &index in path {
        node = node.children.get_mut(index)?;
    }
    Some(node)
}

fn control_label(id: &str) -> String {
    match id {
        "mov" => "Media".into(),
        "host-camera" => "Host".into(),
        "guest-camera" | "stage-guest" => "Guest".into(),
        _ => id
            .split(['-', '_'])
            .filter(|word| !word.is_empty())
            .map(|word| {
                let mut letters = word.chars();
                match letters.next() {
                    Some(first) => format!("{}{}", first.to_uppercase(), letters.as_str()),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn visit_layout(
    node: &Node,
    path: &mut Vec<usize>,
    key: &str,
    visit: &mut impl FnMut(&Node, &[usize], &str),
) {
    visit(node, path, key);
    for (index, child) in node.children.iter().enumerate() {
        path.push(index);
        visit_layout(child, path, &format!("{key}/{}", child.id), visit);
        path.pop();
    }
}

struct SourceSlot {
    path: Vec<usize>,
    key: String,
    name: String,
    source: String,
    fit: Fit,
}

fn source_slots(root: &Node) -> Vec<SourceSlot> {
    let mut slots = Vec::new();
    visit_layout(root, &mut Vec::new(), &root.id, &mut |node, path, key| {
        if let Content::Source { source, fit } = &node.content {
            slots.push(SourceSlot {
                path: path.to_vec(),
                key: key.to_owned(),
                name: control_label(&node.id),
                source: source.clone(),
                fit: *fit,
            });
        }
    });
    slots
}

fn content_fields(
    set: &Set,
    cx: &mut Context<Room>,
) -> std::collections::BTreeMap<String, Vec<ContentField>> {
    set.layouts
        .iter()
        .map(|(layout, authored)| {
            let root = &authored.root;
            let mut fields = Vec::new();
            visit_layout(root, &mut Vec::new(), &root.id, &mut |node, path, _| {
                let Content::Text { value, .. } = &node.content else {
                    return;
                };
                if matches!(
                    node.id.as_str(),
                    "camera-placeholder" | "role-label" | "discussion-label"
                ) {
                    return;
                }
                let path = path.to_vec();
                let input = cx.new(|cx| SetTextField::new(value.clone(), cx));
                let subscription = cx.subscribe(&input, {
                    let path = path.clone();
                    let layout = layout.clone();
                    move |room, field, _: &Changed, cx| {
                        let value = field.read(cx).value.clone();
                        room.edit_set_text(&layout, &path, &value, cx);
                    }
                });
                fields.push(ContentField {
                    label: control_label(&node.id),
                    path,
                    input,
                    _subscription: subscription,
                });
            });
            (layout.clone(), fields)
        })
        .collect()
}

fn assign_slot(set: &mut Set, layout: &str, path: &[usize], source: &str) {
    fn assign(node: &mut Node, key: &[String], source: &str) {
        match key {
            [] => {
                if let Content::Source {
                    source: binding, ..
                } = &mut node.content
                {
                    *binding = source.to_owned();
                }
            }
            [id, rest @ ..] => {
                if let Some(child) = node.children.iter_mut().find(|child| child.id == *id) {
                    assign(child, rest, source);
                }
            }
        }
    }
    let Some(selected) = set.layouts.get(layout) else {
        return;
    };
    let mut node = &selected.root;
    let mut key = Vec::new();
    for &index in path {
        let Some(child) = node.children.get(index) else {
            return;
        };
        key.push(child.id.clone());
        node = child;
    }
    if !matches!(node.content, Content::Source { .. }) {
        return;
    }
    let root = selected.root.id.clone();
    // A repeated authored slot keeps its source assignment across outputs.
    for layout in set
        .layouts
        .values_mut()
        .filter(|layout| layout.root.id == root)
    {
        assign(&mut layout.root, &key, source);
    }
}

fn blur_room(snapshot: image::RgbaImage) -> Arc<RenderImage> {
    let width = (snapshot.width() / 4).max(1);
    let height = (snapshot.height() / 4).max(1);
    let reduced = image::imageops::resize(
        &snapshot,
        width,
        height,
        image::imageops::FilterType::Triangle,
    );
    let mut blurred = image::imageops::fast_blur(&reduced, 4.0);
    for pixel in blurred.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Arc::new(RenderImage::new([image::Frame::new(blurred)]))
}

impl Room {
    pub(super) fn edit_button(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
    ) -> Stateful<Div> {
        div()
            .id(id.into())
            .min_h(px(32.))
            .px(px(10.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .border_1()
            .border_color(rgb(if selected { ACCENT } else { LINE }))
            .bg(rgb(if selected { 0x15382f } else { 0x101c27 }))
            .cursor_pointer()
            .hover(|d| d.bg(rgb(0x1b2b37)))
            .child(label.into())
    }

    pub(crate) fn begin_set_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((id, pair)) = self.selected_set() else {
            return;
        };
        if self.set_editor.is_some() {
            return;
        }
        let snapshot = window.render_to_image().ok();
        let opened = Instant::now();
        self.set_editor_opened = Some(opened);
        self.focus.focus(window, cx);
        self.open_set_editor_selection(&id, Some(pair), cx);
        if let Some(snapshot) = snapshot {
            cx.spawn(async move |this, cx| {
                let blurred = cx
                    .background_executor()
                    .spawn(async move { blur_room(snapshot) })
                    .await;
                let _ = this.update(cx, |this, cx| {
                    if this.set_editor_opened == Some(opened) {
                        this.set_editor_backdrop = Some(blurred);
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }

    pub(super) fn close_set_picker(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(editor) = self.set_editor.as_mut() else {
            return false;
        };
        if !std::mem::take(&mut editor.picker_open) {
            return false;
        }
        cx.notify();
        true
    }

    pub(super) fn dismiss_set_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.set_editor.as_mut() else {
            return;
        };
        if editor.busy {
            return;
        }
        if editor.saved != editor.draft {
            editor.error = Some("Save or discard your changes before closing.".into());
            cx.notify();
            return;
        }
        if let Some(backdrop) = self.set_editor_backdrop.take() {
            let _ = window.drop_image(backdrop);
        }
        self.set_selection = Some((self.snapshot.project.active_scene.clone(), editor.id.clone(), editor.pair.clone()));
        self.close_set_editor(cx);
    }

    fn close_set_editor(&mut self, cx: &mut Context<Self>) {
        if let Some(backdrop) = self.set_editor_backdrop.take() {
            cx.drop_image(backdrop, None);
        }
        self.set_editor = None;
        self.set_editor_opened = None;
        self.send(
            RoomCommand::SetEditPreview {
                id: None,
                draft: None,
                layout: None,
            },
            cx,
        );
    }

    pub(super) fn open_set_editor(&mut self, id: &str, cx: &mut Context<Self>) {
        self.open_set_editor_selection(id, None, cx);
    }

    pub(super) fn review_assistant_set(&mut self,id:String,old:Set,draft:Set,pair:SetLayoutPair,cx:&mut Context<Self>) -> bool {
        if self.snapshot.project.production.sets.get(&id)!=Some(&old) {
            self.assistant.status="Set changed. Ask for a fresh proposal.".into();
            return false;
        }
        if self.set_editor.as_ref().is_some_and(|e| e.busy || e.saved != e.draft) {
            self.assistant.status="Finish the open set edit before reviewing this proposal.".into();
            return false;
        }
        self.set_editor_opened=Some(Instant::now());
        self.open_set_draft(&id, Some(pair), Some(draft), cx);
        true
    }

    fn open_set_editor_selection(&mut self,id:&str,pair:Option<SetLayoutPair>,cx:&mut Context<Self>) {
        self.open_set_draft(id,pair,None,cx);
    }

    fn open_set_draft(&mut self,id:&str,pair:Option<SetLayoutPair>,proposal:Option<Set>,cx:&mut Context<Self>) {
        if self
            .set_editor
            .as_ref()
            .is_some_and(|e| e.busy || e.saved != e.draft)
        {
            return;
        }
        let Some(set) = self.snapshot.project.production.sets.get(id).cloned() else {
            return;
        };
        let project = &self.snapshot.project;
        let pair = pair.unwrap_or_else(|| project.default_set_selection(id));
        let draft = proposal.unwrap_or_else(||set.clone());
        let fields = content_fields(&draft, cx);
        self.set_editor = Some(Editor {
            id: id.into(),
            saved: set,
            draft,
            pair,
            output: 0,
            displayed_pair: None,
            selected_slot: None,
            fields,
            preview_waiting: false,
            preview_scheduled: false,
            picker_open: false,
            slot_bounds: SetSlotBounds::new(),
            ready: false,
            busy: false,
            error: None,
        });
        self.refresh_set_preview(cx);
    }

    fn run_editor_command(
        &mut self,
        command: RoomCommand,
        cx: &mut Context<Self>,
        on_success: impl FnOnce(&mut Self, serde_json::Value, &mut Context<Self>) + 'static,
    ) {
        let Some(editor) = self.set_editor.as_mut() else {
            return;
        };
        if editor.busy {
            return;
        }
        editor.busy = true;
        editor.error = None;
        let handle = self.handle.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let reply = handle.request(command)?;
                    anyhow::ensure!(
                        reply["ok"] == true,
                        "{}",
                        reply["error"]
                            .as_str()
                            .unwrap_or("The studio could not apply this edit")
                    );
                    Ok::<_, anyhow::Error>(reply)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some(editor) = this.set_editor.as_mut() {
                    editor.busy = false;
                    match result {
                        Ok(reply) => on_success(this, reply, cx),
                        Err(error) => editor.error = Some(error.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn refresh_set_preview(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.set_editor.as_mut() else {
            return;
        };
        if editor.busy {
            editor.preview_waiting = true;
            return;
        }
        editor.preview_waiting = false;
        editor.ready = false;
        let draft = editor.draft.clone();
        let pair = editor.pair.clone();
        let command = RoomCommand::SetEditPreview {
            id: Some(editor.id.clone()),
            draft: Some(draft.clone()),
            layout: Some(pair.clone()),
        };
        self.run_editor_command(command, cx, move |room, reply, _| {
            let editor = room.set_editor.as_mut().unwrap();
            editor.slot_bounds = serde_json::from_value(reply["slots"].clone()).unwrap_or_default();
            editor.ready = editor.draft == draft && editor.pair == pair;
            editor.displayed_pair = Some(pair);
        });
    }

    fn edit_set_text(&mut self, layout: &str, path: &[usize], text: &str, cx: &mut Context<Self>) {
        let Some(editor) = self.set_editor.as_mut() else {
            return;
        };
        let Some(Node {
            content: Content::Text { value, .. },
            ..
        }) = node_at_mut(&mut editor.draft, layout, path)
        else {
            return;
        };
        if value == text {
            return;
        }
        *value = text.to_owned();
        editor.ready = false;
        cx.notify();
        if editor.preview_scheduled {
            return;
        }
        editor.preview_scheduled = true;
        cx.spawn(async move |room, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(140))
                .await;
            let _ = room.update(cx, |room, cx| {
                if let Some(editor) = room
                    .set_editor
                    .as_mut()
                    .filter(|editor| editor.preview_scheduled)
                {
                    editor.preview_scheduled = false;
                    room.refresh_set_preview(cx);
                }
            });
        })
        .detach();
    }

    fn discard_set_edits(&mut self, cx: &mut Context<Self>) {
        let editor = self.set_editor.as_mut().unwrap();
        editor.draft = editor.saved.clone();
        for (layout, fields) in &editor.fields {
            for field in fields {
                if let Some(Node {
                    content: Content::Text { value, .. },
                    ..
                }) = node_at(&editor.draft, layout, &field.path)
                {
                    field
                        .input
                        .update(cx, |input, cx| input.reset(value.clone(), cx));
                }
            }
        }
        self.refresh_set_preview(cx);
    }

    fn update_set_draft(&mut self, change: impl FnOnce(&mut Editor), cx: &mut Context<Self>) {
        let Some(editor) = self.set_editor.as_mut() else {
            return;
        };
        if editor.busy {
            return;
        }
        change(editor);
        self.refresh_set_preview(cx);
    }

    fn slot_source_name(&self, source: &str) -> String {
        if source == "rtc-guest" {
            return "Stage guest".into();
        }
        self.snapshot
            .project
            .lanes
            .iter()
            .find(|lane| lane.source == source)
            .map_or_else(|| source.into(), |lane| lane.label.clone())
    }

    pub(super) fn set_source_summary(&self, id: &str, pair: &SetLayoutPair) -> Option<Div> {
        let set = self.snapshot.project.production.sets.get(id)?;
        let mut visible = Vec::new();
        for key in pair.ids() {
            if let Some(layout) = set.layouts.get(key) {
                for slot in source_slots(&layout.root) {
                    let name = (slot.name, self.slot_source_name(&slot.source));
                    if !visible.contains(&name) {
                        visible.push(name);
                    }
                }
            }
        }
        if visible.is_empty() {
            return None;
        }
        let mut sources = div()
            .flex()
            .flex_col()
            .gap(px(5.))
            .pt(px(8.))
            .border_t_1()
            .border_color(rgb(LINE))
            .child(div().font_weight(FontWeight::SEMIBOLD).child("Sources"));
        for (slot, source) in visible {
            sources = sources.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(6.))
                    .child(div().flex_none().child(slot))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(rgb(MUTED))
                            .child(source),
                    ),
            );
        }
        Some(sources)
    }

    pub(super) fn render_set_editor(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let editor = self.set_editor.as_ref().unwrap();
        let dirty = editor.draft != editor.saved;
        let viewport = window.viewport_size();
        let margin = if f32::from(viewport.width) < 850. {
            16.
        } else {
            48.
        };
        let width = (f32::from(viewport.width) - 2. * margin).clamp(1., 1250.);
        let height = (f32::from(viewport.height) - 2. * margin).clamp(1., 760.);
        let compact = width < 760.;
        let rail_width = if compact {
            (width * 0.19).clamp(78., 114.)
        } else {
            156.
        };
        let inspector_width = if compact {
            (width * 0.31).clamp(135., 208.)
        } else {
            284.
        };
        let center_width = (width - rail_width - inspector_width - 44.).max(1.);
        let on_output = self.snapshot.program_kind == "set"
            && self
                .handle
                .is_set_on_output(&editor.id, &editor.pair, &editor.draft);
        let picker = Self::edit_button("set-editor-set-picker", "", editor.picker_open)
            .debug_selector(|| "set-picker".into())
            .flex_1()
            .min_w_0()
            .justify_between()
            .gap(px(8.))
            .child(div().truncate().child(set_label(&editor.id)))
            .child(icon("chevron").size(px(12.)).flex_none());
        let picker = if dirty || editor.busy {
            picker.opacity(0.56).cursor_default()
        } else {
            picker.on_click(cx.listener(|this, _, _, cx| {
                if let Some(editor) = this.set_editor.as_mut() {
                    editor.picker_open = !editor.picker_open;
                    cx.notify();
                }
            }))
        };
        let mut actions = div().flex().flex_wrap().items_center().gap(px(7.));
        if dirty {
            let reset = Self::edit_button("set-reset", "Discard edits", false);
            let can_save = !editor.busy && editor.ready;
            let save = Self::edit_button("set-save", "Save set", can_save).debug_selector(||"assistant-save".to_string());
            actions = actions
                .child(if editor.busy {
                    reset.opacity(0.52).cursor_default()
                } else {
                    reset.on_click(cx.listener(|this, _, _, cx| {
                        this.discard_set_edits(cx);
                    }))
                })
                .child(if !can_save {
                    save.opacity(0.52).cursor_default()
                } else {
                    save.on_click(cx.listener(|this, _, _, cx| {
                        let editor = this.set_editor.as_ref().unwrap();
                        let saved = editor.draft.clone();
                        this.run_editor_command(
                            RoomCommand::SetEditSave {
                                id: editor.id.clone(),
                                expected: editor.saved.clone(),
                                draft: saved.clone(),
                                layout: Some(editor.pair.clone()),
                            },
                            cx,
                            move |room, _, _| {
                                room.set_editor.as_mut().unwrap().saved = saved;
                            },
                        );
                    }))
                });
        }
        let status = if editor.busy {
            "Working…"
        } else if dirty {
            "Unsaved changes"
        } else if on_output {
            "✓ On output"
        } else if editor.ready {
            "Private preview"
        } else {
            "Preparing preview"
        };
        let can_show = editor.ready && !editor.busy && !dirty && !on_output;
        let show = Self::edit_button("set-to-live", "Show on output", can_show).flex_none();
        let show = if can_show {
            show.on_click(cx.listener(|this, _, _, cx| {
                let editor = this.set_editor.as_ref().unwrap();
                this.run_editor_command(
                    RoomCommand::SetMount {
                        id: Some(editor.id.clone()),
                        layout: Some(editor.pair.clone()),
                    },
                    cx,
                    |_, _, _| {},
                );
            }))
        } else {
            show.opacity(0.48).cursor_default()
        };
        let close = Self::edit_button("close-set-editor", "Close editor", false).flex_none();
        let close = if editor.busy {
            close.opacity(0.52).cursor_default()
        } else {
            close.on_click(cx.listener(|this, _, window, cx| this.dismiss_set_editor(window, cx)))
        };
        let toolbar = div().flex_none().p(px(10.)).child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(10.))
                .px(px(9.))
                .py(px(8.))
                .rounded(px(8.))
                .border_1()
                .border_color(rgb(LINE))
                .bg(rgb(0x131d27))
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w(px((width - 42.).clamp(1., 192.)))
                        .items_center()
                        .gap(px(8.))
                        .child(div().flex_none().text_color(rgb(MUTED)).child("Choose set"))
                        .child(picker),
                )
                .child(
                    actions
                        .child(
                            div()
                                .id("set-output-status")
                                .flex_none()
                                .text_color(rgb(if on_output && !dirty { ACCENT } else { MUTED }))
                                .child(status),
                        )
                        .child(show)
                        .child(close),
                ),
        );

        let heading = |title| {
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title)
        };
        let mut layouts = div()
            .id("set-editor-layouts")
            .w(px(rail_width))
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(7.))
            .p(px(10.))
            .border_r_1()
            .border_color(rgb(LINE))
            .bg(rgb(0x101822))
            .child(heading("Layouts").px(px(3.)).pb(px(3.)));
        for (index, choice) in self
            .snapshot
            .project
            .draft_layout_choices(&editor.id,&editor.draft)
            .into_iter()
            .enumerate()
        {
            let active = choice.pair == editor.pair;
            layouts = layouts.child(
                Self::edit_button(format!("set-layout-{index}"), "", active)
                    .child(div().min_w_0().truncate().child(choice.label))
                    .on_click(cx.listener(move |room, _, window, cx| {
                        let editor = room.set_editor.as_mut().unwrap();
                        if editor.pair != choice.pair {
                            editor.pair = choice.pair.clone();
                            editor.selected_slot = None;
                            room.focus.focus(window, cx);
                            room.refresh_set_preview(cx);
                            cx.notify();
                        }
                    })),
            );
        }

        let canvas = &self.snapshot.project.canvas;
        let sizes = [canvas.landscape, canvas.vertical];
        let aspects = sizes.map(|size| size.aspect() as f32);
        let preview_height = (height * 0.49)
            .max(1.)
            .min((center_width - 12.).max(1.) / (aspects[0] + aspects[1]));
        let mut previews = div().flex().items_center().justify_center().gap(px(12.));
        for (i, (layout_key, label)) in editor.pair.ids().into_iter().zip(OUTPUT_LABELS).enumerate()
        {
            let active = editor.output == i;
            let width = preview_height * aspects[i];
            let mut screen = div()
                .id(format!("set-canvas-{layout_key}"))
                .relative()
                .w(px(width))
                .h(px(preview_height))
                .bg(rgb(BG))
                .rounded(px(6.))
                .border_1()
                .border_color(rgb(if active { ACCENT } else { LINE }))
                .overflow_hidden();
            if let Some(frame) = self
                .handle
                .set_edit_media
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|media| media.frame(3 + i))
                .filter(|_| editor.displayed_pair.as_ref() == Some(&editor.pair))
            {
                screen = screen.child(surface(frame.surface()).size_full());
            }
            if let (Some(layout), Some(bounds)) = (
                editor.draft.layouts.get(layout_key),
                editor.slot_bounds.get(layout_key),
            ) {
                for slot in source_slots(&layout.root) {
                    let Some(rect) = bounds.get(&slot.key) else {
                        continue;
                    };
                    let selected = active && editor.selected_slot.as_ref() == Some(&slot.path);
                    let x = width / sizes[i].width as f32;
                    let y = preview_height / sizes[i].height as f32;
                    let guide = div()
                        .id(format!("guide-{layout_key}-{}", slot.key))
                        .absolute()
                        .left(px(rect.x as f32 * x))
                        .top(px(rect.y as f32 * y))
                        .w(px(rect.width as f32 * x))
                        .h(px(rect.height as f32 * y))
                        .rounded(px(4.))
                        .border_1()
                        .border_color(if selected {
                            rgb(ACCENT)
                        } else {
                            rgba(0x00000000).into()
                        })
                        .hover(|guide| guide.border_color(rgb(ACCENT)))
                        .cursor_pointer()
                        .on_click(cx.listener(move |room, _, _, cx| {
                            let editor = room.set_editor.as_mut().unwrap();
                            editor.output = i;
                            editor.selected_slot = Some(slot.path.clone());
                            cx.stop_propagation();
                            cx.notify();
                        }));
                    screen = screen.child(guide);
                }
            }
            let preview = div()
                .id(format!("set-preview-{layout_key}"))
                .flex()
                .flex_col()
                .gap(px(7.))
                .child(screen)
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(rgb(if active { ACCENT } else { MUTED }))
                        .child(label),
                );
            previews = previews.child(if editor.draft.layouts.contains_key(layout_key) {
                preview
                    .cursor_pointer()
                    .on_click(cx.listener(move |room, _, window, cx| {
                        let editor = room.set_editor.as_mut().unwrap();
                        if editor.output != i {
                            editor.output = i;
                            editor.selected_slot = None;
                            room.focus.focus(window, cx);
                            cx.notify();
                        }
                    }))
            } else {
                preview
            });
        }

        let mut fields = div()
            .id("set-editor-content")
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .gap(px(9.))
            .p(px(13.))
            .border_t_1()
            .border_color(rgb(LINE))
            .bg(rgb(PANEL))
            .overflow_y_scroll()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(heading("Content"))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
                            .child(OUTPUT_LABELS[editor.output]),
                    ),
            );
        let visible_fields = editor
            .fields
            .get(editor.layout_id())
            .map(Vec::as_slice)
            .unwrap_or_default();
        if visible_fields.is_empty() {
            fields = fields.child(
                div()
                    .text_color(rgb(MUTED))
                    .child("No text fields in this layout"),
            );
        }
        for field in visible_fields {
            fields = fields.child(
                div()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
                            .child(field.label.clone()),
                    )
                    .child(field.input.clone()),
            );
        }
        let center = div()
            .id("set-editor-preview")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .bg(rgb(0x0a1018))
            .child(div().flex_none().p(px(12.)).child(previews))
            .child(fields);

        let mut sources = div()
            .id("set-editor-sources")
            .w(px(inspector_width))
            .min_h_0()
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(9.))
            .p(px(11.))
            .border_l_1()
            .border_color(rgb(LINE))
            .bg(rgb(PANEL))
            .overflow_y_scroll()
            .child(heading("Sources"));
        let slots = editor
            .draft
            .layouts
            .get(editor.layout_id())
            .map_or_else(Vec::new, |layout| source_slots(&layout.root));
        if slots.is_empty() {
            sources = sources.child(
                div()
                    .text_color(rgb(MUTED))
                    .child("No source slots in this layout"),
            );
        }
        let mut source_choices = vec!["camera", "screen", "movie", "take", "rtc-guest"];
        source_choices.extend(
            self.snapshot
                .project
                .inputs
                .iter()
                .filter_map(|(id, binding)| {
                    (binding.kind == "camera" && id != "camera").then_some(id.as_str())
                }),
        );
        let has_guest = slots
            .iter()
            .any(|slot| slot.source == "rtc-guest" || slot.key.ends_with("/stage-guest"));
        for slot in slots {
            let selected = editor.selected_slot.as_ref() == Some(&slot.path);
            let path = slot.path.clone();
            let mut card = div()
                .flex_none()
                .flex()
                .flex_col()
                .gap(px(6.))
                .p(px(8.))
                .border_1()
                .rounded(px(7.))
                .border_color(rgb(if selected { 0x42685f } else { LINE }))
                .bg(rgb(0x111b25))
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(slot.name),
                )
                .child(
                    Self::edit_button(format!("set-slot-{}", slot.key), "", selected)
                        .justify_between()
                        .gap(px(6.))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .child(self.slot_source_name(&slot.source)),
                        )
                        .child(icon("chevron").size(px(12.)).flex_none())
                        .on_click(cx.listener(move |room, _, _, cx| {
                            let editor = room.set_editor.as_mut().unwrap();
                            editor.selected_slot = if editor.selected_slot.as_ref() == Some(&path) {
                                None
                            } else {
                                Some(path.clone())
                            };
                            cx.notify();
                        })),
                );
            if selected {
                for id in source_choices.iter().copied().filter(|id| {
                    *id == "rtc-guest" || self.snapshot.project.production.sources.contains_key(*id)
                }) {
                    let path = slot.path.clone();
                    let id = id.to_owned();
                    card = card.child(
                        Self::edit_button(
                            format!("set-source-{id}"),
                            self.slot_source_name(&id),
                            id == slot.source,
                        )
                        .on_click(cx.listener(move |room, _, _, cx| {
                            room.update_set_draft(
                                |e| assign_slot(&mut e.draft, e.pair.ids()[e.output], &path, &id),
                                cx,
                            );
                        })),
                    );
                }
                let mut framing = div().flex().flex_wrap().gap(px(4.));
                for (mode, label) in [
                    (Fit::Contain, "Fit"),
                    (Fit::Cover, "Fill"),
                    (Fit::Stretch, "Stretch"),
                ] {
                    let path = slot.path.clone();
                    framing = framing.child(
                        Self::edit_button(format!("set-fit-{label}"), label, slot.fit == mode)
                            .on_click(cx.listener(move |room, _, _, cx| {
                                room.update_set_draft(
                                    |e| {
                                        if let Some(Node {
                                            content: Content::Source { fit, .. },
                                            ..
                                        }) =
                                            node_at_mut(&mut e.draft, e.pair.ids()[e.output], &path)
                                        {
                                            *fit = mode;
                                        }
                                    },
                                    cx,
                                );
                            })),
                    );
                }
                card = card
                    .child(div().text_color(rgb(MUTED)).child("Framing"))
                    .child(framing);
                if slot.path.len() == 1 && slot.key.ends_with("/stage-guest") {
                    let index = slot.path[0];
                    card = card.child(
                        Self::edit_button("remove-stage-guest", "Remove slot", false).on_click(
                            cx.listener(move |room, _, _, cx| {
                                room.update_set_draft(
                                    |editor| {
                                        let root = &mut editor
                                            .draft
                                            .layouts
                                            .get_mut(&editor.pair.ids()[editor.output].to_owned())
                                            .unwrap()
                                            .root;
                                        root.children.remove(index);
                                        if let Flow::Row { sizes, .. }
                                        | Flow::Column { sizes, .. } = &mut root.flow
                                        {
                                            sizes.remove(index);
                                        }
                                        editor.selected_slot = None;
                                    },
                                    cx,
                                );
                            }),
                        ),
                    );
                }
            }
            sources = sources.child(card);
        }

        if !has_guest {
            sources = sources.child(
                Self::edit_button("add-stage-guest", "Add guest slot", false).on_click(
                    cx.listener(|room, _, _, cx| {
                        room.update_set_draft(
                            |editor| {
                                let layout = editor
                                    .draft
                                    .layouts
                                    .get_mut(&editor.pair.ids()[editor.output].to_owned())
                                    .unwrap();
                                let root = &mut layout.root;
                                let width = layout.width as f64;
                                let height = layout.height as f64;
                                let frame = match &mut root.flow {
                                    Flow::Overlay => Some(Rect {
                                        x: width * 0.08,
                                        y: height * 0.12,
                                        width: width * 0.40,
                                        height: height * 0.60,
                                    }),
                                    Flow::Grid { .. } => None,
                                    Flow::Row { sizes, .. } | Flow::Column { sizes, .. } => {
                                        sizes.push(Size::Weight {
                                            weight: 1.,
                                            min: 1.,
                                            max: 65536.,
                                        });
                                        None
                                    }
                                };
                                root.children.push(Node {
                                    id: "stage-guest".into(),
                                    style: None,
                                    placement: None,
                                    frame,
                                    flow: Default::default(),
                                    content: Content::Source {
                                        source: "rtc-guest".into(),
                                        fit: Fit::Contain,
                                    },
                                    children: Vec::new(),
                                    bindings: Vec::new(),
                                });
                                editor.selected_slot = Some(vec![root.children.len() - 1]);
                            },
                            cx,
                        );
                    }),
                ),
            );
        }

        let mut view = div()
            .id("set-editor-modal")
            .block_mouse_except_scroll()
            .w(px(width))
            .h(px(height))
            .overflow_hidden()
            .flex()
            .flex_col()
            .bg(rgb(PANEL))
            .text_color(rgb(TEXT))
            .text_size(px(12.))
            .rounded(px(14.))
            .border_1()
            .border_color(rgb(0x354657))
            .shadow_2xl()
            .child(toolbar)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(layouts)
                    .child(center)
                    .child(sources),
            );
        if let Some(error) = &editor.error {
            view = view.child(
                div()
                    .px(px(14.))
                    .py(px(8.))
                    .text_color(rgb(0xf3a59b))
                    .child(error.clone()),
            );
        }
        if editor.picker_open {
            let mut choices = div()
                .id("set-picker-menu")
                .absolute()
                .top(px(54.))
                .left(px(14.))
                .w(px((width - 28.).clamp(1., 410.)))
                .max_h(px((height - 68.).clamp(1., 260.)))
                .flex()
                .flex_col()
                .gap(px(4.))
                .p(px(5.))
                .border_1()
                .border_color(rgb(LINE))
                .rounded(px(8.))
                .bg(rgb(0x111c27))
                .shadow_lg()
                .overflow_y_scroll()
                .occlude();
            for id in self
                .snapshot
                .project
                .production
                .sets
                .keys()
                .filter(|id| id.as_str() != "room-scene")
            {
                let id = id.clone();
                let selector = format!("pick-{id}");
                choices = choices.child(
                    Self::edit_button(format!("edit-pick-{id}"), set_label(&id), id == editor.id)
                        .debug_selector(move || selector.clone())
                        .flex_none()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.close_set_picker(cx);
                            if this
                                .set_editor
                                .as_ref()
                                .is_some_and(|editor| editor.id != id)
                            {
                                this.open_set_editor(&id, cx);
                            }
                        })),
                );
            }
            view = view
                .child(
                    div()
                        .id("set-picker-dismiss")
                        .absolute()
                        .inset_0()
                        .occlude()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.close_set_picker(cx);
                        })),
                )
                .child(choices);
        }
        let elapsed = self
            .set_editor_opened
            .map_or(1., |opened| opened.elapsed().as_secs_f32() / 0.24);
        let progress = 1. - (1. - elapsed.clamp(0., 1.)).powi(3);
        if elapsed < 1. {
            window.request_animation_frame();
        }
        let mut overlay = div()
            .id("set-editor-overlay")
            .absolute()
            .inset_0()
            .occlude()
            .flex()
            .justify_center()
            .items_center();
        if let Some(backdrop) = self.set_editor_backdrop.as_ref() {
            overlay = overlay.child(
                img(ImageSource::Render(backdrop.clone()))
                    .absolute()
                    .inset_0()
                    .size_full()
                    .object_fit(ObjectFit::Fill)
                    .opacity(progress),
            );
        }
        overlay
            .child(
                div()
                    .id("set-editor-backdrop")
                    .absolute()
                    .inset_0()
                    .bg(rgba(0x04070ab0).opacity(progress)),
            )
            .child(
                view.relative()
                    .top(px(12. * (1. - progress)))
                    .opacity(progress),
            )
    }
}

#[cfg(test)]
mod restored_room_ui_tests {
    use super::{Room, PanelId, WorkspaceCommand, Edge};
    use gpui::prelude::*;
    use gpui::{px,size,Bounds,WindowBounds,WindowOptions,Modifiers, TestAppContext, VisualTestContext};
    #[test]
    fn bottom_sources_stack_and_orbital_desk_opens_from_the_set_picker() {
        let dir = tempfile::tempdir().unwrap();
        crate::starter_sets::install(dir.path()).unwrap();
        let (handle, _, _) = crate::engine::initial_room(dir.path()).unwrap();
        {
            let mut state = handle.snapshot.lock().unwrap();
            let ws = &mut state.project.workspace;
            ws.apply(WorkspaceCommand::Place {panel:PanelId::Sources, edge: Edge::Bottom, before:None}).unwrap();
            ws.apply(WorkspaceCommand::Activate {panel:PanelId::Sources}).unwrap();
            ws.apply(WorkspaceCommand::Collapse {edge:Edge::Bottom, collapsed:false}).unwrap();
        }
        let app = &mut TestAppContext::single();
        let window = app.update(|cx| cx.open_window(WindowOptions {
            window_bounds:Some(WindowBounds::Windowed(Bounds::centered(None,size(px(1440.),px(820.)),cx))),
            ..Default::default()
        },|_,cx| cx.new(|cx|Room::new(handle,cx)))).unwrap();
        let mut cx=VisualTestContext::from_window(window.into(),app);
        cx.run_until_parked();
        let mut bottom=px(0.);
        for id in ["source-row-v1","source-row-v2","source-row-v3","source-row-a1"] {
            let bounds=cx.debug_bounds(id).unwrap();
            assert!(bounds.origin.y>=bottom,"{id} should be below the previous row");
            assert!(bounds.size.width>px(180.));
            bottom=bounds.origin.y+bounds.size.height;
        }
        let room=window.root(&mut cx).unwrap();
        cx.update(|_,cx|room.update(cx,|r,cx|r.open_set_editor("studio",cx)));
        for id in ["set-picker","pick-orbital-desk"] {
            cx.run_until_parked();
            let center=cx.debug_bounds(id).unwrap_or_else(||panic!("Missing {id}")).center();
            cx.simulate_click(center, Modifiers::default());
        }
        cx.update(|_,cx|assert_eq!(room.read(cx).set_editor.as_ref().unwrap().id,"orbital-desk"));
    }
}
