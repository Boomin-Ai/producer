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
    task: Option<GuestTask>,
    invitation_result: Option<Result<String, String>>,
    session_error: Option<String>,
    waiting_for_link: Option<Instant>,
    portrait: bool,
    details: bool,
    remove: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum GuestTaskKind {
    Invitation,
    Session,
}

struct GuestTask {
    kind: GuestTaskKind,
    result: mpsc::Receiver<anyhow::Result<Option<String>>>,
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
        if let Some(task) = &self.task {
            let result = match task.result.try_recv() {
                Ok(result) => Some(result.map_err(|error| error.to_string())),
                Err(mpsc::TryRecvError::Disconnected) => {
                    Some(Err("The guest action could not finish. Try again.".into()))
                }
                Err(mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                match task.kind {
                    GuestTaskKind::Invitation => match result {
                        Ok(Some(message)) => self.invitation_result = Some(Ok(message)),
                        Err(error) => {
                            self.waiting_for_link = None;
                            self.invitation_result = Some(Err(error));
                        }
                        Ok(None) => {}
                    },
                    GuestTaskKind::Session => self.session_error = result.err(),
                }
                self.task = None;
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
        self.waiting_for_link.is_some()
            || self
                .task
                .as_ref()
                .is_some_and(|task| task.kind == GuestTaskKind::Invitation)
    }

    pub fn busy(&self) -> bool {
        self.waiting_for_link.is_some() || self.task.is_some()
    }

    pub fn copy_invitation(
        &mut self,
        copy: impl FnOnce() -> anyhow::Result<String> + Send + 'static,
    ) {
        self.run(GuestTaskKind::Invitation, move || copy().map(Some));
    }

    fn run(
        &mut self,
        kind: GuestTaskKind,
        task: impl FnOnce() -> anyhow::Result<Option<String>> + Send + 'static,
    ) {
        self.invitation_result = None;
        self.session_error = None;
        let (tx, rx) = mpsc::channel();
        self.task = Some(GuestTask { kind, result: rx });
        std::thread::spawn(move || {
            let _ = tx.send(task());
        });
    }

    fn request(&mut self, kind: GuestTaskKind, handle: Arc<Handle>, command: RoomCommand) {
        self.run(kind, move || {
            let reply = handle.request(command)?;
            anyhow::ensure!(
                reply["ok"] == true,
                "{}",
                reply["error"]
                    .as_str()
                    .unwrap_or("The guest action could not finish. Try again.")
            );
            Ok(None)
        });
    }

    pub fn invitation_feedback(&self, rtc: &serde_json::Value) -> Option<El> {
        if matches!(phase(rtc), "connected" | "failed" | "ended") || rtc["admitReady"] == true {
            return None;
        }
        let (message, tint) = match self.invitation_result.as_ref()? {
            Ok(message) => (message, MINT),
            Err(message) => (message, 0xe9b666),
        };
        Some(
            text(message.clone())
                .key("guest-invitation-feedback")
                .font(TextStyle::new(11., 500.))
                .color(color(tint))
                .wrap(),
        )
    }
}

fn phase(rtc: &serde_json::Value) -> &str {
    rtc["phase"].as_str().unwrap_or("idle")
}

fn guest_status<'a>(people: &'a People, rtc: &'a serde_json::Value) -> Option<(&'a str, u32)> {
    let phase = phase(rtc);
    let terminal_message = match phase {
        "failed" => Some(
            rtc["reason"]
                .as_str()
                .unwrap_or("Guest connection failed. End the session to try again."),
        ),
        "ended" => Some(rtc["reason"].as_str().unwrap_or("Guest session ended.")),
        _ => None,
    };
    if let Some(error) = terminal_message.or(people.session_error.as_deref()) {
        return Some((error, 0xe9b666));
    }
    if phase == "connected" {
        return None;
    }
    if matches!(phase, "gathering" | "waiting") && rtc["admitReady"] == true {
        return Some(("Guest ready to join", MINT));
    }
    if let Some(Err(error)) = &people.invitation_result {
        return Some((error, 0xe9b666));
    }
    let copied = people
        .invitation_result
        .as_ref()
        .and_then(|result| result.as_ref().ok());
    match phase {
        "idle" if people.copying_invitation() => Some(("Preparing invitation…", MUTED)),
        "idle" => copied.map(|message| (message.as_str(), MINT)),
        "gathering" => Some(("Preparing invitation…", MUTED)),
        "waiting" if copied.is_some() => Some(("Invitation copied. Waiting for your guest.", MINT)),
        "waiting" => Some(("Waiting for your guest", MUTED)),
        _ => Some(("Connecting guest…", MUTED)),
    }
}

fn send_guest_command(s: &mut Studio, command: RoomCommand) {
    if let Some(live) = &s.live {
        if !s.people.busy() {
            s.people
                .request(GuestTaskKind::Session, live.handle.clone(), command);
        }
    }
}

fn guest_command(s: &Studio, key: &str, label: &str, selected: bool, command: RoomCommand) -> El {
    button(key, label, selected, move |s| {
        send_guest_command(s, command.clone())
    })
    .disabled(s.people.busy())
}

pub(super) fn trigger(s: &Studio) -> El {
    panels::tool(
        "people-session",
        "settings",
        "People settings",
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
    s.live.as_ref().is_some_and(|live| live.broadcast_view.1)
}

fn audience_controls(s: &Studio, mut controls: El) -> El {
    if audience_live(s)
        || s.live
            .as_ref()
            .is_some_and(|live| live.handle.root.join("boomin/audience-open").is_file())
    {
        controls = controls.child(
            button("audience-link", "Copy audience link", false, |s| {
                panels::copy_link(s, crate::room_share::LinkKind::Audience);
            })
            .disabled(!audience_live(s)),
        );
    }
    controls
}

fn empty_guest(s: &Studio) -> El {
    let busy = s.people.copying_invitation();
    col().key("people-empty-guest").min_w(0.).padding(9.).gap(8.)
        .radius(8.).fill(color(SURFACE))
        .child(row().gap(7.).items_center()
            .child(rune::icon(glyphs::glyph("profile"), 17.).color(color(MUTED)))
            .child(text("No guests yet").font(TextStyle::new(12., 600.)).color(color(TEXT)).wrap().min_w(0.).grow(1.)))
        .child(button("guest-link", if busy { "Preparing link…" } else { "Invite a guest" },
            true, guest_link).disabled(s.people.busy()).w_full())
}

pub(super) fn panel(s: &Studio, mut body: El) -> El {
    let live = s.live.as_ref().unwrap();
    let rtc = &live.snapshot.producer_rtc;
    let phase = phase(rtc);
    let awaiting = live.handle.waiting_guests.lock().unwrap().clone();
    body = audience_controls(s, body.gap(8.));
    if !awaiting.is_empty() {
        body = body.child(title(format!("{} waiting", awaiting.len()), 10., 550., MINT));
    }

    if let Some((message, tint)) = guest_status(&s.people, rtc) {
        body = body.child(
            col()
                .key("people-guest-status")
                .role(if tint == 0xe9b666 { "alert" } else { "status" })
                .label(message)
                .padding(8.)
                .radius(6.)
                .fill(color(SURFACE))
                .child(
                    text(message)
                        .font(TextStyle::new(11., 500.))
                        .color(color(tint))
                        .wrap(),
                ),
        );
    }
    if phase == "idle" && awaiting.is_empty() {
        body = body.child(empty_guest(s));
    } else if matches!(phase, "gathering" | "waiting")
        && rtc["admitReady"] != true
        && rtc["linkReady"] == true
    {
        body = body.child(
            button("guest-link", "Copy guest link", false, guest_link).disabled(s.people.busy()),
        );
    }

    if matches!(phase, "gathering" | "waiting") && rtc["admitReady"] == true {
        if let Some(name) = rtc["displayName"].as_str() {
            body = body.child(title(name, 12., 600., TEXT));
        }
        body = body.child(guest_command(
            s,
            "rtc-admit",
            "Admit guest",
            true,
            RoomCommand::RtcAdmit,
        ));
    }
    if phase == "connected" && rtc["role"] == "host" {
        body = guest_card(s, body);
    } else if phase != "idle" {
        body = body.child(guest_command(
            s,
            "rtc-end",
            "End session",
            false,
            RoomCommand::RtcEnd,
        ));
    }

    if live.handle.pending_rtc_link.lock().unwrap().is_some() {
        body = body.child(
            button("accept-invitation", "Accept guest invitation", false, |s| {
                if let Some(live) = &s.live {
                    let link = live.handle.pending_rtc_link.lock().unwrap().take();
                    if link.is_some() {
                        send_guest_command(
                            s,
                            RoomCommand::RtcStart {
                                display_name: None,
                                link,
                                lan: false,
                                rehearsal: false,
                                output: None,
                            },
                        );
                    }
                }
            })
            .disabled(phase != "idle" || s.people.busy()),
        );
    }
    for guest in awaiting {
        let id = guest.id;
        body = body.child(
            col()
                .padding(8.)
                .gap(4.)
                .radius(6.)
                .fill(color(SURFACE))
                .child(title(guest.name, 12., 600., TEXT))
                .child(title("Waiting to join", 10., 500., MUTED))
                .child(
                    button(format!("admit-{id}"), "Admit guest", false, move |s| {
                        if let Some(live) = &s.live {
                            let root = live.handle.root.clone();
                            s.people.run(GuestTaskKind::Session, move || {
                                crate::room_share::admit(&root, id)?;
                                Ok(None)
                            });
                        }
                    })
                    .disabled(s.people.busy()),
                ),
        );
    }
    body
}

pub(super) fn start_direct_invitation(s: &mut Studio) -> bool {
    let Some(live) = &s.live else { return false };
    if s.people.route == Route::Hosted
        || !crate::producer_rtc::Peer::can_host_direct(&live.handle.root)
    {
        return false;
    }
    if phase(&live.snapshot.producer_rtc) != "idle" {
        s.people.invitation_result = Some(Err(
            "End the current guest session before inviting someone else.".into(),
        ));
        return true;
    }
    s.people.waiting_for_link = Some(Instant::now() + Duration::from_secs(20));
    let command = RoomCommand::RtcStart {
        display_name: None,
        link: None,
        lan: s.people.route == Route::Lan,
        rehearsal: false,
        output: Some(if s.people.portrait {
            CanvasView::Vertical
        } else {
            CanvasView::Landscape
        }),
    };
    s.people
        .request(GuestTaskKind::Invitation, live.handle.clone(), command);
    true
}

pub(super) fn poll_direct_invitation(s: &mut Studio) -> bool {
    let Some(deadline) = s.people.waiting_for_link else {
        return false;
    };
    if s.people.task.is_some() {
        return false;
    }
    let Some(live) = &s.live else { return false };
    let rtc = &live.snapshot.producer_rtc;
    if rtc["linkReady"] == true {
        s.people.waiting_for_link = None;
        guest_link(s);
        return true;
    }
    let error = if matches!(rtc["phase"].as_str(), Some("failed" | "ended")) {
        Some(
            rtc["reason"]
                .as_str()
                .unwrap_or("Guest session ended before the invitation was ready.")
                .to_owned(),
        )
    } else if Instant::now() >= deadline {
        Some("The guest link took too long. Try inviting again.".into())
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
fn guest_orientation(
    view: CanvasView,
    prefers_portrait: bool,
    rtc: &serde_json::Value,
) -> (bool, bool) {
    let locked = rtc["role"] == "host" && !matches!(phase(rtc), "idle" | "ended" | "failed");
    let portrait = if locked {
        rtc["outputOrientation"] == "portrait"
    } else {
        view == CanvasView::Vertical || (view == CanvasView::Both && prefers_portrait)
    };
    (portrait, locked)
}

fn guest_output(s: &Studio) -> El {
    let live = s.live.as_ref().unwrap();
    let view = live.snapshot.project.canvas.view;
    let (portrait, locked) =
        guest_orientation(view, s.people.portrait, &live.snapshot.producer_rtc);
    let group = col()
        .key("guest-output-settings")
        .role("group")
        .label("Guest output")
        .gap(5.)
        .padding(7.)
        .radius(5.)
        .fill(color(0x101a24))
        .child(title("Guest output", 11., 550., MUTED));
    if locked || view != CanvasView::Both {
        return group.child(
            row()
                .gap(5.)
                .flex_wrap()
                .items_center()
                .child(title(
                    if portrait { "Portrait" } else { "Landscape" },
                    11.,
                    600.,
                    TEXT,
                ))
                .child(title(
                    if locked {
                        "Locked for this session"
                    } else {
                        "Follows studio output"
                    },
                    10.,
                    450.,
                    MUTED,
                )),
        );
    }
    let mut choices = row().gap(5.).flex_wrap();
    for (label, vertical) in [("Landscape", false), ("Portrait", true)] {
        choices = choices.child(
            button(
                format!("guest-output-{label}"),
                label,
                portrait == vertical,
                move |s| s.people.portrait = vertical,
            )
            .checked(portrait == vertical)
            .disabled(s.people.copying_invitation()),
        );
    }
    group.child(choices)
}

pub(super) fn popover(s: &Studio, height: f32) -> El {
    let live = s.live.as_ref().unwrap();
    let direct = crate::producer_rtc::Peer::can_host_direct(&live.handle.root);
    let status = s.people.hosting.as_ref();
    let hosted = status.is_some_and(|s| s.1) && s.people.checking.is_none();
    let mut menu = col()
        .key("people-connections-popout")
        .role("dialog")
        .label("People settings")
        .anchored_fit("people-session", panels::dock_popover_side(live.snapshot.project.workspace.panels[&PanelId::People].edge), rune::Align::Start, 5.)
        .w(260.)
        .max_h((height - 54.).max(1.))
        .padding(9.)
        .gap(4.)
        .radius(8.)
        .fill(color(0x15202b))
        .border(1., color(0x344755))
        .modal(true, |s: &mut Studio| s.people_settings = false)
        .child(title("People settings", 13., 600., TEXT))
        .child(guest_output(s))
        .child(title("Guest connection", 11., 550., MUTED));
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

fn guest_card(s: &Studio, mut b: El) -> El {
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
            .child(guest_command(
                s,
                "card-mute",
                if muted { "Unmute" } else { "Mute" },
                muted,
                RoomCommand::RtcGuestMute {
                    session_id: id,
                    muted: !muted,
                },
            ))
            .child(guest_command(
                s,
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
        b = b.child(guest_command(
            s,
            "confirm-remove-guest",
            "Remove from studio",
            false,
            RoomCommand::RtcEnd,
        ));
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expired_guest_link_replaces_old_clipboard_confirmation() {
        let people = People {
            invitation_result: Some(Ok("Guest invitation copied".into())),
            ..People::default()
        };
        assert_eq!(
            guest_status(&people, &json!({"phase":"waiting"})),
            Some(("Invitation copied. Waiting for your guest.", MINT))
        );
        assert_eq!(
            guest_status(&people, &json!({"phase":"waiting", "admitReady":true})),
            Some(("Guest ready to join", MINT))
        );
        assert_eq!(
            guest_status(
                &people,
                &json!({"phase":"failed", "reason":"Studio link expired"})
            ),
            Some(("Studio link expired", 0xe9b666))
        );
    }

    #[test]
    fn guest_orientation_follows_single_output_and_preserves_an_active_session() {
        let idle = json!({"phase":"idle"});
        assert_eq!(
            guest_orientation(CanvasView::Landscape, true, &idle),
            (false, false)
        );
        assert_eq!(
            guest_orientation(CanvasView::Vertical, false, &idle),
            (true, false)
        );
        assert_eq!(
            guest_orientation(CanvasView::Both, true, &idle),
            (true, false)
        );

        let connected = json!({"phase":"connected", "role":"host", "outputOrientation":"portrait"});
        assert_eq!(
            guest_orientation(CanvasView::Landscape, false, &connected),
            (true, true)
        );
    }

    #[test]
    fn an_arriving_guest_supersedes_a_racing_copy_failure() {
        let people = People {
            invitation_result: Some(Err("Guest link expired".into())),
            ..People::default()
        };
        assert_eq!(
            guest_status(&people, &json!({"phase":"waiting", "admitReady":true})),
            Some(("Guest ready to join", MINT))
        );
        assert_eq!(guest_status(&people, &json!({"phase":"connected"})), None);
    }
}
