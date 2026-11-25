use super::*;

#[derive(Default, Clone, Copy, PartialEq)]
pub(super) enum Route {
    #[default]
    Invitation,
    Direct,
    Lan,
    Hosted,
}
#[derive(Default)]
pub(super) struct People {
    route: Route,
    hosting: Option<(String, bool)>,
    checking: Option<mpsc::Receiver<(String, bool)>>,
    invitation_copy: Option<mpsc::Receiver<anyhow::Result<String>>>,
    invitation_result: Option<Result<String, String>>,
    waiting_for_link: Option<Instant>,
    portrait: bool,
    details: bool,
    remove: bool,
}
impl People {
    pub fn refresh(s: &mut Studio) {
        if s.people.checking.is_some() {
            return;
        }
        let Some(account) = &s.settings.account else {
            s.people.hosting = Some(("Workspace unavailable · check sign-in".into(), false));
            return;
        };
        let base = s.base.clone();
        let brand = account.login.brand.clone();
        let (tx, rx) = mpsc::channel();
        s.people.checking = Some(rx);
        std::thread::spawn(move || {
            let query = || -> anyhow::Result<(String, bool)> {
                let token = crate::boomin_account::room_token(&base, &brand)?;
                let mut url = url::Url::parse("https://api.boomin.ai/v1/app/media-server")?;
                url.query_pairs_mut().append_pair("brandSlug", &brand);
                let result = crate::rtc_signaling::request("GET", url.as_str(), &token, None)?;
                Ok(match result["status"].as_str() {
                    Some("active" | "trialing") => (format!("{brand} · Hosting available"), true),
                    Some("inactive") => (format!("{brand} · Hosting inactive"), false),
                    _ => ("Workspace unavailable · check sign-in".into(), false),
                })
            };
            let _ =
                tx.send(query().unwrap_or_else(|_| ("Hosting unavailable · retry".into(), false)));
        });
    }
    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        if let Some(receiver) = &self.invitation_copy {
            let result = match receiver.try_recv() {
                Ok(result) => Some(result.map_err(|error| error.to_string())),
                Err(mpsc::TryRecvError::Disconnected) => {
                    Some(Err("Couldn’t copy the invitation. Try again.".into()))
                }
                Err(mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                self.invitation_copy = None;
                self.invitation_result = Some(result);
                changed = true;
            }
        }
        if let Some(result) = self.checking.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.hosting = Some(result);
            self.checking = None;
            return true;
        }
        changed
    }
    pub fn copying_invitation(&self) -> bool {
        self.invitation_copy.is_some() || self.waiting_for_link.is_some()
    }
    pub fn copy_invitation(&mut self, copy: impl FnOnce() -> anyhow::Result<String> + Send + 'static) {
        self.invitation_result = None;
        let (tx, rx) = mpsc::channel();
        self.invitation_copy = Some(rx);
        std::thread::spawn(move || {
            let _ = tx.send(copy());
        });
    }
    pub fn invitation_feedback(&self) -> Option<El> {
        let (message, tint) = match self.invitation_result.as_ref()? {
            Ok(message) => (message, MINT),
            Err(message) => (message, 0xe9b666),
        };
        Some(text(message.clone()).key("guest-invitation-feedback")
            .font(TextStyle::new(11., 500.)).color(color(tint)).wrap())
    }
}
pub(super) fn trigger(s: &Studio) -> El {
    panels::tool(
        "people-session",
        "settings",
        "Guest connection",
        s.people_settings,
        |s| {
            s.people_settings = !s.people_settings;
            if s.people_settings {
                People::refresh(s);
            }
        },
    )
    .size(26., 26.)
}
pub(super) fn guest_link(s: &mut Studio) {
    panels::copy_link(s, crate::room_share::LinkKind::Guest);
}

pub(super) fn audience_live(s: &Studio) -> bool {
    s.live.as_ref().is_some_and(|live| live.handle.media.lock().unwrap()
        .as_ref().is_some_and(|media| media.broadcast.sending_to_studio_site()))
}

pub(super) fn panel_header(s: &Studio, waiting: usize) -> El {
    let mut header = row().items_center().gap(5.)
        .child(title("People", 15., 650., TEXT));
    if waiting > 0 {
        header = header.child(title(format!("{waiting} waiting"), 10., 550., MINT));
    }
    header = header.child(el().grow(1.)).child(trigger(s));
    let mut controls = col().gap(5.).child(header);
    if audience_live(s) || s.live.as_ref().is_some_and(|live| live.handle.root.join("boomin/audience-open").is_file()) {
        controls = controls.child(button("audience-link", "Copy audience link", false, |s| {
            panels::copy_link(s, crate::room_share::LinkKind::Audience);
        }).disabled(!audience_live(s)));
    }
    controls
}

