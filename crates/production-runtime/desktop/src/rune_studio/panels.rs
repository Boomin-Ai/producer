use super::*;
use crate::platform::ScreenCaptureTarget;
use crate::studio_audio::{Bus, Command as Audio, DeckId, Kind};
pub(super) fn glyph(name: &str, size: f32, c: u32) -> El {
    rune::icon(super::glyphs::glyph(name), size).color(color(c))
}
pub(super) fn tool(id: &str, g: &str, label: &str, on: bool, act: impl Fn(&mut Studio) + 'static) -> El {
    let tint = if g == "record" {
        0xff5e69
    } else if on {
        MINT
    } else {
        theme::TOOL_ICON
    };
    el().key(id.to_string())
        .role("button")
        .label(label.to_string())
        .help(label.to_string())
        .focusable(true)
        .size(33., 32.)
        .radius(8.)
        .center()
        .fill(color(if on { theme::TOOL_SELECTED } else { theme::TOOL }))
        .hover_fill(color(if on { theme::SELECTED_HOVER } else { 0x21303c }))
        .child(glyph(g, 17., tint))
        .on_press(act)
}
pub(super) fn send_tool(id: &str, g: &str, label: &str, on: bool, c: RoomCommand) -> El {
    tool(id, g, label, on, move |s| s.send(c.clone()))
}
pub(super) fn copy_link(s: &mut Studio, kind: crate::room_share::LinkKind, panel: Option<PanelId>, anchor: &str) {
    let Some(live) = &s.live else { return };
    if matches!(kind, crate::room_share::LinkKind::Audience) && !super::people::audience_live(s) {
        return;
    }
    let guest = matches!(kind, crate::room_share::LinkKind::Guest);
    if guest && s.people.busy() {
        return;
    }
    if guest && live.snapshot.producer_rtc["linkReady"] == true {
        let handle = live.handle.clone();
        s.people.copy_invitation(move || {
            let reply = handle.request(RoomCommand::RtcLink)?;
            let link = reply["link"].as_str().ok_or_else(|| {
                anyhow::anyhow!("{}", reply["error"].as_str().unwrap_or("Guest link expired"))
            })?;
            crate::room_share::copy_url(&crate::rtc_signaling::browser_invitation(link)?)?;
            Ok("Guest invitation copied".into())
        });
        return;
    }
    if guest && super::people::start_direct_invitation(s) {
        return;
    }
    let live = s.live.as_ref().unwrap();
    let binding = live.handle.root.join("boomin/room-binding.json");
    let legacy = std::fs::read(binding).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|v| v["nativeAccount"] != true);
    if !legacy && s.settings.account.is_none() {
        s.pending_link = Some((kind, panel, anchor.into()));
        s.activity = false;
        return;
    }
    #[cfg(debug_assertions)]
    let registration = (s.base.clone(), live.snapshot.project.room.clone(),
        live.snapshot.project.production.title.clone());
    let copy = move |root: &std::path::Path| {
        #[cfg(debug_assertions)]
        crate::boomin_account::link_dev_room(&registration.0, root, &registration.1, &registration.2)?;
        let url = crate::room_share::link(root, kind)?;
        crate::room_share::copy_url(&url)?;
        Ok(kind.copied().into())
    };
    if guest {
        let root = live.handle.root.clone();
        s.people.copy_invitation(move || copy(&root));
    } else {
        s.room_task(copy);
    }
}
pub(super) fn toolbar_dropdown(key: &'static str, anchor: &'static str, align: rune::Align, width: f32) -> El {
    let gap = if anchor == "activity-trigger" { 8. } else { 6. };
    col().key(key).anchored_fit(anchor, rune::Side::Bottom, align, gap)
        .w(width).corners([0., 0., 9., 9.]).fill(color(0x181e25))
        .transition(rune::Transition::offset(0., -7.))
}
pub(super) fn workspace(s: &Studio, w: f32, h: f32) -> El {
    let l = s.live.as_ref().unwrap();
    let snap = &l.snapshot;
    let p = &snap.project;
    let mut ws = p.workspace.clone();
    if let Some(c) = &s.resize {
        let _ = ws.apply(c.clone());
    }
    if let Some((panel, [x, y])) = s.drag_tile {
        if let Some(command) = panel_placement(&p.workspace, panel, x, y, w, h) {
            let _ = ws.apply(command);
        }
    }
    let [left, right, top, bottom] = ws.layout_extents(w, h - 79., s.editing_docks);
    let streaming = l.broadcast_view.0.active;
    let bar_fill = if cfg!(target_os = "macos") { color(BG).alpha(0.93) } else { color(BG) };
    let notice = if !s.error.is_empty() { Some(s.error.as_str()) } else { snap.error.as_deref() };
    let chrome = row()
        .key("studio-titlebar").w_full()
        .h(44.)
        .px(10.)
        .gap(5.)
        .items_center()
        .fill(bar_fill)
        .child(el().w(if cfg!(target_os = "macos") { 64. } else { 0. }).h_full().window_drag())
        .child(tool("studios", "menu", "Studios", false, |s| {
            s.page = Page::Studios
        }))
        .child(
            tool(
                "edit",
                if s.editing_docks { "done" } else { "edit" },
                if s.editing_docks { "Finish editing dock layout (⌘E)" } else { "Edit dock layout (⌘E)" },
                s.editing_docks,
                toggle_docks,
            )
            .shortcut_hint("⌘E"),
        )
        .child(if s.editing_docks {
            tool("panels-menu", "panels", "Add or hide panels", false, |s| {
                s.studio_panels = !s.studio_panels;
                s.panel_menu = None;
                s.moving_panel = None;
            })
        } else { el().size(0., 0.) })
        .child(if s.editing_docks {
            button("layout-theme", "Desk theme", false, super::settings::open_theme)
        } else { el().size(0., 0.) })
        .child(row().key("activity-trigger").focusable(true)
            .items_center().gap(6.).px(6.).h(28.).min_w(0.)
            .max_w((w - if s.editing_docks { 600. } else { 470. }).clamp(64., 360.))
            .role("button").label("Activity")
            .help(if s.activity { "Hide studio activity" } else { "Show studio activity" })
            .radius(5.).hover_fill(color(0x21303c))
            .child(glyph("activity", 17., if notice.is_some() { MINT } else { MUTED }))
            .child(title(notice.unwrap_or("Activity"), 12., 500., if notice.is_some() { TEXT } else { MUTED }))
            .on_press(|s: &mut Studio| s.activity = !s.activity))
        .child(el().key("titlebar-drag-space").grow(1.).h_full().window_drag())
        .child(tool(
            "studio-link",
            "link",
            "Copy studio link",
            false,
            |s| copy_link(s, crate::room_share::LinkKind::Room, None, "studio-link"),
        ))
        .child(super::channels::indicators(s, w))
        .child(tool("channels", "channels", "Open channels", false, |s| {
            super::channels::Channels::open(s, true)
        }))
        .child(tool(
            "virtual-camera",
            "camera",
            "Virtual camera settings",
            false,
            super::settings::open_output,
        ))
        .child(el().w(1.).h(18.).fill(color(0x263443)))
        .child(send_tool(
            "record",
            "record",
            if snap.recording { "Stop recording" } else { "Start recording" },
            snap.recording,
            RoomCommand::Record {
                enabled: !snap.recording,
            },
        ))
        .child(tool(
            "broadcast",
            "live",
            "Broadcast controls",
            streaming,
            |s| super::channels::Channels::open(s, false),
        ));
    // Rune hosts each material below its Metal surface. The bars paint their tint above it.
    let bar_material = |key, y, height| el().key(key).absolute(0., y).w_full().h(height)
        .fill(color(BG)).system_material(rune::SystemMaterial::Sidebar);
    let shell = col()
        .key("studio-shell")
        .w_full()
        .h_full()
        .gap(3.)
        .child(bar_material("studio-titlebar-material", 0., 44.))
        .child(bar_material("studio-statusbar-material", (h - 24.).max(0.), 24.))
        .child(el().absolute(0., 44.).w_full().h((h - 68.).max(0.)).fill(color(BG)));
    // Keep dock content inside the opaque center, including during live resizing.
    let mut body = col().key("studio-dock-area").absolute(0., 47.)
        .w_full().h((h - 74.).max(0.)).clip_rounded(0.).gap(3.);
    let grip = |edge, size, collapsed| {
        if s.editing_docks {
            el().size(0., 0.)
        } else {
            grip(edge, size, collapsed)
        }
    };
    if top > 0. {
        body = body
            .child(dock(s, Edge::Top, w, w, &ws, [w, h]).h(top))
            .child(grip(
                Edge::Top,
                top,
                p.workspace.docks[&Edge::Top].collapsed,
            ));
    }
    let mut middle = row().grow(1.).min_h(0.).gap(4.);
    if left > 0. {
        middle = middle
            .child(
                dock(
                    s,
                    Edge::Left,
                    left,
                    (h - top - bottom - 79.).max(1.),
                    &ws,
                    [w, h],
                )
                .w(left),
            )
            .child(grip(
                Edge::Left,
                left,
                p.workspace.docks[&Edge::Left].collapsed,
            ));
    }
    let mut views = row().items_start().gap(8.);
    let view = p.canvas.view;
    let available = (w - left - right - 28.).max(32.);
    let aspect = |width: u32, height: u32| width as f32 / height.max(1) as f32;
    let ratios = [
        aspect(p.canvas.landscape.width, p.canvas.landscape.height),
        aspect(p.canvas.vertical.width, p.canvas.vertical.height),
    ];
    let total = match view {
        CanvasView::Landscape => ratios[0],
        CanvasView::Vertical => ratios[1],
        CanvasView::Both => ratios[0] + ratios[1],
    };
    let expanded = s.studio_settings == Some(super::settings::StudioSheet::Preferences);
    let detail_height = if expanded { (h - top - bottom - 179.).clamp(72., 240.) } else { 0. };
    let frame_height = ((available - if view == CanvasView::Both { 8. } else { 0. }) / total)
        .min((h - top - bottom - 147. - detail_height).max(40.));
    for (i, name) in ["Landscape output", "Portrait output"]
        .into_iter()
        .enumerate()
    {
        if matches!(
            (i, view),
            (0, CanvasView::Vertical) | (1, CanvasView::Landscape)
        ) {
            continue;
        }
        views = views.child(
            el().key(format!("monitor-{i}"))
                .role("img")
                .label(name)
                .size(frame_height * ratios[i], frame_height)
                .border(1., color(0x263544))
                .fill(color(0x03070c))
                .native_surface(&l.surfaces[i], SurfaceFit::Fit),
        );
    }
    let mic = p_mic(snap);
    let camera = (0. ..1000.).contains(&snap.frame_age_ms[0]);
    let sharing = snap.frame_age_ms[1] >= 0.;
    let timeline = &ws.panels[&PanelId::Timeline];
    let timeline_docked = timeline.visible && !ws.docks[&timeline.edge].hidden;
    let mut bar = row().key("program-transport").items_center().flex_wrap().gap(4.);
    bar = if expanded {
        bar.w_full().px(9.).py(6.).fill(color(theme::TRANSPORT))
    } else {
        bar.self_center().justify_center().padding(3.).radius(10.).border(1., color(theme::TRANSPORT_BORDER))
            .fill(color(PANEL)).max_w((w - left - right - 20.).max(120.))
    };
    let mut bar = bar
        .child(send_tool(
            "mic",
            "mic",
            if snap.audio_frames == 0 { "Enable microphone" } else if mic.1 { "Unmute microphone" } else { "Mute microphone" },
            snap.audio_frames > 0 && !mic.1,
            if snap.audio_frames == 0 {
                RoomCommand::Capture {
                    camera: false,
                    screen: false,
                    mic: true,
                }
            } else {
                RoomCommand::Gain {
                    source: "microphone".into(),
                    gain: mic.0,
                    muted: !mic.1,
                }
            },
        ))
        .child(send_tool(
            "connect-camera",
            "camera",
            if camera { "Turn camera off" } else { "Turn camera on" },
            camera,
            if camera { RoomCommand::StopCamera } else { RoomCommand::Capture {
                camera: true,
                screen: false,
                mic: false,
            } },
        ))
        .child(send_tool(
            "screen",
            "screen",
            if sharing { "Stop sharing screen" } else { "Share screen" },
            sharing,
            RoomCommand::ScreenCapture {
                target: if sharing { ScreenCaptureTarget::Stop } else { ScreenCaptureTarget::Any },
            },
        ))
        .child(tool(
            "studio-settings",
            "settings",
            if expanded { "Close studio settings" } else { "Studio settings" },
            expanded,
            super::settings::open_studio,
        ));
    if timeline_docked || snap.previewing {
        bar = bar.child(command(
            "monitor-live",
            "Program",
            !snap.previewing,
            RoomCommand::Monitor { preview: false },
        ).help("View the current program output"));
    }
    if timeline_docked {
        bar = bar.child(command(
            "monitor-preview",
            "Timeline",
            snap.previewing,
            RoomCommand::Monitor { preview: true },
        ).help("Preview the timeline in the studio monitors"));
    }
    let record_command = RoomCommand::Record { enabled: !snap.recording };
    let record_label = if snap.recording { "Stop recording" } else { "Record" };
    let bar = if expanded {
        bar.child(el().grow(1.).min_w(0.))
            .child(row().key("transport-record").role("button").focusable(true).label(record_label)
                .items_center().gap(5.).h(29.).px(8.).radius(6.).fill(color(PANEL)).hover_fill(color(SURFACE))
                .child(glyph("record", 14., 0xff5e69)).child(title(record_label, 11., 600., TEXT))
                .on_press(move |s: &mut Studio| s.send(record_command.clone())))
    } else {
        bar.child(send_tool("transport-record", "record",
            if snap.recording { "Stop recording" } else { "Start recording" }, snap.recording, record_command))
    };
    let mut center = col()
        .grow(1.)
        .min_w(0.)
        .padding(4.)
        .child(views)
        .child(el().grow(1.));
    if snap.previewing {
        center = center.child(
            command(
                "take",
                "Send timeline to output",
                false,
                super::timeline::send_to_output(),
            )
            .self_center(),
        );
    }
    let controller = if expanded {
        let width = available.clamp(80., 430.);
        col().key("expanded-quick-controller").self_center().w(width).min_h(0.)
            .radius(10.).clip_rounded(10.).border(1., color(theme::TRANSPORT_BORDER))
            .gradient(color(SURFACE).alpha(0.97), color(PANEL).alpha(0.96))
            .child(super::settings::quick_settings(s, width - 2., detail_height))
            .child(bar)
    } else { bar };
    middle = middle.child(center.child(controller));
    if right > 0. {
        middle = middle
            .child(grip(
                Edge::Right,
                right,
                p.workspace.docks[&Edge::Right].collapsed,
            ))
            .child(
                dock(
                    s,
                    Edge::Right,
                    right,
                    (h - top - bottom - 79.).max(1.),
                    &ws,
                    [w, h],
                )
                .w(right),
            );
    }
    body = body.child(middle);
    if bottom > 0. {
        body = body
            .child(grip(
                Edge::Bottom,
                bottom,
                p.workspace.docks[&Edge::Bottom].collapsed,
            ))
            .child(dock(s, Edge::Bottom, w, w, &ws, [w, h]).h(bottom));
    }
    let mode = if cfg!(debug_assertions) { "Native Dev" } else { "Producer" };
    let fps = l.performance.fps.map_or_else(|| "— fps".into(), |v| format!("{v:.0} fps"));
    let cpu = l.performance.cpu.map_or_else(|| "CPU —".into(), |v| format!("CPU {v:.0}%"));
    let (health, ink) = super::channels::health(&l.broadcast_view.0);
    let seam = |y| el().absolute(0., y).w_full().h(1.).fill(color(theme::SEAM));
    let completed = shell.child(body).child(chrome.absolute(0., 0.))
        .child(seam(44.)).child(seam((h - 25.).max(0.))).child(
        row().key("studio-statusbar").absolute(0., (h - 24.).max(0.)).w_full().fill(bar_fill)
            .h(24.)
            .px(10.)
            .items_center()
            .gap(10.)
            .child(title(mode, 10., 600., MUTED))
            .child(title(if snap.recording { "Recording" } else { "Studio" }, 10., 550., if snap.recording { 0xff6672 } else { MUTED }))
            .child(el().grow(1.))
            .child(title(fps, 10., 550., TEXT).help("Measured program frames per second"))
            .child(title(cpu, 10., 550., TEXT).help(format!("Process CPU, one core = 100% · Frame submission p99 {:.2} ms", snap.cpu_p99_ms)))
            .child(el().grow(1.))
            .child(el().size(6.,6.).radius(3.).fill(color(ink)))
            .child(title(health, 10., 550., ink)),
    );
    let mut completed = completed;
    if !s.editing_docks {
        for edge in Edge::ALL {
            let dock = &ws.docks[&edge];
            if !ws.at(edge).is_empty() && (dock.hidden || (edge.side() && dock.collapsed)) {
                let [x, y, width, height] = crate::workspace::Workspace::restore_bounds(
                    edge,
                    w,
                    h,
                    [left, right, top, bottom],
                );
                completed = completed.child(
                    el().key(format!("reopen-dock-{}", edge.key()))
                        .role("button")
                        .label(format!("Open {} dock", edge.key()))
                        .absolute(x, y)
                        .size(width, height)
                        .radius(5.)
                        .fill(color(0x0e1c27))
                        .center()
                        .child(
                            el().size(
                                if edge.side() { 3. } else { 32. },
                                if edge.side() { 32. } else { 3. },
                            )
                            .fill(color(0x64818f)),
                        )
                        .on_press(move |s: &mut Studio| {
                            s.send(RoomCommand::Workspace {
                                command: WorkspaceCommand::Collapse {
                                    edge,
                                    collapsed: false,
                                },
                            })
                        }),
                );
            }
        }
    }
    let completed = if let Some((panel, [x, y])) = s.drag_tile {
        let hint = match s.drop_edge {
            Some(edge) if panel.accepts(edge) => {
                format!("Release to place here · {} dock", edge.key())
            }
            Some(_) => "Timeline needs a top or bottom dock".into(),
            None => "Drag to a dock · Esc to cancel".into(),
        };
        completed.child(
            col()
                .key("dragged-panel")
                .absolute(
                    (x + 12.).min((w - 196.).max(0.)),
                    (y + 12.).min((h - 70.).max(0.)),
                )
                .w(190.)
                .padding(12.)
                .gap(4.)
                .radius(7.)
                .fill(color(PANEL))
                .border(1., color(MINT))
                .child(title(panel.label(), 14., 600., TEXT))
                .child(title(hint, 10., 500., MUTED)),
        )
    } else {
        completed
    };
    if let Some((_, panel, anchor)) = &s.pending_link {
        let side = panel.map_or(rune::Side::Bottom, |id| dock_popover_side(ws.panels[&id].edge));
        let mut dialog = col().key("boomin-connect").w(336.).radius(8.).fill(color(PANEL))
            .anchored_fit(anchor.clone(), side, rune::Align::Start, 6.)
            .max_h(h - 64.).padding(8.).gap(5.)
            .modal(true, |s: &mut Studio| s.pending_link = None)
            .child(super::settings::account(s).scroll(Default::default()));
        if !s.error.is_empty() {
            dialog = dialog.child(text(s.error.clone()).font(TextStyle::new(12., 500.)).color(color(TEXT)).wrap());
        }
        return completed.child(dialog.child(button("cancel-boomin-connect", "Close", false, |s| s.pending_link = None)));
    }
    if s.people_settings { return completed.child(super::people::popover(s,h)); }
    if s.activity {
        let mut card = col().padding(12.).gap(8.).child(title("Activity", 13., 650., TEXT));
        if let Some(message) = notice {
            card = card.child(text(message.to_owned()).font(TextStyle::new(12., 500.)).color(color(TEXT)).wrap());
            if !s.error.is_empty() {
                card = card.child(button("dismiss-notice", "Dismiss notice", false, |s| s.error.clear()));
            }
        }
        card = card.child(title(format!("{} landscape frames · {} portrait frames",
            snap.output_frames[0], snap.output_frames[1]), 11., 450., MUTED));
        return completed.child(toolbar_dropdown("activity-popover", "activity-trigger", rune::Align::Start, 312.)
            .modal(true, |s: &mut Studio| s.activity = false).child(card));
    }
    if s.editing_docks {
        if let Some(sheet) = dock_picker(s, &ws, [w, h], [left, right, top, bottom]) {
            return completed.child(sheet);
        }
    }
    if let Some((source, owner, anchor)) = &s.source {
        return completed.child(source_popout(s, source, ws.panels[owner].edge, anchor, w, h));
    }
    if let Some(sheet) = super::channels::sheet(s, w) {
        completed.child(sheet)
    } else if let Some(panel) = super::chat::popout(s, &ws) {
        completed.child(panel)
    } else {
        completed
    }
}
pub(super) fn slot_ready(snap: &crate::engine::Snapshot, id: &str) -> bool {
    use producer_production_contract::{Role, Source};
    let p = &snap.project;
    match p.production.sources.get(id) {
        Some(Source::Live { role: Role::Guest }) => p.rtc_video_slot().is_some()
            && snap.producer_rtc["phase"] == "connected" && snap.guest_video_received,
        Some(Source::Graphics { .. }) => true,
        _ if !p.lanes.iter().any(|lane| lane.source == id) => false,
        Some(Source::Live { role: Role::Screen }) => snap.source_frames[1] > 0 && snap.frame_age_ms[1] >= 0.,
        Some(Source::Live { role: Role::HostCamera }) if id == "camera" =>
            snap.source_frames[0] > 0 && (0. ..1000.).contains(&snap.frame_age_ms[0]),
        Some(Source::Live { role: Role::Microphone }) if id == "microphone" => snap.audio_frames > 0,
        Some(Source::Live { .. }) => snap.input_status.get(id).is_some_and(|status| status.frames > 0 && (0. ..1000.).contains(&status.age_ms)),
        Some(Source::Player { .. }) => id == "movie" && snap.movie_loaded(),
        None => false,
    }
}
fn source_kind<'a>(p: &'a crate::model::RoomProject, source: &'a str) -> &'a str {
    use producer_production_contract::{Role, Source};
    match p.production.sources.get(source) {
        Some(Source::Live { role: Role::HostCamera }) => "camera",
        Some(Source::Live { role: Role::Microphone }) => "microphone",
        _ => source,
    }
}
pub(super) fn dock_popover_side(edge: Edge) -> rune::Side {
    match edge {
        Edge::Top => rune::Side::Bottom,
        Edge::Bottom => rune::Side::Top,
        Edge::Left => rune::Side::Right,
        Edge::Right => rune::Side::Left,
    }
}
pub(super) fn open_source(s: &mut Studio, source: &str, owner: PanelId, anchor: String) {
    s.camera_info = Default::default();
    s.source = Some((source.into(), owner, anchor));
    let Some(l) = &s.live else {
        return;
    };
    let binding = l.snapshot.project.inputs.get(source);
    if source_kind(&l.snapshot.project, source) == "camera" {
        let current = binding
            .map(|b| b.device.as_str())
            .filter(|id| !id.is_empty())
            .or_else(|| {
                if source != "camera" { return None; }
                l.snapshot
                    .cameras
                    .as_array()?
                    .iter()
                    .find(|d| d["default"] == true)?["id"]
                    .as_str()
            });
        if let Some(id) = current {
            s.camera_info = crate::platform::camera_controls(id, 0, 0);
        }
    }
}
fn source_popout(s: &Studio, source: &str, edge: Edge, anchor: &str, w: f32, h: f32) -> El {
    let snap = &s.live.as_ref().unwrap().snapshot;
    let p = &snap.project;
    let kind = source_kind(p, source);
    let heading = match kind {
        "camera" => "Camera settings",
        "microphone" => "Microphone settings",
        "screen" => "Screen share settings",
        "add" => "Add source",
        _ => "Source settings",
    };
    let width = 300_f32.min(w - 16.);
    let max_h = (h - 96.).clamp(96., 420.);
    let mut pick = col()
        .key("source-popout")
        .role("dialog")
        .label(heading)
        .anchored_fit(anchor.to_owned(), dock_popover_side(edge), rune::Align::Start, 6.)
        .modal(true, |s: &mut Studio| s.source = None)
        .w(width)
        .max_h(max_h)
        .padding(9.)
        .gap(6.)
        .radius(9.)
        .fill(color(0x0b151f))
        .border(1., color(0x354657))
        .hit()
        .child(
            row()
                .items_center()
                .child(title(heading, 14., 600., TEXT))
                .child(el().grow(1.))
                .child(
                    button("close-source", "×", false, |s| s.source = None)
                        .label("Close source settings")
                        .size(24., 24.),
                ),
        );
    if matches!(kind, "camera" | "microphone") {
        pick = pick.child(title("Input device", 11., 500., MUTED));
    }
    if kind == "add" {
        for (kind, devices) in [("camera", &snap.cameras), ("microphone", &snap.microphones)] {
            for d in devices.as_array().into_iter().flatten() {
                if let (Some(id), Some(name)) = (d["id"].as_str(), d["name"].as_str()) {
                    if !p.inputs.values().any(|b| b.kind == kind && b.device == id) {
                        let id = id.to_owned();
                        pick =
                            pick.child(button(format!("add-{kind}-{id}"), name, false, move |s| {
                                s.send(RoomCommand::AddInput {
                                    kind: kind.into(),
                                    device: id.clone(),
                                });
                                s.source = None;
                            }));
                    }
                }
            }
        }
    } else if matches!(kind, "microphone" | "camera") {
        let devices = if kind == "camera" {
            &snap.cameras
        } else {
            &snap.microphones
        };
        let mut available = false;
        for d in devices.as_array().into_iter().flatten() {
            if let (Some(id), Some(name)) = (d["id"].as_str(), d["name"].as_str()) {
                let current = p.inputs.get(source).map_or(source == kind && d["default"] == true, |b| {
                    if b.device.is_empty() {
                        d["default"] == true
                    } else {
                        b.device == id
                    }
                });
                let used = p
                    .inputs
                    .iter()
                    .any(|(key, b)| key != source && b.kind == kind && b.device == id)
                    || (source != kind && !p.inputs.contains_key(kind) && d["default"] == true
                        && p.lanes.iter().any(|lane| lane.source == kind));
                available |= !used;
                let reconnect = current && source != kind && kind == "camera" && !slot_ready(snap, source);
                let (source, kind, id) = (source.to_string(), kind.to_owned(), id.to_owned());
                let label = if reconnect {
                    "Reconnect"
                } else if current {
                    "Current"
                } else if used {
                    "In Sources"
                } else {
                    ""
                };
                pick = pick.child(
                    row()
                        .key(format!("input-device-{id}"))
                        .role("button")
                        .label(name)
                        .focusable(true)
                        .items_center()
                        .gap(6.)
                        .px(8.)
                        .h(32.)
                        .radius(5.)
                        .fill(color(if current { 0x18382f } else { SURFACE }))
                        .child(title(name, 12., 550., TEXT))
                        .child(el().grow(1.))
                        .child(title(label, 10., 500., if current { MINT } else { MUTED }))
                        .disabled(used)
                        .on_press(move |s: &mut Studio| {
                            if !current || reconnect {
                                s.send(RoomCommand::ConfigureInput {
                                    source: source.clone(),
                                    kind: kind.clone(),
                                    device: id.clone(),
                                });
                                s.source = None;
                            }
                        }),
                );
            }
        }
        if !available && kind == "camera" && source != kind {
            pick = pick.child(title("Connect another camera to use this input.", 11., 500., MUTED));
        }
    } else if kind == "screen" {
        for (label, target) in [
            ("Choose window", ScreenCaptureTarget::Window),
            ("Choose display", ScreenCaptureTarget::Display),
            ("Stop sharing", ScreenCaptureTarget::Stop),
        ] {
            pick = pick.child(button(label, label, false, move |s| {
                s.source = None;
                s.send(RoomCommand::ScreenCapture { target: target.clone() });
            }));
        }
    } else {
        pick = pick.child(
            el().role("button")
                .label("Import movie")
                .px(8.)
                .h(28.)
                .center()
                .fill(color(SURFACE))
                .child(title("Import movie", 12., 500., TEXT))
                .on_press_tx(|_: &mut Studio, tx| {
                    tx.open_file(
                        rune::FileDialogOptions::default().filter("Video", &["mov", "mp4", "m4v"]),
                        |s: &mut Studio, r, _| match r {
                            Ok(Some(path)) => s.send(RoomCommand::ImportMov { path }),
                            Ok(None) => {}
                            Err(e) => s.error = e.to_string(),
                        },
                    )
                }),
        );
    }
    if kind == "camera" {
        let info = &s.camera_info;
        if let Some(fmt) = info["format"].as_str() {
            pick = pick.child(
                row()
                    .items_center()
                    .child(title("Active format", 11., 500., MUTED))
                    .child(el().grow(1.))
                    .child(title(fmt, 12., 500., TEXT)),
            );
        }
        if let Some(id) = info["device"].as_str() {
            if let Some(rates) = info["rates"].as_array().filter(|r| !r.is_empty()) {
                let mut row = row()
                    .gap(4.)
                    .items_center()
                    .child(title("Frame rate", 12., 500., TEXT))
                    .child(el().grow(1.));
                for fps in rates.iter().filter_map(|v| v.as_i64()) {
                    let id = id.to_owned();
                    row = row.child(button(
                        format!("camera-fps-{fps}"),
                        format!("{fps} fps"),
                        info["fps"] == fps,
                        move |s| {
                            s.camera_info = crate::platform::camera_controls(&id, 4, fps as i32)
                        },
                    ));
                }
                pick = pick.child(row);
            }
            for (i, name) in ["Focus", "Exposure", "White balance"]
                .into_iter()
                .enumerate()
            {
                let mode = &info["modes"][i];
                if mode[0] != true || mode[1] != true {
                    continue;
                }
                let mut line = row()
                    .gap(4.)
                    .items_center()
                    .child(title(name, 12., 500., TEXT))
                    .child(el().grow(1.));
                for (auto, label, value) in [(true, "Auto", 2), (false, "Lock", 0)] {
                    let id = id.to_owned();
                    line = line.child(button(
                        format!("camera-{i}-{label}"),
                        label,
                        mode[2] == value,
                        move |s| {
                            s.camera_info = crate::platform::camera_controls(
                                &id,
                                (i + 1) as i32,
                                i32::from(auto),
                            )
                        },
                    ));
                }
                pick = pick.child(line);
            }
        }
        let grade = p.camera_grades.get(source).copied().unwrap_or_default();
        pick = pick.child(title("Lighting & color", 13., 650., TEXT));
        for (field, label, value, step, limit) in [
            ("exposure", "Exposure", grade.exposure, 25_i16, 200_i16),
            ("contrast", "Contrast", grade.contrast, 10, 100),
            ("saturation", "Saturation", grade.saturation, 10, 100),
            ("warmth", "Warmth", grade.warmth, 10, 100),
        ] {
            let display = if field == "exposure" { format!("{:+.2} EV", f32::from(value)/100.) } else { format!("{value:+}%") };
            let mut line = row().gap(4.).items_center().child(title(label, 12., 500., TEXT))
                .child(el().grow(1.)).child(title(display, 11., 500., MUTED));
            for (sign, suffix, delta) in [("−","down",-step), ("+","up",step)] {
                let mut next = grade;
                let new_value = (value + delta).clamp(-limit, limit);
                match field {
                    "exposure" => next.exposure = new_value,
                    "contrast" => next.contrast = new_value,
                    "saturation" => next.saturation = new_value,
                    _ => next.warmth = new_value,
                }
                line = line.child(command(format!("grade-{field}-{suffix}"), sign, false,
                    RoomCommand::CameraGrade { source: source.into(), grade: next })
                    .label(format!("{label} {suffix}")).disabled(new_value == value));
            }
            pick = pick.child(line);
        }
        pick = pick.child(command("reset-camera-grade","Reset lighting & color",false,
            RoomCommand::CameraGrade { source: source.into(), grade: Default::default() })
            .disabled(grade == Default::default()));
        if let Some(msg) = info["error"].as_str() {
            pick = pick.child(title(msg, 11., 500., 0xff9b93));
        }
        pick = pick.child(button(
            "camera-effects",
            "Open macOS Video Effects",
            false,
            |_| crate::platform::camera_effects(),
        ));
    }
    if p.lanes.iter().any(|lane| lane.source == source) {
        let source = source.to_owned();
        pick = pick.child(
            button("remove-source", "Remove source", false, move |s| {
                s.send(RoomCommand::SourceRemove {
                    source: source.clone(),
                });
                s.source = None;
            })
            .disabled(snap.recording || snap.take.busy()),
        );
    }
    pick.scroll(Default::default())
}
fn p_mic(s: &Snapshot) -> (f32, bool) {
    s.project
        .lanes
        .iter()
        .find(|l| l.source == "microphone")
        .map_or((1., false), |l| (l.gain, l.muted))
}
fn studio_list(snap: &Snapshot, id: PanelId, compact: bool) -> El {
    let p = &snap.project;
    let mut list = if compact { row().items_center() } else { col() };
    list = list.gap(4.).min_w(0.);
    let tile = |key: String, active: bool| {
        let r = row()
            .key(key)
            .items_center()
            .gap(5.)
            .px(6.)
            .h(if compact { 28. } else { 34. })
            .radius(5.)
            .fill(color(if active { 0x17372f } else { SURFACE }))
            .border(1., color(if active { 0x4c9a80 } else { 0x263443 }));
        if compact {
            r.max_w(224.)
        } else {
            r.w_full()
        }
    };
    if id == PanelId::Scenes {
        for (key, scene) in &p.room_scenes {
            let active = &p.active_scene == key;
            let selected = key.clone();
            let mut item = tile(format!("scene-{key}"), active)
                .child(glyph("screen", 14., if active { MINT } else { MUTED }))
                .role("button")
                .label(scene.name.clone())
                .focusable(true)
                .child(title(
                    &scene.name,
                    12.,
                    550.,
                    if active { MINT } else { TEXT },
                ));
            if !compact {
                item = item.child(el().grow(1.));
                if active {
                    item = item.child(title("On", 10., 600., MINT));
                }
            }
            let select = item.on_press(move |s: &mut Studio| {
                s.send(RoomCommand::SceneSelect { id: selected.clone() });
            });
            let mut scene_row = row().items_center().gap(3.).min_w(0.)
                .child(if compact { select } else { select.w(0.).grow(1.) });
            if p.room_scenes.len() > 1 {
                let id = key.clone();
                let label = format!("Options for {}", scene.name);
                let delete = format!("Delete {}", scene.name);
                let anchor = format!("scene-options-{key}");
                let menu_anchor = anchor.clone();
                scene_row = scene_row.child(
                    tool(&anchor, "more", &label, false, |_| {}).size(23., 24.)
                        .on_press_tx(move |_: &mut Studio, tx| {
                            let id = id.clone();
                            tx.popup_menu(
                                rune::PopupMenu::new().item(rune::PopupItem::new("delete", &delete)),
                                menu_anchor.clone(),
                                move |s: &mut Studio, pick, _| {
                                    if pick == Some("delete") {
                                        s.send(RoomCommand::SceneRemove { id });
                                    }
                                },
                            );
                        }).disabled(active && (snap.recording || snap.take.busy())),
                );
            }
            list = list.child(scene_row);

        }
    } else {
        let seq = p.production.sequences.get("main");
        for lane in p.lanes.iter().filter(|l| l.kind != "graphics") {
            let source = lane.source.clone();
            let kind = p
                .inputs
                .get(&source)
                .map_or(source.as_str(), |b| b.kind.as_str());
            let (symbol, ready) = match kind {
                "camera" => (
                    "camera",
                    if source == "camera" {
                        snap.source_frames[0] > 0 && snap.frame_age_ms[0] < 1000.
                    } else {
                        snap.input_status
                            .get(&source)
                            .is_some_and(|v| v.frames > 0 && v.age_ms < 1000.)
                    },
                ),
                "microphone" => (
                    "mic",
                    if source == "microphone" {
                        snap.audio_frames > 0
                    } else {
                        snap.input_status.get(&source).is_some_and(|v| v.frames > 0)
                    },
                ),
                "screen" => ("screen", snap.frame_age_ms[1] >= 0.),
                _ => ("studio", snap.source_frames[2] > 0),
            };
            let clip = seq.and_then(|seq| {
                seq.placements
                    .iter()
                    .find(|c| c.source == source)
                    .map(|c| c.id.clone())
            });
            let selected = clip.is_some() && snap.selected_clip == clip;
            let mut name = row()
                .min_w(0.)
                .items_center()
                .gap(5.)
                .role("button")
                .label(lane.label.clone())
                .focusable(true)
                .child(glyph(symbol, 14., MUTED))
                .child(title(&lane.label, 12., 500., TEXT))
                .on_press(move |s: &mut Studio| s.send(RoomCommand::Select { clip: clip.clone() }));
            if !compact {
                name = name.grow(1.);
            }
            let settings = el()
                .key(format!("device-{source}"))
                .size(22., 22.)
                .center()
                .role("button")
                .label(format!("{} settings", lane.label))
                .focusable(true)
                .child(glyph("settings", 14., MUTED))
                .on_press(move |s: &mut Studio| {
                    open_source(s, &source, PanelId::Sources, format!("device-{source}"));
                });
            list = list.child(
                tile(format!("source-row-{}", lane.id), selected)
                    .child(name)
                    .child(el().size(4., 4.).radius(2.).fill(color(if ready {
                        MINT
                    } else {
                        0x52636f
                    })))
                    .child(settings),
            );
        }
    }
    if compact {
        row()
            .w_full()
            .min_w(0.)
            .items_center()
            .gap(4.)
            .child(list.min_w(0.).grow(1.).scroll_x())
            .child(list_add(id))
    } else { list }
}
pub(super) fn list_add(id: PanelId) -> El {
    (if id == PanelId::Scenes {
        send_tool(
            "add-scene",
            "plus",
            "Add scene",
            false,
            RoomCommand::SceneAdd,
        )
    } else {
        tool("add-source", "plus", "Add source", false, |s| {
            open_source(s, "add", PanelId::Sources, "add-source".into())
        })
    }
    ).size(24., 24.)
}
fn strip(s: &Studio, id: PanelId, edge: Edge) -> El {
    let l = s.live.as_ref().unwrap();
    let snap = &l.snapshot;
    let p = &snap.project;
    let mut r = row().h(34.).items_center().gap(4.).min_w(0.);
    match id {
        PanelId::Sources | PanelId::Scenes => return studio_list(snap, id, true),
        PanelId::Mixer => return super::mixer::channels(s, true),
        PanelId::People => {
            r = r.child(button("guest-link","Invite a guest",false,super::people::guest_link))
                .child(super::people::trigger(s));
            if super::people::audience_live(s) {
                r = r.child(button("audience-link","Audience link",false,
                    |s| copy_link(s,crate::room_share::LinkKind::Audience,Some(PanelId::People),"audience-link")));
            }
        }
        PanelId::Controls => {
            let key = p.mounted_set.as_deref().unwrap_or(&p.scene);
            r = r.child(
                row()
                    .key("edit-set")
                    .gap(5.)
                    .items_center()
                    .role("button")
                    .focusable(true)
                    .label("Edit set")
                    .child(glyph("panels", 14., MUTED))
                    .child(title(crate::model::set_label(key), 12., 520., TEXT))
                    .on_press(super::editor::open),
            );
        }
        PanelId::Assistant => return super::chat::compact(s),
        PanelId::Clips => {
            if let Some((st, _)) = &l.clip_view {
                let name = format!("Save last {}s", st.settings.seconds);
                if st.ready {
                    r = r.child(command("save-clip", name, false, RoomCommand::ClipsSave));
                } else {
                    r = r.child(
                        el().px(8.)
                            .h(28.)
                            .center()
                            .border(1., color(0x243240))
                            .radius(5.)
                            .child(title(name, 11., 500., MUTED)),
                    );
                }
                r = r
                    .child(clip_switch("buffer-clips", st.enabled))
                    .child(title(
                        format!("Clips · {}", st.recent.len()),
                        11.,
                        500.,
                        TEXT,
                    ));
            }
        }
        PanelId::Sound => {
            let desk = &l.handle.studio_audio;
            r = r.child(send_tool(
                "sounds-stop",
                "stop",
                "Stop sounds",
                false,
                RoomCommand::StudioAudio {
                    command: Audio::StopSounds,
                },
            ));
            for item in desk.room_sounds("", 0, 256).items {
                r = r.child(command(
                    format!("sound-{}", item.id),
                    item.name,
                    false,
                    RoomCommand::StudioAudio {
                        command: Audio::Trigger {
                            id: item.id,
                            mode: None,
                        },
                    },
                ));
            }
        }
        PanelId::Publish => return r.child(button("publish-new","New post",false,move |s| { s.send(RoomCommand::Workspace { command: WorkspaceCommand::Collapse { edge, collapsed:false } }); super::publish::new_post(s); }).disabled(s.publish.scope.is_none())),
        PanelId::Dj => return dj_strip(s, r),
        _ => {
            r = r.child(command(
                format!("expand-{}", id.key()),
                id.label(),
                false,
                RoomCommand::Workspace {
                    command: WorkspaceCommand::Collapse {
                        edge,
                        collapsed: false,
                    },
                },
            ))
        }
    }
    r.scroll_x()
}
fn dock(
    s: &Studio,
    edge: Edge,
    width: f32,
    length: f32,
    ws: &crate::workspace::Workspace,
    viewport: [f32; 2],
) -> El {
    if s.editing_docks {
        return edit_dock(s, ws, edge, length, width, viewport);
    }
    let mut list = if edge.side() { col() } else { row() };
    let mut visible = ws.clone();
    // A collapsed shelf reserves the timeline's space for the active controls.
    // Expanding the shelf reveals its transport. A dedicated timeline shelf keeps it.
    if ws.docks[&edge].collapsed
        && ws.at(edge).len() > 1
        && ws.panels[&PanelId::Timeline].edge == edge
    {
        visible.panels.get_mut(&PanelId::Timeline).unwrap().visible = false;
    }
    let spans = visible.panel_spans(edge, length, false);
    for (index, &(id, _, span)) in spans.iter().enumerate() {
        if index > 0 {
            let (first, _, before) = spans[index - 1];
            list = list.child(split_handle(
                edge,
                first,
                id,
                before / (before + span).max(1.),
                (before + span).max(1.),
            ));
        }
        let frame = &ws.panels[&id];
        let mut panel = super::panel_frame::surface(id, frame);
        let split_publish = !edge.side() && span >= 480.;
        let composing = id == PanelId::Publish && s.publish.composing;
        if !ws.docks[&edge].collapsed && !composing {
            if let Some(header) = super::panel_frame::header(s, id, frame.header, split_publish) { panel = panel.child(header); }
        }
        if ws.docks[&edge].collapsed {
            panel = panel.child(strip(s, id, edge));
        } else if composing {
            panel = panel.child(super::publish::inline_composer(s, split_publish));
        } else if id == PanelId::Publish && split_publish {
            panel = panel.child(super::publish::panel(s, col().gap(5.), true, frame.header == crate::workspace::HeaderMode::Hidden));
        } else if id == PanelId::Assistant {
            panel = panel.padding(0.).gap(0.).child(super::chat::panel(s, false));
        } else {
            if id == PanelId::Network {
                if let Some(switcher) = super::network::switcher(s) {
                    panel = panel.child(switcher);
                }
            }
            let body = panel_body(s, id, edge, if edge.side() { width } else { span });
            panel = if id == PanelId::Controls && !edge.side() {
                panel.child(body)
            } else {
                panel.child(super::panel_frame::scroll_body(id, body))
            };
        }
        list = list.child(panel);
    }
    list.min_h(0.).min_w(0.)
}
fn clip_file_tool(id: &str, icon: &str, label: &str, path: PathBuf, reveal: bool) -> El {
    tool(id, icon, label, false, move |s| {
        let path = path.clone();
        s.room_task(move |_| {
            let mut command = std::process::Command::new("/usr/bin/open");
            if reveal { command.arg("-R"); }
            anyhow::ensure!(command.arg(path).status()?.success(), "Could not open saved clip");
            Ok(String::new())
        });
    }).size(26., 26.)
}

