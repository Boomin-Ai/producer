use super::*;
use crate::studio_audio::{Bus, Command, DeckId, DeckStatus, Item, Kind, Mode, Status};

const PAGE: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Slider {
    Volume,
    Duck,
    Crossfade,
    Seek(DeckId),
}

impl Slider {
    fn index(self) -> usize {
        match self {
            Self::Volume => 0,
            Self::Duck => 1,
            Self::Crossfade => 2,
            Self::Seek(deck) => 3 + deck.index(),
        }
    }

    fn command(self, fraction: f32, duration: f64) -> Command {
        match self {
            Self::Volume => Command::Gain {
                bus: Bus::Music,
                value: fraction,
            },
            Self::Duck => Command::DuckAmount { amount: fraction },
            Self::Crossfade => Command::Crossfade {
                value: fraction * 2. - 1.,
            },
            Self::Seek(deck) => Command::SeekDeck {
                deck,
                seconds: duration * f64::from(fraction),
            },
        }
    }
}

struct AudioDrag {
    slider: Slider,
    origin: f32,
    width: f32,
    fraction: f32,
    duration: f64,
}

pub(super) struct Panels {
    dj_search: Entity<set_text_field::SetTextField>,
    sound_search: Entity<set_text_field::SetTextField>,
    deck: DeckId,
    sound_page: usize,
    last_query: String,
    editing: Option<String>,
    error: Option<String>,
    slider_focus: [FocusHandle; 5],
    drag: Option<AudioDrag>,
    sound_picker: bool,
}

impl Panels {
    pub(super) fn new(cx: &mut Context<Room>) -> Self {
        Self {
            dj_search: cx.new(|cx| set_text_field::SetTextField::new(String::new(), cx)),
            sound_search: cx.new(|cx| set_text_field::SetTextField::new(String::new(), cx)),
            deck: DeckId::A,
            sound_page: 0,
            last_query: String::new(),
            editing: None,
            error: None,
            slider_focus: std::array::from_fn(|_| cx.focus_handle()),
            drag: None,
            sound_picker: false,
        }
    }
}

fn controls() -> Div {
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .min_w_0()
        .gap(px(4.))
}
fn card() -> Div {
    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(5.))
        .p(px(7.))
        .rounded(px(6.))
        .border_1()
        .border_color(rgb(LINE))
        .bg(rgb(0x0e1822))
}
fn hint(label: impl Into<SharedString>) -> Div {
    div()
        .min_w_0()
        .text_size(px(10.))
        .text_color(rgb(MUTED))
        .child(label.into())
}
fn clock(seconds: f64) -> String {
    let seconds = seconds.max(0.) as u64;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}
fn title(deck: DeckId) -> &'static str {
    match deck {
        DeckId::A => "A",
        DeckId::B => "B",
    }
}

impl Room {
    fn run_studio_audio(&mut self, command: Command, cx: &mut Context<Self>) {
        self.audio_panels.error = None;
        let handle = self.handle.clone();
        cx.spawn(async move |room, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { handle.request(RoomCommand::StudioAudio { command }) })
                .await;
            let _ = room.update(cx, |room, cx| {
                room.audio_panels.error = match result {
                    Ok(v) if v["ok"] == true => None,
                    Ok(v) => Some(
                        v["error"]
                            .as_str()
                            .unwrap_or("Audio command failed")
                            .to_owned(),
                    ),
                    Err(e) => Some(e.to_string()),
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn audio_button(
        &self,
        id: &str,
        label: impl Into<SharedString>,
        active: bool,
        command: Command,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        Self::edit_button(id, label, active)
            .debug_selector(|| id.into())
            .h(px(26.))
            .min_h(px(26.))
            .px(px(6.))
            .min_w_0()
            .text_size(px(11.))
            .flex_none()
            .on_click(cx.listener(move |room, _, _, cx| room.run_studio_audio(command.clone(), cx)))
    }

    fn audio_icon(
        &self,
        id: &str,
        glyph: &str,
        label: &str,
        active: bool,
        command: Command,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        tool(id, glyph, label, active, true)
            .debug_selector(|| id.into())
            .size(px(25.))
            .flex_none()
            .on_click(cx.listener(move |room, _, _, cx| room.run_studio_audio(command.clone(), cx)))
    }

    fn audio_error(&self, state: &Status) -> Option<Div> {
        self.audio_panels
            .error
            .as_ref()
            .or(state.error.as_ref())
            .map(|e| {
                div()
                    .text_size(px(11.))
                    .text_color(rgb(0xffa594))
                    .child(e.clone())
            })
            .or_else(|| {
                state.monitor_error.then(|| {
                    div()
                        .text_size(px(11.))
                        .text_color(rgb(0xffa594))
                        .child("Audio monitor unavailable")
                })
            })
    }

    fn add_studio_audio(&mut self, kind: Kind, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose an audio file".into()),
        });
        cx.spawn(async move |room, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                if let Some(path) = paths.into_iter().next() {
                    let _ = room.update(cx, |r, cx| {
                        r.run_studio_audio(Command::Import { kind, path }, cx)
                    });
                }
            }
        })
        .detach();
    }

    fn audio_import(&self, kind: Kind, cx: &mut Context<Self>) -> Stateful<Div> {
        let id = if kind == Kind::Music {
            "dj-import"
        } else {
            "sound-import"
        };
        Self::edit_button(id, "Import", false)
            .h(px(26.))
            .min_h(px(26.))
            .px(px(6.))
            .flex_none()
            .text_size(px(11.))
            .on_click(cx.listener(move |room, _, _, cx| room.add_studio_audio(kind, cx)))
    }

    fn dj_expand(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let edge = self.workspace().panels[&PanelId::Dj].edge;
        self.workspace_button(
            "dj-expand".into(),
            "DJ",
            false,
            WorkspaceCommand::Collapse {
                edge,
                collapsed: false,
            },
            cx,
        )
        .h(px(26.))
        .min_h(px(26.))
        .px(px(6.))
        .flex_none()
    }