pub(super) fn empty_guest(s: &Studio) -> El {
    let busy = s.people.copying_invitation();
    col().key("people-empty-guest").padding(10.).gap(7.)
        .radius(8.).fill(color(0x111d28)).border(1., color(0x273745))
        .child(row().gap(8.).items_center()
            .child(el().size(30., 30.).radius(7.).fill(color(0x1b2d39)).center()
                .child(rune::icon(glyphs::glyph("profile"), 17.).color(color(MUTED))))
            .child(col().min_w(0.).gap(2.)
                .child(title("Guest slot", 12., 650., TEXT))
                .child(title("Invite someone into your studio", 10., 450., MUTED))))
        .child(button("guest-link", if busy { "Preparing link…" } else { "Invite a guest…" }, false, guest_link)
            .disabled(busy))
}

pub(super) fn start_direct_invitation(s: &mut Studio) -> bool {
    let Some(live) = &s.live else { return false };
    if s.people.route == Route::Hosted || !crate::producer_rtc::Peer::can_host_direct(&live.handle.root) {
        return false;
    }
    let rtc = &live.snapshot.producer_rtc;
    if rtc["phase"] != "idle" {
        s.people.invitation_result = Some(Err("End the current guest session before inviting someone else.".into()));
        return true;
    }
    s.people.invitation_result = None;
    s.people.waiting_for_link = Some(Instant::now() + Duration::from_secs(20));
    if let Err(error) = live.handle.send(RoomCommand::RtcStart {
        display_name: None,
        link: None,
        lan: s.people.route == Route::Lan,
        rehearsal: false,
        output: Some(if s.people.portrait { CanvasView::Vertical } else { CanvasView::Landscape }),
    }) {
        s.people.waiting_for_link = None;
        s.people.invitation_result = Some(Err(error.to_string()));
    }
    true
}

pub(super) fn poll_direct_invitation(s: &mut Studio) -> bool {
    let Some(deadline) = s.people.waiting_for_link else { return false };
    let Some(live) = &s.live else { return false };
    let rtc = &live.snapshot.producer_rtc;
    if rtc["linkReady"] == true {
        s.people.waiting_for_link = None;
        guest_link(s);
        return true;
    }
    let error = if matches!(rtc["phase"].as_str(), Some("failed" | "ended")) {
        Some(rtc["reason"].as_str().unwrap_or("Guest session ended before the invitation was ready.").to_owned())
    } else if Instant::now() >= deadline {
        Some("Guest link took too long. End the session and try again.".into())
    } else {
        None
    };
    if let Some(error) = error {
        s.people.waiting_for_link = None;
        s.people.invitation_result = Some(Err(error));
        if !matches!(rtc["phase"].as_str(), Some("idle")) {
            let _ = live.handle.send(RoomCommand::RtcEnd);
        }
        return true;
    }
    false
}
pub(super) fn guest_output(s: &Studio) -> El {
    let live = s.live.as_ref().unwrap();
    let rtc = &live.snapshot.producer_rtc;
    let locked = rtc["role"] == "host" && matches!(rtc["phase"].as_str(), Some("gathering" | "waiting" | "connected"));
    let view = live.snapshot.project.canvas.view;
    let portrait = if locked {
        rtc["outputOrientation"] == "portrait"
    } else {
        view == CanvasView::Vertical || (view == CanvasView::Both && s.people.portrait)
    };
    let mut group = row().gap(5.).flex_wrap().items_center()
        .child(title("Guest output", 11., 550., MUTED));
    if locked || view != CanvasView::Both {
        return group.child(title(
            if portrait { "Portrait" } else { "Landscape" }, 11., 600., TEXT
        )).child(title(if locked { "Locked for this session" } else { "Follows Studio" }, 10., 450., MUTED));
    }
    for (label, vertical) in [("Landscape", false), ("Portrait", true)] {
        group = group.child(button(format!("guest-output-{label}"), label, portrait==vertical,
            move |s| s.people.portrait=vertical));
    }
    group
}

