//! Render a set through the same native preparation and output path as the room.
use crate::{engine, model, platform, root, visuals};
use anyhow::{ensure, Context, Result};
use std::{
    path::Path,
    time::Instant,
};

pub fn run(args: &[String], rehearsal: bool, outputs: bool) -> Result<()> {
    let out = Path::new(args.first().context("Expected output directory")?);
    let room: model::RoomProject =
        serde_json::from_slice(&std::fs::read(root().join("room.json"))?)?;
    let mut project = room.live_set()?;
    let mut cache = visuals::VisualCache::new(&root());
    let native = platform::NativeRoom::new()?;
    native.prepare([project.canvas.landscape, project.canvas.vertical])?;
    if rehearsal {
        let candidate = args.get(1).context("Expected candidate set JSON")?;
        let draft = serde_json::from_slice(&std::fs::read(candidate)?)?;
        if let Some(baseline) = args.get(2) {
            let baseline = serde_json::from_slice(&std::fs::read(baseline)?)?;
            project = engine::set_edit_project(&project, &project.scene, &baseline)?;
        }
        capture(
            &native,
            &mut cache,
            &project,
            &out.join(if outputs { "orbital" } else { "pressure" }),
            2.,
            1,
        )?;
        let next = engine::set_edit_project(&project, &project.scene, &draft)?;
        capture(
            &native,
            &mut cache,
            &next,
            &out.join(if outputs { "jetstream" } else { "aurora" }),
            2.,
            2,
        )?;
        capture(
            &native,
            &mut cache,
            &next,
            &out.join(if outputs {
                "jetstream-motion"
            } else {
                "aurora-motion"
            }),
            4.,
            3,
        )?;
        if outputs {
            for (i, choice) in project
                .set_layout_choices(&project.scene)
                .into_iter()
                .enumerate()
            {
                let mut alternate = project.clone();
                alternate.mount_set(Some(project.scene.clone()), Some(choice.pair))?;
                capture(
                    &native,
                    &mut cache,
                    &alternate,
                    &out.join(choice.label.to_lowercase()),
                    2.,
                    4 + i as u64,
                )?;
            }
        }
        return Ok(());
    }
    if let Some(label) = args.get(1) {
        let pair = project
            .set_layout_choices(&project.scene)
            .into_iter()
            .find(|c| c.label == *label)
            .context("Unknown layout")?
            .pair;
        project.mount_set(Some(project.scene.clone()), Some(pair))?;
    }
    let time = args
        .get(2)
        .map(|s| s.parse::<f64>())
        .transpose()?
        .unwrap_or(2.);
    capture(&native, &mut cache, &project, out, time, 1)
}

// One private GPU context per process, recreated on room or canvas change.
// Its writable targets are never shared with the live render queue.
struct ReviewRenderer {
    room: std::path::PathBuf,
    sizes: [producer_native_media::boundary::OutputSize; 2],
    native: platform::NativeRoom,
    cache: visuals::VisualCache,
    generation: u64,
    posters: std::collections::VecDeque<ReviewPair>,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) struct PosterSample {
    pub seconds: f64,
    pub connected: bool,
    pub max_dimension: u32,
}

struct ReviewPair {
    sample: PosterSample,
    resources: std::sync::Weak<visuals::Visuals>,
    samples: Vec<Option<producer_production_core::compile::Sample>>,
    wave: bool,
    images: [Vec<u8>; 2],
}

