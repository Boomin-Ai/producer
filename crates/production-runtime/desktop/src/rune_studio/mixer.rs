use super::*;
use crate::model::Lane;

const RAIL: u32 = 0x263744;
const ZONES: [(f32, f32, u32); 3] = [
    (0., 0.7, 0x34d6a5),
    (0.7, 0.9, 0xedc25b),
    (0.9, 1., 0xff6269),
];
const GAIN_STEP: f32 = 0.02;

pub(super) fn channels(s: &Studio, compact: bool) -> El {
    let snapshot = &s.live.as_ref().unwrap().snapshot;
    let mut channels = row().key("mixer-channels").w_full().min_w(0.).gap(8.);
    let mut count = 0;
    for lane in &snapshot.project.lanes {
        if lane.kind == "audio" || matches!(lane.source.as_str(), "movie" | "take") {
            channels = channels.child(channel(snapshot, lane, compact));
            count += 1;
        }
    }
    if count == 0 {
        return channels.child(title("No audio sources", 11., 500., MUTED));
    }
    if !compact && count == 1 {
        channels = channels.justify_center();
    }
    channels.scroll_x()
}

fn channel(snapshot: &Snapshot, lane: &Lane, compact: bool) -> El {
    let peak = snapshot.mixer_peaks.get(&lane.source).copied().unwrap_or(0.);
    let level = meter_level(peak * lane.gain, lane.muted);
    let db = gain_readout(lane.gain);
    let mute = panels::send_tool(
        &format!("mute-{}", lane.source),
        if lane.muted { "mic-off" } else { "mic" },
        &format!("{} {}", if lane.muted { "Unmute" } else { "Mute" }, lane.label),
        lane.muted,
        RoomCommand::Gain {
            source: lane.source.clone(),
            gain: lane.gain,
            muted: !lane.muted,
        },
    ).size(26., 26.);
    let name = title(&lane.label, 11., 550., TEXT).help(&lane.label);
    let readout = title(&db, 10., 450., MUTED);
    let fader = fader(lane, level, &db, compact, "");
    if compact {
        row().items_center().gap(6.)
            .child(mute)
            .child(name.max_w(110.))
            .child(fader)
            .child(readout.w(46.))
    } else {
        col().w(102.).items_center().gap(4.)
            .child(name.max_w(98.))
            .child(readout)
            .child(fader)
            .child(mute)
    }
}

pub(super) fn shortcut_mic_gain(snapshot: &Snapshot) -> Option<El> {
    let lane = snapshot.project.lanes.iter().find(|lane| lane.source == "microphone")?;
    let peak = snapshot.mixer_peaks.get(&lane.source).copied().unwrap_or(0.);
    let level = meter_level(peak * lane.gain, lane.muted);
    let db = gain_readout(lane.gain);
    Some(row().items_center().gap(4.).flex_wrap()
        .child(title("Mic gain", 11., 500., MUTED))
        .child(fader(lane, level, &db, true, "quick-"))
        .child(title(db, 11., 500., MUTED)))
}

fn gain_readout(gain: f32) -> String {
    if gain == 0. { "−∞ dB".into() } else { format!("{:+.1} dB", 20. * gain.log10()) }
}

pub(super) fn meter_level(amplitude: f32, muted: bool) -> f32 {
    if muted || !amplitude.is_finite() || amplitude <= 0. {
        return 0.;
    }
    ((20. * amplitude.log10() + 60.) / 60.).clamp(0., 1.)
}

fn fader(lane: &Lane, level: f32, db: &str, compact: bool, prefix: &str) -> El {
    let span = if compact { 84. } else { 80. };
    let knob = lane.gain / 2. * span;
    let mut rail = el().size(if compact { span } else { 8. }, if compact { 8. } else { span })
        .clip_rounded(4.).radius(4.).fill(color(RAIL));
    for (start, end, tint) in ZONES {
        let length = (level.min(end) - start).max(0.) * span;
        if length > 0. {
            let segment = if compact {
                el().absolute(start * span, 0.).size(length, 8.)
            } else {
                el().absolute(0., span * (1. - start) - length).size(8., length)
            };
            rail = rail.child(segment.fill(color(tint)));
        }
    }
    let handle = if compact {
        el().absolute(knob, 5.).size(12., 16.)
    } else {
        el().absolute(3., span - knob).size(20., 12.)
    };
    let source = lane.source.clone();
    let step_source = source.clone();
    let limit_source = source.clone();
    let accessible_source = source.clone();
    el().key(format!("{prefix}gain-{source}"))
        .size(if compact { span + 12. } else { 26. }, if compact { 26. } else { span + 12. })
        .role("slider")
        .label(format!("{} gain", lane.label))
        .help(format!("{} · {}{}", lane.label, db, if lane.muted { " · Muted" } else { "" }))
        .range_value(lane.gain.into(), 0., 2.)
        .range_step(GAIN_STEP.into())
        .cursor(if compact { rune::Cursor::ResizeEw } else { rune::Cursor::ResizeNs })
        .child(if compact { rail.absolute(6., 9.) } else { rail.absolute(9., 6.) })
        .child(handle.radius(3.).fill(color(if lane.muted { MUTED } else { TEXT })))
        .on_drag(move |s: &mut Studio, drag, _| {
            if drag.cancelled() {
                return;
            }
            let position = if compact { drag.x - 6. } else { span + 6. - drag.y };
            let gain = (position / span * 2.).clamp(0., 2.);
            // Quantize pointer updates so the durable gain queue stays responsive while scrubbing.
            let gain = if drag.phase == rune::Phase::Up { gain } else { (gain / GAIN_STEP).round() * GAIN_STEP };
            if drag.phase == rune::Phase::Down || drag.phase == rune::Phase::Up
                || s.mixer_scrub.is_none_or(|(last, at)| last != gain && at.elapsed() >= Duration::from_millis(40))
            {
                s.mixer_scrub = Some((gain, Instant::now()));
                set_gain(s, &source, |_| gain);
            }
        })
        .on_step(move |s, delta, _| set_gain(s, &step_source, |gain| gain + delta as f32 * GAIN_STEP))
        .on_step_limit(move |s, max, _| set_gain(s, &limit_source, |_| if max { 2. } else { 0. }))
        .on_set_value(move |s, gain, _| set_gain(s, &accessible_source, |_| gain as f32))
}

fn set_gain(s: &mut Studio, source: &str, next: impl FnOnce(f32) -> f32) {
    let Some(lane) = s.live.as_ref().and_then(|l| l.snapshot.project.lanes.iter().find(|l| l.source == source)) else {
        return;
    };
    s.send(RoomCommand::Gain {
        source: source.to_owned(),
        gain: next(lane.gain).clamp(0., 2.),
        muted: lane.muted,
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn meter_preserves_the_production_scale_and_mute() {
        use super::meter_level;
        assert_eq!(meter_level(0., false), 0.);
        assert_eq!(meter_level(0.001, false), 0.);
        assert!((meter_level(0.1, false) - 2. / 3.).abs() < 0.0001);
        assert_eq!(meter_level(2., false), 1.);
        assert_eq!(meter_level(1., true), 0.);
    }
}
