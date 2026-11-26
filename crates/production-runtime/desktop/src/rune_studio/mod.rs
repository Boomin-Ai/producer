//! Rune owns the operator window. The native engine owns capture, timing, recording and output.
mod catalog;
mod channels;
mod chat;
mod editor;
mod glyphs;
mod mixer;
mod monitor;
mod network;
mod panels;
mod panel_frame;
mod theme;
mod people;
mod publish;
mod publish_options;
mod publish_history;
mod settings;
mod set_library;
mod timeline;
use crate::{
    engine::{self, Handle, RoomCommand, Snapshot},
    model::CanvasView,
    platform::Frame,
    studio_presets::Starter,
    workspace::{Edge, PanelId, WorkspaceCommand},
};
use rune::{
    col, el, row, text, text_input, tok::TextStyle, AppSpec, Color, Cx, El, NativeSurface,
    SurfaceFit, TextEdit, Tx, Waker,
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

const BG: u32 = 0x080d14;
const PANEL: u32 = 0x0c141e;
const SURFACE: u32 = 0x14222d;
const TEXT: u32 = 0xe4edf3;
const MUTED: u32 = 0x8ca2af;
const MINT: u32 = 0x78ddba;
fn color(c: u32) -> Color {
    theme::color(c)
}
fn title(s: impl Into<String>, size: f32, weight: f32, c: u32) -> El {
    text(s.into())
        .font(TextStyle::new(size, weight))
        .color(color(c))
        .truncate()
        .min_w(0.)
}
fn button(
    key: impl Into<String>,
    name: impl Into<String>,
    active: bool,
    f: impl Fn(&mut Studio) + 'static,
) -> El {
    let name = name.into();
    el().key(key.into())
        .role("button")
        .label(name.clone())
        .focusable(true)
        .radius(5.)
        .px(8.)
        .h(28.)
        .center()
        .fill(color(if active { 0x193a32 } else { SURFACE }))
        .child(title(name, 11., 500., if active { MINT } else { TEXT }))
        .on_press(f)
}
fn command(key: impl Into<String>, name: impl Into<String>, active: bool, c: RoomCommand) -> El {
    button(key, name, active, move |s| s.send(c.clone()))
}
fn field(
    key: &'static str,
    value: &TextEdit,
    get: impl for<'a> Fn(&'a mut Studio) -> &'a mut TextEdit + 'static,
) -> El {
    text_input(value, TextStyle::new(13., 450.))
        .key(key)
        .label(match key {
            "assistant-quick" | "assistant-input" => "Message to studio assistant",
            "email" => "Boomin email",
            "code" => "Verification code",
            "studio-name" => "Studio name",
            _ => key,
        })
        .placeholder(
            if key.starts_with("assistant") {
                "Ask…"
            } else {
                ""
            },
            color(MUTED),
        )
        .w_full()
        .min_w(0.)
        .h(32.)
        .px(8.)
        .radius(5.)
        .fill(color(SURFACE))
        .color(color(TEXT))
        .on_edit(get)
}
#[derive(PartialEq, Clone, Copy)]
enum Page {
    Studios,
    Starters,
    Studio,
    Settings,
}
struct StudioPerformance {
    sampled: Instant,
    cpu_seconds: Option<f64>,
    frames: u64,
    cpu: Option<f64>,
    fps: Option<f64>,
}

impl StudioPerformance {
    fn new(frames: u64) -> Self {
        Self { sampled: Instant::now(), cpu_seconds: Self::process_seconds(), frames, cpu: None, fps: None }
    }

    #[cfg(unix)]
    fn process_seconds() -> Option<f64> {
        let mut usage = std::mem::MaybeUninit::uninit();
        // getrusage initializes the record when it returns success.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 { return None; }
        let usage = unsafe { usage.assume_init() };
        let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1_000_000.;
        Some(seconds(usage.ru_utime) + seconds(usage.ru_stime))
    }
    #[cfg(not(unix))]
    fn process_seconds() -> Option<f64> { None }