impl ReviewRenderer {
    fn render(
        &mut self,
        live: &model::RoomProject,
        plan: &producer_production_core::compile::Plan,
        samples: &[Option<producer_production_core::compile::Sample>],
        wave: bool,
        dir: &Path,
        sample: PosterSample,
    ) -> Result<serde_json::Value> {
        let start = Instant::now();
        let prepared = self.cache.prepare(live, plan)?;
        let prepare_ms = start.elapsed().as_secs_f64() * 1000.;
        let files = ["landscape.png", "portrait.png"].map(|name| dir.join(name));
        self.posters.retain(|p| p.resources.strong_count() > 0);
        if let Some(hit) = self.posters.iter().find(|p| {
            p.sample == sample
                && p.wave == wave
                && p.samples == samples
                && p.resources.ptr_eq(&std::sync::Arc::downgrade(&prepared))
        }) {
            std::fs::create_dir_all(dir)?;
            for (path, bytes) in files.iter().zip(&hit.images) {
                std::fs::write(path, bytes)?;
            }
            return Ok(serde_json::json!({"reused":true,"prepareMs":prepare_ms,"captureMs":0.}));
        }
        self.generation += 1;
        let capture = Instant::now();
        capture_prepared(
            &self.native,
            live,
            plan,
            &prepared,
            dir,
            sample.seconds,
            self.generation,
            sample.connected,
            wave,
            sample.max_dimension,
        )?;
        let capture_ms = capture.elapsed().as_secs_f64() * 1000.;
        let images = [std::fs::read(&files[0])?, std::fs::read(&files[1])?];
        if images.iter().map(Vec::len).sum::<usize>() <= 4 * 1024 * 1024 {
            self.posters.push_front(ReviewPair {
                resources: std::sync::Arc::downgrade(&prepared),
                samples: samples.to_vec(),
                wave,
                images,
                sample,
            });
            self.posters.truncate(3);
        }
        Ok(serde_json::json!({"reused":false,"prepareMs":prepare_ms,"captureMs":capture_ms}))
    }
}

fn with_review_renderer<T>(
    room: &Path,
    sizes: [producer_native_media::boundary::OutputSize; 2],
    f: impl FnOnce(&mut ReviewRenderer) -> Result<T>,
) -> Result<T> {
    use std::sync::{Mutex, OnceLock};
    static WORKER: OnceLock<Mutex<Option<ReviewRenderer>>> = OnceLock::new();
    let mut worker = WORKER
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("Private renderer stopped"))?;
    if worker
        .as_ref()
        .is_none_or(|r| r.room != room || r.sizes != sizes)
    {
        let native = platform::NativeRoom::new()?;
        native.prepare(sizes)?;
        let cache = visuals::VisualCache::for_inspection(&room);
        *worker = Some(ReviewRenderer {
            room: room.to_path_buf(),
            sizes,
            native,
            cache,
            generation: 0,
            posters: Default::default(),
        });
    }
    let renderer = worker.as_mut().context("Private renderer unavailable")?;
    f(renderer)
}

pub(crate) fn inspect_pair(
    room: &Path,
    live: &model::RoomProject,
    dest: &Path,
    seconds: f64,
    connected: bool,
    max_dimension: u32,
    profile_gpu: bool,
) -> Result<(u64, Option<serde_json::Value>)> {
    let sizes = [live.canvas.landscape, live.canvas.vertical];
    with_review_renderer(room, sizes, |r| {
        let plan = live.compile()?;
        let prepared = r.cache.prepare(live, &plan)?;
        r.generation += 1;
        let wave = engine::camera_border_wave(room)?;
        if profile_gpu { r.native.set_rehearsal_timing(true); }
        let captured = capture_prepared(
            &r.native,
            live,
            &plan,
            &prepared,
            dest,
            seconds,
            r.generation,
            connected,
            wave,
            max_dimension,
        );
        if profile_gpu { r.native.set_rehearsal_timing(false); }
        captured?;
        let profile = if profile_gpu {
            let mut report = serde_json::Map::new();
            for (output, view) in ["landscape", "portrait"].iter().enumerate() {
                let mut measured = r.native.rehearsal_timing(output as u32, r.generation)?;
                if let Some(rows) = measured["renderEncoders"].as_array_mut() {
                    for row in rows {
                        let name = row["preparedSlot"].as_u64()
                            .and_then(|i| prepared.pass_labels.get(i as usize))
                            .map_or("scene composite", String::as_str);
                        row["pass"] = serde_json::json!(name);
                    }
                }
                report.insert((*view).to_owned(), measured);
            }
            Some(serde_json::Value::Object(report))
        } else { None };
        Ok((r.native.device_registry_id(), profile))
    })
}

