//! In-process qualification through the same candidate, compilation, and private
//! review path used by the native Assistant. No model/network time is included.
use crate::{authored_set, model::RoomProject, posters, render_graph};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Instant};

fn peak_resident_bytes() -> Option<i64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    (unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0)
        .then(|| unsafe { usage.assume_init() }.ru_maxrss)
}

pub fn run(args: &[String]) -> Result<()> {
    ensure!(
        args.len() == 4,
        "Expected design, two alternating edit JSON files, and result JSON path"
    );
    let read = |name: &str| -> Result<Value> { Ok(serde_json::from_slice(&fs::read(name)?)?) };
    let mut room: RoomProject =
        serde_json::from_slice(&fs::read(crate::root().join("room.json"))?)?;
    let design = read(&args[0])?;
    let id = design["id"].as_str().context("Missing set ID")?.to_owned();
    let edits = [read(&args[1])?, read(&args[2])?];
    for edit in &edits {
        ensure!(
            edit["op"] == "editAuthoredSet" && edit["id"] == id,
            "Expected two edits to the same authored set"
        );
    }
    let scratch = tempfile::tempdir()?;
    let mut samples = Vec::new();
    let mut timings = Vec::new();
    let mut prior = Value::Null;
    let mut cold = Value::Null;
    for n in 0..=100 {
        let command = if n == 0 { &design } else { &edits[(n - 1) % 2] };
        let start = Instant::now();
        let candidate = authored_set::prepare(&room, command.clone())?;
        candidate.install(&mut room)?;
        render_graph::inspect(&room.production.sets[&id])?;
        let validated = start.elapsed();
        posters::authored_pairs_in(&crate::root(), &room, &id, scratch.path(), 384, |_| Ok(()))?;
        let ms = start.elapsed().as_secs_f64() * 1000.;
        let receipt: Value =
            serde_json::from_slice(&fs::read(scratch.path().join("rehearsal.json"))?)?;
        ensure!(
            prior != receipt["compiledSha256"],
            "Edit {n} did not change compiled set"
        );
        prior = receipt["compiledSha256"].clone();
        let sample = json!({"edit":n,"totalMs":ms,"validationMs":validated.as_secs_f64()*1000.,
            "peakResidentBytes":peak_resident_bytes(),"rehearsal":receipt});
        if n == 0 {
            cold = sample;
        } else {
            samples.push(sample);
            timings.push(ms);
        }
    }
    timings.sort_by(f64::total_cmp);
    let report = json!({"set":id,"warmSamples":100,"cold":cold,"warmMedianMs":(timings[49]+timings[50])/2.,
        "warmP95Ms":timings[94],"metric":"local edit through all operator review PNGs at 384px from full-sized Metal outputs",
        "samples":samples});
    fs::write(Path::new(&args[3]), serde_json::to_vec_pretty(&report)?)?;
    println!(
        "100 warm edits: median {} ms, p95 {} ms",
        report["warmMedianMs"], report["warmP95Ms"]
    );
    Ok(())
}

#[derive(Default)]
struct PacketCounts {
    fragments: u64,
    bytes: u64,
    video: u64,
    audio: u64,
    first_pts: Option<f64>,
    end_pts: f64,
}

