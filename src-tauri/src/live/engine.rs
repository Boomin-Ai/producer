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
///
/// Split shared/per-os for the same reason the plugin allowlist is: the overlap
/// is stated ONCE, and the places where the platforms genuinely differ are
/// visible instead of implied. Nearly every macOS id here has a Windows
/// counterpart that is a different string for the same capability, which is
/// exactly the kind of mapping that rots silently when it is left implicit.
const REQUIRED_SOURCES_SHARED: &[&str] = &[
    "window_capture", // mac-capture (SCK window) / win-capture
    "image_source",   // image-source (image/GIF)
    "color_source",
    "browser_source", // obs-browser -- GUESTS ARE BROWSER SOURCES
];
#[cfg(target_os = "macos")]
const REQUIRED_SOURCES_OS: &[&str] = &[
    "screen_capture",          // mac-capture (ScreenCaptureKit display)
    "sck_audio_capture",       // mac-capture (desktop audio)
    "coreaudio_input_capture", // mac-capture (mic)
    "coreaudio_output_capture",
    "macos-avcapture", // mac-avcapture (webcam)
    "text_ft2_source", // text-freetype2
];
#[cfg(target_os = "windows")]
const REQUIRED_SOURCES_OS: &[&str] = &[
    "monitor_capture",       // win-capture (display)
    "wasapi_output_capture", // win-wasapi (desktop audio)
    "wasapi_input_capture",  // win-wasapi (mic)
    "dshow_input",           // win-dshow (webcam)
    "text_gdiplus",          // obs-text -- NOT text_ft2_source here
];
const REQUIRED_ENCODERS_SHARED: &[&str] = &["obs_x264"];
#[cfg(target_os = "macos")]
const REQUIRED_ENCODERS_OS: &[&str] = &["CoreAudio_AAC"];
#[cfg(target_os = "windows")]
/// ffmpeg_aac is obs-ffmpeg's AAC encoder; Windows has no CoreAudio encoder and
/// obs-ffmpeg is in the allowlist on both platforms, so this is the counterpart.
const REQUIRED_ENCODERS_OS: &[&str] = &["ffmpeg_aac"];
/// VideoToolbox is macOS hardware encode; its ids are hardware-dynamic, so it is
/// asserted by substring. Windows hardware encoders (obs-nvenc, obs-qsv11,
/// obs-ffmpeg's AMF) ARE in the Windows allowlist since artifact rev 6, but
/// each registers only when its vendor's GPU is present, so none can be
/// REQUIRED — the boot probe picks from what registered (encoders.rs
/// `choose_video`, NVENC → QSV → AMF → x264) and reports the choice.
#[cfg(target_os = "macos")]
const VT_ENCODER_SUBSTRING: &str = "videotoolbox";
const REQUIRED_OUTPUTS: &[&str] = &["rtmp_output", "flv_output"];
const REQUIRED_SERVICES: &[&str] = &["rtmp_common", "rtmp_custom"];

/// Whether the stage renders as a transparent hole (preview BELOW the
/// webview) — the UI mirrors this so its CSS matches the native stacking.
/// The warm CEF browser source (see the cef-warm thread in start()).
pub static CEF_WARM: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
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
    /// The H.264 encoder every session will use (encoders.rs), and whether
    /// it is a GPU encoder. Decided here, once, from what registered.
    pub video_encoder: String,
    pub hardware_encoder: bool,
    pub sources: Vec<String>,
    pub encoders: Vec<String>,
    pub outputs: Vec<String>,
    pub services: Vec<String>,
    pub errors: Vec<String>,
    /// Boot phase timings (name, ms) in order: startup, reset_video,
    /// reset_audio, load_modules (CEF initialises inside obs-browser's
    /// module load — on this critical path by obs-browser's own design),
    /// post_load. You cannot halve what you have not measured.
    pub boot_phases_ms: Vec<(String, u64)>,
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

/// Windows has no UI thread to marshal to: OBS_TASK_UI exists for a Qt
/// frontend and Producer has none. But a handler MUST be set --- obs.c drops
/// the task and logs "there's no UI task handler!" when it is null --- so run
/// it inline, which satisfies `wait` trivially and cannot deadlock.
#[cfg(target_os = "windows")]
extern "C" fn ui_task_handler(task: ffi::obs_task_t, param: *mut c_void, _wait: bool) {
    task(param);
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
    if backend == Some("metal") {
        "libobs-metal.dylib"
    } else {
        "libobs-opengl.dylib"
    }
}
#[cfg(target_os = "windows")]
fn graphics_module(backend: Option<&str>) -> &'static str {
    if backend == Some("d3d11") {
        "libobs-d3d11.dll"
    } else {
        "libobs-opengl.dll"
    }
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

/// The engine artifact root at RUNTIME, on Windows.
///
/// libobs finds its own data and its plugins through paths that are RELATIVE on
/// Windows (obs-windows.c: `../../obs-plugins/64bit`,
/// `../../data/obs-plugins/%module%`, and `../../data/libobs/` in
/// find_libobs_data_file). Those resolve against the PROCESS CWD, which is
/// correct for obs64.exe -- installed at bin/64bit and launched with that as its
/// working directory -- and is never correct for us: producer.exe lives
/// elsewhere and the CWD is wherever the user happened to launch from. So the
/// paths have to be registered explicitly, absolute, at boot.
///
/// PRODUCER_ENGINE_DIR is the dev override and matches the name build.rs
/// already uses at compile time. Otherwise the artifact sits beside the
/// executable, which is what bundling produces.
#[cfg(target_os = "windows")]
fn windows_engine_root() -> Option<std::path::PathBuf> {
    let looks_right = |p: &std::path::Path| p.join("obs-plugins/64bit").is_dir();
    if let Ok(dir) = std::env::var("PRODUCER_ENGINE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        if looks_right(&dir) {
            return Some(dir);
        }
    }
    // BESIDE THE EXECUTABLE, and nowhere else. There is exactly one valid
    // shipped layout on Windows, and it is not a choice: producer.exe imports
    // obs.dll statically, so the loader resolves it BEFORE any of our code runs,
    // and it searches the executable's own directory --- not subdirectories of
    // it. An engine at <exe_dir>/engine could never load at all, so probing for
    // one there would be a candidate we can never reach. The bundle must
    // flatten bin/ beside the exe, with obs-plugins/ and data/ as siblings.
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    if looks_right(&exe_dir) {
        return Some(exe_dir);
    }
    None
}