/// Private rehearsal uses generated calibration pictures in the normal video slots.
pub(crate) fn authored_pairs_in(
    room: &Path,
    project: &model::RoomProject,
    id: &str,
    out: &Path,
    max_dimension: u32,
    check: impl FnMut(&str) -> Result<()>,
) -> Result<Vec<(String, std::path::PathBuf)>> {
    let choices = project.set_layout_choices(id);
    let sample = PosterSample { seconds: 2., connected: true, max_dimension };
    let (rendered, receipt) = inspect_layout_pairs(room, project, id, out, &choices, sample, check)?;
    std::fs::write(out.join("rehearsal.json"), serde_json::to_vec_pretty(&receipt)?)?;
    Ok(rendered)
}

pub(crate) fn inspect_layout_pairs(
    room: &Path,
    project: &model::RoomProject,
    id: &str,
    out: &Path,
    choices: &[model::SetLayoutChoice],
    sample: PosterSample,
    mut check: impl FnMut(&str) -> Result<()>,
) -> Result<(Vec<(String, std::path::PathBuf)>, serde_json::Value)> {
    let sizes = [project.canvas.landscape, project.canvas.vertical];
    with_review_renderer(room, sizes, |renderer| {
        let first = choices.first().context("No layout pairs to rehearse")?;
        check(&first.label)?;
        let mut mounted = project.clone();
        mounted.mount_set(Some(id.into()), Some(first.pair.clone()))?;
        let mut live = mounted.live_set()?;
        // A set compiles once into a plan containing all its layouts. Changing the output
        // pair selects different nodes from that plan; its timeline and bindings stay fixed.
        let started = Instant::now();
        let plan = live.compile()?;
        let sequence = &plan.sequences["main"];
        let mut samples = vec![None; sequence.tracks.len()];
        sequence.evaluate_into(model::time(sample.seconds)?, &mut samples)
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let compile_ms = started.elapsed().as_secs_f64() * 1000.;
        let wave = engine::camera_border_wave(room)?;
        let mut rendered = Vec::new();
        let mut receipts = Vec::new();
        for (index, choice) in choices.iter().enumerate() {
            if index != 0 { check(&choice.label)?; }
            let start = Instant::now();
            let dir = out.join(&choice.pair.landscape);
            live.mounted_layout = Some(choice.pair.clone());
            let mut pair_receipt = renderer
                .render(&live, &plan, &samples, wave, &dir, sample)
                .with_context(|| format!("{} output rehearsal", choice.label))?;
            pair_receipt["pair"] = serde_json::json!(&choice.pair);
            pair_receipt["prepareAndRenderMs"] =
                serde_json::json!(start.elapsed().as_secs_f64() * 1000.);
            receipts.push(pair_receipt);
            rendered.push((choice.label.clone(), dir));
        }
        use sha2::{Digest, Sha256};
        let receipt = serde_json::json!({"set":id,"compiledSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&project.production.sets[id])?)),
        "backend":"Metal","deviceRegistryId":renderer.native.device_registry_id(),"canvas":sizes,"maxPosterDimension":sample.max_dimension,
        "sourceSha256":project.authored_designs.get(id).map(|s| s.verified_revision(id,&project.production.sets[id])).transpose()?,
        "assetCatalogSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&project.production.assets)?)),
        "seconds":sample.seconds,"inputs":if sample.connected { "synthetic host and guest" } else { "disconnected" },"compileAndSampleMs":compile_ms,"pairs":receipts});
        Ok((rendered, receipt))
    })
}

pub(crate) fn authored_pairs(
    project: &model::RoomProject,
    id: &str,
    out: &Path,
    check: impl FnMut(&str) -> Result<()>,
) -> Result<Vec<(String, std::path::PathBuf)>> {
    authored_pairs_in(&root(), project, id, out, 0, check)
}