fn clip_switch(key: &'static str, enabled: bool) -> El {
    let track = row().size(32., 18.).px(2.).radius(9.).items_center()
        .fill(color(if enabled { MINT } else { MUTED }));
    let track = if enabled { track.justify_end() } else { track };
    row().key(key).role("switch").label("Clips").checked(enabled).focusable(true)
        .h(28.).items_center().gap(4.)
        .child(track.child(el().size(14., 14.).radius(7.).fill(color(BG))))
        .on_press(move |s: &mut Studio| s.send(RoomCommand::ClipsEnable { enabled: !enabled }))
}

pub(super) fn clip_actions(s: &Studio) -> Option<El> {
    let (state, _) = s.live.as_ref()?.clip_view.as_ref()?;
                let hint = if state.saving {
                    "Saving…".into()
                } else if state.enabled && state.ready {
                    format!("Rolling · {}:{:02}", state.elapsed / 60, state.elapsed % 60)
                } else if state.enabled {
                    "Buffering…".into()
                } else {
                    String::new()
                };
                Some(row()
                        .items_center()
                        .gap(4.)
                        .child(title(hint, 11., 500., MUTED))
                        .child(clip_switch("clips-enable", state.enabled))
                        .child(
                            tool(
                                "clip-settings",
                                "settings",
                                "Clips settings",
                                s.clip_settings,
                                |s| s.clip_settings = !s.clip_settings,
                            )
                            .size(26., 26.),
                        ),
                )
}
fn show_clock(seconds: f64) -> String {
    let seconds = seconds.max(0.) as u64;
    if seconds >= 3600 { format!("{}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60) }
    else { format!("{}:{:02}", seconds / 60, seconds % 60) }
}

fn show_controller(s: &Studio, snap: &Snapshot, show_id: &str,
    show: &producer_production_contract::Show, set: &producer_production_contract::Set) -> Option<El> {
    let segments = &show.segments;
    let active = snap.program_kind == "show" && snap.project.playing_segment.as_ref()
        .is_some_and(|(id, _)| id == show_id);
    let index = snap.project.playing_segment.as_ref().filter(|_| active)
        .and_then(|(_, id)| segments.iter().position(|part| &part.id == id)).unwrap_or(0);
    let current = segments.get(index)?;
    let duration = snap.project.segment_duration(show_id, current);
    let elapsed = if !active { 0. } else if let Some(limit) = duration {
        snap.program_position.clamp(0., limit)
    } else { snap.segment_elapsed };
    let playing = active && snap.program_playing;
    let finished = active && index + 1 == segments.len() && duration.is_some_and(|d| elapsed >= d);
    let expanded = s.expanded_rundown.as_deref() == Some(show_id);
    let run = |i: usize, paused: bool, restart: bool| RoomCommand::RunSegment {
        show: show_id.to_owned(), segment: segments[i].id.clone(), paused, restart,
    };
    let play = if !active || finished { run(0, false, true) } else {
        RoomCommand::ShowPlayback { show: show_id.to_owned(), segment: current.id.clone(), playing: !playing }
    };
    let toggle = if playing { ("pause", "Pause show") } else if active && !finished {
        ("play", "Resume show")
    } else { ("play", "Play show") };
    let id = show_id.to_owned();
    let header = row().key(format!("rundown-{show_id}")).role("button").focusable(true)
        .label(format!("{} rundown · {}", if expanded { "Collapse" } else { "Expand" }, current.title))
        .help(if expanded { "Hide other segments" } else { "Show all segments" })
        .items_center().gap(6.).px(8.).h(30.).radius(5.).hover_fill(color(theme::SELECTED_HOVER))
        .child(glyph("timeline", 14., MUTED)).child(title("Segments", 13., 650., TEXT).grow(1.))
        .child(title(format!("Segment {} of {}", index + 1, segments.len()), 10., 550., MUTED))
        .child(glyph(if expanded { "chevron-up" } else { "chevron-down" }, 13., MUTED))
        .on_press(move |s: &mut Studio| s.expanded_rundown = (!expanded).then(|| id.clone()));
    let status = if !active { "READY" } else if finished { "FINISHED" } else if playing { "PLAYING" } else { "PAUSED" };
    let mut summary = row().items_center().gap(7.);
    if let Some(image) = s.set_library.shot_image(&show.set, set, &current.landscape, 54., 31.) { summary = summary.child(image); }
    summary = summary.child(col().min_w(0.).gap(2.).grow(1.)
        .child(title(status, 9., 650., if playing { MINT } else { MUTED }))
        .child(title(current.title.clone(), 13., 650., TEXT)));
    let mut timing = row().key("segment-time").items_center().gap(7.);
    if let Some(limit) = duration {
        timing = timing.child(el().grow(1.).h(4.).radius(2.).clip_rounded(2.).fill(color(theme::SLIDER_RAIL_COMPACT))
            .child(el().h_full().w_frac((elapsed / limit.max(0.001)).clamp(0.,1.) as f32).fill(color(MINT))))
            .child(title(format!("{} / {}",show_clock(elapsed),show_clock(limit)), 11., 620., TEXT));
    } else {
        timing = timing.child(title("Open-ended", 10., 520., MUTED).grow(1.))
            .child(title(show_clock(elapsed), 11., 620., TEXT));
    }
    let control = |name: &str, icon: &str, label: &str, accent: bool, command: RoomCommand, available: bool| {
        send_tool(&format!("show-{show_id}-{name}"), icon, label, accent, command)
            .size(30., 27.).opacity(if available { 1. } else { 0.32 }).disabled(!available)
    };
    let transport = row().items_center().gap(3.).h(31.)
        .child(control("previous", "previous", "Previous segment", false, run(index.saturating_sub(1), !playing, false), active && index > 0))
        .child(control("play-pause", toggle.0, toggle.1, true, play, true))
        .child(control("next", "next-track", "Next segment", false, run((index + 1).min(segments.len()-1), !playing, false), active && index + 1 < segments.len()))
        .child(control("restart", "restart", "Restart show from the first segment", false, run(0, false, true), active))
        .child(el().min_w(0.).grow(1.))
        .child(col().gap(1.).child(title("Show time", 9., 550., MUTED))
            .child(title(show_clock(if active { snap.show_elapsed } else { 0. }), 11., 650., TEXT)));
    let mut player = col().gap(7.).px(7.).py(6.).min_w(0.).radius(6.)
        .fill(color(theme::TOOL)).child(summary).child(timing).child(transport);
    if show.set == "my-first-million" {
        player = player.child(host_direction_settings(s, snap, show_id, &current.id));
    }
    let mut panel = col().gap(3.).py(4.).min_w(0.).radius(8.)
        .border(1., color(theme::SLIDER_RAIL_COMPACT)).fill(color(SURFACE)).px(4.).child(header).child(player);
    if expanded {
        for (i, segment) in segments.iter().enumerate() {
            let is_current = i == index;
            let item = row().key(format!("run-{show_id}-{}", segment.id)).role("button").focusable(true)
                .label(format!("{} · {}", if is_current && active { status } else { "Take" }, segment.title))
                .items_center().gap(7.).px(8.).h(29.).radius(4.)
                .fill(color(if is_current { theme::TOOL_SELECTED } else { SURFACE })).hover_fill(color(theme::SELECTED_HOVER))
                .child(title(format!("{:02}", i + 1), 10., 550., MUTED))
                .child(title(segment.title.clone(), 11., 600., if is_current { MINT } else { TEXT }).grow(1.).min_w(0.))
                .child(if is_current && active { el().size(6.,6.).radius(3.).fill(color(MINT)) } else { glyph("play", 10., MUTED) });
            let cmd = run(i, false, false);
            panel = panel.child(item.on_press(move |s: &mut Studio| {
                if !is_current || !active { s.send(cmd.clone()); }
            }));
        }
    }
    if expanded && current.sequence.is_some() {
        panel = panel.child(row().items_center().gap(4.).px(5.)
            .child(title("Timing", 10., 560., MUTED).grow(1.))
            .child(command(format!("segment-timing-{show_id}"), if duration.is_some() { "Timed" } else { "Open-ended" },
                duration.is_some(), RoomCommand::SegmentTiming { show: show_id.into(), segment: current.id.clone(), timed: duration.is_none() })
                .help(if duration.is_some() { "Make this segment open-ended" } else { "Use the authored duration" })));
    }
    Some(panel)
}
fn host_direction_settings(s: &Studio, snap: &Snapshot, show: &str, segment: &str) -> El {
    let settings = &snap.project.mfm_direction;
    let enabled = snap.project.speaker_segments.get(show).is_some_and(|ids| ids.contains(segment));
    let configure = |enabled, settings| RoomCommand::MfmDirection { show: show.into(), segment: segment.into(), enabled, settings };
    let mut b = col().gap(4.).child(row().gap(4.).items_center()
        .child(glyph("waveform", 15., MUTED))
        .child(title("Follow active speaker", 12., 600., TEXT).grow(1.))
        .child(command(format!("auto-host-shots-{show}-{segment}"), if enabled { "On" } else { "Off" }, enabled,
            configure(!enabled, settings.clone())).help("Automatically follow Shaan and Sam during this segment")));
    let p = &snap.project;
    let missing = settings.microphones.iter().any(|id| if id == "rtc-guest" { !snap.guest_audio_received } else { !slot_ready(snap,id) });
    if enabled && missing {
        b = b.child(title("Assign both host microphones in Sources.", 11., 520., MUTED));
    } else if enabled && settings.microphones.iter().any(|id| p.lanes.iter().find(|l| &l.source == id).is_some_and(|l| l.muted || l.gain <= 0.)) {
        b = b.child(title("Unmute the host microphones in Mixer.", 11., 520., MUTED));
    }
    b
}
pub(super) fn edit_set_button() -> El {
    tool("edit-set", "settings", "Edit set", false, super::editor::open).size(22., 22.)
}

fn set_controls_header(snap: &Snapshot, show_id: Option<&str>, key: &str, pair: &crate::model::SetLayoutPair, on: bool, width: f32, shelf: bool) -> El {
    let project = &snap.project;
    let mut heading = row().items_center().gap(6.)
        .child(title(crate::model::set_label(show_id.unwrap_or(key)), 18., 650., TEXT).grow(1.));
    if project.workspace.panels[&PanelId::Controls].header == crate::workspace::HeaderMode::Hidden {
        heading = heading.child(edit_set_button());
    }

    let mut status = row().key("set-header-status").items_center().gap(5.);
    let active = snap.program_segment.as_ref()
        .filter(|_| snap.program_kind == "show")
        .and_then(|(id, segment)| {
            let show = project.production.shows.get(id)?;
            (show_id == Some(id.as_str()) && show.set == key).then_some((id, segment, show))
        });
    if let Some((show_id, current, show)) = active {
        let running = snap.program_playing;
        let finished = !running && show.segments.last().is_some_and(|last| {
            &last.id == current && project.segment_duration(show_id, last)
                .is_some_and(|duration| snap.program_position >= duration)
        });
        let label = if running { "Running" } else if finished { "Finished" } else { "Paused" };
        if running {
            status = status.child(el().size(6., 6.).radius(3.).fill(color(MINT)));
        }
        status = status
            .child(title(label, 11., 600., if running { MINT } else { TEXT }))
            .child(title(show_clock(snap.show_elapsed), 11., 600., TEXT).key("set-show-time"))
            .child(title("·", 11., 500., MUTED));
    } else if show_id.is_some() {
        status = status.child(title("Ready", 11., 600., TEXT)).child(title("·", 11., 500., MUTED));
    }
    status = status.child(title(if on { "On output" } else { "Prepared" }, 10., 500., MUTED));

    let scene = project.active_scene.clone();
    let set_id = key.to_owned();
    let selected_show = show_id.map(str::to_owned);
    let opener = show_id.and_then(|id| project.production.shows.get(id)?.segments.first().map(|seg| (id.to_owned(), seg.id.clone())));
    let layouts = pair.clone();
    let action_label = if on { "Switch output to studio scene" } else { "Show set on output" };
    let mut action = row().key("control-set-output").role("button").focusable(true)
        .label(action_label).help(action_label).h(24.).px(6.).gap(4.).items_center().radius(5.)
        .fill(color(SURFACE)).hover_fill(color(theme::GRIP_HOVER))
        .child(glyph(if on { "back" } else { "studio" }, 12., MUTED));
    if shelf || width >= 245. {
        action = action.child(title(if on { "Studio scene" } else if show_id.is_some() { "Take show" } else { "Take set" }, 10., 580., TEXT));
    }
    action = action.on_press(move |s: &mut Studio| {
        s.set_selection = Some(super::editor::ControllerSelection::new(scene.clone(), set_id.clone(), layouts.clone(), selected_show.clone()));
        if !on {
            if let Some((show, first)) = &opener {
                s.send(RoomCommand::RunSegment { show: show.clone(), segment: first.clone(), paused: true, restart: true });
                return;
            }
        }
        s.send(RoomCommand::SetMount {
            id: (!on).then(|| set_id.clone()),
            layout: (!on).then(|| layouts.clone()),
        });
    });
    let output = match snap.program_kind.as_str() {
        "timeline" => "Timeline on output".into(),
        "show" => "Show on output".into(),
        "set" => project.mounted_set.as_deref().map(|id| format!("On output · {}", crate::model::set_label(id)))
            .unwrap_or_else(|| "Studio scene on output".into()),
        _ => "Studio scene on output".into(),
    };
    let mut actions = row().items_center().h(24.).gap(3.);
    if !on && snap.program_kind == "set" && project.mounted_set.is_some() {
        actions = actions.child(tool("configure-output-set", "studio", "Configure set on output", false,
            |s| s.set_selection = None).size(22., 22.).help(output.clone()));
    }
    actions = actions.child(action);
    let status = status.min_w(0.).h(16.).help(output);
    let header = col().key("set-controls-header").min_w(0.).gap(5.).child(heading.h(23.));
    let header = if shelf {
        header.child(status).child(actions.self_start())
    } else {
        header.child(row().h(24.).items_center().gap(4.).child(status.grow(1.)).child(actions))
    };
    header.child(el().key("set-header-divider").h(1.).w_full().fill(color(theme::SEAM)))
}

fn set_disclosure(id: &str, name: &str, detail: &str, open: bool, toggle: impl Fn(&mut Studio) + 'static) -> El {
    row().key(id.to_owned()).label(format!("{} {name}", if open { "Collapse" } else { "Expand" }))
        .role("button").focusable(true).items_center().gap(5.).h(27.).px(5.).radius(5.)
        .hover_fill(color(SURFACE)).child(title(name, 12., 640., TEXT))
        .child(title(detail, 10., 500., MUTED).grow(1.))
        .child(glyph(if open { "chevron-up" } else { "chevron-down" }, 13., MUTED)).on_press(toggle)
}

fn mfm_zoom_control(pair: &crate::model::SetLayoutPair, subject: crate::model::MfmSubject, percent: u16) -> El {
    let label = subject.label();
    let prefix = format!("shot-zoom-{}", label.replace(' ', "-").to_lowercase());
    let op = |percent| RoomCommand::MfmZoom { layout: pair.clone(), subject, percent };
    let step = |direction: &str, glyph: &str, next| {
        command(format!("{prefix}-{direction}"), glyph, false, op(next)).size(22., 23.).padding(0.)
            .label(format!("Zoom {label} {direction}")).disabled(next == percent)
    };
    row().w_full().items_center().gap(3.)
        .child(title(label, 11., 550., TEXT).grow(1.))
        .child(step("out", "−", percent.saturating_sub(10).max(100)))
        .child(command(format!("{prefix}-reset"), format!("{:.1}×", f32::from(percent)/100.), false, op(100))
            .size(32., 23.).padding(0.).help(format!("Reset {label} zoom")))
        .child(step("in", "+", (percent + 10).min(300)))
}

fn panel_body(s: &Studio, id: PanelId, edge: Edge, width: f32) -> El {
    let l = s.live.as_ref().unwrap();
    let snap = &l.snapshot;
    let p = &snap.project;
    let mut b = col().gap(4.).min_w(0.);
    match id {
        PanelId::Scenes | PanelId::Sources => studio_list(snap, id, false),
        PanelId::Mixer => super::mixer::channels(s, false),
        PanelId::Controls => {
            if let Some((selected, pair)) = super::editor::selection(s, p) {
                let key = &selected;
                let set = &p.production.sets[key];
                let shelf = !edge.side();
                // Allow compact shelves to pan across the three panes once their controls
                // reach their minimum usable widths. Each pane scrolls vertically on its own.
                let padding = if theme::orbital() { 16. } else { 12. };
                let usable = (width - padding - 26.).max(0.); // two seams and four 6-point gaps
                let extra = (usable - 485.).max(0.);
                let overview_width = 150. + extra * 0.25;
                let center_width = 205. + extra * 0.35;
                let end_width = 130. + extra * 0.40;
                let show_id = super::editor::controller_show(s, snap, key);
                let running = snap.program_kind == "show" && snap.program_segment.as_ref().is_some_and(|(id, _)| Some(id.as_str()) == show_id);
                let pair = if running || (snap.active_host_shot.is_some() && p.mounted_set.as_ref() == Some(key)) { snap.program_layout.clone().unwrap_or(pair) } else { pair };
                let on = running || (show_id.is_none() && snap.program_kind == "set" && (l.handle.is_set_on_output(key, &pair, set) || (snap.active_host_shot.is_some() && p.mounted_set.as_ref() == Some(key))));
                let header = set_controls_header(snap, show_id, key, &pair, on, width, shelf);
                let mut players = Vec::new();
                if let Some((id, show)) = show_id.and_then(|id| p.production.shows.get(id).filter(|show| &show.set == key).map(|show| (id, show))) {
                    if let Some(player) = show_controller(s, snap, id, show, set) {
                        players.push(player);
                    }
                }
                let has_show = !players.is_empty();
                b = b.gap(8.);
                let shots_open = !s.folded_shots.contains(key);
                let layout_open = s.expanded_layout_controls.contains(key);
                let choices = p.set_layout_choices(key);
                let active_shot = choices.iter().find(|choice| choice.pair == pair)
                    .map(|choice| if key == "my-first-million" && pair.landscape == "landscape" { "Two hosts" } else { &choice.label }).unwrap_or("");
                let owner = key.clone();
                let mut shot_heading = row().items_center().h(27.).gap(3.).child(set_disclosure("set-shots-toggle", if has_show { "Shots" } else { "Layouts" },
                    if shots_open { "" } else { active_shot }, shots_open, move |s| {
                        if shots_open { s.folded_shots.insert(owner.clone()); } else { s.folded_shots.remove(&owner); }
                    }).grow(1.).min_w(0.));
                if let Some((show, segment)) = p.playing_segment.clone().filter(|_| running && p.shot_override.is_some()) {
                    shot_heading = shot_heading.child(send_tool("follow-show-layout", "back", "Follow rundown", false,
                        RoomCommand::ShowLayout { show, segment, layout: None }).size(23., 23.));
                }
                let mut shots = col().min_w(0.).gap(4.).child(shot_heading);
                let shot_area = if shelf {
                    if has_show { end_width } else { center_width }
                } else { width - 20. };
                let columns = ((shot_area + 5.) / 128.).floor().clamp(1., 4.);
                let shot_width = ((shot_area - (columns - 1.) * 5.) / columns).clamp(76., 230.);
                let mut layouts = row().flex_wrap().gap(5.);
                let slots = crate::set_slots::for_pair(p, set, &pair);
                for layout in choices.into_iter().filter(|_| shots_open) {
                    let k = key.clone();
                    let scene = p.active_scene.clone();
                    let chosen = layout.pair;
                    let show_segment = p.playing_segment.clone().filter(|_| running);
                    let selected_show = show_id.map(str::to_owned);
                    let active = chosen == pair;
                    let snap_directed = snap.active_host_shot.is_some();
                    let ready = crate::set_slots::for_pair(p, set, &chosen)
                        .iter().all(|slot| slot_ready(snap, &slot.source));
                    let label = format!("{} · {}", layout.label, if ready { "Ready" } else { "Needs source" });
                    let label_text = if key == "my-first-million" && chosen.landscape == "landscape" { "Two hosts".into() } else { layout.label };
                    let thumbnail = s.set_library.shot_image(key, set, &chosen.landscape, 40., 23.);
                    let mut item = row().key(format!("layout-{}", chosen.landscape))
                        .role("button").label(&label).help(&label).focusable(true)
                        .gap(4.).px(4.).items_center().radius(5.)
                        .border(1., color(if active { MINT } else { theme::SLIDER_RAIL_COMPACT }))
                        .fill(color(if active { theme::TOOL_SELECTED } else { SURFACE })).hover_fill(color(theme::SELECTED_HOVER));
                    if let Some(image) = thumbnail {
                        item = item.w(shot_width).h(34.)
                            .child(image).child(title(label_text, 11., 580., TEXT).grow(1.));
                    } else {
                        item = item.h(28.).child(title(label_text, 11., 550., if active { MINT } else { TEXT }));
                    }
                    layouts = layouts.child(item.child(el().size(6.,6.).radius(3.).fill(color(if ready { MINT } else { 0xe9b666 })))
                        .on_press(move |s: &mut Studio| {
                            if let Some((show, segment)) = &show_segment {
                                s.send(RoomCommand::ShowLayout { show: show.clone(), segment: segment.clone(), layout: Some(chosen.clone()) });
                            } else if !active || snap_directed {
                                s.set_selection = Some(super::editor::ControllerSelection::new(scene.clone(), k.clone(), chosen.clone(), selected_show.clone()));
                                if on {
                                    s.send(RoomCommand::SetMount {
                                        id: Some(k.clone()),
                                        layout: Some(chosen.clone()),
                                    });
                                }
                            }
                        },
                    ));
                }
                if shots_open { shots = shots.child(layouts); }
                let sources = super::set_sources::rows(s,key,&pair,&slots);
                let mut b = col().gap(5.);
                let uses = |uniform: &str| {
                    on && pair.ids().iter().any(|id|set.output_graphs.get(*id).and_then(|g|set.graphs.get(g)).is_some_and(|g|g.passes.iter().any(|pass|matches!(pass,producer_production_contract::GraphPass::Fragment{shader,..} if shader.contains(uniform)))))
                };
                let cam = f32::from_bits(l.handle.host_zoom.load(Ordering::Relaxed));
                let screen = f32::from_bits(l.handle.screen_zoom.load(Ordering::Relaxed));
                if uses("frame.controls.x") {
                    b = b.child(slider("Camera zoom", (cam - 1.) / 2., |s, v| {
                        if let Some(l) = &s.live {
                            l.handle
                                .host_zoom
                                .store((1. + v * 2.).to_bits(), Ordering::Relaxed);
                        }
                    }));
                }
                if uses("frame.controls.z") {
                    b = b.child(slider("Screen Share zoom", (screen - 1.) / 2., |s, v| {
                        if let Some(l) = &s.live {
                            l.handle
                                .screen_zoom
                                .store((1. + v * 2.).to_bits(), Ordering::Relaxed);
                        }
                    }));
                }
                if uses("frame.screenPan") {
                    let [x, y] = l.handle.screen_pan();
                    let controls_width = if !shelf { width } else if has_show { overview_width } else { end_width };
                    let size = (controls_width - 24.).clamp(84., 144.);
                    let marker = size * 0.21;
                    let mut pad = el()
                        .key("window-position")
                        .role("slider")
                        .label("Window position").help("Click to position or drag the square")
                        .cursor(rune::Cursor::Crosshair)
                        .size(size, size).min_h(size).min_w(size)
                        .fill(color(SURFACE))
                        .border(1., color(0x344758));
                    for n in 1..4 {
                        let pos = n as f32 * size / 4.;
                        let grid = if n == 2 { theme::GRIP } else { 0x23333e };
                        pad = pad
                            .child(el().absolute(pos, 0.).size(1., size).fill(color(grid)))
                            .child(el().absolute(0., pos).size(size, 1.).fill(color(grid)));
                    }
                    let place = move |v: f32| (v.clamp(-2., 2.) + 2.) * 0.25 * (size - marker);
                    b = b.child(title(format!("Window position   X {:+.0}%   Y {:+.0}%", x*100., y*100.), 11., 500., MUTED))
                        .child(
                            pad.child(
                                el().key("window-position-marker").absolute(place(x), place(y))
                                    .size(marker, marker)
                                    .radius(4.).border(1.,color(MINT))
                                    .fill(color(0x419b86)),
                            )
                            .on_drag(move |s: &mut Studio, d, _| {
                                if let Some(l) = &s.live {
                                    let current = l.handle.screen_pan();
                                    if matches!(d.phase, rune::Phase::Down) {
                                        let center = [place(current[0]) + marker/2., place(current[1]) + marker/2.];
                                        let inside = (d.x-center[0]).abs() <= marker/2. && (d.y-center[1]).abs() <= marker/2.;
                                        s.pan_grab = Some((current, if inside { [d.x-center[0], d.y-center[1]] } else { [0.,0.] }));
                                    }
                                    if let Some((initial, offset)) = s.pan_grab {
                                        let axis = |at: f32| 4. * ((at-marker/2.)/(size-marker)).clamp(0.,1.) - 2.;
                                        l.handle.set_screen_pan(if d.cancelled() { initial } else {
                                            [axis(d.x-offset[0]), axis(d.y-offset[1])]
                                        });
                                    }
                                    if matches!(d.phase, rune::Phase::Up) { s.pan_grab = None; }
                                }
                            }),
                        )
                        .child(button("center-window", "Center window", false, |s| {
                            if let Some(l) = &s.live {
                                l.handle.set_screen_pan([0., 0.]);
                            }
                        }));
                }
                if on
                    && pair
                        .ids()
                        .iter()
                        .any(|id| crate::headline::supports(set, id))
                {
                    let rev = snap.program_revision;
                    let size = crate::headline::size(set);
                    let wrap = crate::headline::wrap(set);
                    let shown = crate::headline::visible(set);
                    let update = |size, wrap| RoomCommand::Headline {
                        id: key.clone(),
                        revision: rev,
                        text: None,
                        size,
                        wrap,
                    };
                    let k = key.clone();
                    b = b
                        .child(title("Headline", 12., 550., TEXT))
                        .child(field("headline", &s.headline, |s| { s.headline_notice = None; &mut s.headline }))
                        .child(
                            row()
                                .items_center()
                                .gap(6.)
                                .child(title("Text size", 12., 500., MUTED))
                                .child(command(
                                    "headline-smaller",
                                    "−",
                                    false,
                                    update(
                                        Some(size.saturating_sub(4).max(crate::headline::MIN_SIZE)),
                                        None,
                                    ),
                                ))
                                .child(title(size.to_string(), 12., 500., TEXT))
                                .child(command(
                                    "headline-larger",
                                    "+",
                                    false,
                                    update(Some((size + 4).min(crate::headline::MAX_SIZE)), None),
                                )),
                        );
                    let mut wrapping = row().flex_wrap().gap(5.).items_center().child(title(
                        "Portrait wrap",
                        12.,
                        500.,
                        MUTED,
                    ));
                    for (id, label, opt) in [
                        ("auto", "Auto", crate::headline::Wrap::Auto),
                        ("one", "1 line", crate::headline::Wrap::OneLine),
                        ("two", "2 lines", crate::headline::Wrap::TwoLines),
                    ] {
                        wrapping = wrapping.child(command(
                            format!("headline-wrap-{id}"),
                            label,
                            wrap == opt,
                            update(None, Some(opt)),
                        ));
                    }
                    let stored = crate::headline::text(set).unwrap_or_default().to_owned();
                    let mut actions = row().gap(5.).child(button(
                        "headline-show",
                        if shown { "Update" } else { "Show" },
                        false,
                        move |s| {
                            let draft = s.headline.text.trim();
                            let value = if draft.is_empty() { stored.as_str() } else { draft };
                            if value.trim().is_empty() || value.chars().count() > 96 {
                                s.headline_notice = Some((k.clone(), "Enter a headline of 1–96 characters."));
                                return;
                            }
                            let value = value.to_owned();
                            s.headline_notice = None;
                            s.send(RoomCommand::Headline {
                                id: k.clone(),
                                revision: rev,
                                text: Some(value),
                                size: None,
                                wrap: None,
                            })
                        },
                    ));
                    if shown {
                        actions = actions.child(command(
                            "headline-hide",
                            "Hide",
                            false,
                            RoomCommand::Headline {
                                id: key.clone(),
                                revision: rev,
                                text: None,
                                size: None,
                                wrap: None,
                            },
                        ));
                    }
                    b = b.child(wrapping).child(actions);
                    if let Some((owner, message)) = &s.headline_notice {
                        if owner == key {
                            b = b.child(title(*message, 11., 500., 0xe9b666));
                        }
                    }
                }
                if set.theme.contains_key("marquee") {
                    let owner = key.clone();
                    b = b
                        .child(title("Next marquee", 12., 550., TEXT))
                        .child(field("marquee", &s.marquee, |s| &mut s.marquee))
                        .child(button("marquee-cue", "Cue", false, move |s| {
                            s.marquee_cue = Some((owner.clone(), s.marquee.text.trim().into()))
                        }));
                    if let Some((_, cue)) = s.marquee_cue.as_ref().filter(|(id, _)| id == key) {
                        if let Ok(lines) = crate::marquee::lines(cue) {
                            b = b.child(title(
                                if cue.is_empty() {
                                    "Clear marquee".into()
                                } else {
                                    lines.join(" ")
                                },
                                12.,
                                500.,
                                TEXT,
                            ));
                            if on {
                                b = b.child(command(
                                    "marquee-reveal",
                                    "Reveal",
                                    false,
                                    RoomCommand::MarqueeReveal {
                                        id: key.clone(),
                                        revision: snap.program_revision,
                                        text: cue.clone(),
                                    },
                                ));
                            }
                        } else {
                            b = b.child(title(
                                "Shorten the cue to fit two lines.",
                                11.,
                                500.,
                                MUTED,
                            ));
                        }
                    }
                }
                if set.theme.contains_key("weather-desk") {
                    if let Some(selected) = snap.forecast_view {
                        let mut filters = row().gap(4.).flex_wrap();
                        for (view, label) in crate::weather::View::CHOICES {
                            filters = filters.child(command(
                                format!("weather-{label}"),
                                label,
                                view == selected,
                                RoomCommand::ForecastView { view },
                            ));
                        }
                        b = b.child(title("Forecast", 12., 500., MUTED)).child(filters);
                        for (slot, label) in [
                            (crate::weather::CitySlot::Primary, "City"),
                            (crate::weather::CitySlot::Comparison, "Compare with"),
                        ] {
                            let name = snap.forecast_cities[slot as usize]
                                .as_deref()
                                .unwrap_or("Choose city");
                            b = b.child(button(
                                format!("city-slot-{label}"),
                                format!("{label}    {name}"),
                                false,
                                move |s| {
                                    s.city_slot = if s.city_slot == Some(slot) {
                                        None
                                    } else {
                                        Some(slot)
                                    };
                                    s.city_query = TextEdit::new("");
                                    s.city_results.clear();
                                    s.city_searched.clear();
                                    s.city_worker = None;
                                },
                            ));
                            if s.city_slot == Some(slot) {
                                b = b
                                    .child(field("city-query", &s.city_query, |s| {
                                        &mut s.city_query
                                    }))
                                    .child(button("city-search", "Search", false, |s| {
                                        let q = s.city_query.text.trim().to_owned();
                                        let (tx, rx) = mpsc::channel();
                                        s.city_worker = Some(rx);
                                        s.city_searched = q.clone();
                                        s.city_results.clear();
                                        std::thread::spawn(move || {
                                            let _ = tx.send(crate::weather::search(&q));
                                        });
                                    }));
                                if s.city_query.text.trim() == s.city_searched {
                                    for (i, place) in s.city_results.iter().enumerate() {
                                        let loc = place.connection();
                                        b = b.child(button(
                                            format!("city-result-{i}"),
                                            place.label(),
                                            false,
                                            move |s| {
                                                s.send(RoomCommand::ForecastCity {
                                                    slot,
                                                    location: loc.clone(),
                                                });
                                                s.city_slot = None;
                                            },
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    b = b.child(command(
                        "camera-border-wave",
                        format!(
                            "Camera border wave   {}",
                            if snap.camera_border_wave { "On" } else { "Off" }
                        ),
                        snap.camera_border_wave,
                        RoomCommand::CameraBorderWave {
                            enabled: !snap.camera_border_wave,
                        },
                    ));
                }
                if on && pair.has_flythrough(set) {
                    let playing = snap.set_motion_playing;
                    b = b.child(command(
                        "on-air-flythrough",
                        if playing {
                            "Pause flythrough"
                        } else {
                            "Play flythrough"
                        },
                        false,
                        RoomCommand::SetMotion {
                            id: key.clone(),
                            layout: pair.clone(),
                            revision: snap.program_revision,
                            playing: !playing,
                        },
                    ));
                }
                if on && set.theme.contains_key("quiz") {
                    let mut choices = row().flex_wrap().gap(4.);
                    for (v, id, label) in [
                        (0, "quiz-reset", "Reset"),
                        (1, "quiz-yes", "Reveal Yes"),
                        (-1, "quiz-no", "Reveal No"),
                    ] {
                        choices = choices.child(button(
                            id,
                            label,
                            l.handle.quiz_answer.load(Ordering::Relaxed) == v,
                            move |s| {
                                if let Some(l) = &s.live {
                                    l.handle.quiz_answer.store(v, Ordering::Relaxed)
                                }
                            },
                        ));
                    }
                    b = b.child(choices);
                }
                if set.theme.contains_key("ipo-chart") && uses("frame.controls.y") {
                    let line = l.handle.ipo_line_chart.load(Ordering::Relaxed);
                    b = b.child(button(
                        "ipo-chart-mode",
                        if line { "Chart: Lines" } else { "Chart: Bars" },
                        line,
                        |s| {
                            if let Some(l) = &s.live {
                                l.handle.ipo_line_chart.fetch_xor(true, Ordering::Relaxed);
                            }
                        },
                    ));
                }
                let mfm = key == "my-first-million";
                let layout_controls = mfm || uses("frame.controls.x") || uses("frame.controls.z") || uses("frame.screenPan")
                    || (on && pair.ids().iter().any(|id| crate::headline::supports(set, id)))
                    || set.theme.contains_key("marquee") || set.theme.contains_key("weather-desk") || (on && pair.has_flythrough(set))
                    || (on && set.theme.contains_key("quiz")) || (set.theme.contains_key("ipo-chart") && uses("frame.controls.y"));
                if layout_controls {
                    if mfm && layout_open {
                        use crate::model::MfmSubject;
                        let framing = p.mfm_framing.get(&pair.landscape).copied().unwrap_or([100; 3]);
                        for subject in [MfmSubject::Shaan, MfmSubject::Sam, MfmSubject::Screen] {
                            if slots.iter().any(|slot| MfmSubject::from_slot(&slot.name) == Some(subject)) {
                                b = b.child(mfm_zoom_control(&pair, subject, framing[subject as usize]));
                            }
                        }
                    }
                    let owner = key.clone();
                    let mut sections = col().gap(4.).min_w(0.).child(set_disclosure("set-layout-toggle", "Layout controls", "",
                        layout_open, move |s| {
                            if layout_open { s.expanded_layout_controls.remove(&owner); } else { s.expanded_layout_controls.insert(owner.clone()); }
                        }));
                    if layout_open { sections = sections.child(b); }
                    shots = shots.child(el().w_full().h(1.).fill(color(theme::SEAM))).child(sections);
                }
                if shelf {
                    let pane = |key: &'static str, size: f32, content: El| {
                        col().key(key).w(size).min_w(size).h_full().min_h(0.)
                            .child(content.w_full()).scroll(Default::default())
                    };
                    let seam = || el().w(1.).h_full().fill(color(theme::SEAM));
                    let mut columns = row().key("set-control-columns").w_full().h(0.).min_h(0.).grow(1.).gap(6.);
                    if has_show {
                        let rundown = players.into_iter().fold(col().gap(6.), |column, player| column.child(player));
                        columns = columns
                            .child(pane("set-overview-column", overview_width, col().gap(8.).child(header).child(sources)))
                            .child(seam()).child(pane("set-segments-column", center_width, rundown))
                            .child(seam()).child(pane("set-shots-column", end_width, shots));
                    } else {
                        columns = columns
                            .child(pane("set-overview-column", overview_width, header))
                            .child(seam()).child(pane("set-shots-column", center_width, shots))
                            .child(seam()).child(pane("set-settings-column", end_width, sources));
                    }
                    return columns.scroll_x();
                }
                let stack = players.into_iter().fold(col().gap(8.).child(header), |column, player| column.child(player));
                return stack.child(shots).child(sources);
            } else {
                b = b.child(title(
                    "No Sets in this studio",
                    12.,
                    500.,
                    MUTED,
                ));
            }
            b
        }
        PanelId::Clips => {
            if let Some((state, _)) = &l.clip_view {
                b = b.child(
                    command(
                        "clips-save",
                        format!("Save last {}s", state.settings.seconds),
                        false,
                        RoomCommand::ClipsSave,
                    )
                    .disabled(!state.ready || state.saving),
                );
                if s.clip_settings {
                    let cfg = &state.settings;
                    let mut next = cfg.clone();
                    next.queue_for_publish = !cfg.queue_for_publish;
                    b = b.child(command(
                        "clips-local-queue",
                        if cfg.queue_for_publish {
                            "Add saved clips to local queue · On"
                        } else {
                            "Add saved clips to local queue · Off"
                        },
                        cfg.queue_for_publish,
                        RoomCommand::ClipsConfigure { settings: next },
                    ));
                    let mut lengths = row().gap(3.).flex_wrap();
                    for n in [15, 30, 60, 120] {
                        let mut next = cfg.clone();
                        next.seconds = n;
                        lengths = lengths.child(command(
                            format!("clips-{n}"),
                            format!("{n}s"),
                            cfg.seconds == n,
                            RoomCommand::ClipsConfigure { settings: next },
                        ));
                    }
                    b = b.child(lengths);
                    let mut formats = row().gap(3.).flex_wrap();
                    for fmt in [
                        crate::clips::Output::Landscape,
                        crate::clips::Output::Vertical,
                        crate::clips::Output::Both,
                    ] {
                        let mut next = cfg.clone();
                        next.output = fmt;
                        formats = formats.child(command(
                            format!("clips-{}", fmt.label()),
                            fmt.label(),
                            cfg.output == fmt,
                            RoomCommand::ClipsConfigure { settings: next },
                        ));
                    }
                    let cfg = cfg.clone();
                    b = b.child(formats).child(
                        row().child(
                            el().role("button")
                                .label("Change clips folder")
                                .key("clips-folder")
                                .h(26.)
                                .px(6.)
                                .center()
                                .fill(color(SURFACE))
                                .child(title("Change folder", 11., 550., TEXT))
                                .on_press_tx(move |_: &mut Studio, tx| {
                                    let cfg = cfg.clone();
                                    tx.open_folder(
                                        Default::default(),
                                        move |s: &mut Studio, r, _| match r {
                                            Ok(Some(folder)) => {
                                                let mut next = cfg.clone();
                                                next.folder = Some(folder);
                                                s.send(RoomCommand::ClipsConfigure {
                                                    settings: next,
                                                });
                                            }
                                            Ok(None) => {}
                                            Err(e) => s.error = e.to_string(),
                                        },
                                    );
                                }),
                        ),
                    );
                }
                if let Some(err) = &state.error {
                    b = b.child(title(err, 11., 500., 0xffadb3));
                }
                for clip in &state.recent {
                    let mut files = row().gap(4.).items_center();
                    for file in &clip.files {
                        let icon = match file.output {
                            crate::clips::Output::Landscape => "clip-landscape",
                            crate::clips::Output::Vertical => "clip-portrait",
                            crate::clips::Output::Both => "play",
                        };
                        let label = format!("Play {}", file.output.label());
                        files = files.child(clip_file_tool(
                            &format!("clip-{}-{}-false", clip.id, file.output.label()),
                            icon, &label, file.path.clone(), false,
                        ));
                    }
                    if let Some(file) = clip.files.first() {
                        files = files.child(clip_file_tool(
                            &format!("clip-{}-{}-true", clip.id, file.output.label()),
                            "folder", "Show in Finder", file.path.clone(), true,
                        ));
                    }
                    b = b.child(row().w_full().min_w(0.).items_center().gap(6.).padding(5.).radius(6.)
                        .border(1., color(theme::TRANSPORT_BORDER)).fill(color(SURFACE))
                        .child(title(&clip.name, 11., 550., TEXT).grow(1.).min_w(0.))
                        .child(files));
                }
            }
            b
        }
        PanelId::Timeline => super::timeline::panel(s, width),
        PanelId::Network => super::network::panel(s, b),
        PanelId::Publish => super::publish::panel(s, b, false, p.workspace.panels[&id].header == crate::workspace::HeaderMode::Hidden),
        PanelId::Dj | PanelId::Sound => audio(s, id, b, edge, width),
        PanelId::People => super::people::panel(s, b),
        PanelId::Assistant => b,
    }
}
fn audio(s: &Studio, panel: PanelId, mut b: El, edge: Edge, width: f32) -> El {
    let desk = &s.live.as_ref().unwrap().handle.studio_audio;
    let status = desk.status();
    let cmd = |key: String, label: String, on: bool, c| {
        command(key, label, on, RoomCommand::StudioAudio { command: c })
    };
    if panel == PanelId::Sound {
        let selected = desk.room_sounds("", 0, 256);
        let mut top = row().gap(4.).items_center().child(send_tool(
            "stop-sounds",
            "stop",
            "Stop sounds",
            false,
            RoomCommand::StudioAudio {
                command: Audio::StopSounds,
            },
        ));
        top = top.child(button(
            "sound-library",
            if s.sound_library {
                "Close library"
            } else {
                "Add sounds"
            },
            s.sound_library,
            |s| s.sound_library = !s.sound_library,
        ));
        b = b
            .child(top)
            .child(slider("Sound", status.sound_gain, |s, v| {
                s.send(RoomCommand::StudioAudio {
                    command: Audio::Gain {
                        bus: Bus::Sound,
                        value: v,
                    },
                })
            }));
        if s.sound_library {
            b = b.child(
                field("sound-search", &s.sound_query, |s| &mut s.sound_query)
                    .placeholder("Search effects", color(MUTED)),
            );
            for item in desk
                .catalog(Some(Kind::Effect), &s.sound_query.text, 0, 256)
                .items
            {
                let added = selected.items.iter().any(|a| a.id == item.id);
                b = b.child(cmd(
                    format!("library-{}", item.id),
                    format!("{}  {}", if added { "✓" } else { "+" }, item.name),
                    added,
                    Audio::SetSoundAdded {
                        id: item.id,
                        added: !added,
                    },
                ));
            }
        } else {
            let mut items = selected.items.into_iter();
            let columns = if edge.side() || width < 300. { 1 } else { 2 };
            while items.len() > 0 {
                let mut lane = row().min_w(0.).w_full().gap(3.);
                for item in items.by_ref().take(columns) {
                    lane = lane.child(
                        cmd(
                            format!("sound-{}", item.id),
                            item.name,
                            status.active_sounds.contains(&item.id),
                            Audio::Trigger {
                                id: item.id,
                                mode: None,
                            },
                        )
                        .w(0.)
                        .grow(1.),
                    );
                }
                b = b.child(lane);
            }
        }
        return b;
    }
    let audio_tool = |key: &str, g: &str, label: &str, on: bool, action| {
        send_tool(
            key,
            g,
            label,
            on,
            RoomCommand::StudioAudio { command: action },
        )
    };
    let wide = !edge.side() && width >= 400.;
    let mut decks = if edge.side() { col() } else { row() }.w_full().gap(4.);
    for deck in [DeckId::A, DeckId::B] {
        let i = deck.index();
        if i == 1 && !status.mixing {
            continue;
        }
        let d = &status.decks[i];
        let name =
            d.id.as_ref()
                .map(|id| desk.name(id))
                .unwrap_or_else(|| "Empty".into());
        let deck_view = row()
            .grow(1.)
            .min_w(0.)
            .items_center()
            .h(38.)
            .px(3.)
            .gap(4.)
            .radius(6.)
            .border(1., color(theme::TRANSPORT_BORDER))
            .fill(color(theme::TRANSPORT))
            .child(audio_tool(
                &format!("play-{i}"),
                if d.playing { "pause" } else { "play" },
                if d.playing { "Pause" } else { "Play" },
                d.playing,
                if d.playing {
                    Audio::PauseDeck { deck }
                } else {
                    Audio::PlayDeck { deck }
                },
            ))
            .child(
                el().grow(1.)
                    .min_w(0.)
                    .role("button")
                    .label(format!("Select deck {deck:?}"))
                    .child(title(
                        name,
                        12.,
                        620.,
                        if d.id.is_some() { TEXT } else { MUTED },
                    ))
                    .on_press(move |s: &mut Studio| s.dj_deck = i),
            )
            .child(audio_tool(
                &format!("next-{i}"),
                "next-track",
                "Next track",
                false,
                Audio::NextTrack { deck },
            ))
            .child(audio_tool(
                &format!("stop-{i}"),
                "stop",
                "Stop",
                false,
                Audio::StopDeck { deck },
            ));
        decks = decks.child(deck_view);
    }
    b = b
        .child(decks)
        .child(slider("Music", status.music_gain, |s, v| {
            s.send(RoomCommand::StudioAudio {
                command: Audio::Gain {
                    bus: Bus::Music,
                    value: v,
                },
            })
        }))
        .child(slider("Duck", status.duck_amount, |s, v| {
            s.send(RoomCommand::StudioAudio {
                command: Audio::DuckAmount { amount: v },
            })
        }))
        .child(
            row()
                .items_center()
                .gap(3.)
                .h(29.)
                .radius(5.)
                .fill(color(theme::TRANSPORT))
                .child(cmd(
                    "mix".into(),
                    "Mix".into(),
                    status.mixing,
                    Audio::Mix {
                        enabled: !status.mixing,
                    },
                ))
                .child(audio_tool(
                    "monitor-music",
                    "headphones",
                    "Monitor music",
                    status.monitor,
                    Audio::Monitor {
                        enabled: !status.monitor,
                    },
                ))
                .child(audio_tool(
                    "duck-music",
                    "mic",
                    "Duck music",
                    status.duck_music,
                    Audio::DuckMusic {
                        enabled: !status.duck_music,
                    },
                )),
        );
    if status.mixing {
        b = b.child(slider("Crossfade", status.crossfade, |s, v| {
            s.send(RoomCommand::StudioAudio {
                command: Audio::Crossfade { value: v },
            })
        }));
    }
    let track_column = col().min_w(0.).gap(3.).child(
        row()
            .h(24.)
            .items_center()
            .child(title("Tracks", 11., 500., MUTED))
            .child(el().grow(1.))
            .child(
                el().key("import-track")
                    .role("button")
                    .label("Import track")
                    .size(24., 24.)
                    .center()
                    .child(glyph("plus", 14., MUTED))
                    .on_press_tx(|_: &mut Studio, tx| {
                        tx.open_file(
                            rune::FileDialogOptions::default()
                                .filter("Audio", &["mp3", "wav", "m4a", "aiff", "flac"]),
                            |s: &mut Studio, r, _| match r {
                                Ok(Some(path)) => s.send(RoomCommand::StudioAudio {
                                    command: Audio::Import {
                                        kind: Kind::Music,
                                        path,
                                    },
                                }),
                                Ok(None) => {}
                                Err(e) => s.error = e.to_string(),
                            },
                        )
                    }),
            ),
    );
    let deck = if status.mixing && s.dj_deck == 1 {
        DeckId::B
    } else {
        DeckId::A
    };
    let mut tracks = col().gap(2.);
    for item in desk.catalog(Some(Kind::Music), "", 0, 256).items {
        let selected = status.decks[deck.index()].id.as_ref() == Some(&item.id);
        tracks = tracks.child(
            row()
                .key(format!("track-{}", item.id))
                .role("button")
                .label(item.name.clone())
                .h(19.)
                .items_center()
                .px(6.)
                .radius(3.)
                .fill(color(if selected { theme::TRACK_SELECTED } else { theme::TRACK }))
                .child(title(item.name, 11., 500., TEXT))
                .on_press(move |s: &mut Studio| {
                    s.send(RoomCommand::StudioAudio {
                        command: Audio::LoadDeck {
                            deck,
                            id: item.id.clone(),
                            play: false,
                        },
                    })
                }),
        );
    }
    let tracks = track_column.child(tracks);
    if wide {
        row()
            .w_full()
            .gap(8.)
            .child(b.w(0.).grow(1.2))
            .child(tracks.w(0.).grow(1.))
    } else {
        b.child(tracks)
    }
}
fn dj_strip(s: &Studio, strip: El) -> El {
    let desk = &s.live.as_ref().unwrap().handle.studio_audio;
    let status = desk.status();
    let deck = if status.mixing && s.dj_deck == DeckId::B.index() { DeckId::B } else { DeckId::A };
    let track = &status.decks[deck.index()];
    let name = track.loading.as_ref().or(track.id.as_ref())
        .map_or_else(|| "No track loaded".into(), |id| desk.name(id));
    let ready = track.loading.is_none() && track.duration > 0.;
    let key = track.id.clone();
    let seek = move |s: &mut Studio, progress: f32| {
        let Some(live) = &s.live else { return };
        let current = &live.handle.studio_audio.status().decks[deck.index()];
        if current.id == key && current.loading.is_none() && current.duration > 0. {
            s.send(RoomCommand::StudioAudio { command: Audio::SeekDeck {
                deck, seconds: f64::from(progress) * current.duration,
            }});
        }
    };
    let progress = if ready { (track.seconds / track.duration) as f32 } else { 0. };
    let time = |seconds: f64| {
        let seconds = seconds as u64;
        format!("{}:{:02}", seconds / 60, seconds % 60)
    };
    let transport = |key, glyph, label, active, action| {
        send_tool(key, glyph, label, active, RoomCommand::StudioAudio { command: action }).size(24., 26.)
    };
    let volume = compact_slider("dj-volume", "DJ volume", status.music_gain, |s, gain| {
        s.send(RoomCommand::StudioAudio { command: Audio::Gain { bus: Bus::Music, value: gain } });
    }).w(46.).h(23.)
        .help(format!("DJ volume {:.0}% · Scroll to adjust", status.music_gain * 100.))
        .on_wheel(|s: &mut Studio, event, _| {
            if event.dy == 0. || event.dy.abs() < event.dx.abs() {
                return false;
            }
            if !event.momentum {
                let delta = if event.notch { -event.dy.signum() * 0.04 } else { (-event.dy / 500.).clamp(-0.12, 0.12) };
                s.send(RoomCommand::StudioAudio { command: Audio::AdjustMusicGain { delta } });
            }
            true
        });
    strip.w_full().key("dj-compact").gap(3.)
        .child(transport("dj-previous", "previous", "Previous track", false, Audio::PreviousTrack { deck }))
        .child(transport("dj-play", if track.playing { "pause" } else { "play" },
            if track.playing { "Pause track" } else { "Play track" }, track.playing,
            if track.playing { Audio::PauseDeck { deck } } else { Audio::PlayDeck { deck } }).disabled(!ready))
        .child(transport("dj-next", "next-track", "Next track", false, Audio::NextTrack { deck }))
        .child(col().w(0.).grow(1.).min_w(104.).justify_center().gap(0.)
            .child(title(&name, 11., 600., TEXT).help(name.clone()))
            .child(compact_slider("dj-seek", "Seek within track", progress, seek).disabled(!ready)
                .help(format!("{} / {}", time(track.seconds), time(track.duration)))))
        .child(transport("dj-mute", if status.music_muted { "volume-off" } else { "volume" },
            if status.music_muted { "Unmute DJ" } else { "Mute DJ" }, status.music_muted,
            Audio::MuteMusic { muted: !status.music_muted }))
        .child(volume)
        .scroll_x()
}

fn compact_slider(key: &str, label: &str, value: f32, set: impl Fn(&mut Studio, f32) + 'static) -> El {
    let value = value.clamp(0., 1.);
    let set = std::rc::Rc::new(set);
    let keyboard = set.clone();
    let accessible = set.clone();
    el().key(key.to_owned()).w_full().h(13.).center().padding(1.)
        .role("slider").label(label.to_owned()).range_value(value.into(), 0., 1.).range_step(0.02)
        .child(row().w_full().h(4.).radius(2.).clip_rounded(2.).fill(color(theme::SLIDER_RAIL_COMPACT))
            .child(el().h_full().w_frac(value).fill(color(MINT))))
        .on_drag(move |s: &mut Studio, d, _| {
            if !d.cancelled() && d.w > 0. {
                set(s, (d.x / d.w).clamp(0., 1.));
            }
        })
        .on_step(move |s, delta, _| keyboard(s, (value + delta as f32 * 0.02).clamp(0., 1.)))
        .on_set_value(move |s, value, _| accessible(s, value as f32))
}

fn slider(label: &str, value: f32, set: impl Fn(&mut Studio, f32) + 'static) -> El {
    let frac = value.clamp(0., 1.);
    let track = el()
        .w_full()
        .h(14.)
        .center()
        .role("slider")
        .label(
            if label.is_empty() {
                "Microphone gain"
            } else {
                label
            }
            .to_owned(),
        )
        .child(
            row()
                .items_center()
                .w_full()
                .h(2.)
                .fill(color(theme::SLIDER_RAIL))
                .child(el().w_frac(frac).h(2.).fill(color(theme::SLIDER_VALUE)))
                .child(el().size(6., 6.).radius(3.).fill(color(theme::SLIDER_VALUE))),
        )
        .on_drag(move |s: &mut Studio, d, _| {
            if !d.cancelled() && d.w > 0. {
                set(s, (d.x / d.w).clamp(0., 1.));
            }
        });
    if label.is_empty() {
        return track.w(74.);
    }
    col()
        .gap(1.)
        .child(
            row()
                .w_full()
                .items_center()
                .child(title(label, 11., 500., MUTED))
                .child(el().grow(1.))
                .child(title(
                    if matches!(label, "Camera zoom" | "Screen Share zoom") {
                        format!("{:.2}×", 1. + 2. * frac)
                    } else {
                        format!("{:.0}%", frac * 100.)
                    },
                    11.,
                    500.,
                    MUTED,
                )),
        )
        .child(track)
}
fn split_handle(edge: Edge, first: PanelId, second: PanelId, ratio: f32, span: f32) -> El {
    let (rail, mark, cursor) = if edge.side() {
        (
            el().h(4.).w_full(),
            el().size(24., 2.),
            rune::Cursor::ResizeNs,
        )
    } else {
        (
            el().w(4.).h_full(),
            el().size(2., 16.),
            rune::Cursor::ResizeEw,
        )
    };
    rail.key(format!("split-{}-{}", first.key(), second.key()))
        .role("separator")
        .label(format!("Resize {} and {}", first.label(), second.label()))
        .center()
        .hit()
        .cursor(cursor)
        .hover_fill(color(theme::GRIP_HOVER))
        .child(mark.radius(1.).fill(color(theme::GRIP)))
        .on_drag(move |s: &mut Studio, d, _| {
            if d.cancelled() {
                s.resize = None;
                return;
            }
            if matches!(d.phase, rune::Phase::Down) {
                d.data = ratio;
            }
            let delta = if edge.side() { d.dy } else { d.dx };
            let cmd = WorkspaceCommand::ResizeSplit {
                first,
                second,
                ratio: (d.data + delta / span).clamp(0.05, 0.95),
            };
            if matches!(d.phase, rune::Phase::Up) {
                s.resize = None;
                s.send(RoomCommand::Workspace { command: cmd });
            } else {
                s.resize = Some(cmd);
            }
        })
}
fn grip(edge: Edge, size: f32, collapsed: bool) -> El {
    let side = edge.side();
    let line = if side {
        el().w(2.).h(28.)
    } else {
        el().w(28.).h(2.)
    };
    let rail = if side {
        el().w(5.).h_full()
    } else {
        el().h(5.).w_full()
    };
    rail.key(format!("resize-{}", edge.key()))
        .role("separator")
        .label(format!("Resize {} dock", edge.key()))
        .center().hit()
        .cursor(if side { rune::Cursor::ResizeEw } else { rune::Cursor::ResizeNs })
        .hover_fill(color(theme::GRIP_HOVER))
        .child(line.radius(1.).fill(color(theme::GRIP)))
        .on_drag(move |s: &mut Studio, d, _| {
            if matches!(d.phase, rune::Phase::Down) {
                d.data = size;
            }
            if d.cancelled() {
                s.resize = None;
                return;
            }
            let delta = match edge {
                Edge::Left => d.dx,
                Edge::Right => -d.dx,
                Edge::Top => d.dy,
                Edge::Bottom => -d.dy,
            };
            let c = crate::workspace::Workspace::dock_drag(edge, d.data, collapsed, delta);
            if matches!(d.phase, rune::Phase::Up) {
                s.resize = None;
                s.send(RoomCommand::Workspace { command: c });
            } else {
                s.resize = Some(c);
            }
        })
}

pub(super) fn guest_stage(s: &Studio) -> El {
    let l = s.live.as_ref().unwrap();
    let rtc = &l.snapshot.producer_rtc;
    let connected = rtc["phase"] == "connected";
    let tally = match (rtc["phase"].as_str(), rtc["stageTally"].as_bool()) {
        (Some("connected"), Some(true)) => "On stage",
        (Some("connected"), Some(false)) => "Backstage",
        (Some("connected"), _) => "Waiting for stage status",
        (Some("failed" | "ended" | "closed" | "disconnected"), _) => "Disconnected",
        _ => "Waiting for admission",
    };
    let mic = rtc["microphoneEnabled"].as_bool().unwrap_or(true);
    let camera = rtc["cameraEnabled"].as_bool().unwrap_or(true);
    let header = row()
        .items_center()
        .gap(6.)
        .h(46.)
        .child(title("Stage", 16., 650., TEXT))
        .child(title(
            tally,
            13.,
            500.,
            if connected { MINT } else { MUTED },
        ))
        .child(el().grow(1.))
        .child(command(
            "stage-mic",
            if mic { "Mute mic" } else { "Unmute mic" },
            !mic,
            RoomCommand::RtcMedia {
                microphone: Some(!mic),
                camera: None,
            },
        ))
        .child(command(
            "stage-camera",
            if camera { "Camera off" } else { "Camera on" },
            !camera,
            RoomCommand::RtcMedia {
                camera: Some(!camera),
                microphone: None,
            },
        ))
        .child(command(
            "stage-leave",
            "Leave stage",
            false,
            RoomCommand::RtcEnd,
        ));
    let mut screen = el().grow(1.).w_full().min_h(0.).center().fill(color(BG));
    if connected
        && l.handle
            .rtc_feed
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|g| g.frame().is_some())
    {
        screen = screen.native_surface(&l.surfaces[0], SurfaceFit::Fit);
    } else {
        screen = screen.child(title(
            rtc["reason"].as_str().unwrap_or(if connected {
                "Waiting for host picture"
            } else if tally == "Disconnected" {
                "The call has ended"
            } else {
                "The host will admit you to the studio"
            }),
            13.,
            500.,
            MUTED,
        ));
    }
    col()
        .key("guest-stage")
        .w_full()
        .h_full()
        .padding(14.)
        .child(el().w_full().h(24.).window_drag())
        .child(header)
        .child(screen)
}
fn toggle_docks(s: &mut Studio) {
    s.editing_docks = !s.editing_docks;
    s.drag_tile = None;
    s.studio_panels = false;
    s.panel_menu = None;
    s.moving_panel = None;
    s.drop_edge = None;
    s.resize = None;
    s.activity = false;
    s.source = None;
}
fn panel_placement(ws: &crate::workspace::Workspace, panel: PanelId, x: f32, y: f32, w: f32, h: f32) -> Option<WorkspaceCommand> {
    let bounds = ws.layout_extents(w, h - 79., true);
    let edge = crate::workspace::Workspace::drop_target(x, y, w, h, bounds)?;
    if !panel.accepts(edge) { return None; }
    let (coord, length) = if edge.side() {
        (y - 48. - bounds[2], h - 79. - bounds[2] - bounds[3])
    } else { (x, w) };
    Some(WorkspaceCommand::Place { panel, edge, before: ws.insertion_before(panel, edge, coord, length) })
}
fn edit_dock(
    s: &Studio,
    ws: &crate::workspace::Workspace,
    edge: Edge,
    length: f32,
    width: f32,
    [w, h]: [f32; 2],
) -> El {
    let side = edge.side();
    let bounds = s.live.as_ref().unwrap().snapshot.project.workspace.layout_extents(w, h - 79., true);
    let mut content = if side { col() } else { row() }
        .padding(2.)
        .min_w(0.)
        .min_h(0.)
        .fill(color(BG));
    if s.drop_edge == Some(edge) {
        content = content.border(1., color(MINT));
    }
    let spans = ws.panel_spans(edge, length, true);
    for (index, &(id, _, span)) in spans.iter().enumerate() {
        if index > 0 {
            let (prev, _, a) = spans[index - 1];
            content = content.child(split_handle(
                edge,
                prev,
                id,
                a / (a + span).max(1.),
                (a + span).max(1.),
            ));
        }
        let mut tile = el()
            .key(format!("panel-placeholder-{}", id.key()))
            .min_h(0.)
            .min_w(0.)
            .grow(ws.panels[&id].weight)
            .radius(6.)
            .fill(color(PANEL))
            .border(1., color(0x263443))
            .center()
            .child(title(id.label(), 14., 500., MUTED))
            .cursor(rune::Cursor::Grab)
            .on_drag(move |s: &mut Studio, d, _| {
                if d.cancelled() {
                    s.drag_tile = None;
                    s.drop_edge = None;
                    return;
                }
                if s.drag_tile.is_none() && d.dx.abs() + d.dy.abs() < 4. {
                    return;
                }
                let [x, y] = d.window_point();
                s.drag_tile = Some((id, [x, y]));
                let target =
                    crate::workspace::Workspace::drop_target(x, y, w, h, bounds);
                s.drop_edge = target;
                if matches!(d.phase, rune::Phase::Up) {
                    s.drop_edge = None;
                    s.drag_tile = None;
                    let ws = &s.live.as_ref().unwrap().snapshot.project.workspace;
                    if let Some(command) = panel_placement(ws, id, x, y, w, h) {
                        s.send(RoomCommand::Workspace { command });
                    }
                }
            });
        if s.drag_tile.is_some_and(|(dragged, _)| dragged == id) {
            tile = tile.fill(color(0x132a2c)).border(1., color(MINT));
        }
        tile = if side { tile.h(0.) } else { tile.w(0.) };
        let actions = row()
            .gap(2.)
            .absolute(((if side { width - 4. } else { span }) - 50.).max(0.), 4.)
            .child(
                button(format!("move-{}", id.key()), "⋯", false, move |s| {
                    s.studio_panels = false;
                    s.moving_panel = if s.moving_panel == Some(id) {
                        None
                    } else {
                        Some(id)
                    };
                    s.panel_menu = s.moving_panel.map(|_| edge);
                })
                .size(22., 22.)
                .px(0.),
            )
            .child(
                button(format!("hide-{}", id.key()), "×", false, move |s| {
                    s.send(RoomCommand::Workspace {
                        command: WorkspaceCommand::Visibility {
                            panel: id,
                            visible: false,
                        },
                    })
                })
                .size(22., 22.)
                .px(0.),
            );
        content = content.child(tile.child(actions));
    }
    let add = el()
        .key(format!("add-panel-{}", edge.key()))
        .role("button")
        .label("Add panel")
        .focusable(true)
        .center()
        .border(1., color(0x14202a))
        .radius(5.)
        .child(title("Add panel", 10., 500., MUTED))
        .on_press(move |s: &mut Studio| {
            s.studio_panels = false;
            s.panel_menu = if s.panel_menu == Some(edge) && s.moving_panel.is_none() {
                None
            } else {
                Some(edge)
            };
            s.moving_panel = None;
        });
    if spans.is_empty() {
        content = content.center().border(1., color(0x14202a));
    } else {
        content = content.child(if side {
            el().h(4.).w_full()
        } else {
            el().w(4.).h_full()
        });
    }
    content.child(if side {
        add.w_full().h(28.)
    } else {
        add.w(76.).h_full()
    })
}
fn dock_picker(
    s: &Studio,
    ws: &crate::workspace::Workspace,
    [w, h]: [f32; 2],
    extents: [f32; 4],
) -> Option<El> {
    if s.studio_panels {
        let mut menu = col()
            .key("studio-panels")
            .absolute(8., 48.)
            .w(260.)
            .max_h((h - 100.).max(64.))
            .padding(8.)
            .gap(3.)
            .radius(8.)
            .fill(color(PANEL))
            .border(1., color(0x263443))
            .child(button(
                "close-studio-panels",
                "Studio panels   ×",
                false,
                |s| s.studio_panels = false,
            ));
        for id in PanelId::launch_panels() {
            let edge = ws.panels[&id].edge;
            let dock = &ws.docks[&edge];
            let shown = ws.visible(id) && !dock.hidden && !(edge.side() && dock.collapsed);
            menu = menu.child(button(format!("toggle-{}", id.key()), id.label(), shown, move |s| {
                let command = if shown { WorkspaceCommand::Visibility { panel: id, visible: false } }
                    else { WorkspaceCommand::Activate { panel: id } };
                s.send(RoomCommand::Workspace { command });
                if id == PanelId::Assistant && !shown { toggle_docks(s); }
            }));
        }
        return Some(
            menu.child(command(
                "workspace-reset",
                "Reset studio layout",
                false,
                RoomCommand::Workspace {
                    command: WorkspaceCommand::Reset,
                },
            ))
            .scroll(Default::default()),
        );
    }
    let edge = s.panel_menu?;
    let candidates = PanelId::launch_panels()
        .filter(|p| p.accepts(edge) && !ws.at(edge).contains(p))
        .collect::<Vec<_>>();
    let (_, mut r) = ws.panel_picker(
        edge,
        w,
        h,
        extents,
        if s.moving_panel.is_some() {
            3
        } else {
            candidates.len()
        },
    );
    if let Some(id) = s.moving_panel {
        let length = if edge.side() {
            h - 79. - extents[2] - extents[3]
        } else {
            w
        };
        if let Some((_, offset, span)) = ws
            .panel_spans(edge, length, true)
            .into_iter()
            .find(|(p, _, _)| *p == id)
        {
            let (x, y) = match edge {
                Edge::Left => (6., 48. + extents[2] + offset + 28.),
                Edge::Right => (w - extents[1] + 6., 48. + extents[2] + offset + 28.),
                Edge::Top => (offset + span - 176., 76.),
                Edge::Bottom => (offset + span - 176., h - 50. - extents[3] + 28.),
            };
            let height = 320_f32.min((h - 80.).max(80.));
            r = [
                x.clamp(6., (w - 182.).max(6.)),
                y.clamp(48., (h - height - 24.).max(48.)),
                176.,
                height,
            ];
        }
    }
    let mut pane = col()
        .key("dock-panel-picker")
        .absolute(r[0], r[1])
        .w(r[2])
        .max_h(r[3])
        .padding(6.)
        .gap(4.)
        .radius(9.)
        .border(1., color(0x344856))
        .fill(color(0x111c27));
    let mut head = row()
        .items_center()
        .child(title(
            if s.moving_panel.is_some() {
                "Panel settings"
            } else {
                "Add panel"
            },
            14.,
            600.,
            TEXT,
        ))
        .child(el().grow(1.));
    head = head.child(button("close-picker", "×", false, |s| {
        s.panel_menu = None;
        s.moving_panel = None;
    }));
    pane = pane.child(head);
    if let Some(id) = s.moving_panel {
        {
            pane = pane.child(title("Header", 11., 550., MUTED));
            use crate::workspace::HeaderMode;
            for (mode, name) in [(HeaderMode::Standard,"Standard"),(HeaderMode::Compact,"Compact"),(HeaderMode::Hidden,"Hidden")] {
                pane = pane.child(command(format!("panel-header-{}", name.to_lowercase()), name,
                    ws.panels[&id].header == mode,
                    RoomCommand::Workspace { command: WorkspaceCommand::SetHeader { panel:id, mode } }));
            }
            pane = pane.child(title("Move to", 11., 550., MUTED));
        }
        for target in Edge::ALL {
            if target != edge && id.accepts(target) {
                pane = pane.child(button(
                    format!("move-to-{}", target.key()),
                    format!("{} dock", target.key()),
                    false,
                    move |s| {
                        s.send(RoomCommand::Workspace {
                            command: WorkspaceCommand::Move {
                                panel: id,
                                edge: target,
                            },
                        });
                        s.panel_menu = None;
                        s.moving_panel = None;
                    },
                ));
            }
        }
    } else {
        for id in candidates {
            let state = &ws.panels[&id];
            let subtitle = if state.visible {
                format!("Move from {} dock", state.edge.key())
            } else {
                "Not in studio".into()
            };
            pane = pane.child(
                col()
                    .key(format!("add-{}-{}", edge.key(), id.key()))
                    .role("button")
                    .label(id.label())
                    .padding(5.)
                    .fill(color(SURFACE))
                    .radius(4.)
                    .child(title(id.label(), 13., 600., TEXT))
                    .child(title(subtitle, 10., 500., MUTED))
                    .on_press(move |s: &mut Studio| {
                        s.send(RoomCommand::Workspace {
                            command: WorkspaceCommand::Move { panel: id, edge },
                        });
                        s.panel_menu = None;
                        if id == PanelId::Assistant { toggle_docks(s); }
                    }),
            );
        }
    }
    Some(pane.scroll(Default::default()))
}

pub(super) fn layout_key(s: &mut Studio, event: &rune::KeyEvent, _: &mut rune::Tx) -> bool {
    if s.studio_settings.is_some() {
        if matches!(event.key, rune::Key::Escape) {
            s.studio_settings = None;
            return true;
        }
        return false;
    }
    if s.settings.profile_open && s.page != Page::Studio && matches!(event.key, rune::Key::Escape) {
        s.settings.profile_open = false;
        return true;
    }
    if s.source.is_some() && matches!(event.key, rune::Key::Escape) {
        s.source = None;
        return true;
    }
    if s.slot_picker.is_some() && matches!(event.key, rune::Key::Escape) { s.slot_picker=None; return true; }
    if s.show_chat && matches!(event.key, rune::Key::Escape) {
        super::chat::close_popout(s);
        return true;
    }
    if s.editor.is_some() {
        if matches!(event.key, rune::Key::Escape) {
            super::editor::escape(s);
            return true;
        }
        return false;
    }
    if s.page != Page::Studio || s.live.is_none() {
        return false;
    }
    if event.mods.cmd
        && !event.mods.alt
        && !event.mods.shift
        && matches!(event.key, rune::Key::Command('e'))
    {
        toggle_docks(s);
        return true;
    }
    if s.editing_docks && matches!(event.key, rune::Key::Escape) {
        if s.drag_tile.take().is_some() {
            s.drop_edge = None;
            return true;
        }
        if s.panel_menu.take().is_some() || s.studio_panels {
            s.moving_panel = None;
            s.studio_panels = false;
            return true;
        }
        toggle_docks(s);
        return true;
    }
    false
}
