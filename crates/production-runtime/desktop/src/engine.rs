use crate::{
    assets,
    model::{self, CanvasView, RoomProject, SetLayoutPair},
    platform::{self, Frame, Movie, NativeRoom, ScreenCaptureTarget, Shared},
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
    P0StartCall,
    ForecastCity { slot: crate::weather::CitySlot, location: crate::weather::Connection },
    CameraBorderWave { enabled: bool },
    ForecastView { view: crate::weather::View },
    StageHistory {participant:Option<String>, before:Option<String>},
    RtcStart { #[serde(default,rename="displayName")] display_name:Option<String>, link: Option<String>, #[serde(default)] lan:bool, #[serde(default)] rehearsal:bool, #[serde(default)] output:Option<crate::model::CanvasView> },
    RtcAdmit,
    RtcAdmitBoomin { #[serde(rename="sessionId")] session_id:String, #[serde(rename="answerFingerprint")] answer_fingerprint:String, brand:String },
    RtcStage { enabled:bool },
    RtcGuestMute { session_id: String, muted: bool },
    RtcLink,
    RtcMedia {microphone:Option<bool>,camera:Option<bool>},
    RtcEnd,
    #[cfg(debug_assertions)]
    P0StallProgram,
    /// Select the monitor, never the recording bus.
    Monitor {
        preview: bool,
    },
    /// Explicitly put the editorial snapshot and its playhead on program.
    SendToOutput {
        #[serde(default, rename="operationId")]
        operation_id:Option<String>,
        #[serde(default, rename="expectedProgramRevision")]
        expected_program_revision:Option<u64>,
        #[serde(default, rename="permissionEpoch")]
        permission_epoch:Option<u64>,
    },
    OperationOutcome { #[serde(rename="operationId")] operation_id:String },
    RevokePermission { permission:String, #[serde(rename="permissionEpoch")] permission_epoch:u64, #[serde(default,rename="operationId")] operation_id:Option<String> },
    GrantPermission { permission:String, #[serde(rename="permissionEpoch")] permission_epoch:u64 },
    RunSegment { show: String, segment: String },
    ShowLayout { show: String, segment: String, layout: Option<SetLayoutPair> },
    SceneAdd,
    SceneRemove {
        id: String,
    },
    CameraGrade { source: String, grade: crate::model::CameraGrade },
    SourceRemove {
        source: String,
    },
    StopCamera,
    SceneSelect {
        id: String,
    },
    SetMotion { id: String, layout: SetLayoutPair, revision: u64, playing: bool },
    SetMount {
        id: Option<String>,
        #[serde(default)]
        layout: Option<SetLayoutPair>,
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
    ClipsStatus,
    StudioAudio { command: crate::studio_audio::Command },
    BroadcastStart, BroadcastStop, BroadcastStatus,
    ClipsConfigure { settings:crate::clips::Settings },
    ClipsEnable { enabled:bool },
    ClipsSave,
    ClipsRename { id:String, name:String },
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
    MarqueeReveal { id: String, revision: u64, text: String },
    Headline {
        id: String,
        revision: u64,
        text: Option<String>,
        size: Option<u16>,
        wrap: Option<crate::headline::Wrap>,
    },
    SetEditPreview {
        id: Option<String>,
        draft: Option<producer_production_contract::Set>,
        #[serde(default)]
        layout: Option<SetLayoutPair>,
    },
    SetEditSave {
        id: String,
        expected: producer_production_contract::Set,
        draft: producer_production_contract::Set,
        #[serde(default)]
        layout: Option<SetLayoutPair>,
    },
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
    ScreenCapture { target: ScreenCaptureTarget },
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
    pub camera_border_wave: bool,
    pub forecast_cities: [Option<String>; 2],
    pub forecast_view: Option<crate::weather::View>,
    pub cameras: serde_json::Value,
    pub microphones: serde_json::Value,
    pub input_status: std::collections::BTreeMap<String, InputStatus>,
    pub originals: Originals,
    pub producer_rtc: serde_json::Value,
    pub rtc_capacity: serde_json::Value,
    pub guest_audio_received: bool,
    pub guest_video_received: bool,
    pub take: crate::recording::Progress,
    pub take_playback: serde_json::Value,
    pub project: RoomProject,
    pub revision: u64,
    pub previewing: bool,
    pub program_position: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program_segment: Option<(String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program_layout: Option<SetLayoutPair>,
    pub program_playing: bool,
    pub set_motion_playing: bool,
    pub set_motion_position: f64,
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
    pub mixer_peaks: std::collections::BTreeMap<String, f32>,
    pub audio_frames: u64,
    pub audio_dropped: u64,
    pub audio_diagnostics: platform::AudioDiagnostics,
    pub native_status: [String; 5],
    pub assistant_context: serde_json::Value,
}
impl Snapshot {
    pub fn movie_loaded(&self) -> bool { self.movie_playback.loaded }
}
pub struct Handle {
    grades: crate::platform::GradeSlots,
    pub studio_audio: crate::studio_audio::Desk,
    pub waiting_guests: Mutex<Vec<crate::room_share::WaitingGuest>>,
    pub root:PathBuf,
    pub assistant_requests: Mutex<std::collections::VecDeque<(crate::ipc::AssistantRequest, SyncSender<serde_json::Value>, Instant)>>,
    pub ipo_line_chart: std::sync::atomic::AtomicBool,
    pub host_zoom: std::sync::atomic::AtomicU32,
    speaker_share: std::sync::atomic::AtomicU32,
    pub screen_zoom: std::sync::atomic::AtomicU32,
    screen_pan: AtomicU64,
    pub quiz_answer: std::sync::atomic::AtomicI32,
    camera_border_wave: AtomicBool,
    pub rtc_feed:Mutex<Option<crate::p0_call::Guest>>,
    pub pending_rtc_link:Mutex<Option<String>>,
    pub journal: crate::take_control::Journal,
    pub tx: SyncSender<Envelope>,
    pub snapshot: Arc<Mutex<Snapshot>>,
    pub media: Arc<Mutex<Option<Arc<Shared>>>>,
    pub set_edit_media: Arc<Mutex<Option<Arc<Shared>>>>,
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
        let broadcast=matches!(command,RoomCommand::BroadcastStart|RoomCommand::BroadcastStop);
        let private_edit=matches!(command,RoomCommand::SetEditPreview{..}|RoomCommand::SetEditSave{..});
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(Envelope {
                command,
                reply: Some(tx),
            })
            .map_err(|_| anyhow!("Room control queue busy"))?;
        if broadcast{return rx.recv().map_err(Into::into)}
        rx.recv_timeout(Duration::from_secs(if private_edit { 45 } else { 8 })).map_err(Into::into)
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn try_snapshot(&self) -> Option<Snapshot> {
        Some(self.snapshot.try_lock().ok()?.clone())
    }

    pub(crate) fn screen_pan(&self) -> [f32; 2] {
        let packed = self.screen_pan.load(Ordering::Relaxed);
        [f32::from_bits(packed as u32), f32::from_bits((packed >> 32) as u32)]
    }

    pub(crate) fn set_screen_pan(&self, [x, y]: [f32; 2]) {
        // Both axes reach the renderer in the same frame.
        let packed = u64::from(x.to_bits()) | (u64::from(y.to_bits()) << 32);
        self.screen_pan.store(packed, Ordering::Relaxed);
    }

    pub fn is_set_on_output(&self, id: &str, pair: &SetLayoutPair, set: &producer_production_contract::Set) -> bool {
        let program = self.program.lock().unwrap();
        program.scene == id && program.output_layout_pair() == *pair
            && program.production.sets.get(id) == Some(set)
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
    loaded: bool,
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
    set_motion_playing: bool,
    set_motion_position: f64,
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
    mixer_peaks: std::collections::BTreeMap<String, f32>,
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
        s.program_segment = s.project.playing_segment.clone().filter(|_| s.program_kind == "show");
        s.program_layout = s.program_segment.as_ref().and_then(|_| s.project.show_layout_at(self.position));
        s.program_playing = self.playing;
        s.set_motion_playing = self.set_motion_playing;
        s.set_motion_position = self.set_motion_position;
        s.render_frames = self.render_frames;
        s.refused_frames = self.refused_frames;
        s.cpu_p99_ms = self.cpu_p99_ms;
        s.movie_playback = self.movie_playback.clone();
        s.source_frames = self.source_frames;
        s.output_frames = self.output_frames;
        s.frame_age_ms = self.frame_age_ms;
        s.microphone_peak = self.microphone_peak;
        s.mixer_peaks.clone_from(&self.mixer_peaks);
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
// Only the on-air output graph can detach from the timeline. Live inputs and
// editorial transport retain their own clocks throughout a hold.
#[derive(Default)]
enum SetMotionClock {
    #[default]
    Timeline,
    Held(f64),
    Running { position: f64, started: f64 },
}

impl SetMotionClock {
    fn sample(&self, host: f64, timeline: f64, playing: bool) -> (f64, bool) {
        match *self {
            Self::Timeline => (timeline, playing),
            Self::Held(position) => (position, false),
            Self::Running { position, started } => (position + (host - started), true),
        }
    }

    fn set_playing(&mut self, playing: bool, host: f64, last_frame: f64, transport_playing: bool) {
        if self.sample(host, last_frame, transport_playing).1 != playing {
            *self = if playing {
                Self::Running { position: last_frame, started: host }
            } else {
                Self::Held(last_frame)
            };
        }
    }
}

// Both directions use the animated layout's graph. Retaining its visuals
// keeps the outgoing live source available until its final transition frame.
struct ReversibleLayout {
    visuals: Arc<crate::visuals::Visuals>,
    started: f64,
    duration: f64,
    initial: f32,
    reverse: bool,
}

impl ReversibleLayout {
    fn phase(&self, now: f64) -> f32 {
        let elapsed = ((now - self.started) / self.duration).max(0.) as f32;
        (self.initial + if self.reverse { -elapsed } else { elapsed }).clamp(0., 1.)
    }

    fn done(&self, phase: f32) -> bool {
        phase == if self.reverse { 0. } else { 1. }
    }

    fn between(
        old: &RoomProject, next: &RoomProject,
        old_visuals: &Arc<crate::visuals::Visuals>, next_visuals: &Arc<crate::visuals::Visuals>,
        prior: Option<&Self>, now: f64,
    ) -> Option<Self> {
        let set = next.production.sets.get(&next.scene)?;
        let before = old.output_layout_pair();
        let after = next.output_layout_pair();
        let matches = |animated: &SetLayoutPair, resting: &SetLayoutPair| {
            animated.ids().into_iter().zip(resting.ids()).all(|(a, b)| {
                set.reversible_layout_transitions.get(a).is_some_and(|target| target == b)
            })
        };
        let reverse = matches(&before, &after);
        if !reverse && !matches(&after, &before) {
            return None;
        }
        let visuals = if reverse { old_visuals } else { next_visuals };
        let initial = prior.filter(|p| p.reverse != reverse)
            .map_or(if reverse { 1. } else { 0. }, |p| p.phase(now));
        Some(Self { visuals: visuals.clone(), started: now,
            duration: f64::from(set.layout_transition_ms?)/1000., initial, reverse })
    }
}

enum RenderOp {
    SetMotion(bool),
    ReplaceVisuals(Arc<crate::visuals::Visuals>),
    P0Guest(crate::p0_call::Guest),
    DetachGuest,
    #[cfg(debug_assertions)]
    P0StallProgram,
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
    Layout {
        project: Arc<RoomProject>,
        plan: Arc<Plan>,
        visuals: Arc<crate::visuals::Visuals>,
        revision: u64,
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
    StopCamera,
    ScreenCapture(ScreenCaptureTarget),
    RemoveSource(String),
    CameraDevice(String),
    Input {
        source: String,
        endpoint: platform::CaptureInput,
    },
    MicrophoneDevice(String),
    Record(u64, producer_native_media::recording::RecordingHeader),
    StopRecord,
    StartBroadcast(u64,Vec<usize>), StopBroadcast,
    StartClips(u64,crate::clips::Settings),
    StopClips,
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
    prepared: Mutex<(Arc<RoomProject>,Arc<Plan>)>,
    tx: SyncSender<RenderEnvelope>,
    stats: Arc<Mutex<RenderStats>>,
}
impl Renderer {
    fn request(&self, op: RenderOp) -> Result<()> {
        let next = match &op {
            RenderOp::Layout { project, plan, .. } | RenderOp::Publish { project, plan, .. } | RenderOp::Adopt { project, plan, .. } | RenderOp::Take {project, plan, ..} => Some((project.clone(),plan.clone())),
            _ => None,
        };
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(RenderEnvelope { op, reply: tx })
            .map_err(|_| anyhow!("Render control busy"))?;
        rx.recv_timeout(Duration::from_secs(2))
            .context("Renderer acknowledgement timed out")?
            .map_err(|e| anyhow!(e))?;
        if let Some(next) = next { *self.prepared.lock().unwrap() = next; }
        Ok(())
    }
    fn switch_layout(
        &self, project: RoomProject, revision: u64, cache: &mut crate::visuals::VisualCache,
        root: &Path,
    ) -> Result<()> {
        let (previous, plan) = self.prepared.lock().unwrap().clone();
        // Compilation depends on the document, selected set, and both output sizes.
        // A staged document edit still takes the full validation and publish path.
        if previous.scene != project.scene || previous.production != project.production
            || previous.canvas.landscape != project.canvas.landscape
            || previous.canvas.vertical != project.canvas.vertical
        {
            return publish(self, root, project, 0., true, revision, cache);
        }
        let visuals = cache.prepare(&project, &plan)?;
        self.request(RenderOp::Layout { project: Arc::new(project), plan, visuals, revision })
    }

    fn warm_layouts(&self) -> std::thread::JoinHandle<crate::visuals::VisualCache> {
        let (project, plan) = self.prepared.lock().unwrap().clone();
        std::thread::spawn(move || {
            let mut cache = crate::visuals::VisualCache::default();
            if project.mounted_set.as_ref() == Some(&project.scene) {
                let current = project.output_layout_pair();
                for choice in project.set_layout_choices(&project.scene).into_iter()
                    .filter(|choice| choice.pair != current).take(2)
                {
                    let mut candidate = (*project).clone();
                    candidate.mounted_layout = Some(choice.pair);
                    let _ = cache.prepare(&candidate, &plan);
                }
            }
            cache
        })
    }
    fn refresh_fields(&self, cache: &mut crate::visuals::VisualCache) -> Result<()> {
        let (project,plan)=self.prepared.lock().unwrap().clone();
        let visuals=cache.prepare(&project,&plan)?;
        self.request(RenderOp::ReplaceVisuals(visuals))
    }
}
pub fn camera_border_wave(root: &Path) -> Result<bool> {
    match fs::read(root.join("atmosphere-camera-wave.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
pub(crate) fn initial_room(root: &Path) -> Result<(Arc<Handle>,Receiver<Envelope>,Arc<Plan>)> {
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
    let camera_border_wave = camera_border_wave(&root)?;
    let snapshot = Snapshot {
        camera_border_wave,
        forecast_cities: [crate::weather::CitySlot::Primary,crate::weather::CitySlot::Comparison].map(|slot|slot.location(&root).map(|c|c.city)),
        forecast_view: root.join("weather.json").is_file().then(|| crate::weather::selected_view(&root).unwrap_or_default()),
        producer_rtc: crate::producer_rtc::idle(),
        rtc_capacity: crate::producer_rtc::capacity(&root),
        guest_audio_received: false,
        guest_video_received: false,
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
        program_segment: None,
        program_layout: None,
        program_playing: true,
        set_motion_playing: true,
        set_motion_position: 0.,
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
        frame_age_ms: [-1.; 3],
        source_frames: [0; 3],
        output_frames: [0; 2],
        microphone_peak: 0.,
        mixer_peaks: Default::default(),
        audio_frames: 0,
        audio_dropped: 0,
        audio_diagnostics: platform::AudioDiagnostics::default(),
        native_status: std::array::from_fn(|_| String::new()),
    };
    let (tx, rx) = mpsc::sync_channel(16);
    let handle = Arc::new(Handle {
        grades: Arc::new(std::sync::RwLock::new(snapshot.project.grade_slots())),
        studio_audio: crate::studio_audio::Desk::open(root)?,
        waiting_guests: Mutex::default(),
        root:root.to_path_buf(),
        assistant_requests:Mutex::default(),
        ipo_line_chart: std::sync::atomic::AtomicBool::new(false),
        host_zoom: std::sync::atomic::AtomicU32::new(1.0f32.to_bits()),
        speaker_share: std::sync::atomic::AtomicU32::new(crate::speaker_split::CENTER.to_bits()),
        screen_zoom: std::sync::atomic::AtomicU32::new(1.0f32.to_bits()),
        screen_pan: AtomicU64::new(0),
        quiz_answer: std::sync::atomic::AtomicI32::new(0),
        camera_border_wave: AtomicBool::new(camera_border_wave),
        rtc_feed:Mutex::default(),
        pending_rtc_link:Mutex::default(),
        journal:crate::take_control::Journal::open(&root)?,
        tx,
        snapshot: Arc::new(Mutex::new(snapshot)),
        media: Arc::new(Mutex::new(None)),
        set_edit_media: Arc::new(Mutex::new(None)),
        preview_media: Arc::new(Mutex::new(None)),
        program: Arc::new(Mutex::new(program)),
        closed: Arc::new(AtomicBool::new(false)),
        done: Arc::new(AtomicBool::new(false)),
    });
    Ok((handle,rx,plan))
}
pub fn start(root: PathBuf) -> Result<Arc<Handle>> {
    let (handle,rx,plan)=initial_room(&root)?;
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
pub(crate) fn persist(root: &Path, p: &RoomProject) -> Result<()> {
    let pending = root.join("room.pending");
    let mut file = File::create(&pending)?;
    let mut bytes = serde_json::to_vec_pretty(p)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
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
    prepared_plan: &mut Option<Arc<Plan>>,
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
                state.project.restore_source_lane(&kind)?;
            }
            // Claim the existing default endpoint before admitting a second
            // capture of the same physical device.
            if !restoring && !state.project.inputs.contains_key(&kind)
                && state.project.lanes.iter().any(|lane| lane.source == kind) {
                if let Some(d) = devices
                    .as_array()
                    .and_then(|a| a.iter().find(|d| d["default"].as_bool() == Some(true)))
                {
                    if let (Some(id), Some(name)) = (d["id"].as_str(), d["name"].as_str()) {
                        state.project.configure_input_inner(&kind, &kind, id, name)?;
                    }
                }
            }
            let source = if restoring {
                state
                    .project
                    .configure_input_inner(&kind, &kind, &device, &label)?;
                kind.clone()
            } else if let Some(source) = source {
                state
                    .project
                    .configure_input_inner(&source, &kind, &device, &label)?;
                source
            } else {
                state.project.add_input_inner(&kind, &device, &label)?
            };
            // Validate before opening hardware; a rejected candidate opens nothing.
            *prepared_plan = Some(state.project.compile()?);
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
            if kind == "camera" { state.cameras = devices; } else { state.microphones = devices; }
            changed = true;
        }
        RoomCommand::CameraGrade { source, grade } => {
            state.project.validate_grade(&source, grade)?;
            changed = state.project.camera_grades.get(&source).copied().unwrap_or_default() != grade;
            if grade == Default::default() { state.project.camera_grades.remove(&source); }
            else { state.project.camera_grades.insert(source, grade); }
        }
        RoomCommand::SourceRemove { source } => {
            if state.recording || state.take.busy() {
                bail!("Stop and finalize recording before removing a source");
            }
            *prepared_plan = Some(state.project.remove_source(&source)?);

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
        RoomCommand::RtcStart{..}|RoomCommand::RtcAdmit|RoomCommand::RtcAdmitBoomin{..}|RoomCommand::RtcStage{..}|RoomCommand::RtcGuestMute{..}|RoomCommand::RtcLink|RoomCommand::RtcMedia{..}|RoomCommand::RtcEnd|RoomCommand::StageHistory{..}|RoomCommand::P0StartCall => unreachable!("probe command handled on control lane"),
        RoomCommand::ForecastCity { slot, location } => {
            crate::weather::set_city(root, slot, &location)?;
            state.forecast_cities[slot as usize] = Some(location.city);
        }
        RoomCommand::CameraBorderWave { enabled } => {
            let pending = root.join("atmosphere-camera-wave.pending");
            fs::write(&pending, serde_json::to_vec(&enabled)?)?;
            fs::rename(pending, root.join("atmosphere-camera-wave.json"))?;
            handle.camera_border_wave.store(enabled, Ordering::Relaxed);
            state.camera_border_wave = enabled;
        }
        RoomCommand::ForecastView { view } => {
            crate::weather::select(root, view)?;
            state.forecast_view = Some(view);
        }
        RoomCommand::State => {}
        #[cfg(debug_assertions)]
        RoomCommand::P0StallProgram => { render.request(RenderOp::P0StallProgram)?; }
        RoomCommand::ClearError => {
            state.error = None;
        }
        RoomCommand::Monitor { .. }
        | RoomCommand::MarqueeReveal { .. } | RoomCommand::Headline { .. }
        | RoomCommand::SetEditPreview { .. } | RoomCommand::SetEditSave { .. }
        | RoomCommand::OperationOutcome { .. } | RoomCommand::RevokePermission { .. } | RoomCommand::GrantPermission { .. }
        | RoomCommand::SendToOutput { .. }
        | RoomCommand::SceneRemove { .. }
        | RoomCommand::SceneAdd
        | RoomCommand::SceneSelect { .. }
        | RoomCommand::SetMount { .. }
        | RoomCommand::SetMotion { .. }
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
        RoomCommand::ScreenCapture { target } => {
            if !matches!(target, ScreenCaptureTarget::Stop)
                && !state.project.lanes.iter().any(|l| l.source == "screen")
            {
                state.project.restore_source("screen")?;
                changed = true;
            }
            render.request(RenderOp::ScreenCapture(target))?;
        }
        RoomCommand::StopCamera => render.request(RenderOp::StopCamera)?,
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
        RoomCommand::StudioAudio { .. } | RoomCommand::BroadcastStart | RoomCommand::BroadcastStop | RoomCommand::BroadcastStatus | RoomCommand::ClipsStatus | RoomCommand::ClipsConfigure{..} |
        RoomCommand::ClipsEnable{..} | RoomCommand::ClipsSave | RoomCommand::ClipsRename{..} => unreachable!("Handled on control worker"),
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
    renderer.request(prepare_publish(root,project,position,playing,revision,cache)?)
}
fn prepare_publish(root:&Path,project:RoomProject,position:f64,playing:bool,revision:u64,cache:&mut crate::visuals::VisualCache)->Result<RenderOp>{
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
    Ok(RenderOp::Publish {
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
        let mut cache = crate::visuals::VisualCache::default();
        *slot = Some(start_preview_worker(handle, state.project.clone(), handle.preview_media.clone())?);
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

fn start_preview_worker(
    handle: &Arc<Handle>,
    project: RoomProject,
    output: Arc<Mutex<Option<Arc<Shared>>>>,
) -> Result<PreviewRuntime> {
    let plan = project.compile()?;
    let visuals = crate::visuals::VisualCache::default().prepare(&project, &plan)?;
    start_prepared_preview(handle, Arc::new(project), plan, visuals, output)
}

fn start_prepared_preview(handle: &Arc<Handle>, project: Arc<RoomProject>, plan: Arc<Plan>,
    visuals: Arc<crate::visuals::Visuals>, output: Arc<Mutex<Option<Arc<Shared>>>>) -> Result<PreviewRuntime> {
    let (tx, rx) = mpsc::sync_channel(16);
    let stats = Arc::new(Mutex::new(RenderStats::default()));
    let worker_stats = stats.clone();
    let handle = handle.clone();
    let prepared=Mutex::new((project.clone(),plan.clone()));
    let worker = std::thread::Builder::new().name("producer-preview".into()).spawn(move || {
        if let Err(error) = render_loop(handle, rx, project, plan, worker_stats.clone(), visuals, Some(output)) {
            worker_stats.lock().unwrap().error = Some(format!("Preview: {error:#}"));
        }
    })?;
    Ok(PreviewRuntime {render: Renderer {tx, stats, prepared}, worker})
}

pub type SetSlotBounds = std::collections::BTreeMap<String, std::collections::BTreeMap<String, producer_production_contract::Rect>>;

fn editor_slot_bounds(project: &RoomProject, plan: &Plan, id: &str) -> SetSlotBounds {
    let prefix = format!("sets/{id}/layouts/");
    let mut slots = SetSlotBounds::new();
    for node in plan.nodes.iter().filter(|node| node.source.is_some()) {
        if let Some((layout, path)) = node.path.strip_prefix(&prefix).and_then(|path| path.split_once('/')) {
            let set = &project.production.sets[id];
            let fit = project.canvas.transform(set, &set.layouts[layout]);
            slots.entry(layout.to_owned()).or_default().insert(path.to_owned(), fit.rect(node.frame));
        }
    }
    slots
}

pub(crate) fn set_edit_project(project: &RoomProject, id: &str, draft: &producer_production_contract::Set) -> Result<RoomProject> {
    let mut next = project.clone();
    use producer_production_contract::{Content, Node, Role, Source};
    fn references_guest(node: &Node) -> bool {
        matches!(&node.content, Content::Source { source, .. } if source == "rtc-guest")
            || node.children.iter().any(references_guest)
    }
    let mut operations = Vec::new();
    let guest_graph = draft.graphs.values().flat_map(|g| &g.passes).any(|pass| {
        pass.inputs().iter().any(|i| matches!(i,producer_production_contract::GraphInput::Source{id} if id=="rtc-guest"))
    });
    if guest_graph || draft.layouts.values().any(|layout| references_guest(&layout.root)) {
        match next.production.sources.get("rtc-guest") {
            None => operations.push(commands::Operation::AddSource {
                id: "rtc-guest".into(), value: Source::Live { role: Role::Guest },
            }),
            Some(Source::Live { role: Role::Guest }) => {}
            Some(_) => bail!("The rtc-guest source name is already in use"),
        }
    }
    operations.push(commands::Operation::ReplaceSet { id: id.into(), value: draft.clone() });
    next.command(commands::Command::Transaction { operations })?;
    crate::render_graph::inspect(draft)?;
    Ok(next)
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
    let prepared=Mutex::new((project.clone(),plan.clone()));
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
                None,
            ) {
                worker_stats.lock().unwrap().error = Some(format!("Render/audio: {e:#}"));
                worker_handle.closed.store(true, Ordering::Release);
            }
        })?;
    let render = Renderer { tx, stats, prepared };
    let mut warmed_set = None;
    let mut warmer: Option<std::thread::JoinHandle<crate::visuals::VisualCache>> = None;
    let mut history=crate::stage_history::History::open(&root)?;
    let mut rtc_staged=false;
    let mut peer:Option<crate::producer_rtc::Peer>=None;
    let mut observed_guest = None;
    let mut p0 = crate::p0_call::Probe::default();
    let mut preview: Option<PreviewRuntime> = None;
    let mut set_edit: Option<PreviewRuntime> = None;
    let mut set_edit_cache = crate::visuals::VisualCache::default();
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
    let watch_weather=root.join("weather.json").is_file();
    if watch_weather { crate::weather::start(root.clone(),handle.closed.clone())?; }
    let mut last_fields=Default::default();
    let mut field_check=Instant::now();
    let mut preview_field_cache=crate::visuals::VisualCache::default();
    let mut broadcast_poll=Instant::now();
    while !handle.closed.load(Ordering::Acquire) {
        if broadcast_poll.elapsed()>=Duration::from_millis(250){broadcast_poll=Instant::now();let media=handle.media.lock().unwrap().clone();if let Some(m)=media{m.broadcast.poll();}}
        if watch_weather && field_check.elapsed()>=Duration::from_millis(300) {
            field_check=Instant::now();
            let result=(|| -> Result<()> {
                let fields=crate::weather::fields(&root)?;
                if fields!=last_fields {
                    render.refresh_fields(&mut visual_cache)?;
                    if let Some(p)=&preview {p.render.refresh_fields(&mut preview_field_cache)?;}
                    if let Some(p)=&set_edit {p.render.refresh_fields(&mut set_edit_cache)?;}
                    last_fields=fields;
                }
                Ok(())
            })();
            if let Err(e)=result {state.error=Some(format!("Room data: {e}"));}
        }
        let observed=peer.as_mut().map(|p|p.status()).unwrap_or_default();
        if rtc_staged && observed["phase"]!="connected" {
            render.request(RenderOp::DetachGuest)?;rtc_staged=false;
            if let Some(p)=peer.as_ref(){let _=p.tally(false);}
        }
        let live=handle.program.lock().unwrap().clone();
        history.observe(&observed,rtc_staged,&live,state.program_revision)?;
        let incoming = rx.recv_timeout(Duration::from_millis(50));
        if warmer.as_ref().is_some_and(|worker| worker.is_finished()) {
            if let Ok(cache) = warmer.take().unwrap().join() {
                if warmed_set.as_ref() == Some(&live.scene) { visual_cache.merge_warmed(cache); }
            }
        }
        if warmer.is_none() && matches!(incoming, Err(mpsc::RecvTimeoutError::Timeout))
            && state.program_kind == "set" && warmed_set.as_ref() != Some(&live.scene)
        {
            warmer = Some(render.warm_layouts());
            warmed_set = Some(live.scene.clone());
        }
        if let Ok(envelope) = incoming {
            if let RoomCommand::StageHistory{participant,before}=&envelope.command {
                let reply=history.list(participant.as_deref(),before.as_deref()).unwrap_or_else(|e|serde_json::json!({"ok":false,"error":e.to_string()}));
                if let Some(tx)=envelope.reply{let _=tx.try_send(reply);}continue;
            }
            if matches!(&envelope.command, RoomCommand::SetEditPreview { .. } | RoomCommand::SetEditSave { .. }) {
                let result = (|| -> Result<SetSlotBounds> {
                    let mut slots = SetSlotBounds::new();
                    match &envelope.command {
                        RoomCommand::SetEditPreview { id: Some(id), draft: Some(draft), layout } => {
                            let mut next = set_edit_project(&state.project, id, draft)?;
                            next.mount_set(Some(id.clone()), layout.clone())?;
                            let next = next.live_set()?;
                            let prepared = prepare_publish(&root, next, 0., true, state.revision, &mut set_edit_cache)?;
                            if let RenderOp::Publish { project, plan, visuals, .. } = &prepared {
                                slots = editor_slot_bounds(project, plan, id);
                                if set_edit.is_none() {set_edit=Some(start_prepared_preview(&handle,project.clone(),plan.clone(),visuals.clone(),handle.set_edit_media.clone())?);}
                            }
                            let preview = &set_edit.as_ref().unwrap().render;
                            preview.request(prepared)?;
                            preview.request(RenderOp::Monitor(true))?;
                        }
                        RoomCommand::SetEditPreview { id: None, draft: None, layout: None } => {
                            if let Some(preview) = &set_edit {
                                preview.render.request(RenderOp::Monitor(false))?;
                            }
                        }
                        RoomCommand::SetEditSave { id, expected, draft, layout } => {
                            if state.project.production.sets.get(id) != Some(expected) {
                                bail!("This set changed while you were editing. Reopen it to use the current version.");
                            }
                            let next = set_edit_project(&state.project, id, draft)?;
                            let mut live = next.clone();
                            live.mount_set(Some(id.clone()), layout.clone())?;
                            let live = live.live_set()?;
                            let plan = live.compile()?;
                            set_edit_cache.prepare(&live, &plan)?;
                            persist(&root, &next)?;
                            state.project = next;
                            state.revision += 1;
                            state.assistant_context = state.project.assistant_context();
                            *handle.snapshot.lock().unwrap() = state.clone();
                        }
                        _ => bail!("Choose a set and its draft"),
                    }
                    Ok(slots)
                })();
                if let Some(tx) = envelope.reply {
                    let _ = tx.try_send(match result {
                        Ok(slots) => serde_json::json!({"ok": true, "programRevision": state.program_revision, "slots": slots}),
                        Err(e) => serde_json::json!({"ok": false, "error": e.to_string()}),
                    });
                }
                continue;
            }
            if matches!(&envelope.command, RoomCommand::RtcStart{..}|RoomCommand::RtcAdmit|RoomCommand::RtcAdmitBoomin{..}|RoomCommand::RtcStage{..}|RoomCommand::RtcGuestMute{..}|RoomCommand::RtcLink|RoomCommand::RtcMedia{..}|RoomCommand::RtcEnd) {
                let result=(|| -> Result<serde_json::Value> {
                    match &envelope.command {
                        RoomCommand::RtcStart{link,lan,rehearsal,display_name,output}=>{
                            if peer.is_some() || observed_guest.is_some() {bail!("End the current guest session first");}
                            let start_muted=link.is_none() && (state.project.lanes.iter().find(|l|l.source=="microphone").is_none_or(|l| l.muted) || (!*rehearsal && state.audio_frames==0));
                            let view = state.project.canvas.view;
                            let portrait = match view {
                                crate::model::CanvasView::Vertical => true,
                                crate::model::CanvasView::Landscape => false,
                                crate::model::CanvasView::Both => *output == Some(crate::model::CanvasView::Vertical),
                            };
                            let (session,guest)=crate::producer_rtc::Peer::start(&root,link.as_deref(),*lan,*rehearsal,start_muted,display_name.as_deref(),handle.media.clone(),portrait)?;
                            *handle.rtc_feed.lock().unwrap()=Some(guest.clone());
                            observed_guest=Some(guest);peer=Some(session);
                        }
                        RoomCommand::RtcLink=>return Ok(serde_json::json!({"ok":true,"link":peer.as_ref().context("No direct call")?.link()?})),
                        RoomCommand::RtcAdmit=>peer.as_mut().context("No direct call")?.admit(None)?,
                        RoomCommand::RtcAdmitBoomin{session_id,answer_fingerprint,brand}=>peer.as_mut().context("No direct call")?.admit(Some((session_id,answer_fingerprint,brand)))?,
                        RoomCommand::RtcGuestMute{session_id,muted}=>{
                            let session=peer.as_mut().context("No direct call")?;
                            let status=session.status();
                            if status["role"]!="host" || status["phase"]!="connected" || status["sessionId"].as_str()!=Some(session_id.as_str()) {
                                bail!("A matching connected host session is required");
                            }
                            session.mute_guest(*muted)?;
                        }
                        RoomCommand::RtcStage{enabled}=>{
                            let session=peer.as_mut().context("No direct call")?;
                            let status=session.status();
                            if status["role"]!="host"{bail!("Only the host can change stage membership");}
                            if status["phase"]!="connected"{bail!("A connected guest is required");}
                            if *enabled!=rtc_staged {
                                if *enabled {render.request(RenderOp::P0Guest(observed_guest.clone().context("No guest input")?))?;}
                                else {render.request(RenderOp::DetachGuest)?;}
                                rtc_staged=*enabled;
                                history.observe(&status,*enabled,&live,state.program_revision)?;
                                session.tally(*enabled)?;
                            }
                        }
                        RoomCommand::RtcMedia{microphone,camera}=>peer.as_ref().context("No direct call")?.set_media(*microphone,*camera)?,
                        RoomCommand::RtcEnd=>{if peer.is_some(){if rtc_staged {render.request(RenderOp::DetachGuest)?;}rtc_staged=false;history.finish("leftRoom")?;peer=None;observed_guest=None;*handle.rtc_feed.lock().unwrap()=None;}}
                        _=>unreachable!(),
                    }
                    Ok(serde_json::json!({"ok":true}))
                })();
                let reply = result.unwrap_or_else(|error| {
                    let message = error.to_string();
                    if envelope.reply.is_none() {
                        state.error = Some(message.clone());
                    }
                    serde_json::json!({"ok": false, "error": message})
                });
                state.producer_rtc=peer.as_mut().map(|p|p.status()).unwrap_or_else(crate::producer_rtc::idle);
        state.producer_rtc["onStage"]=serde_json::json!(rtc_staged);
        if observed["sessionId"]==state.producer_rtc["sessionId"] && state.producer_rtc["role"]=="host" {state.producer_rtc["stageTimeMs"]=history.elapsed_ms().into();}
                *handle.snapshot.lock().unwrap()=state.clone();
                if let Some(tx)=envelope.reply{let _=tx.try_send(reply);}
                continue;
            }
            if matches!(envelope.command, RoomCommand::P0StartCall) {
                if peer.is_some(){if let Some(tx)=envelope.reply{let _=tx.try_send(serde_json::json!({"ok":false,"error":"End the direct call first"}));}continue;}
                let reply = match p0.start(&root) {
                    Ok((pid,_guest)) if root.join("p0-sdk-only").is_file() => serde_json::json!({"ok":true,"hostPid":pid}),
                    Ok((pid,guest)) => match render.request(RenderOp::P0Guest(guest.clone())) {
                        Ok(()) => { observed_guest = Some(guest); serde_json::json!({"ok":true,"hostPid":pid}) },
                        Err(e) => serde_json::json!({"ok":false,"error":e.to_string()}),
                    },
                    Err(e) => serde_json::json!({"ok":false,"error":e.to_string()}),
                };
                if let Some(tx) = envelope.reply { let _ = tx.try_send(reply); }
                continue;
            }
            if let RoomCommand::SendToOutput { operation_id,expected_program_revision,permission_epoch } = &envelope.command {
                if operation_id.is_some() || expected_program_revision.is_some() || permission_epoch.is_some() {
                    let result=(|| -> Result<_> {
                        let key=crate::take_control::Key{
                            operation_id:operation_id.clone().context("Missing operationId")?,
                            expected_program_revision:expected_program_revision.context("Missing expectedProgramRevision")?,
                            permission_epoch:permission_epoch.context("Missing permissionEpoch")?,
                        };
                        let revision=state.program_revision;
                        let receipt=handle.journal.execute(&key,revision,||{
                            let prepared=prepare_publish(&root,state.project.clone(),state.position,state.playing,revision.checked_add(1).context("Program revision exhausted")?,&mut visual_cache)?;
                            #[cfg(debug_assertions)]
                            if root.join("p0-hold-take-prep").is_file(){
                                let start=Instant::now();
                                while root.join("p0-hold-take-prep").is_file() && start.elapsed()<Duration::from_secs(4){std::thread::sleep(Duration::from_millis(5));}
                            }
                            Ok(prepared)
                        },|prepared,next|{
                            render.request(prepared)?;
                            state.program_kind="timeline".into();state.program_revision=next;state.previewing=false;
                            Ok(())
                        })?;
                        if receipt.status=="applied" && state.program_revision!=revision {
                            if let Some(p)=&preview {let _=p.render.request(RenderOp::Monitor(false));}
                            state.assistant_context=state.project.assistant_context();
                            *handle.snapshot.lock().unwrap()=state.clone();
                        }
                        Ok(serde_json::json!({"ok":receipt.status=="applied","outcome":receipt}))
                    })().unwrap_or_else(|e|serde_json::json!({"ok":false,"error":e.to_string()}));
                    if let Some(tx)=envelope.reply {let _=tx.try_send(result);}continue;
                }
            }
            if let Ok(stats) = render.stats.try_lock() {
                stats.merge(&mut state);
            }
            if matches!(
                &envelope.command,
                RoomCommand::Monitor { .. }
                    | RoomCommand::SetMotion { .. }
                    | RoomCommand::Play
                    | RoomCommand::Pause
                    | RoomCommand::Seek { .. }
                    | RoomCommand::SendToOutput { .. }
                    | RoomCommand::SceneRemove { .. }
                    | RoomCommand::SceneAdd
                    | RoomCommand::SceneSelect { .. }
                    | RoomCommand::MarqueeReveal { .. }
                    | RoomCommand::Headline { .. }
                    | RoomCommand::SetMount { .. }
            ) {
                let result = (|| -> Result<()> {
                    match &envelope.command {
                        RoomCommand::SetMotion { id, layout, revision, playing } => {
                            let program = handle.program.lock().unwrap().clone();
                            if *revision != state.program_revision || program.scene != *id
                                || program.output_layout_pair() != *layout
                                || !program.production.sets.get(id).is_some_and(|set| layout.has_flythrough(set))
                            {
                                bail!("This flythrough is no longer on output");
                            }
                            render.request(RenderOp::SetMotion(*playing))?;
                            state.set_motion_playing = *playing;
                        }
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
                        RoomCommand::Headline { id, revision, text, size, wrap } => {
                            if *revision != state.program_revision || state.program_kind != "set"
                                || state.project.mounted_set.as_ref() != Some(id)
                            {
                                bail!("The selected Set is no longer on output");
                            }
                            let mut next = state.project.clone();
                            let pair = next.output_layout_pair();
                            let set = next.production.sets.get_mut(id).context("Missing Set")?;
                            anyhow::ensure!(
                                pair.ids().iter().any(|layout| crate::headline::supports(set, layout)),
                                "This layout has no headline"
                            );
                            crate::headline::apply(set, text.as_deref(), *size, *wrap)?;
                            let program = next.live_set()?;
                            let plan = program.compile()?;
                            let visuals = visual_cache.prepare(&program, &plan)?;
                            let revision = state.program_revision + 1;
                            render.request(RenderOp::Layout { project: Arc::new(program),
                                plan, visuals, revision })?;
                            state.project = next;
                            state.revision += 1;
                            state.program_revision = revision;
                            persist(&root, &state.project)?;
                        }
                        RoomCommand::ShowLayout { show, segment, layout } => {
                            anyhow::ensure!(state.program_kind == "show"
                                && state.project.playing_segment.as_ref() == Some(&(show.clone(), segment.clone())),
                                "The selected segment is no longer on output");
                            let mut next = state.project.clone();
                            let set = &next.production.sets[&next.scene];
                            anyhow::ensure!(layout.as_ref().is_none_or(|pair| pair.exists_in(set)),
                                "Unknown shot for this set");
                            next.shot_override = layout.clone();
                            let revision = state.program_revision + 1;
                            render.switch_layout(next.live_set()?, revision, &mut visual_cache, &root)?;
                            state.project = next;
                            state.program_revision = revision;
                        }
                        RoomCommand::RunSegment { .. }
                        | RoomCommand::MarqueeReveal { .. }
                        | RoomCommand::SetMount { .. }
                        | RoomCommand::SceneSelect { .. }
                        | RoomCommand::SceneRemove { .. } => {
                            let mut next = state.project.clone();
                            match &envelope.command {
                                RoomCommand::MarqueeReveal {id, revision, text} => {
                                    if *revision != state.program_revision || state.program_kind!="set" || next.mounted_set.as_ref()!=Some(id) {
                                        bail!("The selected set is no longer on output");
                                    }
                                    let set=next.production.sets.get_mut(id).context("Missing set")?;
                                    crate::marquee::apply(set,text)?;
                                }
                                RoomCommand::RunSegment { show, segment } => next.enter_segment(show, segment)?,
                                RoomCommand::SetMount { id, layout } => {
                                    next.mount_set(id.clone(), layout.clone())?;
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
                            let revision = state.program_revision + 1;
                            if state.program_kind == "set" && has_set
                                && matches!(envelope.command, RoomCommand::SetMount { .. })
                                && state.project.mounted_set == next.mounted_set
                                && state.project.mounted_layout != next.mounted_layout
                            {
                                render.switch_layout(live, revision, &mut visual_cache, &root)?;
                            } else {
                                publish(&render, &root, live, 0., true, revision, &mut visual_cache)?;
                            }
                            state.project = next;
                            state.program_kind = if state.project.playing_segment.is_some() { "show" } else if has_set { "set" } else { "room" }.into();
                            state.program_revision += 1;
                            state.previewing = false;
                            if let Some(p) = &preview {
                                p.render.request(RenderOp::Monitor(false))?;
                            }
                            // Publish the accepted cut to the UI immediately. The control
                            // worker still orders disk commits and durable CLI replies.
                            if matches!(envelope.command, RoomCommand::SetMount { .. }) {
                                state.error = None;
                                state.assistant_context = state.project.assistant_context();
                                *handle.snapshot.lock().unwrap() = state.clone();
                            }
                            persist(&root, &state.project)?;
                        }
                        RoomCommand::SendToOutput { .. } => {
                            handle.journal.legacy(||publish(
                                &render,
                                &root,
                                state.project.clone(),
                                state.position,
                                state.playing,
                                state.program_revision + 1,
                                &mut visual_cache,
                            ))?;
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
                state.error = result.err().map(|err| err.to_string());
                *handle.snapshot.lock().unwrap() = state.clone();
                if let Some(tx) = envelope.reply {
                    let reply = match &state.error {
                        Some(error) => serde_json::json!({"ok":false,"error":error}),
                        None => serde_json::json!({"ok":true,"state":state}),
                    };
                    let _ = tx.try_send(reply);
                }
                continue;
            }
            if matches!(envelope.command,RoomCommand::BroadcastStart|RoomCommand::BroadcastStop|RoomCommand::BroadcastStatus){
                let result=(||->Result<_>{
                    let media=handle.media.lock().unwrap().clone().context("Program renderer is starting")?;
                    match envelope.command {
                        RoomCommand::BroadcastStart=>{
                            anyhow::ensure!(state.producer_rtc["role"]!="guest","Only the host can start streaming");
                            let (epoch,outputs)=media.broadcast.begin(&crate::workspace_root(),&root)?;
                            if let Err(e)=render.request(RenderOp::StartBroadcast(epoch,outputs)){
                                media.broadcast.end(Some(e.to_string()));return Err(e);
                            }
                        }
                        RoomCommand::BroadcastStop=>{render.request(RenderOp::StopBroadcast)?;media.broadcast.finish();}
                        _=>{}
                    }
                    Ok(serde_json::json!({"ok":true,"broadcast":media.broadcast.status()}))
                })();
                let reply=result.unwrap_or_else(|e|{state.error=Some(e.to_string());serde_json::json!({"ok":false,"error":e.to_string()})});
                if let Some(tx)=envelope.reply{let _=tx.try_send(reply);}
                continue;
            }
            if let RoomCommand::StudioAudio { command } = &envelope.command {
                let result=handle.studio_audio.execute(command.clone());
                if let Some(tx)=envelope.reply {
                    let _=tx.try_send(result.unwrap_or_else(|error|serde_json::json!({"ok":false,"error":error.to_string()})));
                }
                continue;
            }
            if matches!(envelope.command,RoomCommand::ClipsStatus|RoomCommand::ClipsConfigure{..}|RoomCommand::ClipsEnable{..}|RoomCommand::ClipsSave|RoomCommand::ClipsRename{..}){
                let result=(||->Result<_>{
                    let media=handle.media.lock().unwrap().clone().context("Native media is starting")?;
                    let clips=&media.clips;
                    match envelope.command{
                        RoomCommand::ClipsConfigure{settings}=>clips.configure(settings)?,
                        RoomCommand::ClipsEnable{enabled:true}=>{
                            let (session,settings)=clips.begin()?;
                            if let Err(err)=render.request(RenderOp::StartClips(session,settings)){clips.end(Some(err.to_string()));return Err(err);}
                        }
                        RoomCommand::ClipsEnable{enabled:false}=>{render.request(RenderOp::StopClips)?;clips.end(None);}
                        RoomCommand::ClipsSave=>clips.save()?,
                        RoomCommand::ClipsRename{id,name}=>clips.rename(id.parse()?,name)?,
                        _=>{}
                    }
                    Ok(serde_json::json!({"ok":true,"clips":clips.status()}))
                })();
                let reply=result.unwrap_or_else(|e|serde_json::json!({"ok":false,"error":e.to_string()}));
                if let Some(tx)=envelope.reply{let _=tx.try_send(reply);}
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
            let rtc_mic = match &envelope.command {
                RoomCommand::Gain{source, muted, ..} if source=="microphone" => Some(!*muted),
                RoomCommand::Capture{mic:true,..} => Some(state.project.lanes.iter().find(|l|l.source=="microphone").is_some_and(|l|!l.muted)),
                RoomCommand::SourceRemove{source} if source=="microphone" => Some(false),
                _ => None,
            };
            let grade_only = matches!(&envelope.command, RoomCommand::CameraGrade { .. });
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
                RoomCommand::ScreenCapture { target } => !matches!(target, ScreenCaptureTarget::Stop)
                    && !state.project.lanes.iter().any(|l| l.source == "screen"),
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
            let mut prepared_plan = None;
            let result = if matches!(&envelope.command,RoomCommand::CanvasSize{..})
                && handle.media.lock().unwrap().as_ref().is_some_and(|media|media.clips.enabled() || media.broadcast.active()){
                Err(anyhow!("Stop streaming and rolling capture before changing output dimensions"))
            } else if input_or_size && state.program_kind == "timeline" {
                Err(anyhow!("Return to a live Set before changing output dimensions or device bindings"))
            } else { apply(
                &mut state,
                envelope.command,
                &root,
                &render,
                &handle,
                &importing,
                &mut prepared_plan,
            ) }
            .and_then(|changed| {
                if changed && grade_only {
                    persist(&root, &state.project)?;
                } else if changed && gain_only {
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
                    use crate::workspace::PanelId;
                    if before.workspace.visible(PanelId::Timeline)
                        && !state.project.workspace.visible(PanelId::Timeline)
                        && state.previewing
                    {
                        state.previewing = false;
                        if let Some(p) = &preview {
                            let _ = p.render.request(RenderOp::Monitor(false));
                        }
                    }
                } else if changed {
                    let next = match prepared_plan { Some(plan) => plan, None => state.project.compile()? };
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
            let result=result.and_then(|()|{
                if grade_only || input_or_size {
                    *handle.grades.write().unwrap() = state.project.grade_slots();
                }
                if let (Some(enabled),Some(session))=(rtc_mic,peer.as_ref()){
                    if state.producer_rtc["role"]=="host"{session.set_media(Some(enabled),None)?;}
                }
                Ok(())
            });
            let reply = match result {
                Ok(()) => {
                    if !read_only {
                        state.error = None;
                    }
                    if envelope.reply.is_some() { serde_json::json!({"ok":true,"state":state}) } else { serde_json::Value::Null }
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
        state.producer_rtc=peer.as_mut().map(|p|p.status()).unwrap_or_else(crate::producer_rtc::idle);
        state.producer_rtc["onStage"]=serde_json::json!(rtc_staged);
        if observed["sessionId"]==state.producer_rtc["sessionId"] && state.producer_rtc["role"]=="host" {state.producer_rtc["stageTimeMs"]=history.elapsed_ms().into();}
        if peer.is_some() {if let Some(guest)=&observed_guest {state.producer_rtc["programAudio"]=guest.program_audio_vitals();}}
        (state.guest_audio_received, state.guest_video_received) = observed_guest.as_ref().map(|g| g.recent_media()).unwrap_or_default();
        state.assistant_context["monitor"] = serde_json::json!({"previewing":state.previewing,"programKind":state.program_kind,"programRevision":state.program_revision,"commands":["monitor","sendToOutput","setMount","runSegment"],"policy":"Timeline play/seek/edit are preview-only. Only sendToOutput or setMount changes program. Recording always reads program."});
        *handle.snapshot.lock().unwrap() = state.clone();
    }
    // A window can close immediately after a dock edit. Save accepted workspace
    // commands even if shutdown won the race with the next control-loop tick.
    let mut layout_changed = false;
    for envelope in rx.try_iter() {
        if matches!(&envelope.command, RoomCommand::Workspace { .. }
            | RoomCommand::Panel { .. } | RoomCommand::TimelineDock { .. })
        {
            match apply(&mut state, envelope.command, &root, &render, &handle, &importing, &mut None) {
                Ok(changed) => layout_changed |= changed,
                Err(error) => eprintln!("Workspace command at shutdown failed: {error:#}"),
            }
        }
    }
    if layout_changed {
        persist(&root, &state.project)?;
    }
    if let Some(warmer) = warmer { let _ = warmer.join(); }
    history.finish("roomClosed")?;
    if let Some(p) = preview {
        let _ = p.worker.join();
    }
    if let Some(preview) = set_edit {
        let _ = preview.worker.join();
    }
    let _ = worker.join();
    if let Some(media)=handle.media.lock().unwrap().as_ref(){media.broadcast.end(None);}
    persist(&root, &state.project)?;
    Ok(())
}
fn mix_metered_channel(program: &mut [f32], input: &[f32], gain: f32, peak: &mut f32) {
    for (output, &sample) in program.iter_mut().zip(input) {
        *peak = peak.max(sample.abs());
        *output = (*output + sample * gain).clamp(-1., 1.);
    }
}

fn render_loop(
    handle: Arc<Handle>,
    rx: Receiver<RenderEnvelope>,
    mut project: Arc<RoomProject>,
    mut plan: Arc<Plan>,
    stats: Arc<Mutex<RenderStats>>,
    mut visuals: Arc<crate::visuals::Visuals>,
    preview_output: Option<Arc<Mutex<Option<Arc<Shared>>>>>,
) -> Result<()> {
    let preview = preview_output.is_some();
    let editor = preview_output.as_ref().is_some_and(|output| Arc::ptr_eq(output, &handle.set_edit_media));
    let mut program_clock: Option<crate::program_clock::Clock> = None;
    let mut guest: Option<crate::p0_call::Guest> = None;
    let mut native = NativeRoom::new()?;
    native.target.set_grades(handle.grades.clone());
    if let Some(output) = preview_output {
        *output.lock().unwrap() = Some(native.shared.clone());
    } else {
        if let Some(binding) = project.inputs.get("camera") {
            native.camera_device(&binding.device)?;
        }
        if let Some(binding) = project.inputs.get("microphone") {
            native.microphone_device(&binding.device)?;
        }
        native.shared.clips.load(&crate::root());
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
    let mut chart_mix = 0f32;
    let mut chart_tick = platform::host_time();
    let mut speaker_focus = crate::speaker_split::Focus::default();
    let mut headline_opacity = f32::from(project.production.sets.get(&project.scene)
        .is_some_and(crate::headline::visible));
    let mut set_motion = SetMotionClock::Timeline;
    let mut layout_blend:Option<crate::visuals::LayoutBlend>=None;
    let mut reversible_layout: Option<ReversibleLayout> = None;
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
    let mut microphone_peak = 0.0_f32;
    let mut movie_peaks = [0.0_f32; 2];
    let mut input_peaks = std::collections::BTreeMap::<String, f32>::new();
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
                    RenderOp::SetMotion(playing) => {
                        set_motion.set_playing(playing, platform::host_time(), state.set_motion_position, state.playing);
                        state.set_motion_playing = playing;
                    }
                    RenderOp::ReplaceVisuals(next) => visuals = next,
                    RenderOp::DetachGuest => {program_clock=None;guest=None;}
                    RenderOp::P0Guest(input) => {
                        program_clock = Some(crate::program_clock::Clock::start(native.target.clone(),input.clone())?);
                        guest = Some(input);
                    }
                    #[cfg(debug_assertions)]
                    RenderOp::P0StallProgram => {
                        let start=platform::host_time();
                        std::thread::sleep(Duration::from_millis(200));
                        let end=platform::host_time();
                        if let Some(guest)=&guest {guest.stall_receipt(start,end)?;}
                    },
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
                        set_motion = SetMotionClock::Timeline;
                        state.set_motion_position = position.as_f64();
                        state.set_motion_playing = playing;
                        if !preview {
                            *handle.program.lock().unwrap() = next.clone();
                        }
                        reversible_layout = None;
                        let ms=next.production.sets.get(&next.scene).and_then(|s|s.layout_transition_ms).unwrap_or(0);
                        layout_blend=if ms>0 && next.scene==project.scene && next.output_layout_pair()!=project.output_layout_pair() {
                            Some(crate::visuals::LayoutBlend::begin(&visuals,&next_visuals,layout_blend.as_ref(),platform::host_time(),ms))
                        }else{None};
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
                    RenderOp::Layout { project: next, plan: next_plan, visuals: next_visuals, revision: next_revision } => {
                        let now = platform::host_time();
                        reversible_layout = ReversibleLayout::between(
                            &project, &next, &visuals, &next_visuals, reversible_layout.as_ref(), now,
                        );
                        let ms = next.production.sets.get(&next.scene).and_then(|s|s.layout_transition_ms).unwrap_or(0);
                        layout_blend = if reversible_layout.is_none() && ms > 0
                            && next.output_layout_pair() != project.output_layout_pair()
                        {
                            Some(crate::visuals::LayoutBlend::begin(&visuals, &next_visuals, layout_blend.as_ref(), now, ms))
                        } else { None };
                        if !preview { *handle.program.lock().unwrap() = next.clone(); }
                        project = next;
                        visuals = next_visuals;
                        plan = next_plan;
                        revision = next_revision;
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
                        layout_blend=None;
                        reversible_layout = None;
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
                    RenderOp::StopCamera => {
                        native.stop_capture(0);
                        *native.shared.frames[0].lock().unwrap() = None;
                    }
                    RenderOp::ScreenCapture(target) => native.screen_capture(target),
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
                        layout_blend=None;
                        reversible_layout = None;
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
                    RenderOp::StartBroadcast(epoch,outputs)=>native.start_broadcast(epoch,&outputs,[project.canvas.landscape,project.canvas.vertical])?,
                    RenderOp::StopBroadcast=>native.stop_broadcast(),
                    RenderOp::StartClips(session,settings)=>{
                        native.start_clips(session,settings,[project.canvas.landscape,project.canvas.vertical])?;
                    }
                    RenderOp::StopClips=>native.stop_clips(),
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
        let measure_speakers = !preview && visuals.at(position).has_speaker_split();
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

            if let Some(input)=&guest {input.host_mic(&mut pcm,origin+audio_cursor as f64/48000.);}
            raw_mic.copy_from_slice(&pcm);
            for sample in &mut pcm {
                microphone_peak = microphone_peak.max(sample.abs());
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
                    .mix(input.shared.fence, audio_cursor, &mut movie_pcm, 1.);
                if !input_peaks.contains_key(source) {
                    input_peaks.insert(source.clone(), 0.);
                }
                mix_metered_channel(&mut pcm, &movie_pcm, gain, input_peaks.get_mut(source).unwrap());
            }
            let host_level = if measure_speakers && guest.is_some() {
                crate::speaker_split::rms(&pcm)
            } else {
                0.
            };
            if state.playing {
                for ((source, worker), peak) in [
                    ("movie", movie.as_ref()),
                    ("take", take.as_ref().filter(|_| take_bound)),
                ].into_iter().zip(&mut movie_peaks) {
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
                        1.,
                    );
                    if seq.players.iter().any(|p| p.source == source && p.envelopes.contains_key(&producer_production_contract::EnvelopeParameter::Gain)) {
                        let start = OutputInstant(Counter(audio_cursor.max(0) as u64 * 1_000_000_000 / 48000));
                        let content = transport.position(start)?;
                        for (i, frame) in movie_pcm.chunks_exact_mut(2).enumerate() {
                            let time = content.checked_add(Time::new(i as i64, 48000)?)?;
                            let level = seq.players.iter().filter(|p| p.source == source)
                                .find_map(|p| p.controls_at(time).ok().flatten()).map_or(0., |c| c.gain as f32);
                            frame[0] *= level;
                            frame[1] *= level;
                        }
                    }
                    mix_metered_channel(&mut pcm, &movie_pcm, gain, peak);
                }
            }
            let mic_peak = native.shared.mic_peak.load(Ordering::Relaxed) as f32 / 1000. * gain;
            handle.studio_audio.mix(&mut pcm, mic_peak);
            let guest_level = guest.as_ref().map(|input| input.mix(&mut pcm, measure_speakers));
            if measure_speakers {
                speaker_focus.observe(host_level, guest_level);
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
            state.movie_playback.loaded = movie.is_some();
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
            let guest_slot = guest.as_ref().and_then(|_| project.rtc_video_slot());
            if let (Some(slot), Some(guest)) = (guest_slot, &guest) {
                frames[slot] = guest.frame();
                active[slot] = true;
            }
            if editor && (visuals.at(position).has_guest_slot(0) || visuals.at(position).has_guest_slot(1)) {
                if let Some(slot) = project.rtc_video_slot() {
                    frames[slot] = handle.rtc_feed.try_lock().ok().and_then(|feed| feed.as_ref().and_then(|guest| guest.frame()));
                    active[slot] = true;
                }
            }
            (state.set_motion_position, state.set_motion_playing) =
                set_motion.sample(host, position.as_f64(), state.playing);
            let chart_target = if handle.ipo_line_chart.load(Ordering::Relaxed) { 1. } else { 0. };
            let delta = (host - chart_tick).max(0.) as f32;
            let speaker_share = if preview {
                f32::from_bits(handle.speaker_share.load(Ordering::Relaxed))
            } else if measure_speakers {
                let share = speaker_focus.advance(delta);
                handle.speaker_share.store(share.to_bits(), Ordering::Relaxed);
                share
            } else {
                speaker_focus = crate::speaker_split::Focus::default();
                let center = crate::speaker_split::CENTER;
                handle.speaker_share.store(center.to_bits(), Ordering::Relaxed);
                center
            };
            let step = (delta / 0.85).min(1.);
            chart_tick = host;
            chart_mix += (chart_target - chart_mix).clamp(-step, step);
            let headline_target = f32::from(project.production.sets.get(&project.scene)
                .is_some_and(crate::headline::visible));
            let step = (delta / 0.20).min(1.);
            headline_opacity += (headline_target - headline_opacity).clamp(-step, step);
            let host_zoom = f32::from_bits(handle.host_zoom.load(Ordering::Relaxed));
            let screen_zoom = f32::from_bits(handle.screen_zoom.load(Ordering::Relaxed));
            let screen_pan = handle.screen_pan();
            let quiz_answer = handle.quiz_answer.load(Ordering::Relaxed) as f32;
            let camera_wave = handle.camera_border_wave.load(Ordering::Relaxed);
            if layout_blend.as_ref().is_some_and(|b| b.phase(host) >= 1.) {
                layout_blend = None;
            }
            let phase = reversible_layout.as_ref().map(|blend| blend.phase(host));
            if reversible_layout.as_ref().zip(phase).is_some_and(|(blend, phase)| blend.done(phase)) {
                reversible_layout = None;
            }
            let frame_visuals = reversible_layout.as_ref().map_or(visuals.at(position), |blend| &blend.visuals);
            let music=handle.studio_audio.dj_visual.bands();
            let mut dj_title=None;
            let graph_progress = reversible_layout.as_ref().zip(phase)
                .map(|(_, phase)| phase * phase * (3. - 2. * phase));
            let resting_layouts = project.production.sets.get(&project.scene)
                .map(|set| &set.reversible_layout_transitions);
            for (i, (layout, size)) in frame_visuals.pair.ids().into_iter().zip([project.canvas.landscape, project.canvas.vertical])
                .enumerate()
            {
                frame_visuals.draw_transition(
                    &plan,
                    &samples,
                    i,
                    size,
                    &frames,
                    active,
                    host - origin,
                    position.as_f64(),
                    state.set_motion_position,
                    camera_wave,
                    &mut draws[i],
                    layout_blend.as_ref().map(|b|(b,b.phase(host))),
                    graph_progress,
                    speaker_share,
                );
                for draw in draws[i].iter_mut().filter(|d| d.kind == 5) {
                    draw.opacity = headline_opacity * headline_opacity * (3. - 2. * headline_opacity);
                    draw.surface[0] = quiz_answer;
                    draw.surface[3] = host_zoom;
                    draw.surface[2] = chart_mix;
                    draw.surface[1] = screen_zoom;
                    // Terminal graph draws carry uniform values in place of texture coordinates.
                    draw.uv[..2].copy_from_slice(&screen_pan);
                    draw.material=music;
                }
                let suppress_guest_fallback = resting_layouts.is_some_and(|layouts|
                    layouts.values().any(|target| target == layout));
                if let Some(slot) = guest_slot.filter(|_| !frame_visuals.places_guest && !suppress_guest_fallback) {
                    let height = 0.8 * size.width as f32 * 9. / (16. * size.height as f32);
                    let mut draw = platform::Draw::solid([0.1,(1.-height)/2.,0.8,height],[1.;4]);
                    draw.metrics = [0.,0.8*size.width as f32,height*size.height as f32,0.];
                    draw.kind = 1;
                    draw.reserved = 1; // Fit the decoded guest inside this program slot.
                    draw.source = slot as u32;
                    draws[i].push(draw);
                }
                for (slot, source) in [(2, "movie"), (3, "take")] {
                    if let Some(clip) = seq.players.iter().filter(|p| p.source == source && !p.envelopes.is_empty())
                        .find_map(|p| p.controls_at(position).ok().flatten()) {
                        for draw in draws[i].iter_mut().filter(|d| d.kind == 1 && d.source == slot) {
                            draw.opacity *= clip.opacity as f32;
                            let [r, g, b] = clip.color_gain;
                            draw.clip_grade = [(r-1.) as f32, (g-1.) as f32, (b-1.) as f32, (clip.saturation-1.) as f32];
                        }
                    }
                }
                take_draws[i] = draws[i]
                    .iter()
                    .filter(|d| d.kind == 1 && d.source == 3)
                    .count();
                if dj_title.is_none() && draws[i].iter().any(|d|d.kind==2 && d.source==u32::MAX){
                    dj_title=handle.studio_audio.dj_visual.label();
                }
                if program_clock.is_some() { continue; }
                if native.target.render_with_dj(
                    i,
                    size.width,
                    size.height,
                    &draws[i],
                    &frames,
                    &frame_visuals.text,
                    dj_title.as_deref(),
                    host,
                    revision,
                ) {
                    state.render_frames += 1;
                } else {
                    state.refused_frames += 1;
                }
            }
            if let Some(clock) = &program_clock {
                let (sent,refused) = clock.publish(crate::program_clock::Scene {
                    frames, draws: draws.clone(), dj_title, sizes:[project.canvas.landscape,project.canvas.vertical],
                    visuals:frame_visuals.clone(), revision, guest_slot,
                });
                state.render_frames += sent;
                state.refused_frames += refused;
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
            input_peaks.retain(|source, _| inputs.contains_key(source));
            state.mixer_peaks.clone_from(&input_peaks);
            for peak in input_peaks.values_mut() {
                *peak = 0.;
            }
            state.mixer_peaks.insert("microphone".into(), std::mem::take(&mut microphone_peak));
            for (source, peak) in ["movie", "take"].into_iter().zip(&mut movie_peaks) {
                state.mixer_peaks.insert(source.into(), std::mem::take(peak));
            }
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
                    .map_or(-1., |f| (host - f.at).max(0.) * 1000.);
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
    fn flythrough_holds_the_displayed_frame_and_resumes_independently_of_transport() {
        let mut clock = SetMotionClock::default();
        assert_eq!(clock.sample(10., 7., true), (7., true));
        clock.set_playing(false, 10.05, 7., true);
        // The program timeline can wrap while the billboard is held.
        assert_eq!(clock.sample(40., 1., true), (7., false));
        clock.set_playing(false, 40., 7., true);
        clock.set_playing(true, 50., 7., false);
        assert_eq!(clock.sample(50., 1., false), (7., true));
        clock.set_playing(true, 51., 8., false);
        assert_eq!(clock.sample(52., 1., false), (9., true));
        clock.set_playing(false, 52.02, 9., false);
        assert_eq!(clock.sample(55., 1., false), (9., false));
    }

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
