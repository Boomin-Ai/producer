use super::*;
use crate::boomin_account::{self, Account, Action, Login, Outcome};
pub(super) struct Identity {
    pub(super) account: Option<Account>,
    pub(super) avatar: Option<Arc<RenderImage>>,
    pending: Option<(Login, Vec<(String, String)>)>,
    email: Entity<SetTextField>,
    code: Entity<SetTextField>,
    enter_code: bool,
    form: bool,
    pub(super) local: bool,
    pub(super) busy: Option<&'static str>,
    pub(super) error: Option<String>,
    pub(super) reference: String,
}
impl Identity {
    pub(super) fn new(cx: &mut Context<Shell>) -> Self {
        Self {
            account: None,
            avatar: None,
            pending: None,
            email: cx.new(|cx| SetTextField::new(String::new(), cx)),
            code: cx.new(|cx| SetTextField::new(String::new(), cx)),
            enter_code: false,
            form: false,
            local: false,
            busy: None,
            error: None,
            reference: String::new(),
        }
    }
}
impl Shell {
    pub(super) fn refresh_rooms(&mut self) -> Result<()> {
        self.rooms = if let Some(a) = self
            .identity
            .account
            .as_ref()
            .filter(|_| !self.identity.local)
        {
            a.rooms
                .iter()
                .map(|r| RoomEntry {
                    title: r.title.clone().unwrap_or_else(|| "Studio".into()),
                    path: boomin_account::room_path(&self.base, &a.login.brand, r.id),
                    main: r.is_default,
                })
                .collect()
        } else {
            catalog(&self.base)?
        };
        Ok(())
    }
    pub(super) fn open_card(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if let Some(a) = self
            .identity
            .account
            .as_ref()
            .filter(|_| !self.identity.local)
        {
            let Some(r) = a
                .rooms
                .iter()
                .find(|r| boomin_account::room_path(&self.base, &a.login.brand, r.id) == path)
            else {
                return;
            };
            if let Err(e) = boomin_account::prepare_room(&self.base, &a.login.brand, r) {
                self.notice = Some(e.to_string());
                cx.notify();
                return;
            }
        }
        self.open(path, cx)
    }
    pub(super) fn account_action(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.identity.busy.is_some() || self.switching {
            return;
        }
        if matches!(action, Action::Switch(..) | Action::SignOut)
            && self.active.lock().unwrap().is_some()
        {
            let h = self.active.lock().unwrap().clone().unwrap();
            if self.has_active_session(&h, cx) {
                self.identity.error =
                    Some("End the active studio session before changing accounts.".into());
                cx.notify();
                return;
            }
            if let Some(studio) = self.studio.take() {
                studio.update(cx, |r, _| r.retiring = true);
            }
            h.closed.store(true, Ordering::Release);
            self.switching = true;
            cx.spawn(async move |this, cx| {
                while !h.done.load(Ordering::Acquire) {
                    cx.background_executor()
                        .timer(Duration::from_millis(30))
                        .await;
                }
                let _ = this.update(cx, |s, cx| {
                    *s.active.lock().unwrap() = None;
                    s.switching = false;
                    s.account_action(action, cx);
                });
            })
            .detach();
            return;
        }
        let message = match &action {
            Action::Restore => "Opening your workspace…",
            Action::RequestCode(_) => "Sending code…",
            Action::Verify(..) => "Verifying code…",
            Action::Switch(..) => "Opening workspace…",
            Action::SignOut => "Signing out…",
            Action::Create(..) => "Creating room…",
        };
        self.identity.busy = Some(message);
        self.identity.error = None;
        let base = self.base.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { boomin_account::run(&base, action) })
                .await;
            let _ = this.update(cx, |s, cx| {
                s.identity.busy = None;
                match result {
                    Ok(Outcome::Local) => {
                        s.identity = Identity::new(cx);
                        s.profile = "Producer".into();
                        s.profile_open = false;
                        let _ = s.refresh_rooms();
                    }
                    Ok(Outcome::CodeSent) => {
                        s.identity.enter_code = true;
                    }
                    Ok(Outcome::Pick(l, brands)) => {
                        s.identity.pending = Some((l, brands));
                        s.profile_open = true;
                    }
                    Ok(out) => {
                        let (mut a, new_room) = match out {
                            Outcome::Authenticated(a) => (a, None),
                            Outcome::Created(a, id) => (a, Some(id)),
                            _ => unreachable!(),
                        };
                        s.profile = a.name.clone();
                        s.identity = Identity::new(cx);
                        s.identity.avatar = a
                            .avatar
                            .take()
                            .map(|i| Arc::new(RenderImage::new([image::Frame::new(i)])));
                        s.identity.account = Some(a);
                        s.profile_open = false;
                        s.room_name = None;
                        let _ = s.refresh_rooms();
                        if let Some(id) = new_room {
                            let a = s.identity.account.as_ref().unwrap();
                            s.open_card(boomin_account::room_path(&s.base, &a.login.brand, id), cx);
                        }
                    }
                    Err(e) => {
                        s.identity.error = Some(e.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn advance_setup(&mut self, next: FirstLight, cx: &mut Context<Self>) {
        let marker = if next == FirstLight::Permissions { "permissions" } else { "complete" };
        let result = fs::create_dir_all(&self.base)
            .and_then(|_| fs::write(self.base.join("setup-stage"), marker));
        match result {
            Ok(()) => { self.first_light = next; self.notice = None; }
            Err(err) => self.notice = Some(format!("Could not save setup progress: {err}")),
        }
        cx.notify();
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub(super) fn setup_screen(&self, _window: &mut Window, cx: &mut Context<Self>) -> Div {
        extern "C" { fn nr_setup_access(kind: i32) -> i32; fn nr_setup_request(kind: i32); }
        let mut body = stack().w(px(420.)).gap(px(14.)).child(label("Producer · by Boomin"));
        if self.first_light == FirstLight::Welcome {
            body = body.child(div().text_size(px(30.)).child("Your studio starts here."))
                .child("Build your set, bring in guests, and take your show live.")
                .child(Room::edit_button("setup-next", "Continue to setup", true)
                    .debug_selector(|| "setup-next".into())
                    .on_click(cx.listener(|s, _, _, cx| s.advance_setup(FirstLight::Permissions, cx))));
        } else {
            // Authorization can change while System Settings is in the foreground.

            body = body.child(div().text_size(px(30.)).child("Give your studio access."));
            for (kind, title, pane) in [(0, "Camera", "Camera"), (1, "Microphone", "Microphone"), (2, "Screen recording", "ScreenCapture")] {
                let access = unsafe { nr_setup_access(kind) };
                let name = if access == 1 { format!("{title} · Allowed") } else { format!("Allow {title}") };
                let mut row = Room::edit_button(format!("setup-access-{kind}"), name, access == 1);
                if access != 1 {
                    row = row.on_click(cx.listener(move |_, _, _, cx| {
                        if access >= 0 { unsafe { nr_setup_request(kind); } }
                        if access < 0 || kind == 2 {
                            cx.open_url(&format!("x-apple.systempreferences:com.apple.preference.security?Privacy_{pane}"));
                        }
                        cx.notify();
                    }));
                }
                body = body.child(row);
            }
            let (camera_status, actionable) = crate::virtual_camera::install_status();
            body = if actionable {
                body.child(Room::edit_button("setup-install-virtual-camera", camera_status, false)
                    .on_click(|_, _, _| crate::virtual_camera::install()))
            } else { body.child(camera_status) };
            body = body.child(Room::edit_button("setup-finish", "Continue", true)
                .debug_selector(|| "setup-finish".into())
                    .on_click(cx.listener(|s, _, _, cx| s.advance_setup(FirstLight::Complete, cx))));
        }
        if let Some(err) = &self.notice { body = body.child(err.clone()); }
        stack().size_full().bg(rgb(BG)).text_color(rgb(0xe8ecf3))
            .child(div().h(px(28.)).window_control_area(WindowControlArea::Drag))
            .child(div().flex_1().flex().items_center().justify_center().child(body))
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub(super) fn entry_screen(&self, cx: &mut Context<Self>) -> Div {
        let mut screen = stack().size_full().bg(rgb(BG)).text_color(rgb(0xe8ecf3))
            .child(div().h(px(28.)).window_control_area(WindowControlArea::Drag));
        let heading = if self.identity.pending.is_some() {
            "Choose your workspace"
        } else if self.identity.enter_code {
            "Check your inbox"
        } else {
            "Sign in to Producer"
        };
        let mut card = stack().w(px(380.)).gap(px(12.)).child(label("Producer"));
        if self.identity.busy == Some("Opening your workspace…") {
            card = card.child("Opening your workspace…");
        } else {
            card = card.child(div().text_size(px(28.)).child(heading));
            if !self.identity.enter_code && self.identity.pending.is_none() {
                card = card.child("Use your Boomin email to open your workspace.");
            }
            card = card.child(self.account_contents(true, cx));
            if self.identity.busy.is_none() && !self.identity.enter_code && self.identity.pending.is_none() {
                card = card.child(Room::edit_button("create-account", "Create a Boomin account", false)
                    .on_click(|_, _, cx| cx.open_url("https://boomin.ai/signup")));
            }
            #[cfg(debug_assertions)]
            if self.identity.busy.is_none() {
                card = card.child(Room::edit_button("entry-local", "Rooms on this Mac", false)
                    .debug_selector(|| "entry-local".into())
                    .on_click(cx.listener(|s, _, _, cx| {
                        s.identity.local = true;
                        s.profile_open = false;
                        cx.notify();
                    })));
            }
        }
        screen = screen.child(div().flex_1().flex().justify_center().items_center().child(card));
        screen
    }
    pub(super) fn account_contents(&self, entry: bool, cx: &mut Context<Self>) -> Div {
        let i = &self.identity;
        let mut body = stack().gap(px(7.)).p(px(6.));
        if !entry { body = body.child(label("YOU")); }
        if let Some((login, brands)) = &i.pending {
            body = body.child(label("Choose your brand workspace"));
            for (slug, name) in brands {
                let l = login.clone();
                let slug = slug.clone();
                body = body.child(
                    Room::edit_button(format!("pick-{slug}"), name.clone(), false).on_click(
                        cx.listener(move |s, _, _, cx| {
                            s.account_action(Action::Switch(l.clone(), slug.clone()), cx)
                        }),
                    ),
                );
            }
        } else if let Some(a) = &i.account {
            body = body
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(self.avatar())
                        .child(stack().child(a.name.clone()).child(div().text_color(rgb(MUTED)).child(a.email.clone()))),
                )
                .child(detail_row("Sign-in", &a.method));
            if let Some(on) = a.two_factor {
                body = body.child(detail_row("Two-factor", if on { "On" } else { "Off" }));
            } else {
                body = body.child(
                    Room::edit_button("account-web", "Manage account on boomin.ai ↗", false)
                        .on_click(|_, _, cx| cx.open_url("https://boomin.ai")),
                );
            }
            body = body.child(label("BRAND WORKSPACES"));
            for (slug, name) in &a.brands {
                let l = a.login.clone();
                let slug = slug.clone();
                body = body.child(
                    Room::edit_button(
                        format!("switch-{slug}"),
                        name.clone(),
                        slug == a.login.brand && !i.local,
                    )
                    .on_click(cx.listener(move |s, _, _, cx| {
                        s.account_action(Action::Switch(l.clone(), slug.clone()), cx)
                    })),
                );
            }
            body = body
                .child(
                    Room::edit_button("local-workspace", "Rooms on this Mac", i.local).on_click(
                        cx.listener(|s, _, _, cx| {
                            s.identity.local = true;
                            s.profile_open = false;
                            s.room_name = None;
                            let _ = s.refresh_rooms();
                            cx.notify();
                        }),
                    ),
                )
                .child(
                    Room::edit_button("sign-out", "Sign out of Boomin", false)
                        .on_click(cx.listener(|s, _, _, cx| s.account_action(Action::SignOut, cx))),
                );
        } else if entry || i.form {
            let verify = i.enter_code;
            body = body
                .child(label(if verify {
                    "Enter the code Boomin emailed you"
                } else {
                    "Boomin email"
                }))
                .child(if verify {
                    i.code.clone()
                } else {
                    i.email.clone()
                })
                .child(
                    Room::edit_button(
                        "submit-account",
                        if verify {
                            "Verify code"
                        } else {
                            "Send sign-in code"
                        },
                        true,
                    )
                    .debug_selector(|| "submit-account".into())
                    .on_click(cx.listener(move |s, _, _, cx| {
                        let email = s.identity.email.read(cx).value.trim().to_string();
                        let code = s.identity.code.read(cx).value.trim().to_string();
                        if !email.contains('@') || (verify && code.is_empty()) {
                            s.identity.error = Some("Enter a valid email and sign-in code.".into());
                            cx.notify();
                            return;
                        }
                        s.account_action(
                            if verify {
                                Action::Verify(email, code)
                            } else {
                                Action::RequestCode(email)
                            },
                            cx,
                        );
                    })),
                );
            if verify {
                body = body.child(
                    Room::edit_button(
                        "change-email",
                        "Change email or request another code",
                        false,
                    )
                    .on_click(cx.listener(|s, _, _, cx| {
                        s.identity.enter_code = false;
                        cx.notify();
                    })),
                );
            }
        } else {
            body = body.child(detail_row("Boomin", "Signed out")).child(
                Room::edit_button("start-sign-in", "Sign in to Boomin", true).on_click(
                    cx.listener(|s, _, w, cx| {
                        s.identity.form = true;
                        s.identity.error = None;
                        s.identity.email.read(cx).focus_handle(cx).focus(w, cx);
                        cx.notify();
                    }),
                ),
            );
        }
        if let Some(e) = &i.error {
            body = body.child(div().text_color(rgb(0xffadb3)).child(e.clone()));
        }
        if let Some(status) = i.busy {
            body = body.child(label(status));
        }
        body
    }
}
