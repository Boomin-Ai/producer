use super::*;
use crate::model::SetLayoutPair;
use producer_production_contract::{Content, Fit, Flow, Node, Rect, Set, Size};
fn node_at_mut<'a>(set: &'a mut Set, layout: &str, path: &[usize]) -> Option<&'a mut Node> {
    let mut node = &mut set.layouts.get_mut(layout)?.root;
    for &index in path {
        node = node.children.get_mut(index)?;
    }
    Some(node)
}

pub(super) fn control_label(id: &str) -> String {
    match id {
        "mov" => "Media".into(),
        "classic-title" => "On-screen title".into(),
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

struct Field {
    path: Vec<usize>,
    label: String,
    input: TextEdit,
}
pub(super) struct Editor {
    id: String,
    saved: Set,
    draft: Set,
    pair: SetLayoutPair,
    output: usize,
    fields: Vec<Field>,
    opened: Instant,
    picker: bool,
    inspect_sources: bool,
    source_picker: Option<Vec<usize>>,
    due: Option<Instant>,
    bounds: crate::engine::SetSlotBounds,
    inflight: Option<mpsc::Receiver<anyhow::Result<serde_json::Value>>>,
    saving: bool,
    ready: bool,
    error: String,
    assistant_draft: bool,
    assistant_saved: bool,
}
impl Editor {
    fn new(id: String, saved: Set, draft: Set, pair: SetLayoutPair) -> Self {
        let mut editor = Self {
            id, saved, draft, pair,
            opened: Instant::now(),
            picker: false,
            inspect_sources: false,
            output: 0,
            fields: vec![],
            source_picker: None,
            due: Some(Instant::now()),
            bounds: Default::default(),
            inflight: None,
            saving: false,
            ready: false,
            error: String::new(),
            assistant_draft: false,
            assistant_saved: false,
        };
        editor.fields();
        editor
    }
    pub(super) fn assistant_review_state(&self) -> Option<serde_json::Value> {
        self.assistant_draft.then(|| json!({
            "set":self.id,"layout":self.pair,"displayed":self.ready.then_some(&self.pair),
            "ready":self.ready,"error":(!self.error.is_empty()).then_some(&self.error)
        }))
    }
    pub(super) fn take_assistant_save(&mut self) -> bool {
        std::mem::take(&mut self.assistant_saved)
    }
    fn fields(&mut self) {
        self.fields.clear();
        self.source_picker = None;
        if let Some(layout) = self.draft.layouts.get(self.pair.ids()[self.output]) {
            visit_layout(&layout.root, &mut vec![], "", &mut |node, path, _| {
                if let Content::Text { value, .. } = &node.content {
                    if !matches!(
                        node.id.as_str(),
                        "camera-placeholder" | "role-label" | "discussion-label"
                    ) {
                        self.fields.push(Field {
                            path: path.into(),
                            label: control_label(&node.id),
                            input: TextEdit::new(value.clone()),
                        });
                    }
                }
            });
        }
    }
    fn changed(&mut self) {
        self.ready = false;
        self.due = Some(Instant::now() + Duration::from_millis(140));
    }
    fn text_changes(&mut self) {
        let layout = self.pair.ids()[self.output];
        let mut changed = false;
        // A field identifies the same authored copy in every shot and output.
        // Unbound copy is shared only by matching nodes in the paired composition.
        let mut edits = Vec::new();
        let selected = &self.draft.layouts[layout];
        for f in &self.fields {
            let mut node = &selected.root;
            let mut path = vec![node.id.clone()];
            for &index in &f.path {
                node = &node.children[index];
                path.push(node.id.clone());
            }
            if matches!(&node.content, Content::Text { value, .. } if value != &f.input.text) {
                let field = node.style.as_ref().and_then(|s| s.text.as_ref()).and_then(|s| s.field.clone());
                edits.push((path, field, f.input.text.clone()));
            }
        }
        fn update(node: &mut Node, path: Option<&[String]>, field: Option<&str>, value: &str) {
            let path = path.and_then(|p| p.split_first()).and_then(|(id, rest)| (id == &node.id).then_some(rest));
            let bound = node.style.as_ref().and_then(|s| s.text.as_ref()).and_then(|s| s.field.as_deref());
            if (field.is_some() && field == bound) || (field.is_none() && path.is_some_and(|p| p.is_empty())) {
                if let Content::Text { value: text, .. } = &mut node.content { value.clone_into(text); }
            }
            for child in &mut node.children { update(child, path, field, value); }
        }
        for (path, field, value) in edits {
            for (id, output) in &mut self.draft.layouts {
                if field.is_some() || self.pair.ids().contains(&id.as_str()) || path.last().is_some_and(|id| id == "classic-title") {
                    update(&mut output.root, Some(&path), field.as_deref(), &value);
                }
            }
            changed = true;
        }
        if changed {
            self.changed();
        }
    }
    fn preview(&self) -> RoomCommand {
        RoomCommand::SetEditPreview {
            id: Some(self.id.clone()),
            draft: Some(self.draft.clone()),
            layout: Some(self.pair.clone()),
        }
    }
    fn run(&mut self, handle: Arc<Handle>, cmd: RoomCommand) {
        let (tx, rx) = mpsc::channel();
        self.inflight = Some(rx);
        std::thread::spawn(move || {
            let result = handle.request(cmd).and_then(|v| {
                anyhow::ensure!(
                    v["ok"] == true,
                    "{}",
                    v["error"].as_str().unwrap_or("Studio rejected edit")
                );
                Ok(v)
            });
            let _ = tx.send(result);
        });
    }
    fn save(&mut self, handle: Arc<Handle>) {
        self.text_changes();
        if self.inflight.is_some() || !self.ready {
            return;
        }
        self.saving = true;
        self.run(
            handle,
            RoomCommand::SetEditSave {
                id: self.id.clone(),
                expected: self.saved.clone(),
                draft: self.draft.clone(),
                layout: Some(self.pair.clone()),
            },
        );
    }
    pub(super) fn tick(&mut self, live: &Live) -> bool {
        if !self.saving {
            self.text_changes();
        }
        if let Some(rx) = &self.inflight {
            match rx.try_recv() {
                Err(mpsc::TryRecvError::Empty) => return false,
                result => {
                    self.inflight = None;
                    match result
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("Editor worker disconnected")))
                    {
                        Ok(_) if self.saving => {
                            self.saved = self.draft.clone();
                            self.error.clear();
                            self.ready = true;
                            self.assistant_saved = self.assistant_draft;
                        }
                        Ok(reply) => {
                            self.bounds =
                                serde_json::from_value(reply["slots"].clone()).unwrap_or_default();
                            self.error.clear();
                            self.ready = self.due.is_none();
                            live.reviewing.store(true, Ordering::Release);
                        }
                        Err(e) => {
                            self.error = e.to_string();
                            self.ready = false;
                        }
                    }
                    self.saving = false;
                }
            }
        }
        if self.due.is_some_and(|at| Instant::now() >= at) {
            self.due = None;
            self.run(live.handle.clone(), self.preview());
        }
        false
    }
}
pub(super) fn open(s: &mut Studio) {
    let Some(l) = &s.live else {
        return;
    };
    let p = &l.snapshot.project;
    let Some((id, pair)) = selection(s, p) else {
        return;
    };
    open_selection(s, id, pair);
}
pub(super) fn selection(
    s: &Studio,
    p: &crate::model::RoomProject,
) -> Option<(String, SetLayoutPair)> {
    if let Some((scene, id, pair)) = &s.set_selection {
        if scene == &p.active_scene && p.set_layout_choices(id).iter().any(|c| c.pair == *pair) {
            return Some((id.clone(), pair.clone()));
        }
    }
    let id = p.mounted_set.as_ref().or_else(|| {
        p.production
            .sets
            .keys()
            .find(|id| id.as_str() != "room-scene")
    })?;
    Some((id.clone(), p.default_set_selection(id)))
}
pub(super) fn open_selection(s: &mut Studio, id: String, pair: SetLayoutPair) {
    let l = s.live.as_ref().unwrap();
    let p = &l.snapshot.project;
    let Some(set) = p.production.sets.get(&id) else {
        return;
    };
    if s.chat.busy() {
        s.error = "The assistant is preparing a draft.".into();
        return;
    }
    s.editor = Some(Editor::new(id, set.clone(), set.clone(), pair));
}

