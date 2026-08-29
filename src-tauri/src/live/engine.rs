//! LiveEngine — the single owner of libobs lifecycle per LIVE-REVIEW.md §5.1:
//! one dedicated engine thread performs every libobs lifecycle/graph call;
//! OBS UI tasks are marshalled onto the macOS main thread; callbacks publish
//! immutable events, never mutate app state directly.
//!
//! M-L1 scope: bootstrap per F3 (startup → reset video/audio → load modules →
//! validate required IDs → post-load) and a truthful report of what the
//! engine discovered. No sources, outputs, or credentials yet.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::ptr;
use std::sync::mpsc;

use serde::Serialize;

use super::ffi;

/// Registration IDs the product requires, per LIVE-REVIEW.md §2.1 / M-L1.
/// VideoToolbox encoder IDs are hardware-dynamic, asserted by substring below.
const REQUIRED_SOURCES: &[&str] = &[
    "screen_capture",          // mac-capture (ScreenCaptureKit display)
    "window_capture",          // mac-capture (SCK window)
    "sck_audio_capture",       // mac-capture (desktop audio)
    "coreaudio_input_capture", // mac-capture (mic)
    "coreaudio_output_capture",
    "macos-avcapture", // mac-avcapture (webcam)
    "image_source",    // image-source (image/GIF)
    "text_ft2_source", // text-freetype2
    "color_source",
];
const REQUIRED_ENCODERS: &[&str] = &["obs_x264", "CoreAudio_AAC"];
const VT_ENCODER_SUBSTRING: &str = "videotoolbox";
const REQUIRED_OUTPUTS: &[&str] = &["rtmp_output", "flv_output"];
const REQUIRED_SERVICES: &[&str] = &["rtmp_common", "rtmp_custom"];

#[derive(Debug, Clone, Serialize)]
pub struct EngineReport {
    pub ok: bool,
    pub obs_version: String,
    pub graphics_backend: Option<String>,
    pub failed_modules: Vec<String>,
    pub missing_ids: Vec<String>,
    pub videotoolbox_encoders: Vec<String>,
    pub sources: Vec<String>,
    pub encoders: Vec<String>,
    pub outputs: Vec<String>,
    pub services: Vec<String>,
    pub errors: Vec<String>,
}

/// Marshal an OBS UI task onto the macOS main thread (GCD main queue).
/// `wait` tasks run synchronously; nested main-thread calls run inline to
/// avoid deadlocking dispatch_sync on the main queue.
extern "C" fn ui_task_handler(task: ffi::obs_task_t, param: *mut c_void, wait: bool) {
    struct Ctx {
        task: ffi::obs_task_t,
        param: usize,
    }
    extern "C" fn run(ctx: *mut c_void) {
        let ctx = unsafe { Box::from_raw(ctx as *mut Ctx) };
        (ctx.task)(ctx.param as *mut c_void);
    }
    extern "C" fn run_borrowed(ctx: *mut c_void) {
        let ctx = unsafe { &*(ctx as *const Ctx) };
        (ctx.task)(ctx.param as *mut c_void);
    }
    unsafe {
        if wait {
            if ffi::pthread_main_np() == 1 {
                task(param);
            } else {
                let ctx = Ctx {
                    task,
                    param: param as usize,
                };
                ffi::dispatch_sync_f(
                    &ffi::_dispatch_main_q as *const c_void,
                    &ctx as *const Ctx as *mut c_void,
                    run_borrowed,
                );
            }
        } else {
            let ctx = Box::into_raw(Box::new(Ctx {
                task,
                param: param as usize,
            }));
            ffi::dispatch_async_f(&ffi::_dispatch_main_q as *const c_void, ctx as *mut c_void, run);
        }
    }
}

fn enum_ids(f: unsafe extern "C" fn(usize, *mut *const c_char) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut idx = 0usize;
    loop {
        let mut id: *const c_char = ptr::null();
        if !unsafe { f(idx, &mut id) } {
            break;
        }
        if !id.is_null() {
            out.push(unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned());
        }
        idx += 1;
    }
    out
}

