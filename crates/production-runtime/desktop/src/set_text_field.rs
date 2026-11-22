use super::*;
use producer_production_contract::STRING_BYTES;
use std::ops::Range;

pub(super) struct Changed;
impl EventEmitter<Changed> for SetTextField {}

pub(super) struct SetTextField {
    pub value: String,
    pub composer:bool,
    focus: FocusHandle,
    anchor: usize,
    caret: usize,
    marked: Option<Range<usize>>,
    shape: Option<(Bounds<Pixels>, ShapedLine)>,
    dragging: bool,
}

impl SetTextField {
    pub fn new(value: String, cx: &mut Context<Self>) -> Self {
        let caret = value.len();
        Self {
            value,
            composer:false,
            focus: cx.focus_handle(),
            anchor: caret,
            caret,
            marked: None,
            shape: None,
            dragging: false,
        }
    }

    pub fn reset(&mut self, value: String, cx: &mut Context<Self>) {
        self.value = value;
        self.caret = self.value.len();
        self.anchor = self.caret;
        self.marked = None;
        self.shape = None;
        cx.notify();
    }

    fn selection(&self) -> Range<usize> {
        self.anchor.min(self.caret)..self.anchor.max(self.caret)
    }

    fn select(&mut self, caret: usize, extend: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.caret = caret;
        if !extend {
            self.anchor = caret;
        }
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }

    fn byte_offset(&self, units: usize) -> usize {
        let mut length = 0;
        for (offset, character) in self.value.char_indices() {
            length += character.len_utf16();
            if length > units {
                return offset;
            }
        }
        self.value.len()
    }

    fn utf16_range(&self, range: Range<usize>) -> Range<usize> {
        self.value[..range.start].encode_utf16().count()
            ..self.value[..range.end].encode_utf16().count()
    }

    fn byte_range(&self, range: Range<usize>) -> Range<usize> {
        self.byte_offset(range.start)..self.byte_offset(range.end)
    }

    fn replace(&mut self, range: Range<usize>, text: &str) -> Range<usize> {
        let remaining = STRING_BYTES.saturating_sub(self.value.len() - range.len());
        let end = text.floor_char_boundary(text.len().min(remaining));
        let text = text[..end].replace(['\r', '\n', '\t'], " ");
        self.value.replace_range(range.clone(), &text);
        self.shape = None;
        self.caret = range.start + text.len();
        self.anchor = self.caret;
        range.start..self.caret
    }

    fn replacement_range(&self, range: Option<Range<usize>>) -> Range<usize> {
        range
            .map(|range| self.byte_range(range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection())
    }

    fn moved_left(&self) -> usize {
        self.value[..self.caret]
            .char_indices()
            .next_back()
            .map_or(0, |(index, _)| index)
    }

    fn moved_right(&self) -> usize {
        self.value[self.caret..]
            .chars()
            .next()
            .map_or(self.caret, |ch| self.caret + ch.len_utf8())
    }

    fn index_at(&self, cursor: Point<Pixels>) -> usize {
        self.shape.as_ref().map_or(self.caret, |(bounds, line)| {
            self.value.floor_char_boundary(
                line.closest_index_for_x(cursor.x - bounds.left())
                    .min(self.value.len()),
            )
        })
    }

    fn handle_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        let extend = key.modifiers.shift;
        let selection = self.selection();
        if key.modifiers.secondary(cx) {
            match key.key.as_str() {
                "a" => {
                    self.anchor = 0;
                    self.select(self.value.len(), true, window, cx);
                }
                "c" | "x" => {
                    if !selection.is_empty() {
                        cx.write_to_clipboard(ClipboardItem::new_string(
                            self.value[selection].to_owned(),
                        ));
                        if key.key == "x" {
                            self.replace_text_in_range(None, "", window, cx);
                        }
                    }
                }
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        self.replace_text_in_range(None, &text, window, cx);
                    }
                }
                _ => return,
            }
        } else {
            match key.key.as_str() {
                "left" => self.select(
                    if !extend && !selection.is_empty() {
                        selection.start
                    } else {
                        self.moved_left()
                    },
                    extend,
                    window,
                    cx,
                ),
                "right" => self.select(
                    if !extend && !selection.is_empty() {
                        selection.end
                    } else {
                        self.moved_right()
                    },
                    extend,
                    window,
                    cx,
                ),
                "home" => self.select(0, extend, window, cx),
                "end" => self.select(self.value.len(), extend, window, cx),
                "backspace" | "delete" => {
                    let range = if selection.is_empty() {
                        if key.key == "backspace" {
                            self.moved_left()..self.caret
                        } else {
                            self.caret..self.moved_right()
                        }
                    } else {
                        selection
                    };
                    if !range.is_empty() {
                        self.replace_text_in_range(Some(self.utf16_range(range)), "", window, cx);
                    }
                }
                _ => return,
            }
        }
        cx.stop_propagation();
    }

    fn changed(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.notify_text_input_changed(&self.focus);
        cx.emit(Changed);
        cx.notify();
    }
}