    fn audio_monitor(&self, id: &str, state: &Status, cx: &mut Context<Self>) -> Stateful<Div> {
        self.audio_icon(
            id,
            "headphones",
            "Monitor DJ and Sound on this device",
            state.monitor,
            Command::Monitor {
                enabled: !state.monitor,
            },
            cx,
        )
    }

    fn audio_gain(&self, id: &str, bus: Bus, value: f32, cx: &mut Context<Self>) -> Div {
        let label = match bus {
            Bus::Music => "Music",
            Bus::Sound => "Sound",
        };
        controls()
            .child(hint(format!("{label} {:0.0}%", value * 100.)))
            .child(self.audio_button(
                &format!("{id}-down"),
                "−",
                false,
                Command::Gain {
                    bus,
                    value: (value - 0.08).max(0.),
                },
                cx,
            ))
            .child(self.audio_button(
                &format!("{id}-up"),
                "+",
                false,
                Command::Gain {
                    bus,
                    value: (value + 0.08).min(1.),
                },
                cx,
            ))
    }

    fn deck_status_name(&self, state: &DeckStatus) -> String {
        if state.loading.is_some() {
            return "Loading…".into();
        }
        state
            .id
            .as_deref()
            .map(|id| self.handle.studio_audio.name(id))
            .unwrap_or_else(|| "Empty".into())
    }

