use super::*;
#[path = "shell_account.rs"]
mod shell_account;
use crate::boomin_account::Action;
use crate::broadcast::{self, Destination};
use anyhow::{ensure, Result};
use set_text_field::SetTextField;
use shell_account::Identity;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
};

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Page {
    Rooms,
    Settings,
    Studio,
}
#[derive(Clone, Copy, PartialEq)]
enum Section {
    App,
    Integrations,
    Output,
}
impl Section {
    fn label(self) -> &'static str {
        match self {
            Self::App => "App",
            Self::Integrations => "Integrations",
            Self::Output => "Output",
        }
    }
    fn subtitle(self) -> &'static str {
        match self {
            Self::App => "Version and shortcuts",
            Self::Integrations => "Live destinations",
            Self::Output => "Encoder and program formats",
        }
    }
}
impl EventEmitter<Page> for Room {}
struct RoomEntry {
    main: bool,
    path: PathBuf,
    title: String,
}
fn catalog(root: &Path) -> Result<Vec<RoomEntry>> {
    let mut paths = vec![root.to_path_buf()];
    let dir = root.join("rooms");
    if dir.exists() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() && entry.path().join("room.json").is_file() {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    Ok(paths
        .into_iter()
        .map(|path| {
            let title = fs::read(path.join("room.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| v["production"]["title"].as_str().map(str::to_string))
                .unwrap_or_else(|| "Native Studio".into());
            RoomEntry {
                path,
                title,
                main: false,
            }
        })
        .collect())
}
fn create_room(root: &Path, name: &str) -> Result<PathBuf> {
    let name = name.trim();
    ensure!(
        !name.is_empty() && name.chars().count() <= 80,
        "Enter a room name (up to 80 characters)"
    );
    let parent = root.join("rooms");
    fs::create_dir_all(&parent)?;
    let dir = tempfile::Builder::new()
        .prefix("room-")
        .tempdir_in(parent)?;
    let mut project = crate::model::RoomProject::demo();
    project.room = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_ascii_lowercase();
    project.production.id = project.room.clone();
    project.production.title = name.into();
    project.compile()?;
    let mut file = fs::File::create(dir.path().join("room.json"))?;
    serde_json::to_writer_pretty(&mut file, &project)?;
    file.sync_all()?;
    Ok(dir.keep())
}
struct Form {
    id: Option<String>,
    label: Entity<SetTextField>,
    server: Entity<SetTextField>,
    key: Option<String>,
    vertical: bool,
}
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[derive(PartialEq, Eq, Clone, Copy)]
enum FirstLight { Welcome, Permissions, Complete }
pub(crate) struct Shell {
    base: PathBuf,
    page: Page,
    rooms: Vec<RoomEntry>,
    active: Arc<Mutex<Option<Arc<Handle>>>>,
    studio: Option<Entity<Room>>,
    pending: Arc<Mutex<Option<String>>>,
    switching: bool,
    notice: Option<String>,
    room_name: Option<Entity<SetTextField>>,
    rows: Vec<Destination>,
    form: Option<Form>,
    saving: bool,
    confirm_remove: Option<String>,
    identity: Identity,
    profile: String,
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    first_light: FirstLight,
    profile_open: bool,
    section: Section,
    shortcuts: bool,
    small_detail: bool,
    slide_from: f32,
    slide_at: Instant,
    focus: FocusHandle,
}
impl Shell {
    pub(crate) fn new(
        base: PathBuf,
        active: Arc<Mutex<Option<Arc<Handle>>>>,
        pending: Arc<Mutex<Option<String>>>,
        cx: &mut Context<Self>,
    ) -> Self {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        let first_light = match fs::read_to_string(base.join("setup-stage")).as_deref() {
            Ok("permissions") => FirstLight::Permissions,
            Ok("complete") => FirstLight::Complete,
            _ => FirstLight::Welcome,
        };
        let mut shell = Self {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            first_light,
            base,
            active,
            pending,
            page: Page::Rooms,
            rooms: vec![],
            studio: None,
            switching: false,
            notice: None,
            room_name: None,
            rows: vec![],
            form: None,
            saving: false,
            confirm_remove: None,
            profile_open: false,
            section: Section::App,
            shortcuts: false,
            small_detail: false,
            slide_from: 0.,
            slide_at: Instant::now(),
            focus: cx.focus_handle(),
            identity: Identity::new(cx),
            profile: "Producer".into(),
        };
        shell.navigate(Page::Rooms, cx);
        #[cfg(not(test))]
        shell.account_action(Action::Restore, cx);
        cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(200))
                .await;
            if this
                .update(cx, |s, cx| {
                    if !s.switching && s.pending.lock().unwrap().is_some() {
                        let path = s
                            .active
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map_or_else(|| s.base.clone(), |h| h.root.clone());
                        s.open(path, cx);
                    }
                    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                    if s.first_light == FirstLight::Permissions {
                        cx.notify();
                    }
                    if s.active.lock().unwrap().is_some() && s.page != Page::Studio {
                        cx.notify();
                    }
                })
                .is_err()
            {
                break;
            }
        })
        .detach();
        shell
    }
    fn navigate(&mut self, page: Page, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        if self.page != page {
            self.slide_from = self.drawer_progress();
            self.slide_at = Instant::now();
            self.small_detail = self.page == Page::Studio;
            self.section = if self.page == Page::Studio {
                Section::Integrations
            } else {
                Section::App
            };
        }
        self.profile_open = false;
        self.page = page;
        self.notice = None;
        self.form = None;
        self.confirm_remove = None;
        self.room_name = None;
        let result = match page {
            Page::Rooms => self.refresh_rooms(),
            Page::Settings => broadcast::list(&self.base).map(|v| self.rows = v),
            _ => Ok(()),
        };
        if let Err(e) = result {
            self.notice = Some(e.to_string());
        }
        cx.notify();
    }
    fn begin(&mut self, path: PathBuf, cx: &mut Context<Self>) -> Result<()> {
        let listener = crate::ipc::reserve(&path)?;
        crate::starter_sets::install(&path)?;
        *crate::ACTIVE_ROOT.write().unwrap() = Some(path.clone());
        let h = crate::engine::start(path.clone())?;
        if let Err(e) = crate::ipc::serve(listener, h.clone()) {
            h.closed.store(true, Ordering::Release);
            return Err(e);
        }
        *h.pending_rtc_link.lock().unwrap() = self.pending.lock().unwrap().take();
        *self.active.lock().unwrap() = Some(h.clone());
        let room = cx.new(|cx| Room::new(h, cx));
        cx.subscribe(&room, |s, _, page: &Page, cx| s.navigate(*page, cx))
            .detach();
        self.studio = Some(room);
        self.navigate(Page::Studio, cx);
        Ok(())
    }
    fn open(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if self.switching || self.saving {
            return;
        }
        let current = self.active.lock().unwrap().clone();
        if let Some(h) = current {
            if h.root == path {
                if let Some(link) = self.pending.lock().unwrap().take() {
                    *h.pending_rtc_link.lock().unwrap() = Some(link);
                }
                self.navigate(Page::Studio, cx);
                return;
            }
            if self.has_active_session(&h, cx) {
                self.notice = Some("Finish the active room session before switching rooms.".into());
                return;
            }
            self.switching = true;
            if let Some(room) = self.studio.take() {
                room.update(cx, |r, _| r.retiring = true);
            }
            h.closed.store(true, Ordering::Release);
            cx.spawn(async move |this, cx| {
                while !h.done.load(Ordering::Acquire) {
                    cx.background_executor()
                        .timer(Duration::from_millis(30))
                        .await;
                }
                let _ = this.update(cx, |s, cx| {
                    s.switching = false;
                    *s.active.lock().unwrap() = None;
                    s.open(path, cx);
                });
            })
            .detach();
        } else if let Err(e) = self.begin(path, cx) {
            self.pending.lock().unwrap().take();
            self.notice = Some(format!("Open room · {e:#}"));
        }
        cx.notify();
    }
    fn has_active_session(&self, h: &Handle, cx: &Context<Self>) -> bool {
        let snap = h.snapshot();
        let active_media = h.media.lock().unwrap().as_ref().is_some_and(|m| {
            m.broadcast.active() || {
                let c = m.clips.status();
                c.enabled || c.saving
            }
        });
        active_media
            || snap.recording
            || snap.take.busy()
            || !matches!(
                snap.producer_rtc["phase"].as_str(),
                None | Some("idle" | "ended" | "failed")
            )
            || self
                .studio
                .as_ref()
                .is_some_and(|r| r.read(cx).live.pending || r.read(cx).assistant.working())
    }
    fn edit(&mut self, row: Option<Destination>, cx: &mut Context<Self>) {
        let text = |s: String, cx: &mut Context<Self>| cx.new(|cx| SetTextField::new(s, cx));
        self.notice = None;
        self.confirm_remove = None;
        self.form = Some(Form {
            id: row.as_ref().map(|d| d.id.clone()),
            label: text(row.as_ref().map_or(String::new(), |d| d.label.clone()), cx),
            server: text(row.as_ref().map_or(String::new(), |d| d.server.clone()), cx),
            key: None,
            vertical: row.is_some_and(|d| d.vertical),
        });
        cx.notify();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let Some(f) = &self.form else { return };
        let (id, label, url, key, vertical) = (
            f.id.clone(),
            f.label.read(cx).value.clone(),
            f.server.read(cx).value.clone(),
            f.key.clone(),
            f.vertical,
        );
        let root = self.base.clone();
        self.saving = true;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    broadcast::save(&root, id.as_deref(), &label, &url, key.as_deref(), vertical)
                })
                .await;
            let _ = this.update(cx, |s, cx| {
                s.saving = false;
                match result {
                    Ok(()) => s.navigate(Page::Settings, cx),
                    Err(e) => s.notice = Some(format!("{e:#}")),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn drawer_progress(&self) -> f32 {
        let t = (self.slide_at.elapsed().as_secs_f32() / 0.26).min(1.);
        let goal = if self.page == Page::Settings { 1. } else { 0. };
        goal + (self.slide_from - goal) * (1. - t).powi(3)
    }
    fn room_list(&self, width: f32, cx: &mut Context<Self>) -> Div {
        if let Some(status) = self.identity.busy {
            return div().child(label(status));
        }
        let usable = (width - 72. - 44.).max(160.);
        let cols = (((usable + 14.) / 234.).floor() as usize).max(1);
        let tile_width = ((usable - 14. * (cols - 1) as f32) / cols as f32).floor();
        let tile = || {
            div()
                .w(px(tile_width))
                .max_w_full()
                .min_h(px(109.))
                .p(px(20.))
                .flex()
                .flex_col()
                .items_start()
                .gap(px(5.))
                .rounded(px(16.))
                .border_1()
                .border_color(rgb(0x232c3c))
        };
        let mut grid = div().w_full().flex().flex_wrap().items_start().gap(px(14.));
        for r in &self.rooms {
            let path = r.path.clone();
            let handle = self
                .active
                .lock()
                .unwrap()
                .clone()
                .filter(|h| h.root == path);
            let status = handle.as_ref().and_then(|h| {
                h.media
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|m| m.broadcast.status())
            });
            let sending = status
                .as_ref()
                .is_some_and(|s| s.destinations.iter().any(|(_, p)| p == "Sending"));
            let caption = if sending {
                "Streaming · Return to studio"
            } else if status.is_some_and(|s| s.active) {
                "Broadcast in progress"
            } else if handle.is_some() {
                "Studio open"
            } else {
                "Open studio"
            };
            grid = grid.child(
                tile()
                    .id(SharedString::from(format!("room-{}", path.display())))
                    .cursor_pointer()
                    .bg(linear_gradient(
                        180.,
                        linear_color_stop(rgb(0x061523), 0.),
                        linear_color_stop(rgb(0x151925), 1.),
                    ))
                    .when(r.main, |d| {
                        d.border_color(rgb(0x197c64)).child(label("MAIN STAGE"))
                    })
                    .hover(|d| d.border_color(rgb(0x26745f)))
                    .child(
                        div()
                            .text_size(px(16.5))
                            .font_weight(FontWeight::BOLD)
                            .child(r.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(if sending { ACCENT } else { 0x929cad }))
                            .child(caption),
                    )
                    .on_click(cx.listener(move |s, _, _, cx| s.open_card(path.clone(), cx))),
            );
        }
        if let Some(field) = &self.room_name {
            grid = grid.child(
                tile()
                    .border_dashed()
                    .child(label("Room name"))
                    .child(field.clone())
                    .child(
                        Room::edit_button("create-room", "Create room", true).on_click(
                            cx.listener(|s, _, _, cx| {
                                let name = s.room_name.as_ref().unwrap().read(cx).value.clone();
                                if let Some(a) =
                                    s.identity.account.as_ref().filter(|_| !s.identity.local)
                                {
                                    if name.trim().is_empty() || name.chars().count() > 80 {
                                        s.notice =
                                            Some("Enter a room name (up to 80 characters)".into());
                                        cx.notify();
                                        return;
                                    }
                                    s.account_action(
                                        Action::Create(
                                            a.login.clone(),
                                            name.trim().into(),
                                            s.identity.reference.clone(),
                                        ),
                                        cx,
                                    );
                                    return;
                                }
                                match create_room(&s.base, &name) {
                                    Ok(path) => {
                                        s.navigate(Page::Rooms, cx);
                                        s.open(path, cx);
                                    }
                                    Err(e) => s.notice = Some(e.to_string()),
                                }
                                cx.notify();
                            }),
                        ),
                    ),
            );
        } else {
            grid = grid.child(
                tile()
                    .id("new-room")
                    .border_dashed()
                    .cursor_pointer()
                    .hover(|v| v.border_color(rgb(0x438e7c)))
                    .child(icon("plus").size(px(15.)).text_color(rgb(ACCENT)))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_size(px(16.5))
                            .child("New room"),
                    )
                    .child(label("a stage of its own"))
                    .on_click(cx.listener(|s, _, w, cx| {
                        let f = cx.new(|cx| SetTextField::new(String::new(), cx));
                        f.read(cx).focus_handle(cx).focus(w, cx);
                        s.identity.reference = uuid::Uuid::new_v4().to_string();
                        s.room_name = Some(f);
                        cx.notify();
                    })),
            );
        }
        if self.identity.error.is_some() && !self.profile_open {
            return stack()
                .gap(px(12.))
                .child(
                    Room::edit_button("account-error", self.identity.error.clone().unwrap(), false)
                        .on_click(cx.listener(|s, _, _, cx| {
                            s.profile_open = true;
                            cx.notify();
                        })),
                )
                .child(grid);
        }
        grid
    }
    fn settings(&self, cx: &mut Context<Self>) -> Div {
        let mut content = stack().child(
            div()
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .child("Live destinations"),
        );
        if let Some(f) = &self.form {
            let mut presets = div().flex().flex_wrap().gap(px(6.));
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
                presets = presets.child(
                    Room::edit_button(format!("preset-{label}"), label, false).on_click(
                        cx.listener(move |s, _, _, cx| {
                            if let Some(f) = &mut s.form {
                                f.vertical = matches!(label, "TikTok LIVE" | "Instagram Live");
                                f.label.update(cx, |t, cx| t.reset(label.into(), cx));
                                f.server.update(cx, |t, cx| t.reset(url.into(), cx));
                            }
                        }),
                    ),
                );
            }
            if f.id.is_none() {
                content = content.child(presets);
            }
            content = content
                .child(label("Name"))
                .child(f.label.clone())
                .child(label("Server URL"))
                .child(f.server.clone())
                .child(label("Stream key"))
                .child(
                    Room::edit_button(
                        "paste-stream-key",
                        if f.key.is_some() {
                            "••••••••  ·  Replace"
                        } else if f.id.is_some() {
                            "Saved in Keychain  ·  Paste replacement"
                        } else {
                            "Paste stream key"
                        },
                        false,
                    )
                    .on_click(cx.listener(|s, _, _, cx| {
                        let key = cx
                            .read_from_clipboard()
                            .and_then(|v| v.text())
                            .map(|s| s.trim().to_owned())
                            .filter(|s| !s.is_empty());
                        if key.is_some() {
                            s.form.as_mut().unwrap().key = key;
                            s.notice = None
                        } else {
                            s.notice = Some("Copy your stream key first.".into());
                        }
                        cx.notify();
                    })),
                )
                .child(label("Program output"));
            let mut formats = div().flex().gap(px(8.));
            for (vertical, name) in [(false, "Landscape"), (true, "Portrait")] {
                formats = formats.child(
                    Room::edit_button(format!("format-{name}"), name, f.vertical == vertical)
                        .on_click(cx.listener(move |s, _, _, cx| {
                            s.form.as_mut().unwrap().vertical = vertical;
                            cx.notify();
                        })),
                );
            }
            return content.child(formats).child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        Room::edit_button(
                            "save-destination",
                            if self.saving {
                                "Saving…"
                            } else {
                                "Save destination"
                            },
                            true,
                        )
                        .on_click(cx.listener(|s, _, _, cx| s.save(cx))),
                    )
                    .child(
                        Room::edit_button("cancel-destination", "Cancel", false)
                            .debug_selector(|| "cancel-destination".into())
                            .on_click(cx.listener(|s, _, _, cx| s.navigate(Page::Settings, cx))),
                    ),
            );
        }
        let busy = self.active.lock().unwrap().as_ref().is_some_and(|h| {
            h.media
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|m| m.broadcast.active())
        }) || self
            .studio
            .as_ref()
            .is_some_and(|r| r.read(cx).live.pending);
        if self.rows.is_empty() {
            content = content.child(label(
                "Connect a streaming destination with its server URL and stream key.",
            ));
        }
        for row in &self.rows {
            let d = row.clone();
            let id = row.id.clone();
            let confirm = self.confirm_remove.as_ref() == Some(&id);
            let mut line =
                card().child(stack().child(d.label.clone()).child(label(if d.vertical {
                    "Portrait"
                } else {
                    "Landscape"
                })));
            if !busy {
                line = line.child(
                    div()
                        .flex()
                        .gap(px(6.))
                        .child(
                            Room::edit_button(format!("edit-{id}"), "Edit", false).on_click(
                                cx.listener(move |s, _, _, cx| s.edit(Some(d.clone()), cx)),
                            ),
                        )
                        .child(
                            Room::edit_button(
                                format!("remove-{id}"),
                                if confirm { "Confirm removal" } else { "Remove" },
                                false,
                            )
                            .on_click(cx.listener(
                                move |s, _, _, cx| {
                                    if confirm {
                                        match broadcast::remove(&s.base, &id) {
                                            Ok(()) => s.navigate(Page::Settings, cx),
                                            Err(e) => s.notice = Some(e.to_string()),
                                        }
                                    } else {
                                        s.confirm_remove = Some(id.clone());
                                    }
                                    cx.notify();
                                },
                            )),
                        ),
                );
            }
            content = content.child(line);
        }
        if busy {
            content.child(label("End the broadcast to change destinations."))
        } else {
            content.child(
                Room::edit_button("add-destination", "+ Add destination", true)
                    .debug_selector(|| "add-destination".into())
                    .on_click(cx.listener(|s, _, _, cx| s.edit(None, cx))),
            )
        }
    }
}
fn stack() -> Div {
    div().flex().flex_col().gap(px(10.))
}
fn label(text: &'static str) -> Div {
    div().text_color(rgb(MUTED)).child(text)
}
fn card() -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .p(px(16.))
        .rounded(px(9.))
        .border_1()
        .border_color(rgb(LINE))
        .bg(rgb(PANEL))
}
fn rail_icon(id: &'static str, art: &str, hint: &'static str, selected: bool) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .size(px(38.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(11.))
        .cursor_pointer()
        .bg(if selected { rgba(0xffffffeb) } else { rgba(0) })
        .hover(move |d| {
            d.bg(if selected {
                rgba(0xffffffff)
            } else {
                rgba(0xffffff19)
            })
        })
        .child(
            icon(art)
                .size(px(17.))
                .text_color(rgb(if selected { 0x0b0e14 } else { 0xd0d5de })),
        )
        .tooltip(move |_, cx| cx.new(|_| HeaderTip(hint.into())).into())
}
impl Shell {
    fn initial(&self) -> String {
        self.profile
            .chars()
            .next()
            .unwrap_or('P')
            .to_uppercase()
            .collect()
    }
    fn avatar(&self) -> Div {
        div()
            .size(px(38.))
            .flex_none()
            .rounded_full()
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .bg(linear_gradient(
                135.,
                linear_color_stop(rgb(0x335b55), 0.),
                linear_color_stop(rgb(0x384966), 1.),
            ))
            .text_size(px(15.))
            .font_weight(FontWeight::BOLD)
            .child(if let Some(photo) = &self.identity.avatar {
                div()
                    .size_full()
                    .rounded_full()
                    .overflow_hidden()
                    .child(img(gpui::ImageSource::Render(photo.clone())).size_full())
            } else {
                div().child(self.initial())
            })
            .child(
                div()
                    .absolute()
                    .right(px(-1.))
                    .bottom(px(-1.))
                    .size(px(11.))
                    .rounded_full()
                    .border_2()
                    .border_color(rgb(0x0d1117))
                    .bg(rgb(0x34d399)),
            )
    }
    fn glass_nav(&self, cx: &mut Context<Self>) -> Div {
        let settings = self.page == Page::Settings;
        let mut rail = div()
            .w(px(72.))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .items_center()
            .pt(px(48.))
            .pb(px(14.))
            .gap(px(6.));
        if settings {
            rail = rail.child(
                rail_icon("back-to-rooms", "back", "Back to Rooms", false)
                    .mb(px(8.))
                    .on_click(cx.listener(|s, _, _, cx| s.navigate(Page::Rooms, cx))),
            );
        } else {
            rail = rail.child(
                div()
                    .id("profile")
                    .debug_selector(|| "profile".into())
                    .mb(px(8.))
                    .cursor_pointer()
                    .child(self.avatar())
                    .tooltip(|_, cx| cx.new(|_| HeaderTip("Profile".into())).into())
                    .on_click(cx.listener(|s, _, w, cx| {
                        s.profile_open = !s.profile_open;
                        s.focus.focus(w, cx);
                        cx.notify();
                    })),
            );
        }
        rail.child(
            rail_icon("rooms", "live", "Rooms", !settings)
                .on_click(cx.listener(|s, _, _, cx| s.navigate(Page::Rooms, cx))),
        )
        .child(div().flex_1())
        .child(
            rail_icon("settings", "settings", "Settings", settings).on_click(cx.listener(
                move |s, _, w, cx| {
                    s.focus.focus(w, cx);
                    s.navigate(
                        if settings {
                            Page::Rooms
                        } else {
                            Page::Settings
                        },
                        cx,
                    );
                },
            )),
        )
    }
    fn settings_nav(&self, width: f32, cx: &mut Context<Self>) -> Div {
        let mut rows = stack()
            .gap(px(2.))
            .p(px(6.))
            .rounded(px(14.))
            .bg(rgba(0xffffff08))
            .border_1()
            .border_color(rgba(0xffffff19));
        for section in [Section::App, Section::Integrations, Section::Output] {
            let selected = self.section == section;
            let id = section.label();
            rows = rows.child(
                div()
                    .id(id)
                    .debug_selector(move || id.into())
                    .px(px(12.))
                    .py(px(9.))
                    .rounded(px(10.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .cursor_pointer()
                    .bg(if selected { rgba(0xffffff16) } else { rgba(0) })
                    .border_1()
                    .border_color(if selected { rgba(0xffffff25) } else { rgba(0) })
                    .hover(|v| v.bg(rgba(0xffffff20)))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(id))
                    .child(
                        div()
                            .text_size(px(11.5))
                            .text_color(rgb(0xc5cbd2))
                            .child(section.subtitle()),
                    )
                    .on_click(cx.listener(move |s, _, _, cx| {
                        if s.saving {
                            return;
                        }
                        s.section = section;
                        s.small_detail = true;
                        s.form = None;
                        s.notice = None;
                        cx.notify();
                    })),
            );
        }
        div()
            .w(px(width))
            .h_full()
            .pt(px(48.))
            .px(px(15.))
            .flex_none()
            .border_l_1()
            .border_color(rgba(0xffffff19))
            .child(
                stack()
                    .gap(px(13.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .child(
                                div()
                                    .text_color(rgb(0xbfc8d1))
                                    .text_size(px(12.))
                                    .child("›  Rooms"),
                            )
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("Settings · {}", self.profile)),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .child(div().font_weight(FontWeight::BOLD).child("Producer"))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(rgb(0xbfc8d1))
                                    .child(if cfg!(debug_assertions) { "Native Dev" } else { env!("CARGO_PKG_VERSION") }),
                            ),
                    )
                    .child(rows),
            )
    }
    fn settings_detail(&self, narrow: bool, cx: &mut Context<Self>) -> Div {
        let mut body = stack().gap(px(14.));
        if narrow {
            body = body.child(
                Room::edit_button("settings-list", "‹  Settings", false).on_click(cx.listener(
                    |s, _, _, cx| {
                        s.small_detail = false;
                        cx.notify();
                    },
                )),
            );
        }
        body = body.child(
            stack()
                .gap(px(4.))
                .pb(px(14.))
                .border_b_1()
                .border_color(rgb(LINE))
                .child(
                    div()
                        .text_size(px(22.))
                        .font_weight(FontWeight::BOLD)
                        .child(self.section.label()),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(rgb(MUTED))
                        .child(format!("{} · {}", self.section.subtitle(), self.profile)),
                ),
        );
        match self.section {
            Section::App => {
                let mut tabs = div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .pb(px(10.))
                    .border_b_1()
                    .border_color(rgb(LINE));
                for (shortcut, title) in [(false, "General"), (true, "Shortcuts")] {
                    let selected = self.shortcuts == shortcut;
                    tabs = tabs.child(
                        div()
                            .id(title)
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .bg(if selected { rgba(0xffffff16) } else { rgba(0) })
                            .child(title)
                            .on_click(cx.listener(move |s, _, _, cx| {
                                s.shortcuts = shortcut;
                                cx.notify();
                            })),
                    );
                }
                body = body.child(tabs.child(div().flex_1()).child(label(if cfg!(debug_assertions) { "Native Dev" } else { env!("CARGO_PKG_VERSION") })));
                if self.shortcuts {
                    body.child(detail_row("Edit room layout", "⌘ E"))
                        .child(detail_row("Dismiss a menu", "Esc"))
                } else {
                    body.child(detail_row("Workspace", &self.profile))
                        .child(detail_row("Build", env!("CARGO_PKG_VERSION")))
                }
            }
            Section::Integrations => body.child(self.settings(cx)),
            Section::Output => body
                .child(detail_row("Video", "H.264 · 30 fps"))
                .child(detail_row("Program audio", "AAC · 48 kHz stereo"))
                .child(detail_row(
                    "Orientation",
                    "Landscape or portrait per destination",
                )),
        }
    }
    fn profile_sheet(&self, cx: &mut Context<Self>) -> Div {
        div()
            .absolute()
            .inset_0()
            .child(
                div()
                    .id("dismiss-profile")
                    .debug_selector(|| "dismiss-profile".into())
                    .absolute()
                    .inset_0()
                    .on_click(cx.listener(|s, _, _, cx| {
                        s.profile_open = false;
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .id("profile-popout")
                    .debug_selector(|| "profile-popout".into())
                    .absolute()
                    .left(px(80.))
                    .top(px(48.))
                    .w(px(320.))
                    .max_w_full()
                    .p(px(9.))
                    .rounded(px(14.))
                    .shadow_lg()
                    .border_1()
                    .border_color(rgba(0xffffff23))
                    .bg(rgba(0x18212ef8))
                    .max_h_full()
                    .overflow_y_scroll()
                    .child(self.account_contents(false, cx)),
            )
    }
}
fn detail_row(name: &str, value: &str) -> Div {
    div()
        .py(px(12.))
        .flex()
        .items_center()
        .justify_between()
        .border_b_1()
        .border_color(rgb(0x182632))
        .child(name.to_owned())
        .child(div().text_color(rgb(MUTED)).child(value.to_owned()))
}
impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(room) = self.studio.as_ref().filter(|_| self.page == Page::Studio) {
            return div()
                .size_full()
                .flex()
                .flex_col()
                .bg(rgb(BG))
                .child(
                    div()
                        .flex_none()
                        .h(px(28.))
                        .window_control_area(WindowControlArea::Drag),
                )
                .child(div().flex_1().min_h_0().child(room.clone()))
                .into_any_element();
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        if self.first_light != FirstLight::Complete {
            return self.setup_screen(window, cx).into_any_element();
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        if self.identity.account.is_none() && !self.identity.local {
            return self.entry_screen(cx).into_any_element();
        }
        let width: f32 = window.viewport_size().width.into();
        let settings = self.page == Page::Settings;
        let narrow = width < 860.;
        let progress = self.drawer_progress();
        if self.slide_at.elapsed().as_millis() < 261 {
            window.request_animation_frame();
        }
        let nav_width = if narrow { (width - 72.).max(0.) } else { 300. };
        let reveal = if narrow && self.small_detail && settings {
            0.
        } else {
            progress
        };
        let mut root = div()
            .id("producer-shell")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .font_family("Helvetica Neue")
            .text_size(px(13.5))
            .text_color(rgb(0xe8ecf3))
            .child(self.glass_nav(cx))
            .on_key_down(cx.listener(|s, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && !s.saving {
                    if s.profile_open {
                        s.profile_open = false;
                    } else if s.form.is_some() {
                        s.form = None;
                    } else if s.room_name.is_some() {
                        s.room_name = None;
                    } else {
                        s.navigate(Page::Rooms, cx);
                    }
                    cx.stop_propagation();
                    cx.notify();
                }
            }));
        if reveal > 0. {
            root = root.child(
                div()
                    .flex_none()
                    .w(px(reveal * nav_width))
                    .overflow_hidden()
                    .h_full()
                    .child(self.settings_nav(nav_width, cx)),
            );
        }
        if !(settings && narrow && !self.small_detail) {
            let content = if settings {
                self.settings_detail(narrow, cx)
            } else {
                self.room_list(width, cx)
            };
            let mut page = div()
                .id("shell-page")
                .flex_1()
                .min_w_0()
                .h_full()
                .rounded_l(px(16.))
                .overflow_y_scroll()
                .bg(rgb(0x03101e))
                .pt(px(if settings { 50. } else { 42. }))
                .px(px(if settings && !narrow { 48. } else { 22. }))
                .child(if settings {
                    div().w_full().max_w(px(696.)).mx_auto().child(content)
                } else {
                    content
                });
            if let Some(error) = &self.notice {
                page = page.child(
                    div()
                        .mt(px(12.))
                        .text_color(rgb(0xffadb3))
                        .child(error.clone()),
                );
            }
            if self.switching {
                page = page.child(label("Opening studio…"));
            }
            root = root.child(page);
        }
        root = root.child(
            div()
                .absolute()
                .left(px(76.))
                .top_0()
                .right_0()
                .h(px(26.))
                .window_control_area(WindowControlArea::Drag),
        );
        if self.profile_open {
            root = root.child(self.profile_sheet(cx));
        }
        root.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{catalog, create_room, fs, Page, Shell};
    use gpui::{prelude::*, Modifiers, TestAppContext, VisualTestContext, WindowOptions};
    #[test]
    fn shell_navigation_and_room_isolation() {
        let dir = tempfile::tempdir().unwrap();
        let a = create_room(dir.path(), "Morning Brief").unwrap();
        let b = create_room(dir.path(), "Evening Desk").unwrap();
        assert_ne!(a, b);
        assert_eq!(catalog(dir.path()).unwrap().len(), 3);
        let project: crate::model::RoomProject =
            serde_json::from_slice(&fs::read(a.join("room.json")).unwrap()).unwrap();
        assert_eq!(project.production.title, "Morning Brief");
        project.compile().unwrap();
        let app = &mut TestAppContext::single();
        let window = app
            .update(|cx| {
                let bounds =
                    gpui::Bounds::centered(None, gpui::size(gpui::px(1280.), gpui::px(800.)), cx);
                cx.open_window(
                    WindowOptions {
                        window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                        ..Default::default()
                    },
                    |_, cx| {
                        cx.new(|cx| {
                            Shell::new(
                                dir.path().into(),
                                Default::default(),
                                Default::default(),
                                cx,
                            )
                        })
                    },
                )
            })
            .unwrap();
        let mut cx = VisualTestContext::from_window(window.into(), app);
        let shell = window.root(&mut cx).unwrap();
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            cx.run_until_parked();
            for id in ["setup-next", "setup-finish"] {
                let next = cx.debug_bounds(id).unwrap().center();
                cx.simulate_click(next, Modifiers::default());
                cx.run_until_parked();
            }
            assert_eq!(fs::read_to_string(dir.path().join("setup-stage")).unwrap(), "complete");
            assert!(cx.debug_bounds("submit-account").is_some());
            let local = cx.debug_bounds("entry-local").unwrap().center();
            cx.simulate_click(local, Modifiers::default());
        }
        for id in [
            "profile",
            "dismiss-profile",
            "settings",
            "Integrations",
            "add-destination",
            "cancel-destination",
            "rooms",
        ] {
            cx.run_until_parked();
            if id == "Integrations" {
                cx.update(|_, cx| {
                    shell.update(cx, |s, cx| {
                        s.slide_at =
                            std::time::Instant::now() - std::time::Duration::from_millis(300);
                        cx.notify();
                    })
                });
                cx.run_until_parked();
            }
            if id == "dismiss-profile" {
                assert!(cx.debug_bounds("profile-popout").is_some());
            }
            let center = cx
                .debug_bounds(id)
                .unwrap_or_else(|| panic!("missing {id}"))
                .center();
            cx.simulate_click(center, Modifiers::default());
        }
        cx.update(|_, cx| {
            assert!(shell.read(cx).page == Page::Rooms);
            assert!(shell.read(cx).studio.is_none());
        });
    }
}
