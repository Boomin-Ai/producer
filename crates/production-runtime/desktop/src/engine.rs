use crate::{
    assets,
    model::{self, CanvasView, RoomProject},
    platform::{self, Frame, Movie, NativeRoom, Shared},
};
use anyhow::{anyhow, bail, Context, Result};
use producer_native_media::boundary::{OutputSize, BLOCK_FRAMES, BLOCK_SAMPLES};
use producer_production_contract::{Counter, Time};
use producer_production_core::{
    commands,
    compile::Plan,
    transport::{OutputInstant, Transport},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum RoomCommand {
    /// Select the monitor, never the recording bus.
    Monitor {
        preview: bool,
    },
    /// Explicitly put the editorial snapshot and its playhead on program.
    SendToOutput,
    SceneAdd,
    SceneRemove {
        id: String,
    },
    SourceRemove {
        source: String,
    },
    SceneSelect {
        id: String,
    },
    SetMount {
        id: Option<String>,
    },
    AddInput {
        kind: String,
        device: String,
    },
    ConfigureInput {
        source: String,
        kind: String,
        device: String,
    },
    CameraDevice {
        id: String,
    },
    RecordOriginals {
        camera: bool,
        screen: bool,
        microphone: bool,
    },
    TakeList,
    /// Add a frozen committed video track on its own editorial lane.
    TakePlace {
        name: String,
        track: u32,
        start: f64,
        #[serde(default)]
        duration: Option<f64>,
        #[serde(default)]
        source_in: Option<f64>,
    },
    /// Publish a newer source snapshot; preserve existing clip trims.
    TakeRefresh,
    TakeInspect {
        name: String,
    },
    TakeRecover {
        name: String,
    },
    State,
    ClearError,
    ScaffoldSet {
        id: String,
        title: String,
    },
    Document {
        command: commands::Command,
    },
    Play,
    Pause,
    Seek {
        seconds: f64,
    },
    Trim {
        clip: String,
        start: f64,
        duration: f64,
        source_in: f64,
    },
    CanvasView {
        view: CanvasView,
    },
    CanvasSize {
        target: String,
        width: u32,
        height: u32,
    },
    Workspace {
        command: crate::workspace::WorkspaceCommand,
    },
    Panel {
        panel: String,
        visible: bool,
    },
    TimelineDock {
        edge: String,
    },
    Select {
        clip: Option<String>,
    },
    Capture {
        camera: bool,
        screen: bool,
        mic: bool,
    },
    ImportMov {
        path: PathBuf,
    },
    ImportFailed {
        message: String,
    },
    Imported {
        grant: assets::ImportedAsset,
        duration: f64,
    },
    Record {
        enabled: bool,
    },
    Gain {
        source: String,
        gain: f32,
        muted: bool,
    },
    Quit,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Originals {
    pub camera: bool,
    pub screen: bool,
    pub microphone: bool,
}
pub struct Envelope {
    pub command: RoomCommand,
    pub reply: Option<SyncSender<serde_json::Value>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub cameras: serde_json::Value,
    pub microphones: serde_json::Value,
    pub input_status: std::collections::BTreeMap<String, InputStatus>,
    pub originals: Originals,
    pub take: crate::recording::Progress,
    pub take_playback: serde_json::Value,
    pub project: RoomProject,
    pub revision: u64,
    pub previewing: bool,
    pub program_position: f64,
    pub program_playing: bool,
    pub program_kind: String,
    pub program_revision: u64,
    pub preview_output_frames: [u64; 2],
    pub preview_cpu_p99_ms: f64,
    pub position: f64,
    pub playing: bool,
    pub recording: bool,
    pub selected_clip: Option<String>,
    pub error: Option<String>,
    pub record_path: Option<PathBuf>,
    pub render_frames: u64,
    pub refused_frames: u64,
    pub cpu_p99_ms: f64,
    movie_playback: VideoDiagnostics,
    pub frame_age_ms: [f64; 3],
    pub source_frames: [u64; 3],
    pub output_frames: [u64; 2],
    pub microphone_peak: f32,
    pub audio_frames: u64,
    pub audio_dropped: u64,
    pub audio_diagnostics: platform::AudioDiagnostics,
    pub native_status: [String; 5],
    pub assistant_context: serde_json::Value,
}
pub struct Handle {
    pub tx: SyncSender<Envelope>,
    pub snapshot: Arc<Mutex<Snapshot>>,
    pub media: Arc<Mutex<Option<Arc<Shared>>>>,
    pub preview_media: Arc<Mutex<Option<Arc<Shared>>>>,
    program: Arc<Mutex<Arc<RoomProject>>>,
    pub closed: Arc<AtomicBool>,
    pub done: Arc<AtomicBool>,
}
impl Handle {
    pub fn send(&self, command: RoomCommand) -> Result<()> {
        self.tx
            .try_send(Envelope {
                command,
                reply: None,
            })
            .map_err(|_| anyhow!("Room control queue busy"))
    }
    pub fn request(&self, command: RoomCommand) -> Result<serde_json::Value> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(Envelope {
                command,
                reply: Some(tx),
            })
            .map_err(|_| anyhow!("Room control queue busy"))?;
        rx.recv_timeout(Duration::from_secs(8)).map_err(Into::into)
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }
}
static MOVIE_WORKERS: AtomicU64 = AtomicU64::new(0);
struct MovieAdmission;
impl Drop for MovieAdmission {
    fn drop(&mut self) {
        MOVIE_WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}

struct MovieRequest {
    at: f64,
    generation: u64,
}
struct MovieAudioRequest {
    at: f64,
    generation: u64,
    start: i64,
}
struct MovieWorker {
    tx: SyncSender<MovieRequest>,
    audio_tx: SyncSender<MovieAudioRequest>,
    result: Arc<Mutex<Option<crate::presentation::Decoded<Frame>>>>,
    audio: Arc<producer_native_media::boundary::AudioQueue>,
    generation: Arc<AtomicU64>,
    closed: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    decoded: Arc<AtomicU64>,
    missed: Arc<AtomicU64>,
}
fn movie_fence(generation: u64) -> producer_native_media::boundary::MediaFence {
    producer_native_media::boundary::MediaFence {
        execution: 1,
        epoch: 1,
        source_incarnation: 1,
        request: generation,
    }
}
enum ReaderInput {
    File(PathBuf),
    Take {
        root: PathBuf,
        name: String,
        track: u32,
        frozen: Option<crate::take_playback::TakeGrant>,
    },
}
#[derive(Debug)]
struct ReaderInfo {
    available: producer_production_contract::Range,
    grant: Option<crate::take_playback::TakeGrant>,
}
enum Reader {
    File(Movie, Option<platform::MovieAudio>),
    Take(crate::take_playback::TakeDecoder),
}
impl Reader {
    fn open(input: ReaderInput) -> Result<(Self, ReaderInfo)> {
        match input {
            ReaderInput::File(path) => {
                let movie = Movie::open(&path)?;
                let info = ReaderInfo {
                    available: producer_production_contract::Range {
                        start: Time::ZERO,
                        duration: model::time(movie.duration)?,
                    },
                    grant: None,
                };
                Ok((Self::File(movie, platform::MovieAudio::open(&path)), info))
            }
            ReaderInput::Take {
                root,
                name,
                track,
                frozen,
            } => {
                let reader = crate::take_playback::TakeDecoder::open(&root, &name, track, frozen)?;
                let info = ReaderInfo {
                    available: reader.available(),
                    grant: Some(reader.grant.clone()),
                };
                Ok((Self::Take(reader), info))
            }
        }
    }
    fn frame(&mut self, at: f64, generation: u64) -> Result<Option<Arc<Frame>>> {
        match self {
            Self::File(m, _) => Ok(m.frame(at, generation)),
            Self::Take(t) => t.frame(at, generation),
        }
    }
    fn read(&mut self, at: f64, generation: u64, pcm: &mut [f32; BLOCK_SAMPLES]) -> Result<()> {
        match self {
            Self::File(_, s) => {
                if let Some(s) = s {
                    s.read(at, generation, pcm);
                }
                Ok(())
            }
            Self::Take(t) => t.read(at, generation, pcm),
        }
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        if let Self::File(movie, _) = self {
            movie.cancel();
        }
    }
}
impl MovieWorker {
    fn start(path: PathBuf) -> Result<(Self, f64)> {
        let (worker, info) = Self::start_reader(ReaderInput::File(path))?;
        Ok((worker, info.available.duration.as_f64()))
    }
    fn start_reader(input: ReaderInput) -> Result<(Self, ReaderInfo)> {
        if MOVIE_WORKERS
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                if n < 6 {
                    Some(n + 1)
                } else {
                    None
                }
            })
            .is_err()
        {
            bail!("MOV worker budget reached; wait for prior reader to close");
        }
        let (tx, rx) = mpsc::sync_channel::<MovieRequest>(1);
        let (audio_tx, audio_rx) = mpsc::sync_channel::<MovieAudioRequest>(16);
        let (result, generation, closed) = (
            Arc::new(Mutex::new(None)),
            Arc::new(AtomicU64::new(1)),
            Arc::new(AtomicBool::new(false)),
        );
        let audio = Arc::new(producer_native_media::boundary::AudioQueue::new(
            movie_fence(1),
            32,
        )?);
        let (r, g, c, q) = (
            result.clone(),
            generation.clone(),
            closed.clone(),
            audio.clone(),
        );
        let error = Arc::new(Mutex::new(None));
        let decoded = Arc::new(AtomicU64::new(0));
        let missed = Arc::new(AtomicU64::new(0));
        let worker_missed = missed.clone();
        let (worker_error, worker_decoded) = (error.clone(), decoded.clone());
        let (ready, opened) = mpsc::sync_channel(1);
        let spawn = std::thread::Builder::new()
            .name("producer-mov".into())
            .spawn(move || {
                let _admission = MovieAdmission;
                let (mut reader, info) = match Reader::open(input) {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready.send(Err(e.to_string()));
                        return;
                    }
                };
                let first_at = (info.available.start.as_f64() * 48000.).ceil() / 48000.;
                let first = match reader.frame(first_at, 1) {
                    Ok(Some(f)) => f,
                    other => {
                        let _ = ready.send(Err(format!(
                            "Video could not decode its first committed frame: {}",
                            other.err().map_or("no frame".into(), |e| e.to_string())
                        )));
                        return;
                    }
                };
                *r.lock().unwrap() = Some(crate::presentation::Decoded {
                    at: first_at,
                    generation: 1,
                    published: Instant::now(),
                    frame: first,
                });
                worker_decoded.fetch_add(1, Ordering::Relaxed);
                if ready.send(Ok(info)).is_err() {
                    return;
                }
                while !c.load(Ordering::Acquire) {
                    if let Ok(req) = rx.try_recv() {
                        if req.generation == g.load(Ordering::Acquire) {
                            let frame = match reader.frame(req.at, req.generation) {
                                Ok(f) => f,
                                Err(e) => {
                                    *worker_error.lock().unwrap() = Some(e.to_string());
                                    None
                                }
                            };
                            if frame.is_some() {
                                worker_decoded.fetch_add(1, Ordering::Relaxed);
                            } else {
                                worker_missed.fetch_add(1, Ordering::Relaxed);
                            }
                            if req.generation == g.load(Ordering::Acquire)
                                && !c.load(Ordering::Acquire)
                            {
                                if let Some(frame) = frame {
                                    *r.lock().unwrap() = Some(crate::presentation::Decoded {
                                        at: req.at,
                                        generation: req.generation,
                                        published: Instant::now(),
                                        frame,
                                    });
                                }
                            }
                        }
                    }
                    for _ in 0..8 {
                        let Ok(req) = audio_rx.try_recv() else {
                            break;
                        };
                        if req.generation != g.load(Ordering::Acquire) {
                            continue;
                        }
                        {
                            let mut block = producer_native_media::boundary::AudioBlock::silence(
                                movie_fence(req.generation),
                                req.start,
                            );
                            if let Err(e) = reader.read(req.at, req.generation, &mut block.samples)
                            {
                                *worker_error.lock().unwrap() = Some(e.to_string());
                            }
                            if req.generation == g.load(Ordering::Acquire) {
                                let _ = q.push(&block);
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            });
        if let Err(e) = spawn {
            MOVIE_WORKERS.fetch_sub(1, Ordering::AcqRel);
            return Err(e.into());
        }
        let info = match opened.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(d)) => d,
            result => {
                closed.store(true, Ordering::Release);
                bail!("MOV opening failed or timed out: {result:?}");
            }
        };
        Ok((
            Self {
                tx,
                audio_tx,
                result,
                audio,
                generation,
                closed,
                error,
                decoded,
                missed,
            },
            info,
        ))
    }
    fn request(&self, at: f64, generation: u64) -> bool {
        self.generation.store(generation, Ordering::Release);
        self.tx.try_send(MovieRequest { at, generation }).is_ok()
    }
    fn request_audio(&self, at: f64, generation: u64, start: i64) -> bool {
        self.audio_tx
            .try_send(MovieAudioRequest {
                at,
                generation,
                start,
            })
            .is_ok()
    }
    fn reset_audio(&self, generation: u64) -> bool {
        self.generation.store(generation, Ordering::Release);
        self.audio.reset(movie_fence(generation)).is_ok()
    }
    fn latest(&self) -> Option<crate::presentation::Decoded<Frame>> {
        self.result.try_lock().ok().and_then(|r| {
            r.as_ref().map(|f| crate::presentation::Decoded {
                at: f.at,
                generation: f.generation,
                published: f.published,
                frame: f.frame.clone(),
            })
        })
    }
}
impl Drop for MovieWorker {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
    }
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputStatus {
    pub frames: u64,
    pub peak: f32,
    pub age_ms: f64,
    pub dropped: u64,
    pub message: String,
}
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoDiagnostics {
    requested: f64,
    decoded_at: f64,
    decode_age_ms: f64,
    decoded_frames: u64,
    decode_misses: u64,
    missing_presentations: u64,
    frame_ready: bool,
}
#[derive(Clone, Default)]
struct RenderStats {
    input_status: std::collections::BTreeMap<String, InputStatus>,
    position: f64,
    playing: bool,
    render_frames: u64,
    refused_frames: u64,
    cpu_p99_ms: f64,
    movie_playback: VideoDiagnostics,
    source_frames: [u64; 3],
    output_frames: [u64; 2],
    frame_age_ms: [f64; 3],
    microphone_peak: f32,
    audio_frames: u64,
    audio_dropped: u64,
    audio_diagnostics: platform::AudioDiagnostics,
    native_status: [String; 5],
    take: crate::recording::Progress,
    take_playback: serde_json::Value,
    error: Option<String>,
}
impl RenderStats {
    fn merge(&self, s: &mut Snapshot) {
        s.input_status = self.input_status.clone();
        s.program_position = self.position;
        s.program_playing = self.playing;
        s.render_frames = self.render_frames;
        s.refused_frames = self.refused_frames;
        s.cpu_p99_ms = self.cpu_p99_ms;
        s.movie_playback = self.movie_playback.clone();
        s.source_frames = self.source_frames;
        s.output_frames = self.output_frames;
        s.frame_age_ms = self.frame_age_ms;
        s.microphone_peak = self.microphone_peak;
        s.audio_frames = self.audio_frames;
        s.audio_dropped = self.audio_dropped;
        s.audio_diagnostics = self.audio_diagnostics.clone();
        s.native_status = self.native_status.clone();
        // A render snapshot can lag an acknowledged new recording by one
        // polling interval. Never let the prior take's Saved/Failed state
        // clear a newer session or expose its old committed head as the new one.
        merge_recording_progress(&mut s.take, &mut s.recording, &self.take);
        s.take_playback = self.take_playback.clone();
        s.assistant_context["editing"] = serde_json::json!({"committedTake":s.take_playback,"commands":["takeList","takeInspect","takePlace","takeRefresh","trim","seek"],"policy":"Edits target the immutable committed snapshot; refresh never changes trims. Recording clock remains independent."});
        s.assistant_context["recording"] = serde_json::json!({"originals":s.originals,"take":s.take,"commands":["recordOriginals","record","takeInspect","takeRecover"],"policy":"Originals require explicit selection; paused editorial time does not pause capture. Only committed chunks are readable. Recovery does not resume devices."});
        if let Some(e) = &self.error {
            s.error = Some(e.clone());
        }
    }
}
fn merge_recording_progress(
    current: &mut crate::recording::Progress,
    recording: &mut bool,
    incoming: &crate::recording::Progress,
) {
    if incoming.session < current.session {
        return;
    }
    *current = incoming.clone();
    if matches!(current.phase.as_str(), "failed" | "saved") {
        *recording = false;
    }
}
enum RenderOp {
    Monitor(bool),
    Publish {
        project: Arc<RoomProject>,
        plan: Arc<Plan>,
        visuals: Arc<crate::visuals::Visuals>,
        revision: u64,
        position: Time,
        playing: bool,
        movie: Option<MovieWorker>,
        take: Option<(MovieWorker, String, serde_json::Value)>,
    },
    Mix {
        project: Arc<RoomProject>,
    },
    Adopt {
        visuals: Arc<crate::visuals::Visuals>,
        project: Arc<RoomProject>,
        plan: Arc<Plan>,
        revision: u64,
    },
    Play,
    Pause,
    Seek(Time),
    Capture(bool, bool, bool),
    RemoveSource(String),
    CameraDevice(String),
    Input {
        source: String,
        endpoint: platform::CaptureInput,
    },
    MicrophoneDevice(String),
    Record(u64, producer_native_media::recording::RecordingHeader),
    StopRecord,
    Movie(MovieWorker),
    Take {
        visuals: Arc<crate::visuals::Visuals>,
        worker: MovieWorker,
        info: serde_json::Value,
        hash: String,
        project: Arc<RoomProject>,
        plan: Arc<Plan>,
        revision: u64,
    },
}
struct RenderEnvelope {
    op: RenderOp,
    reply: SyncSender<std::result::Result<(), String>>,
}
struct Renderer {
    tx: SyncSender<RenderEnvelope>,
    stats: Arc<Mutex<RenderStats>>,
}
impl Renderer {
    fn request(&self, op: RenderOp) -> Result<()> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(RenderEnvelope { op, reply: tx })
            .map_err(|_| anyhow!("Render control busy"))?;
        rx.recv_timeout(Duration::from_secs(2))
            .context("Renderer acknowledgement timed out")?
            .map_err(|e| anyhow!(e))
    }
}
pub fn start(root: PathBuf) -> Result<Arc<Handle>> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let project_path = root.join("room.json");
    let project: RoomProject = if project_path.exists() {
        let bytes = fs::read(&project_path)?;
        if bytes.len() > 8 * 1024 * 1024 {
            bail!("Native room project too large");
        }
        serde_json::from_slice(&bytes)?
    } else {
        RoomProject::demo()
    };
    let plan = project.compile()?;
    let program = Arc::new(project.live_set()?);
    let snapshot = Snapshot {
        cameras: platform::cameras(),
        microphones: platform::microphones(),
        input_status: Default::default(),
        originals: Originals::default(),
        take: crate::recording::Progress::default(),
        take_playback: serde_json::json!(null),
        assistant_context: project.assistant_context(),
        project,
        revision: 1,
        previewing: false,
        program_position: 0.,
        program_playing: true,
        program_kind: "set".into(),
        program_revision: 1,
        preview_output_frames: [0; 2],
        preview_cpu_p99_ms: 0.,
        position: 0.,
        playing: false,
        recording: false,
        selected_clip: None,
        error: None,
        record_path: None,
        render_frames: 0,
        refused_frames: 0,
        cpu_p99_ms: 0.,
        movie_playback: VideoDiagnostics::default(),
        frame_age_ms: [0.; 3],
        source_frames: [0; 3],
        output_frames: [0; 2],
        microphone_peak: 0.,
        audio_frames: 0,
        audio_dropped: 0,
        audio_diagnostics: platform::AudioDiagnostics::default(),
        native_status: std::array::from_fn(|_| String::new()),
    };
    let (tx, rx) = mpsc::sync_channel(16);
    let handle = Arc::new(Handle {
        tx,
        snapshot: Arc::new(Mutex::new(snapshot)),
        media: Arc::new(Mutex::new(None)),
        preview_media: Arc::new(Mutex::new(None)),
        program: Arc::new(Mutex::new(program)),
        closed: Arc::new(AtomicBool::new(false)),
        done: Arc::new(AtomicBool::new(false)),
    });
    let shared = handle.clone();
    std::thread::Builder::new()
        .name("producer-room-control".into())
        .spawn(move || {
            if let Err(e) = control(root, shared.clone(), rx, plan) {
                shared.snapshot.lock().unwrap().error = Some(format!("Native runtime: {e:#}"));
                shared.closed.store(true, Ordering::Release);
            }
            shared.done.store(true, Ordering::Release);
        })?;
    Ok(handle)
}
fn now(origin: f64) -> OutputInstant {
    OutputInstant(Counter(
        ((platform::host_time() - origin).max(0.) * 1e9) as u64,
    ))
}
fn persist(root: &Path, p: &RoomProject) -> Result<()> {
    let pending = root.join("room.pending");
    let mut file = File::create(&pending)?;
    serde_json::to_writer_pretty(&mut file, p)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(pending, root.join("room.json"))?;
    File::open(root)?.sync_all()?;
    Ok(())
}
fn apply(
    state: &mut Snapshot,
    command: RoomCommand,
    root: &Path,
    render: &Renderer,
    handle: &Arc<Handle>,
    importing: &Arc<AtomicBool>,
) -> Result<bool> {
    let mut changed = false;
    match command {
        c @ (RoomCommand::AddInput { .. } | RoomCommand::ConfigureInput { .. }) => {
            if state.recording || state.take.busy() {
                bail!("Stop and finalize recording before changing device inputs");
            }
            let (kind, device, source) = match c {
                RoomCommand::AddInput { kind, device } => (kind, device, None),
                RoomCommand::ConfigureInput {
                    source,
                    kind,
                    device,
                } => (kind, device, Some(source)),
                _ => unreachable!(),
            };
            let devices = match kind.as_str() {
                "camera" => platform::cameras(),
                "microphone" => platform::microphones(),
                _ => bail!("Unknown input type"),
            };
            let label = devices
                .as_array()
                .and_then(|a| a.iter().find(|d| d["id"].as_str() == Some(&device)))
                .and_then(|d| d["name"].as_str())
                .ok_or_else(|| anyhow!("Device disconnected; choose an available input"))?
                .to_owned();
            let restoring =
                source.is_none() && !state.project.lanes.iter().any(|l| l.source == kind);
            if restoring {
                state.project.restore_source(&kind)?;
            }
            // Claim the existing default endpoint before admitting a second
            // capture of the same physical device.
            if !restoring && !state.project.inputs.contains_key(&kind) {
                if let Some(d) = devices
                    .as_array()
                    .and_then(|a| a.iter().find(|d| d["default"].as_bool() == Some(true)))
                {
                    if let (Some(id), Some(name)) = (d["id"].as_str(), d["name"].as_str()) {
                        state.project.configure_input(&kind, &kind, id, name)?;
                    }
                }
            }
            let source = if restoring {
                state
                    .project
                    .configure_input(&kind, &kind, &device, &label)?;
                kind.clone()
            } else if let Some(source) = source {
                state
                    .project
                    .configure_input(&source, &kind, &device, &label)?;
                source
            } else {
                state.project.add_input(&kind, &device, &label)?
            };
            // Validate before opening hardware; a rejected candidate opens nothing.
            state.project.compile()?;
            if source == "camera" {
                render.request(RenderOp::CameraDevice(device))?;
                render.request(RenderOp::Capture(true, false, false))?;
            } else if source == "microphone" {
                render.request(RenderOp::MicrophoneDevice(device))?;
                render.request(RenderOp::Capture(false, false, true))?;
            } else {
                let origin = handle
                    .media
                    .lock()
                    .unwrap()
                    .as_ref()
                    .context("Capture service is starting")?
                    .origin;
                let endpoint = platform::CaptureInput::new(kind == "microphone", &device, origin)?;
                render.request(RenderOp::Input { source, endpoint })?;
            }
            state.cameras = platform::cameras();
            state.microphones = platform::microphones();
            changed = true;
        }
        RoomCommand::SourceRemove { source } => {
            if state.recording || state.take.busy() {
                bail!("Stop and finalize recording before removing a source");
            }
            state.project.remove_source(&source)?;

            if state.selected_clip.as_ref().is_some_and(|id| {
                !state.project.production.sequences["main"]
                    .placements
                    .iter()
                    .any(|p| &p.id == id)
            }) {
                state.selected_clip = None;
            }
            changed = true;
        }
        RoomCommand::ScaffoldSet { id, title } => {
            state.project.scaffold_set(&id, &title)?;
            changed = true;
        }
        RoomCommand::State => {}
        RoomCommand::ClearError => {
            state.error = None;
        }
        RoomCommand::Monitor { .. }
        | RoomCommand::SendToOutput
        | RoomCommand::SceneRemove { .. }
        | RoomCommand::SceneAdd
        | RoomCommand::SceneSelect { .. }
        | RoomCommand::SetMount { .. }
        | RoomCommand::Play
        | RoomCommand::Pause
        | RoomCommand::Seek { .. } => {
            unreachable!("monitor commands are routed before room mutations")
        }
        RoomCommand::Document { command } => {
            state.project.command(command)?;
            changed = true;
        }
        RoomCommand::Trim {
            clip,
            start,
            duration,
            source_in,
        } => {
            state.project.trim(&clip, start, duration, source_in)?;
            changed = true;
        }
        RoomCommand::CanvasView { view } => {
            state.project.canvas.view = view;
            changed = true;
        }
        RoomCommand::CanvasSize {
            target,
            width,
            height,
        } => {
            if state.recording {
                bail!("Stop recording before changing output dimensions");
            }
            let size = OutputSize { width, height }.validate()?;
            match target.as_str() {
                "landscape" => state.project.canvas.landscape = size,
                "vertical" => state.project.canvas.vertical = size,
                _ => bail!("Unknown output target"),
            };
            changed = true;
        }
        RoomCommand::Workspace { command } => {
            state.project.workspace.apply(command)?;
            changed = true;
        }
        RoomCommand::Panel { panel, visible } => {
            state
                .project
                .workspace
                .apply(crate::workspace::WorkspaceCommand::Visibility {
                    panel: crate::workspace::PanelId::parse(&panel)?,
                    visible,
                })?;
            changed = true;
        }
        RoomCommand::TimelineDock { edge } => {
            let edge = match edge.as_str() {
                "top" => crate::workspace::Edge::Top,
                "bottom" => crate::workspace::Edge::Bottom,
                _ => bail!("Timeline supports top/bottom docks"),
            };
            state
                .project
                .workspace
                .apply(crate::workspace::WorkspaceCommand::Move {
                    panel: crate::workspace::PanelId::Timeline,
                    edge,
                })?;
            changed = true;
        }
        RoomCommand::Select { clip } => {
            state.project.workspace.selected = clip.clone();
            state.selected_clip = clip;
        }
        RoomCommand::Capture {
            camera,
            screen,
            mic,
        } => {
            for (enabled, source) in [(camera, "camera"), (screen, "screen"), (mic, "microphone")] {
                if enabled && !state.project.lanes.iter().any(|l| l.source == source) {
                    state.project.restore_source(source)?;
                    changed = true;
                }
            }
            render.request(RenderOp::Capture(camera, screen, mic))?;
        }
        RoomCommand::ImportMov { path } => {
            if importing.swap(true, Ordering::AcqRel) {
                bail!("An asset import is already running");
            }
            let root = root.to_path_buf();
            let h = handle.clone();
            let busy = importing.clone();
            std::thread::Builder::new()
                .name("producer-asset-import".into())
                .spawn(move || {
                    let result = assets::import(&path, &root.join("assets"));
                    match result {
                        Ok(grant) => {
                            if h.send(RoomCommand::Imported {
                                grant,
                                duration: 0.,
                            })
                            .is_err()
                            {
                                h.snapshot.lock().unwrap().error =
                                    Some("Import completion queue busy; please retry".into());
                            }
                        }
                        Err(e) => {
                            let _ = h.send(RoomCommand::ImportFailed {
                                message: e.to_string(),
                            });
                        }
                    }
                    busy.store(false, Ordering::Release);
                })?;
        }
        RoomCommand::ImportFailed { message } => {
            bail!("{message}");
        }
        RoomCommand::Imported { grant, .. } => {
            let (worker, duration) = MovieWorker::start(grant.path.clone())?;
            state.project.restore_source("movie")?;
            state.project.bind_movie(&grant.hash, duration)?;
            drop(worker);
            fs::write(root.join("movie.json"), serde_json::to_vec(&grant)?)?;
            changed = true;
        }
        RoomCommand::CameraDevice { id } => {
            if state.recording || state.take.busy() {
                bail!("Stop recording before changing camera devices");
            }
            if !state
                .cameras
                .as_array()
                .is_some_and(|v| v.iter().any(|d| d["id"].as_str() == Some(&id)))
            {
                bail!("Unknown camera device");
            }
            let label = state
                .cameras
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["id"].as_str() == Some(&id))
                .unwrap()["name"]
                .as_str()
                .context("Camera has no label")?
                .to_owned();
            state
                .project
                .configure_input("camera", "camera", &id, &label)?;
            render.request(RenderOp::CameraDevice(id))?;
            changed = true;
        }
        RoomCommand::RecordOriginals {
            camera,
            screen,
            microphone,
        } => {
            if state.recording || state.take.busy() {
                bail!("Stop and finalize the take before changing originals");
            }
            state.originals = Originals {
                camera,
                screen,
                microphone,
            };
        }
        RoomCommand::TakePlace { .. } | RoomCommand::TakeRefresh => {
            unreachable!("Handled on control worker")
        }
        RoomCommand::TakeList => unreachable!("Handled on control worker"),
        RoomCommand::TakeInspect { name } | RoomCommand::TakeRecover { name } => {
            let _ = name;
            unreachable!("Handled on control worker")
        }
        RoomCommand::Record { enabled } => {
            let media = handle
                .media
                .lock()
                .unwrap()
                .clone()
                .context("Native media is starting")?;
            if enabled && !state.recording {
                if media.recorder.snapshot().busy() {
                    bail!("The previous take is still finalizing");
                }
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos();
                let parent = root.join("recordings");
                fs::create_dir_all(&parent)?;
                let path = parent.join(format!("take-{stamp}"));
                let program = handle.program.lock().unwrap().clone();
                let mut tracks = Vec::new();
                for (source, size) in [
                    ("program-landscape", program.canvas.landscape),
                    ("program-vertical", program.canvas.vertical),
                ] {
                    tracks.push(producer_native_media::recording::RecordingTrack {
                        id: tracks.len() as u32,
                        source: source.into(),
                        incarnation: 1,
                        width: size.width,
                        height: size.height,
                        audio: true,
                    });
                }
                for (i, selected) in [state.originals.camera, state.originals.screen]
                    .into_iter()
                    .enumerate()
                {
                    if selected {
                        let frame = media
                            .frame(i)
                            .filter(|f| platform::host_time() - f.at < 1.)
                            .context(
                                "Selected original has no fresh frames; enable its capture first",
                            )?;
                        OutputSize {
                            width: frame.width as u32,
                            height: frame.height as u32,
                        }
                        .validate()?;
                        tracks.push(producer_native_media::recording::RecordingTrack {
                            id: tracks.len() as u32,
                            source: ["camera", "screen"][i].into(),
                            incarnation: frame.generation,
                            width: frame.width as u32,
                            height: frame.height as u32,
                            audio: false,
                        });
                    }
                }
                if state.originals.microphone {
                    if !media.mic_ready() {
                        bail!("Selected original microphone has no fresh samples");
                    }
                    tracks.push(producer_native_media::recording::RecordingTrack {
                        id: tracks.len() as u32,
                        source: "microphone".into(),
                        incarnation: 1,
                        width: 0,
                        height: 0,
                        audio: true,
                    });
                }
                let asset_refs = program
                    .production
                    .sources
                    .iter()
                    .filter_map(|(id, source)| {
                        if let producer_production_contract::Source::Player { asset } = source {
                            program
                                .production
                                .assets
                                .get(asset)
                                .map(|a| (id.clone(), a.hash.clone()))
                        } else {
                            None
                        }
                    })
                    .collect();
                let header = producer_native_media::recording::RecordingHeader {
                    version: 1,
                    room: state.project.room.clone(),
                    host_origin_ns: (platform::host_time() * 1e9).round() as u64,
                    tracks,
                    asset_refs,
                };
                let session = media.recorder.start(path.clone(), header.clone())?;
                if let Err(e) = render.request(RenderOp::Record(session, header)) {
                    media.recorder.event(
                        session,
                        0,
                        3,
                        e.to_string().as_bytes(),
                        Default::default(),
                        0,
                    );
                    return Err(e);
                }
                state.record_path = Some(path);
                state.recording = true;
                state.take = media.recorder.snapshot();
            } else if !enabled && (state.recording || media.recorder.snapshot().busy()) {
                render.request(RenderOp::StopRecord)?;
                state.recording = false;
                state.take = media.recorder.snapshot();
            }
        }
        RoomCommand::Gain {
            source,
            gain,
            muted,
        } => {
            if !gain.is_finite() || !(0.0..=2.).contains(&gain) {
                bail!("Gain outside 0..2");
            }
            let lane = state
                .project
                .lanes
                .iter_mut()
                .find(|l| l.source == source)
                .ok_or_else(|| anyhow!("Unknown audio lane"))?;
            lane.gain = gain;
            lane.muted = muted;
            changed = true;
        }
        RoomCommand::Quit => handle.closed.store(true, Ordering::Release),
    }
    Ok(changed)
}
fn take_asset_digest(project: &RoomProject) -> Option<&str> {
    let producer_production_contract::Source::Player { asset } =
        project.production.sources.get("take")?
    else {
        return None;
    };
    Some(&project.production.assets.get(asset)?.hash)
}
fn take_asset_hash(project: &RoomProject) -> Option<String> {
    take_asset_digest(project).map(str::to_owned)
}
fn load_take_grant(root: &Path, hash: &str) -> Result<crate::take_playback::TakeGrant> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("Invalid take asset digest");
    }
    let path = root.join("assets").join(format!("take-{hash}.json"));
    let meta = fs::symlink_metadata(&path)?;
    if !meta.is_file() || meta.len() > 32768 {
        bail!("Invalid take grant");
    }
    let g: crate::take_playback::TakeGrant = serde_json::from_reader(File::open(path)?)?;
    if g.hash != hash {
        bail!("Take grant digest mismatch");
    }
    Ok(g)
}
fn save_take_grant(root: &Path, g: &crate::take_playback::TakeGrant) -> Result<()> {
    fs::create_dir_all(root.join("assets"))?;
    let path = root.join("assets").join(format!("take-{}.json", g.hash));
    if path.exists() {
        load_take_grant(root, &g.hash)?;
        return Ok(());
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    serde_json::to_writer(&mut f, g)?;
    f.sync_all()?;
    File::open(root.join("assets"))?.sync_all()?;
    Ok(())
}
fn take_summary(info: &ReaderInfo) -> serde_json::Value {
    let g = info.grant.as_ref().unwrap();
    serde_json::json!({"name":g.name,"track":g.track,"headRevision":g.head.revision,"asset":g.hash,"available":info.available,"decodedFrames":0,"error":null,"policy":"Frozen committed snapshot; refresh does not change clip trims or record clock"})
}
/// Each monitor owns its transport and decoder requests. Only program owns
/// hardware capture, mixing and recording. Preview reuses retained live surfaces.
struct PreviewRuntime {
    render: Renderer,
    worker: std::thread::JoinHandle<()>,
}
impl PreviewRuntime {
    fn merge(&self, state: &mut Snapshot) {
        if let Ok(stats) = self.render.stats.try_lock() {
            state.position = stats.position;
            state.playing = stats.playing;
            state.preview_output_frames = stats.output_frames;
            state.preview_cpu_p99_ms = stats.cpu_p99_ms;
            state.take_playback = stats.take_playback.clone();
            if let Some(e) = &stats.error {
                state.error = Some(e.clone());
            }
        }
    }
}
fn publish(
    renderer: &Renderer,
    root: &Path,
    project: RoomProject,
    position: f64,
    playing: bool,
    revision: u64,
    cache: &mut crate::visuals::VisualCache,
) -> Result<()> {
    // All fallible preparation precedes the single render adoption boundary.
    let plan = project.compile()?;
    let visuals = cache.prepare(&project, &plan)?;
    let movie = if let Ok(bytes) = fs::read(root.join("movie.json")) {
        let grant: assets::ImportedAsset = serde_json::from_slice(&bytes)?;
        let bound = project
            .production
            .sources
            .get("movie")
            .and_then(|s| match s {
                producer_production_contract::Source::Player { asset } => {
                    project.production.assets.get(asset)
                }
                _ => None,
            })
            .is_some_and(|a| a.hash == grant.hash);
        if bound && project.lanes.iter().any(|lane| lane.source == "movie") {
            Some(MovieWorker::start(grant.path)?.0)
        } else {
            None
        }
    } else {
        None
    };
    let take = if let Some(hash) = take_asset_hash(&project) {
        let g = load_take_grant(root, &hash)?;
        let (worker, info) = MovieWorker::start_reader(ReaderInput::Take {
            root: root.into(),
            name: g.name.clone(),
            track: g.track,
            frozen: Some(g),
        })?;
        Some((worker, hash, take_summary(&info)))
    } else {
        None
    };
    let position = model::time(position)?;
    if position > project.production.sequences["main"].duration {
        bail!("Playhead outside timeline");
    }
    renderer.request(RenderOp::Publish {
        project: Arc::new(project),
        plan,
        visuals,
        revision,
        position,
        playing,
        movie,
        take,
    })
}
fn ensure_preview<'a>(
    slot: &'a mut Option<PreviewRuntime>,
    handle: &Arc<Handle>,
    root: &Path,
    state: &Snapshot,
) -> Result<&'a PreviewRuntime> {
    if slot.is_none() {
        let (tx, rx) = mpsc::sync_channel(16);
        let stats = Arc::new(Mutex::new(RenderStats::default()));
        let h = handle.clone();
        let worker_stats = stats.clone();
        let project = Arc::new(state.project.clone());
        let plan = project.compile()?;
        let mut cache = crate::visuals::VisualCache::default();
        let visuals = cache.prepare(&project, &plan)?;
        let worker = std::thread::Builder::new()
            .name("producer-preview".into())
            .spawn(move || {
                if let Err(e) =
                    render_loop(h, rx, project, plan, worker_stats.clone(), visuals, true)
                {
                    worker_stats.lock().unwrap().error = Some(format!("Timeline preview: {e:#}"));
                }
            })?;
        // Retain the worker even on a failed publish so shutdown always joins it.
        *slot = Some(PreviewRuntime {
            render: Renderer { tx, stats },
            worker,
        });
        publish(
            &slot.as_ref().unwrap().render,
            root,
            state.project.clone(),
            state.position,
            state.playing,
            state.revision,
            &mut cache,
        )?;
    }
    Ok(slot.as_ref().unwrap())
}