    fn update(&mut self, counts: [u64; 2]) {
        let elapsed = self.sampled.elapsed().as_secs_f64();
        if elapsed < 1. { return; }
        let frames = counts[0].max(counts[1]);
        self.fps = frames.checked_sub(self.frames).map(|delta| delta as f64 / elapsed);
        let cpu = Self::process_seconds();
        self.cpu = cpu.zip(self.cpu_seconds).map(|(new, old)| 100. * (new - old).max(0.) / elapsed);
        self.frames = frames;
        self.cpu_seconds = cpu;
        self.sampled = Instant::now();
    }
}

struct Live {
    performance: StudioPerformance,
    handle: Arc<Handle>,
    snapshot: Snapshot,
    broadcast_view: (crate::broadcast::Status, bool),
    clip_view: Option<(crate::clips::Status, Arc<Vec<crate::clips::Saved>>)>,
    surfaces: [NativeSurface; 2],
    guest_thumbnail: NativeSurface,
    worker: Option<std::thread::JoinHandle<()>>,
    reviewing: Arc<AtomicBool>,
    previewing: Arc<AtomicBool>,
    guest_view: Arc<AtomicBool>,
    updated: Instant,
}
impl Live {
    fn start(path: PathBuf, pending: Option<String>, capture: bool) -> anyhow::Result<Self> {
        let listener = crate::ipc::reserve(&path)?;
        crate::starter_sets::install(&path)?;
        let handle = engine::start(path.clone())?;
        if let Err(e) = crate::ipc::serve(listener, handle.clone()) {
            handle.closed.store(true, Ordering::Release);
            return Err(e);
        }
        *crate::ACTIVE_ROOT.write().unwrap() = Some(path);
        crate::room_share::maintain_presence(&handle);
        let snap = handle.snapshot();
        if pending.is_some() {
            *handle.pending_rtc_link.lock().unwrap() = pending;
        } else if capture {
            let has = |name| snap.project.lanes.iter().any(|l| l.source == name);
            if let Err(e) = handle.send(RoomCommand::Capture {
                camera: has("camera"),
                screen: false,
                mic: has("microphone"),
            }) {
                handle.closed.store(true, Ordering::Release);
                return Err(e);
            }
        }
        let surfaces = std::array::from_fn(|_| NativeSurface::new());
        let previewing = Arc::new(AtomicBool::new(snap.previewing));
        let reviewing = Arc::new(AtomicBool::new(false));
        let guest_view = Arc::new(AtomicBool::new(false));
        let guest_thumbnail = NativeSurface::new();
        let worker = monitor::spawn(
            handle.clone(),
            surfaces.clone(),
            guest_thumbnail.clone(),
            previewing.clone(),
            reviewing.clone(),
            guest_view.clone(),
        )?;
        Ok(Self {
            handle,
            performance: StudioPerformance::new(snap.output_frames[0].max(snap.output_frames[1])),
            snapshot: snap,
            clip_view: None,
            broadcast_view: Default::default(),
            surfaces,
            guest_thumbnail,
            worker: Some(worker),
            guest_view,
            reviewing,
            previewing,
            updated: Instant::now(),
        })
    }
    fn refresh(&mut self) -> Result<bool, String> {
        if self.updated.elapsed() < Duration::from_millis(150) {
            return Ok(false);
        }
        if let Ok(media) = self.handle.media.try_lock() {
            if let Some(media) = media.as_ref() {
                if let Some(view) = media.clips.try_view() { self.clip_view = Some(view); }
                if let Some(view) = media.broadcast.try_view() { self.broadcast_view = view; }
            }
        }
        if let Some(snapshot) = self.handle.try_snapshot() {
            self.performance.update(snapshot.output_frames);
            self.snapshot = snapshot;
        }
        self.previewing
            .store(self.snapshot.previewing, Ordering::Release);
        self.guest_view.store(
            self.snapshot.producer_rtc["role"] == "guest"
                && self.snapshot.producer_rtc["phase"] == "connected",
            Ordering::Release,
        );
        self.updated = Instant::now();
        Ok(true)
    }
    fn switch_blocker(&self) -> Option<&'static str> {
        let state = self.handle.snapshot();
        if state.recording || state.take.busy() {
            return Some("Finish the recording before switching studios.");
        }
        if let Some(media) = self.handle.media.lock().unwrap().as_ref() {
            if media.broadcast.active() {
                return Some("Stop the broadcast before switching studios.");
            }
            if media.clips.status().saving {
                return Some("Wait for the clip to finish saving before switching studios.");
            }
        }
        state.producer_rtc["phase"].as_str()
            .filter(|phase| !matches!(*phase, "idle" | "ended" | "failed"))
            .map(|_| "Leave the call before switching studios.")
    }
}
impl Drop for Live {
    fn drop(&mut self) {
        self.handle.closed.store(true, Ordering::Release);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
struct Studio {
    chat: chat::Chat,
    editor: Option<editor::Editor>,
    set_library: set_library::Library,
    job_rx: mpsc::Receiver<(PathBuf, anyhow::Result<String>)>,
    job_tx: mpsc::Sender<(PathBuf, anyhow::Result<String>)>,
    base: PathBuf,
    page: Page,
    rooms: Vec<catalog::RoomEntry>,
    live: Option<Live>,
    error: String,
    wake_stop: Arc<AtomicBool>,
    name: TextEdit,
    starter: Option<Starter>,
    pending: Option<String>,
    quiet: bool,
    resize: Option<WorkspaceCommand>,
    editing_docks: bool,
    moving_panel: Option<PanelId>,
    drop_edge: Option<Edge>,
    drag_tile: Option<(PanelId, [f32; 2])>,
    studio_panels: bool,
    panel_menu: Option<Edge>,
    set_selection: Option<(String, String, crate::model::SetLayoutPair)>,
    pending_trim: Option<RoomCommand>,
    channels: channels::Channels,
    naming: bool,
    starter_images: Option<[rune::Image; Starter::ALL.len()]>,
    pending_link: Option<crate::room_share::LinkKind>,
    activity: bool,
    switch_notice: Option<&'static str>,
    show_chat: bool,
    settings: settings::Settings,
    studio_settings: Option<settings::StudioSheet>,
    mixer_scrub: Option<(f32, Instant)>,
    network: network::Network,
    publish: publish::Publish,
    dj_deck: usize,
    sound_library: bool,
    sound_query: TextEdit,
    pan_grab: Option<([f32; 2], [f32; 2])>,
    people_settings: bool,
    people: people::People,
    clip_settings: bool,
    source_anchor: Option<[f32; 2]>,
    camera_info: serde_json::Value,
    source: Option<String>,
    marquee: TextEdit,
    marquee_cue: Option<(String, String)>,
    city_slot: Option<crate::weather::CitySlot>,
    city_query: TextEdit,
    city_results: Vec<crate::weather::Place>,
    city_searched: String,
    city_worker: Option<mpsc::Receiver<anyhow::Result<Vec<crate::weather::Place>>>>,
    headline: TextEdit,
    expanded_rundown: Option<String>,
    host_mic_settings: bool,
    headline_notice: Option<(String, &'static str)>,
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    camera: crate::virtual_camera::Camera,
}
impl Studio {
    fn dev_startup_studio(&self) -> PathBuf {
        let saved = std::fs::read(self.base.join("last-studio.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<PathBuf>(&bytes).ok())
            .filter(|path| path.components().all(|part| matches!(part, std::path::Component::Normal(_))))
            .map(|path| self.base.join(path));
        saved.filter(|path| path.join("room.json").is_file()).unwrap_or_else(|| self.base.clone())
    }

    fn new(base: PathBuf) -> Self {
        let rooms = catalog::catalog(&base);
        let error = rooms
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default();
        let (job_tx, job_rx) = mpsc::channel();
        Self {
            job_tx,
            job_rx,
            editor: None,
            set_library: Default::default(),
            chat: Default::default(),
            base,
            page: Page::Studios,
            rooms: rooms.unwrap_or_default(),
            error,
            live: None,
            wake_stop: Default::default(),
            name: TextEdit::new(""),
            starter: None,
            pending: None,
            quiet: std::env::var_os("PRODUCER_NO_AUTO_CAPTURE").is_some(),
            resize: None,
            editing_docks: false,
            drag_tile: None,
            studio_panels: false,
            moving_panel: None,
            drop_edge: None,
            panel_menu: None,
            set_selection: None,
            pending_trim: None,
            channels: Default::default(),
            naming: false,
            starter_images: None,
            pending_link: None,
            activity: false,
            switch_notice: None,
            show_chat: false,
            settings: Default::default(),
            network: Default::default(),
            publish: Default::default(),
            dj_deck: 0,
            sound_library: false,
            sound_query: TextEdit::new(""),
            pan_grab: None,
            people_settings: false,
            people: Default::default(),
            clip_settings: false,
            source_anchor: None,
            camera_info: Default::default(),
            source: None,
            marquee: TextEdit::new(""),
            marquee_cue: None,
            city_slot: None,
            city_query: TextEdit::new(""),
            studio_settings: None,
            mixer_scrub: None,
            city_searched: String::new(),
            city_results: vec![],
            city_worker: None,
            headline: TextEdit::new(""),
            expanded_rundown: None,
            host_mic_settings: false,
            headline_notice: None,
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            camera: Default::default(),
        }
    }
    fn open(&mut self, path: PathBuf) {
        self.settings.profile_open = false;
        self.switch_notice = None;
        if let Some(l) = &self.live {
            if l.handle.root == path {
                self.page = Page::Studio;
                return;
            }
            if let Some(reason) = l.switch_blocker() {
                self.switch_notice = Some(reason);
                return;
            }
        }
        match Live::start(path, self.pending.clone(), !self.quiet) {
            Ok(l) => {
                if std::env::var_os("PRODUCER_DEV_OPEN_LOCAL_ROOM").is_some() {
                    if let Ok(relative) = l.handle.root.strip_prefix(&self.base) {
                        if let (Ok(bytes), Ok(mut file)) = (
                            serde_json::to_vec(relative),
                            tempfile::NamedTempFile::new_in(&self.base),
                        ) {
                            use std::io::Write;
                            if file.write_all(&bytes).is_ok() {
                                let _ = file.persist(self.base.join("last-studio.json"));
                            }
                        }
                    }
                }
                #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                self.camera.stop();
                self.editor = None;
                self.studio_settings = None;
                self.mixer_scrub = None;
                self.set_selection = None;
                self.pending_link = None;
                self.activity = false;
                self.editing_docks = false;
                self.studio_panels = false;
                self.moving_panel = None;
                self.panel_menu = None;
                self.resize = None;
                self.drag_tile = None;
                self.drop_edge = None;
                self.city_worker = None;
                self.city_slot = None;
                self.marquee_cue = None;
                self.headline_notice = None;
                self.chat = Default::default();
                self.live = Some(l);
                self.channels = Default::default();
                channels::Channels::preferences(self);
                self.pending = None;
                self.page = Page::Studio;
                self.network = Default::default();
                self.people = Default::default();
                self.people_settings = false;
                self.error.clear();
                self.source = None;
                self.pending_trim = None;
                self.channels = Default::default();
                self.show_chat = false;
            }
            Err(e) => self.error = e.to_string(),
        }
    }
    fn send(&mut self, c: RoomCommand) {
        if let Some(l) = &mut self.live {
            match l.handle.send(c) {
                Ok(()) => l.updated = Instant::now() - Duration::from_secs(1),
                Err(e) => self.error = e.to_string(),
            }
        }
    }
    fn setup(&mut self, wake: Waker) {
        if std::env::var_os("PRODUCER_DEV_OPEN_LOCAL_ROOM").is_some() {
            self.open(self.dev_startup_studio());
        }
        let images = rune::ImageCache::new(wake.clone());
        self.starter_images = Some(Starter::ALL.map(|starter| images.load(starter.art())));
        self.set_library.setup(wake.clone());
        self.settings.restore(self.base.clone(), wake.clone());
        let stop = self.wake_stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(33));
                if !stop.load(Ordering::Acquire) {
                    wake();
                }
            }
        });
    }
    fn tick(&mut self, _: f64, _: &mut Tx) -> bool {
        let mut accounts =
            self.settings.poll(&mut self.error) | self.channels.poll(&mut self.error) | self.people.poll();
        accounts |= publish::poll(self) | network::poll(self) | self.set_library.poll();
        accounts |= people::poll_direct_invitation(self);
        if self.settings.account.is_some() {
            if let Some(kind) = self.pending_link.take() {
                panels::copy_link(self, kind);
                accounts = true;
            }
        }
        if let Some((brand, room)) = self.settings.created.take() {
            match crate::boomin_account::prepare_room(&self.base, &brand, &room, self.starter) {
                Ok(path) => self.open(path),
                Err(e) => self.error = e.to_string(),
            }
        }
        if let Some(result) = self.city_worker.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.city_worker = None;
            match result {
                Ok(places) => self.city_results = places,
                Err(e) => self.error = e.to_string(),
            }
            accounts = true;
        }
        while let Ok((root, result)) = self.job_rx.try_recv() {
            if self.live.as_ref().is_some_and(|l| l.handle.root == root) {
                self.error = result.unwrap_or_else(|e| e.to_string());
                accounts = true;
            }
        }
        let assistant_target = self.live.as_ref()
            .filter(|live| !live.handle.assistant_requests.lock().unwrap().is_empty())
            .and_then(|live| chat::target(self, &live.snapshot.project));
        if let Some(l) = &mut self.live {
            if self.editor.as_mut().is_some_and(|e| e.tick(l)) {
                self.editor = None;
                l.reviewing.store(false, Ordering::Release);
                let _ = l.handle.send(RoomCommand::SetEditPreview {
                    id: None,
                    draft: None,
                    layout: None,
                });
                accounts = true;
            }
            let assistant = &l.snapshot.project.workspace.panels[&PanelId::Assistant];
            let dock = &l.snapshot.project.workspace.docks[&assistant.edge];
            let mut changed_chat = false;
            if self.show_chat && (!assistant.visible || assistant.edge.side() || dock.hidden || !dock.collapsed || self.editor.is_some() || self.editing_docks) {
                self.show_chat = false;
                changed_chat = true;
            }
            if self.editor.as_mut().is_some_and(editor::Editor::take_assistant_save) {
                self.chat.saved_set();
                changed_chat = true;
            }
            changed_chat |= self.chat.tick(l, self.editor.as_ref(), assistant.visible && !dock.hidden, assistant_target);
            if self.editor.is_none() {
                if let Some(editor) = self.chat.take_review(l) {
                    self.editor = Some(editor);
                    self.show_chat = false;
                    changed_chat = true;
                }
            }
            match l.refresh() {
                Ok(changed) => accounts || changed || changed_chat,
                Err(e) => {
                    self.error = e;
                    true
                }
            }
        } else {
            accounts
        }
    }
    fn room_task(
        &self,
        task: impl FnOnce(&std::path::Path) -> anyhow::Result<String> + Send + 'static,
    ) {
        if let Some(l) = &self.live {
            let root = l.handle.root.clone();
            let tx = self.job_tx.clone();
            std::thread::spawn(move || {
                let result = task(&root);
                let _ = tx.send((root, result));
            });
        }
    }
    fn create(&mut self) {
        if let Some(a) = &self.settings.account {
            let name = self.name.text.trim();
            if name.is_empty() || name.chars().count() > 80 {
                self.error = "Enter a studio name (up to 80 characters)".into();
                return;
            }
            self.settings.dispatch(
                self.base.clone(),
                crate::boomin_account::Action::Create(
                    a.login.clone(),
                    name.into(),
                    self.settings.reference.clone(),
                ),
            );
            return;
        }
        {
            match catalog::create_room(&self.base, &self.name.text, self.starter) {
                Ok(p) => {
                    self.rooms = catalog::catalog(&self.base).unwrap_or_default();
                    self.open(p);
                }
                Err(e) => self.error = e.to_string(),
            }
        }
    }
    fn stop(&mut self) {
        self.wake_stop.store(true, Ordering::Release);
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        self.camera.stop();
        if let Some(l) = self.live.take() {
            let h = l.handle.clone();
            drop(l);
            let until = Instant::now() + Duration::from_secs(5);
            while !h.done.load(Ordering::Acquire) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
impl Drop for Studio {
    fn drop(&mut self) {
        self.stop();
    }
}
pub(super) fn run() {
    // Rune uses a function pointer to construct a fresh state for native and headless hosts.
    rune::App::new(AppSpec {
        setup: Some(Studio::setup),
        poll: Some(Studio::tick),
        on_key: Some(panels::layout_key),
        min_size: Some((580., 380.)),
        ..AppSpec::new(
            "Producer",
            (1320., 820.),
            || Studio::new(crate::workspace_root()),
            view,
        )
    })
    .window_options(rune::WindowOptions {
        transparent: cfg!(target_os = "macos"),
        ..Default::default()
    })
    .on_open_url(|s, url, _| {
        let Ok(uri) = url::Url::parse(url) else {
            return;
        };
        if uri.scheme() == "producer-rtc" && uri.host_str() == Some("join") {
            if let Some((_, v)) = uri.query_pairs().find(|(k, _)| k == "url") {
                if crate::rtc_signaling::parse(&v).is_ok() {
                    if let Some(l) = &s.live {
                        *l.handle.pending_rtc_link.lock().unwrap() = Some(v.into_owned());
                    } else {
                        s.pending = Some(v.into_owned());
                    }
                }
            }
        }
    })
    .on_quit(|s, _| s.stop())
    .run()
}
fn view(s: &Studio, cx: &mut Cx<Studio>) -> El {
    let palette = s.live.as_ref().filter(|_| s.page == Page::Studio).map(|l| l.snapshot.project.workspace.theme).unwrap_or_default();
    theme::with(palette, || desk_view(s, cx))
}
fn desk_view(s: &Studio, cx: &mut Cx<Studio>) -> El {
    cx.help_look(rune::HelpLook::system(true)
        .fill(color(0x16232e))
        .ink(color(TEXT))
        .ring(1., color(0x314251))
        .delay(0.08)
        .skip_delay(0.3));
    let width = cx.layout_size("app").map_or(1320., |v| v[0]);
    let height = cx.layout_size("app").map_or(820., |v| v[1]);
    let root = col().key("app").w_full().h_full().gap(4.);
    if s.page == Page::Studio && s.live.is_some() {
        if s.live.as_ref().unwrap().snapshot.producer_rtc["role"] == "guest" {
            return root.fill(color(BG)).child(panels::guest_stage(s));
        }
        if s.editor.is_some() {
            return root
                .child(panels::workspace(s, width, height).disabled(true))
                .child(editor::view(s, width, height));
        }
        if s.studio_settings == Some(settings::StudioSheet::DeskTheme) {
            return root
                .child(panels::workspace(s, width, height).disabled(true))
                .child(settings::theme_overlay(s, width, height));
        }
        return root.child(panels::workspace(s, width, height));
    }
    settings::shell(s, width, height)
}