fn reset_video(module: &str) -> Result<(), i32> {
    let module_c = CString::new(module).unwrap();
    let mut ovi = ffi::obs_video_info {
        graphics_module: module_c.as_ptr(),
        fps_num: 30,
        fps_den: 1,
        base_width: 1280,
        base_height: 720,
        output_width: 1280,
        output_height: 720,
        output_format: ffi::VIDEO_FORMAT_NV12,
        adapter: 0,
        gpu_conversion: true,
        colorspace: ffi::VIDEO_CS_709,
        range: ffi::VIDEO_RANGE_PARTIAL,
        scale_type: ffi::OBS_SCALE_BILINEAR,
    };
    let rc = unsafe { ffi::obs_reset_video(&mut ovi) };
    if rc == 0 {
        Ok(())
    } else {
        Err(rc)
    }
}

/// Full F3 bootstrap. MUST be called on the live-engine thread, never the
/// main thread and never more than once per process.
pub fn bootstrap() -> EngineReport {
    let mut report = EngineReport {
        ok: false,
        obs_version: String::new(),
        graphics_backend: None,
        failed_modules: Vec::new(),
        missing_ids: Vec::new(),
        videotoolbox_encoders: Vec::new(),
        sources: Vec::new(),
        encoders: Vec::new(),
        outputs: Vec::new(),
        services: Vec::new(),
        errors: Vec::new(),
    };

    let locale = CString::new("en-US").unwrap();
    if !unsafe { ffi::obs_startup(locale.as_ptr(), ptr::null(), ptr::null_mut()) } {
        report.errors.push("obs_startup failed".into());
        return report;
    }
    report.obs_version = unsafe { CStr::from_ptr(ffi::obs_get_version_string()) }
        .to_string_lossy()
        .into_owned();

    // §5.1: OBS UI tasks are marshalled to the macOS main thread from the start.
    unsafe { ffi::obs_set_ui_task_handler(ui_task_handler) };

    // Dev-mode escape hatch: outside a .app bundle, NSBundle's builtInPlugInsURL
    // does not point at the engine artifact; allow an explicit override.
    if let Ok(plugins_dir) = std::env::var("PRODUCER_ENGINE_PLUGINS") {
        let bin = CString::new(format!("{plugins_dir}/%module%.plugin/Contents/MacOS")).unwrap();
        let data =
            CString::new(format!("{plugins_dir}/%module%.plugin/Contents/Resources")).unwrap();
        unsafe { ffi::obs_add_module_path(bin.as_ptr(), data.as_ptr()) };
    }

    // Metal preferred, OpenGL fallback (A5 / F9); record the actual backend.
    match reset_video("libobs-metal.dylib") {
        Ok(()) => report.graphics_backend = Some("metal".into()),
        Err(metal_rc) => match reset_video("libobs-opengl.dylib") {
            Ok(()) => {
                report.graphics_backend = Some("opengl".into());
                report
                    .errors
                    .push(format!("metal backend unavailable (rc={metal_rc}), fell back to opengl"));
            }
            Err(gl_rc) => {
                report
                    .errors
                    .push(format!("obs_reset_video failed: metal rc={metal_rc}, opengl rc={gl_rc}"));
                return report;
            }
        },
    }

    let oai = ffi::obs_audio_info {
        samples_per_sec: 48000,
        speakers: ffi::SPEAKERS_STEREO,
    };
    if !unsafe { ffi::obs_reset_audio(&oai) } {
        report.errors.push("obs_reset_audio failed".into());
        return report;
    }

    let mut mfi = ffi::obs_module_failure_info {
        failed_modules: ptr::null_mut(),
        count: 0,
    };
    unsafe { ffi::obs_load_all_modules2(&mut mfi) };
    for i in 0..mfi.count {
        let name = unsafe { CStr::from_ptr(*mfi.failed_modules.add(i)) };
        report.failed_modules.push(name.to_string_lossy().into_owned());
    }
    unsafe { ffi::obs_module_failure_info_free(&mut mfi) };

    // F3 ★: validate required IDs, then obs_post_load_modules. VideoToolbox
    // registers its encoders during post-load, so VT is re-checked after it.
    unsafe { ffi::obs_post_load_modules() };
    unsafe { ffi::obs_log_loaded_modules() };

    report.sources = enum_ids(ffi::obs_enum_source_types);
    report.encoders = enum_ids(ffi::obs_enum_encoder_types);
    report.outputs = enum_ids(ffi::obs_enum_output_types);
    report.services = enum_ids(ffi::obs_enum_service_types);
    report.videotoolbox_encoders = report
        .encoders
        .iter()
        .filter(|id| id.to_lowercase().contains(VT_ENCODER_SUBSTRING))
        .cloned()
        .collect();

    for (required, present) in [
        (REQUIRED_SOURCES, &report.sources),
        (REQUIRED_ENCODERS, &report.encoders),
        (REQUIRED_OUTPUTS, &report.outputs),
        (REQUIRED_SERVICES, &report.services),
    ] {
        for id in required {
            if !present.iter().any(|p| p == id) {
                report.missing_ids.push((*id).into());
            }
        }
    }
    if report.videotoolbox_encoders.is_empty() {
        report
            .missing_ids
            .push("<any VideoToolbox encoder>".into());
    }

    report.ok = report.missing_ids.is_empty() && report.failed_modules.is_empty();
    report
}

