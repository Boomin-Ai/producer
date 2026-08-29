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
#[cfg(target_os = "macos")]
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
#[cfg(target_os = "macos")]
const REQUIRED_ENCODERS: &[&str] = &["obs_x264", "CoreAudio_AAC"];
#[cfg(target_os = "macos")]
const VT_ENCODER_SUBSTRING: &str = "videotoolbox";

#[cfg(target_os = "windows")]
const REQUIRED_SOURCES: &[&str] = &[
    "monitor_capture",       // win-capture (display: DXGI/WGC)
    "window_capture",        // win-capture
    "wasapi_input_capture",  // win-wasapi (mic)
    "wasapi_output_capture", // win-wasapi (desktop audio)
    "dshow_input",           // win-dshow (webcam)
    "image_source",          // image-source (image/GIF)
    "text_gdiplus",          // obs-text
    "color_source",
];
#[cfg(target_os = "windows")]
const REQUIRED_ENCODERS: &[&str] = &["obs_x264", "ffmpeg_aac"];
/// Hardware encoders are dynamic (NVENC/QSV/AMF register only when the GPU
/// supports them); reported by substring, preferred at stream setup, never
/// required.
#[cfg(target_os = "windows")]
const VT_ENCODER_SUBSTRING: &str = "nvenc";
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

/// Windows: none of the allowlisted plugins issue OBS_TASK_UI work (that is a
/// Qt-frontend pattern); run any task inline on the calling thread. Revisited
/// at the preview milestone if a plugin proves otherwise.
#[cfg(target_os = "windows")]
extern "C" fn ui_task_handler(task: ffi::obs_task_t, param: *mut c_void, _wait: bool) {
    task(param);
}