// Distinct BGRA charts expose swapped roles, stretching, cropping and UV displacement.
// Motion derives solely from the requested time. The private renderer never opens a device.
fn test_picture(guest: bool, time: f64) -> Result<std::sync::Arc<platform::Frame>> {
    // The standard rehearsal always samples at two seconds. Retain its two immutable
    // surfaces in the private process; arbitrary cue times still get their own pixels.
    static FIXED: [std::sync::OnceLock<std::sync::Arc<platform::Frame>>; 2] =
        [const { std::sync::OnceLock::new() }; 2];
    let fixed = &FIXED[usize::from(guest)];
    if time == 2. {
        if let Some(frame) = fixed.get() {
            return Ok(frame.clone());
        }
    }
    let (w, h) = (320usize, 180usize);
    let mut bgra = Vec::with_capacity(w * h * 4);
    let phase = (time * 48.).rem_euclid(w as f64) as usize;
    for y in 0..h {
        for x in 0..w {
            let dx = x as i32 - 160;
            let dy = y as i32 - 90;
            let radius = dx * dx + dy * dy;
            let grid = x % 24 <= 1 || y % 24 <= 1;
            let bar = (x + w - phase) % w < 4;
            let mut color = if guest {
                [56, 99, 168, 255]
            } else {
                [145, 88, 32, 255]
            };
            if (44 * 44..=46 * 46).contains(&radius) || bar {
                color = [245, 245, 245, 255];
            } else if grid {
                color = [58, 58, 58, 255];
            }
            bgra.extend_from_slice(&color);
        }
    }
    let frame = std::sync::Arc::new(platform::Frame::guest(&bgra, w, h)
        .context("Unable to allocate private review input")?);
    if time == 2. {
        return Ok(fixed.get_or_init(|| frame).clone());
    }
    Ok(frame)
}

fn capture(
    native: &platform::NativeRoom,
    cache: &mut visuals::VisualCache,
    project: &model::RoomProject,
    out: &Path,
    time: f64,
    generation: u64,
) -> Result<()> {
    let plan = project.compile()?;
    let visuals = cache.prepare(project, &plan)?;
    capture_prepared(
        native,
        project,
        &plan,
        &visuals,
        out,
        time,
        generation,
        false,
        engine::camera_border_wave(&root())?,
        0,
    )
}

pub(crate) fn capture_prepared(
    native: &platform::NativeRoom,
    project: &model::RoomProject,
    plan: &producer_production_core::compile::Plan,
    visuals: &visuals::Visuals,
    out: &Path,
    time: f64,
    generation: u64,
    fixtures: bool,
    wave: bool,
    max_dimension: u32,
) -> Result<()> {
    let sample = FrameSample {
        live: time,
        timeline: time,
        set_motion: time,
        progress: None,
        fixture_time: time,
        host: fixtures,
        guest: fixtures,
        pictures: None,
    };
    capture_sample(
        native,
        project,
        plan,
        visuals,
        out,
        generation,
        wave,
        max_dimension,
        sample,
    )
}

pub(crate) struct FrameSample<'a> {
    pub live: f64,
    pub timeline: f64,
    pub set_motion: f64,
    pub progress: Option<f32>,
    pub fixture_time: f64,
    pub host: bool,
    pub guest: bool,
    pub pictures: Option<&'a [std::sync::Arc<platform::Frame>; 2]>,
}

