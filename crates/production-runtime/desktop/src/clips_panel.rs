use super::*;
use crate::clips::{Output, Status};

#[derive(Default)]
pub(super) struct Panel {
    settings_open: bool,
    actions: Option<u128>,
    name: Option<Entity<set_text_field::SetTextField>>,
    duration: Option<Entity<set_text_field::SetTextField>>,
    error: Option<String>,
    pending: bool,
}
impl Room {
    fn clips_status(&self) -> Option<Status> {
        self.handle
            .media
            .lock()
            .unwrap()
            .as_ref()
            .map(|media| media.clips.status())
    }
    fn clip_command(&mut self, command: RoomCommand, cx: &mut Context<Self>) {
        if self.clips_panel.pending {
            return;
        }
        self.clips_panel.pending = true;
        self.clips_panel.error = None;
        let handle = self.handle.clone();
        cx.spawn(async move |room, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { handle.request(command) })
                .await;
            let _ = room.update(cx, |r, cx| {
                r.clips_panel.pending = false;
                r.clips_panel.error = match result {
                    Ok(v) if v["ok"] == true => None,
                    Ok(v) => Some(v["error"].as_str().unwrap_or("Clips command failed").into()),
                    Err(e) => Some(e.to_string()),
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn clips_toggle(&self, state: &Status, loaded: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let enabled = state.enabled;
        let button = Self::edit_button("clips-toggle", if enabled { "On" } else { "Off" }, enabled)
            .debug_selector(|| "clips-toggle".into())
            .tooltip(|_, cx| cx.new(|_| HeaderTip("Rolling capture".into())).into());
        if loaded && !state.saving && !self.clips_panel.pending {
            button.on_click(cx.listener(move |r, _, _, cx| {
                r.clip_command(RoomCommand::ClipsEnable { enabled: !enabled }, cx)
            }))
        } else {
            button.opacity(0.55)
        }
    }
    fn clips_save_button(&self, state: &Status, cx: &mut Context<Self>) -> Stateful<Div> {
        let title = if state.saving {
            "Saving…".into()
        } else {
            format!("Save last {}s", state.settings.seconds)
        };
        let can_save = state.enabled && state.ready && !state.saving && !self.clips_panel.pending;
        let button =
            Self::edit_button("clips-save", title, can_save).debug_selector(|| "clips-save".into());
        if can_save {
            button.on_click(cx.listener(|r, _, _, cx| r.clip_command(RoomCommand::ClipsSave, cx)))
        } else {
            button.opacity(0.55)
        }
    }
    pub(super) fn clips_compact(&self, cx: &mut Context<Self>) -> Div {
        let status = self.clips_status();
        let loaded = status.is_some();
        let state = status.unwrap_or_default();
        let edge = self.workspace().panels[&PanelId::Clips].edge;
        let count = state
            .recent
            .iter()
            .filter(|clip| !clip.files.is_empty())
            .count();
        div()
            .flex()
            .items_center()
            .gap(px(5.))
            .child(self.clips_save_button(&state, cx).flex_none())
            .child(self.clips_toggle(&state, loaded, cx).flex_none())
            .child(
                Self::edit_button("clips-expand", format!("Clips · {count}"), false)
                    .debug_selector(|| "clips-expand".into())
                    .flex_none()
                    .on_click(cx.listener(move |r, _, _, cx| {
                        r.send(
                            RoomCommand::Workspace {
                                command: WorkspaceCommand::Collapse {
                                    edge,
                                    collapsed: false,
                                },
                            },
                            cx,
                        )
                    })),
            )
    }
    pub(super) fn clips_panel(&self, wide: bool, cx: &mut Context<Self>) -> Div {
        let status = self.clips_status();
        let loaded = status.is_some();
        let state = status.unwrap_or_default();
        let locked = state.enabled || state.saving || self.clips_panel.pending || !loaded;
        let status = if state.saving {
            "Saving…".into()
        } else if !loaded {
            "Preparing…".into()
        } else if state.enabled && state.ready {
            format!("Rolling · {}:{:02}", state.elapsed / 60, state.elapsed % 60)
        } else if state.enabled {
            "Buffering…".into()
        } else {
            "Off".into()
        };
        let open = self.clips_panel.settings_open;
        let seconds = state.settings.seconds;
        let capture = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .min_w_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(4.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Clips"))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(rgb(if state.ready { ACCENT } else { MUTED }))
                                    .truncate()
                                    .child(status),
                            )
                            .child(self.clips_toggle(&state, loaded, cx))
                            .child(
                                Self::edit_button("clips-settings", "", open)
                                    .debug_selector(|| "clips-settings".into())
                                    .child(icon("settings").size(px(14.)))
                                    .on_click(cx.listener(|r, _, _, cx| {
                                        r.clips_panel.settings_open = !r.clips_panel.settings_open;
                                        r.clips_panel.duration = None;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(self.clips_save_button(&state, cx));
        let mut options = div().flex().flex_col().min_w_0().gap(px(6.));
        if open {
            options = options.child(div().text_size(px(11.)).text_color(rgb(MUTED)).child(
                if locked {
                    "Stop capture to change settings."
                } else {
                    "Capture window"
                },
            ));
            let mut windows = div().flex().flex_wrap().gap(px(4.));
            for seconds in [15, 30, 60, 120] {
                let button = Self::edit_button(
                    format!("clips-window-{seconds}"),
                    format!("{seconds}s"),
                    seconds == state.settings.seconds,
                );
                let mut settings = state.settings.clone();
                settings.seconds = seconds;
                windows = windows.child(if locked {
                    button.opacity(0.55)
                } else {
                    button.on_click(cx.listener(move |r, _, _, cx| {
                        r.clip_command(
                            RoomCommand::ClipsConfigure {
                                settings: settings.clone(),
                            },
                            cx,
                        )
                    }))
                });
            }
            options = options.child(windows);
            if !locked {
                if let Some(input) = &self.clips_panel.duration {
                    let settings = state.settings.clone();
                    options = options.child(div().flex().gap(px(4.)).child(input.clone()).child(
                        Self::edit_button("apply-custom-window", "Set seconds", false).on_click(
                            cx.listener(move |r, _, _, cx| {
                                let Some(input) = &r.clips_panel.duration else {
                                    return;
                                };
                                let Ok(seconds) = input.read(cx).value.trim().parse::<u32>() else {
                                    r.clips_panel.error =
                                        Some("Enter a duration from 1 to 600 seconds".into());
                                    cx.notify();
                                    return;
                                };
                                let settings = crate::clips::Settings {
                                    seconds,
                                    ..settings.clone()
                                };
                                r.clips_panel.duration = None;
                                r.clip_command(RoomCommand::ClipsConfigure { settings }, cx);
                            }),
                        ),
                    ));
                } else {
                    options = options.child(
                        Self::edit_button("custom-window", "Custom duration", false).on_click(
                            cx.listener(move |r, _, _, cx| {
                                r.clips_panel.duration = Some(cx.new(|cx| {
                                    set_text_field::SetTextField::new(seconds.to_string(), cx)
                                }));
                                cx.notify();
                            }),
                        ),
                    );
                }
            }
            let mut output = div().flex().flex_wrap().gap(px(4.));
            for format in [Output::Landscape, Output::Vertical, Output::Both] {
                let button = Self::edit_button(
                    format.label(),
                    format.label(),
                    format == state.settings.output,
                );
                let settings = crate::clips::Settings {
                    output: format,
                    ..state.settings.clone()
                };
                output = output.child(if locked {
                    button.opacity(0.55)
                } else {
                    button.on_click(cx.listener(move |r, _, _, cx| {
                        r.clip_command(
                            RoomCommand::ClipsConfigure {
                                settings: settings.clone(),
                            },
                            cx,
                        )
                    }))
                });
            }
            options = options.child(output);
            let mut memory = div().flex().flex_wrap().gap(px(4.));
            for mb in [64, 128, 256, 512, 1024] {
                let button = Self::edit_button(
                    format!("clips-memory-{mb}"),
                    format!("{mb} MB"),
                    mb == state.settings.memory_mb,
                );
                let settings = crate::clips::Settings {
                    memory_mb: mb,
                    ..state.settings.clone()
                };
                memory = memory.child(if locked {
                    button.opacity(0.55)
                } else {
                    button.on_click(cx.listener(move |r, _, _, cx| {
                        r.clip_command(
                            RoomCommand::ClipsConfigure {
                                settings: settings.clone(),
                            },
                            cx,
                        )
                    }))
                });
            }
            options = options.child(memory);
        }
        let mut library = div().min_w_0().flex().flex_col().gap(px(5.)).child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(12.))
                .child("Saved clips"),
        );
        if state.recent.is_empty() {
            library = library.child(div().text_color(rgb(MUTED)).child("No saved clips yet."));
        }
        for clip in state.recent.iter().take(30) {
            let id = clip.id;
            let mut row = div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .border_t_1()
                .border_color(rgb(LINE))
                .pt(px(5.));
            if let Some(first) = clip.files.first() {
                let path = first.path.clone();
                let seconds = first.duration_ms / 1000;
                let format = if clip.files.len() > 1 {
                    "Both formats"
                } else {
                    first.output.label()
                };
                row = row.child(
                    div()
                        .flex()
                        .min_w_0()
                        .gap(px(4.))
                        .child(
                            Self::edit_button(format!("preview-{id}"), "", false)
                                .flex_1()
                                .min_w_0()
                                .gap(px(6.))
                                .child(icon("play").size(px(14.)).flex_none())
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .min_w_0()
                                        .child(div().truncate().child(clip.name.clone()))
                                        .child(
                                            div().text_size(px(11.)).text_color(rgb(MUTED)).child(
                                                format!(
                                                    "{format} · {}:{:02}",
                                                    seconds / 60,
                                                    seconds % 60
                                                ),
                                            ),
                                        ),
                                )
                                .on_click(cx.listener(move |r, _, _, cx| {
                                    r.open_clip(path.clone(), false, cx)
                                })),
                        )
                        .child(
                            Self::edit_button(
                                format!("clip-actions-{id}"),
                                "⋯",
                                self.clips_panel.actions == Some(id),
                            )
                            .flex_none()
                            .on_click(cx.listener(
                                move |r, _, _, cx| {
                                    let panel = &mut r.clips_panel;
                                    panel.actions = (panel.actions != Some(id)).then_some(id);
                                    panel.name = None;
                                    cx.notify();
                                },
                            )),
                        ),
                );
                if self.clips_panel.actions == Some(id) {
                    for file in &clip.files {
                        let preview = file.path.clone();
                        let reveal = file.path.clone();
                        let label = file.output.label();
                        row = row.child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap(px(4.))
                                .child(
                                    Self::edit_button(format!("clip-{id}-{label}"), label, false)
                                        .on_click(cx.listener(move |r, _, _, cx| {
                                            r.open_clip(preview.clone(), false, cx)
                                        })),
                                )
                                .child(
                                    Self::edit_button(
                                        format!("reveal-{id}-{label}"),
                                        "Reveal",
                                        false,
                                    )
                                    .on_click(cx.listener(
                                        move |r, _, _, cx| r.open_clip(reveal.clone(), true, cx),
                                    )),
                                ),
                        );
                    }
                    if let Some(input) = &self.clips_panel.name {
                        row = row.child(input.clone()).child(
                            Self::edit_button("save-clip-name", "Save name", false).on_click(
                                cx.listener(move |r, _, _, cx| {
                                    let Some(input) = r.clips_panel.name.take() else {
                                        return;
                                    };
                                    let name = input.read(cx).value.clone();
                                    r.clip_command(
                                        RoomCommand::ClipsRename {
                                            id: id.to_string(),
                                            name,
                                        },
                                        cx,
                                    );
                                }),
                            ),
                        );
                    } else {
                        let name = clip.name.clone();
                        row = row.child(
                            Self::edit_button("rename-clip", "Rename clip", false).on_click(
                                cx.listener(move |r, _, _, cx| {
                                    r.clips_panel.name = Some(cx.new(|cx| {
                                        set_text_field::SetTextField::new(name.clone(), cx)
                                    }));
                                    cx.notify();
                                }),
                            ),
                        );
                    }
                }
            } else {
                row = row.child(clip.name.clone());
                if let Some(error) = &clip.error {
                    row = row.child(div().text_color(rgb(0xff9185)).child(error.clone()));
                }
            }
            library = library.child(row);
        }
        let mut left = capture.child(options);
        if let Some(error) = self.clips_panel.error.as_ref().or(state.error.as_ref()) {
            left = left.child(
                div()
                    .text_size(px(11.))
                    .text_color(rgb(0xff9185))
                    .child(error.clone()),
            );
        }
        let mut content = div().flex().gap(px(9.)).min_w_0();
        content = if wide {
            content.child(left.flex_1()).child(library.flex_1())
        } else {
            content.flex_col().child(left).child(library)
        };
        let folder = state.settings.directory(&crate::root());
        let label = folder
            .file_name()
            .unwrap_or(folder.as_os_str())
            .to_string_lossy()
            .into_owned();
        let settings = state.settings;
        let change = Self::edit_button("clips-folder", "Change", false);
        div()
            .flex()
            .flex_col()
            .p(px(8.))
            .gap(px(8.))
            .child(content)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .border_t_1()
                    .border_color(rgb(LINE))
                    .pt(px(5.))
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .text_color(rgb(MUTED))
                            .child(label),
                    )
                    .child(if locked {
                        change.opacity(0.55)
                    } else {
                        change.on_click(cx.listener(move |r, _, _, cx| {
                            r.choose_clip_folder(settings.clone(), cx)
                        }))
                    }),
            )
    }
    fn choose_clip_folder(&mut self, settings: crate::clips::Settings, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose clip folder".into()),
        });
        cx.spawn(async move |room, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                if let Some(folder) = paths.into_iter().next() {
                    let _ = room.update(cx, |r, cx| {
                        r.clip_command(
                            RoomCommand::ClipsConfigure {
                                settings: crate::clips::Settings {
                                    folder: Some(folder),
                                    ..settings
                                },
                            },
                            cx,
                        )
                    });
                }
            }
        })
        .detach();
    }
    fn open_clip(&mut self, path: std::path::PathBuf, reveal: bool, cx: &mut Context<Self>) {
        if !reveal {
            if let Err(error) = crate::platform::preview_clip(&path) {
                self.clips_panel.error = Some(error.to_string());
                cx.notify();
            }
            return;
        }
        cx.spawn(async move |room, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    std::process::Command::new("/usr/bin/open")
                        .arg("-R")
                        .arg(path)
                        .status()
                        .is_ok_and(|s| s.success())
                })
                .await;
            if !result {
                let _ = room.update(cx, |r, cx| {
                    r.clips_panel.error = Some("Could not open the saved clip.".into());
                    cx.notify();
                });
            }
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::{PanelId, Room, WorkspaceCommand};
    use crate::workspace::Edge;
    use gpui::prelude::*;
    use gpui::{px, size, Bounds, TestAppContext, VisualTestContext, WindowBounds, WindowOptions};
    #[test]
    fn clips_dock_renders_controls_at_each_edge() {
        let root = tempfile::tempdir().unwrap();
        let (handle, _, _) = crate::engine::initial_room(root.path()).unwrap();
        let app = &mut TestAppContext::single();
        let window = app
            .update(|cx| {
                cx.open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                            None,
                            size(px(1200.), px(830.)),
                            cx,
                        ))),
                        ..Default::default()
                    },
                    |_, cx| cx.new(|cx| Room::new(handle.clone(), cx)),
                )
            })
            .unwrap();
        let mut cx = VisualTestContext::from_window(window.into(), app);
        for edge in Edge::ALL {
            for collapsed in [false, true] {
                {
                    let mut s = handle.snapshot.lock().unwrap();
                    let ws = &mut s.project.workspace;
                    ws.apply(WorkspaceCommand::Place {
                        panel: PanelId::Clips,
                        edge,
                        before: None,
                    })
                    .unwrap();
                    ws.apply(WorkspaceCommand::Activate {
                        panel: PanelId::Clips,
                    })
                    .unwrap();
                    ws.apply(WorkspaceCommand::Collapse { edge, collapsed })
                        .unwrap();
                }
                // Repaint using the same snapshot path that drives the physical dock.
                let room = window.root(&mut cx).unwrap();
                cx.update(|_, cx| {
                    room.update(cx, |r, cx| {
                        r.snapshot = r.handle.snapshot();
                        cx.notify();
                    })
                });
                cx.run_until_parked();
                if !collapsed || !edge.side() {
                    assert!(
                        cx.debug_bounds("clips-toggle").is_some(),
                        "{edge:?}, collapsed={collapsed}"
                    );
                    assert!(cx.debug_bounds("clips-save").is_some());
                    if !collapsed {
                        assert!(cx.debug_bounds("clips-settings").is_some());
                    } else {
                        assert!(cx.debug_bounds("clips-expand").is_some());
                    }
                }
            }
        }
    }
}