/// Marshal an OBS UI task onto the macOS main thread (GCD main queue).
/// `wait` tasks run synchronously; nested main-thread calls run inline to
/// avoid deadlocking dispatch_sync on the main queue.
#[cfg(target_os = "macos")]
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
    #[cfg(target_os = "macos")]
    if let Ok(plugins_dir) = std::env::var("PRODUCER_ENGINE_PLUGINS") {
        let bin = CString::new(format!("{plugins_dir}/%module%.plugin/Contents/MacOS")).unwrap();
        let data =
            CString::new(format!("{plugins_dir}/%module%.plugin/Contents/Resources")).unwrap();
        unsafe { ffi::obs_add_module_path(bin.as_ptr(), data.as_ptr()) };
    }

    // Windows layout law: everything lives beside Producer.exe (build.rs copies
    // the artifact there for dev; the installer places it there for real).
    //   <exe>/obs-plugins/64bit/*.dll + <exe>/data/obs-plugins/<module>/
    //   <exe>/data/libobs/  (effect shaders — libobs finds these only if told)
    #[cfg(target_os = "windows")]
    {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        let norm = |p: std::path::PathBuf| p.to_string_lossy().replace('\\', "/");
        let libobs_data = CString::new(format!("{}/", norm(exe_dir.join("data/libobs")))).unwrap();
        unsafe { ffi::obs_add_data_path(libobs_data.as_ptr()) };
        let bin = CString::new(norm(exe_dir.join("obs-plugins/64bit"))).unwrap();
        let data = CString::new(format!(
            "{}/%module%",
            norm(exe_dir.join("data/obs-plugins"))
        ))
        .unwrap();
        unsafe { ffi::obs_add_module_path(bin.as_ptr(), data.as_ptr()) };
    }

    // macOS: Metal preferred, OpenGL fallback (A5 / F9).
    // Windows: D3D11 is THE renderer (OBS's own default), OpenGL fallback.
    // Record the actual backend either way.
    #[cfg(target_os = "macos")]
    let (primary, primary_name, fallback, fallback_name) = (
        "libobs-metal.dylib",
        "metal",
        "libobs-opengl.dylib",
        "opengl",
    );
    #[cfg(target_os = "windows")]
    let (primary, primary_name, fallback, fallback_name) =
        ("libobs-d3d11.dll", "d3d11", "libobs-opengl.dll", "opengl");
    match reset_video(primary) {
        Ok(()) => report.graphics_backend = Some(primary_name.into()),
        Err(primary_rc) => match reset_video(fallback) {
            Ok(()) => {
                report.graphics_backend = Some(fallback_name.into());
                report.errors.push(format!(
                    "{primary_name} backend unavailable (rc={primary_rc}), fell back to {fallback_name}"
                ));
            }
            Err(fb_rc) => {
                report.errors.push(format!(
                    "obs_reset_video failed: {primary_name} rc={primary_rc}, {fallback_name} rc={fb_rc}"
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

pub enum Command {
    GoLive(MultiConfig),
    StopLive,
    SetSources {
        screen: bool,
        camera: bool,
        mic: bool,
    },
    SetOverlay {
        window_id: Option<u32>,
        color_key: bool,
    },
    /// Enumerate capturable windows on the engine thread (Windows: via OBS
    /// source properties; macOS answers via the CGWindow shim without this).
    ListWindows {
        reply: mpsc::Sender<serde_json::Value>,
    },
    AttachPreview {
        /// NSWindow* of the Tauri window, as usize.
        window: usize,
        rect: PreviewRect,
    },
    MovePreview(PreviewRect),
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
    pub sources: graph::SourcesState,
    pub preview_attached: bool,
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
    pub fn set_overlay(&self, window_id: Option<u32>, color_key: bool) -> Result<(), String> {
        self.cmd
            .send(Command::SetOverlay {
                window_id,
                color_key,
            })
            .map_err(|e| e.to_string())
    }
    pub fn list_windows(&self) -> Result<serde_json::Value, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::ListWindows { reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "window enumeration timed out".to_string())
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
    {
        static FIRST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
        if FIRST.swap(false, std::sync::atomic::Ordering::Relaxed) {
            eprintln!("[live] preview_draw first frame ({_cx}x{_cy})");
        }
    }
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
        ffi::gs_set_viewport(0, 0, _cx as i32, _cy as i32);
        ffi::gs_ortho(0.0, bw, 0.0, bh, -100.0, 100.0);
        // Render the channel-0 scene source DIRECTLY (the OBS source-projector
        // pattern). obs_render_main_texture draws the cached mix texture,
        // which libobs only renders while an encoder or raw consumer is
        // active — an idle preview showed black forever (M-W6 finding).
        // Blit the courier frame (see preview_pipeline_tap) — a CPU-uploaded
        // dynamic texture drawn with the default effect, the cursor-proven
        // path. The texture lives across frames; recreated on size change.
        {
            static mut PREVIEW_TEX: *mut ffi::gs_texture_t = std::ptr::null_mut();
            static mut TEX_W: u32 = 0;
            static mut TEX_H: u32 = 0;
            let mut guard = PREVIEW_FRAME.lock().unwrap();
            if let Some(frame) = guard.as_mut() {
                if PREVIEW_TEX.is_null() || TEX_W != frame.width || TEX_H != frame.height {
                    if !PREVIEW_TEX.is_null() {
                        ffi::gs_texture_destroy(PREVIEW_TEX);
                    }
                    PREVIEW_TEX = ffi::gs_texture_create(
                        frame.width,
                        frame.height,
                        ffi::GS_BGRA,
                        1,
                        std::ptr::null_mut(),
                        ffi::GS_DYNAMIC,
                    );
                    TEX_W = frame.width;
                    TEX_H = frame.height;
                }
                if !PREVIEW_TEX.is_null() {
                    if frame.dirty {
                        ffi::gs_texture_set_image(
                            PREVIEW_TEX,
                            frame.data.as_ptr(),
                            frame.width * 4,
                            false,
                        );
                        frame.dirty = false;
                    }
                    let effect = ffi::obs_get_base_effect(ffi::OBS_EFFECT_DEFAULT);
                    if !effect.is_null() {
                        let image = std::ffi::CString::new("image").unwrap();
                        let tech = std::ffi::CString::new("Draw").unwrap();
                        let param = ffi::gs_effect_get_param_by_name(effect, image.as_ptr());
                        ffi::gs_effect_set_texture(param, PREVIEW_TEX);
                        while ffi::gs_effect_loop(effect, tech.as_ptr()) {
                            ffi::gs_draw_sprite(PREVIEW_TEX, 0, frame.width, frame.height);
                        }
                    }
                }
            }
        }
        ffi::gs_projection_pop();
        ffi::gs_viewport_pop();
    }
}

/// Preview frame courier (M-W6 final form): libobs hands us BGRA canvas
/// frames on the CPU (the raw tap requests conversion); preview_draw uploads
/// them to a dynamic texture and blits. CPU-uploaded textures are the ONE
/// draw path proven to present in our display context (the cursor test) —
/// every GPU-texture route (main texture, source render, DrawMultiply/scRGB)
/// rendered black there on this HDR desktop.
struct PreviewFrame {
    data: Vec<u8>,
    width: u32,
    height: u32,
    dirty: bool,
}
static PREVIEW_FRAME: std::sync::Mutex<Option<PreviewFrame>> = std::sync::Mutex::new(None);

extern "C" fn preview_pipeline_tap(_param: *mut c_void, frame: *mut ffi::video_data) {
    unsafe {
        if frame.is_null() {
            return;
        }
        let f = &*frame;
        let src = f.data[0];
        let linesize = f.linesize[0] as usize;
        if src.is_null() || linesize == 0 {
            return;
        }
        // Requested conversion: BGRA 1280x720 (see attach).
        let (w, h) = (1280u32, 720u32);
        let row = (w as usize) * 4;
        let mut guard = PREVIEW_FRAME.lock().unwrap();
        let slot = guard.get_or_insert_with(|| PreviewFrame {
            data: vec![0u8; row * h as usize],
            width: w,
            height: h,
            dirty: false,
        });
        for y in 0..h as usize {
            let s = std::slice::from_raw_parts(src.add(y * linesize), row);
            slot.data[y * row..(y + 1) * row].copy_from_slice(s);
        }
        slot.dirty = true;
    }
}

/// Windows preview (M-W6): the command layer creates/moves/destroys the child
/// HWND on the MAIN thread (cross-thread child windows link input queues with
/// the webview thread — the M-W6 crash finding); the engine receives the
/// child hwnd and owns ONLY the obs_display bound to it. rect values arrive
/// as device pixels (pre-scaled by the command layer).
#[cfg(target_os = "windows")]
impl Preview {
    fn attach(child: *mut std::os::raw::c_void, rect: PreviewRect) -> Result<Preview, String> {
        unsafe {
            let init = ffi::gs_init_data {
                window: ffi::gs_window { view: child },
                cx: (rect.w as u32).max(1),
                cy: (rect.h as u32).max(1),
                num_backbuffers: 0,
                format: ffi::GS_BGRA,
                zsformat: ffi::GS_ZS_NONE,
                adapter: 0,
            };
            let display = ffi::obs_display_create(&init, 0);
            if display.is_null() {
                return Err("obs_display_create failed".into());
            }
            ffi::obs_display_add_draw_callback(display, preview_draw, std::ptr::null_mut());
            // OBS projector pattern: take a SHOWING ref on the previewed
            // source. Without it, capture sources never mark as shown while
            // idle (no encoder/raw consumer) and produce nothing (M-W6).
            let scene_src = ffi::obs_get_output_source(0);
            if !scene_src.is_null() {
                ffi::obs_source_inc_showing(scene_src);
                ffi::obs_source_release(scene_src);
            }
            // Frame courier (see preview_pipeline_tap): request BGRA 1280x720
            // conversion so the tap receives ready-to-upload frames.
            let conv = ffi::video_scale_info {
                format: ffi::VIDEO_FORMAT_BGRA,
                width: 1280,
                height: 720,
                range: 0,
                colorspace: 0,
            };
            ffi::obs_add_raw_video_callback(
                &conv as *const ffi::video_scale_info as *const c_void,
                preview_pipeline_tap,
                std::ptr::null_mut(),
            );
            eprintln!(
                "[live] preview display created: child={child:?} {}x{}",
                (rect.w as u32).max(1),
                (rect.h as u32).max(1)
            );
            Ok(Preview {
                view: child,
                display,
            })
        }
    }

    fn set_rect(&mut self, rect: PreviewRect) {
        unsafe {
            ffi::obs_display_resize(self.display, (rect.w as u32).max(1), (rect.h as u32).max(1));
        }
    }

    fn detach(self) {
        unsafe {
            ffi::obs_remove_raw_video_callback(preview_pipeline_tap, std::ptr::null_mut());
            let scene_src = ffi::obs_get_output_source(0);
            if !scene_src.is_null() {
                ffi::obs_source_dec_showing(scene_src);
                ffi::obs_source_release(scene_src);
            }
            ffi::obs_display_remove_draw_callback(self.display, preview_draw, std::ptr::null_mut());
            ffi::obs_display_destroy(self.display);
        }
    }
}

#[cfg(target_os = "macos")]
impl Preview {
    // A10 finding (crash 2026-08-28): libobs-metal's swapchain create/resize/
    // destroy are Swift and dispatch_assert the MAIN queue — OBS Studio's Qt
    // UI satisfies this implicitly. Per §5.1 these are AppKit-adjacent ops,
    // so every obs_display lifecycle call is marshalled to the main thread;
    // draw callbacks still run on the OBS graphics thread.
    fn attach(ns_window: *mut std::os::raw::c_void, rect: PreviewRect) -> Result<Preview, String> {
        unsafe {
            let (mut px_w, mut px_h) = (0f64, 0f64);
            let view = ffi::producer_preview_attach(
                ns_window, rect.x, rect.y, rect.w, rect.h, &mut px_w, &mut px_h,
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

            // The implicit scene (§2.2) exists from engine start; sources are
            // added/removed by user toggles (which is when TCC prompts fire).
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
            let mut dbg_tick: u64 = 0;
            let mut state = SessionState::Idle;
            let mut last_status_emit = Instant::now();

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
                            snap.lock().unwrap().sources = sources;
                            sink(&LiveEvent::SourcesChanged { sources });
                        }
                    }
                    Ok(Command::SetOverlay {
                        window_id,
                        color_key,
                    }) => {
                        if let Some(g) = scene.as_mut() {
                            if let Err(e) = g.set_overlay(window_id, color_key) {
                                sink(&LiveEvent::EngineError {
                                    message: format!("overlay: {e}"),
                                });
                            }
                            let sources = g.state();
                            snap.lock().unwrap().sources = sources;
                            sink(&LiveEvent::SourcesChanged { sources });
                        }
                    }
                    Ok(Command::ListWindows { reply }) => {
                        #[cfg(target_os = "windows")]
                        let _ = reply.send(graph::list_capture_windows());
                        #[cfg(not(target_os = "windows"))]
                        let _ = reply.send(serde_json::Value::Null);
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
                        // M-W6 diagnostic heartbeat: engine-truth of the
                        // screen source every ~5s while present.
                        dbg_tick += 1;
                        if dbg_tick % 25 == 0 {
                            if let Some(g) = scene.as_ref() {
                                g.debug_log();
                            }
                        }
                    }
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