impl EntityInputHandler for SetTextField {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.byte_range(range);
        *actual = Some(self.utf16_range(range.clone()));
        Some(self.value[range].to_owned())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.utf16_range(self.selection()),
            reversed: self.caret < self.anchor,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|range| self.utf16_range(range))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        self.changed(window, cx);
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace(self.replacement_range(range), text);
        self.marked = None;
        self.changed(window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selection: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let inserted = self.replace(self.replacement_range(range), text);
        self.marked = (!inserted.is_empty()).then_some(inserted.clone());
        if let Some(selection) = selection {
            let units = self.utf16_range(inserted);
            let selection = self.byte_range(
                units.start + selection.start.min(units.len())
                    ..units.start + selection.end.min(units.len()),
            );
            self.anchor = selection.start;
            self.caret = selection.end;
        }
        self.changed(window, cx);
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.value.encode_utf16().count())
    }

    fn set_selected_text_range(
        &mut self,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = self.byte_range(range);
        self.anchor = range.start;
        self.select(range.end, true, window, cx);
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (bounds, line) = self.shape.as_ref()?;
        let range = self.byte_range(range);
        let left = bounds.left() + line.x_for_index(range.start);
        let right = bounds.left() + line.x_for_index(range.end);
        Some(Bounds::from_corners(
            point(left.min(right), bounds.top()),
            point(left.max(right), bounds.bottom()),
        ))
    }

    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let byte = self.index_at(position);
        Some(self.value[..byte].encode_utf16().count())
    }
}

impl Focusable for SetTextField {
    fn focus_handle(&self, _: &App) -> FocusHandle { self.focus.clone() }
}

impl Render for SetTextField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .w_full()
            .h(px(31.))
            .flex()
            .items_center()
            .pl(px(8.)).pr(px(if self.composer{38.}else{8.}))
            .rounded(px(6.))
            .border_1()
            .border_color(rgb(if self.focus.is_focused(window) {
                ACCENT
            } else {
                LINE
            }))
            .bg(rgb(0x111d28))
            .text_size(px(12.))
            .line_height(px(18.))
            .overflow_hidden()
            .on_key_down(cx.listener(Self::handle_key))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.focus.focus(window, cx);
                    window.request_virtual_keyboard();
                    this.dragging = true;
                    let at = this.index_at(event.position);
                    this.select(at, event.modifiers.shift, window, cx);
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.dragging && event.pressed_button == Some(MouseButton::Left) {
                    this.select(this.index_at(event.position), true, window, cx);
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.dragging = false),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.dragging = false),
            )
            .child(FieldText(cx.entity()))
    }
}

struct FieldText(Entity<SetTextField>);
impl Element for FieldText {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut Window,
        _: &mut App,
    ) {
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let field = self.0.read(cx);
        let focus = field.focus.clone();
        let selection = field.selection();
        let caret = field.caret;
        let style = window.text_style();
        let run = TextRun {
            len: field.value.len(),
            font: style.font(),
            color: style.color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let line = window.text_system().shape_line(
            field.value.replace(['\r', '\n', '\t'], " ").into(),
            style.font_size.to_pixels(window.rem_size()),
            &[run],
            None,
        );
        let at = line.x_for_index(caret);
        let shift = if focus.is_focused(window) {
            (at - bounds.size.width + px(1.)).max(px(0.))
        } else {
            px(0.)
        };
        let origin = point(bounds.left() - shift, bounds.top());
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.0.clone()), cx);
        if focus.is_focused(window) {
            let start = line.x_for_index(selection.start);
            let end = line.x_for_index(selection.end);
            let highlight = if selection.is_empty() {
                Bounds::new(
                    point(origin.x + at, origin.y),
                    size(px(1.), bounds.size.height),
                )
            } else {
                Bounds::new(
                    point(origin.x + start.min(end), origin.y),
                    size((start - end).abs(), bounds.size.height),
                )
            };
            window.paint_quad(fill(
                highlight,
                if selection.is_empty() {
                    rgb(ACCENT).into()
                } else {
                    rgba(0x3d9f8862)
                },
            ));
        }
        let _ = line.paint(
            origin,
            window.line_height(),
            TextAlign::Left,
            None,
            window,
            cx,
        );
        self.0.update(cx, |field, _| {
            field.shape = Some((Bounds::new(origin, bounds.size), line))
        });
    }
}
