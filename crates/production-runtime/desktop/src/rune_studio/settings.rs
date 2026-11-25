use super::*;
use crate::boomin_account::{self, Account, Action, Login, Outcome};
pub(super) struct Settings {
    pub(super) profile_open: bool,
    pub(super) created: Option<(String, boomin_account::RemoteRoom)>,
    pub(super) reference: String,
    section: Section,
    shortcuts: bool,
    avatar: Option<rune::Pixels>,
    email: TextEdit,
    code: TextEdit,
    code_sent: bool,
    choosing_workspace: bool,
    pub(super) account: Option<Account>,
    pick: Option<(Login, Vec<(String, String)>)>,
    pending: Option<mpsc::Receiver<Result<Outcome, String>>>,
    wake: Option<Waker>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            profile_open: false,
            created: None,
            reference: String::new(),
            section: Section::App,
            shortcuts: false,
            avatar: None,
            email: TextEdit::new(""),
            code: TextEdit::new(""),
            code_sent: false,
            choosing_workspace: false,
            account: None,
            pick: None,
            pending: None,
            wake: None,
        }
    }
}
impl Settings {
    pub fn restore(&mut self, base: PathBuf, wake: Waker) {
        self.wake = Some(wake);
        self.dispatch(base, Action::Restore);
    }
    pub(super) fn dispatch(&mut self, base: PathBuf, action: Action) {
        if self.pending.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        self.pending = Some(rx);
        let wake = self.wake.clone();
        std::thread::spawn(move || {
            let result = boomin_account::run(&base, action).map_err(|e| e.to_string());
            let _ = tx.send(result);
            if let Some(w) = wake {
                w();
            }
        });
    }
    pub fn poll(&mut self, error: &mut String) -> bool {
        let Some(rx) = &self.pending else {
            return false;
        };
        let result = match rx.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => return false,
            Err(_) => Err("Boomin account operation interrupted".into()),
        };
        self.pending = None;
        let result = result.map(|outcome| match outcome {
            Outcome::Created(a, id) => {
                self.created = a
                    .rooms
                    .iter()
                    .find(|r| r.id == id)
                    .map(|r| (a.login.brand.clone(), r.clone()));
                if self.created.is_none() {
                    *error = "Studio created. Refresh your workspace to open it.".into();
                }
                Outcome::Authenticated(a)
            }
            other => other,
        });
        match result {
            Ok(Outcome::Created(..)) => unreachable!(),
            Ok(Outcome::Authenticated(a)) => {
                self.avatar = a.avatar.as_ref().map(|img| {
                    let p = rune::Pixels::new();
                    p.set(img.width(), img.height(), img.as_raw().clone());
                    p
                });
                self.choosing_workspace = false;
                self.account = Some(a);
                self.pick = None;
                self.code_sent = false;
                self.code = TextEdit::new("");
            }
            Ok(Outcome::Pick(login, brands)) => {
                self.pick = Some((login, brands));
            }
            Ok(Outcome::CodeSent) => self.code_sent = true,
            Ok(Outcome::Local) => {
                self.choosing_workspace = false;
                self.avatar = None;
                self.account = None;
                self.pick = None;
                self.code_sent = false;
            }
            Err(e) => *error = e,
        }
        true
    }
}
pub(super) fn account(s: &Studio) -> El {
    let prefs = &s.settings;
    let mut body = col()
        .padding(18.)
        .gap(7.)
        .child(title("Boomin account", 18., 650., TEXT));
    if prefs.pending.is_some() {
        body = body.child(title("Connecting…", 13., 450., MUTED));
    } else if let Some((login, brands)) = &prefs.pick {
        for (id, name) in brands {
            let (login, id) = (login.clone(), id.clone());
            body = body.child(button(format!("brand-{id}"), name, false, move |s| {
                s.settings
                    .dispatch(s.base.clone(), Action::Switch(login.clone(), id.clone()))
            }));
        }
    } else if let Some(a) = &prefs.account {
        let active = a.brands.iter().find(|(slug, _)| slug == &a.login.brand)
            .map_or(a.login.brand.as_str(), |(_, name)| name.as_str());
        body = body.child(title(&a.email, 12., 450., MUTED))
            .child(title("Current workspace", 12., 500., MUTED))
            .child(button("workspace-picker", active, true, |s| {
                s.settings.choosing_workspace = !s.settings.choosing_workspace;
            }));
        if prefs.choosing_workspace {
            for (id, name) in a.brands.iter().filter(|(slug, _)| slug != &a.login.brand) {
                let login = a.login.clone();
                let id = id.clone();
                body = body.child(button(format!("brand-{id}"), name, false, move |s| {
                    s.settings.dispatch(s.base.clone(), Action::Switch(login.clone(), id.clone()));
                }));
            }
        }
        body = body.child(button("sign-out", "Sign out", false, |s| {
            s.settings.dispatch(s.base.clone(), Action::SignOut)
        }));
    } else {
        body = body
            .child(button("use-producer-login", "Use my Producer sign-in", false, |s| {
                s.error.clear();
                s.settings.dispatch(s.base.clone(), Action::UseProducerLogin);
            }))
            .child(title("Email", 12., 550., MUTED))
            .child(field("email", &prefs.email, |s| &mut s.settings.email))
            .child(button("send-code", "Send verification code", false, |s| {
                s.settings.dispatch(
                    s.base.clone(),
                    Action::RequestCode(s.settings.email.text.trim().into()),
                )
            }));
        if prefs.code_sent {
            body = body
                .child(title("Verification code", 12., 550., MUTED))
                .child(field("code", &prefs.code, |s| &mut s.settings.code))
                .child(button("verify", "Sign in", true, |s| {
                    s.settings.dispatch(
                        s.base.clone(),
                        Action::Verify(
                            s.settings.email.text.trim().into(),
                            s.settings.code.text.trim().into(),
                        ),
                    )
                }));
        }
    }
    body
}
pub(super) fn open_studio(s: &mut Studio) {
    s.settings.section = Section::App;
    s.studio_settings = true;
}