// ---------------------------------------------------------------------------
// M-L5 host contract: the LiveEngine owner — one thread owns every libobs
// lifecycle/graph/output call (§5.1); commands arrive over a channel, and
// immutable events flow back through the sink (which the app layer forwards
// to the webview as IPC events).
// ---------------------------------------------------------------------------

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::graph;
use super::multi::{DestStatus, MultiConfig, MultiReport, Session};

pub enum Command {
    GoLive(MultiConfig),
    StopLive,
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    #[default]
    Idle,
    Starting,
    /// Outputs exist and are connecting/sending. Transport truth only —
    /// per-destination phases carry the detail; platform confirmation is a
    /// dashboard concern (M-L4 finding).
    Streaming,
    Stopping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveEvent {
    EngineReady {
        ok: bool,
        graphics_backend: Option<String>,
        obs_version: String,
    },
    SessionState {
        state: SessionState,
    },
    Status {
        elapsed_secs: f64,
        destinations: Vec<DestStatus>,
    },
    SessionEnded {
        report: MultiReport,
    },
    EngineError {
        message: String,
    },
}

/// Pull-side view of the engine for IPC (`live_status`); the push side is
/// the event sink. Updated only by the engine thread.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Snapshot {
    pub engine_ready: bool,
    pub bootstrap_ok: bool,
    pub graphics_backend: Option<String>,
    pub session_state: SessionState,
    pub elapsed_secs: f64,
    pub destinations: Vec<DestStatus>,
}

pub struct LiveHandle {
    cmd: mpsc::Sender<Command>,
    pub snapshot: Arc<Mutex<Snapshot>>,
    streaming: Arc<AtomicBool>,
}

impl LiveHandle {
    pub fn go_live(&self, config: MultiConfig) -> Result<(), String> {
        self.proxy().go_live(config)
    }
    pub fn stop_live(&self) -> Result<(), String> {
        self.proxy().stop_live()
    }
    pub fn shutdown(&self) {
        let _ = self.cmd.send(Command::Shutdown);
    }
    pub fn proxy(&self) -> LiveProxy {
        LiveProxy {
            cmd: self.cmd.clone(),
            streaming: self.streaming.clone(),
        }
    }
}

/// Cheap clonable command sender for helper threads (harness relay).
#[derive(Clone)]
pub struct LiveProxy {
    cmd: mpsc::Sender<Command>,
    streaming: Arc<AtomicBool>,
}

impl LiveProxy {
    pub fn go_live(&self, config: MultiConfig) -> Result<(), String> {
        if self.streaming.load(AtomicOrdering::SeqCst) {
            return Err("a live session is already running".into());
        }
        self.cmd.send(Command::GoLive(config)).map_err(|e| e.to_string())
    }
    pub fn stop_live(&self) -> Result<(), String> {
        self.cmd.send(Command::StopLive).map_err(|e| e.to_string())
    }
}

