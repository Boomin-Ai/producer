use super::*;
use crate::broadcast::{self, Destination};
#[derive(Default)]
pub(super) struct Channels {
    open: bool,
    managing: bool,
    rows: Vec<Destination>,
    editing: bool,
    delete: bool,
    id: Option<String>,
    name: TextEdit,
    server: TextEdit,
    secret: TextEdit,
    portrait: bool,
    result: Option<mpsc::Receiver<anyhow::Result<Vec<Destination>>>>,
}
impl Channels {
    pub(super) fn open(s: &mut Studio, managing: bool) {
        let Some(l) = &s.live else {
            return;
        };
        let me = &mut s.channels;
        if me.result.is_some() {
            return;
        }
        if me.open && me.managing == managing {
            me.dismiss();
            return;
        }
        me.open = true;
        me.managing = managing;
        me.editing = false;
        me.delete = false;
        match broadcast::channels(&s.base, &l.handle.root) {
            Ok(rows) => me.rows = rows,
            Err(e) => s.error = e.to_string(),
        }
    }
    pub(super) fn preferences(s: &mut Studio) {
        s.channels.dismiss();
        if s.channels.result.is_none() {
            match s.live.as_ref().map_or_else(|| broadcast::list(&s.base), |l| broadcast::channels(&s.base, &l.handle.root)) {
                Ok(rows) => s.channels.rows = rows,
                Err(e) => s.error = e.to_string(),
            }
        }
    }
    fn dismiss(&mut self) {
        self.open = false;
        self.editing = false;
        self.delete = false;
        self.secret = TextEdit::new("");
    }
    fn edit(&mut self, id: Option<String>) {
        let row = self.rows.iter().find(|r| Some(&r.id) == id.as_ref());
        self.name = TextEdit::new(row.map_or("", |r| &r.label));
        self.server = TextEdit::new(row.map_or("", |r| &r.server));
        self.secret = TextEdit::new("");
        self.portrait = row.is_some_and(|r| r.vertical);
        self.id = id;
        self.editing = true;
        self.delete = false;
    }
    fn task(
        s: &mut Studio,
        work: impl FnOnce(&std::path::Path, Option<&Handle>) -> anyhow::Result<()> + Send + 'static,
    ) {
        if s.channels.result.is_some() {
            return;
        }
        let h = s.live.as_ref().map(|l| l.handle.clone());
        let base = s.base.clone();
        let (tx, rx) = mpsc::channel();
        s.channels.result = Some(rx);
        std::thread::spawn(move || {
            let r = work(&base, h.as_deref()).and_then(|_| match &h {
                Some(h) => broadcast::channels(&base, &h.root),
                _ => broadcast::list(&base),
            });
            let _ = tx.send(r);
        });
    }
    pub(super) fn poll(&mut self, error: &mut String) -> bool {
        let Some(rx) = &self.result else { return false };
        let result = match rx.try_recv() {
            Ok(r) => r,
            Err(mpsc::TryRecvError::Empty) => return false,
            Err(_) => Err(anyhow::anyhow!("Channel operation ended")),
        };
        self.result = None;
        match result {
            Ok(rows) => {
                self.rows = rows;
                self.editing = false;
                self.delete = false;
                self.secret = TextEdit::new("");
            }
            Err(e) => *error = e.to_string(),
        };
        true
    }
}
pub(super) fn indicators(s: &Studio, width: f32) -> El {
    let status = &s.live.as_ref().unwrap().broadcast_view.0;
    let mut group = row().key("channel-indicators").items_center().gap(4.).min_w(0.);
    let limit = if width < 740. { 1 } else if width < 1100. { 2 } else { 3 };
    let mut count = 0;
    for destination in s.channels.rows.iter().filter(|d| d.enabled) {
        count += 1;
        if count > limit { continue; }
        let phase = status.destinations.iter().find(|(name, _)| name == &destination.label).map(|(_, phase)| phase.as_str());
        let (state, ink) = match (status.active, phase) {
            (true, Some("Sending")) => ("Sending", MINT),
            (true, Some(p)) if p.starts_with("Connect") => ("Connecting", 0xf4bd68),
            (true, _) => ("Interrupted", 0xf4bd68),
            _ => ("Enabled", MUTED),
        };
        let description = format!("{} · {state}", destination.label);
        group = group.child(row().key(format!("enabled-channel-{}", destination.id))
            .items_center().gap(5.).px(6.).h(23.).max_w(if width < 740. { 68. } else { 128. })
            .radius(6.).fill(color(theme::ROW)).label(description.clone()).help(description)
            .child(el().size(5.,5.).radius(3.).fill(color(ink)))
            .child(title(&destination.label, 10., 600., TEXT).min_w(0.)));
    }
    if count > limit { group = group.child(title(format!("+{}", count-limit), 10., 500., MUTED)); }
    group
}