pub(super) fn open_output(s: &mut Studio) {
    s.settings.section = Section::Output;
    if s.page == Page::Studio {
        s.studio_settings = true;
    } else {
        s.page = Page::Settings;
    }
}

fn output(s: &Studio) -> El {
    let mut body = col().key("output-settings")
        .gap(10.)
        .child(detail("Video", "H.264 · 30 fps"))
        .child(detail("Program audio", "AAC · 48 kHz stereo"))
        .child(detail(
            "Orientation",
            "Landscape or portrait per destination",
        ));
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let (status, can_install) = crate::virtual_camera::install_status();
        body = body
            .child(title("Virtual camera", 18., 650., TEXT))
            .child(title(status, 13., 450., MUTED));
        if can_install {
            body = body.child(button(
                "install-camera",
                "Set up virtual camera",
                false,
                |_| crate::virtual_camera::install(),
            ));
        }
        if s.live.is_some() {
            if s.camera.active() {
                body = body.child(button("stop-camera", "Stop virtual camera", true, |s| {
                    s.camera.stop()
                }));
            } else {
                for (portrait, name) in [(false, "Start landscape"), (true, "Start portrait")] {
                    body = body.child(button(name, name, false, move |s| {
                        if let Some(l) = &s.live {
                            s.camera.start(l.handle.clone(), portrait)
                        }
                    }));
                }
            }
            body = body.child(title(s.camera.status(), 12., 450., MUTED));
        }
    }
    body
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    App,
    Integrations,
    Output,
}

impl Section {
    fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::App => ("App", "Version and shortcuts"),
            Self::Integrations => ("Integrations", "Live destinations"),
            Self::Output => ("Output", "Encoder and program formats"),
        }
    }
}

fn rail_button(
    key: &'static str,
    label: &'static str,
    artwork: El,
    selected: bool,
    f: impl Fn(&mut Studio) + 'static,
) -> El {
    let base = el()
        .key(key)
        .size(38., 38.)
        .radius(11.)
        .center()
        .role("button")
        .label(label)
        .focusable(true);
    let base = if selected {
        base.fill(color(0xf7f7f7))
    } else {
        base
    };
    base.child(artwork).on_press(f)
}

fn icon(name: &str, selected: bool) -> El {
    rune::icon(glyphs::glyph(name), 18.).color(color(if selected { BG } else { TEXT }))
}

fn detail(label: &str, value: &str) -> El {
    col()
        .w_full()
        .child(
            row()
                .h(50.)
                .items_center()
                .child(title(label, 14., 500., TEXT))
                .child(el().grow(1.))
                .child(title(value, 14., 450., MUTED)),
        )
        .child(el().w_full().h(1.).fill(color(0x1b2a37)))
}