fn control(
    root: PathBuf,
    handle: Arc<Handle>,
    rx: Receiver<Envelope>,
    _plan: Arc<Plan>,
) -> Result<()> {
    let mut state = handle.snapshot();
    let (tx, render_rx) = mpsc::sync_channel(16);
    let stats = Arc::new(Mutex::new(RenderStats::default()));
    let worker_stats = stats.clone();
    let worker_handle = handle.clone();
    let project = Arc::new(state.project.live_set()?);
    let plan = project.compile()?;
    let mut visual_cache = crate::visuals::VisualCache::default();
    let visuals = visual_cache.prepare(&project, &plan)?;
    let worker = std::thread::Builder::new()
        .name("producer-render-audio".into())
        .spawn(move || {
            if let Err(e) = render_loop(
                worker_handle.clone(),
                render_rx,
                project,
                plan,
                worker_stats.clone(),
                visuals,
                false,
            ) {
                worker_stats.lock().unwrap().error = Some(format!("Render/audio: {e:#}"));
                worker_handle.closed.store(true, Ordering::Release);
            }
        })?;
    let render = Renderer { tx, stats };
    let mut preview: Option<PreviewRuntime> = None;
    let importing = Arc::new(AtomicBool::new(false));
    if let Ok(bytes) = fs::read(root.join("movie.json")) {
        if let Ok(grant) = serde_json::from_slice::<assets::ImportedAsset>(&bytes) {
            if state.project.lanes.iter().any(|l| l.source == "movie") {
                if let Ok((movie, _)) = MovieWorker::start(grant.path) {
                    render.request(RenderOp::Movie(movie))?;
                }
            }
        }
    }
    persist(&root, &state.project)?;
    while !handle.closed.load(Ordering::Acquire) {
        if let Ok(envelope) = rx.recv_timeout(Duration::from_millis(50)) {
            if let Ok(stats) = render.stats.try_lock() {
                stats.merge(&mut state);
            }
            if matches!(
                &envelope.command,
                RoomCommand::Monitor { .. }
                    | RoomCommand::Play
                    | RoomCommand::Pause
                    | RoomCommand::Seek { .. }
                    | RoomCommand::SendToOutput
                    | RoomCommand::SceneRemove { .. }
                    | RoomCommand::SceneAdd
                    | RoomCommand::SceneSelect { .. }
                    | RoomCommand::SetMount { .. }
            ) {
                let result = (|| -> Result<()> {
                    match &envelope.command {
                        RoomCommand::SceneAdd => {
                            let mut next = state.project.clone();
                            next.add_scene()?;
                            persist(&root, &next)?;
                            state.project = next;
                        }
                        RoomCommand::SceneRemove { id } if id != &state.project.active_scene => {
                            let mut next = state.project.clone();
                            next.remove_scene(id)?;
                            persist(&root, &next)?;
                            state.project = next;
                        }
                        RoomCommand::SetMount { .. }
                        | RoomCommand::SceneSelect { .. }
                        | RoomCommand::SceneRemove { .. } => {
                            let mut next = state.project.clone();
                            match &envelope.command {
                                RoomCommand::SetMount { id } => {
                                    next.mounted_set = id.clone();
                                    next.remember_scene_set();
                                }
                                RoomCommand::SceneSelect { id } => next.select_scene(id)?,
                                RoomCommand::SceneRemove { id } => next.remove_scene(id)?,
                                _ => unreachable!(),
                            }
                            if let Some(id) = &next.mounted_set {
                                next.scene = id.clone();
                            }
                            let has_set = next.mounted_set.is_some();
                            let live = next.live_set()?;
                            publish(
                                &render,
                                &root,
                                live,
                                0.,
                                true,
                                state.program_revision + 1,
                                &mut visual_cache,
                            )?;
                            state.project = next;
                            state.program_kind = if has_set { "set" } else { "room" }.into();
                            state.program_revision += 1;
                            persist(&root, &state.project)?;
                            state.previewing = false;
                            if let Some(p) = &preview {
                                p.render.request(RenderOp::Monitor(false))?;
                            }
                        }
                        RoomCommand::SendToOutput => {
                            publish(
                                &render,
                                &root,
                                state.project.clone(),
                                state.position,
                                state.playing,
                                state.program_revision + 1,
                                &mut visual_cache,
                            )?;
                            state.program_kind = "timeline".into();
                            state.program_revision += 1;
                            state.previewing = false;
                            if let Some(p) = &preview {
                                p.render.request(RenderOp::Monitor(false))?;
                            }
                        }
                        RoomCommand::Monitor { preview: false } => {
                            if let Some(p) = &preview {
                                p.render.request(RenderOp::Monitor(false))?;
                            }
                            state.previewing = false;
                        }
                        command => {
                            let p = ensure_preview(&mut preview, &handle, &root, &state)?;
                            p.render.request(RenderOp::Monitor(true))?;
                            state.previewing = true;
                            match command {
                                RoomCommand::Play => p.render.request(RenderOp::Play)?,
                                RoomCommand::Pause => p.render.request(RenderOp::Pause)?,
                                RoomCommand::Seek { seconds } => {
                                    p.render.request(RenderOp::Seek(model::time(*seconds)?))?
                                }
                                _ => {}
                            }
                            p.merge(&mut state);
                        }
                    }
                    Ok(())
                })();
                state.assistant_context = state.project.assistant_context();
                let reply = match result {
                    Ok(()) => {
                        state.error = None;
                        serde_json::json!({"ok":true,"state":state})
                    }
                    Err(e) => {
                        state.error = Some(e.to_string());
                        serde_json::json!({"ok":false,"error":e.to_string()})
                    }
                };
                *handle.snapshot.lock().unwrap() = state.clone();
                if let Some(tx) = envelope.reply {
                    let _ = tx.try_send(reply);
                }
                continue;
            }
            if matches!(envelope.command, RoomCommand::TakeList) {
                let result = (|| -> Result<serde_json::Value> {
                    let mut names = Vec::new();
                    let mut truncated = false;
                    if root.join("recordings").exists() {
                        for (scanned, entry) in fs::read_dir(root.join("recordings"))?
                            .take(1001)
                            .enumerate()
                        {
                            if scanned >= 1000 {
                                truncated = true;
                                break;
                            }
                            let entry = entry?;
                            let name = entry.file_name().to_string_lossy().into_owned();
                            if entry.file_type()?.is_dir()
                                && name.starts_with("take-")
                                && name[5..].bytes().all(|c| c.is_ascii_digit())
                            {
                                names.push(name);
                            }
                        }
                    }
                    names.sort();
                    names.reverse();
                    Ok(serde_json::json!({"ok":true,"takes":names,"truncated":truncated}))
                })();
                if let Some(tx) = envelope.reply {
                    let _ =
                        tx.try_send(result.unwrap_or_else(
                            |e| serde_json::json!({"ok":false,"error":e.to_string()}),
                        ));
                }
                continue;
            }
            if let RoomCommand::TakeInspect { name } | RoomCommand::TakeRecover { name } =
                &envelope.command
            {
                let result = (|| -> Result<serde_json::Value> {
                    if !name.starts_with("take-")
                        || name.len() > 64
                        || !name[5..].bytes().all(|c| c.is_ascii_digit())
                    {
                        bail!("Invalid local take name");
                    }
                    let path = root.join("recordings").join(name);
                    if matches!(envelope.command, RoomCommand::TakeRecover { .. }) {
                        producer_native_media::recording::RecordingStore::recover(&path)?;
                    }
                    let (header, head) =
                        producer_native_media::recording::RecordingStore::inspect(&path)?;
                    Ok(serde_json::json!({"ok":true,"header":header,"head":head}))
                })();
                if let Some(tx) = envelope.reply {
                    let _ =
                        tx.try_send(result.unwrap_or_else(
                            |e| serde_json::json!({"ok":false,"error":e.to_string()}),
                        ));
                }
                continue;
            }
            if matches!(
                envelope.command,
                RoomCommand::TakePlace { .. } | RoomCommand::TakeRefresh
            ) {
                let result = (|| -> Result<()> {
                    let (name, track, frozen) = match &envelope.command {
                        RoomCommand::TakePlace { name, track, .. } => (name.clone(), *track, None),
                        _ => {
                            let hash = take_asset_hash(&state.project)
                                .context("No committed take is placed")?;
                            let grant = load_take_grant(&root, &hash)?;
                            // Verify the old snapshot before accepting an extension.
                            crate::take_playback::TakeDecoder::open(
                                &root,
                                &grant.name,
                                grant.track,
                                Some(grant.clone()),
                            )?;
                            (grant.name, grant.track, None)
                        }
                    };
                    let (worker, info) = MovieWorker::start_reader(ReaderInput::Take {
                        root: root.clone(),
                        name,
                        track,
                        frozen,
                    })?;
                    let grant = info.grant.as_ref().context("Missing take grant")?;
                    let placement = match &envelope.command {
                        RoomCommand::TakePlace {
                            start,
                            duration,
                            source_in,
                            ..
                        } => {
                            let source_in = source_in.unwrap_or(
                                (info.available.start.as_f64() * 48000.).ceil() / 48000.,
                            );
                            let end = (info.available.end()?.as_f64() * 48000.).floor() / 48000.;
                            let duration = duration.unwrap_or((end - source_in).min(8.));
                            Some((*start, duration, source_in))
                        }
                        _ => None,
                    };
                    let mut project = state.project.clone();
                    project.bind_take(&grant.hash, info.available, placement)?;
                    let plan = project.compile()?;
                    let revision = state
                        .revision
                        .checked_add(1)
                        .context("Room revision exhausted")?;
                    save_take_grant(&root, grant)?;
                    let summary = take_summary(&info);
                    let target = ensure_preview(&mut preview, &handle, &root, &state)?;
                    target.render.request(RenderOp::Monitor(true))?;
                    state.previewing = true;
                    target.render.request(RenderOp::Take {
                        visuals: visual_cache.prepare(&project, &plan)?,
                        worker,
                        hash: grant.hash.clone(),
                        info: summary.clone(),
                        project: Arc::new(project.clone()),
                        plan,
                        revision,
                    })?;
                    state.project = project;
                    state.revision = revision;
                    state.take_playback = summary;
                    persist(&root, &state.project)?;
                    state.assistant_context = state.project.assistant_context();
                    state.error = None;
                    Ok(())
                })();
                let reply = match result {
                    Ok(()) => serde_json::json!({"ok":true,"state":state}),
                    Err(e) => {
                        state.error = Some(e.to_string());
                        serde_json::json!({"ok":false,"error":e.to_string()})
                    }
                };
                *handle.snapshot.lock().unwrap() = state.clone();
                if let Some(tx) = envelope.reply {
                    let _ = tx.try_send(reply);
                }
                continue;
            }
            let read_only = matches!(envelope.command, RoomCommand::State);
            let gain_only = matches!(&envelope.command, RoomCommand::Gain { .. });
            let workspace_only = matches!(
                &envelope.command,
                RoomCommand::Workspace { .. }
                    | RoomCommand::Panel { .. }
                    | RoomCommand::TimelineDock { .. }
            );
            let removing_source = match &envelope.command {
                RoomCommand::SourceRemove { source } => Some(source.clone()),
                _ => None,
            };
            let restoring_capture = match &envelope.command {
                RoomCommand::Capture {
                    camera,
                    screen,
                    mic,
                } => [
                    (*camera, "camera"),
                    (*screen, "screen"),
                    (*mic, "microphone"),
                ]
                .iter()
                .any(|(enabled, id)| {
                    *enabled && !state.project.lanes.iter().any(|l| l.source == *id)
                }),
                _ => false,
            };
            let input_or_size = restoring_capture
                || matches!(
                    &envelope.command,
                    RoomCommand::AddInput { .. }
                        | RoomCommand::SourceRemove { .. }
                        | RoomCommand::ConfigureInput { .. }
                        | RoomCommand::CameraDevice { .. }
                        | RoomCommand::CanvasSize { .. }
                );
            let imported = matches!(&envelope.command, RoomCommand::Imported { .. });
            let before = state.project.clone();
            let result = if input_or_size && state.program_kind == "timeline" {
                Err(anyhow!("Return to a live Set before changing output dimensions or device bindings"))
            } else { apply(
                &mut state,
                envelope.command,
                &root,
                &render,
                &handle,
                &importing,
            ) }
            .and_then(|changed| {
                if changed && gain_only {
                    // Mixer changes do not alter layout, capture, transport or
                    // graphics resources. Keep them off the compilation path.
                    render.request(RenderOp::Mix {
                        project: Arc::new(state.project.clone()),
                    })?;
                    persist(&root, &state.project)?;
                } else if changed && workspace_only {
                    state.project.workspace.validate()?;
                    persist(&root, &state.project)?;
                    state.assistant_context = state.project.assistant_context();
                } else if changed {
                    let next = state.project.compile()?;
                    let revision = state
                        .revision
                        .checked_add(1)
                        .context("Room revision exhausted")?;
                    if input_or_size {
                        // Hardware and output size are explicit live room operations.
                        // Timeline edits never enter this branch.
                        if state.program_kind != "timeline" {
                            publish(&render, &root, state.project.live_set()?, state.program_position, true, state.program_revision + 1, &mut visual_cache)?;
                            state.program_revision += 1;
                        } else {
                            bail!("Return to a live Set before changing output size or device bindings");
                        }
                    }
                    if !input_or_size || preview.is_some() {
                        let target = ensure_preview(&mut preview, &handle, &root, &state)?;
                        if imported {
                            publish(&target.render, &root, state.project.clone(), state.position, state.playing, revision, &mut visual_cache)?;
                        } else {
                            target.render.request(RenderOp::Adopt {
                                visuals: visual_cache.prepare(&state.project, &next)?,
                                project: Arc::new(state.project.clone()), plan: next, revision,
                            })?;
                        }
                        if !input_or_size || state.previewing {
                            target.render.request(RenderOp::Monitor(true))?;
                            state.previewing = true;
                        }
                    }
                    if let Some(source) = &removing_source { render.request(RenderOp::RemoveSource(source.clone()))?; }
                    state.revision = revision;
                    persist(&root, &state.project)?;
                    state.assistant_context = state.project.assistant_context();
                }
                Ok(())
            });
            let reply = match result {
                Ok(()) => {
                    if !read_only {
                        state.error = None;
                    }
                    serde_json::json!({"ok":true,"state":state})
                }
                Err(e) => {
                    state.project = before;
                    eprintln!("Room command failed: {e:#}");
                    state.error = Some(e.to_string());
                    serde_json::json!({"ok":false,"error":e.to_string()})
                }
            };
            if let Some(tx) = envelope.reply {
                let _ = tx.try_send(reply);
            }
        }
        if let Ok(stats) = render.stats.try_lock() {
            stats.merge(&mut state);
        }
        if let Some(p) = &preview {
            p.merge(&mut state);
        }
        state.assistant_context["monitor"] = serde_json::json!({"previewing":state.previewing,"programKind":state.program_kind,"programRevision":state.program_revision,"commands":["monitor","sendToOutput","setMount"],"policy":"Timeline play/seek/edit are preview-only. Only sendToOutput or setMount changes program. Recording always reads program."});
        *handle.snapshot.lock().unwrap() = state.clone();
    }
    if let Some(p) = preview {
        let _ = p.worker.join();
    }
    let _ = worker.join();
    persist(&root, &state.project)?;
    Ok(())
}
fn render_loop(
    handle: Arc<Handle>,
    rx: Receiver<RenderEnvelope>,
    mut project: Arc<RoomProject>,
    mut plan: Arc<Plan>,
    stats: Arc<Mutex<RenderStats>>,
    mut visuals: Arc<crate::visuals::Visuals>,
    preview: bool,
) -> Result<()> {
    let mut native = NativeRoom::new()?;
    if preview {
        *handle.preview_media.lock().unwrap() = Some(native.shared.clone());
    } else {
        *handle.media.lock().unwrap() = Some(native.shared.clone());
    }
    native.prepare([project.canvas.landscape, project.canvas.vertical])?;
    let origin = native.shared.origin;
    let mut transport = Transport::new(project.production.sequences["main"].duration, now(origin))?
        .with_host_timebase(48000)?;
    transport.looping = true;
    if !preview {
        transport.play(now(origin))?;
    }
    let mut visible = !preview;
    let (mut generation, mut revision) = (1u64, 1u64);
    let mut inputs = std::collections::BTreeMap::<String, platform::CaptureInput>::new();
    // Stop device sessions away from the output clock when replacing an input.
    let (retire_tx, retire_rx) = mpsc::sync_channel::<platform::CaptureInput>(16);
    let _retire_worker = std::thread::Builder::new()
        .name("producer-input-cleanup".into())
        .spawn(move || {
            for input in retire_rx {
                drop(input);
            }
        })?;
    let mut movie: Option<MovieWorker> = None;
    let mut take: Option<MovieWorker> = None;
    let mut presentations = [
        crate::presentation::Presentation::default(),
        crate::presentation::Presentation::default(),
    ];
    let mut take_hash = String::new();
    let mut take_frame_ready = false;
    let mut take_draws = [0; 2];
    let mut samples = vec![None; plan.sequences["main"].tracks.len()];
    let mut draws = [
        Vec::with_capacity(crate::visuals::MAX_DRAWS),
        Vec::with_capacity(crate::visuals::MAX_DRAWS),
    ];
    let render_interval = Duration::from_nanos(1_000_000_000 / 30);
    let (mut next_render, mut last_snapshot) = (Instant::now(), Instant::now());
    let mut state = RenderStats::default();
    state.playing = !preview;
    let mut frame_times = [0f64; 1024];
    let (mut times_index, mut times_len) = (0usize, 0usize);
    let mut audio_cursor = 0i64;
    let mut pcm = [0f32; BLOCK_SAMPLES];
    let mut raw_mic = [0f32; BLOCK_SAMPLES];
    let mut last_media_time = [-1.; 2];
    let mut media_generation = [0; 2];
    let mut audio_generation = [0; 2];
    let mut media_audio_cursor = [0i64; 2];
    let mut movie_pcm = [0f32; BLOCK_SAMPLES];
    let mut recording = false;
    let (mut mic_mix_contended, mut mic_mix_missing, mut clock_skipped) = (0u64, 0u64, 0u64);
    while !handle.closed.load(Ordering::Acquire) {
        let tick = Instant::now();
        for _ in 0..4 {
            let Ok(envelope) = rx.try_recv() else {
                break;
            };
            let result = (|| -> Result<()> {
                match envelope.op {
                    RenderOp::Monitor(enabled) => visible = enabled,
                    RenderOp::Publish {
                        project: next,
                        plan: next_plan,
                        visuals: next_visuals,
                        revision: next_revision,
                        position,
                        playing,
                        movie: next_movie,
                        take: next_take,
                    } => {
                        native.prepare([next.canvas.landscape, next.canvas.vertical])?;
                        transport.duration = next.production.sequences["main"].duration;
                        transport.seek(position, now(origin))?;
                        if playing {
                            transport.resume("operator", now(origin))?;
                            transport.play(now(origin))?;
                        } else {
                            transport.pause("operator", now(origin))?;
                        }
                        state.playing = playing;
                        if !preview {
                            *handle.program.lock().unwrap() = next.clone();
                        }
                        project = next;
                        plan = next_plan;
                        visuals = next_visuals;
                        revision = next_revision;
                        movie = next_movie;
                        if let Some((worker, hash, info)) = next_take {
                            take = Some(worker);
                            take_hash = hash;
                            state.take_playback = info;
                        } else {
                            take = None;
                            take_hash.clear();
                            state.take_playback = serde_json::Value::Null;
                        }
                        generation += 1;
                        samples.resize(plan.sequences["main"].tracks.len(), None);
                    }
                    RenderOp::Mix { project: next } => {
                        let mut mixed = (*project).clone();
                        mixed.lanes = next.lanes.clone();
                        project = Arc::new(mixed);
                    }
                    RenderOp::Adopt {
                        visuals: next_visuals,
                        project: next,
                        plan: next_plan,
                        revision: next_revision,
                    } => {
                        native.prepare([next.canvas.landscape, next.canvas.vertical])?;
                        visuals = next_visuals;
                        transport.duration = next.production.sequences["main"].duration;
                        let sequence_changed = project.production.sequences.get("main")
                            != next.production.sequences.get("main");
                        project = next;
                        plan = next_plan;
                        revision = next_revision;
                        samples.resize(plan.sequences["main"].tracks.len(), None);
                        if sequence_changed {
                            generation = generation
                                .checked_add(1)
                                .context("Media generation exhausted")?;
                        }
                    }
                    RenderOp::Play => {
                        transport.resume("operator", now(origin))?;
                        transport.play(now(origin))?;
                        state.playing = true;
                    }
                    RenderOp::Pause => {
                        transport.pause("operator", now(origin))?;
                        state.playing = false;
                    }
                    RenderOp::Seek(t) => {
                        transport.seek(t, now(origin))?;
                        generation = generation
                            .checked_add(1)
                            .context("Media generation exhausted")?;
                    }
                    RenderOp::Capture(c, s, m) => native.capture(c, s, m),
                    RenderOp::RemoveSource(source) => {
                        if let Some(old) = inputs.remove(&source) {
                            retire_tx
                                .send(old)
                                .map_err(|_| anyhow!("Input cleanup worker unavailable"))?;
                        }
                        match source.as_str() {
                            "camera" => native.stop_capture(0),
                            "screen" => native.stop_capture(1),
                            "microphone" => native.stop_capture(3),
                            "movie" => {
                                movie = None;
                            }
                            _ => {}
                        }
                    }
                    RenderOp::CameraDevice(id) => native.camera_device(&id)?,
                    RenderOp::MicrophoneDevice(id) => native.microphone_device(&id)?,
                    RenderOp::Input { source, endpoint } => {
                        // Reserve cleanup capacity before replacing a live endpoint.
                        if let Some(old) = inputs.remove(&source) {
                            retire_tx
                                .send(old)
                                .map_err(|_| anyhow!("Input cleanup worker unavailable"))?;
                        }
                        inputs.insert(source, endpoint);
                    }
                    RenderOp::Movie(worker) => {
                        movie = Some(worker);
                        generation += 1;
                    }
                    RenderOp::Take {
                        visuals: next_visuals,
                        worker,
                        hash,
                        info,
                        project: next,
                        plan: next_plan,
                        revision: next_revision,
                    } => {
                        native.prepare([next.canvas.landscape, next.canvas.vertical])?;
                        generation = generation
                            .checked_add(1)
                            .context("Media generation exhausted")?;
                        visuals = next_visuals;
                        take = Some(worker);
                        take_hash = hash;
                        state.take_playback = info;
                        project = next;
                        plan = next_plan;
                        revision = next_revision;
                        transport.duration = project.production.sequences["main"].duration;
                        samples.resize(plan.sequences["main"].tracks.len(), None);
                    }
                    RenderOp::Record(session, header) => {
                        state.error = None;
                        native.record(session, &header)?;
                        recording = true;
                    }
                    RenderOp::StopRecord => {
                        native.stop_record();
                        recording = false;
                    }
                }
                Ok(())
            })();
            let _ = envelope.reply.try_send(result.map_err(|e| e.to_string()));
        }
        if preview && !visible {
            state.position = transport.position(now(origin))?.as_f64();
            if let Ok(mut dest) = stats.try_lock() {
                *dest = state.clone();
            }
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        let host = platform::host_time();
        let position = transport.position(now(origin))?;
        state.position = position.as_f64();
        let seq = &plan.sequences["main"];
        let source_times = [
            active_source_time(seq, "camera", position)?,
            active_source_time(seq, "screen", position)?,
            active_source_time(seq, "movie", position)?,
            active_source_time(seq, "take", position)?,
        ];
        let take_bound = take_asset_digest(&project).is_some_and(|h| h == take_hash);
        for (i, (source, worker)) in [
            ("movie", movie.as_ref()),
            ("take", take.as_ref().filter(|_| take_bound)),
        ]
        .into_iter()
        .enumerate()
        {
            let Some(worker) = worker else {
                continue;
            };
            if let Some(t) = source_times[i + 2] {
                if media_generation[i] != generation || (t - last_media_time[i]).abs() > 0.015 {
                    if worker.request(t, generation) {
                        last_media_time[i] = t;
                        media_generation[i] = generation;
                    }
                }
            }
            if audio_generation[i] != generation && worker.reset_audio(generation) {
                audio_generation[i] = generation;
                media_audio_cursor[i] = ((host - origin) * 48000.) as i64 / 480 * 480;
            }
            if !preview && state.playing && audio_generation[i] == generation {
                let ahead = ((host - origin + 0.06) * 48000.) as i64;
                for _ in 0..12 {
                    if media_audio_cursor[i] >= ahead {
                        break;
                    }
                    let at_host = OutputInstant(Counter(
                        media_audio_cursor[i].max(0) as u64 * 1_000_000_000 / 48000,
                    ));
                    if let Ok(content) = transport.position(at_host) {
                        if let Some(t) = active_source_time(seq, source, content)? {
                            if !worker.request_audio(t, generation, media_audio_cursor[i]) {
                                break;
                            }
                        }
                    }
                    media_audio_cursor[i] += 480;
                }
            }
        }
        let wanted = ((host - origin - 0.04).max(0.) * 48000.) as i64;
        if wanted - audio_cursor > 4800 {
            clock_skipped += (wanted - audio_cursor) as u64;
            audio_cursor = wanted / 480 * 480;
        }
        for _ in 0..if preview { 0 } else { 4 } {
            if audio_cursor + BLOCK_FRAMES as i64 > wanted {
                break;
            }
            pcm.fill(0.);
            let gain = project
                .lanes
                .iter()
                .find(|l| l.source == "microphone")
                .map_or(0., |l| if l.muted { 0. } else { l.gain });
            match native
                .audio
                .mix(native.shared.fence, audio_cursor, &mut pcm, 1.)
            {
                Ok(frames) => mic_mix_missing += (BLOCK_FRAMES - frames) as u64,
                Err(producer_native_media::Error::Busy) => mic_mix_contended += 1,
                Err(_) => mic_mix_missing += BLOCK_FRAMES as u64,
            }

            raw_mic.copy_from_slice(&pcm);
            for sample in &mut pcm {
                *sample = (*sample * gain).clamp(-1., 1.);
            }
            for (source, input) in &mut inputs {
                if project
                    .inputs
                    .get(source)
                    .is_none_or(|b| b.kind != "microphone")
                {
                    continue;
                }
                movie_pcm.fill(0.);
                let gain = project
                    .lanes
                    .iter()
                    .find(|l| &l.source == source)
                    .map_or(0., |l| if l.muted { 0. } else { l.gain });
                let _ = input
                    .audio
                    .mix(input.shared.fence, audio_cursor, &mut movie_pcm, gain);
                for i in 0..BLOCK_SAMPLES {
                    pcm[i] = (pcm[i] + movie_pcm[i]).clamp(-1., 1.);
                }
            }
            if state.playing {
                for (source, worker) in [
                    ("movie", movie.as_ref()),
                    ("take", take.as_ref().filter(|_| take_bound)),
                ] {
                    let Some(worker) = worker else {
                        continue;
                    };
                    movie_pcm.fill(0.);
                    let gain = project
                        .lanes
                        .iter()
                        .find(|l| l.source == source)
                        .map_or(1., |l| if l.muted { 0. } else { l.gain });
                    let _ = worker.audio.mix(
                        movie_fence(generation),
                        audio_cursor,
                        &mut movie_pcm,
                        gain,
                    );
                    for i in 0..BLOCK_SAMPLES {
                        pcm[i] = (pcm[i] + movie_pcm[i]).clamp(-1., 1.);
                    }
                }
            }
            native.audio(&pcm, &raw_mic, origin + audio_cursor as f64 / 48000.);
            audio_cursor += BLOCK_FRAMES as i64;
        }
        if Instant::now() >= next_render {
            let start = Instant::now();
            seq.evaluate_into(position, &mut samples)
                .map_err(|_| anyhow!("Frame evaluation failed"))?;
            let live = if preview {
                handle.media.lock().unwrap().clone()
            } else {
                Some(native.shared.clone())
            };
            let mut frames = [
                live.as_ref().and_then(|s| s.frame(0)),
                live.as_ref().and_then(|s| s.frame(1)),
                presentations[0].frame(
                    generation,
                    source_times[2],
                    movie.as_ref().and_then(|m| m.latest()),
                    Instant::now(),
                ),
                presentations[1].frame(
                    generation,
                    take_bound.then_some(source_times[3]).flatten(),
                    take.as_ref()
                        .filter(|_| take_bound)
                        .and_then(|m| m.latest()),
                    Instant::now(),
                ),
                None,
                None,
                None,
                None,
            ];
            let mut active = [false; 8];
            active[..4].copy_from_slice(&source_times.map(|t| t.is_some()));
            for (source, input) in &inputs {
                if let Some(binding) = project.inputs.get(source).filter(|b| b.kind == "camera") {
                    let slot = binding.slot as usize;
                    frames[slot] = input.frame();
                    active[slot] = active_source_time(seq, source, position)?.is_some();
                }
            }
            if preview {
                if let Some(live) = &live {
                    for i in 4..8 {
                        frames[i] = live.extra_frames[i - 4]
                            .try_lock()
                            .ok()
                            .and_then(|f| f.clone());
                    }
                    for (source, binding) in &project.inputs {
                        if binding.kind == "camera" {
                            active[binding.slot as usize] =
                                active_source_time(seq, source, position)?.is_some();
                        }
                    }
                }
            } else {
                for i in 4..8 {
                    if let Ok(mut slot) = native.shared.extra_frames[i - 4].try_lock() {
                        *slot = frames[i].clone();
                    }
                }
            }
            take_frame_ready = frames[3].is_some();
            state.movie_playback.frame_ready = frames[2].is_some();
            if movie.is_some() && source_times[2].is_some() && frames[2].is_none() {
                state.movie_playback.missing_presentations += 1;
            }
            if let Some(f) = &frames[2] {
                if let Ok(mut slot) = native.shared.frames[2].try_lock() {
                    if slot.as_ref().is_none_or(|p| !Arc::ptr_eq(p, f)) {
                        native.shared.counts[2].fetch_add(1, Ordering::Relaxed);
                        *slot = Some(f.clone());
                    }
                }
            }
            for (i, size) in [project.canvas.landscape, project.canvas.vertical]
                .into_iter()
                .enumerate()
            {
                visuals.draws(
                    &plan,
                    &samples,
                    i,
                    size,
                    &frames,
                    active,
                    host - origin,
                    &mut draws[i],
                );
                take_draws[i] = draws[i]
                    .iter()
                    .filter(|d| d.kind == 1 && d.source == 3)
                    .count();
                if native.render(
                    i,
                    size.width,
                    size.height,
                    &draws[i],
                    &frames,
                    &visuals.text,
                    host,
                    revision,
                ) {
                    state.render_frames += 1;
                } else {
                    state.refused_frames += 1;
                }
            }
            frame_times[times_index] = start.elapsed().as_secs_f64() * 1000.;
            times_index = (times_index + 1) % frame_times.len();
            times_len = (times_len + 1).min(frame_times.len());
            // Keep a fixed output cadence. Resetting after work adds submission
            // time to every frame and turns a nominal 30 fps into ~27 fps.
            // Skip missed deadlines instead of rendering a catch-up burst.
            let finished = Instant::now();
            next_render += render_interval;
            if next_render <= finished {
                let remainder =
                    finished.duration_since(next_render).as_nanos() % render_interval.as_nanos();
                next_render = finished + render_interval - Duration::from_nanos(remainder as u64);
            }
        }
        if last_snapshot.elapsed() >= Duration::from_millis(100) {
            state.input_status.clear();
            for (source, input) in &inputs {
                let mic = project
                    .inputs
                    .get(source)
                    .is_some_and(|b| b.kind == "microphone");
                state.input_status.insert(
                    source.clone(),
                    InputStatus {
                        frames: if mic {
                            input.shared.audio_frames.load(Ordering::Relaxed)
                        } else {
                            input.shared.count.load(Ordering::Relaxed)
                        },
                        peak: input.shared.mic_peak.load(Ordering::Relaxed) as f32 / 1000.,
                        age_ms: input.frame().map_or(-1., |f| (host - f.at) * 1000.),
                        dropped: input.shared.audio_dropped.load(Ordering::Relaxed),
                        message: input
                            .shared
                            .status
                            .try_lock()
                            .map(|s| s.clone())
                            .unwrap_or_default(),
                    },
                );
            }
            for i in 0..3 {
                state.source_frames[i] = native.shared.counts[i].load(Ordering::Relaxed);
                state.frame_age_ms[i] = native
                    .shared
                    .frame(i)
                    .map_or(-1., |f| (host - f.at) * 1000.);
            }
            for i in 0..2 {
                state.output_frames[i] = native.shared.counts[i + 3].load(Ordering::Relaxed);
            }
            state.audio_frames = native.shared.audio_frames.load(Ordering::Relaxed);
            state.audio_dropped = native.shared.audio_dropped.load(Ordering::Relaxed);
            state.audio_diagnostics = native.shared.audio_diagnostics();
            state.audio_diagnostics.mix_contended_blocks = mic_mix_contended;
            state.audio_diagnostics.mix_missing_frames = mic_mix_missing;
            state.audio_diagnostics.clock_skipped_frames = clock_skipped;
            state.microphone_peak = native.shared.mic_peak.load(Ordering::Relaxed) as f32 / 1000.;
            if let Some(movie) = &movie {
                let f = movie.latest();
                state.movie_playback.requested = source_times[2].unwrap_or(-1.);
                state.movie_playback.decoded_at = f.as_ref().map_or(-1., |f| f.at);
                state.movie_playback.decode_age_ms = f
                    .as_ref()
                    .map_or(-1., |f| f.published.elapsed().as_secs_f64() * 1000.);
                state.movie_playback.decoded_frames = movie.decoded.load(Ordering::Relaxed);
                state.movie_playback.decode_misses = movie.missed.load(Ordering::Relaxed);
            }
            if let Some(take) = &take {
                state.take_playback["decodedFrames"] = take.decoded.load(Ordering::Relaxed).into();
                state.take_playback["frameReady"] = take_frame_ready.into();
                state.take_playback["draws"] = serde_json::json!(take_draws);
                state.take_playback["generation"] = generation.into();
                if let Ok(error) = take.error.try_lock() {
                    state.take_playback["error"] = serde_json::json!(*error);
                }
            }
            state.take = native.shared.recorder.snapshot();
            if let Some(e) = &state.take.error {
                state.error = Some(e.clone());
            }
            state.native_status = std::array::from_fn(|i| native.shared.status([0, 1, 3, 8, 9][i]));
            if times_len > 0 {
                let mut sorted = frame_times[..times_len].to_vec();
                sorted.sort_by(f64::total_cmp);
                state.cpu_p99_ms = sorted[(sorted.len() * 99 / 100).min(sorted.len() - 1)];
            }
            if let Ok(mut dest) = stats.try_lock() {
                *dest = state.clone();
            }
            last_snapshot = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(5).saturating_sub(tick.elapsed()));
    }
    for (_, input) in inputs {
        let _ = retire_tx.send(input);
    }
    drop(retire_tx);
    if recording {
        native.stop_record();
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    while native.shared.recorder.snapshot().busy() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
fn active_source_time(
    sequence: &producer_production_core::compile::SequencePlan,
    source: &str,
    position: Time,
) -> Result<Option<f64>> {
    for player in sequence.players.iter().filter(|p| p.source == source) {
        let time = player.media_seconds(position).map_err(|_| {
            anyhow!("Source time mapping failed for {source}; not a disconnected source")
        })?;
        if time.is_some() {
            return Ok(time);
        }
    }
    Ok(None)
}

#[cfg(test)]
mod playback_tests {
    use super::*;

    #[test]
    fn native_republish_at_audio_sample_position_survives_nanosecond_clock() {
        let start = OutputInstant(Counter(0));
        let mut transport = Transport::new(model::time(30.).unwrap(), start)
            .unwrap()
            .with_host_timebase(48000)
            .unwrap();
        transport.seek(Time::new(1, 48000).unwrap(), start).unwrap();
        transport.play(start).unwrap();
        for ns in [1, 1001, 33333333, 987654321, 1_234_567_891] {
            let host = OutputInstant(Counter(ns));
            let at = transport.position(host).unwrap();
            transport.seek(at, host).unwrap();
            transport.pause("operator", host).unwrap();
            transport.resume("operator", host).unwrap();
            transport.play(host).unwrap();
        }
    }
    #[test]
    fn stale_terminal_progress_cannot_clear_a_new_recording_or_replace_its_head() {
        let mut current = crate::recording::Progress {
            session: 2,
            phase: "starting".into(),
            ..Default::default()
        };
        let mut recording = true;
        for phase in ["saved", "failed"] {
            merge_recording_progress(
                &mut current,
                &mut recording,
                &crate::recording::Progress {
                    session: 1,
                    phase: phase.into(),
                    ..Default::default()
                },
            );
            assert!(recording);
            assert_eq!(current.session, 2);
            assert_eq!(current.phase, "starting");
        }
        merge_recording_progress(
            &mut current,
            &mut recording,
            &crate::recording::Progress {
                session: 2,
                phase: "failed".into(),
                ..Default::default()
            },
        );
        assert!(!recording);
        assert_eq!(current.phase, "failed");
    }

    #[test]
    fn later_cut_resolves_its_source_time_without_holding_across_the_gap() {
        let mut room = RoomProject::demo();
        room.bind_take(
            &"a".repeat(64),
            producer_production_contract::Range {
                start: model::time(0.3).unwrap(),
                duration: model::time(10.).unwrap(),
            },
            Some((0., 1., 1.)),
        )
        .unwrap();
        let sequence = room.production.sequences.get_mut("main").unwrap();
        let mut cut = sequence.placements.last().unwrap().clone();
        cut.id = "take-cut-2".into();
        cut.range.start = Time::seconds(6);
        cut.source_in = Time::seconds(3);
        sequence.placements.push(cut);
        let plan = room.compile().unwrap();
        let sequence = &plan.sequences["main"];
        for (position, expected) in [
            (0., Some(1.)),
            (1., None),
            (5., None),
            (6.2, Some(3.2)),
            (7., None),
        ] {
            assert_eq!(
                active_source_time(sequence, "take", model::time(position).unwrap()).unwrap(),
                expected,
            );
        }
    }
}
