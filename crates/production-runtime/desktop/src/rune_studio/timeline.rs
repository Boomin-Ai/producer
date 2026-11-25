use super::*;

pub(super) fn send_to_output() -> RoomCommand {
    // The local operator uses the engine's permission-checked Take. Journaled
    // callers supply all three fields together for replay and revision fencing.
    RoomCommand::SendToOutput {
        operation_id: None,
        expected_program_revision: None,
        permission_epoch: None,
    }
}

pub(super) fn panel(s: &Studio, width: f32) -> El {
    let snap = &s.live.as_ref().unwrap().snapshot;
    let mut panel = col().key("sequence").w_full().min_w(0.).padding(6.).gap(3.);
    let Some(seq) = snap.project.production.sequences.get("main") else {
        return panel;
    };
    let duration = seq.duration.as_f64();
    if duration <= 0. {
        return panel;
    }
    let label_width = (width * 0.2).clamp(56., 144.);
    let track_width = (width - label_width - 24.).max(1.);
    panel = panel.child(
        row()
            .items_center()
            .gap(6.)
            .child(command(
                "rewind",
                "|◀",
                false,
                RoomCommand::Seek { seconds: 0. },
            ))
            .child(super::panels::send_tool(
                "timeline-play",
                if snap.playing { "pause" } else { "play" },
                if snap.playing { "Pause" } else { "Play" },
                snap.playing,
                if snap.playing {
                    RoomCommand::Pause
                } else {
                    RoomCommand::Play
                },
            ))
            .child(title(
                format!("{:05.2} / {:.0}s", snap.position, duration),
                11.,
                500.,
                TEXT,
            ))
            .child(el().grow(1.))
            .child(command(
                "send-timeline-output",
                "Send to output",
                false,
                send_to_output(),
            )),
    );
    let mut ruler = el()
        .key("timeline-ruler")
        .role("slider")
        .label("Seek timeline")
        .w(track_width)
        .h(20.)
        .on_press_tx(move |s: &mut Studio, tx| {
            if let Some(point) = tx.press_point() {
                s.send(RoomCommand::Seek {
                    seconds: (point.x / track_width).clamp(0., 1.) as f64 * duration,
                });
            }
        })
        .on_drag(move |s: &mut Studio, d, _| {
            if !d.cancelled() && d.w > 0. {
                s.send(RoomCommand::Seek {
                    seconds: (d.x / d.w).clamp(0., 1.) as f64 * duration,
                });
            }
        });
    let steps = (track_width / 80.).clamp(1., 6.) as usize;
    for i in 0..=steps {
        let frac = i as f32 / steps as f32;
        ruler = ruler.child(
            title(format!("{:.0}s", frac as f64 * duration), 10., 450., MUTED)
                .absolute((track_width * frac).min((track_width - 24.).max(0.)), 3.),
        );
    }
    panel = panel.child(row().gap(4.).child(el().w(label_width)).child(ruler));
    for lane in &snap.project.lanes {
        let tint = match lane.kind.as_str() {
            "audio" => 0x265349,
            "graphics" => 0x4d4166,
            _ => 0x29475c,
        };
        let mut track = el()
            .w(track_width)
            .h(28.)
            .radius(4.)
            .fill(color(0x101e2b))
            .clip_rounded(4.);
        if lane.kind == "graphics" {
            track = track.child(title("Title · Camera motion", 11., 500., TEXT).absolute(6., 6.));
        }
        for p in seq.placements.iter().filter(|p| p.source == lane.source) {
            let id = p.id.clone();
            let selected = snap.selected_clip.as_ref() == Some(&id);
            let start = p.range.start.as_f64();
            let length = p.range.duration.as_f64();
            let source_in = p.source_in.as_f64();
            let (left, shown) = match &s.pending_trim {
                Some(RoomCommand::Trim {
                    clip,
                    start,
                    duration,
                    ..
                }) if clip == &id => (*start, *duration),
                _ => (start, length),
            };
            let mut clip = row()
                .key(format!("clip-{id}"))
                .items_center()
                .h(26.)
                .gap(2.)
                .w((shown / duration * track_width as f64).max(12.) as f32)
                .absolute((left / duration * track_width as f64) as f32, 1.)
                .fill(color(tint))
                .radius(3.)
                .border(1., color(if selected { MINT } else { 0x446077 }));
            for right in [false, true] {
                let id = p.id.clone();
                clip = clip.child(
                    el().key(format!("trim-{id}-{right}"))
                        .w(6.)
                        .h_full()
                        .fill(color(0x708491))
                        .role("slider")
                        .label(if right { "Trim end" } else { "Trim start" })
                        .on_drag(move |s: &mut Studio, d, _| {
                            if d.cancelled() {
                                s.pending_trim = None;
                                return;
                            }
                            let delta = d.dx as f64 / track_width as f64 * duration;
                            let (next, len, src) = if right {
                                (
                                    start,
                                    (length + delta)
                                        .clamp(0.05_f64.min(duration - start), duration - start),
                                    source_in,
                                )
                            } else {
                                let change =
                                    delta.clamp((-start).max(-source_in), (length - 0.05).max(0.));
                                (start + change, length - change, source_in + change)
                            };
                            let cmd = RoomCommand::Trim {
                                clip: id.clone(),
                                start: next,
                                duration: len,
                                source_in: src,
                            };
                            if matches!(d.phase, rune::Phase::Up) {
                                s.pending_trim = None;
                                s.send(cmd);
                            } else {
                                s.pending_trim = Some(cmd);
                            }
                        }),
                );
                if !right {
                    let id = p.id.clone();
                    clip = clip.child(
                        el().h_full()
                            .min_w(0.)
                            .grow(1.)
                            .role("button")
                            .label(lane.label.clone())
                            .child(title(lane.label.clone(), 10., 500., TEXT))
                            .on_press(move |s: &mut Studio| {
                                s.send(RoomCommand::Select {
                                    clip: Some(id.clone()),
                                })
                            }),
                    );
                }
            }
            track = track.child(clip);
        }
        track = track.child(
            el().size(1., 28.)
                .absolute(
                    (snap.position / duration).clamp(0., 1.) as f32 * (track_width - 1.),
                    0.,
                )
                .fill(color(MINT)),
        );
        panel = panel.child(
            row()
                .gap(4.)
                .items_center()
                .child(title(lane.label.clone(), 11., 500., MUTED).w(label_width))
                .child(track),
        );
    }
    panel.scroll(Default::default())
}