pub(super) fn assistant_draft(live: &Live, id: String, old: Set, draft: Set, pair: SetLayoutPair) -> anyhow::Result<Editor> {
    anyhow::ensure!(live.handle.snapshot().project.production.sets.get(&id) == Some(&old),
        "This set changed. Ask for a fresh draft.");
    let mut editor = Editor::new(id, old, draft, pair);
    editor.assistant_draft = true;
    Ok(editor)
}
pub(super) fn close(s: &mut Studio) {
    if let Some(e) = s.editor.as_mut() {
        e.text_changes();
        if e.saved != e.draft {
            e.error = "Save or discard your changes before closing.".into();
            return;
        }
    }
    if s.editor.as_ref().is_some_and(|e| e.saving) {
        return;
    }
    if let Some(l) = &s.live {
        l.reviewing.store(false, Ordering::Release);
        let _ = l.handle.send(RoomCommand::SetEditPreview {
            id: None,
            draft: None,
            layout: None,
        });
    }
    if let (Some(l), Some(e)) = (&s.live, &s.editor) {
        s.set_selection = (l.snapshot.program_kind != "set").then(|| (
            l.snapshot.project.active_scene.clone(), e.id.clone(), e.pair.clone(),
        ));
    }
    s.editor = None;
}
pub(super) fn back_to_editor(s: &mut Studio) {
    if let Some(editor) = &mut s.editor {
        editor.picker = false;
    }
}