impl PacketCounts {
    /// Only the synthetic qualification studio reaches this path. The recorder
    /// finalizes from its in-memory cursors. It never reopens older fragments.
    /// Keep the current head on disk until the next commit (or final save).
    fn consume(
        &mut self,
        path: &Path,
        tool: &Path,
        head: &producer_native_media::recording::RecordingHead,
        track: u32,
        until: u64,
    ) -> Result<()> {
        use producer_native_media::recording::RecordingStore;
        use std::{io::Write, process::Command};
        let mut playlist = tempfile::NamedTempFile::new_in(path)?;
        writeln!(playlist, "ffconcat version 1.0")?;
        let mut verified = Vec::new();
        for index in self.fragments..until {
            let (fragment, file) = RecordingStore::read_chunk(path, head, track, index)?;
            self.bytes += fragment.bytes;
            for span in fragment.spans.iter().filter(|s| s.media == "video") {
                self.first_pts.get_or_insert(span.start.as_f64());
                self.end_pts = span.end()?.as_f64();
            }
            let name = file
                .file_name()
                .and_then(|n| n.to_str())
                .context("Invalid fragment name")?;
            writeln!(playlist, "file '{name}'")?;
            verified.push(file);
        }
        playlist.flush()?;
        let output = Command::new(tool)
            .args([
                "-nostdin", "-v", "error", "-xerror", "-f", "concat", "-safe", "1", "-i",
            ])
            .arg(playlist.path())
            .args([
                "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "framecrc", "-",
            ])
            .output()
            .context("Read encoded packets with the packaged ffmpeg")?;
        ensure!(
            output.status.success(),
            "Encoded packet inspection failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let rows = std::str::from_utf8(&output.stdout)?;
        let count = |stream| {
            rows.lines()
                .filter_map(|r| r.split_once(','))
                .filter(|(id, _)| id.trim() == stream)
                .count()
        };

        self.video += count("0") as u64;
        self.audio += count("1") as u64;
        self.fragments = until;
        for file in verified {
            fs::remove_file(file)?;
        }
        Ok(())
    }
}

/// Read compressed packets in small batches off the render and review threads.
/// Continuous recording uses bounded scratch storage and keeps its original clock.
fn inspect_take(path: &Path, ffmpeg: &Path) -> Result<Vec<Value>> {
    use producer_native_media::recording::{RecordingHead, RecordingStore, TakeState};
    let (header, _) = RecordingStore::inspect(path)?;
    ensure!(header.tracks.len() == 2, "Expected both program tracks");
    let mut counts = [PacketCounts::default(), PacketCounts::default()];
    loop {
        let head: RecordingHead = serde_json::from_slice(&fs::read(path.join("head.json"))?)?;
        ensure!(
            matches!(head.state, TakeState::Recording | TakeState::Saved),
            "Take failed: {:?}",
            head.error
        );
        let saved = head.state == TakeState::Saved;
        for (track, tally) in header.tracks.iter().zip(&mut counts) {
            if let Some(last) = &head.tracks[track.id as usize] {
                let until = last.index + u64::from(saved);
                if until > tally.fragments && (saved || until - tally.fragments >= 4) {
                    tally.consume(path, ffmpeg, &head, track.id, until)?;
                }
            }
        }
        if saved {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let mut results = Vec::new();
    for (track, tally) in header.tracks.iter().zip(counts) {
        ensure!(
            tally.video > 0 && tally.audio > 0,
            "Missing encoded video or audio in {}",
            track.source
        );
        let span = tally.end_pts - tally.first_pts.context("Missing encoded video span")?;
        let expected = (span * 30.).round() as u64;
        ensure!(expected > 0, "Empty video span");
        let missing = expected.saturating_sub(tally.video);
        results.push(json!({"source":track.source,"width":track.width,"height":track.height,
            "committedFragments":tally.fragments,"committedBytes":tally.bytes,"encodedVideoSamples":tally.video,
            "encodedAudioPackets":tally.audio,"videoSpanSeconds":span,"nominalSamplesInSpan":expected,
            "missingSamplesInSpan":missing,"missingPercentInSpan":100.*missing as f64/expected as f64}));
    }
    Ok(results)
}

/// Runs a real program worker beside private edit review, entirely in a fresh
/// studio. No device binding, capture, outgoing stream or model call is needed.
pub fn loaded(args: &[String]) -> Result<()> {
    use crate::engine;
    use std::{sync::atomic::Ordering, thread, time::Duration};

    ensure!(
        matches!(args.len(), 4..=6) && (args.len()<6 || args[5]=="--loaded-only"),
        "Expected design, material edit, seconds per condition, report path and optional packaged ffmpeg path for recording followed optionally by --loaded-only"
    );
    let ffmpeg = args.get(4).map(Path::new);
    if let Some(tool) = ffmpeg {
        ensure!(
            tool.is_file(),
            "Missing packaged ffmpeg at {}",
            tool.display()
        );
    }
    let seconds = args[2].parse::<u64>()?;
    ensure!(
        (10..=1200).contains(&seconds),
        "Choose 10–1200 seconds per condition"
    );
    let root = tempfile::tempdir()?;
    let mut studio = RoomProject::demo();
    let design: Value = serde_json::from_slice(&fs::read(&args[0])?)?;
    let id = design["id"].as_str().context("Missing set id")?.to_owned();
    authored_set::prepare(&studio, design)?.install(&mut studio)?;
    let pair = studio
        .set_layout_choices(&id)
        .into_iter()
        .find(|c| c.label.eq_ignore_ascii_case("Duo"))
        .context("Load fixture needs a Duo layout")?
        .pair;
    studio.mount_set(Some(id.clone()), Some(pair))?;
    engine::persist(root.path(), &studio)?;
    let base: Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    ensure!(
        base["op"] == "editAuthoredSet" && base["id"] == id,
        "Supply an edit for this fixture"
    );
    let scratch = tempfile::tempdir()?;
    let handle = engine::start(root.path().to_path_buf())?;
    let start = Instant::now();
    while handle.snapshot().output_frames.iter().any(|n| *n < 5) {
        ensure!(
            start.elapsed().as_secs() < 20,
            "Program never delivered both outputs: {:?}",
            handle.snapshot().error
        );
        thread::sleep(Duration::from_millis(50));
    }
    let mut results = Vec::new();
    for load in [false, true]
        .into_iter()
        .filter(|load| *load || args.get(5).is_none())
    {
        let mut recording_path = None;
        let mut inspector = None;
        if let Some(tool) = ffmpeg {
            let reply = handle.request(engine::RoomCommand::Record { enabled: true })?;
            ensure!(
                reply["ok"] == true,
                "Recording start failed: {}",
                reply["error"]
            );
            let take = reply["state"]["recordPath"]
                .as_str()
                .context("Missing private recording path")?;
            let path = Path::new(take);
            ensure!(
                path.parent() == Some(root.path().join("recordings").as_path()),
                "Recording is outside qualification studio"
            );
            recording_path = Some(path.to_path_buf());
            let owned_path = path.to_path_buf();
            let tool = tool.to_path_buf();
            inspector = Some(thread::spawn(move || inspect_take(&owned_path, &tool)));
        }
        let before = handle.snapshot();
        let begin = Instant::now();
        let mut max_cpu_p99 = 0.0f64;
        let mut edits = 0;
        let mut next_review = begin;
        while begin.elapsed().as_secs() < seconds {
            if load && Instant::now() >= next_review {
                let mut command = base.clone();
                command["changes"][0]["value"] = json!(2. + (edits % 499) as f64 / 17.);
                let candidate = authored_set::prepare(&studio, command)?;
                let mut private = studio.clone();
                candidate.install(&mut private)?;
                render_graph::inspect(&private.production.sets[&id])?;
                posters::authored_pairs_in(
                    root.path(),
                    &private,
                    &id,
                    scratch.path(),
                    384,
                    |_| Ok(()),
                )?;
                edits += 1;
                next_review += Duration::from_secs(1);
            }
            if inspector
                .as_ref()
                .is_some_and(|worker| worker.is_finished())
            {
                inspector
                    .take()
                    .unwrap()
                    .join()
                    .map_err(|_| anyhow::anyhow!("Packet inspector panicked"))??;
                anyhow::bail!("Recording ended before the timed condition completed");
            }
            let snap = handle.snapshot();
            ensure!(snap.error.is_none(), "Program failed: {:?}", snap.error);
            ensure!(
                snap.take.error.is_none(),
                "Encoder failed: {:?}",
                snap.take.error
            );
            max_cpu_p99 = max_cpu_p99.max(snap.cpu_p99_ms);
            thread::sleep(Duration::from_millis(50));
        }
        let elapsed = begin.elapsed().as_secs_f64();
        let after = handle.snapshot();
        let tracks = if let (Some(worker), Some(path)) = (inspector, recording_path.as_ref()) {
            let stop = handle.request(engine::RoomCommand::Record { enabled: false })?;
            ensure!(
                stop["ok"] == true,
                "Recording stop failed: {}",
                stop["error"]
            );
            let deadline = Instant::now() + Duration::from_secs(45);
            loop {
                let take = handle.snapshot().take;
                ensure!(
                    take.error.is_none(),
                    "Encoder finalization failed: {:?}",
                    take.error
                );
                if take.phase == "saved" && take.path.as_ref() == Some(path) {
                    break;
                }
                ensure!(Instant::now() < deadline, "Take finalization timed out");
                thread::sleep(Duration::from_millis(100));
            }
            Some(
                worker
                    .join()
                    .map_err(|_| anyhow::anyhow!("Packet inspector panicked"))??,
            )
        } else {
            None
        };
        results.push(json!({"encodedTracks":tracks,"privateReviews":edits,"seconds":elapsed,"frames":[after.output_frames[0]-before.output_frames[0],after.output_frames[1]-before.output_frames[1]],
            "skippedRenderDeadlines":after.skipped_render_deadlines-before.skipped_render_deadlines,
            "refusedOutputFrames":after.refused_frames-before.refused_frames,"maxCpuP99Ms":max_cpu_p99,"programRevision":after.program_revision}));
        fs::write(
            &args[3],
            serde_json::to_vec_pretty(
                &json!({"canvas":studio.canvas,"targetFps":30,"scene":id,"input":"disconnected","encoding":ffmpeg.is_some(),"packetInspection":if ffmpeg.is_some() {Some("concurrent verification and demux in four-fragment batches")} else {None},"conditions":results}),
            )?,
        )?;
        if let Some(path) = recording_path {
            fs::remove_dir_all(path)?;
        }
    }
    handle.closed.store(true, Ordering::Release);
    Ok(())
}