fn preferences(s: &Studio, name: &str, narrow: bool) -> El {
    let (heading, sub) = s.settings.section.labels();
    let body = col()
        .w_full()
        .padding(if narrow { 16. } else { 48. })
        .gap(13.)
        .child(title(heading, 22., 700., TEXT))
        .child(title(format!("{sub} · {name}"), 13., 450., MUTED))
        .child(el().w_full().h(1.).fill(color(0x253442)));
    match s.settings.section {
        Section::App => {
            let body = body.child(
                row()
                    .gap(6.)
                    .child(button("general", "General", !s.settings.shortcuts, |s| {
                        s.settings.shortcuts = false
                    }))
                    .child(button(
                        "shortcuts",
                        "Shortcuts",
                        s.settings.shortcuts,
                        |s| s.settings.shortcuts = true,
                    )),
            );
            if s.settings.shortcuts {
                body.child(detail("Edit studio layout", "⌘ E"))
                    .child(detail("Dismiss a menu", "Esc"))
            } else {
                body.child(detail("Workspace", name))
                    .child(detail("Build", env!("CARGO_PKG_VERSION")))
            }
        }
        Section::Output => body.child(output(s)),

        Section::Integrations => body.child(channels::preferences(s)),
    }
}

pub(super) fn studio_overlay(s: &Studio, width: f32, height: f32) -> El {
    let name = s.settings.account.as_ref().map_or("Local workspace", |a| a.name.as_str());
    let w = (width - 32.).min(600.);
    let h = (height - 64.).min(480.);
    let mut tabs = row().gap(5.);
    for section in [Section::App, Section::Integrations, Section::Output] {
        let (label, _) = section.labels();
        tabs = tabs.child(button(format!("prefs-{label}"), label, s.settings.section == section, move |s| {
            s.settings.section = section;
            if section == Section::Integrations {
                channels::Channels::preferences(s);
            }
        }));
    }
    el().key("studio-settings-backdrop").absolute(0., 0.).w_full().h_full()
        .fill(Color::BLACK.alpha(0.56))
        .child(
            col().key("studio-settings-sheet").absolute((width - w) / 2., (height - h) / 2.)
                .size(w, h).radius(12.).clip_rounded(12.).border(1., color(0x304151))
                .role("dialog").label("Studio settings").focus_return("studio-settings")
                .fill(color(PANEL))
                .child(row().h(48.).px(16.).items_center()
                    .child(title("Studio settings", 16., 650., TEXT))
                    .child(el().grow(1.))
                    .child(button("close-studio-settings", "Done", false, |s| s.studio_settings = false)))
                .child(tabs.px(16.))
                .child(col().h(0.).grow(1.).min_h(0.)
                    .child(preferences(s, name, true)).scroll(Default::default())),
        )
}