pub(super) fn popover(s: &Studio, height: f32) -> El {
    let live = s.live.as_ref().unwrap();
    let direct = crate::producer_rtc::Peer::can_host_direct(&live.handle.root);
    let status = s.people.hosting.as_ref();
    let hosted = status.is_some_and(|s| s.1) && s.people.checking.is_none();
    let mut menu = col()
        .key("people-connections-popout")
        .role("dialog")
        .label("Guest connection")
        .anchored_fit("people-session", rune::Side::Bottom, rune::Align::End, 5.)
        .w(260.)
        .max_h((height - 54.).max(1.))
        .padding(9.)
        .gap(4.)
        .radius(8.)
        .fill(color(0x15202b))
        .border(1., color(0x344755))
        .modal(true, |s: &mut Studio| s.people_settings = false)
        .child(title("Guest connection", 13., 600., TEXT));
    for (route, key, name, hint, enabled) in [
        (
            Route::Invitation,
            "room-invitation",
            "Guest invitation",
            "Invite a guest to this studio",
            true,
        ),
        (
            Route::Direct,
            "rtc-choice-internet",
            "Direct",
            "Device hosted · no relay",
            direct,
        ),
        (
            Route::Lan,
            "rtc-choice-lan",
            "LAN only",
            "Same local network",
            direct,
        ),
        (
            Route::Hosted,
            "rtc-choice-hosted",
            "Boomin Media Server",
            if s.people.checking.is_some() {
                "Checking workspace…"
            } else {
                status.map_or("Check hosting", |v| v.0.as_str())
            },
            hosted,
        ),
    ] {
        let chosen = s.people.route == route;
        menu = menu.child(
            col()
                .key(key)
                .role("button")
                .label(name)
                .focusable(true)
                .padding(7.)
                .gap(3.)
                .radius(5.)
                .fill(color(if chosen { 0x203a38 } else { 0x15202b }))
                .hover_fill(color(0x23343e))
                .disabled(!enabled)
                .child(title(name, 12., 550., if enabled { TEXT } else { MUTED }))
                .child(title(hint, 10., 450., MUTED))
                .on_press(move |s: &mut Studio| {
                    s.people.route = route;
                    s.people_settings = false;
                }),
        );
    }
    menu = menu.child(
        button("boomin-refresh", "Refresh hosting", false, People::refresh)
            .disabled(s.people.checking.is_some()),
    );
    let open = live.handle.root.join("boomin/audience-open").is_file();
    let base = s.base.clone();
    let room = live.snapshot.project.room.clone();
    let name = live.snapshot.project.production.title.clone();
    menu = menu.child(button(
        "audience-access",
        if open {
            "Close audience access"
        } else {
            "Open audience access"
        },
        open,
        move |s| {
            let (base, room, name) = (base.clone(), room.clone(), name.clone());
            s.room_task(move |root| {
                #[cfg(debug_assertions)]
                crate::boomin_account::link_dev_room(&base, root, &room, &name)?;
                crate::room_share::audience_access(root, !open)?;
                Ok(if open {
                    "Audience access closed"
                } else {
                    "Audience access opened"
                }
                .into())
            });
        },
    ));
    if let Some(limit) = live.snapshot.rtc_capacity["testedGuests"].as_u64() {
        menu = menu.child(title(
            format!("Tested on this device · {limit} guests"),
            10.,
            500.,
            MUTED,
        ));
    }
    menu.scroll(Default::default())
}

pub(super) fn guest_card(s: &Studio, mut b: El) -> El {
    let live = s.live.as_ref().unwrap();
    let rtc = &live.snapshot.producer_rtc;
    let staged = rtc["onStage"] == true;
    let muted = rtc["guestMuted"] == true;
    let id = rtc["sessionId"].as_str().unwrap_or("").to_owned();
    let name = rtc["verifiedBoominBrand"]
        .as_str()
        .or(rtc["displayName"].as_str())
        .unwrap_or("Guest");
    b = b.child(title(
        if staged { "On stage" } else { "Backstage" },
        12.,
        600.,
        MUTED,
    ));
    let tile = el()
        .key("people-guest-card")
        .size(144., 81.)
        .center()
        .fill(color(BG));
    b = b
        .child(if live.snapshot.guest_video_received {
            tile.native_surface(&live.guest_thumbnail, SurfaceFit::Fit)
        } else {
            tile.child(title("Waiting for camera", 10., 500., MUTED))
        })
        .child(title(name, 13., 600., TEXT));
    b = b.child(
        row()
            .flex_wrap()
            .gap(4.)
            .child(command(
                "card-mute",
                if muted { "Unmute" } else { "Mute" },
                muted,
                RoomCommand::RtcGuestMute {
                    session_id: id,
                    muted: !muted,
                },
            ))
            .child(command(
                "rtc-stage",
                if staged {
                    "Take off stage"
                } else {
                    "Bring on stage"
                },
                staged,
                RoomCommand::RtcStage { enabled: !staged },
            ))
            .child(button("card-details", "Details", s.people.details, |s| {
                s.people.details = !s.people.details;
                s.people.remove = false;
            }))
            .child(button("card-remove", "Remove…", s.people.remove, |s| {
                s.people.remove = !s.people.remove;
                s.people.details = false;
            })),
    );
    if s.people.details {
        let sec = rtc["stageTimeMs"].as_u64().unwrap_or(0) / 1000;
        b = b.child(title(
            format!("Time on stage  {}:{:02}", sec / 60, sec % 60),
            11.,
            500.,
            TEXT,
        ));
        if let Some(route) = rtc["mediaRoute"].as_str() {
            b = b.child(title(format!("Media · {route}"), 11., 500., MUTED));
        }
        if let Some(rtt) = rtc["stats"]["currentRoundTripTime"].as_f64() {
            b = b.child(title(
                format!("Round trip  {:.0} ms", rtt * 1000.),
                11.,
                500.,
                MUTED,
            ));
        }
        b = b.child(title(
            format!(
                "Audio {} · Video {}",
                if live.snapshot.guest_audio_received {
                    "receiving"
                } else {
                    "waiting"
                },
                if live.snapshot.guest_video_received {
                    "receiving"
                } else {
                    "waiting"
                }
            ),
            11.,
            500.,
            MUTED,
        ));
    }
    if s.people.remove {
        b = b.child(command(
            "confirm-remove-guest",
            "Remove from studio",
            false,
            RoomCommand::RtcEnd,
        ));
    }
    b
}