    fn dj_action(
        &self,
        id: &str,
        glyph: &str,
        label: &str,
        color: Option<u32>,
        command: Command,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let play = matches!(glyph, "play" | "pause");
        let available = color.is_some();
        let label = SharedString::from(label.to_owned());
        div()
            .id(SharedString::from(id.to_owned()))
            .debug_selector(|| id.into())
            .size(px(if play { 30. } else { 22. }))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(if play { 15. } else { 5. }))
            .when(play, |d| {
                d.bg(rgb(if available { 0x233943 } else { 0x1a2530 }))
            })
            .child(
                icon(glyph)
                    .size(px(if play { 15. } else { 13. }))
                    .text_color(rgb(color.unwrap_or(0x536775))),
            )
            .tooltip(move |_, cx| cx.new(|_| HeaderTip(label.clone())).into())
            .when(available, |d| {
                d.cursor_pointer().hover(|s| s.bg(rgb(0x2a4150))).on_click(
                    cx.listener(move |room, _, _, cx| room.run_studio_audio(command.clone(), cx)),
                )
            })
    }

    fn dj_play(&self, deck: DeckId, state: &DeckStatus, cx: &mut Context<Self>) -> Stateful<Div> {
        let (glyph, label, command) = if state.playing {
            ("pause", "Pause deck", Command::PauseDeck { deck })
        } else {
            ("play", "Play deck", Command::PlayDeck { deck })
        };
        let tint = if state.playing {
            if deck == DeckId::A {
                ACCENT
            } else {
                0xc6b4fb
            }
        } else {
            TEXT
        };
        self.dj_action(
            &format!("dj-play-{}", title(deck)),
            glyph,
            label,
            (state.id.is_some() && state.loading.is_none()).then_some(tint),
            command,
            cx,
        )
    }

    fn dj_transport(
        &self,
        deck: DeckId,
        state: &DeckStatus,
        skip: bool,
        compact: bool,
        tight: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let id = title(deck);
        let loaded = state.id.is_some();
        div()
            .flex()
            .flex_none()
            .items_center()
            .child(self.dj_action(
                &format!("dj-next-track-{id}"),
                "next-track",
                "Next track",
                Some(0xa7b8cb),
                Command::NextTrack { deck },
                cx,
            ))
            .when(!tight, |d| {
                d.child(self.dj_action(
                    &format!("dj-stop-{id}"),
                    "stop",
                    "Stop deck",
                    loaded.then_some(0xa7b8cb),
                    Command::StopDeck { deck },
                    cx,
                ))
            })
            .when(!compact, |d| {
                d.child(self.dj_action(
                    &format!("dj-loop-{id}"),
                    "restart",
                    "Loop track",
                    loaded.then_some(if state.looping { ACCENT } else { 0xa7b8cb }),
                    Command::LoopDeck {
                        deck,
                        enabled: !state.looping,
                    },
                    cx,
                ))
            })
            .when(loaded && skip, |d| {
                d.child(self.dj_action(
                    &format!("dj-seek-back-{id}"),
                    "previous",
                    "Back 10 seconds",
                    Some(MUTED),
                    Command::SeekDeck {
                        deck,
                        seconds: (state.seconds - 10.).max(0.),
                    },
                    cx,
                ))
                .child(self.dj_action(
                    &format!("dj-seek-ahead-{id}"),
                    "next",
                    "Forward 10 seconds",
                    Some(MUTED),
                    Command::SeekDeck {
                        deck,
                        seconds: (state.seconds + 10.).min(state.duration),
                    },
                    cx,
                ))
            })
            .when(loaded && !compact, |d| {
                d.child(self.dj_action(
                    &format!("dj-unload-{id}"),
                    "stage-out",
                    "Eject track",
                    Some(0xa7b8cb),
                    Command::UnloadDeck { deck },
                    cx,
                ))
            })
    }

    pub(super) fn dj_compact(&self, cx: &mut Context<Self>) -> Div {
        let state = self.handle.studio_audio.status();
        let deck = state
            .decks
            .iter()
            .position(|d| d.playing)
            .map_or(self.audio_panels.deck, |i| {
                if i == 0 {
                    DeckId::A
                } else {
                    DeckId::B
                }
            });
        let deck = if state.mixing { deck } else { DeckId::A };
        let current = &state.decks[deck.index()];
        div()
            .flex()
            .items_center()
            .gap(px(4.))
            .min_w_0()
            .child(self.dj_expand(cx))
            .child(self.dj_play(deck, current, cx))
            .child(self.dj_transport(deck, current, false, false, false, cx))
            .child(
                hint(format!(
                    "{} · {}",
                    title(deck),
                    self.deck_status_name(current)
                ))
                .truncate(),
            )
    }

    fn dj_slider_value(&self, slider: Slider, value: f32) -> f32 {
        self.audio_panels
            .drag
            .as_ref()
            .filter(|drag| drag.slider == slider)
            .map_or(value.clamp(0., 1.), |drag| drag.fraction)
    }

    pub(super) fn move_dj_slider(
        &mut self,
        x: Pixels,
        released: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(drag) = &mut self.audio_panels.drag else {
            return false;
        };
        if released {
            let drag = self.audio_panels.drag.take().unwrap();
            self.run_studio_audio(drag.slider.command(drag.fraction, drag.duration), cx);
        } else {
            drag.fraction = ((f32::from(x) - drag.origin) / drag.width).clamp(0., 1.);
        }
        cx.notify();
        true
    }

    fn dj_slider(
        &self,
        slider: Slider,
        fraction: f32,
        duration: f64,
        tint: u32,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let (id, hint) = match slider {
            Slider::Volume => ("dj-volume", "Music volume"),
            Slider::Duck => (
                "dj-duck-amount",
                "Amount of music reduction while you speak",
            ),
            Slider::Crossfade => (
                "dj-crossfade",
                "Crossfade between A and B · Double-click to center",
            ),
            Slider::Seek(DeckId::A) => ("dj-seek-A", "Seek in deck A"),
            Slider::Seek(DeckId::B) => ("dj-seek-B", "Seek in deck B"),
        };
        let enabled = !matches!(slider, Slider::Seek(_)) || duration > 0.;
        let focus = self.audio_panels.slider_focus[slider.index()].clone();
        let bounds = std::rc::Rc::new(std::cell::Cell::new((0_f32, 0_f32)));
        let measured = bounds.clone();
        let center = if slider == Slider::Crossfade {
            0.5_f32
        } else {
            0.
        };
        let track = div()
            .relative()
            .w_full()
            .h(px(2.))
            .rounded_full()
            .bg(rgb(0x2e3e4f))
            .when(slider == Slider::Crossfade, |d| {
                d.child(
                    div()
                        .absolute()
                        .left(relative(0.5))
                        .top(px(-2.))
                        .w(px(1.))
                        .h(px(7.))
                        .bg(rgb(MUTED)),
                )
            })
            .when(enabled, |d| {
                d.child(
                    div()
                        .absolute()
                        .left(relative(center.min(fraction)))
                        .top_0()
                        .h_full()
                        .w(relative((fraction - center).abs()))
                        .rounded_full()
                        .bg(rgb(tint)),
                )
                .child(
                    div()
                        .absolute()
                        .left(relative(fraction))
                        .ml(px(-3.))
                        .top(px(-2.))
                        .size(px(6.))
                        .rounded_full()
                        .bg(rgb(tint)),
                )
            });
        div()
            .w_full()
            .min_w_0()
            .h(px(13.))
            .px(px(4.))
            .flex()
            .items_center()
            .on_children_prepainted(move |children, _, _| {
                if let Some(track) = children.first() {
                    measured.set((track.origin.x.into(), track.size.width.into()));
                }
            })
            .id(id)
            .debug_selector(move || id.into())
            .child(track)
            .when(enabled, |d| {
                d.cursor_pointer()
                    .track_focus(&focus)
                    .tab_index(0)
                    .focus(|style| style.bg(rgb(0x202d3a)))
                    .tooltip(move |_, cx| cx.new(|_| HeaderTip(hint.into())).into())
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |room, event: &MouseDownEvent, window, cx| {
                            focus.focus(window, cx);
                            let (origin, width) = bounds.get();
                            if slider == Slider::Crossfade && event.click_count == 2 {
                                room.audio_panels.drag = None;
                                room.run_studio_audio(slider.command(0.5, duration), cx);
                            } else if width > 0. {
                                room.audio_panels.drag = Some(AudioDrag {
                                    slider,
                                    origin,
                                    width,
                                    fraction,
                                    duration,
                                });
                                room.move_dj_slider(event.position.x, false, cx);
                            }
                            cx.stop_propagation();
                        }),
                    )
                    .on_key_down(cx.listener(move |room, event: &KeyDownEvent, _, cx| {
                        let next = match event.keystroke.key.as_str() {
                            "left" | "down" => fraction - 0.05,
                            "right" | "up" => fraction + 0.05,
                            "pageup" if duration > 0. => fraction + (10. / duration) as f32,
                            "pagedown" if duration > 0. => fraction - (10. / duration) as f32,
                            "home" => 0.,
                            "end" => 1.,
                            "escape" if room.audio_panels.drag.is_some() => {
                                room.audio_panels.drag = None;
                                cx.notify();
                                cx.stop_propagation();
                                return;
                            }
                            _ => return,
                        };
                        room.run_studio_audio(slider.command(next.clamp(0., 1.), duration), cx);
                        cx.stop_propagation();
                    }))
            })
    }

    fn deck_lane(
        &self,
        deck: DeckId,
        state: &DeckStatus,
        width: f32,
        mixing: bool,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let id = title(deck);
        let compact = compact || width < 260.;
        let tight = width < 192.;
        let tint = if deck == DeckId::A { ACCENT } else { 0xc6b4fb };
        let selected = self.audio_panels.deck == deck;
        let value = if state.duration > 0. {
            (state.seconds / state.duration) as f32
        } else {
            0.
        };
        let fraction = self.dj_slider_value(Slider::Seek(deck), value);
        let badge = div()
            .id(SharedString::from(format!("dj-deck-select-{id}")))
            .size(px(17.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .text_size(px(10.))
            .font_weight(FontWeight::SEMIBOLD)
            .bg(rgb(if selected { 0x263a49 } else { 0x192631 }))
            .text_color(rgb(if selected { tint } else { MUTED }))
            .child(id)
            .cursor_pointer()
            .hover(|s| s.bg(rgb(0x314759)))
            .tooltip(move |_, cx| {
                cx.new(|_| HeaderTip(format!("Load tracks into deck {id}").into()))
                    .into()
            })
            .on_click(cx.listener(move |room, _, _, cx| {
                room.audio_panels.deck = deck;
                cx.notify();
            }));
        let time = if width >= 370. && state.duration > 0. {
            format!(
                "{} / {}",
                clock(f64::from(fraction) * state.duration),
                clock(state.duration)
            )
        } else {
            clock(f64::from(fraction) * state.duration)
        };
        let heading = div()
            .flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap(px(if tight { 3. } else { 6. }))
            .px(px(4.))
            .when(mixing, |d| d.child(badge))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(if state.id.is_some() { TEXT } else { MUTED }))
                    .child(self.deck_status_name(state)),
            )
            .when(!compact && state.duration > 0., |d| {
                d.child(hint(time).flex_none())
            });
        let seek = self.dj_slider(
            Slider::Seek(deck),
            fraction,
            state.duration,
            if state.playing { tint } else { 0x93b9c7 },
            cx,
        );
        let transport =
            self.dj_transport(deck, state, !compact && width >= 800., compact, tight, cx);
        let track = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(1.))
            .child(heading)
            .when(!compact, |d| d.child(seek));
        let player = div()
            .flex()
            .min_w_0()
            .w_full()
            .items_center()
            .gap(px(5.))
            .child(
                self.dj_play(deck, state, cx)
                    .when(tight, |d| d.size(px(24.))),
            )
            .child(track);
        div()
            .debug_selector(move || format!("dj-lane-{id}").into())
            .w_full()
            .min_w_0()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.))
            .px(px(if tight { 3. } else { 6. }))
            .py(px(if compact { 3. } else { 5. }))
            .rounded(px(7.))
            .border_1()
            .border_color(rgb(0x20303e))
            .bg(rgb(0x141f2c))
            .child(player.flex_1())
            .child(transport)
    }

    fn dj_mixer(&self, status: &Status, width: f32, tools: Div, cx: &mut Context<Self>) -> Div {
        let volume = self.dj_slider_value(Slider::Volume, status.music_gain);
        let duck = self.dj_slider_value(Slider::Duck, status.duck_amount);
        let fade = self.dj_slider_value(Slider::Crossfade, (status.crossfade + 1.) * 0.5);
        let level = |label: &str, value: f32| {
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(3.))
                .px(px(4.))
                .child(hint(label.to_owned()).truncate())
                .child(
                    hint(format!("{:.0}%", value * 100.))
                        .text_color(rgb(0xb6c8d2))
                        .flex_none(),
                )
        };
        let volume = div()
            .min_w_0()
            .flex_1()
            .child(level("Music", volume))
            .child(self.dj_slider(Slider::Volume, volume, 0., 0x96b8c7, cx));
        let duck = div()
            .min_w_0()
            .flex_1()
            .child(level(
                if width < 300. { "Duck" } else { "Duck amount" },
                duck,
            ))
            .child(self.dj_slider(
                Slider::Duck,
                duck,
                0.,
                if status.duck_music { 0x96b8c7 } else { MUTED },
                cx,
            ));
        let levels = div()
            .flex()
            .items_center()
            .min_w_0()
            .flex_1()
            .gap(px(10.))
            .child(volume)
            .child(duck);
        let crossfade = div()
            .flex()
            .items_center()
            .min_w_0()
            .px(px(4.))
            .gap(px(5.))
            .child(hint("Crossfade").flex_none())
            .child(hint("A").text_color(rgb(ACCENT)).flex_none())
            .child(div().flex_1().min_w_0().child(self.dj_slider(
                Slider::Crossfade,
                fade,
                0.,
                TEXT,
                cx,
            )))
            .child(hint("B").text_color(rgb(0xc6b4fb)).flex_none());
        let strip = div()
            .w_full()
            .flex()
            .min_w_0()
            .gap(px(9.))
            .when(width < 224., |d| d.flex_col().gap(px(2.)))
            .when(width >= 224., |d| d.items_center())
            .child(levels)
            .child(tools);
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(px(3.))
            .py(px(2.))
            .child(strip)
            .when(status.mixing, |d| d.child(crossfade))
    }

    pub(super) fn dj_panel(&self, width: f32, shallow: bool, cx: &mut Context<Self>) -> Div {
        let status = self.handle.studio_audio.status();
        let deck = if status.mixing {
            self.audio_panels.deck
        } else {
            DeckId::A
        };
        let library_width = (width * 0.31).clamp(134., 328.);
        let side_by_side = width >= 420.;
        let console_width = width
            - if side_by_side {
                library_width + 21.
            } else {
                12.
            };
        let compact = shallow || console_width < 392.;
        let panel = div()
            .debug_selector(|| "native-dj-panel".into())
            .min_w_0()
            .w_full()
            .p(px(6.))
            .flex()
            .flex_col()
            .gap(px(5.))
            .h_full()
            .min_h_0();
        let tools = div()
            .flex()
            .items_center()
            .flex_none()
            .gap(px(2.))
            .p(px(2.))
            .rounded(px(6.))
            .bg(rgb(0x141f2c))
            .child(
                self.audio_button(
                    "dj-mix",
                    "Mix",
                    status.mixing,
                    Command::Mix {
                        enabled: !status.mixing,
                    },
                    cx,
                )
                .h(px(22.))
                .min_h(px(22.))
                .px(px(6.))
                .bg(rgb(if status.mixing { 0x223b40 } else { 0x141f2c }))
                .border_color(rgb(if status.mixing { 0x3c5e61 } else { 0x141f2c })),
            )
            .child(self.dj_action(
                "dj-monitor",
                "headphones",
                "Monitor DJ and Sound on this device",
                Some(if status.monitor { ACCENT } else { MUTED }),
                Command::Monitor {
                    enabled: !status.monitor,
                },
                cx,
            ))
            .child(self.dj_action(
                "dj-duck",
                "mic",
                "Lower music while you speak",
                Some(if status.duck_music { ACCENT } else { MUTED }),
                Command::DuckMusic {
                    enabled: !status.duck_music,
                },
                cx,
            ));
        let adjacent = status.mixing && console_width >= 262.;
        let lane_width = if adjacent {
            (console_width - 5.) * 0.5
        } else {
            console_width
        };
        let decks = div()
            .flex()
            .min_w_0()
            .gap(px(5.))
            .when(!adjacent, |d| d.flex_col())
            .child(div().flex_1().min_w_0().child(self.deck_lane(
                DeckId::A,
                &status.decks[0],
                lane_width,
                status.mixing,
                compact,
                cx,
            )))
            .when(status.mixing, |d| {
                d.child(div().flex_1().min_w_0().child(self.deck_lane(
                    DeckId::B,
                    &status.decks[1],
                    lane_width,
                    status.mixing,
                    compact,
                    cx,
                )))
            });
        let console = div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(px(5.))
            .child(decks)
            .child(self.dj_mixer(&status, console_width, tools, cx))
            .children(self.audio_error(&status));

        if side_by_side {
            panel.child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .gap(px(9.))
                    .child(
                        div()
                            .id("dj-console-scroll")
                            .flex_1()
                            .min_w_0()
                            .min_h_0()
                            .overflow_y_scroll()
                            .child(console),
                    )
                    .child(self.dj_library(&status, deck, Some(library_width), shallow, cx)),
            )
        } else {
            panel
                .child(console.flex_none())
                .child(self.dj_library(&status, deck, None, true, cx))
        }
    }

    fn dj_library(
        &self,
        status: &Status,
        deck: DeckId,
        column_width: Option<f32>,
        shallow: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let compact = shallow || column_width.is_none_or(|width| width < 180.);
        let query = self.audio_panels.dj_search.read(cx).value.clone();
        let library = self
            .handle
            .studio_audio
            .catalog(Some(Kind::Music), &query, 0, 64);
        let show_search = !compact || library.total > 8 || !query.is_empty();
        let target = &status.decks[deck.index()];
        let mut rows = div().flex().flex_col().gap(px(2.)).min_w_0();
        for track in &library.items {
            let id = track.id.clone();
            let label = format!("Load {} into deck {}", track.name, title(deck));
            let current = target.loading.as_ref().or(target.id.as_ref()) == Some(&id);
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("dj-load-{id}")))
                    .debug_selector(|| format!("dj-load-{}", track.id).into())
                    .h(px(if compact { 18. } else { 23. }))
                    .flex_none()
                    .flex()
                    .items_center()
                    .min_w_0()
                    .gap(px(5.))
                    .px(px(6.))
                    .rounded(px(4.))
                    .bg(rgb(if current { 0x183032 } else { 0x131e29 }))
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(0x213545)))
                    .tooltip(move |_, cx| cx.new(|_| HeaderTip(label.clone().into())).into())
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(11.))
                            .text_color(rgb(if current { 0xbbeddd } else { TEXT }))
                            .child(track.name.clone()),
                    )
                    .when(current, |d| {
                        d.child(
                            div()
                                .size(px(4.))
                                .rounded_full()
                                .bg(rgb(ACCENT))
                                .flex_none(),
                        )
                    })
                    .on_click(cx.listener(move |room, _, _, cx| {
                        if !current {
                            room.run_studio_audio(
                                Command::LoadDeck {
                                    deck,
                                    id: id.clone(),
                                    play: false,
                                },
                                cx,
                            );
                        }
                    })),
            );
        }
        let header = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .min_w_0()
            .child(
                hint(if status.mixing {
                    format!("Tracks · Deck {}", title(deck))
                } else {
                    "Tracks".to_owned()
                })
                .flex_none(),
            )
            .child(div().flex_1().min_w_0().when(show_search, |d| {
                d.child(self.audio_panels.dj_search.clone())
            }))
            .child(
                tool("dj-import", "plus", "Import a track", false, true)
                    .size(px(20.))
                    .on_click(cx.listener(|room, _, _, cx| room.add_studio_audio(Kind::Music, cx))),
            );
        div()
            .debug_selector(|| "dj-library".into())
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .gap(px(3.))
            .when_some(column_width, |d, width| {
                d.w(px(width))
                    .flex_none()
                    .pl(px(8.))
                    .border_l_1()
                    .border_color(rgb(LINE))
            })
            .when(column_width.is_none(), |d| d.flex_1())
            .child(header)
            .when(library.items.is_empty(), |d| {
                d.child(hint("No matching tracks"))
            })
            .child(
                div()
                    .id("dj-track-scroll")
                    .w_full()
                    .min_h_0()
                    .flex_1()
                    .overflow_y_scroll()
                    .child(rows),
            )
    }

    pub(super) fn sound_compact(&self, cx: &mut Context<Self>) -> Div {
        let status = self.handle.studio_audio.status();
        let mut row = div()
            .flex()
            .items_center()
            .gap(px(4.))
            .min_w_0()
            .child(self.audio_icon(
                "sound-compact-stop",
                "stop",
                "Stop all sounds",
                false,
                Command::StopSounds,
                cx,
            ));
        for item in self.handle.studio_audio.room_sounds("", 0, 2).items {
            let active = status.active_sounds.contains(&item.id);
            row = row.child(
                self.audio_button(
                    &format!("quick-{}", item.id),
                    item.name,
                    active,
                    Command::Trigger {
                        id: item.id,
                        mode: None,
                    },
                    cx,
                )
                .max_w(px(126.))
                .overflow_hidden(),
            );
        }
        row
    }

    fn sound_row(&self, item: &Item, state: &Status, cx: &mut Context<Self>) -> Div {
        let id = &item.id;
        let active = state.active_sounds.contains(id) || state.pending_sounds.contains(id);
        let previewing = state.preview.as_ref() == Some(id);
        let edit = id.clone();
        div()
            .flex()
            .items_center()
            .gap(px(3.))
            .min_w_0()
            .w_full()
            .child(
                self.audio_button(
                    &format!("sound-fire-{id}"),
                    item.name.clone(),
                    active,
                    Command::Trigger {
                        id: id.clone(),
                        mode: None,
                    },
                    cx,
                )
                .flex_1()
                .justify_start()
                .overflow_hidden()
                .truncate(),
            )
            .child(self.audio_icon(
                &format!("sound-cue-{id}"),
                "headphones",
                "Preview on this device",
                previewing,
                if previewing {
                    Command::StopPreview
                } else {
                    Command::Preview { id: id.clone() }
                },
                cx,
            ))
            .child(
                tool(
                    &format!("sound-configure-{id}"),
                    "settings",
                    "Edit pad",
                    false,
                    true,
                )
                .size(px(25.))
                .flex_none()
                .on_click(cx.listener(move |r, _, _, cx| {
                    r.audio_panels.editing = Some(edit.clone());
                    cx.notify()
                })),
            )
            .when(active, |d| {
                d.child(self.audio_icon(
                    &format!("sound-stop-{id}"),
                    "stop",
                    "Stop sound",
                    false,
                    Command::StopSound { id: id.clone() },
                    cx,
                ))
            })
    }

    fn pad_settings(&self, id: &str, cx: &mut Context<Self>) -> Div {
        let pad = self.handle.studio_audio.pad(id);
        let configure = |mode, gain, fade_ms| Command::ConfigurePad {
            id: id.to_owned(),
            mode,
            gain,
            fade_ms,
        };
        let mut row = controls();
        for (label, mode) in [
            ("Restart", Mode::Restart),
            ("Toggle", Mode::Toggle),
            ("Overlap", Mode::Overlap),
            ("Loop", Mode::Loop),
        ] {
            row = row.child(self.audio_button(
                &format!("pad-mode-{label}"),
                label,
                pad.mode == mode,
                configure(mode, pad.gain, pad.fade_ms),
                cx,
            ));
        }
        card()
            .child(Self::panel_heading(
                self.handle.studio_audio.name(id),
                "Pad settings",
            ))
            .child(row)
            .child(
                controls()
                    .child(hint(format!("Gain {:.0}%", pad.gain * 100.)))
                    .child(self.audio_button(
                        "pad-gain-less",
                        "−",
                        false,
                        configure(pad.mode, (pad.gain - 0.08).max(0.), pad.fade_ms),
                        cx,
                    ))
                    .child(self.audio_button(
                        "pad-gain-more",
                        "+",
                        false,
                        configure(pad.mode, (pad.gain + 0.08).min(1.), pad.fade_ms),
                        cx,
                    )),
            )
            .child(
                controls()
                    .child(hint(format!("Fade {} ms", pad.fade_ms)))
                    .child(self.audio_button(
                        "pad-fade-less",
                        "−",
                        false,
                        configure(pad.mode, pad.gain, pad.fade_ms.saturating_sub(25)),
                        cx,
                    ))
                    .child(self.audio_button(
                        "pad-fade-more",
                        "+",
                        false,
                        configure(pad.mode, pad.gain, (pad.fade_ms + 25).min(2000)),
                        cx,
                    ))
                    .child(self.audio_button(
                        "pad-remove",
                        "Remove",
                        false,
                        Command::SetSoundAdded {
                            id: id.to_owned(),
                            added: false,
                        },
                        cx,
                    ))
                    .child(
                        Self::edit_button("pad-close", "Done", false)
                            .h(px(26.))
                            .min_h(px(26.))
                            .px(px(6.))
                            .on_click(cx.listener(|r, _, _, cx| {
                                r.audio_panels.editing = None;
                                cx.notify()
                            })),
                    ),
            )
    }

    pub(super) fn sound_panel(&self, wide: bool, cx: &mut Context<Self>) -> Div {
        let status = self.handle.studio_audio.status();
        let picker = self.audio_panels.sound_picker;
        let search = if picker {
            self.audio_panels.sound_search.read(cx).value.clone()
        } else {
            String::new()
        };
        let page = if self.audio_panels.last_query == search {
            self.audio_panels.sound_page
        } else {
            0
        };
        let audio = &self.handle.studio_audio;
        let sounds = if picker {
            audio.catalog(Some(Kind::Effect), &search, page * PAGE, PAGE)
        } else {
            audio.room_sounds("", page * PAGE, PAGE)
        };
        let mut rows = div().flex().flex_col().gap(px(4.)).min_w_0();
        for pair in sounds.items.chunks(if wide { 2 } else { 1 }) {
            let mut row = div().flex().min_w_0().gap(px(5.));
            for item in pair {
                let content = if picker {
                    self.sound_catalog_row(item, &status, cx)
                } else {
                    self.sound_row(item, &status, cx)
                };
                row = row.child(div().flex_1().min_w_0().child(content));
            }
            if wide && pair.len() == 1 {
                row = row.child(div().flex_1().min_w_0());
            }
            rows = rows.child(row);
        }
        let mut panel = div()
            .debug_selector(|| "native-sound-panel".into())
            .min_w_0()
            .w_full()
            .p(px(7.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(Self::panel_heading(
                "Sound",
                if picker { "Add sounds" } else { "" },
            ))
            .child(
                controls()
                    .child(self.audio_icon(
                        "sound-stop-all",
                        "stop",
                        "Stop all sounds",
                        false,
                        Command::StopSounds,
                        cx,
                    ))
                    .child(self.audio_monitor("sound-monitor", &status, cx))
                    .child(self.audio_gain("sound-gain", Bus::Sound, status.sound_gain, cx))
                    .child(
                        Self::edit_button(
                            "sound-picker",
                            if picker { "Done" } else { "Add sounds" },
                            picker,
                        )
                        .h(px(26.))
                        .px(px(6.))
                        .on_click(cx.listener(|r, _, _, cx| {
                            r.audio_panels.sound_picker = !r.audio_panels.sound_picker;
                            r.audio_panels.editing = None;
                            r.audio_panels.sound_page = 0;
                            cx.notify();
                        })),
                    ),
            );
        if picker {
            panel = panel.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .min_w_0()
                    .child(hint("Search"))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(self.audio_panels.sound_search.clone()),
                    )
                    .child(self.audio_import(Kind::Effect, cx)),
            );
        } else if let Some(id) = self
            .audio_panels
            .editing
            .as_deref()
            .filter(|id| audio.sound_added(id))
        {
            panel = panel.child(self.pad_settings(id, cx));
        }
        let mut pager = controls();
        for (name, next, available) in [
            ("Previous", page.saturating_sub(1), page > 0),
            ("Next", page + 1, (page + 1) * PAGE < sounds.total),
        ] {
            if available {
                let query = search.clone();
                pager = pager.child(
                    Self::edit_button(&format!("sound-page-{name}"), name, false)
                        .h(px(26.))
                        .min_h(px(26.))
                        .px(px(6.))
                        .on_click(cx.listener(move |r, _, _, cx| {
                            r.audio_panels.last_query = query.clone();
                            r.audio_panels.sound_page = next;
                            cx.notify();
                        })),
                );
            }
        }
        panel
            .when(sounds.total == 0, |d| {
                d.child(hint(if picker {
                    "No matching sounds"
                } else {
                    "No sounds added to this studio"
                }))
            })
            .child(rows)
            .child(pager)
            .children(self.audio_error(&status))
    }

    fn sound_catalog_row(&self, item: &Item, state: &Status, cx: &mut Context<Self>) -> Div {
        let id = &item.id;
        let added = self.handle.studio_audio.sound_added(id);
        let previewing = state.preview.as_ref() == Some(id);
        div()
            .flex()
            .items_center()
            .min_w_0()
            .gap(px(4.))
            .pl(px(5.))
            .rounded(px(4.))
            .bg(rgb(0x121e29))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(11.))
                    .child(item.name.clone()),
            )
            .child(self.audio_icon(
                &format!("sound-picker-preview-{id}"),
                "headphones",
                "Preview on this device",
                previewing,
                if previewing {
                    Command::StopPreview
                } else {
                    Command::Preview { id: id.clone() }
                },
                cx,
            ))
            .child(self.audio_button(
                &format!("sound-picker-add-{id}"),
                if added { "Added" } else { "Add" },
                added,
                Command::SetSoundAdded {
                    id: id.clone(),
                    added: !added,
                },
                cx,
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::{Edge, PanelId, Room, Workspace, WorkspaceCommand};
    use gpui::{px, size, AppContext, Bounds, WindowBounds, WindowOptions};
    #[test]
    fn studio_audio_panels_fit_each_expanded_and_compact_dock() {
        let root = tempfile::tempdir().unwrap();
        let (handle, commands, _) = crate::engine::initial_room(root.path()).unwrap();
        let effects =
            handle
                .studio_audio
                .catalog(Some(crate::studio_audio::Kind::Effect), "", 0, 3);
        let fire_ids: Vec<&'static str> = effects
            .items
            .iter()
            .map(|item| &*Box::leak(format!("sound-fire-{}", item.id).into_boxed_str()))
            .collect();
        for item in effects.items.iter().take(2) {
            handle
                .studio_audio
                .execute(crate::studio_audio::Command::SetSoundAdded {
                    id: item.id.clone(),
                    added: true,
                })
                .unwrap();
        }
        let app = &mut gpui::TestAppContext::single();
        let window = app
            .update(|cx| {
                cx.open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                            None,
                            size(px(1180.), px(840.)),
                            cx,
                        ))),
                        ..Default::default()
                    },
                    |_, cx| cx.new(|cx| Room::new(handle, cx)),
                )
            })
            .unwrap();
        let mut ui = gpui::VisualTestContext::from_window(window.into(), app);
        let room = window.root(&mut ui).unwrap();
        for edge in Edge::ALL {
            for collapsed in [false, true] {
                ui.update(|_, cx| {
                    room.update(cx, |r, cx| {
                        let mut w = Workspace::default();
                        for panel in PanelId::ALL {
                            w.apply(WorkspaceCommand::Visibility {
                                panel,
                                visible: false,
                            })
                            .unwrap();
                        }
                        for panel in [PanelId::Dj, PanelId::Sound] {
                            w.apply(WorkspaceCommand::Place {
                                panel,
                                edge,
                                before: None,
                            })
                            .unwrap();
                            w.apply(WorkspaceCommand::Visibility {
                                panel,
                                visible: true,
                            })
                            .unwrap();
                        }
                        w.apply(WorkspaceCommand::Collapse { edge, collapsed })
                            .unwrap();
                        r.snapshot.project.workspace = w.clone();
                        r.handle.snapshot.lock().unwrap().project.workspace = w;
                        cx.notify();
                    })
                });
                ui.run_until_parked();
                if collapsed && edge.side() {
                    assert!(ui.debug_bounds("dj-play-A").is_none());
                    let selector = if edge == Edge::Left {
                        "reopen-dock-left"
                    } else {
                        "reopen-dock-right"
                    };
                    let restore = ui
                        .debug_bounds(selector)
                        .unwrap_or_else(|| panic!("Missing {selector}"));
                    assert!(restore.right() <= px(1180.) && restore.bottom() <= px(840.));
                    continue;
                }
                for name in if collapsed {
                    ["dj-next-track-A", "sound-compact-stop"]
                } else {
                    ["dj-next-track-A", "sound-stop-all"]
                } {
                    let rect = ui.debug_bounds(name).unwrap_or_else(|| {
                        panic!("{name} missing on {edge:?}, collapsed {collapsed}")
                    });
                    assert!(rect.size.width > px(0.) && rect.size.height > px(0.));
                    assert!(rect.origin.x >= px(0.) && rect.origin.y >= px(0.));
                    assert!(rect.right() <= px(1180.) && rect.bottom() <= px(840.));
                }
                if !collapsed {
                    let first = ui.debug_bounds(fire_ids[0]).unwrap();
                    let second = ui.debug_bounds(fire_ids[1]).unwrap();
                    assert!(ui.debug_bounds(fire_ids[2]).is_none());
                    if edge.side() {
                        assert!(first.bottom() <= second.top());
                    } else {
                        assert!(first.right() <= second.left() && first.top() == second.top());
                    }
                    assert!(ui.debug_bounds("dj-lane-A").is_some());
                    assert!(ui.debug_bounds("dj-lane-B").is_none());
                    ui.update(|_, cx| {
                        room.update(cx, |r, cx| {
                            r.handle
                                .studio_audio
                                .execute(crate::studio_audio::Command::Mix { enabled: true })
                                .unwrap();
                            cx.notify();
                        })
                    });
                    ui.run_until_parked();
                    let a = ui.debug_bounds("dj-lane-A").unwrap();
                    let b = ui.debug_bounds("dj-lane-B").unwrap();
                    if edge == Edge::Left {
                        assert!(a.bottom() <= b.top());
                    } else {
                        assert!(a.right() <= b.left());
                    }
                    ui.update(|_, cx| {
                        room.update(cx, |r, cx| {
                            r.handle
                                .studio_audio
                                .execute(crate::studio_audio::Command::Mix { enabled: false })
                                .unwrap();
                            cx.notify();
                        })
                    });
                    ui.run_until_parked();
                    assert!(ui.debug_bounds("dj-lane-B").is_none());
                }
            }
        }
        ui.update(|_, cx| {
            room.update(cx, |r, cx| {
                let mut w = r.snapshot.project.workspace.clone();
                w.apply(WorkspaceCommand::Collapse {
                    edge: Edge::Bottom,
                    collapsed: false,
                })
                .unwrap();
                w.apply(WorkspaceCommand::Resize {
                    edge: Edge::Bottom,
                    size: 208.,
                })
                .unwrap();
                w.apply(WorkspaceCommand::ResizeSplit {
                    first: PanelId::Dj,
                    second: PanelId::Sound,
                    ratio: 0.32,
                })
                .unwrap();
                r.snapshot.project.workspace = w.clone();
                r.handle.snapshot.lock().unwrap().project.workspace = w;
                cx.notify();
            });
        });
        ui.run_until_parked();
        let row = ui.debug_bounds("dj-load-waiting-in-case").unwrap();
        assert!(!row.is_empty() && row.bottom() <= px(840.));
        assert!(ui.debug_bounds("dj-seek-A").is_none());
        assert!(ui.debug_bounds("dj-cue-waiting-in-case").is_none());
        let read_click = std::thread::spawn(move || {
            let envelope = commands
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap();
            if let Some(reply) = envelope.reply {
                reply.send(serde_json::json!({"ok":true})).unwrap();
            }
            match envelope.command {
                crate::engine::RoomCommand::StudioAudio {
                    command: crate::studio_audio::Command::LoadDeck { deck, id, play },
                } => {
                    assert_eq!(deck, crate::studio_audio::DeckId::A);
                    assert_eq!(id, "waiting-in-case");
                    assert!(!play);
                }
                other => panic!("Unexpected track-row action: {other:?}"),
            }
        });
        ui.simulate_mouse_move(row.center(), None, gpui::Modifiers::none());
        ui.simulate_click(row.center(), gpui::Modifiers::none());
        ui.run_until_parked();
        read_click.join().unwrap();

        for (ratio, side_by_side) in [(0.39, true), (0.24, false)] {
            ui.update(|_, cx| {
                room.update(cx, |r, cx| {
                    r.handle
                        .studio_audio
                        .execute(crate::studio_audio::Command::Mix { enabled: true })
                        .unwrap();
                    let mut w = r.snapshot.project.workspace.clone();
                    w.apply(WorkspaceCommand::ResizeSplit {
                        first: PanelId::Dj,
                        second: PanelId::Sound,
                        ratio,
                    })
                    .unwrap();
                    r.snapshot.project.workspace = w.clone();
                    r.handle.snapshot.lock().unwrap().project.workspace = w;
                    cx.notify();
                })
            });
            ui.run_until_parked();
            let a = ui.debug_bounds("dj-lane-A").unwrap();
            let b = ui.debug_bounds("dj-lane-B").unwrap();
            let library = ui.debug_bounds("dj-library").unwrap();
            let track = ui.debug_bounds("dj-load-waiting-in-case").unwrap();
            let duck = ui.debug_bounds("dj-duck-amount").unwrap();
            let mix = ui.debug_bounds("dj-mix").unwrap();
            assert!(a.right() <= b.left());
            assert!(duck.right() <= mix.left());
            assert!(track.bottom() <= library.bottom() && track.bottom() <= px(840.));
            if side_by_side {
                assert!(b.right() < library.left());
            } else {
                assert!(b.bottom() < library.top());
            }
        }
    }
}