/// Start the LiveEngine owner thread. `sink` receives every event after the
/// snapshot has been updated; it runs on the engine thread and must not
/// block or call back into the engine.
pub fn start(sink: impl Fn(&LiveEvent) + Send + 'static) -> LiveHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
    let snapshot = Arc::new(Mutex::new(Snapshot::default()));
    let streaming = Arc::new(AtomicBool::new(false));
    let snap = snapshot.clone();
    let streaming_flag = streaming.clone();

    std::thread::Builder::new()
        .name("live-engine".into())
        .spawn(move || {
            let report = bootstrap();
            {
                let mut s = snap.lock().unwrap();
                s.engine_ready = true;
                s.bootstrap_ok = report.ok;
                s.graphics_backend = report.graphics_backend.clone();
            }
            sink(&LiveEvent::EngineReady {
                ok: report.ok,
                graphics_backend: report.graphics_backend.clone(),
                obs_version: report.obs_version.clone(),
            });

            let mut capture_attached = false;
            let mut session: Option<Session> = None;
            let mut state = SessionState::Idle;
            let mut last_status_emit = Instant::now();

            let set_state =
                |state: &mut SessionState, new: SessionState, snap: &Arc<Mutex<Snapshot>>, sink: &dyn Fn(&LiveEvent)| {
                    if *state != new {
                        *state = new;
                        snap.lock().unwrap().session_state = new;
                        sink(&LiveEvent::SessionState { state: new });
                    }
                };

            loop {
                match cmd_rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(Command::GoLive(config)) => {
                        if session.is_some() {
                            sink(&LiveEvent::EngineError {
                                message: "go-live refused: session already running".into(),
                            });
                        } else if !report.ok {
                            sink(&LiveEvent::EngineError {
                                message: "go-live refused: engine bootstrap failed".into(),
                            });
                        } else {
                            set_state(&mut state, SessionState::Starting, &snap, &sink);
                            if !capture_attached {
                                match graph::attach_capture_sources() {
                                    Ok(()) => capture_attached = true,
                                    Err(e) => {
                                        sink(&LiveEvent::EngineError {
                                            message: format!("capture attach failed: {e}"),
                                        });
                                        set_state(&mut state, SessionState::Idle, &snap, &sink);
                                        continue;
                                    }
                                }
                            }
                            match Session::start(config) {
                                Ok(s) => {
                                    session = Some(s);
                                    streaming_flag.store(true, AtomicOrdering::SeqCst);
                                    set_state(&mut state, SessionState::Streaming, &snap, &sink);
                                }
                                Err(failed_report) => {
                                    sink(&LiveEvent::SessionEnded { report: failed_report });
                                    set_state(&mut state, SessionState::Idle, &snap, &sink);
                                }
                            }
                        }
                    }
                    Ok(Command::StopLive) => {
                        if let Some(s) = session.as_mut() {
                            s.request_stop();
                            set_state(&mut state, SessionState::Stopping, &snap, &sink);
                        }
                    }
                    Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if let Some(mut s) = session.take() {
                            s.request_stop();
                            let deadline = Instant::now() + Duration::from_secs(15);
                            while !s.pump() && Instant::now() < deadline {
                                std::thread::sleep(Duration::from_millis(200));
                            }
                            let report = s.finish();
                            sink(&LiveEvent::SessionEnded { report });
                        }
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }

                if let Some(s) = session.as_mut() {
                    let done = s.pump();
                    if s.stopping() {
                        set_state(&mut state, SessionState::Stopping, &snap, &sink);
                    }
                    if done {
                        let report = session.take().unwrap().finish();
                        streaming_flag.store(false, AtomicOrdering::SeqCst);
                        {
                            let mut sn = snap.lock().unwrap();
                            sn.destinations = report.destinations.clone();
                            sn.elapsed_secs = report.streamed_secs;
                        }
                        sink(&LiveEvent::SessionEnded { report });
                        set_state(&mut state, SessionState::Idle, &snap, &sink);
                    } else if last_status_emit.elapsed() > Duration::from_secs(1) {
                        last_status_emit = Instant::now();
                        let statuses = s.statuses();
                        let elapsed = s.elapsed_secs();
                        {
                            let mut sn = snap.lock().unwrap();
                            sn.destinations = statuses.clone();
                            sn.elapsed_secs = elapsed;
                        }
                        sink(&LiveEvent::Status {
                            elapsed_secs: elapsed,
                            destinations: statuses,
                        });
                    }
                }
            }
            // Process exit path: outputs already stopped above; skip
            // obs_shutdown — teardown of a dying process, not a lifecycle.
        })
        .expect("spawn live-engine thread");

    LiveHandle {
        cmd: cmd_tx,
        snapshot,
        streaming,
    }
}