fn modal_frame(width: f32, height: f32, mw: f32, mh: f32, progress: f32, body: El) -> El {
    let frame = col().key("set-editor").role("dialog").label("Set editor")
        .absolute((width - mw) / 2., (height - mh) / 2. + 12. * (1. - progress))
        .opacity(progress).size(mw, mh).radius(14.).clip_rounded(14.)
        .border(1., color(0x354657)).padding(1.).fill(color(PANEL)).hit().child(body);
    el().key("set-modal-backdrop").absolute(0., 0.).size(width, height).hit()
        .backdrop_blur(6.).fill(rune::color::hex("#04070ab0").unwrap()).child(frame)
}

pub(super) fn view(s: &Studio, width: f32, height: f32) -> El {
    let l = s.live.as_ref().unwrap();
    let e = s.editor.as_ref().unwrap();
    let p = &l.snapshot.project;
    let margin = if width < 850. { 16. } else { 48. };
    let mw = (width - margin * 2.).clamp(1., 1250.);
    let mh = (height - margin * 2.).clamp(1., 760.);
    let stacked = mw < 780.;
    let inspector = (mw * 0.29).clamp(240., 324.);
    let progress = 1. - (1. - (e.opened.elapsed().as_secs_f32() / 0.24).clamp(0., 1.)).powi(3);
    if e.picker {
        return modal_frame(width, height, mw, mh, progress, super::set_library::view(s, mw - 2., &e.id));
    }
    let mut root = col().w_full().h_full().min_h(0.);
    let mut header = row().gap(8.).px(4.).flex_wrap().items_center()
        .child(title("Set editor", 19., 650., TEXT))
        .child(title(crate::model::set_label(&e.id), 13., 550., MUTED))
        .child(button("set-picker", "Browse sets", false, |s| {
            let e = s.editor.as_mut().unwrap();
            if e.saved == e.draft && !e.saving {
                e.picker = true;
            }
        }).disabled(e.draft != e.saved || e.saving))
        .child(el().grow(1.));
    let mounted = matches!(l.snapshot.program_kind.as_str(), "set" | "show") && p.mounted_set.as_ref() == Some(&e.id)
        && l.snapshot.program_layout.as_ref().unwrap_or(&p.output_layout_pair()) == &e.pair;
    if e.draft != e.saved {
        header = header.child(button("discard-set", "Discard edits", false, |s| {
            let e = s.editor.as_mut().unwrap();
            if !e.saving {
                e.draft = e.saved.clone();
                e.fields();
                e.changed();
            }
        }));
    }
    if e.draft != e.saved {
        header = header.child(button("save-set", "Save set", true, |s| {
            if let (Some(l), Some(e)) = (&s.live, &mut s.editor) {
                e.save(l.handle.clone());
            }
        }).disabled(!e.ready || e.saving));
    }
    header = header.child(title(
        if e.saving {
            "Working…"
        } else if e.draft != e.saved {
            "Unsaved changes"
        } else if mounted {
            "✓ On output"
        } else if e.ready {
            "Private preview"
        } else {
            "Preparing preview"
        },
        11.,
        500.,
        if mounted { MINT } else { MUTED },
    ));
    let mount = RoomCommand::SetMount {
        id: Some(e.id.clone()),
        layout: Some(e.pair.clone()),
    };
    if !mounted {
        header = header.child(command("show-set", "Show on output", true, mount)
            .disabled(!e.ready || e.draft != e.saved || e.saving));
    }
    header = header.child(button("close-editor", "Close", false, close));
    root = root.child(col().padding(12.).child(header));
    let mut layouts = row()
        .key("set-layouts").w_full().h(42.).items_center().px(14.).gap(6.)
        .fill(color(0x101923))
        .child(title("Layout", 11., 550., MUTED));
    for choice in p.draft_layout_choices(&e.id, &e.draft) {
        let pair = choice.pair;
        layouts = layouts.child(button(
            format!("editor-layout-{}", pair.landscape),
            choice.label,
            pair == e.pair,
            move |s| {
                let e = s.editor.as_mut().unwrap();
                if e.saving {
                    return;
                }
                e.text_changes();
                e.pair = pair.clone();
                e.fields();
                e.changed();
            },
        ));
    }
    let mut center = col().min_w(0.).min_h(0.).fill(color(BG));
    let ratios = [
        p.canvas.landscape.width as f32 / p.canvas.landscape.height.max(1) as f32,
        p.canvas.vertical.width as f32 / p.canvas.vertical.height.max(1) as f32,
    ];
    let preview_width = if stacked { mw } else { mw - inspector };
    let h = ((preview_width - 50.).max(1.) / (ratios[0] + ratios[1]))
        .min((mh * if stacked { 0.31 } else { 0.70 }).max(1.))
        .max(1.);
    let mut monitors = row().gap(12.).padding(12.).self_center();
    for (i, label) in ["Landscape", "Portrait"].iter().enumerate() {
        let mut screen = el()
            .size(h * ratios[i], h)
            .fill(color(PANEL))
            .border(1., color(if e.output == i { MINT } else { MUTED }))
            .native_surface(&l.surfaces[i], SurfaceFit::Fit);
        let layout_id = e.pair.ids()[i];
        if let (Some(layout), Some(bounds)) =
            (e.draft.layouts.get(layout_id), e.bounds.get(layout_id))
        {
            let size = [p.canvas.landscape, p.canvas.vertical][i];
            let sx = h * ratios[i] / size.width.max(1) as f32;
            let sy = h / size.height.max(1) as f32;
            visit_layout(
                &layout.root,
                &mut vec![],
                &layout.root.id,
                &mut |node, path, key| {
                    if matches!(node.content, Content::Source { .. }) {
                        if let Some(rect) = bounds.get(key) {
                            let path = path.to_vec();
                            let selected = i == e.output && e.source_picker.as_ref() == Some(&path);
                            let mut guide = el()
                                .key(format!("guide-{i}-{key}"))
                                .role("button")
                                .label(control_label(&node.id))
                                .absolute(rect.x as f32 * sx, rect.y as f32 * sy)
                                .size(rect.width as f32 * sx, rect.height as f32 * sy);
                            if selected {
                                guide = guide.border(1., color(MINT));
                            }
                            screen = std::mem::replace(&mut screen, el()).child(guide.on_press(
                                move |s: &mut Studio| {
                                    let e = s.editor.as_mut().unwrap();
                                    if !e.saving {
                                        e.text_changes();
                                        if e.output != i {
                                            e.output = i;
                                            e.fields();
                                        }
                                        e.inspect_sources = true;
                                        e.source_picker = Some(path.clone());
                                    }
                                },
                            ));
                        }
                    }
                },
            );
        }
        monitors = monitors.child(
            col()
                .gap(4.)
                .key(format!("editor-output-{i}"))
                .role("button")
                .focusable(true)
                .label(*label)
                .child(screen)
                .child(title(
                    *label,
                    11.,
                    550.,
                    if e.output == i { MINT } else { MUTED },
                ))
                .on_press(move |s: &mut Studio| {
                    let e = s.editor.as_mut().unwrap();
                    if !e.saving && e.output != i {
                        e.text_changes();
                        e.output = i;
                        e.fields();
                    }
                }),
        );
    }
    center = center.center().child(monitors);
    if !e.error.is_empty() {
        root = root.child(title(&e.error, 12., 500., 0xffadb3));
    }
    if e.saving {
        root = root.child(title("Saving…", 12., 500., MUTED));
    }
    let mut fields = col()
        .key("editor-fields")
        .grow(1.)
        .min_h(0.)
        .gap(9.)
        .padding(13.)
        .fill(color(PANEL))
        .child(title("On-screen text", 13., 600., TEXT));
    for (i, f) in e.fields.iter().enumerate() {
        fields = fields.child(
            col()
                .gap(4.)
                .child(title(&f.label, 11., 500., MUTED))
                .child(
                    text_input(&f.input, TextStyle::new(13., 450.))
                        .key(format!("editor-text-{i}"))
                        .label(&*f.label)
                        .h(30.)
                        .w_full()
                        .border(1., color(0x263443))
                        .py(6.)
                        .radius(5.)
                        .px(6.)
                        .fill(color(SURFACE))
                        .color(color(TEXT))
                        .on_edit(move |s: &mut Studio| {
                            &mut s.editor.as_mut().unwrap().fields[i].input
                        }),
                ),
        );
    }
    let mut sources = col()
        .key("set-inspector")
        .w_full()
        .padding(10.)
        .gap(7.)
        .fill(color(PANEL))
        .child(title("Source assignments", 13., 600., TEXT));
    if e.fields.is_empty() {
        fields = fields.child(title("No text fields in this layout", 12., 500., MUTED));
    }
    let layout = e.pair.ids()[e.output];
    if let Some(auth) = e.draft.layouts.get(layout) {
        let mut slots = Vec::new();
        visit_layout(&auth.root, &mut vec![], "", &mut |n, path, _| {
            if let Content::Source { source, fit } = &n.content {
                slots.push((path.to_vec(), control_label(&n.id), source.clone(), *fit))
            }
        });
        if slots.is_empty() {
            sources = sources.child(title("No source slots in this layout", 12., 500., MUTED));
        }
        let has_guest = slots.iter().any(|(_, _, source, _)| source == "rtc-guest")
            || auth.root.children.iter().any(|n| n.id == "stage-guest");
        for (i, (path, label, source, fit)) in slots.into_iter().enumerate() {
            let mut line = col()
                .padding(8.)
                .border(1., color(0x263443))
                .fill(color(0x111b25))
                .radius(7.)
                .gap(5.)
                .child(title(label, 12., 550., MUTED).w(135.));
            let picker = path.clone();
            line = line.child(button(
                format!("editor-slot-{i}"),
                source_name(p, &source),
                false,
                move |s| {
                    let e = s.editor.as_mut().unwrap();
                    e.source_picker = if e.source_picker.as_ref() == Some(&picker) {
                        None
                    } else {
                        Some(picker.clone())
                    };
                },
            ));
            let mut fits = row().gap(3.).flex_wrap();
            for mode in [Fit::Contain, Fit::Cover, Fit::Stretch] {
                let path = path.clone();
                fits = fits.child(button(
                    format!("fit-{i}-{mode:?}"),
                    format!("{mode:?}"),
                    mode == fit,
                    move |s| {
                        let e = s.editor.as_mut().unwrap();
                        if let Some(Node {
                            content: Content::Source { fit, .. },
                            ..
                        }) = node_at_mut(&mut e.draft, e.pair.ids()[e.output], &path)
                        {
                            *fit = mode;
                            e.changed();
                        }
                    },
                ));
            }
            sources = sources.child(line);
            if e.source_picker.as_ref() == Some(&path) {
                let mut choices = col().gap(4.);
                for source in p
                    .production
                    .sources
                    .keys()
                    .filter(|key| key.as_str() != "rtc-guest" && super::set_sources::visual_source(p, key))
                    .map(String::as_str)
                    .chain(std::iter::once("rtc-guest"))
                {
                    let source = source.to_owned();
                    let path = path.clone();
                    choices =
                        choices.child(button(format!("assign-{i}-{source}"), source_name(p, &source), false, {
                            let source = source.to_owned();
                            move |s| {
                                let e = s.editor.as_mut().unwrap();
                                assign_slot(&mut e.draft, e.pair.ids()[e.output], &path, &source);
                                e.source_picker = None;
                                e.changed();
                            }
                        }));
                }
                sources = sources
                    .child(choices)
                    .child(title("Framing", 11., 500., MUTED))
                    .child(fits);
                if path.len() == 1 && auth.root.children[path[0]].id == "stage-guest" {
                    let index = path[0];
                    sources = sources.child(button(
                        "remove-stage-guest",
                        "Remove slot",
                        false,
                        move |s| {
                            let e = s.editor.as_mut().unwrap();
                            if let Some(l) = e.draft.layouts.get_mut(e.pair.ids()[e.output]) {
                                l.root.children.remove(index);
                                if let Flow::Row { sizes, .. } | Flow::Column { sizes, .. } =
                                    &mut l.root.flow
                                {
                                    sizes.remove(index);
                                }
                                e.fields();
                                e.changed();
                            }
                        },
                    ));
                }
            }
        }
        if !has_guest {
            sources = sources.child(button("add-stage-guest", "Add guest slot", false, |s| {
                let e = s.editor.as_mut().unwrap();
                let Some(layout) = e.draft.layouts.get_mut(e.pair.ids()[e.output]) else {
                    return;
                };
                let root = &mut layout.root;
                let frame = match &mut root.flow {
                    Flow::Overlay => Some(Rect {
                        x: layout.width as f64 * 0.08,
                        y: layout.height as f64 * 0.12,
                        width: layout.width as f64 * 0.40,
                        height: layout.height as f64 * 0.60,
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
                    children: vec![],
                    bindings: vec![],
                });
                e.changed();
            }));
        }
    }
    let inspector_tabs = row().items_center().gap(5.).padding(9.)
        .child(button("inspect-content", "Text", !e.inspect_sources, |s| s.editor.as_mut().unwrap().inspect_sources = false))
        .child(button("inspect-sources", "Sources", e.inspect_sources, |s| s.editor.as_mut().unwrap().inspect_sources = true))
        .child(el().grow(1.))
        .child(title(["Landscape", "Portrait"][e.output], 11., 500., MUTED));
    let inspector_body = col().key("editor-inspector").min_h(0.)
        .fill(color(PANEL)).child(inspector_tabs)
        .child(if e.inspect_sources { sources } else { fields }.grow(1.).min_h(0.).scroll(Default::default()));
    root = root.child(layouts.scroll_x());
    root = root.child(if stacked {
        col().grow(1.).min_h(0.).child(center.h(h + 48.).min_h(h + 48.)).child(inspector_body.grow(1.))
    } else {
        row().grow(1.).min_h(0.).child(center.grow(1.)).child(inspector_body.w(inspector))
    });
    modal_frame(width, height, mw, mh, progress, root)
}

pub(super) fn source_name(p: &crate::model::RoomProject, id: &str) -> String {
    if id == "rtc-guest" {
        return "Stage guest".into();
    }
    p.lanes
        .iter()
        .find(|l| l.source == id)
        .map_or_else(|| {
            if let Some(number) = id.strip_prefix("camera-") {
                format!("Camera {number}")
            } else {
                id.into()
            }
        }, |l| l.label.clone())
}

pub(super) fn escape(s: &mut Studio) {
    if let Some(e) = s.editor.as_mut() {
        if e.picker {
            e.picker = false;
            return;
        }
    }
    close(s)
}