pub(super) fn shell(s: &Studio, width: f32, height: f32) -> El {
    let settings = s.page == Page::Settings;
    let name = s
        .settings
        .account
        .as_ref()
        .map_or("Local workspace", |a| a.name.as_str());
    let mut rail = col()
        .w(72.)
        .h_full()
        .items_center()
        .gap(10.)
        .child(el().h(44.).w_full().window_drag());
    if settings {
        rail = rail.child(rail_button(
            "back",
            "Back to Studios",
            icon("back", false),
            false,
            |s| s.page = Page::Studios,
        ));
    } else {
        let avatar = if let Some(p) = &s.settings.avatar {
            el().size(38., 38.)
                .clip_rounded(19.)
                .pixels_fit(p, SurfaceFit::Fill)
        } else {
            el().size(38., 38.)
                .radius(19.)
                .fill(color(0x384966))
                .center()
                .child(icon("profile", false))
        };
        let avatar = if s.settings.account.is_some() {
            el().size(38., 38.).child(avatar).child(
                el().absolute(28., 28.)
                    .size(11., 11.)
                    .radius(6.)
                    .fill(color(MINT))
                    .border(2., color(BG)),
            )
        } else {
            avatar
        };
        rail = rail.child(rail_button(
            "profile",
            "Workspace account",
            avatar,
            false,
            |s| {
                s.settings.profile_open = true;
            },
        ));
    }
    rail = rail
        .child(rail_button(
            "studios",
            "Studios",
            icon("live", !settings),
            !settings,
            |s| s.page = Page::Studios,
        ))
        .child(el().grow(1.))
        .child(rail_button(
            "settings",
            "Settings",
            icon("settings", settings),
            settings,
            |s| {
                s.settings.section = Section::App;
                s.page = Page::Settings;
            },
        ))
        .child(el().h(12.));
    let narrow = width < 800.;
    let nav_width = if narrow { 0. } else { 300. };
    let sidebar_width = 72. + if settings { nav_width } else { 0. };
    const CONTENT_RADIUS: f32 = 16.;
    // Extend the rail material beneath the rounded inner corners.
    // Rounded content corners expose the same material as the navigation rail.
    let backdrop = el()
        .key("shell-material")
        .absolute(0., 0.)
        .w(sidebar_width + CONTENT_RADIUS)
        .h_full()
        .fill(color(0x343d49))
        .system_material(rune::SystemMaterial::Glass);
    let mut navigation = row().w(sidebar_width).h_full().child(rail);
    let mut sections = if narrow { row().gap(4.) } else { col().gap(4.) };
    if settings {
        for section in [Section::App, Section::Integrations, Section::Output] {
            let (label, help) = section.labels();
            let mut item = col()
                .key(format!("prefs-{label}"))
                .radius(10.)
                .padding(if narrow { 8. } else { 12. })
                .gap(5.)
                .role("button")
                .focusable(true)
                .label(label)
                .child(title(label, 14., 650., TEXT));
            if section == s.settings.section {
                item = item.fill(Color::WHITE.alpha(0.13));
            }
            if !narrow {
                item = item.child(title(help, 12., 450., TEXT));
            }
            sections = sections.child(item.on_press(move |s: &mut Studio| {
                s.settings.section = section;
                if section == Section::Integrations {
                    channels::Channels::preferences(s);
                }
            }));
        }
    }
    let mut content = col()
        .grow(1.)
        .min_w(0.)
        .h_full()
        .corners([CONTENT_RADIUS, 0., 0., CONTENT_RADIUS])
        .clip_corners([CONTENT_RADIUS, 0., 0., CONTENT_RADIUS])
        .fill(color(0x03111e))
        .child(el().h(28.).w_full().window_drag());
    if let Some(reason) = s.switch_notice {
        content = content.child(button("studio-switch-notice", reason, false, |s| s.switch_notice = None));
    }
    if !s.error.is_empty() {
        content = content.child(button("notice", s.error.clone(), false, |s| {
            s.error.clear()
        }));
    }
    if settings {
        if narrow {
            content = content.child(sections);
        } else {
            navigation = navigation.child(
                col()
                    .w(nav_width)
                    .padding(16.)
                    .gap(16.)
                    .child(el().h(24.).w_full().window_drag())
                    .child(title(
                        format!("›  Studios    Settings · {name}"),
                        13.,
                        650.,
                        TEXT,
                    ))
                    .child(title(
                        concat!("Producer    ", env!("CARGO_PKG_VERSION")),
                        13.,
                        550.,
                        TEXT,
                    ))
                    .child(
                        sections
                            .border(1., Color::WHITE.alpha(0.16))
                            .radius(12.)
                            .padding(6.),
                    ),
            );
        }
        content = content.child(preferences(s, name, narrow).scroll(Default::default()));
    } else if s.page == Page::Starters {
        content = content.child(catalog::starters(s, width - 72.));
    } else {
        content = content.child(catalog::studios(s, width - 72.));
    }
    let root = row()
        .key("app")
        .w_full()
        .h_full()
        .child(backdrop)
        // Production uses vibrant-dark HUD glass. Keep text legible when
        // the Rune sidebar material picks up a bright desktop or window.
        .child(el().key("shell-glass-tint").absolute(0., 0.)
            .w(sidebar_width + CONTENT_RADIUS).h_full().fill(color(0x141414).alpha(0.58)))
        .child(navigation)
        .child(content);
    if !s.settings.profile_open || settings {
        return root;
    }
    root.child(
        el().absolute(0., 0.)
            .w_full()
            .h_full()
            .key("dismiss-profile")
            .on_press(|s: &mut Studio| s.settings.profile_open = false),
    )
    .child(
        col()
            .key("profile-sheet")
            .absolute(78., 46.)
            .w((width - 90.).clamp(120., 312.))
            .h((height - 60.).clamp(80., if s.settings.choosing_workspace || s.settings.account.is_none() {380.} else {230.})).min_h(0.).clip_rounded(12.)
            .radius(12.)
            .fill(color(PANEL))
            .border(1., color(0x263443))
            .child(
                row()
                    .px(16.)
                    .h(42.)
                    .items_center()
                    .child(title(name, 14., 650., TEXT))
                    .child(el().grow(1.))
                    .child(button("close-profile", "Close", false, |s| {
                        s.settings.profile_open = false
                    })),
            )
            .child(account(s).min_h(0.).grow(1.).scroll(Default::default())),
    )
}
