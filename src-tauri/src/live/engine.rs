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

pub enum Command {
    // Sent by the app on quit from M-L5's host contract; the startup probe
    // currently drops the sender instead, which shuts down the same way.
    #[allow(dead_code)]
    Shutdown,
}

/// Spawn the engine owner thread: bootstraps, reports, then holds the engine
/// until Shutdown. All libobs calls stay on this thread.
pub fn spawn() -> (mpsc::Sender<Command>, mpsc::Receiver<EngineReport>) {
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
    let (report_tx, report_rx) = mpsc::channel::<EngineReport>();
    std::thread::Builder::new()
        .name("live-engine".into())
        .spawn(move || {
            let report = bootstrap();
            let _ = report_tx.send(report);
            while let Ok(cmd) = cmd_rx.recv() {
                match cmd {
                    Command::Shutdown => break,
                }
            }
            if unsafe { ffi::obs_initialized() } {
                unsafe { ffi::obs_shutdown() };
            }
        })
        .expect("spawn live-engine thread");
    (cmd_tx, report_rx)
}