/// Full F3 bootstrap, HARNESS ENTRY ONLY. MUST be called on the live-engine
/// thread, never the main thread and never more than once per process.
///
/// A null module_config_dir makes obs_module_config_path fall back to the
/// PROCESS CWD, and plugins write there: win-capture drops
/// `win-capture/compatibility.json` beside whatever the user launched from.
/// Tolerable for a selftest, never for the shipped app --- so the app cannot
/// reach it. bootstrap_with_config takes a &Path, not an Option, and this is
/// the only route to None. The guard is the signature, not a runtime check.
pub fn bootstrap() -> EngineReport {
    bootstrap_inner(None)
}

/// The engine as the app boots it: a real config directory, always.
pub fn bootstrap_with_config(module_config_dir: &std::path::Path) -> EngineReport {
    bootstrap_inner(Some(module_config_dir))
}

/// module_config_path feeds obs_module_config_path() — obs-browser derives
/// its CEF cache dir from it (M-L7.1); harmless for every other plugin.
/// The video mode the user last chose, persisted beside the module config so
/// BOOT can start there directly — booting 720p30 and resetting to the stored
/// mode afterwards tears the Metal pipeline down on the main thread at every
/// room open (the beach ball).
/// The video modes the engine accepts: 720p/1080p/2160p at 30 or 60.
/// 2160p ("4K") is additionally gated at SetVideo on a hardware encoder —
/// a 3840×2160 canvas through x264 is not a product, it is a space heater.
pub fn video_mode_ok(height: u32, fps: u32) -> bool {
    matches!(height, 720 | 1080 | 2160) && matches!(fps, 30 | 60)
}

/// Local-recording bitrate for a canvas: quality-first, 2s keyframes.
/// 720p 8 Mbps, 1080p 12 Mbps, 2160p 20 Mbps at 30 / 30 Mbps at 60 (the
/// same ~1.7× step-up per resolution tier as 720→1080, doubled for the
/// pixel count, plus a frame-rate step that 1080p never needed).
pub fn record_kbps(height: u32, fps: u32) -> i64 {
    match (height, fps) {
        (2160, f) if f >= 60 => 30000,
        (2160, _) => 20000,
        (h, _) if h >= 1080 => 12000,
        _ => 8000,
    }
}

pub fn stored_video(dir: Option<&std::path::Path>) -> (u32, u32) {
    let fallback = (720u32, 30u32);
    let Some(dir) = dir else { return fallback };
    let Ok(txt) = std::fs::read_to_string(dir.join("video.json")) else {
        return fallback;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
        return fallback;
    };
    let h = v.get("h").and_then(|x| x.as_u64()).unwrap_or(720) as u32;
    let f = v.get("f").and_then(|x| x.as_u64()).unwrap_or(30) as u32;
    if video_mode_ok(h, f) {
        (h, f)
    } else {
        fallback
    }
}

pub fn persist_video(dir: &std::path::Path, h: u32, f: u32) {
    let _ = std::fs::write(dir.join("video.json"), format!("{{\"h\":{h},\"f\":{f}}}"));
}