pub(super) fn health(status: &broadcast::Status) -> (&'static str, u32) {
    let sending = status.destinations.iter().filter(|(_, phase)| phase == "Sending").count();
    if status.error.is_some() { ("Stream interrupted", 0xf4bd68) }
    else if !status.active { ("Stream offline", MUTED) }
    else if sending > 0 && sending == status.destinations.len() { ("Stream healthy", MINT) }
    else if !status.destinations.is_empty() && status.destinations.iter().all(|(_,p)| p.starts_with("Connecting")) { ("Connecting", 0xf4bd68) }
    else { ("Stream degraded", 0xf4bd68) }
}

pub(super) fn sheet(s: &Studio, width: f32) -> Option<El> {
    let me = &s.channels;
    if !me.open {
        return None;
    }
    let status = status(s);
    let box_ = super::panels::toolbar_dropdown("channels-sheet", if me.managing {"channels"} else {"broadcast"},
        rune::Align::End, (width - 16.).min(340.))
        .max_h(450.).padding(14.).gap(7.)
        .modal(true, |s: &mut Studio| s.channels.dismiss())
        .child(
            row()
                .items_center()
                .child(title(
                    if me.managing {
                        "Channels"
                    } else if status.active {
                        "Broadcast destinations"
                    } else {
                        "Ready to go live?"
                    },
                    16.,
                    650.,
                    TEXT,
                ))
                .child(el().grow(1.))
                .child(button("close-channels", "Close", false, |s| {
                    s.channels.dismiss()
                })),
        );
    Some(controls(s, box_, false, status))
}
fn status(s: &Studio) -> broadcast::Status {
    s.live.as_ref().map(|live| live.broadcast_view.0.clone()).unwrap_or_default()
}
pub(super) fn preferences(s: &Studio) -> El {
    controls(s, col().gap(8.), true, status(s))
}
fn controls(s: &Studio, mut box_: El, preferences: bool, status: broadcast::Status) -> El {
    let me = &s.channels;
    let managing = preferences || me.managing;
    if me.result.is_some() {
        return box_.child(title("Please wait…", 12., 500., MUTED));
    }
    if me.editing && !status.active {
        if preferences && me.id.is_none() {
            let mut presets = row().w_full().flex_wrap().gap(5.);
            for (label, url) in [
                ("YouTube", "rtmps://a.rtmps.youtube.com:443/live2"),
                ("Twitch", "rtmp://live.twitch.tv/app"),
                ("Kick", ""),
                ("Facebook Live", ""),
                ("Instagram Live", ""),
                ("TikTok LIVE", ""),
                ("Rumble", ""),
                ("Custom RTMP", ""),
            ] {
                presets = presets.child(button(
                    format!("preset-{label}"),
                    label,
                    me.name.text == label,
                    move |s| {
                        s.channels.name = TextEdit::new(label);
                        s.channels.server = TextEdit::new(url);
                        s.channels.portrait = matches!(label, "TikTok LIVE" | "Instagram Live");
                    },
                ));
            }
            box_ = box_.child(presets);
        }
        box_ = box_
            .child(title("Destination name", 12., 500., MUTED))
            .child(field("destination-name", &me.name, |s| {
                &mut s.channels.name
            }))
            .child(title("Server URL", 12., 500., MUTED))
            .child(field("destination-server", &me.server, |s| {
                &mut s.channels.server
            }))
            .child(title(
                if me.id.is_some() {
                    "New stream key (optional)"
                } else {
                    "Stream key"
                },
                12.,
                500.,
                MUTED,
            ))
            .child(field("destination-key", &me.secret, |s| &mut s.channels.secret).secure())
            .child(
                row()
                    .gap(4.)
                    .child(button(
                        "channel-landscape",
                        "Landscape",
                        !me.portrait,
                        |s| s.channels.portrait = false,
                    ))
                    .child(button("channel-portrait", "Portrait", me.portrait, |s| {
                        s.channels.portrait = true
                    })),
            );
        let mut bar = row()
            .gap(5.)
            .child(button("save-channel", "Save destination", true, |s| {
                let v = &s.channels;
                let (id, name, server, key, vertical) = (
                    v.id.clone(),
                    v.name.text.clone(),
                    v.server.text.clone(),
                    v.secret.text.clone(),
                    v.portrait,
                );
                Channels::task(s, move |base, _| {
                    broadcast::save(
                        base,
                        id.as_deref(),
                        &name,
                        &server,
                        if key.is_empty() { None } else { Some(&key) },
                        vertical,
                    )
                });
            }))
            .child(button("discard-channel", "Cancel", false, |s| {
                s.channels.editing = false;
                s.channels.secret = TextEdit::new("");
            }));
        if let Some(id) = me.id.clone() {
            bar = bar.child(button(
                "remove-channel",
                if me.delete {
                    "Confirm removal"
                } else {
                    "Remove"
                },
                false,
                move |s| {
                    if s.channels.delete {
                        let id = id.clone();
                        Channels::task(s, move |base, _| broadcast::remove(base, &id));
                    } else {
                        s.channels.delete = true;
                    }
                },
            ));
        }
        return box_.child(bar).scroll(Default::default());
    }
    if status.active {
        for (label, phase) in status.destinations {
            box_ = box_.child(
                row()
                    .child(title(label, 12., 550., TEXT))
                    .child(el().grow(1.))
                    .child(title(phase, 12., 500., MINT)),
            );
        }
        box_ = box_.child(title(
            format!("Elapsed {}:{:02}", status.elapsed / 60, status.elapsed % 60),
            12.,
            500.,
            MUTED,
        ));
    } else {
        for d in me.rows.iter().filter(|r| managing || r.enabled) {
            let id = d.id.clone();
            let mut line = row().items_center().gap(5.);
            if preferences {
                line = line
                    .child(title(&d.label, 14., 550., TEXT))
                    .child(el().grow(1.))
                    .child(button(format!("configure-{id}"), "Edit", false, move |s| {
                        s.channels.edit(Some(id.clone()))
                    }));
            } else if managing {
                line = line
                    .child(button(format!("enable-{id}"), &d.label, d.enabled, {
                        let id = id.clone();
                        move |s| {
                            let id = id.clone();
                            Channels::task(s, move |base, h| {
                                broadcast::toggle(
                                    base,
                                    &h.ok_or_else(|| anyhow::anyhow!("Open a studio first"))?
                                        .root,
                                    &id,
                                )
                                .map(|_| ())
                            });
                        }
                    }))
                    .child(el().grow(1.))
                    .child(button(format!("configure-{id}"), "Edit", false, move |s| {
                        s.channels.edit(Some(id.clone()))
                    }));
            } else {
                line = line.child(title(&d.label, 12., 550., TEXT));
            }
            box_ = box_.child(line);
        }
        if managing {
            box_ = box_.child(
                row().child(button("add-channel", "Add destination", false, |s| {
                    s.channels.edit(None)
                })),
            );
        } else if !me.rows.iter().any(|r| r.enabled) {
            box_ = box_.child(button(
                "select-channels",
                "Choose destinations",
                false,
                |s| Channels::open(s, true),
            ));
        }
    }
    if !managing && (status.active || me.rows.iter().any(|r| r.enabled)) {
        box_ = box_.child(button(
            "confirm-broadcast",
            if status.active {
                "End stream"
            } else {
                "Start streaming"
            },
            true,
            move |s| {
                Channels::task(s, move |_, h| {
                    let r = h
                        .ok_or_else(|| anyhow::anyhow!("Open a studio first"))?
                        .request(if status.active {
                            RoomCommand::BroadcastStop
                        } else {
                            RoomCommand::BroadcastStart
                        })?;
                    anyhow::ensure!(
                        r["ok"] == true,
                        "{}",
                        r["error"].as_str().unwrap_or("Broadcast failed")
                    );
                    Ok(())
                });
            },
        ));
    }
    box_.scroll(Default::default())
}