pub(crate) fn capture_sample(
    native: &platform::NativeRoom,
    project: &model::RoomProject,
    plan: &producer_production_core::compile::Plan,
    visuals: &visuals::Visuals,
    out: &Path,
    generation: u64,
    wave: bool,
    max_dimension: u32,
    sample: FrameSample<'_>,
) -> Result<()> {
    let mut frames = std::array::from_fn(|_| None);
    let picture = |guest| match sample.pictures {
        Some(pictures) => Ok(pictures[usize::from(guest)].clone()),
        None => test_picture(guest, sample.fixture_time),
    };
    if sample.host {
        frames[0] = Some(picture(false)?);
    }
    if let Some(slot) = project.rtc_video_slot().filter(|_| sample.guest) {
        frames[slot] = Some(picture(true)?);
    }
    let active = std::array::from_fn(|slot| frames[slot].is_some());
    let seq = &plan.sequences["main"];
    let mut samples = vec![None; seq.tracks.len()];
    seq.evaluate_into(model::time(sample.timeline)?, &mut samples)
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    std::fs::create_dir_all(out)?;
    for (i, (_, size)) in project.output_layouts().into_iter().enumerate() {
        let mut draws = Vec::new();
        visuals.draw_transition(
            plan,
            &samples,
            i,
            size,
            &frames,
            active,
            sample.live,
            sample.timeline,
            sample.set_motion,
            wave,
            &mut draws,
            None,
            sample.progress,
            crate::speaker_split::CENTER,
            [100; 3],
        );
        let completions = native.shared.poster_frames.get_or_init(Default::default);
        let submitted = platform::host_time();
        ensure!(
            native.target.render(
                i,
                size.width,
                size.height,
                &draws,
                &frames,
                &visuals.text,
                submitted,
                generation,
            ),
            "Render refused"
        );
        let frame = completions.wait(i, generation, submitted)?;
        unsafe extern "C" {
            fn nr_write_poster(
                pixel: *mut std::ffi::c_void,
                path: *const std::ffi::c_char,
                max_dimension: u32,
            ) -> bool;
        }
        let path = out.join(["landscape.png", "portrait.png"][i]);
        let cpath = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
        ensure!(
            unsafe { nr_write_poster(frame.ptr.as_ptr(), cpath.as_ptr(), max_dimension) },
            "PNG export failed"
        );
    }
    Ok(())
}

/// Deterministic two-document rehearsal through the normal room renderer.
pub fn filmstrip(args: &[String]) -> Result<()> {
    use sha2::{Digest, Sha256};
    ensure!(
        args.len() == 4,
        "Expected destination, baseline set, edited set, and duration in seconds"
    );
    let out = Path::new(&args[0]);
    let seconds: u64 = args[3].parse()?;
    ensure!((1..=30).contains(&seconds), "Expected 1..30 seconds");
    let room: model::RoomProject =
        serde_json::from_slice(&std::fs::read(root().join("room.json"))?)?;
    let mut project = room.live_set()?;
    let renderer = platform::NativeRoom::new()?;
    renderer.prepare([project.canvas.landscape, project.canvas.vertical])?;
    let mut cache = visuals::VisualCache::new(&root());
    let mut revision = 0;
    let mut documents = Vec::new();
    for (index, file) in args[1..=2].iter().enumerate() {
        let bytes = std::fs::read(file)?;
        let draft = serde_json::from_slice(&bytes)?;
        project = engine::set_edit_project(&project, &project.scene, &draft)?;
        let plan = project.compile()?;
        let visuals = cache.prepare(&project, &plan)?;
        let dir = out.join(["original", "edited"][index]);
        for n in 0..seconds * 15 {
            revision += 1;
            capture_prepared(
                &renderer,
                &project,
                &plan,
                &visuals,
                &dir.join(format!("{n:04}")),
                n as f64 / 15.,
                revision,
                false,
                engine::camera_border_wave(&root())?,
                0,
            )?;
        }
        documents.push(format!("{:x}", Sha256::digest(bytes)));
    }
    let executable = std::env::current_exe()?;
    let report = serde_json::json!({"pid":std::process::id(),"executableSha256":format!("{:x}",Sha256::digest(std::fs::read(executable)?)),
        "documentSha256":documents,"pairedFramesPerDocument":seconds*15,"fps":15,"source":"native Metal program output","inputs":"offline"});
    std::fs::write(
        out.join("verification.json"),
        serde_json::to_string_pretty(&report)?,
    )?;
    Ok(())
}
