use super::*;
use crate::broadcast::{self, Destination};

#[derive(Default)]
pub(super) struct Panel {
    rows: Vec<Destination>,
    pub(super) pending: bool,
    error: Option<String>,
}
impl Room {
    pub(super) fn broadcast_active(&self) -> bool {
        self.handle
            .media
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|m| m.broadcast.active())
    }
    pub(super) fn open_live_menu(&mut self, mode: &'static str, cx: &mut Context<Self>) {
        self.header_menu = if self.header_menu == Some(mode) {
            None
        } else {
            Some(mode)
        };
        match broadcast::channels(&crate::workspace_root(), &self.handle.root) {
            Ok(rows) => {
                self.live.rows = rows;
                self.live.error = None
            }
            Err(e) => self.live.error = Some(e.to_string()),
        }
        cx.notify();
    }
    fn broadcast_command(&mut self, start: bool, cx: &mut Context<Self>) {
        if self.live.pending {
            return;
        }
        self.live.pending = true;
        self.live.error = None;
        let handle = self.handle.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    handle.request(if start {
                        RoomCommand::BroadcastStart
                    } else {
                        RoomCommand::BroadcastStop
                    })
                })
                .await;
            let _ = this.update(cx, |r, cx| {
                r.live.pending = false;
                match result {
                    Ok(v) if v["ok"] == true => {}
                    Ok(v) => {
                        r.live.error = Some(
                            v["error"]
                                .as_str()
                                .unwrap_or("Broadcast command failed")
                                .into(),
                        )
                    }
                    Err(e) => r.live.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn live_sheet(&self, mode: &str, cx: &mut Context<Self>) -> Div {
        let status = self
            .handle
            .media
            .lock()
            .unwrap()
            .as_ref()
            .map(|m| m.broadcast.status())
            .unwrap_or_default();
        let channels = mode == "channels";
        let mut sheet = div()
            .absolute()
            .right(px(12.))
            .top(px(46.))
            .w(px(338.))
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .rounded(px(10.))
            .bg(rgb(PANEL))
            .border_1()
            .border_color(rgb(LINE))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .text_size(px(16.))
                            .child(if channels {
                                "Channels"
                            } else if status.active {
                                "Broadcast destinations"
                            } else {
                                "Ready to go live?"
                            }),
                    )
                    .child(
                        Self::edit_button("close-stream-menu", "Close", false).on_click(
                            cx.listener(|r, _, _, cx| {
                                r.header_menu = None;
                                cx.notify();
                            }),
                        ),
                    ),
            );
        let mut items = div()
            .id("stream-destinations")
            .max_h(px(310.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(6.));
        if status.active {
            for (label, phase) in status.destinations {
                items = items.child(
                    div().flex().justify_between().child(label).child(
                        div()
                            .text_color(rgb(if phase == "Sending" { ACCENT } else { MUTED }))
                            .child(phase),
                    ),
                );
            }
            sheet = sheet
                .child(items)
                .child(div().text_color(rgb(MUTED)).child(format!(
                    "Elapsed  {}:{:02}",
                    status.elapsed / 60,
                    status.elapsed % 60
                )));
        } else {
            for row in self.live.rows.iter().filter(|r| channels || r.enabled) {
                let id = row.id.clone();
                let button = Self::edit_button(
                    format!("channel-{id}"),
                    format!(
                        "{}{}  ·  {}",
                        if channels && row.enabled { "✓ " } else { "" },
                        row.label,
                        if row.vertical {
                            "Portrait"
                        } else {
                            "Landscape"
                        }
                    ),
                    row.enabled && channels,
                );
                if channels {
                    items = items.child(button.on_click(cx.listener(move |r, _, _, cx| {
                        let root = crate::workspace_root();
                        match broadcast::toggle(&root, &r.handle.root, &id) {
                            Ok(rows) => r.live.rows = rows,
                            Err(e) => r.live.error = Some(e.to_string()),
                        }
                        cx.notify();
                    })));
                } else {
                    let canvas = if row.vertical {
                        self.snapshot.project.canvas.vertical
                    } else {
                        self.snapshot.project.canvas.landscape
                    };
                    items = items.child(div().child(format!(
                        "{}  ·  {} × {}",
                        row.label, canvas.width, canvas.height
                    )));
                }
            }
            sheet = sheet.child(items);
            if self.live.rows.iter().all(|r| !r.enabled) {
                sheet = sheet.child(div().text_color(rgb(MUTED)).child(
                    if self.live.rows.is_empty() {
                        "Add your first live destination in Settings."
                    } else {
                        "Choose at least one destination in Channels."
                    },
                ));
            }
            if !channels && !self.live.rows.is_empty() {
                sheet = sheet.child(
                    Self::edit_button("choose-stream-channels", "Choose channels", false)
                        .on_click(cx.listener(|r, _, _, cx| r.open_live_menu("channels", cx))),
                );
            }
            sheet = sheet.child(
                Self::edit_button("manage-stream-destinations", "Destination settings", false)
                    .on_click(cx.listener(|r, _, _, cx| {
                        r.header_menu = None;
                        cx.emit(shell::Page::Settings);
                    })),
            );
        }
        if let Some(error) = self.live.error.as_ref().or(status.error.as_ref()) {
            sheet = sheet.child(div().text_color(rgb(0xffadb3)).child(error.clone()));
        }
        if !channels {
            let active = status.active;
            let enabled = !self.live.pending
                && (active
                    || (self.live.rows.iter().any(|d| d.enabled)
                        && self.handle.media.lock().unwrap().is_some()));
            let button = Self::edit_button(
                "confirm-stream",
                if self.live.pending {
                    "Please wait…"
                } else if active {
                    "End stream"
                } else {
                    "Start streaming"
                },
                enabled,
            );
            sheet = sheet.child(if enabled {
                button.on_click(cx.listener(move |r, _, _, cx| r.broadcast_command(!active, cx)))
            } else {
                button.opacity(0.5)
            });
        }
        sheet
    }
}
