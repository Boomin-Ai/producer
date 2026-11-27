//! Headless replay through the program's set clock, reversible layout handoff and Metal output.
use super::{ReversibleLayout, SetMotionClock};
use crate::{
    model::RoomProject, platform::{Frame, NativeRoom}, posters, root, set_slots, visuals::VisualCache,
};
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::{fs, path::{Path, PathBuf}, sync::Arc};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Sequence {
    set: String,
    start: String,
    cues: Vec<Cue>,
    sample_pictures: Option<[PathBuf; 2]>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Cue {
    at: f64,
    layout: Option<String>,
    playing: Option<bool>,
    host: bool,
    guest: bool,
}

fn sample_picture(path: &Path) -> Result<Arc<Frame>> {
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    reader.limits(limits);
    let mut picture = reader.decode()?.thumbnail(640, 360).to_rgba8();
    let (width, height) = picture.dimensions();
    for pixel in picture.pixels_mut() {
        pixel.0.swap(0, 2);
        pixel.0[3] = 255;
    }
    Frame::guest(picture.as_raw(), width as usize, height as usize)
        .map(Arc::new)
        .context("Unable to prepare rehearsal picture")
}

fn mounted(studio: &RoomProject, set: &str, choice: &str) -> Result<RoomProject> {
    let pair = studio
        .set_layout_choices(set)
        .into_iter()
        .find(|c| c.label.eq_ignore_ascii_case(choice) || c.pair.landscape == choice)
        .context("Unknown rehearsal layout")?
        .pair;
    let mut copy = studio.clone();
    copy.mount_set(Some(set.to_owned()), Some(pair))?;
    copy.live_set()
}

pub(crate) fn run(args: &[String]) -> Result<()> {
    ensure!(
        args.len() == 2 || (args.len() == 4 && args[2] == "--candidate"),
        "Expected cue sheet, new frames directory and optional --candidate design JSON"
    );
    let seq: Sequence = serde_json::from_slice(&fs::read(&args[0])?)?;
    let out = Path::new(&args[1]);
    ensure!((1..=120).contains(&seq.cues.len()), "Expected 1..120 cues");
    let pictures = seq.sample_pictures.as_ref()
        .map(|paths| -> Result<_> { Ok([sample_picture(&paths[0])?, sample_picture(&paths[1])?]) })
        .transpose()?;
    let mut studio: RoomProject = serde_json::from_slice(&fs::read(root().join("room.json"))?)?;
    if let Some(path) = args.get(3) {
        let design = serde_json::from_slice(&fs::read(path)?)?;
        let candidate = crate::authored_set::prepare(&studio, design)?;
        ensure!(candidate.id() == seq.set, "Cue sheet and candidate must select the same set");
        candidate.install(&mut studio)?;
        crate::render_graph::inspect(&studio.production.sets[&seq.set])?;
    }
    let mut project = mounted(&studio, &seq.set, &seq.start)?;
    let mut plan = project.compile()?;
    let mut cache = VisualCache::new(&root());
    let mut visuals = cache.prepare(&project, &plan)?;
    let renderer = NativeRoom::new()?;
    renderer.prepare([project.canvas.landscape, project.canvas.vertical])?;
    fs::create_dir(out).context("Choose a fresh destination for rehearsal frames")?;
    let mut transition: Option<ReversibleLayout> = None;
    let mut set_clock = SetMotionClock::Timeline;
    let mut last_sample = 0.;
    let mut last_time = 0.;
    let mut trace = Vec::new();
    for (i, cue) in seq.cues.into_iter().enumerate() {
        ensure!(
            (last_time..=3600.).contains(&cue.at),
            "Cue times must increase"
        );
        last_time = cue.at;
        if let Some(choice) = cue.layout {
            let next = mounted(&studio, &seq.set, &choice)?;
            let next_plan = next.compile()?;
            let next_visuals = cache.prepare(&next, &next_plan)?;
            if next.output_layout_pair() != project.output_layout_pair() {
                transition = ReversibleLayout::between(
                    &project,
                    &next,
                    &visuals,
                    &next_visuals,
                    transition.as_ref(),
                    cue.at,
                );
            }
            project = next;
            plan = next_plan;
            visuals = next_visuals;
        }
        if let Some(playing) = cue.playing {
            set_clock.set_playing(playing, cue.at, last_sample, true);
        }
        last_sample = set_clock.sample(cue.at, cue.at, true).0;
        if transition.as_ref().is_some_and(|b| b.done(b.phase(cue.at))) {
            transition = None;
        }
        let progress = transition.as_ref().map(|b| b.graph_progress(cue.at));
        let frame_visuals = transition.as_ref().map_or(&visuals, |b| &b.visuals);
        let pair = project.output_layout_pair();
        let slots = set_slots::for_pair(&project, &project.production.sets[&seq.set], &pair)
            .into_iter()
            .map(|s| json!({"key":s.key, "source":s.source}))
            .collect::<Vec<_>>();
        posters::capture_sample(
            &renderer,
            &project,
            &plan,
            frame_visuals,
            &out.join(format!("{i:03}")),
            i as u64 + 1,
            false,
            0,
            posters::FrameSample {
                live: cue.at,
                timeline: cue.at,
                set_motion: last_sample,
                progress,
                fixture_time: 1.,
                host: cue.host,
                guest: cue.guest,
                pictures: pictures.as_ref(),
            },
        )?;
        trace.push(
            json!({"time":cue.at, "setMotion":last_sample, "transitionProgress":progress,
            "layout":pair, "rendered":frame_visuals.pair, "slots":slots,
            "placesGuest":frame_visuals.places_guest, "host":cue.host, "guest":cue.guest}),
        );
    }
    fs::write(out.join("trace.json"), serde_json::to_vec_pretty(&trace)?)?;
    Ok(())
}
