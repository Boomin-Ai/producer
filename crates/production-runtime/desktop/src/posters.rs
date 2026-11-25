//! Render a set through the same native preparation and output path as the room.
use crate::{engine, model, platform, root, visuals};
use anyhow::{ensure, Context, Result};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub fn run(args: &[String], rehearsal: bool, outputs: bool) -> Result<()> {
    let out = Path::new(args.first().context("Expected output directory")?);
    let room: model::RoomProject =
        serde_json::from_slice(&std::fs::read(root().join("room.json"))?)?;
    let mut project = room.live_set()?;
    let mut cache = visuals::VisualCache::default();
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
    capture_prepared(native, project, &plan, &visuals, out, time, generation)
}

fn capture_prepared(native: &platform::NativeRoom, project: &model::RoomProject,
    plan: &producer_production_core::compile::Plan, visuals: &visuals::Visuals,
    out: &Path, time: f64, generation: u64) -> Result<()> {
    let frames = std::array::from_fn(|_| None);
    let seq = &plan.sequences["main"];
    let mut samples = vec![None; seq.tracks.len()];
    seq.evaluate_into(model::time(time)?, &mut samples)
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    std::fs::create_dir_all(out)?;
    let wave = engine::camera_border_wave(&root())?;
    for (i, (_, size)) in project.output_layouts().into_iter().enumerate() {
        let mut draws = Vec::new();
        visuals.draws(
            &plan, &samples, i, size, &frames, [false; 8], time, wave, &mut draws,
        );
        ensure!(
            native.target.render(
                i,
                size.width,
                size.height,
                &draws,
                &frames,
                &visuals.text,
                platform::host_time(),
                generation
            ),
            "Render refused"
        );
        let start = Instant::now();
        loop {
            let frame = native.shared.frames[i + 3].lock().unwrap().clone();
            if let Some(frame) = frame.filter(|f| f.generation == generation) {
                unsafe extern "C" {
                    fn nr_write_poster(
                        pixel: *mut std::ffi::c_void,
                        path: *const std::ffi::c_char,
                    ) -> bool;
                }
                let path = out.join(["landscape.png", "portrait.png"][i]);
                let cpath = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
                ensure!(
                    unsafe { nr_write_poster(frame.ptr.as_ptr(), cpath.as_ptr()) },
                    "PNG export failed"
                );
                break;
            }
            ensure!(start.elapsed() < Duration::from_secs(4), "Output timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    Ok(())
}

/// Deterministic two-document rehearsal through the normal room renderer.
pub fn filmstrip(args: &[String]) -> Result<()> {
    use sha2::{Digest, Sha256};
    ensure!(args.len()==4, "Expected destination, baseline set, edited set, and duration in seconds");
    let out=Path::new(&args[0]);
    let seconds:u64=args[3].parse()?;
    ensure!((1..=30).contains(&seconds),"Expected 1..30 seconds");
    let room:model::RoomProject=serde_json::from_slice(&std::fs::read(root().join("room.json"))?)?;
    let mut project=room.live_set()?;
    let renderer=platform::NativeRoom::new()?;
    renderer.prepare([project.canvas.landscape,project.canvas.vertical])?;
    let mut cache=visuals::VisualCache::default();
    let mut revision=0;
    let mut documents=Vec::new();
    for (index,file) in args[1..=2].iter().enumerate() {
        let bytes=std::fs::read(file)?;
        let draft=serde_json::from_slice(&bytes)?;
        project=engine::set_edit_project(&project,&project.scene,&draft)?;
        let plan=project.compile()?;
        let visuals=cache.prepare(&project,&plan)?;
        let dir=out.join(["original","edited"][index]);
        for n in 0..seconds*15 {
            revision+=1;
            capture_prepared(&renderer,&project,&plan,&visuals,&dir.join(format!("{n:04}")),
                n as f64/15.,revision)?;
        }
        documents.push(format!("{:x}",Sha256::digest(bytes)));
    }
    let executable=std::env::current_exe()?;
    let report=serde_json::json!({"pid":std::process::id(),"executableSha256":format!("{:x}",Sha256::digest(std::fs::read(executable)?)),
        "documentSha256":documents,"pairedFramesPerDocument":seconds*15,"fps":15,"source":"native Metal program output","inputs":"offline"});
    std::fs::write(out.join("verification.json"),serde_json::to_string_pretty(&report)?)?;
    Ok(())
}
