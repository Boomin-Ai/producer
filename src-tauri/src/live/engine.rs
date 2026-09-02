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
use super::record;

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

/// Whether the stage renders as a transparent hole (preview BELOW the
/// webview) — the UI mirrors this so its CSS matches the native stacking.
pub static STAGE_TRANSPARENT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

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
            ffi::dispatch_async_f(
                &ffi::_dispatch_main_q as *const c_void,
                ctx as *mut c_void,
                run,
            );
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

/// The graphics module for a backend name recorded at boot.
///
/// A later reset MUST reuse the backend the engine actually booted with, and
/// the module names are per-platform: handing obs_reset_video a `.dylib` name on
/// Windows fails the reset and takes the graphics device with it. The boot path
/// chooses the backend; this maps its recorded name back to a module.
#[cfg(target_os = "macos")]
fn graphics_module(backend: Option<&str>) -> &'static str {
    if backend == Some("metal") { "libobs-metal.dylib" } else { "libobs-opengl.dylib" }
}
#[cfg(target_os = "windows")]
fn graphics_module(backend: Option<&str>) -> &'static str {
    if backend == Some("d3d11") { "libobs-d3d11.dll" } else { "libobs-opengl.dll" }
}

fn reset_video(module: &str, height: u32, fps: u32) -> Result<(), i32> {
    let width = height * 16 / 9;
    let module_c = CString::new(module).unwrap();
    let mut ovi = ffi::obs_video_info {
        graphics_module: module_c.as_ptr(),
        fps_num: fps,
        fps_den: 1,
        base_width: width,
        base_height: height,
        output_width: width,
        output_height: height,
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
    bootstrap_with_config(None)
}

/// module_config_path feeds obs_module_config_path() — obs-browser derives
/// its CEF cache dir from it (M-L7.1); harmless for every other plugin.
/// The video mode the user last chose, persisted beside the module config so
/// BOOT can start there directly — booting 720p30 and resetting to the stored
/// mode afterwards tears the Metal pipeline down on the main thread at every
/// room open (the beach ball).
pub fn stored_video(dir: Option<&std::path::Path>) -> (u32, u32) {
    let fallback = (720u32, 30u32);
    let Some(dir) = dir else { return fallback };
    let Ok(txt) = std::fs::read_to_string(dir.join("video.json")) else { return fallback };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else { return fallback };
    let h = v.get("h").and_then(|x| x.as_u64()).unwrap_or(720) as u32;
    let f = v.get("f").and_then(|x| x.as_u64()).unwrap_or(30) as u32;
    if (h == 720 || h == 1080) && (f == 30 || f == 60) { (h, f) } else { fallback }
}

pub fn persist_video(dir: &std::path::Path, h: u32, f: u32) {
    let _ = std::fs::write(dir.join("video.json"), format!("{{\"h\":{h},\"f\":{f}}}"));
}

pub fn bootstrap_with_config(module_config_dir: Option<&std::path::Path>) -> EngineReport {
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
    let config_c = module_config_dir.and_then(|p| {
        let _ = std::fs::create_dir_all(p);
        CString::new(p.to_string_lossy().into_owned()).ok()
    });
    let config_ptr = config_c.as_ref().map_or(ptr::null(), |c| c.as_ptr());
    // Chromium switches for obs-browser, set BEFORE startup so they are in
    // place when the module loads and initialises CEF.
    //
    // Without this, getUserMedia inside a browser source does not prompt — it
    // HANGS. obs-browser installs no CefPermissionHandler, and CEF's default
    // for a media request with no handler is to never answer. That is what
    // stalled the guest return-audio leg: a page awaiting the host mic waited
    // forever. On macOS obs-browser forwards our argv into CefMainArgs, so a
    // flag here reaches CEF with no engine patch.
    //
    // ⚠️ This grant is BLANKET, not per-origin: any browser source can now
    // capture audio. Acceptable because every browser URL in Producer is one
    // the user added, but the correct long-term fix is an origin-scoped
    // CefPermissionHandler in our own obs-browser build, allowing only our
    // guest-render origin.
    let argv0 = CString::new("producer").unwrap();
    let media_flag = CString::new("--use-fake-ui-for-media-stream").unwrap();
    // Dev builds expose the render pages' devtools — guest issues are
    // otherwise invisible (CEF has no window, no console, no network tab).
    #[cfg(debug_assertions)]
    let debug_flag = CString::new("--remote-debugging-port=9223").unwrap();
    #[cfg(debug_assertions)]
    let cef_argv: [*const c_char; 3] = [argv0.as_ptr(), media_flag.as_ptr(), debug_flag.as_ptr()];
    #[cfg(not(debug_assertions))]
    let cef_argv: [*const c_char; 2] = [argv0.as_ptr(), media_flag.as_ptr()];
    unsafe { ffi::obs_set_cmdline_args(cef_argv.len() as i32, cef_argv.as_ptr()) };

    if !unsafe { ffi::obs_startup(locale.as_ptr(), config_ptr, ptr::null_mut()) } {
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

    // Preferred backend, OpenGL fallback (A5 / F9); record the actual backend.
    // The module NAMES are the only platform difference — obs_reset_video's
    // contract is identical, so the preference/fallback shape is shared rather
    // than duplicated per platform.
    let (boot_h, boot_f) = stored_video(module_config_dir);
    #[cfg(target_os = "macos")]
    let (primary, primary_name) = ("libobs-metal.dylib", "metal");
    #[cfg(target_os = "windows")]
    let (primary, primary_name) = ("libobs-d3d11.dll", "d3d11");
    #[cfg(target_os = "macos")]
    let fallback = "libobs-opengl.dylib";
    #[cfg(target_os = "windows")]
    let fallback = "libobs-opengl.dll";

    match reset_video(primary, boot_h, boot_f) {
        Ok(()) => report.graphics_backend = Some(primary_name.into()),
        Err(primary_rc) => match reset_video(fallback, boot_h, boot_f) {
            Ok(()) => {
                report.graphics_backend = Some("opengl".into());
                report.errors.push(format!(
                    "{primary_name} backend unavailable (rc={primary_rc}), fell back to opengl"
                ));
            }
            Err(gl_rc) => {
                report.errors.push(format!(
                    "obs_reset_video failed: {primary_name} rc={primary_rc}, opengl rc={gl_rc}"
                ));
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
        report
            .failed_modules
            .push(name.to_string_lossy().into_owned());
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
        report.missing_ids.push("<any VideoToolbox encoder>".into());
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

/// What to do to a source's filter chain. Every op answers with the chain's
/// new state, so the UI never has to guess what happened.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FilterOp {
    List,
    Add {
        kind: String,
        name: String,
    },
    Remove {
        name: String,
    },
    Enable {
        name: String,
        on: bool,
    },
    /// 0 up, 1 down, 2 top, 3 bottom.
    Reorder {
        name: String,
        movement: i32,
    },
    Update {
        name: String,
        settings: serde_json::Value,
    },
}

pub enum Command {
    SetThumbRate { fps: u32 },
    GoLive(MultiConfig),
    StopLive,
    SetSources {
        screen: bool,
        camera: bool,
        mic: bool,
    },
    SetMicAudio {
        volume: Option<f32>,
        muted: Option<bool>,
    },
    /// Stage-editor transform (UI-P1). `commit: false` applies silently at
    /// gesture rate; `commit: true` (pointer-up) echoes SourcesChanged so
    /// the UI and room document settle on engine truth.
    SetTransform {
        id: String,
        patch: graph::TransformPatch,
        commit: bool,
    },
    /// Devices behind a source's picker (camera / mic / screen). Carries its
    /// own reply channel: obs_* calls must happen on the engine-owner thread
    /// (§5.1), so the caller asks and waits rather than touching libobs.
    ListDevices {
        kind: String,
        reply: std::sync::mpsc::Sender<Vec<graph::DeviceOption>>,
    },
    /// Start the stinger clip over everything; replies with its duration in
    /// ms (0 = not known yet, use the configured length).
    PlayStinger {
        path: String,
        reply: std::sync::mpsc::Sender<Result<i64, String>>,
    },
    /// Start recording to ~/Movies/Producer. `stamp` names the file; the
    /// engine never reads a clock.
    StartRecording {
        stamp: String,
        reply: std::sync::mpsc::Sender<Result<String, String>>,
    },
    StopRecording {
        reply: std::sync::mpsc::Sender<Option<String>>,
    },
    /// A/V sync offset in ms for any source.
    SetSyncOffset {
        id: String,
        ms: i64,
    },
    /// Volume/mute for any audio-bearing source — guests included, not just
    /// the mic.
    SetSourceAudio {
        id: String,
        volume: Option<f32>,
        muted: Option<bool>,
    },
    /// Per-item opacity for scene fades. Gesture-rate, fire-and-forget: a
    /// reply per animation frame would be pure latency.
    SetItemOpacity {
        id: String,
        opacity: f64,
    },
    /// Filters are per source and ordered — every op names the source and,
    /// except for List/Add, the filter within it.
    Filters {
        source: String,
        op: FilterOp,
        reply: std::sync::mpsc::Sender<Result<Vec<super::filters::FilterState>, String>>,
    },
    /// Open the clip ahead of time so the cut itself is instant.
    PrepareStinger {
        path: String,
    },
    StopStinger,
    /// Virtual camera output — Producer appears as a webcam in other apps.
    SetVirtualCam {
        on: bool,
        reply: std::sync::mpsc::Sender<Result<bool, String>>,
    },
    /// Point a live source at a different device, keeping its transform.
    SetDevice {
        kind: String,
        device: String,
    },
    /// Add an open-list scene item (UI-P2.10). Id and label come from the
    /// room document so items respawn with stable identity.
    AddExtra {
        id: String,
        label: String,
        spec: graph::ExtraSpec,
    },
    RemoveExtra {
        id: String,
    },
    /// Output video settings (OBS-style, our flavor): 16:9 height + fps.
    /// Refused while a session is running.
    SetVideo {
        height: u32,
        fps: u32,
    },
    SetOverlay(graph::OverlaySpec),
    AttachPreview {
        /// NSWindow* of the Tauri window, as usize.
        window: usize,
        rect: PreviewRect,
    },
    MovePreview(PreviewRect),
    SetPreviewHidden(bool),
    DetachPreview,
    Shutdown,
}

/// CSS-point rect of the preview area, top-left origin, webview coordinates.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct PreviewRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
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
pub struct ExtraPeak {
    pub id: String,
    pub peak: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GuestThumb {
    pub id: String,
    pub jpeg: String,
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
    SourcesChanged {
        sources: graph::SourcesState,
    },
    /// Mic meter tick (~8 Hz while the mic is on): peak absolute sample
    /// since the previous tick, 0..=1.
    Levels {
        mic_peak: f64,
        extra_peaks: Vec<ExtraPeak>,
    },
    /// Live guest previews (~7 Hz): 256x144 JPEG, base64 — the panel shows a
    /// real feed for everyone in the room, on stage or not. JPEG at the
    /// source keeps the event ~12KB per guest instead of ~200KB of raw RGBA.
    GuestThumbs {
        w: u32,
        h: u32,
        thumbs: Vec<GuestThumb>,
    },
    VideoChanged {
        height: u32,
        fps: u32,
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
    /// Thumbnail readback instrumentation (docs/THUMB-PIPELINE-V2.md,
    /// amendment 1): worst map wait and count of >200µs maps since boot.
    #[serde(default)]
    pub thumb_wait_us_max: u64,
    #[serde(default)]
    pub thumb_slow_maps: u64,
    pub bootstrap_ok: bool,
    pub graphics_backend: Option<String>,
    pub session_state: SessionState,
    pub elapsed_secs: f64,
    pub destinations: Vec<DestStatus>,
    pub sources: graph::SourcesState,
    pub preview_attached: bool,
    /// OBS-parity health: render FPS, frames the renderer had to skip, and
    /// process CPU. Skipped frames mean the MACHINE is behind, which is a
    /// different failure from dropped frames (the NETWORK is behind) — OBS
    /// shows both because the fix is different.
    pub fps: f64,
    pub skipped_frames: u32,
    pub total_frames: u32,
    pub cpu: f64,
    pub video_height: u32,
    pub video_fps: u32,
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
    pub fn set_sources(&self, screen: bool, camera: bool, mic: bool) -> Result<(), String> {
        self.cmd
            .send(Command::SetSources {
                screen,
                camera,
                mic,
            })
            .map_err(|e| e.to_string())
    }

    pub fn set_mic_audio(&self, volume: Option<f32>, muted: Option<bool>) -> Result<(), String> {
        self.cmd
            .send(Command::SetMicAudio { volume, muted })
            .map_err(|e| e.to_string())
    }

    pub fn set_transform(
        &self,
        id: String,
        patch: graph::TransformPatch,
        commit: bool,
    ) -> Result<(), String> {
        self.cmd
            .send(Command::SetTransform { id, patch, commit })
            .map_err(|e| e.to_string())
    }

    /// Blocks the caller (a Tauri command thread, never the UI) until the
    /// engine answers; a wedged engine yields an empty list, not a hang.
    pub fn list_devices(&self, kind: String) -> Result<Vec<graph::DeviceOption>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::ListDevices { kind, reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "the engine did not answer in time".to_string())
    }

    pub fn play_stinger(&self, path: String) -> Result<i64, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::PlayStinger { path, reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "the engine did not answer in time".to_string())?
    }

    /// Demand control (docs/THUMB-PIPELINE-V2.md): 0 = previews off.
    pub fn set_thumb_rate(&self, fps: u32) {
        let _ = self.cmd.send(Command::SetThumbRate { fps });
    }

    pub fn start_recording(&self, stamp: String) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::StartRecording { stamp, reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "the engine did not answer in time".to_string())?
    }

    pub fn stop_recording(&self) -> Result<Option<String>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::StopRecording { reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(15))
            .map_err(|_| "the engine did not answer in time".to_string())
    }

    pub fn set_sync_offset(&self, id: String, ms: i64) -> Result<(), String> {
        self.cmd
            .send(Command::SetSyncOffset { id, ms })
            .map_err(|e| e.to_string())
    }

    pub fn set_source_audio(
        &self,
        id: String,
        volume: Option<f32>,
        muted: Option<bool>,
    ) -> Result<(), String> {
        self.cmd
            .send(Command::SetSourceAudio { id, volume, muted })
            .map_err(|e| e.to_string())
    }

    pub fn set_item_opacity(&self, id: String, opacity: f64) -> Result<(), String> {
        self.cmd
            .send(Command::SetItemOpacity { id, opacity })
            .map_err(|e| e.to_string())
    }

    pub fn filters(
        &self,
        source: String,
        op: FilterOp,
    ) -> Result<Vec<super::filters::FilterState>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::Filters {
                source,
                op,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "the engine did not answer in time".to_string())?
    }

    pub fn set_virtual_cam(&self, on: bool) -> Result<bool, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::SetVirtualCam { on, reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "the engine did not answer in time".to_string())?
    }

    pub fn prepare_stinger(&self, path: String) -> Result<(), String> {
        self.cmd
            .send(Command::PrepareStinger { path })
            .map_err(|e| e.to_string())
    }

    pub fn stop_stinger(&self) -> Result<(), String> {
        self.cmd
            .send(Command::StopStinger)
            .map_err(|e| e.to_string())
    }

    pub fn set_device(&self, kind: String, device: String) -> Result<(), String> {
        self.cmd
            .send(Command::SetDevice { kind, device })
            .map_err(|e| e.to_string())
    }

    pub fn add_extra(
        &self,
        id: String,
        label: String,
        spec: graph::ExtraSpec,
    ) -> Result<(), String> {
        self.cmd
            .send(Command::AddExtra { id, label, spec })
            .map_err(|e| e.to_string())
    }

    pub fn remove_extra(&self, id: String) -> Result<(), String> {
        self.cmd
            .send(Command::RemoveExtra { id })
            .map_err(|e| e.to_string())
    }

    pub fn set_video(&self, height: u32, fps: u32) -> Result<(), String> {
        self.cmd
            .send(Command::SetVideo { height, fps })
            .map_err(|e| e.to_string())
    }
    pub fn set_overlay(&self, spec: graph::OverlaySpec) -> Result<(), String> {
        self.cmd
            .send(Command::SetOverlay(spec))
            .map_err(|e| e.to_string())
    }
    pub fn attach_preview(&self, window: usize, rect: PreviewRect) -> Result<(), String> {
        self.cmd
            .send(Command::AttachPreview { window, rect })
            .map_err(|e| e.to_string())
    }
    pub fn move_preview(&self, rect: PreviewRect) -> Result<(), String> {
        self.cmd
            .send(Command::MovePreview(rect))
            .map_err(|e| e.to_string())
    }
    pub fn set_preview_hidden(&self, hidden: bool) -> Result<(), String> {
        self.cmd
            .send(Command::SetPreviewHidden(hidden))
            .map_err(|e| e.to_string())
    }

    pub fn detach_preview(&self) -> Result<(), String> {
        self.cmd
            .send(Command::DetachPreview)
            .map_err(|e| e.to_string())
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

/// The A6 integration: obs_display bound to an NSView hosted over the Tauri
/// webview (shim.m owns the AppKit side; Streamlabs precedent). Draw callback
/// runs on the OBS graphics thread and only renders — no state mutation
/// (§5.1). Owned by the engine thread.
struct Preview {
    view: *mut std::os::raw::c_void,
    display: *mut ffi::obs_display_t,
}

extern "C" fn preview_draw(_param: *mut std::os::raw::c_void, _cx: u32, _cy: u32) {
    unsafe {
        let mut ovi: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        let (bw, bh) = if ffi::obs_get_video_info(ovi.as_mut_ptr()) {
            let ovi = ovi.assume_init();
            (ovi.base_width as f32, ovi.base_height as f32)
        } else {
            (1280.0, 720.0)
        };
        ffi::gs_viewport_push();
        ffi::gs_projection_push();
        ffi::gs_ortho(0.0, bw, 0.0, bh, -100.0, 100.0);
        ffi::obs_render_main_texture();
        ffi::gs_projection_pop();
        ffi::gs_viewport_pop();
    }
}

impl Preview {
    // A10 finding (crash 2026-08-28): libobs-metal's swapchain create/resize/
    // destroy are Swift and dispatch_assert the MAIN queue — OBS Studio's Qt
    // UI satisfies this implicitly. Per §5.1 these are AppKit-adjacent ops,
    // so every obs_display lifecycle call is marshalled to the main thread;
    // draw callbacks still run on the OBS graphics thread.
    fn attach(ns_window: *mut std::os::raw::c_void, rect: PreviewRect) -> Result<Preview, String> {
        unsafe {
            let (mut px_w, mut px_h) = (0f64, 0f64);
            // Whether the stage is a transparent hole was decided (on the
            // main thread) by live_attach_preview before this command was
            // queued; here we only honour it.
            let transparent = STAGE_TRANSPARENT.load(AtomicOrdering::SeqCst);
            let view = ffi::producer_preview_attach(
                ns_window,
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                transparent as i32,
                &mut px_w,
                &mut px_h,
            );
            if view.is_null() {
                return Err("NSView creation failed".into());
            }
            let view_addr = view as usize;
            let (cx, cy) = (px_w.max(1.0) as u32, px_h.max(1.0) as u32);
            let display_addr = graph::on_main_thread(move || {
                let init = ffi::gs_init_data {
                    window: ffi::gs_window {
                        view: view_addr as *mut std::os::raw::c_void,
                    },
                    cx,
                    cy,
                    num_backbuffers: 0,
                    format: ffi::GS_BGRA,
                    zsformat: ffi::GS_ZS_NONE,
                    adapter: 0,
                };
                ffi::obs_display_create(&init, 0) as usize
            });
            if display_addr == 0 {
                ffi::producer_preview_detach(view);
                return Err("obs_display_create failed".into());
            }
            let display = display_addr as *mut ffi::obs_display_t;
            ffi::obs_display_add_draw_callback(display, preview_draw, std::ptr::null_mut());
            Ok(Preview { view, display })
        }
    }

    fn set_rect(&mut self, rect: PreviewRect) {
        unsafe {
            let (mut px_w, mut px_h) = (0f64, 0f64);
            ffi::producer_preview_set_frame(
                self.view, rect.x, rect.y, rect.w, rect.h, &mut px_w, &mut px_h,
            );
            let display_addr = self.display as usize;
            let (cx, cy) = (px_w.max(1.0) as u32, px_h.max(1.0) as u32);
            graph::on_main_thread(move || {
                ffi::obs_display_resize(display_addr as *mut ffi::obs_display_t, cx, cy);
            });
        }
    }

    fn detach(self) {
        unsafe {
            ffi::obs_display_remove_draw_callback(self.display, preview_draw, std::ptr::null_mut());
            let display_addr = self.display as usize;
            graph::on_main_thread(move || {
                ffi::obs_display_destroy(display_addr as *mut ffi::obs_display_t);
            });
            ffi::producer_preview_detach(self.view);
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
        self.cmd
            .send(Command::GoLive(config))
            .map_err(|e| e.to_string())
    }
    pub fn stop_live(&self) -> Result<(), String> {
        self.cmd.send(Command::StopLive).map_err(|e| e.to_string())
    }
}

/// Start the LiveEngine owner thread. `sink` receives every event after the
/// snapshot has been updated; it runs on the engine thread and must not
/// block or call back into the engine.
/// Upstream modules speak in their own brand and their own UI vocabulary —
/// mac-virtualcam's "Please allow OBS to install…" is a compiled string we
/// cannot patch. Every message that can reach a user passes through here, so
/// nothing says OBS in Producer's window.
pub fn user_facing(message: &str) -> String {
    let m = message.trim();
    let lower = m.to_ascii_lowercase();
    if lower.contains("virtual camera") && lower.contains("not installed") {
        return "The virtual camera isn't installed yet. Approve Producer's \
camera extension in System Settings › General › Login Items & Extensions › \
Camera Extensions, then try again."
            .replace('\n', "");
    }
    m.replace("OBS Studio", "Producer")
        .replace("obs-studio", "Producer")
        .replace("OBS", "Producer")
}

pub fn start(
    module_config_dir: std::path::PathBuf,
    sink: impl Fn(&LiveEvent) + Send + Sync + 'static,
) -> LiveHandle {
    // Wrap the caller's sink once: every EngineError leaving the engine is
    // rewritten, no matter which of the many call sites produced it.
    // Arc'd because the thumbnail ENCODER thread emits events too.
    let sink_arc = std::sync::Arc::new(move |ev: &LiveEvent| match ev {
        LiveEvent::EngineError { message } => sink(&LiveEvent::EngineError {
            message: user_facing(message),
        }),
        other => sink(other),
    });
    // Plain-closure shim: Arc<F> is not itself callable, and every internal
    // call site expects `sink(ev)`. The engine thread gets this; the encoder
    // thread builds its own from another clone.
    let sink = {
        let s = sink_arc.clone();
        move |ev: &LiveEvent| (*s)(ev)
    };
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
    // Preview distribution primitive (docs/THUMB-PIPELINE-V2.md): graphics
    // thread produces via thumb_render_cb, this thread encodes and emits.
    let hub = std::sync::Arc::new(graph::ThumbHub::new());
    {
        let hub = hub.clone();
        let sink = {
            let s = sink_arc.clone();
            move |ev: &LiveEvent| (*s)(ev)
        };
        std::thread::Builder::new()
            .name("thumb-encoder".into())
            .spawn(move || {
                use base64::Engine as _;
                let mut jpg: Vec<u8> = Vec::with_capacity(32 * 1024);
                let mut scratch: Vec<u8> = Vec::new();
                #[cfg(debug_assertions)]
                let mut dumped: std::collections::HashSet<String> = std::collections::HashSet::new();
                loop {
                    {
                        let flag = hub.wake_flag.lock().unwrap();
                        let (mut flag, _) = hub
                            .wake
                            .wait_timeout(flag, Duration::from_millis(500))
                            .unwrap();
                        *flag = false;
                    }
                    // Drain ready slots. Locks are held only long enough to
                    // SWAP the buffer out — the graphics thread must never
                    // find this thread camped on a slot (latest-frame-wins).
                    let mut work: Vec<(String, Vec<u8>)> = Vec::new();
                    {
                        let mut slots = hub.slots.lock().unwrap();
                        for (id, slot) in slots.iter_mut() {
                            if slot.ready {
                                slot.ready = false;
                                scratch.clear();
                                std::mem::swap(&mut scratch, &mut slot.rgba);
                                work.push((id.clone(), std::mem::take(&mut scratch)));
                            }
                        }
                    }
                    if work.is_empty() {
                        continue;
                    }
                    let mut thumbs = Vec::with_capacity(work.len());
                    for (id, rgba) in &work {
                        if rgba.len() != (graph::THUMB_W * graph::THUMB_H * 4) as usize {
                            continue;
                        }
                        jpg.clear();
                        let enc = jpeg_encoder::Encoder::new(&mut jpg, 62);
                        if enc
                            .encode(
                                rgba,
                                graph::THUMB_W as u16,
                                graph::THUMB_H as u16,
                                jpeg_encoder::ColorType::Rgba,
                            )
                            .is_ok()
                        {
                            #[cfg(debug_assertions)]
                            if dumped.insert(id.clone()) {
                                let _ = std::fs::create_dir_all("/tmp/producer-thumbs");
                                let _ = std::fs::write(
                                    format!("/tmp/producer-thumbs/{id}.jpg"),
                                    &jpg,
                                );
                            }
                            thumbs.push(GuestThumb {
                                id: id.clone(),
                                jpeg: base64::engine::general_purpose::STANDARD.encode(&jpg),
                            });
                        }
                    }
                    // hand buffers back so the graphics thread reuses them
                    {
                        let mut slots = hub.slots.lock().unwrap();
                        for (id, rgba) in work {
                            if let Some(slot) = slots.get_mut(&id) {
                                if slot.rgba.capacity() == 0 {
                                    slot.rgba = rgba;
                                }
                            }
                        }
                    }
                    if !thumbs.is_empty() {
                        sink(&LiveEvent::GuestThumbs {
                            w: graph::THUMB_W,
                            h: graph::THUMB_H,
                            thumbs,
                        });
                    }
                }
            })
            .expect("spawn thumb-encoder thread");
    }
    let hub_engine = hub.clone();
    let snapshot = Arc::new(Mutex::new(Snapshot::default()));
    let streaming = Arc::new(AtomicBool::new(false));
    let snap = snapshot.clone();
    let streaming_flag = streaming.clone();

    std::thread::Builder::new()
        .name("live-engine".into())
        .spawn(move || {
            let report = bootstrap_with_config(Some(&module_config_dir));
            {
                let mut s = snap.lock().unwrap();
                s.engine_ready = true;
                s.bootstrap_ok = report.ok;
                let (h, f) = stored_video(Some(&module_config_dir));
                s.video_height = h;
                s.video_fps = f;
                s.graphics_backend = report.graphics_backend.clone();
            }
            if report.ok {
                // Preview capture rides the compositor: registered once, for
                // the life of the process. hub_engine's Arc keeps it alive.
                unsafe {
                    ffi::obs_add_main_render_callback(
                        graph::thumb_render_cb,
                        std::sync::Arc::as_ptr(&hub_engine) as *mut std::os::raw::c_void,
                    );
                }
            }
            sink(&LiveEvent::EngineReady {
                ok: report.ok,
                graphics_backend: report.graphics_backend.clone(),
                obs_version: report.obs_version.clone(),
            });

            // The implicit scene (§2.2) exists from engine start; sources are
            // added/removed by user toggles (which is when TCC prompts fire).
            // Recording lives beside the session, not inside it: you can
            // record without streaming and keep recording after a stream ends.
            let mut recorder: Option<record::Recorder> = None;
            // The virtual camera runs independently of streaming and
            // recording — all three can be on at once.
            let mut vcam: Option<*mut ffi::obs_output_t> = None;
            let mut scene = if report.ok {
                match graph::SceneGraph::create() {
                    Ok(s) => Some(s),
                    Err(e) => {
                        sink(&LiveEvent::EngineError {
                            message: format!("scene create failed: {e}"),
                        });
                        None
                    }
                }
            } else {
                None
            };
            let mut preview: Option<Preview> = None;
            let mut session: Option<Session> = None;
            let mut state = SessionState::Idle;
            let mut last_status_emit = Instant::now();
            let mut last_levels_emit = Instant::now();
            // CPU needs a persistent sampler: one reading has nothing to
            // compare against, so the value only means anything over time.
            let cpu_info: *mut c_void = unsafe { ffi::os_cpu_usage_info_start() };
            let mut last_perf = Instant::now();

            let set_state = |state: &mut SessionState,
                             new: SessionState,
                             snap: &Arc<Mutex<Snapshot>>,
                             sink: &dyn Fn(&LiveEvent)| {
                if *state != new {
                    *state = new;
                    snap.lock().unwrap().session_state = new;
                    sink(&LiveEvent::SessionState { state: new });
                }
            };

            loop {
                // Performance is sampled whether or not a session is running:
                // FPS and CPU tell you the machine is struggling BEFORE you go
                // live, which is when the information is still actionable.
                if last_perf.elapsed() > Duration::from_secs(1) {
                    last_perf = Instant::now();
                    unsafe {
                        let video = ffi::obs_get_video();
                        let (total, skipped) = if video.is_null() {
                            (0, 0)
                        } else {
                            (
                                ffi::video_output_get_total_frames(video),
                                ffi::video_output_get_skipped_frames(video),
                            )
                        };
                        let fps = ffi::obs_get_active_fps();
                        let cpu = if cpu_info.is_null() {
                            0.0
                        } else {
                            ffi::os_cpu_usage_info_query(cpu_info)
                        };
                        let mut sn = snap.lock().unwrap();
                        sn.fps = fps;
                        sn.total_frames = total;
                        sn.skipped_frames = skipped;
                        sn.cpu = cpu;
                    }
                }

                // 120ms tick: meters want ~8Hz; command latency stays low.
                match cmd_rx.recv_timeout(Duration::from_millis(120)) {
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
                            match Session::start(config) {
                                Ok(s) => {
                                    session = Some(s);
                                    streaming_flag.store(true, AtomicOrdering::SeqCst);
                                    set_state(&mut state, SessionState::Streaming, &snap, &sink);
                                }
                                Err(failed_report) => {
                                    sink(&LiveEvent::SessionEnded {
                                        report: failed_report,
                                    });
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
                    Ok(Command::SetSources {
                        screen,
                        camera,
                        mic,
                    }) => {
                        if let Some(g) = scene.as_mut() {
                            for (label, result) in [
                                ("screen", g.set_screen(screen)),
                                ("camera", g.set_camera(camera)),
                                ("mic", g.set_mic(mic)),
                            ] {
                                if let Err(e) = result {
                                    sink(&LiveEvent::EngineError {
                                        message: format!("{label}: {e}"),
                                    });
                                }
                            }
                            let sources = g.state();
                            snap.lock().unwrap().sources = sources.clone();
                            sink(&LiveEvent::SourcesChanged { sources });
                        }
                    }
                    Ok(Command::SetMicAudio { volume, muted }) => {
                        if let Some(g) = scene.as_mut() {
                            g.set_mic_audio(volume, muted);
                            let sources = g.state();
                            snap.lock().unwrap().sources = sources.clone();
                            sink(&LiveEvent::SourcesChanged { sources });
                        }
                    }
                    Ok(Command::SetTransform { id, patch, commit }) => {
                        if let Some(g) = scene.as_mut() {
                            if let Err(e) = g.set_transform(&id, &patch) {
                                sink(&LiveEvent::EngineError { message: e });
                            } else if commit {
                                let sources = g.state();
                                snap.lock().unwrap().sources = sources.clone();
                                sink(&LiveEvent::SourcesChanged { sources });
                            }
                        }
                    }
                    Ok(Command::ListDevices { kind, reply }) => {
                        let list = match scene.as_ref() {
                            Some(g) => g.devices(&kind),
                            None => graph::devices_for(&kind),
                        };
                        let _ = reply.send(list);
                    }
                    Ok(Command::PlayStinger { path, reply }) => {
                        let r = match scene.as_mut() {
                            Some(g) => g.play_stinger(&path),
                            None => Err("no scene".into()),
                        };
                        if let Err(e) = &r {
                            sink(&LiveEvent::EngineError { message: e.clone() });
                        }
                        let _ = reply.send(r);
                    }
                    Ok(Command::StartRecording { stamp, reply }) => {
                        if recorder.is_some() {
                            let _ = reply.send(Err("already recording".into()));
                        } else {
                            // Recording rides the same canvas as the stream at
                            // a quality bitrate; 1080p gets more headroom.
                            let br = if snap.lock().unwrap().video_height >= 1080 { 12000 } else { 8000 };
                            match record::Recorder::start(&stamp, br) {
                                Ok(r) => {
                                    let p = r.path();
                                    recorder = Some(r);
                                    let _ = reply.send(Ok(p));
                                }
                                Err(e) => {
                                    sink(&LiveEvent::EngineError { message: e.clone() });
                                    let _ = reply.send(Err(e));
                                }
                            }
                        }
                    }
                    Ok(Command::StopRecording { reply }) => {
                        let _ = reply.send(recorder.take().map(|r| r.stop()));
                    }
                    Ok(Command::SetSyncOffset { id, ms }) => {
                        if let Some(g) = scene.as_mut() {
                            match g.set_sync_offset(&id, ms) {
                                Ok(()) => {
                                    let sources = g.state();
                                    snap.lock().unwrap().sources = sources.clone();
                                    sink(&LiveEvent::SourcesChanged { sources });
                                }
                                Err(e) => sink(&LiveEvent::EngineError { message: e }),
                            }
                        }
                    }
                    Ok(Command::SetSourceAudio { id, volume, muted }) => {
                        if let Some(g) = scene.as_mut() {
                            match g.set_source_audio(&id, volume, muted) {
                                Ok(()) => {
                                    let sources = g.state();
                                    snap.lock().unwrap().sources = sources.clone();
                                    sink(&LiveEvent::SourcesChanged { sources });
                                }
                                Err(e) => sink(&LiveEvent::EngineError { message: e }),
                            }
                        }
                    }
                    Ok(Command::SetItemOpacity { id, opacity }) => {
                        if let Some(g) = scene.as_ref() {
                            if let Some(src) = g.source_by_id(&id) {
                                let _ = super::filters::set_opacity(src, opacity);
                            }
                        }
                    }
                    Ok(Command::Filters { source, op, reply }) => {
                        let r = (|| -> Result<Vec<super::filters::FilterState>, String> {
                            let g = scene.as_ref().ok_or("no scene")?;
                            let src = g
                                .source_by_id(&source)
                                .ok_or_else(|| format!("{source} is not on the stage"))?;
                            match &op {
                                FilterOp::List => {}
                                FilterOp::Add { kind, name } => super::filters::add(src, kind, name)?,
                                FilterOp::Remove { name } => super::filters::remove(src, name)?,
                                FilterOp::Enable { name, on } => {
                                    super::filters::set_enabled(src, name, *on)?
                                }
                                FilterOp::Reorder { name, movement } => {
                                    super::filters::reorder(src, name, *movement)?
                                }
                                FilterOp::Update { name, settings } => {
                                    super::filters::update(src, name, settings)?
                                }
                            }
                            Ok(super::filters::list(src))
                        })();
                        if let Err(e) = &r {
                            sink(&LiveEvent::EngineError { message: e.clone() });
                        }
                        let _ = reply.send(r);
                    }
                    Ok(Command::SetVirtualCam { on, reply }) => {
                        let r = (|| -> Result<bool, String> {
                            unsafe {
                                if !on {
                                    if let Some(o) = vcam.take() {
                                        ffi::obs_output_stop(o);
                                        ffi::obs_output_release(o);
                                    }
                                    return Ok(false);
                                }
                                if vcam.is_some() {
                                    return Ok(true);
                                }
                                let id = CString::new("virtualcam_output").unwrap();
                                let name = CString::new("Producer Virtual Camera").unwrap();
                                let out = ffi::obs_output_create(
                                    id.as_ptr(),
                                    name.as_ptr(),
                                    ptr::null_mut(),
                                    ptr::null_mut(),
                                );
                                if out.is_null() {
                                    return Err("this engine has no virtual camera output".into());
                                }
                                if !ffi::obs_output_start(out) {
                                    let e = ffi::obs_output_get_last_error(out);
                                    // Upstream's text is OBS-branded; it reaches
                                    // the user as a command error, which never
                                    // passes through the event sink.
                                    let msg = if e.is_null() {
                                        "the virtual camera refused to start — is the extension approved?".to_string()
                                    } else {
                                        user_facing(&CStr::from_ptr(e).to_string_lossy())
                                    };
                                    ffi::obs_output_release(out);
                                    return Err(msg);
                                }
                                vcam = Some(out);
                                Ok(true)
                            }
                        })();
                        if let Err(e) = &r {
                            sink(&LiveEvent::EngineError { message: e.clone() });
                        }
                        let _ = reply.send(r);
                    }
                    Ok(Command::PrepareStinger { path }) => {
                        if let Some(g) = scene.as_mut() {
                            if let Err(e) = g.prepare_stinger(&path) {
                                sink(&LiveEvent::EngineError { message: e });
                            }
                        }
                    }
                    Ok(Command::StopStinger) => {
                        if let Some(g) = scene.as_mut() {
                            // Hide, don't destroy: the next cut reuses it.
                            g.hide_stinger();
                        }
                    }
                    Ok(Command::SetDevice { kind, device }) => {
                        if let Some(g) = scene.as_mut() {
                            match g.set_device(&kind, &device) {
                                Ok(()) => {
                                    let sources = g.state();
                                    snap.lock().unwrap().sources = sources.clone();
                                    sink(&LiveEvent::SourcesChanged { sources });
                                }
                                Err(e) => sink(&LiveEvent::EngineError { message: e }),
                            }
                        }
                    }
                    Ok(Command::AddExtra { id, label, spec }) => {
                        if let Some(g) = scene.as_mut() {
                            match g.add_extra(&id, &label, &spec) {
                                Ok(()) => {
                                    let sources = g.state();
                                    snap.lock().unwrap().sources = sources.clone();
                                    sink(&LiveEvent::SourcesChanged { sources });
                                }
                                Err(e) => sink(&LiveEvent::EngineError { message: e }),
                            }
                        }
                    }
                    Ok(Command::RemoveExtra { id }) => {
                        if let Some(g) = scene.as_mut() {
                            match g.remove_extra(&id) {
                                Ok(()) => {
                                    let sources = g.state();
                                    snap.lock().unwrap().sources = sources.clone();
                                    sink(&LiveEvent::SourcesChanged { sources });
                                }
                                Err(e) => sink(&LiveEvent::EngineError { message: e }),
                            }
                        }
                    }
                    Ok(Command::SetThumbRate { fps }) => {
                        hub_engine
                            .fps
                            .store(fps.min(30), std::sync::atomic::Ordering::Relaxed);
                    }
                    Ok(Command::SetVideo { height, fps }) => {
                        if session.is_some() {
                            sink(&LiveEvent::EngineError {
                                message: "stop the stream to change video settings".into(),
                            });
                        } else if !(height == 720 || height == 1080) || !(fps == 30 || fps == 60) {
                            sink(&LiveEvent::EngineError {
                                message: "video settings must be 720p/1080p at 30/60fps".into(),
                            });
                        } else {
                            let module = graphics_module(report.graphics_backend.as_deref());
                            match reset_video(module, height, fps) {
                                Ok(()) => {
                                    if let Some(g) = scene.as_mut() {
                                        g.relayout();
                                    }
                                    {
                                        let mut sn = snap.lock().unwrap();
                                        sn.video_height = height;
                                        sn.video_fps = fps;
                                    }
                                    persist_video(&module_config_dir, height, fps);
                                    sink(&LiveEvent::VideoChanged { height, fps });
                                }
                                Err(rc) => sink(&LiveEvent::EngineError {
                                    message: format!("video reset failed (rc={rc})"),
                                }),
                            }
                        }
                    }
                    Ok(Command::SetOverlay(spec)) => {
                        if let Some(g) = scene.as_mut() {
                            if let Err(e) = g.set_overlay(spec) {
                                sink(&LiveEvent::EngineError {
                                    message: format!("overlay: {e}"),
                                });
                            }
                            let sources = g.state();
                            snap.lock().unwrap().sources = sources.clone();
                            sink(&LiveEvent::SourcesChanged { sources });
                        }
                    }
                    Ok(Command::AttachPreview { window, rect }) => {
                        if preview.is_none() {
                            match Preview::attach(window as *mut std::os::raw::c_void, rect) {
                                Ok(p) => {
                                    preview = Some(p);
                                    snap.lock().unwrap().preview_attached = true;
                                }
                                Err(e) => sink(&LiveEvent::EngineError {
                                    message: format!("preview attach failed: {e}"),
                                }),
                            }
                        }
                    }
                    Ok(Command::MovePreview(rect)) => {
                        if let Some(p) = preview.as_mut() {
                            p.set_rect(rect);
                        }
                    }
                    Ok(Command::SetPreviewHidden(hidden)) => {
                        if let Some(p) = preview.as_ref() {
                            unsafe {
                                ffi::producer_preview_set_hidden(p.view, if hidden { 1 } else { 0 })
                            };
                        }
                    }
                    Ok(Command::DetachPreview) => {
                        if let Some(p) = preview.take() {
                            p.detach();
                            snap.lock().unwrap().preview_attached = false;
                        }
                    }
                    Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if let Some(p) = preview.take() {
                            p.detach();
                        }
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
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if let Some(g) = scene.as_ref() {
                            hub_engine.publish_targets(g);
                        }
                    }
                }

                // Meter stream — while a mic OR any metered extra (guest,
                // media) exists; guests must meter with the host mic off.
                if scene
                    .as_ref()
                    .is_some_and(|g| g.state().mic || !g.take_extra_peaks_ids_empty())
                    && last_levels_emit.elapsed() > Duration::from_millis(110)
                {
                    last_levels_emit = Instant::now();
                    sink(&LiveEvent::Levels {
                        mic_peak: graph::take_mic_peak(),
                        extra_peaks: scene
                            .as_ref()
                            .map(|g| {
                                g.take_extra_peaks()
                                    .into_iter()
                                    .map(|(id, peak)| ExtraPeak { id, peak })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    });
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
                        {
                            let mut sn = snap.lock().unwrap();
                            sn.thumb_wait_us_max = hub_engine
                                .readback_wait_us_max
                                .load(std::sync::atomic::Ordering::Relaxed);
                            sn.thumb_slow_maps = hub_engine
                                .readback_slow_maps
                                .load(std::sync::atomic::Ordering::Relaxed);
                        }
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