fn bootstrap_inner(module_config_dir: Option<&std::path::Path>) -> EngineReport {
    let mut report = EngineReport {
        ok: false,
        obs_version: String::new(),
        graphics_backend: None,
        failed_modules: Vec::new(),
        missing_ids: Vec::new(),
        videotoolbox_encoders: Vec::new(),
        video_encoder: super::encoders::X264.into(),
        hardware_encoder: false,
        sources: Vec::new(),
        encoders: Vec::new(),
        outputs: Vec::new(),
        services: Vec::new(),
        errors: Vec::new(),
        boot_phases_ms: Vec::new(),
    };
    let mut phase_t = Instant::now();
    let mut phase = |report: &mut EngineReport, name: &str| {
        let ms = phase_t.elapsed().as_millis() as u64;
        report.boot_phases_ms.push((name.to_string(), ms));
        eprintln!("[live] boot phase {name}: {ms} ms");
        phase_t = Instant::now();
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
    //
    // Which origin that is depends on the ENDPOINT, not on Boomin: a
    // self-hosted producer-server (server/SELF_HOSTING.md) serves its own
    // guest render pages from its own worker origin, and Boomin serves
    // them from its web origin. So the allow-list must be derived per
    // endpoint (ipc::endpoint_access → origin of the room's render_url at
    // source creation, see graph.rs ExtraSpec::Guest), never hard-coded.
    // TODO(selfhost): once the permission handler exists, pass the guest
    // render origin(s) of every connected endpoint into it here.
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

    // Windows resolves libobs's own data and its plugin directory through paths
    // that are RELATIVE (obs-windows.c) and therefore CWD-dependent. Register
    // them absolutely instead -- see windows_engine_root(). The data path has to
    // be in place before startup, because the graphics module compiles libobs's
    // .effect files during obs_reset_video.
    #[cfg(target_os = "windows")]
    let _engine_root = windows_engine_root();
    #[cfg(target_os = "windows")]
    if let Some(root) = _engine_root.as_ref() {
        // The DirectShow virtual camera modules ride in the engine's plugin data.
        let dir = root.join("data").join("obs-plugins").join("win-dshow");
        if let Ok(c) = CString::new(dir.to_string_lossy().into_owned()) {
            unsafe { ffi::producer_vcam_set_module_dir(c.as_ptr()) };
        }
    }
    #[cfg(target_os = "windows")]
    match _engine_root.as_ref() {
        Some(root) => {
            // TRAILING SLASH IS LOAD-BEARING. libobs's check_path() does
            //     dstr_copy(out, path); dstr_cat(out, file);
            // with no separator inserted, so a path without one produces
            //     ...\data\libobsformat_conversion.effect
            // and every effect lookup fails. OBS's own defaults carry the slash.
            let data = format!("{}/", root.join("data/libobs").to_string_lossy());
            if let Ok(p) = CString::new(data) {
                unsafe { ffi::obs_add_data_path(p.as_ptr()) };
            }
        }
        None => report
            .errors
            .push("no engine artifact beside the executable; set PRODUCER_ENGINE_DIR".into()),
    }

    if !unsafe { ffi::obs_startup(locale.as_ptr(), config_ptr, ptr::null_mut()) } {
        report.errors.push("obs_startup failed".into());
        return report;
    }
    report.obs_version = unsafe { CStr::from_ptr(ffi::obs_get_version_string()) }
        .to_string_lossy()
        .into_owned();
    phase(&mut report, "startup");

    // §5.1: OBS UI tasks are marshalled to the macOS main thread from the start.
    unsafe { ffi::obs_set_ui_task_handler(ui_task_handler) };

    // Producer's own filters, registered like a plugin would but from the
    // shim: Cutout (person mask). Before modules load so it is present
    // whenever a scene config that names it is read.
    unsafe { ffi::producer_person_mask_register() };

    #[cfg(target_os = "macos")]
    // Dev-mode escape hatch: outside a .app bundle, NSBundle's builtInPlugInsURL
    // does not point at the engine artifact; allow an explicit override.
    if let Ok(plugins_dir) = std::env::var("PRODUCER_ENGINE_PLUGINS") {
        let bin = CString::new(format!("{plugins_dir}/%module%.plugin/Contents/MacOS")).unwrap();
        let data =
            CString::new(format!("{plugins_dir}/%module%.plugin/Contents/Resources")).unwrap();
        unsafe { ffi::obs_add_module_path(bin.as_ptr(), data.as_ptr()) };
    }

    // Windows: absolute paths in the shipped app too, not just as a dev escape
    // hatch -- see windows_engine_root(). The shapes are OBS's own Windows
    // install layout, which is exactly what the artifact mirrors.
    #[cfg(target_os = "windows")]
    if let Some(root) = _engine_root.as_ref() {
        let bin = CString::new(
            root.join("obs-plugins/64bit")
                .to_string_lossy()
                .into_owned(),
        );
        let data = CString::new(format!(
            "{}/%module%",
            root.join("data/obs-plugins").to_string_lossy()
        ));
        if let (Ok(bin), Ok(data)) = (bin, data) {
            unsafe { ffi::obs_add_module_path(bin.as_ptr(), data.as_ptr()) };
        }
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

    // libobs never initialises video->sdr_white_level; OBS Studio's frontend
    // sets it from its settings. On an scRGB (HDR) display the preview draws
    // the mix with technique DrawMultiply × (sdr_white / 80) — with 0 that is
    // a black stage over a perfectly rendered mix. Found on the Windows port
    // (HDR desk); SDR displays never take the branch. OBS's defaults.
    // 300/1000 are OBS Studio's defaults. On Windows, prefer the display's own
    // SDR white level (Settings > Display > SDR content brightness): the preview
    // and its outline then match the SDR desktop around them on an HDR monitor.
    #[cfg(target_os = "windows")]
    let sdr_white = {
        let nits = unsafe { ffi::producer_sdr_white_nits() };
        if nits > 0.0 {
            nits
        } else {
            300.0
        }
    };
    #[cfg(not(target_os = "windows"))]
    let sdr_white = 300.0;
    unsafe { ffi::obs_set_video_levels(sdr_white, 1000.0) };
    eprintln!("[engine] sdr white level = {sdr_white} nits");
    phase(&mut report, "reset_video");

    let oai = ffi::obs_audio_info {
        samples_per_sec: 48000,
        speakers: ffi::SPEAKERS_STEREO,
    };
    if !unsafe { ffi::obs_reset_audio(&oai) } {
        report.errors.push("obs_reset_audio failed".into());
        return report;
    }
    phase(&mut report, "reset_audio");

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
    phase(&mut report, "load_modules");

    // F3 ★: validate required IDs, then obs_post_load_modules. VideoToolbox
    // registers its encoders during post-load, so VT is re-checked after it.
    unsafe { ffi::obs_post_load_modules() };
    unsafe { ffi::obs_log_loaded_modules() };
    phase(&mut report, "post_load");

    report.sources = enum_ids(ffi::obs_enum_source_types);
    report.encoders = enum_ids(ffi::obs_enum_encoder_types);
    report.outputs = enum_ids(ffi::obs_enum_output_types);
    report.services = enum_ids(ffi::obs_enum_service_types);
    #[cfg(target_os = "macos")]
    {
        report.videotoolbox_encoders = report
            .encoders
            .iter()
            .filter(|id| id.to_lowercase().contains(VT_ENCODER_SUBSTRING))
            .cloned()
            .collect();
    }

    for (required, present) in [
        (REQUIRED_SOURCES_SHARED, &report.sources),
        (REQUIRED_SOURCES_OS, &report.sources),
        (REQUIRED_ENCODERS_SHARED, &report.encoders),
        (REQUIRED_ENCODERS_OS, &report.encoders),
        (REQUIRED_OUTPUTS, &report.outputs),
        (REQUIRED_SERVICES, &report.services),
    ] {
        for id in required {
            if !present.iter().any(|p| p == id) {
                report.missing_ids.push((*id).into());
            }
        }
    }
    #[cfg(target_os = "macos")]
    if report.videotoolbox_encoders.is_empty() {
        report.missing_ids.push("<any VideoToolbox encoder>".into());
    }

    // The encoder decision, from the ids that ACTUALLY registered (a Windows
    // hardware encoder plugin loads fine and registers nothing on the wrong
    // GPU). Published for multi/record/stream; surfaced to the UI below.
    let choice = super::encoders::choose_video(&report.encoders);
    eprintln!(
        "[live] video encoder: {} (hardware: {})",
        choice.id, choice.hardware
    );
    report.video_encoder = choice.id.clone();
    report.hardware_encoder = choice.hardware;
    super::encoders::set_chosen(choice);

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
    SetThumbRate {
        fps: u32,
    },
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
    /// Rects (CSS px, window client coords) the preview must not cover.
    SetPreviewCutouts(Vec<PreviewRect>),
    DetachPreview,
    Shutdown,
}

/// Variant name for the engine-loop stall log (no reflection in Rust).
fn cmd_name(c: &Command) -> &'static str {
    match c {
        Command::SetThumbRate { .. } => "SetThumbRate",
        Command::GoLive { .. } => "GoLive",
        Command::StopLive { .. } => "StopLive",
        Command::SetSources { .. } => "SetSources",
        Command::SetMicAudio { .. } => "SetMicAudio",
        Command::SetTransform { .. } => "SetTransform",
        Command::ListDevices { .. } => "ListDevices",
        Command::PlayStinger { .. } => "PlayStinger",
        Command::StartRecording { .. } => "StartRecording",
        Command::StopRecording { .. } => "StopRecording",
        Command::SetSyncOffset { .. } => "SetSyncOffset",
        Command::SetSourceAudio { .. } => "SetSourceAudio",
        Command::SetItemOpacity { .. } => "SetItemOpacity",
        Command::Filters { .. } => "Filters",
        Command::PrepareStinger { .. } => "PrepareStinger",
        Command::StopStinger { .. } => "StopStinger",
        Command::SetVirtualCam { .. } => "SetVirtualCam",
        Command::SetDevice { .. } => "SetDevice",
        Command::AddExtra { .. } => "AddExtra",
        Command::RemoveExtra { .. } => "RemoveExtra",
        Command::SetVideo { .. } => "SetVideo",
        Command::SetOverlay { .. } => "SetOverlay",
        Command::AttachPreview { .. } => "AttachPreview",
        Command::MovePreview { .. } => "MovePreview",
        Command::SetPreviewHidden { .. } => "SetPreviewHidden",
        Command::SetPreviewCutouts { .. } => "SetPreviewCutouts",
        Command::DetachPreview { .. } => "DetachPreview",
        Command::Shutdown { .. } => "Shutdown",
    }
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
        video_encoder: String,
        hw_encoder: bool,
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
    /// Boot phase timings from the EngineReport, for the room's own readout.
    #[serde(default)]
    pub boot_phases_ms: Vec<(String, u64)>,
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
    /// The H.264 encoder id every session uses (encoders.rs), and whether it
    /// is a GPU encoder — macOS VideoToolbox, Windows NVENC/QSV/AMF. The 4K
    /// canvas is gated on `hw_encoder`.
    #[serde(default)]
    pub video_encoder: Option<String>,
    #[serde(default)]
    pub hw_encoder: bool,
    /// 2160p at 60 is allowed. Intel Macs have VideoToolbox but not the
    /// throughput for 4K60; they get 2160p30 only. Apple silicon: both.
    #[serde(default)]
    pub hw_4k60: bool,
}

/// Intel Macs get 2160p30 only — the encoder exists, the headroom doesn't.
fn four_k_60_ok() -> bool {
    !(cfg!(target_os = "macos") && cfg!(target_arch = "x86_64"))
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
    pub fn set_preview_cutouts(&self, rects: Vec<PreviewRect>) -> Result<(), String> {
        self.cmd
            .send(Command::SetPreviewCutouts(rects))
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

static PREVIEW_DRAWS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The stage item the room has selected, by source name, drawn natively as an
/// outline + handles inside the preview. In float mode the preview HWND covers
/// the stage, so anything the webview paints over the video is hidden --- OBS
/// Studio draws its selection inside the display for the same reason.
pub static PREVIEW_SELECTION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn set_preview_selection(name: Option<String>) {
    *PREVIEW_SELECTION.lock().unwrap() = name;
}

/// Draw the selected item's outline and eight handles in the base (canvas)
/// coordinate space preview_draw already set up. 1-px line loops follow
/// rotation; handles are small quads centred on corners and edge midpoints.
#[cfg(target_os = "windows")]
unsafe fn draw_selection(bw: f32, bh: f32, cx: u32, cy: u32) {
    static ENTRIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let e = ENTRIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sel = PREVIEW_SELECTION.lock().unwrap().clone();
    if e % 600 == 0 {
        eprintln!("[selection] draw entry #{e}: selection = {sel:?}");
    }
    let Some(name) = sel else { return };
    let scene_src = ffi::obs_get_output_source(0);
    if scene_src.is_null() {
        if e % 600 == 0 {
            eprintln!("[selection] channel 0 is NULL");
        }
        return;
    }
    let scene = ffi::obs_scene_from_source(scene_src);
    let mut item: *mut ffi::obs_sceneitem_t = std::ptr::null_mut();
    if !scene.is_null() {
        // extras are named by their id; the built-ins by their labels
        for cand in [name.clone(), capitalize(&name)] {
            if let Ok(c) = CString::new(cand) {
                item = ffi::obs_scene_find_source(scene, c.as_ptr());
                if !item.is_null() {
                    break;
                }
            }
        }
    }
    ffi::obs_source_release(scene_src);
    static SEL_LOGS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let k = SEL_LOGS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if item.is_null() {
        if k % 300 == 0 {
            eprintln!("[selection] '{name}': no scene item by that name (scene={scene:?})");
        }
        return;
    }
    let mut m: ffi::matrix4 = std::mem::zeroed();
    ffi::obs_sceneitem_get_box_transform(item, &mut m);
    if k % 300 == 0 {
        eprintln!(
            "[selection] '{name}': box t=({:.0},{:.0}) x=({:.0},{:.0}) y=({:.0},{:.0}) display {cx}x{cy} base {bw}x{bh}",
            m.t.x, m.t.y, m.x.x, m.x.y, m.y.x, m.y.y
        );
    }
    let xf = |px: f32, py: f32| -> (f32, f32) {
        (
            m.x.x * px + m.y.x * py + m.t.x,
            m.x.y * px + m.y.y * py + m.t.y,
        )
    };
    // The box transform is the item's BOUNDS. With OBS_BOUNDS_SCALE_INNER the
    // (cropped) source is fitted inside those bounds and centred, so with a
    // crop -- or any aspect mismatch -- the picture occupies a smaller rect
    // than the box. Outline the picture, exactly as the macOS stage editor's
    // visRect() does; outlining the bounds draws a box around letterbox bars
    // and the red crop edge lands away from where the crop actually is.
    let mut crop: ffi::obs_sceneitem_crop = std::mem::zeroed();
    ffi::obs_sceneitem_get_crop(item, &mut crop);
    let (mut ox, mut oy, mut nw, mut nh) = (0.0f32, 0.0f32, 1.0f32, 1.0f32);
    let src = ffi::obs_sceneitem_get_source(item);
    if !src.is_null() {
        let sw = ffi::obs_source_get_width(src) as f32;
        let sh = ffi::obs_source_get_height(src) as f32;
        let bw_box = (m.x.x * m.x.x + m.x.y * m.x.y).sqrt();
        let bh_box = (m.y.x * m.y.x + m.y.y * m.y.y).sqrt();
        let cw = (sw - crop.left as f32 - crop.right as f32).max(1.0);
        let ch = (sh - crop.top as f32 - crop.bottom as f32).max(1.0);
        if sw > 0.0 && sh > 0.0 && bw_box > 0.0 && bh_box > 0.0 {
            let k = (bw_box / cw).min(bh_box / ch);
            let (vw, vh) = (cw * k, ch * k);
            ox = (bw_box - vw) / 2.0 / bw_box;
            oy = (bh_box - vh) / 2.0 / bh_box;
            nw = vw / bw_box;
            nh = vh / bh_box;
        }
    }
    let corners = [
        xf(ox, oy),
        xf(ox + nw, oy),
        xf(ox + nw, oy + nh),
        xf(ox, oy + nh),
    ];

    let solid = ffi::obs_get_base_effect(3); // OBS_EFFECT_SOLID
    if solid.is_null() {
        return;
    }
    let c_color = CString::new("color").unwrap();
    let c_tech = CString::new("Solid").unwrap();
    let param = ffi::gs_effect_get_param_by_name(solid, c_color.as_ptr());
    let tech = ffi::gs_effect_get_technique(solid, c_tech.as_ptr());
    if param.is_null() || tech.is_null() {
        return;
    }
    // Colours, colour-space aware. The solid effect writes the value as
    // given: on an SDR (sRGB) display that is the encoded colour; on the scRGB
    // (FP16) swapchain an HDR monitor gets, values are LINEAR and SDR white sits
    // at sdr_white_level/80 --- the same multiplier obs_render_main_texture
    // applies to the mix. Without it the outline reads dim and yellow-shifted.
    let space = ffi::gs_get_color_space();
    let scale = if space == 3 {
        ffi::obs_get_video_sdr_white_level() / 80.0
    } else {
        1.0
    };
    let col = |srgb: [f32; 3], lin: [f32; 3]| -> ffi::vec4 {
        if space == 3 || space == 2 {
            ffi::vec4 {
                x: lin[0] * scale,
                y: lin[1] * scale,
                z: lin[2] * scale,
                w: 1.0,
            }
        } else {
            ffi::vec4 {
                x: srgb[0],
                y: srgb[1],
                z: srgb[2],
                w: 1.0,
            }
        }
    };
    // Producer green (#22c55e) for the selection; the stage editor's crop red
    // (#ff5a5a, App.css .se-edge.cut) for any edge that has been cropped, so a
    // Windows room shows the same "which edges you took off" as macOS does
    // with its webview outline (hidden here under the float-mode preview).
    let green = col([0.133, 0.773, 0.369], [0.016, 0.560, 0.110]);
    let red = col([1.0, 0.353, 0.353], [1.0, 0.102, 0.102]);
    // edges in corner order: top (0->1), right (1->2), bottom (2->3), left (3->0)
    let edge_cut = [crop.top > 0, crop.right > 0, crop.bottom > 0, crop.left > 0];
    ffi::gs_effect_set_vec4(param, &green);
    // canvas px per display px, so handles keep a constant size on screen
    let sx = bw / cx.max(1) as f32;
    let sy = bh / cy.max(1) as f32;
    let handle = 7.0f32;
    let passes = ffi::gs_technique_begin(tech);
    for i in 0..passes {
        if !ffi::gs_technique_begin_pass(tech, i) {
            continue;
        }
        // outline: each edge its own 2-px line (two 1-px lines, one nudged),
        // coloured per edge so a cropped side reads red like the macOS editor.
        for e in 0..4 {
            ffi::gs_effect_set_vec4(param, if edge_cut[e] { &red } else { &green });
            let (ax, ay) = corners[e];
            let (bx, by) = corners[(e + 1) % 4];
            for nudge in [0.0f32, 1.0] {
                ffi::gs_render_start(true);
                ffi::gs_vertex2f(ax + nudge * sx, ay + nudge * sy);
                ffi::gs_vertex2f(bx + nudge * sx, by + nudge * sy);
                ffi::gs_render_stop(2); // GS_LINESTRIP
            }
        }
        ffi::gs_effect_set_vec4(param, &green);
        let mids = [
            (
                (corners[0].0 + corners[1].0) / 2.0,
                (corners[0].1 + corners[1].1) / 2.0,
            ),
            (
                (corners[1].0 + corners[2].0) / 2.0,
                (corners[1].1 + corners[2].1) / 2.0,
            ),
            (
                (corners[2].0 + corners[3].0) / 2.0,
                (corners[2].1 + corners[3].1) / 2.0,
            ),
            (
                (corners[3].0 + corners[0].0) / 2.0,
                (corners[3].1 + corners[0].1) / 2.0,
            ),
        ];
        for (x, y) in corners.iter().chain(mids.iter()) {
            ffi::gs_matrix_push();
            ffi::gs_matrix_translate3f(x - handle * sx / 2.0, y - handle * sy / 2.0, 0.0);
            ffi::gs_matrix_scale3f(handle * sx, handle * sy, 1.0);
            ffi::gs_draw_sprite(std::ptr::null_mut(), 0, 1, 1);
            ffi::gs_matrix_pop();
        }
        ffi::gs_technique_end_pass(tech);
    }
    ffi::gs_technique_end(tech);
}

#[cfg(target_os = "windows")]
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

extern "C" fn preview_draw(_param: *mut std::os::raw::c_void, cx: u32, cy: u32) {
    // Diagnostic breadcrumb for the Windows port: proves the display's draw
    // callback runs at all, and at what size. Throttled so it cannot flood.
    let n = PREVIEW_DRAWS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    if n == 1 || n == 30 || n % 600 == 0 {
        eprintln!("[preview] draw #{n} target {cx}x{cy}");
    }
    // Once: what does output channel 0 actually hold? Expected the "main" scene.
    // "Live Screen" means attach_capture_sources rebound it; null means the
    // probe path cleared it or SceneGraph::create failed silently.
    if n == 30 {
        unsafe {
            let src = ffi::obs_get_output_source(0);
            if src.is_null() {
                eprintln!("[preview] channel 0 = NULL");
            } else {
                let name = CStr::from_ptr(ffi::obs_source_get_name(src))
                    .to_string_lossy()
                    .into_owned();
                eprintln!(
                    "[preview] channel 0 = '{name}'  color space = {}",
                    ffi::gs_get_color_space()
                );
                ffi::obs_source_release(src);
            }
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
        ffi::gs_ortho(0.0, bw, 0.0, bh, -100.0, 100.0);
        ffi::obs_render_main_texture();
        // Windows float mode: the selection outline lives HERE, in the display
        // pass after the mix --- never in the mix itself, which feeds the
        // encoder, the recording, the virtual camera and the guests.
        #[cfg(target_os = "windows")]
        draw_selection(bw, bh, cx, cy);
        ffi::gs_projection_pop();
        ffi::gs_viewport_pop();
    }
}

/// Run a preview-window op on the thread that OWNS that window.
///
/// macOS: shim.m already wraps its own body in run_on_main, so calling straight
/// through is correct and double-marshalling would be the risk.
/// Windows: nothing marshals inside the C, the caller is the engine thread, and
/// the window belongs to main --- DestroyWindow in particular FAILS from any
/// other thread, which would silently leak the preview.
#[cfg(target_os = "macos")]
#[inline]
fn on_window_thread<T: Send + 'static, F: FnOnce() -> T + Send + 'static>(f: F) -> T {
    f()
}
#[cfg(target_os = "windows")]
#[inline]
fn on_window_thread<T: Send + 'static, F: FnOnce() -> T + Send + 'static>(f: F) -> T {
    graph::on_main_thread(f)
}

impl Preview {
    // A10 finding (crash 2026-08-28): libobs-metal's swapchain create/resize/
    // destroy are Swift and dispatch_assert the MAIN queue — OBS Studio's Qt
    // UI satisfies this implicitly. Per §5.1 these are AppKit-adjacent ops,
    // so every obs_display lifecycle call is marshalled to the main thread;
    // draw callbacks still run on the OBS graphics thread.
    fn attach(ns_window: *mut std::os::raw::c_void, rect: PreviewRect) -> Result<Preview, String> {
        unsafe {
            // Whether the stage is a transparent hole was decided (on the
            // main thread) by live_attach_preview before this command was
            // queued; here we only honour it.
            let transparent = STAGE_TRANSPARENT.load(AtomicOrdering::SeqCst);
            let t_shim = Instant::now();
            // THE WINDOW MUST BE CREATED ON THE MAIN THREAD. shim.m does this
            // internally with run_on_main; shim_win.c has no handle to tauri's event
            // loop, so the marshal lives here. A Win32 window belongs to its creating
            // thread, and that thread must pump messages -- an HWND made on the engine
            // thread hangs the UI as soon as the loop touches it.
            let (view, px) = {
                let (x, y, w, h) = (rect.x, rect.y, rect.w, rect.h);
                let parent = ns_window as usize;
                let t = transparent as i32;
                graph::on_main_thread(move || {
                    let (mut pw, mut ph) = (0f64, 0f64);
                    let v = {
                        ffi::producer_preview_attach(
                            parent as *mut std::os::raw::c_void,
                            x,
                            y,
                            w,
                            h,
                            t,
                            &mut pw,
                            &mut ph,
                        )
                    };
                    (v as usize, (pw, ph))
                })
            };
            let view = view as *mut std::os::raw::c_void;
            let (px_w, px_h) = px;
            {
                let ms = t_shim.elapsed().as_millis();

                if ms > 150 {
                    if let Some(dir) = crate::live::report_dir() {
                        use std::io::Write;

                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(dir.join("slow-cmds.log"))
                        {
                            let _ = f.write_all(format!("shim-attach {ms}ms\n").as_bytes());
                        }
                    }
                }
            }
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
            eprintln!(
                "[preview] display created: 0x{display_addr:x} view=0x{view_addr:x} {cx}x{cy}"
            );
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
            let v = self.view as usize;
            let (x, y, w, h) = (rect.x, rect.y, rect.w, rect.h);
            let (pw, ph) = on_window_thread(move || {
                let (mut pw, mut ph) = (0f64, 0f64);
                ffi::producer_preview_set_frame(
                    v as *mut std::os::raw::c_void,
                    x,
                    y,
                    w,
                    h,
                    &mut pw,
                    &mut ph,
                );
                (pw, ph)
            });
            px_w = pw;
            px_h = ph;
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
            let v = self.view as usize;
            on_window_thread(move || ffi::producer_preview_detach(v as *mut std::os::raw::c_void));
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
        // Same condition, each platform's own remedy: a system extension to
        // approve on macOS, a DirectShow filter to register on Windows.
        #[cfg(target_os = "macos")]
        return String::from("The virtual camera isn't installed yet. Approve Producer's camera extension in System Settings › General › Login Items & Extensions › Camera Extensions, then try again.");
        #[cfg(not(target_os = "macos"))]
        return String::from("The virtual camera isn't installed yet. Click Install cam, allow the prompt, then try again.");
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
                let mut dumped: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
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
                                let _ =
                                    std::fs::write(format!("/tmp/producer-thumbs/{id}.jpg"), &jpg);
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
            let report = bootstrap_with_config(&module_config_dir);
            // The real boot leaves its report on disk (beside the legacy
            // harness's), phases included — readable without a debugger.
            if let Some(dir) = module_config_dir.parent() {
                if let Ok(json) = serde_json::to_string_pretty(&report) {
                    let _ = std::fs::write(dir.join("engine-report.json"), json);
                }
            }
            {
                let mut s = snap.lock().unwrap();
                s.engine_ready = true;
                s.bootstrap_ok = report.ok;
                let (h, f) = stored_video(Some(&module_config_dir));
                s.video_height = h;
                s.video_fps = f;
                s.graphics_backend = report.graphics_backend.clone();
                s.boot_phases_ms = report.boot_phases_ms.clone();
                s.video_encoder = Some(report.video_encoder.clone());
                // One gate for 4K on every platform: whatever GPU encoder
                // registered (VideoToolbox, NVENC, QSV, AMF).
                s.hw_encoder = report.hardware_encoder;
                s.hw_4k60 = s.hw_encoder && four_k_60_ok();
            }
            if report.ok {
                // CEF WARM-UP, off every critical path. The first browser
                // source a process creates pays Chromium's renderer/GPU
                // spin-up — measured 4.6s inside SetOverlay, holding the
                // engine loop (and with it every other source's ack) hostage.
                // A hidden about:blank browser created on ITS OWN thread
                // right after boot takes that hit while the user is still on
                // the home screen; it stays alive so CEF stays hot, and later
                // creates (overlay, guest pages) return in a few hundred ms.
                std::thread::Builder::new()
                    .name("cef-warm".into())
                    .spawn(|| unsafe {
                        let t0 = Instant::now();
                        let settings = ffi::obs_data_create();
                        let k_url = CString::new("url").unwrap();
                        let v_url = CString::new("about:blank").unwrap();
                        ffi::obs_data_set_string(settings, k_url.as_ptr(), v_url.as_ptr());
                        ffi::obs_data_set_int(settings, CString::new("width").unwrap().as_ptr(), 16);
                        ffi::obs_data_set_int(settings, CString::new("height").unwrap().as_ptr(), 16);
                        let id = CString::new("browser_source").unwrap();
                        let name = CString::new("cef-warm").unwrap();
                        let src = ffi::obs_source_create(id.as_ptr(), name.as_ptr(), settings, ptr::null_mut());
                        ffi::obs_data_release(settings);
                        eprintln!("[live] cef warm-up: {} ms (src null: {})", t0.elapsed().as_millis(), src.is_null());
                        // Kept alive on purpose (released with the process).
                        CEF_WARM.store(src as usize, std::sync::atomic::Ordering::Relaxed);
                    })
                    .ok();
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
                video_encoder: report.video_encoder.clone(),
                hw_encoder: report.hardware_encoder,
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
            // The sources snapshot used to change only when a COMMAND ran, so
            // a first-frame poll read stale width=0 until some unrelated
            // command recomputed state (report #6: three unrelated capture
            // stacks all "framed" at the same 5s mark). Refresh it on a
            // 100ms cadence — a handful of FFI getters — without emitting an
            // event, so the snapshot is live truth and the UI is not churned.
            let mut last_src_refresh = Instant::now();
            let probe_t0 = Instant::now();
            let mut probe_last = Instant::now();

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

            // Stall log: any loop iteration over 150ms is written with the
            // command it was handling (or "idle"). The frame probe showed the
            // loop asleep for ~4.6s during room open — this names the sleeper.
            let mut iter_prev: Option<(Instant, &'static str)> = None;
            loop {
                if let Some((t0, label)) = iter_prev.take() {
                    let ms = t0.elapsed().as_millis();
                    if ms > 150 {
                        if let Some(dir) = module_config_dir.parent() {
                            use std::io::Write;
                            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("slow-cmds.log")) {
                                let _ = f.write_all(format!("{} {} {}ms\n", probe_t0.elapsed().as_millis(), label, ms).as_bytes());
                            }
                        }
                    }
                }
                let iter_t0 = Instant::now();
                let mut iter_label: &'static str = "idle";
                // Performance is sampled whether or not a session is running:
                // FPS and CPU tell you the machine is struggling BEFORE you go
                // live, which is when the information is still actionable.
                if last_src_refresh.elapsed() > Duration::from_millis(100) {
                    last_src_refresh = Instant::now();
                    if let Some(g) = scene.as_ref() {
                        snap.lock().unwrap().sources = g.state();
                        // Frame probe: while any item has no frame, log every
                        // item's width/active/showing + the engine's total
                        // rendered frames each tick. Appends to
                        // live/frames-probe.log; one line per tick; stops
                        // once everything has framed.
                        // Probe at 500ms, not every refresh: obs_source_get_width
                        // takes the capture plugin's lock, and hammering it while
                        // the camera starts serialized the loop behind it
                        // (sub-second 'idle' iterations after the fix).
                        let probe = if probe_last.elapsed() > Duration::from_millis(500) { probe_last = Instant::now(); g.frame_probe() } else { Vec::new() };
                        if probe.iter().any(|(_, w, _, _)| *w == 0) {
                            if let Some(dir) = module_config_dir.parent() {
                                let total = unsafe { ffi::obs_get_total_frames() };
                                let line = format!(
                                    "{} total_frames={} {}\n",
                                    probe_t0.elapsed().as_millis(),
                                    total,
                                    probe
                                        .iter()
                                        .map(|(id, w, a, sh)| format!("{id}:w={w},active={a},showing={sh}"))
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                );
                                use std::io::Write;
                                if let Ok(mut f) = std::fs::OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(dir.join("frames-probe.log"))
                                {
                                    let _ = f.write_all(line.as_bytes());
                                }
                            }
                        }
                    }
                }
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
                let received = cmd_rx.recv_timeout(Duration::from_millis(120));
                if let Ok(c) = &received {
                    iter_label = cmd_name(c);
                }
                iter_prev = Some((iter_t0, iter_label));
                match received {
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
                            // a quality bitrate keyed by canvas + frame rate.
                            let br = {
                                let s = snap.lock().unwrap();
                                record_kbps(s.video_height, s.video_fps)
                            };
                            // A live stream lends its encoder (see record.rs).
                            let shared = session.as_ref().map(|s| s.video_encoder());
                            match record::Recorder::start(&stamp, br, shared) {
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
                                let name = CString::new(graph::VCAM_DEVICE_NAME).unwrap();
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
                                        #[cfg(target_os = "macos")]
                                        { "the virtual camera refused to start — is the extension approved?".to_string() }
                                        #[cfg(not(target_os = "macos"))]
                                        { "the virtual camera refused to start — install the camera first".to_string() }
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
                        } else if !video_mode_ok(height, fps) {
                            sink(&LiveEvent::EngineError {
                                message: "video settings must be 720p/1080p/2160p at 30/60fps".into(),
                            });
                        } else if height == 2160 && !report.hardware_encoder {
                            sink(&LiveEvent::EngineError {
                                message: "4K needs a hardware encoder (VideoToolbox, NVENC, QSV, or AMF)".into(),
                            });
                        } else if height == 2160 && fps == 60 && !four_k_60_ok() {
                            sink(&LiveEvent::EngineError {
                                message: "4K on an Intel Mac runs at 30 fps".into(),
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
                                { let v = p.view as usize; let h = if hidden { 1 } else { 0 }; on_window_thread(move || ffi::producer_preview_set_hidden(v as *mut std::os::raw::c_void, h)) }
                            };
                        }
                    }
                    Ok(Command::SetPreviewCutouts(rects)) => {
                        // Windows float mode only: elsewhere the preview sits
                        // below the webview and nothing needs punching out.
                        #[cfg(target_os = "windows")]
                        if let Some(p) = preview.as_ref() {
                            let v = p.view as usize;
                            let flat: Vec<f64> =
                                rects.iter().flat_map(|r| [r.x, r.y, r.w, r.h]).collect();
                            on_window_thread(move || unsafe {
                                ffi::producer_preview_set_cutouts(
                                    v as *mut std::os::raw::c_void,
                                    flat.as_ptr(),
                                    flat.len() as std::os::raw::c_int / 4,
                                )
                            });
                        }
                        #[cfg(not(target_os = "windows"))]
                        let _ = rects;
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
