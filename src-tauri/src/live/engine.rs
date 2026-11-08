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

use crate::performance_trace::native_stage as performance_stage;
use serde::Serialize;

use super::ffi;
use super::record;
use super::studio;

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
    let started = Instant::now();
    let rc = unsafe { ffi::obs_reset_video(&mut ovi) };
    performance_stage(
        if module.contains("metal") {
            "native.video.reset.metal"
        } else if module.contains("d3d11") {
            "native.video.reset.d3d11"
        } else {
            "native.video.reset.opengl"
        },
        started.elapsed(),
        Some(rc == 0),
    );
    if std::env::var_os("PRODUCER_TRACE_ROOM_OPEN").is_some() {
        eprintln!(
            "[room-open] video_reset module={module} ms={} rc={rc}",
            started.elapsed().as_millis()
        );
    }
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
    bootstrap_inner(None, stored_video(None))
}

/// The engine as the app boots it: a real config directory, always.
pub fn bootstrap_with_config(module_config_dir: &std::path::Path) -> EngineReport {
    // The isolated OBS/CEF cache is not the app's video-settings profile.
    // Resolve video from the same profile used by status and SetVideo before
    // redirecting plugin storage, otherwise a fresh cache silently boots 720p.
    let video_mode = stored_video(Some(module_config_dir));
    // An explicitly isolated dev renderer can run beside the installed app.
    // CEF refuses to initialize twice against the same browser cache.
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("PRODUCER_DEV_MODULE_CONFIG_DIR") {
        return bootstrap_inner(Some(std::path::Path::new(&dir)), video_mode);
    }
    bootstrap_inner(Some(module_config_dir), video_mode)
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

fn bootstrap_inner(
    module_config_dir: Option<&std::path::Path>,
    video_mode: (u32, u32),
) -> EngineReport {
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
        let elapsed = phase_t.elapsed();
        let ms = elapsed.as_millis() as u64;
        performance_stage(
            match name {
                "startup" => "native.bootstrap.startup",
                "reset_video" => "native.bootstrap.reset_video",
                "reset_audio" => "native.bootstrap.reset_audio",
                "load_modules" => "native.bootstrap.load_modules",
                "post_load" => "native.bootstrap.post_load",
                _ => "native.bootstrap.phase",
            },
            elapsed,
            None,
        );
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

    #[cfg(target_os = "macos")]
    let started = {
        struct Startup {
            locale: *const std::ffi::c_char,
            config: *const std::ffi::c_char,
            ok: bool,
        }
        extern "C" fn start(param: *mut c_void) {
            let startup = unsafe { &mut *(param as *mut Startup) };
            startup.ok =
                unsafe { ffi::obs_startup(startup.locale, startup.config, ptr::null_mut()) };
        }
        let mut startup = Startup {
            locale: locale.as_ptr(),
            config: config_ptr,
            ok: false,
        };
        // OBS initializes HIToolbox keyboard input sources here. macOS requires
        // the main queue even when all later engine work runs on its own thread.
        ui_task_handler(start, &mut startup as *mut Startup as *mut c_void, true);
        startup.ok
    };
    #[cfg(not(target_os = "macos"))]
    let started = unsafe { ffi::obs_startup(locale.as_ptr(), config_ptr, ptr::null_mut()) };
    if !started {
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
    unsafe {
        ffi::producer_person_mask_register();
        #[cfg(target_os = "windows")]
        ffi::producer_vcam_mirror_register();
        ffi::producer_source_appearance_register();
        super::sets_v2::register();
        #[cfg(feature = "guest-rtc-pilot")]
        super::rtc_ingest::register_type();
    };

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
    let (boot_h, boot_f) = video_mode;
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
    // The RTC publisher needs a bounded capture timeline. Legacy OBS audio
    // can grow its mixer delay to 960 ms, exceeding our publication budget.
    // Keep this candidate restricted to the explicit native RTC pilot.
    let rtc_audio = cfg!(feature = "guest-rtc-pilot")
        && (cfg!(feature = "guest-rtc-production")
            || std::env::var("PRODUCER_RTC_PROGRAM_PILOT").as_deref() == Ok("1"));
    let audio_ready = if rtc_audio {
        let bounded = ffi::obs_audio_info2 {
            samples_per_sec: oai.samples_per_sec,
            speakers: oai.speakers,
            max_buffering_ms: 200,
            fixed_buffering: true,
        };
        unsafe { ffi::obs_reset_audio2(&bounded) }
    } else {
        unsafe { ffi::obs_reset_audio(&oai) }
    };
    if !audio_ready {
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

    #[cfg(target_os = "macos")]
    if unsafe { ffi::producer_capture_guard_install() } == 0 {
        eprintln!("[live] Camera startup protection could not attach to mac-avcapture");
    }

    // F3 ★: validate required IDs, then obs_post_load_modules. VideoToolbox
    // registers its encoders during post-load, so VT is re-checked after it.
    unsafe { ffi::obs_post_load_modules() };
    #[cfg(target_os = "windows")]
    unsafe {
        ffi::producer_window_capture_register();
    }
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

// The macOS capture plugin can block in HAL while creating its input unit.
// Prepare one unparented input at a time. Only the engine may attach it.
enum RoomMicStage {
    Queued,
    Preparing,
    Attached(graph::RoomMicPacket),
    Failed,
}

struct RoomMicStart {
    extra: graph::RestoreExtra,
    change: graph::SceneChange,
    cancelled: Arc<AtomicBool>,
    started: Instant,
    stage: RoomMicStage,
    volume: Option<f32>,
}

impl RoomMicStart {
    fn expects_audio(&self) -> bool {
        self.change.patch.visible == Some(true) && self.change.muted == Some(false)
    }

    fn is_attached(&self) -> bool {
        matches!(self.stage, RoomMicStage::Attached(_))
    }

    fn update_audio_plan(&mut self, visible: Option<bool>, muted: Option<bool>) {
        self.change.patch.visible = visible.or(self.change.patch.visible);
        self.change.muted = muted.or(self.change.muted);
    }

    fn restart(&mut self, spec: graph::ExtraSpec) {
        self.cancelled.store(true, AtomicOrdering::Release);
        self.cancelled = Arc::new(AtomicBool::new(false));
        self.extra.spec = spec;
        self.started = Instant::now();
        self.stage = RoomMicStage::Queued;
    }
}

impl Drop for RoomMicStart {
    fn drop(&mut self) {
        self.cancelled.store(true, AtomicOrdering::Release);
    }
}

type RoomMicWorker = (
    Arc<AtomicBool>,
    std::thread::JoinHandle<Result<graph::DetachedRoomMic, String>>,
);

fn defer_room_microphones(restore: &mut graph::RoomRestore, started: Instant) -> Vec<RoomMicStart> {
    // Leave invalid plans to the ordinary restore path, where they produce the
    // same validation errors or warnings as before.
    let mut ids = std::collections::HashSet::new();
    if restore.extras.len() > 128
        || restore.changes.len() > 128
        || restore.extras.iter().any(|extra| {
            extra.id == "overlay"
                || extra.id.contains('\0')
                || restore.keep_ids.contains(&extra.id)
                || !ids.insert(extra.id.as_str())
        })
        || restore.changes.iter().any(|change| {
            let p = &change.patch;
            [p.x, p.y, p.w, p.h, p.rot]
                .into_iter()
                .flatten()
                .any(|value| !value.is_finite())
        })
    {
        return Vec::new();
    }
    let mut microphones = Vec::new();
    let mut others = Vec::new();
    for extra in std::mem::take(&mut restore.extras) {
        if matches!(extra.spec, graph::ExtraSpec::Mic { .. }) {
            let change = restore
                .changes
                .iter()
                .rev()
                .find(|change| change.id == extra.id)
                .cloned()
                .unwrap_or_else(|| graph::SceneChange {
                    id: extra.id.clone(),
                    patch: graph::TransformPatch::default(),
                    muted: None,
                });
            microphones.push(RoomMicStart {
                extra,
                change,
                cancelled: Arc::new(AtomicBool::new(false)),
                started,
                stage: RoomMicStage::Queued,
                volume: None,
            });
        } else {
            others.push(extra);
        }
    }
    restore.extras = others;
    microphones
}

fn room_mic_status(snapshot: &mut Snapshot, microphones: &[RoomMicStart]) {
    snapshot.room_mic_pending = false;
    snapshot.room_mic_failed = false;
    snapshot.room_mic_starting_ids.clear();
    for mic in microphones {
        if !mic.is_attached() {
            snapshot.room_mic_starting_ids.push(mic.extra.id.clone());
        }
        if mic.expects_audio() {
            if matches!(mic.stage, RoomMicStage::Failed)
                || mic.started.elapsed() >= Duration::from_secs(8)
            {
                snapshot.room_mic_failed = true;
            } else {
                snapshot.room_mic_pending = true;
            }
        }
    }
}

fn current_video_mode(snapshot: &Mutex<Snapshot>, height: u32, fps: u32) -> bool {
    let snapshot = snapshot.lock().unwrap();
    snapshot.video_height == height && snapshot.video_fps == fps
}

#[cfg(test)]
mod room_mic_tests {
    use super::*;

    #[test]
    fn deferred_microphones_follow_saved_audibility_and_cancel_independently() {
        let mut restore: graph::RoomRestore = serde_json::from_value(serde_json::json!({
            "keep_ids": [],
            "extras": [
                {"id":"mic-a","label":"Mic A","spec":{"kind":"mic"}},
                {"id":"mic-b","label":"Mic B","spec":{"kind":"mic"}},
                {"id":"image","label":"Image","spec":{"kind":"image","path":"image.png"}}
            ],
            "changes": [
                {"id":"mic-a","patch":{"visible":true},"muted":false},
                {"id":"mic-b","patch":{"visible":true},"muted":true}
            ]
        }))
        .unwrap();
        let mut microphones = defer_room_microphones(&mut restore, Instant::now());
        assert_eq!(restore.extras.len(), 1);
        let token = microphones[0].cancelled.clone();
        let mut snapshot = Snapshot::default();
        room_mic_status(&mut snapshot, &microphones);
        assert!(snapshot.room_mic_pending);
        assert_eq!(snapshot.room_mic_starting_ids, ["mic-a", "mic-b"]);

        microphones[0].stage = RoomMicStage::Failed;
        room_mic_status(&mut snapshot, &microphones);
        assert!(snapshot.room_mic_failed);
        assert!(!snapshot.room_mic_pending);

        microphones.remove(0);
        assert!(token.load(AtomicOrdering::Acquire));
        room_mic_status(&mut snapshot, &microphones);
        assert_eq!(snapshot.room_mic_starting_ids, ["mic-b"]);
        assert!(!snapshot.room_mic_failed);
        assert!(!snapshot.room_mic_pending);
    }
}

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
    PortraitRoom {
        reply: mpsc::Sender<Result<graph::SourcesState, String>>,
    },
    PortraitState {
        reply: mpsc::Sender<Result<graph::SourcesState, String>>,
    },
    PortraitTransform {
        id: String,
        patch: graph::TransformPatch,
        reply: mpsc::Sender<Result<graph::SourcesState, String>>,
    },
    PortraitPreview {
        window: usize,
        rect: Option<PreviewRect>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    PortraitWarm {
        request: super::presentation::Request,
        reply: mpsc::Sender<Result<Arc<super::presentation::Bridge>, String>>,
    },
    PortraitPrepare {
        request: super::presentation::Request,
        reply: mpsc::Sender<Result<Arc<super::presentation::Bridge>, String>>,
    },
    PortraitAbort {
        token: String,
        revision: u64,
    },
    PortraitCommit {
        token: String,
        placements: Vec<super::presentation::Placement>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    PortraitStop {
        queued_at: Instant,
        reply: mpsc::Sender<()>,
    },
    PortraitFrame {
        reply: mpsc::Sender<String>,
    },
    PresentationStatus {
        reply: mpsc::Sender<super::presentation::Status>,
    },
    SetSourceCreate {
        id: String,
        label: String,
        spec: graph::ExtraSpec,
        reply: mpsc::Sender<Result<graph::SourcesState, String>>,
    },
    SetsV2 {
        action: super::sets_v2::contract::Action,
        queued_at: Instant,
        reply: mpsc::Sender<Result<super::sets_v2::contract::Status, String>>,
    },
    PresentationWarm {
        request: super::presentation::Request,
        reply: mpsc::Sender<Result<Arc<super::presentation::Bridge>, String>>,
    },
    PresentationPrepare {
        request: super::presentation::Request,
        reply: mpsc::Sender<Result<Arc<super::presentation::Bridge>, String>>,
    },
    PresentationCommit {
        token: String,
        placements: Vec<super::presentation::Placement>,
        reply: mpsc::Sender<Result<super::presentation::Status, String>>,
    },
    PresentationAbort {
        token: String,
        revision: u64,
    },
    PresentationReturn {
        lease: Option<String>,
        reply: mpsc::Sender<Result<super::presentation::Status, String>>,
    },
    Soundboard {
        action: crate::soundboard::Native,
        reply: std::sync::mpsc::Sender<Result<crate::soundboard::Reply, String>>,
    },
    Dj {
        action: crate::dj::Action,
        reply: std::sync::mpsc::Sender<Result<crate::dj::Status, String>>,
    },
    SetPreviewSources {
        lease: String,
        ids: Vec<String>,
    },
    SetThumbRate {
        fps: u32,
    },
    /// A seat's monitor wants the PROGRAM thumb (host side of
    /// lib/monitorFeed.ts): the `program` target joins the thumb hub.
    SetProgramThumb {
        on: bool,
    },
    VirtualCamMirror {
        on: Option<bool>,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    SelectOutput {
        portrait: bool,
        reply: mpsc::Sender<Result<(), String>>,
    },
    GoLive {
        config: MultiConfig,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    StopLive,
    ReleaseIdleRoom {
        reply: mpsc::Sender<Result<bool, String>>,
    },
    /// Stage-editor transform (UI-P1). `commit: false` applies silently at
    /// gesture rate; `commit: true` (pointer-up) echoes SourcesChanged so
    /// the UI and room document settle on engine truth.
    SetTransform {
        id: String,
        patch: graph::TransformPatch,
        commit: bool,
    },
    ApplyScene {
        changes: Vec<graph::SceneChange>,
        reply: mpsc::Sender<Result<graph::SourcesState, String>>,
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
        dual: bool,
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
    /// Studio output (studio.rs): Some = broadcast our own window as the
    /// program, None = back to the room scene. Replies with the resulting
    /// state.
    SetStudio {
        spec: Option<studio::StudioSpec>,
        reply: std::sync::mpsc::Sender<Result<bool, String>>,
    },
    /// Point a live source at a different device, keeping its transform.
    SetDevice {
        id: String,
        device: String,
    },
    /// Add an open-list scene item (UI-P2.10). Id and label come from the
    /// room document so items respawn with stable identity.
    ReplaceExtra {
        id: String,
        label: String,
        spec: graph::ExtraSpec,
        initial: Option<graph::SceneChange>,
        reply: mpsc::Sender<Result<graph::SourcesState, String>>,
    },
    RestoreRoom {
        queued_at: Instant,
        restore: graph::RoomRestore,
        reply: mpsc::Sender<Result<graph::RoomRestoreResult, String>>,
    },
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
    DetachPreview {
        reply: mpsc::Sender<()>,
    },
    Shutdown,
}

/// Variant name for the engine-loop stall log (no reflection in Rust).
fn cmd_name(c: &Command) -> &'static str {
    match c {
        Command::Soundboard { .. } => "Soundboard",
        Command::Dj { .. } => "Dj",
        Command::SetPreviewSources { .. } => "SetPreviewSources",
        Command::SetThumbRate { .. } => "SetThumbRate",
        Command::SetProgramThumb { .. } => "SetProgramThumb",
        Command::GoLive { .. } => "GoLive",
        Command::StopLive { .. } => "StopLive",
        Command::ReleaseIdleRoom { .. } => "ReleaseIdleRoom",
        Command::SetTransform { .. } => "SetTransform",
        Command::ApplyScene { .. } => "ApplyScene",
        Command::PresentationWarm { .. } => "PresentationWarm",
        Command::PresentationStatus { .. } => "PresentationStatus",
        Command::SetsV2 { .. } => "SetsV2",
        Command::SetSourceCreate { .. } => "SetSourceCreate",
        Command::PortraitRoom { .. } => "PortraitRoom",
        Command::PortraitState { .. } => "PortraitState",
        Command::PortraitTransform { .. } => "PortraitTransform",
        Command::PortraitPreview { .. } => "PortraitPreview",
        Command::PortraitWarm { .. } => "PortraitWarm",
        Command::PortraitPrepare { .. } => "PortraitPrepare",
        Command::PortraitAbort { .. } => "PortraitAbort",
        Command::PortraitCommit { .. } => "PortraitCommit",
        Command::PortraitStop { .. } => "PortraitStop",
        Command::PortraitFrame { .. } => "PortraitFrame",
        Command::PresentationPrepare { .. } => "PresentationPrepare",
        Command::PresentationCommit { .. } => "PresentationCommit",
        Command::PresentationAbort { .. } => "PresentationAbort",
        Command::PresentationReturn { .. } => "PresentationReturn",
        Command::ListDevices { .. } => "ListDevices",
        Command::PlayStinger { .. } => "PlayStinger",
        Command::SelectOutput { .. } => "SelectOutput",
        Command::VirtualCamMirror { .. } => "VirtualCamMirror",
        Command::StartRecording { .. } => "StartRecording",
        Command::StopRecording { .. } => "StopRecording",
        Command::SetSyncOffset { .. } => "SetSyncOffset",
        Command::SetSourceAudio { .. } => "SetSourceAudio",
        Command::SetItemOpacity { .. } => "SetItemOpacity",
        Command::Filters { .. } => "Filters",
        Command::PrepareStinger { .. } => "PrepareStinger",
        Command::StopStinger { .. } => "StopStinger",
        Command::SetVirtualCam { .. } => "SetVirtualCam",
        Command::SetStudio { .. } => "SetStudio",
        Command::SetDevice { .. } => "SetDevice",
        Command::ReplaceExtra { .. } => "ReplaceExtra",
        Command::RestoreRoom { .. } => "RestoreRoom",
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
    /// Meter tick (~8 Hz while any metered source exists): per-source peak
    /// absolute sample since the previous tick, 0..=1.
    Levels {
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
    pub room_mic_pending: bool,
    pub room_mic_failed: bool,
    pub room_mic_starting_ids: Vec<String>,
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
    /// Mean render time per frame in µs (`obs_get_average_frame_time_ns`),
    /// 0 until the graphics thread has rendered. The UI divides it by the
    /// frame budget (1e6 / video_fps) for the "Render load" chart.
    #[serde(default)]
    pub render_time_us: f64,
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
    #[cfg(debug_assertions)]
    pub(super) fn probe_sender(&self) -> mpsc::Sender<Command> {
        self.cmd.clone()
    }

    pub fn portrait_room(&self) -> Result<graph::SourcesState, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitRoom { reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())?
    }
    pub fn portrait_state(&self) -> Result<graph::SourcesState, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitState { reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?
    }
    pub fn portrait_transform(
        &self,
        id: String,
        patch: graph::TransformPatch,
    ) -> Result<graph::SourcesState, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitTransform {
                id,
                patch,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?
    }
    pub fn portrait_preview(&self, window: usize, rect: Option<PreviewRect>) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitPreview {
                window,
                rect,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())?
    }
    pub fn portrait_warm(&self, request: super::presentation::Request) -> Result<(), String> {
        let revision = request.projection.revision;
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitWarm { request, reply: tx })
            .map_err(|e| e.to_string())?;
        let bridge = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())??;
        if let Err(e) = bridge.wait_revision(revision) {
            let _ = self.cmd.send(Command::PortraitAbort {
                token: bridge.token.clone(),
                revision,
            });
            return Err(e);
        }
        Ok(())
    }
    pub fn portrait_apply(&self, request: super::presentation::Request) -> Result<(), String> {
        let revision = request.projection.revision;
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitPrepare { request, reply: tx })
            .map_err(|e| e.to_string())?;
        let bridge = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())??;
        let placements = match bridge.wait_revision(revision) {
            Ok(p) => p,
            Err(e) => {
                let _ = self.cmd.send(Command::PortraitAbort {
                    token: bridge.token.clone(),
                    revision,
                });
                return Err(e);
            }
        };
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitCommit {
                token: bridge.token.clone(),
                placements,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())?
    }
    pub fn portrait_stop(&self) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitStop {
                queued_at: Instant::now(),
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())
    }
    pub fn portrait_frame(&self) -> Result<String, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PortraitFrame { reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())
    }
    pub fn presentation_status(&self) -> Result<super::presentation::Status, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PresentationStatus { reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Set engine did not answer".into())
    }
    pub fn set_source_create(
        &self,
        id: String,
        label: String,
        spec: graph::ExtraSpec,
    ) -> Result<graph::SourcesState, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::SetSourceCreate {
                id,
                label,
                spec,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Source creation did not answer".to_string())?
    }
    pub fn sets_v2(
        &self,
        action: super::sets_v2::contract::Action,
    ) -> Result<super::sets_v2::contract::Status, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::SetsV2 {
                action,
                queued_at: Instant::now(),
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Sets v2 engine did not answer".to_string())?
    }
    pub fn presentation_warm(&self, request: super::presentation::Request) -> Result<(), String> {
        let revision = request.projection.revision;
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PresentationWarm { request, reply: tx })
            .map_err(|e| e.to_string())?;
        let bridge = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Set warmup did not start".to_string())??;
        if let Err(e) = bridge.wait_revision(revision) {
            let _ = self.cmd.send(Command::PresentationAbort {
                token: bridge.token.clone(),
                revision,
            });
            return Err(e);
        }
        Ok(())
    }
    pub fn presentation_apply(
        &self,
        request: super::presentation::Request,
    ) -> Result<super::presentation::Status, String> {
        let started = Instant::now();
        let revision = request.projection.revision;
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PresentationPrepare { request, reply: tx })
            .map_err(|e| e.to_string())?;
        let bridge = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Set preparation did not start".to_string())??;
        let prepared_ms = started.elapsed().as_millis();
        // Wait outside the engine owner: Stop/Return/room restoration can cancel
        // preparation immediately while the private renderers obtain their receipt.
        let placements = match bridge.wait_revision(revision) {
            Ok(p) => p,
            Err(e) => {
                let _ = self.cmd.send(Command::PresentationAbort {
                    token: bridge.token.clone(),
                    revision,
                });
                return Err(e);
            }
        };
        let ready_ms = started.elapsed().as_millis();
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PresentationCommit {
                token: bridge.token.clone(),
                placements,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        let result = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Set activation did not answer".to_string())?;
        eprintln!("[set-perf] revision={revision} apply_ms={} prepare_ms={prepared_ms} ready_ms={ready_ms} renderer={}",started.elapsed().as_millis(),bridge.token);
        result
    }
    pub fn presentation_return(
        &self,
        lease: Option<String>,
    ) -> Result<super::presentation::Status, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::PresentationReturn { lease, reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Return to room did not answer".to_string())?
    }

    pub fn replace_extra(
        &self,
        id: String,
        label: String,
        spec: graph::ExtraSpec,
        initial: Option<graph::SceneChange>,
    ) -> Result<graph::SourcesState, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::ReplaceExtra {
                id,
                label,
                spec,
                initial,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|_| "Source replacement did not finish".to_string())?
    }
    pub fn restore_room(
        &self,
        restore: graph::RoomRestore,
    ) -> Result<graph::RoomRestoreResult, String> {
        let (tx, rx) = mpsc::channel();
        performance_stage("native.room.restore.queued", Duration::ZERO, None);
        self.cmd
            .send(Command::RestoreRoom {
                queued_at: Instant::now(),
                restore,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        // Multiple cold browser/capture creations can take longer than a cut.
        rx.recv_timeout(Duration::from_secs(120))
            .map_err(|_| "Room restoration did not finish".to_string())?
    }
    pub fn apply_scene(
        &self,
        changes: Vec<graph::SceneChange>,
    ) -> Result<graph::SourcesState, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::ApplyScene { changes, reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "The scene engine did not answer".to_string())?
    }
    pub fn go_live(&self, config: MultiConfig) -> Result<(), String> {
        self.proxy().go_live(config)
    }
    pub fn stop_live(&self) -> Result<(), String> {
        self.proxy().stop_live()
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
    pub fn set_preview_sources(&self, lease: String, ids: Vec<String>) {
        let _ = self.cmd.send(Command::SetPreviewSources { lease, ids });
    }

    pub fn set_thumb_rate(&self, fps: u32) {
        let _ = self.cmd.send(Command::SetThumbRate { fps });
    }

    /// The program thumb for a seat's monitor fallback (docs/THUMB-PIPELINE-V2.md
    /// target `program`, PROGRAM_THUMB_FPS while on).
    pub fn virtual_cam_mirror(&self, on: Option<bool>) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::VirtualCamMirror { on, reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Camera mirror settings timed out".to_string())?
    }

    pub fn select_output(&self, portrait: bool) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::SelectOutput {
                portrait,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Output selection timed out".to_string())?
    }
    pub fn set_program_thumb(&self, on: bool) {
        let _ = self.cmd.send(Command::SetProgramThumb { on });
    }

    pub fn start_recording(&self, stamp: String) -> Result<String, String> {
        self.start_recording_mode(stamp, false)
    }
    pub fn start_recording_mode(&self, stamp: String, dual: bool) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::StartRecording {
                stamp,
                dual,
                reply: tx,
            })
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

    pub fn soundboard_dispatch(
        &self,
    ) -> Result<
        Box<
            dyn FnOnce(crate::soundboard::Native) -> Result<crate::soundboard::Reply, String>
                + Send,
        >,
        String,
    > {
        let sender = self.cmd.clone();
        Ok(Box::new(move |action| {
            let (tx, rx) = std::sync::mpsc::channel();
            sender
                .send(Command::Soundboard { action, reply: tx })
                .map_err(|e| e.to_string())?;
            rx.recv_timeout(Duration::from_secs(5))
                .map_err(|_| "Soundboard did not answer".to_string())?
        }))
    }
    pub fn dj_dispatch(
        &self,
    ) -> Result<
        Box<dyn FnOnce(crate::dj::Action) -> Result<crate::dj::Status, String> + Send>,
        String,
    > {
        let sender = self.cmd.clone();
        Ok(Box::new(move |action| {
            let (tx, rx) = std::sync::mpsc::channel();
            sender
                .send(Command::Dj { action, reply: tx })
                .map_err(|e| e.to_string())?;
            rx.recv_timeout(Duration::from_secs(5))
                .map_err(|_| "The DJ audio engine did not answer".to_string())?
        }))
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

    pub fn set_studio(&self, spec: Option<studio::StudioSpec>) -> Result<bool, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.cmd
            .send(Command::SetStudio { spec, reply: tx })
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

    pub fn set_device(&self, id: String, device: String) -> Result<(), String> {
        self.cmd
            .send(Command::SetDevice { id, device })
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
        let (tx, rx) = mpsc::channel();
        self.cmd
            .send(Command::DetachPreview { reply: tx })
            .map_err(|e| e.to_string())?;
        // A send receipt does not mean the native views have disappeared.
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "the native preview did not close in time".to_string())
    }
    pub fn release_idle_room(&self) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel();
        performance_stage("native.room.release.queued", Duration::ZERO, None);
        self.cmd
            .send(Command::ReleaseIdleRoom { reply: tx })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "the engine did not release the room in time".to_string())?
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
    canvas: *mut std::os::raw::c_void,
    rect: PreviewRect,
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
        super::callback_diagnostics::write_stderr(format_args!(
            "[preview] draw #{n} target {cx}x{cy}"
        ));
    }
    // Once: what does output channel 0 actually hold? Expected the "main" scene.
    // "Live Screen" means attach_capture_sources rebound it; null means the
    // probe path cleared it or SceneGraph::create failed silently.
    if n == 30 {
        unsafe {
            let src = ffi::obs_get_output_source(0);
            if src.is_null() {
                super::callback_diagnostics::write_stderr(format_args!(
                    "[preview] channel 0 = NULL"
                ));
            } else {
                let name = CStr::from_ptr(ffi::obs_source_get_name(src))
                    .to_string_lossy()
                    .into_owned();
                super::callback_diagnostics::write_stderr(format_args!(
                    "[preview] channel 0 = '{name}'  color space = {}",
                    ffi::gs_get_color_space()
                ));
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
        if studio::STUDIO_ON.load(std::sync::atomic::Ordering::Relaxed) {
            // Studio output: the main texture is a capture of THIS window.
            // Drawing it here would be the infinite mirror; the stage shows
            // the ROOM scene (channel 0) instead — studio.rs.
            let room = ffi::obs_get_output_source(0);
            if !room.is_null() {
                ffi::obs_source_video_render(room);
                ffi::obs_source_release(room);
            }
        } else {
            ffi::obs_render_main_texture();
        }
        // Windows float mode: the selection outline lives HERE, in the display
        // pass after the mix --- never in the mix itself, which feeds the
        // encoder, the recording, the virtual camera and the guests.
        #[cfg(target_os = "windows")]
        draw_selection(bw, bh, cx, cy);
        ffi::gs_projection_pop();
        ffi::gs_viewport_pop();
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(super) static PORTRAIT_DRAWS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(any(target_os = "macos", target_os = "windows"))]
extern "C" fn portrait_draw(canvas: *mut std::os::raw::c_void, _: u32, _: u32) {
    unsafe {
        let mut info = std::mem::MaybeUninit::<ffi::obs_video_info>::zeroed();
        if !ffi::obs_get_video_info(info.as_mut_ptr()) {
            return;
        }
        let info = info.assume_init();
        ffi::gs_viewport_push();
        ffi::gs_projection_push();
        ffi::gs_ortho(
            0.0,
            info.base_height as f32,
            0.0,
            info.base_width as f32,
            -100.0,
            100.0,
        );
        PORTRAIT_DRAWS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        super::portrait::obs_canvas_render(canvas.cast());
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

#[cfg(target_os = "windows")]
fn apply_preview_cutouts(
    landscape: Option<&Preview>,
    portrait: Option<&Preview>,
    rects: Vec<PreviewRect>,
) {
    let mut views: Vec<usize> = landscape
        .into_iter()
        .chain(portrait)
        .map(|p| p.view as usize)
        .collect();
    // Keep the region for a display that attaches while a modal is open.
    if views.is_empty() {
        views.push(0);
    }
    let flat: Vec<f64> = rects.iter().flat_map(|r| [r.x, r.y, r.w, r.h]).collect();
    on_window_thread(move || unsafe {
        for view in views {
            ffi::producer_preview_set_cutouts(
                view as *mut c_void,
                flat.as_ptr(),
                flat.len() as i32 / 4,
            );
        }
    });
}

#[cfg(all(test, target_os = "windows"))]
mod preview_occlusion_tests {
    use super::*;
    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(
            ex: u32,
            class: *const u16,
            title: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: *mut c_void,
            menu: *mut c_void,
            instance: *mut c_void,
            param: *mut c_void,
        ) -> *mut c_void;
        fn DestroyWindow(window: *mut c_void) -> i32;
        fn GetWindowRgn(window: *mut c_void, region: *mut c_void) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> *mut c_void;
        fn DeleteObject(object: *mut c_void) -> i32;
    }
    struct Parent(*mut c_void);
    impl Drop for Parent {
        fn drop(&mut self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }
    unsafe fn attach(parent: &Parent, x: f64) -> Preview {
        let rect = PreviewRect {
            x,
            y: 40.,
            w: 200.,
            h: 300.,
        };
        let (mut w, mut h) = (0., 0.);
        let view = ffi::producer_preview_attach(
            parent.0, rect.x, rect.y, rect.w, rect.h, 0, &mut w, &mut h,
        );
        assert!(!view.is_null());
        Preview {
            view,
            display: ptr::null_mut(),
            canvas: ptr::null_mut(),
            rect,
        }
    }
    unsafe fn region_kind(preview: &Preview) -> i32 {
        let region = CreateRectRgn(0, 0, 0, 0);
        assert!(!region.is_null());
        let kind = GetWindowRgn(preview.view, region);
        DeleteObject(region);
        kind
    }
    #[test]
    fn windows_modal_clips_both_previews_and_late_attach_then_restores() {
        // Hidden Win32 children, no GPU, capture device, account or output.
        for _ in 0..8 {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let parent = Parent(unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    0,
                    0,
                    0,
                    1200,
                    900,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            });
            assert!(!parent.0.is_null());
            apply_preview_cutouts(None, None, vec![]);
            let landscape = unsafe { attach(&parent, 30.) };
            let portrait = unsafe { attach(&parent, 300.) };
            let modal = vec![PreviewRect {
                x: 0.,
                y: 0.,
                w: 20000.,
                h: 20000.,
            }];
            apply_preview_cutouts(Some(&landscape), Some(&portrait), modal.clone());
            assert_eq!(
                unsafe { region_kind(&landscape) },
                1,
                "landscape must have an empty region"
            );
            assert_eq!(
                unsafe { region_kind(&portrait) },
                1,
                "portrait must have an empty region"
            );
            apply_preview_cutouts(None, None, modal);
            let late = unsafe { attach(&parent, 600.) };
            assert_eq!(
                unsafe { region_kind(&late) },
                1,
                "a new display inherits modal clipping"
            );
            unsafe {
                ffi::producer_preview_set_frame(
                    late.view,
                    650.,
                    80.,
                    180.,
                    300.,
                    ptr::null_mut(),
                    ptr::null_mut(),
                );
            }
            assert_eq!(
                unsafe { region_kind(&late) },
                1,
                "moving a display must retain clipping"
            );
            apply_preview_cutouts(Some(&landscape), Some(&portrait), vec![]);
            assert_eq!(
                unsafe { region_kind(&landscape) },
                0,
                "closing restores the full display"
            );
            assert_eq!(
                unsafe { region_kind(&portrait) },
                0,
                "closing restores portrait too"
            );
            // Production moves periodically reapply the current shared region.
            unsafe {
                ffi::producer_preview_set_frame(
                    late.view,
                    650.,
                    80.,
                    180.,
                    300.,
                    ptr::null_mut(),
                    ptr::null_mut(),
                );
            }
            assert_eq!(unsafe { region_kind(&late) }, 0);
        }
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
            Ok(Preview {
                view,
                display,
                canvas: std::ptr::null_mut(),
                rect,
            })
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    unsafe fn attach_canvas(
        window: *mut std::os::raw::c_void,
        rect: PreviewRect,
        canvas: *mut super::portrait::Canvas,
    ) -> Result<Self, String> {
        let mut p = Self::attach(window, rect)?;
        ffi::obs_display_remove_draw_callback(p.display, preview_draw, std::ptr::null_mut());
        p.canvas = super::portrait::obs_canvas_get_ref(canvas).cast();
        ffi::obs_display_add_draw_callback(p.display, portrait_draw, p.canvas);
        Ok(p)
    }
    fn set_rect(&mut self, rect: PreviewRect) {
        // The frontend suppresses unchanged DOM measurements. An explicit
        // move with the same CSS rect must still recompute native placement:
        // the WKWebView's container/titlebar origin may have moved.
        self.rect = rect;
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

    fn conceal(&self) {
        let view = self.view as usize;
        on_window_thread(move || unsafe {
            ffi::producer_preview_set_hidden(view as *mut std::os::raw::c_void, 1);
        });
    }
    fn detach(self) {
        // Hide the retained last frame before graphics callbacks or a
        // platform swapchain can delay destruction on the UI thread.
        self.conceal();
        unsafe {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if !self.canvas.is_null() {
                ffi::obs_display_remove_draw_callback(self.display, portrait_draw, self.canvas);
            } else {
                ffi::obs_display_remove_draw_callback(
                    self.display,
                    preview_draw,
                    std::ptr::null_mut(),
                );
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            ffi::obs_display_remove_draw_callback(self.display, preview_draw, std::ptr::null_mut());
            let display_addr = self.display as usize;
            graph::on_main_thread(move || {
                ffi::obs_display_destroy(display_addr as *mut ffi::obs_display_t);
            });
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if !self.canvas.is_null() {
                super::portrait::release_display_canvas(self.canvas);
            }
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
        let (reply, accepted) = mpsc::sync_channel(0);
        self.cmd
            .send(Command::GoLive { config, reply })
            .map_err(|e| e.to_string())?;
        accepted
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "The engine did not acknowledge Go Live".to_string())?
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
                        let (tw, th) = graph::thumb_dims(id);
                        if rgba.len() != (tw * th * 4) as usize {
                            continue;
                        }
                        jpg.clear();
                        let enc = jpeg_encoder::Encoder::new(&mut jpg, 62);
                        if enc
                            .encode(rgba, tw as u16, th as u16, jpeg_encoder::ColorType::Rgba)
                            .is_ok()
                        {
                            #[cfg(debug_assertions)]
                            // First async-source frames can be black before decoding.
                            // Save the first image containing pixels for diagnostics.
                            if rgba
                                .chunks_exact(4)
                                .any(|p| p[0] > 12 || p[1] > 12 || p[2] > 12)
                                && dumped.insert(id.clone())
                            {
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
    #[cfg(debug_assertions)]
    let probe_cmd = cmd_tx.clone();
    let streaming_flag = streaming.clone();

    std::thread::Builder::new()
        .name("live-engine".into())
        .spawn(move || {
            let bootstrap_started = Instant::now();
            let report = bootstrap_with_config(&module_config_dir);
            performance_stage("native.bootstrap.complete", bootstrap_started.elapsed(), Some(report.ok));
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
                        ffi::obs_data_set_int(
                            settings,
                            CString::new("width").unwrap().as_ptr(),
                            16,
                        );
                        ffi::obs_data_set_int(
                            settings,
                            CString::new("height").unwrap().as_ptr(),
                            16,
                        );
                        let id = CString::new("browser_source").unwrap();
                        let name = CString::new("cef-warm").unwrap();
                        let src = ffi::obs_source_create(
                            id.as_ptr(),
                            name.as_ptr(),
                            settings,
                            ptr::null_mut(),
                        );
                        ffi::obs_data_release(settings);
                        eprintln!(
                            "[live] cef warm-up: {} ms (src null: {})",
                            t0.elapsed().as_millis(),
                            src.is_null()
                        );
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
            let mut portrait_recorder: Option<record::Recorder> = None;
            // The virtual camera runs independently of streaming and
            // recording — all three can be on at once.
            let mut vcam: Option<*mut ffi::obs_output_t> = None;
            let mirror_path = module_config_dir.parent().unwrap_or(&module_config_dir).join("virtual-camera-mirror.json");
            let mut vcam_mirrored = std::fs::read(&mirror_path).ok()
                .and_then(|bytes| serde_json::from_slice::<bool>(&bytes).ok()).unwrap_or(false);

            // Studio output (studio.rs) — the studio scene over the room.
            let mut studio_out: Option<studio::Studio> = None;
            // The room-only mix the virtual camera reads, in BOTH studio modes.
            // Built once, before the vcam starts, and torn down only when the
            // vcam is off — so a studio toggle never restarts the vcam output
            // (studio.rs module docs: that restart was the v0.4.40 crash).
            let mut room_mix: Option<studio::RoomMix> = None;
            /// Build the room mix if it does not exist yet, and hand back its
            /// `video_t`. Engine-thread only.
            unsafe fn room_mix_video(
                room_mix: &mut Option<studio::RoomMix>,
            ) -> Result<*mut ffi::video_t, String> {
                if room_mix.is_none() {
                    // SIZE ON THE RECORD. macOS's CoreMediaIO extension
                    // advertises a HARDCODED 1920x1080 (obs-studio#10263); when
                    // the mix it is fed differs, macOS implicitly rescales and
                    // the consumer shows a CROPPED picture — corners gone,
                    // subject blown up. That is exactly the report, so the one
                    // number that settles it is what this mix actually is.
                    let mut ovi: std::mem::MaybeUninit<ffi::obs_video_info> =
                        std::mem::MaybeUninit::zeroed();
                    if ffi::obs_get_video_info(ovi.as_mut_ptr()) {
                        let o = ovi.assume_init();
                        eprintln!(
                            "[vcam] room mix built: base {}x{} output {}x{} — the macOS camera device is a fixed 1920x1080, so anything but 1920x1080 here is rescaled and cropped",
                            o.base_width, o.base_height, o.output_width, o.output_height
                        );
                    }
                    let room = ffi::obs_get_output_source(0);
                    let built = studio::RoomMix::build(room);
                    if !room.is_null() {
                        ffi::obs_source_release(room);
                    }
                    *room_mix = Some(built?);
                }
                Ok(room_mix.as_ref().unwrap().video())
            }
            /// Stop a virtual camera output and release it SAFELY.
            ///
            /// `obs_output_stop` is asynchronous. Releasing immediately after
            /// it lets `obs_output_destroy` run `obs_output_actual_stop` a
            /// SECOND time, which re-enters the plugin's stop callback — the
            /// double `CFRelease` that crashed v0.4.40 on macOS. Drain the
            /// output first; the plugin-side stop is idempotent as of the
            /// v0.4.41 engine, this is the belt to that pair of braces.
            unsafe fn stop_vcam(out: *mut ffi::obs_output_t) {
                ffi::obs_output_stop(out);
                let deadline = Instant::now() + Duration::from_secs(5);
                while ffi::obs_output_active(out) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                ffi::obs_output_release(out);
            }
            /// Create + start the virtual camera output on `mix` — the
            /// guests' and mods' RETURN FEED, which is always the room scene,
            /// never the main mix (which is the UI while studio is on).
            unsafe fn start_vcam(mix: *mut ffi::video_t, portrait: bool, mirrored: bool) -> Result<*mut ffi::obs_output_t, String> {
                let id = CString::new("virtualcam_output").unwrap();
                let name = CString::new(graph::VCAM_DEVICE_NAME).unwrap();
                let settings = ffi::obs_data_create();
                ffi::obs_data_set_bool(settings, b"portrait\0".as_ptr().cast(), portrait);
                ffi::obs_data_set_bool(settings, b"mirrored\0".as_ptr().cast(), mirrored);
                let out = ffi::obs_output_create(
                    id.as_ptr(), name.as_ptr(), settings, ptr::null_mut(),
                );
                ffi::obs_data_release(settings);
                if out.is_null() {
                    return Err("this engine has no virtual camera output".into());
                }
                ffi::obs_output_set_media(out, mix, ffi::obs_get_audio());
                if !ffi::obs_output_start(out) {
                    let e = ffi::obs_output_get_last_error(out);
                    // Upstream's text is OBS-branded; it reaches the user as
                    // a command error, which never passes through the sink.
                    let msg = if e.is_null() {
                        #[cfg(target_os = "macos")]
                        {
                            "the virtual camera refused to start — is the extension approved?"
                                .to_string()
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            #[cfg(target_os = "windows")]
                            if ffi::producer_vcam_in_use() != 0 {
                                "The virtual camera is busy. Close other camera sessions in Producer or OBS, then try again.".to_string()
                            } else {
                                "The virtual camera could not start. Check its installation and try again.".to_string()
                            }
                            #[cfg(not(target_os = "windows"))]
                            "the virtual camera refused to start — install the camera first".to_string()
                        }
                    } else {
                        user_facing(&CStr::from_ptr(e).to_string_lossy())
                    };
                    ffi::obs_output_release(out);
                    return Err(msg);
                }
                Ok(out)
            }
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
            #[cfg(debug_assertions)]
            if let (Some(g),Ok(path))=(scene.as_mut(),std::env::var("PRODUCER_SET_OUTPUT_PROBE")) {
                let handle=LiveHandle{cmd:probe_cmd,snapshot:snap.clone(),streaming:streaming_flag.clone()};
                if let Err(e)=unsafe {super::presentation_probe::start(g,handle,std::path::PathBuf::from(path.clone()))} {let _=std::fs::write(std::path::Path::new(&path).join("result.json"),serde_json::json!({"ok":false,"error":e}).to_string());}
            }
            let mut dj = super::dj::Dj::default();
            let mut soundboard = super::soundboard::Soundboard::default();
            let mut preview: Option<Preview> = None;
            let mut portrait_preview: Option<Preview> = None;
            let mut selected_portrait=false;
            let mut selected_video=unsafe{ffi::obs_get_video()};
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

            let async_room_mic = cfg!(target_os = "macos")
                && std::env::var_os("PRODUCER_ASYNC_ROOM_MIC").is_some();
            let mic_proof_delay = if cfg!(debug_assertions) {
                std::env::var("PRODUCER_MIC_PROOF_DELAY_MS").ok()
                    .and_then(|value| value.parse::<u64>().ok()).unwrap_or(0).min(30000)
            } else { 0 };
            let mut microphones: Vec<RoomMicStart> = Vec::new();
            let mut mic_worker: Option<RoomMicWorker> = None;
            let trace_room_open = std::env::var_os("PRODUCER_TRACE_ROOM_OPEN").is_some();

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
                            if let Ok(mut f) = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(dir.join("slow-cmds.log"))
                            {
                                let _ = f.write_all(
                                    format!(
                                        "{} {} {}ms\n",
                                        probe_t0.elapsed().as_millis(),
                                        label,
                                        ms
                                    )
                                    .as_bytes(),
                                );
                            }
                        }
                    }
                }
                let iter_t0 = Instant::now();
                let mut iter_label: &'static str = "idle";
                for recording in [recorder.as_ref(), portrait_recorder.as_ref()].into_iter().flatten() {
                    if let Some(message) = recording.take_failure() {
                        eprintln!("[recording] {message}");
                        let _ = std::fs::OpenOptions::new().create(true).append(true)
                            .open(module_config_dir.join("recording-errors.log"))
                            .and_then(|mut file| {
                                use std::io::Write;
                                writeln!(file, "{message}")
                            });
                        sink(&LiveEvent::EngineError { message });
                    }
                }
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
                        let probe = if probe_last.elapsed() > Duration::from_millis(500) {
                            probe_last = Instant::now();
                            g.frame_probe()
                        } else {
                            Vec::new()
                        };
                        if probe.iter().any(|(_, w, _, _)| *w == 0) {
                            if let Some(dir) = module_config_dir.parent() {
                                let total = unsafe { ffi::obs_get_total_frames() };
                                let line = format!(
                                    "{} total_frames={} {}\n",
                                    probe_t0.elapsed().as_millis(),
                                    total,
                                    probe
                                        .iter()
                                        .map(|(id, w, a, sh)| format!(
                                            "{id}:w={w},active={a},showing={sh}"
                                        ))
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
                        let render_time_us = ffi::obs_get_average_frame_time_ns() as f64 / 1000.0;
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
                        sn.render_time_us = render_time_us;
                        crate::performance_trace::engine_metrics_updated();
                    }
                }

                let mic_status_changed = !microphones.is_empty();
                if mic_worker.as_ref().is_some_and(|(_, worker)| worker.is_finished()) {
                    let (token, worker) = mic_worker.take().unwrap();
                    let result = worker.join().unwrap_or_else(|_| Err("Microphone setup failed".into()));
                    if let Some(mic) = microphones.iter_mut().find(|mic| Arc::ptr_eq(&mic.cancelled, &token)) {
                        let will_attach = result.is_ok();
                        let attach_started = Instant::now();
                        if will_attach { performance_stage("native.mic.attach.start", Duration::ZERO, None); }
                        let result = result.and_then(|source| {
                            let graph = scene.as_mut().ok_or("Room scene is unavailable")?;
                            let packet = graph.attach_prepared_room_mic(mic.extra.clone(), source, Some(mic.change.clone()))?;
                            if let Some(volume) = mic.volume {
                                graph.set_source_audio(&mic.extra.id, Some(volume), None)?;
                            }
                            Ok(packet)
                        });
                        if will_attach { performance_stage("native.mic.attach.complete", attach_started.elapsed(), Some(result.is_ok())); }
                        match result {
                            Ok(packet) => {
                                mic.stage = RoomMicStage::Attached(packet);
                                performance_stage("native.mic.attached", mic.started.elapsed(), Some(true));
                                if trace_room_open {
                                    eprintln!("[room-open] mic_attached_ms={}", mic.started.elapsed().as_millis());
                                }
                                if let Some(graph) = scene.as_ref() {
                                    let sources = graph.state();
                                    {
                                        let mut snapshot = snap.lock().unwrap();
                                        snapshot.sources = sources.clone();
                                        room_mic_status(&mut snapshot, &microphones);
                                    }
                                    sink(&LiveEvent::SourcesChanged { sources });
                                }
                            }
                            Err(message) => {
                                mic.stage = RoomMicStage::Failed;
                                performance_stage("native.mic.failed", mic.started.elapsed(), Some(false));
                                sink(&LiveEvent::EngineError { message });
                            }
                        }
                    } else {
                        performance_stage("native.mic.stale_completion", Duration::ZERO, None);
                        if trace_room_open { eprintln!("[room-open] dropped stale microphone completion"); }
                    }
                }
                if mic_worker.is_none() {
                    if let Some(mic) = microphones.iter_mut().find(|mic| matches!(mic.stage, RoomMicStage::Queued)) {
                        let extra = mic.extra.clone();
                        let cancelled = mic.cancelled.clone();
                        performance_stage("native.mic.prepare.queue_wait", mic.started.elapsed(), None);
                        let worker = std::thread::Builder::new().name("room-mic-prepare".into()).spawn(move || {
                            let prepare_started = Instant::now();
                            performance_stage("native.mic.prepare.start", Duration::ZERO, None);
                            if mic_proof_delay > 0 {
                                std::thread::sleep(Duration::from_millis(mic_proof_delay));
                            }
                            if cancelled.load(AtomicOrdering::Acquire) {
                                performance_stage("native.mic.prepare.cancelled", prepare_started.elapsed(), None);
                                return Err("Microphone setup cancelled".into());
                            }
                            let source = graph::DetachedRoomMic::prepare(&extra);
                            performance_stage("native.mic.worker.ready", prepare_started.elapsed(), Some(source.is_ok()));
                            if cancelled.load(AtomicOrdering::Acquire) {
                                performance_stage("native.mic.prepare.cancelled", prepare_started.elapsed(), None);
                                return Err("Microphone setup cancelled".into());
                            }
                            source
                        });
                        match worker {
                            Ok(worker) => {
                                mic.stage = RoomMicStage::Preparing;
                                mic_worker = Some((mic.cancelled.clone(), worker));
                            }
                            Err(error) => {
                                mic.stage = RoomMicStage::Failed;
                                performance_stage("native.mic.worker.spawn_failed", mic.started.elapsed(), Some(false));
                                sink(&LiveEvent::EngineError { message: error.to_string() });
                            }
                        }
                    }
                }
                microphones.retain(|mic| {
                    let RoomMicStage::Attached(packet) = &mic.stage else { return true; };
                    let Some(first) = packet.first_packet() else { return true; };
                    crate::performance_trace::native_stage_at("native.mic.first_packet", first, first.duration_since(mic.started), Some(true));
                    if trace_room_open {
                        eprintln!("[room-open] mic_first_packet_ms={}", first.duration_since(mic.started).as_millis());
                    }
                    false
                });
                if mic_status_changed {
                    room_mic_status(&mut snap.lock().unwrap(), &microphones);
                }
                // 120ms tick: meters want ~8Hz; command latency stays low.
                if let Some(g)=scene.as_mut(){g.warm_ready_buffers();}
                let received = cmd_rx.recv_timeout(Duration::from_millis(120));
                if let Ok(c) = &received {
                    iter_label = cmd_name(c);
                }
                iter_prev = Some((iter_t0, iter_label));
                match received {
                    Ok(Command::Soundboard { action, reply }) => {
                        let changing=matches!(&action,crate::soundboard::Native::Activate(room) if !soundboard.room().is_empty() && soundboard.room()!=room);
                        let _=reply.send(if changing&&(session.is_some()||recorder.is_some()){Err("Stop the current output before switching soundboard rooms".into())}else if report.ok {soundboard.apply(action)} else {Err("Room audio engine unavailable".into())});
                    }
                    Ok(Command::Dj { action, reply }) => {
                        let result = if report.ok { dj.apply(action) } else { Err("The room audio engine did not start".into()) };
                        let _ = reply.send(result);
                    }
                    Ok(Command::VirtualCamMirror { on, reply }) => {
                        let result = (|| -> Result<bool, String> {
                            if let Some(next) = on {
                                let pending = mirror_path.with_extension("json.tmp");
                                std::fs::write(&pending, if next { b"true".as_slice() } else { b"false".as_slice() }).map_err(|e| e.to_string())?;
                                std::fs::rename(&pending, &mirror_path).map_err(|e| e.to_string())?;
                                if let Some(output) = vcam {
                                    unsafe {
                                        let settings = ffi::obs_data_create();
                                        ffi::obs_data_set_bool(settings, b"mirrored\0".as_ptr().cast(), next);
                                        ffi::obs_output_update(output, settings);
                                        ffi::obs_data_release(settings);
                                    }
                                }
                                vcam_mirrored = next;
                                #[cfg(target_os = "windows")]
                                if let Some(m) = room_mix.as_ref() { unsafe { m.set_mirrored(next); } }
                            }
                            Ok(vcam_mirrored)
                        })();
                        let _ = reply.send(result);
                    }
                    Ok(Command::SelectOutput{portrait,reply})=>{
                        let result=(||->Result<(),String>{
                            if selected_portrait==portrait{return Ok(());}
                            if vcam.is_some(){return Err("Stop the virtual camera before changing the output canvas".into());}
                            if session.is_some()||recorder.is_some()||portrait_recorder.is_some(){return Err("Stop streaming and recording before changing the output canvas".into());}
                            let video=if portrait{
                                #[cfg(any(target_os = "macos", target_os = "windows"))]{scene.as_mut().ok_or("Room is not ready")?.portrait_video()?}
                                #[cfg(not(any(target_os = "macos", target_os = "windows")))]{return Err("Portrait output is unavailable in this build".into());}
                            }else{unsafe{ffi::obs_get_video()}};
                            #[cfg(any(target_os = "macos", target_os = "windows"))]super::portrait::select_program(portrait);
                            if selected_portrait!=portrait {selected_video=video;selected_portrait=portrait;hub_engine.program_portrait.store(portrait,std::sync::atomic::Ordering::Relaxed);if let Some(g)=scene.as_ref(){hub_engine.publish_targets(g);}}
                            Ok(())
                        })();let _=reply.send(result);
                    }
                    Ok(Command::GoLive { config, reply }) => {
                        let mic_unready = {
                            let snapshot = snap.lock().unwrap();
                            snapshot.room_mic_pending || snapshot.room_mic_failed
                        };
                        let approval = if mic_unready {
                            Err("The room microphone is not ready".into())
                        } else if session.is_some() {
                            Err("go-live refused: session already running".into())
                        } else if !report.ok {
                            Err("go-live refused: engine bootstrap failed".into())
                        } else {
                            Ok(())
                        };
                        let approved = approval.is_ok();
                        // The caller may start Boomin presence after this reply.
                        // A request that timed out waiting in the queue must not start later.
                        if reply.send(approval).is_ok() && approved {
                            set_state(&mut state, SessionState::Starting, &snap, &sink);
                            match Session::start_video(config,if selected_portrait{selected_video}else{unsafe{ffi::obs_get_video()}}) {
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
                    Ok(Command::SetTransform { id, patch, commit }) => {
                        if let Some(mic) = microphones.iter_mut().find(|mic| mic.extra.id == id) {
                            mic.update_audio_plan(patch.visible, None);
                            if !mic.is_attached() { continue; }
                        }
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
                    Ok(Command::PortraitRoom{reply})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]let result=scene.as_mut().ok_or("Room is not ready".into()).and_then(|g|g.portrait_room());
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]let result=Err("Portrait output is unavailable on this platform".into());let _=reply.send(result);
                    }
                    Ok(Command::PortraitState{reply})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]let result=scene.as_mut().ok_or("Room is not ready".into()).and_then(|g|{if g.portrait_canvas().is_err(){return Err("Portrait room is unavailable".into());}g.sync_portrait_room();Ok(g.portrait_state())});
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]let result=Err("Portrait output is unavailable on this platform".into());let _=reply.send(result);
                    }
                    Ok(Command::PortraitTransform{id,patch,reply})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]let result=scene.as_mut().ok_or("Room is not ready".into()).and_then(|g|g.portrait_transform(&id,patch));
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]let result={let _=(id,patch);Err("Portrait output is unavailable on this platform".into())};let _=reply.send(result);
                    }
                    Ok(Command::PortraitPreview{window,rect,reply})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]let result=(||->Result<(),String>{if let Some(rect)=rect{if let Some(p)=portrait_preview.as_mut(){p.set_rect(rect);}else{let canvas=scene.as_mut().ok_or("Room is not ready")?.portrait_canvas()?;portrait_preview=Some(unsafe{Preview::attach_canvas(window as *mut _,rect,canvas)?});}}else if let Some(p)=portrait_preview.take(){p.detach();}Ok(())})();
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]let result={let _=(window,rect);Err("Portrait output is unavailable on this platform".into())};let _=reply.send(result);
                    }
                    Ok(Command::PortraitWarm{request,reply})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]
                        let result=scene.as_mut().ok_or("Room scene unavailable".to_string()).and_then(|g|g.portrait_warm(request));
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                        let result={let _=request;Err("Portrait warmup is currently a Mac dev capability".into())};
                        let _=reply.send(result);
                    }
                    Ok(Command::PortraitPrepare{request,reply})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]
                        let result=scene.as_mut().ok_or("Room scene unavailable".to_string()).and_then(|g|g.portrait_prepare(request));
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                        let result={let _=request;Err("Portrait preview is currently a Mac dev capability".into())};
                        let _=reply.send(result);
                    }
                    Ok(Command::PortraitAbort{token,revision})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]
                        if let Some(g)=scene.as_mut(){g.portrait_abort(&token,revision);}
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                        let _=(token,revision);
                    }
                    Ok(Command::PortraitCommit{token,placements,reply})=>{
                        #[cfg(any(target_os = "macos", target_os = "windows"))]
                        let result=scene.as_mut().ok_or("Room scene unavailable".to_string()).and_then(|g|g.portrait_commit(&token,placements));
                        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                        let result={let _=(token,placements);Err("Portrait preview is currently a Mac dev capability".into())};
                        let _=reply.send(result);
                    }
                    Ok(Command::PortraitStop{queued_at,reply})=>{
                        performance_stage("native.portrait.stop.engine_wait",queued_at.elapsed(),None);
                        let service=Instant::now();
                        if portrait_recorder.is_some()||selected_portrait{
                            performance_stage("native.portrait.stop.output_retained",service.elapsed(),Some(true));
                            let _=reply.send(());continue;
                        }
                        if let Some(p)=portrait_preview.take(){p.detach();}
                        #[cfg(any(target_os = "macos", target_os = "windows"))]
                        if let Some(g)=scene.as_mut(){g.portrait_stop();}
                        performance_stage("native.portrait.stop.engine_complete",service.elapsed(),Some(true));
                        let _=reply.send(());
                    }
                    Ok(Command::PortraitFrame{reply})=>{#[cfg(any(target_os = "macos", target_os = "windows"))]let frame=scene.as_ref().map(|g|g.portrait_frame()).unwrap_or_default();#[cfg(not(any(target_os = "macos", target_os = "windows")))]let frame=String::new();let _=reply.send(frame);}
                    Ok(Command::SetSourceCreate{id,label,spec,reply})=>{
                        let result=scene.as_mut().ok_or("Room unavailable".to_string()).and_then(|g|g.create_set_source(&id,&label,&spec));
                        if let Ok(sources)=&result{snap.lock().unwrap().sources=sources.clone();sink(&LiveEvent::SourcesChanged{sources:sources.clone()});}
                        let _=reply.send(result);
                    }
                    Ok(Command::SetsV2 {action,queued_at,reply}) => {
                        use super::sets_v2::contract::Action as SetAction;
                        let stages=match &action {
                            SetAction::Preload{..}=>Some(("native.set.preload.engine_wait","native.set.preload.engine_complete")),
                            SetAction::Activate{..}=>Some(("native.set.activate.engine_wait","native.set.activate.engine_complete")),
                            SetAction::Retain{..}=>Some(("native.set.retain.engine_wait","native.set.retain.engine_complete")),
                            SetAction::Take{..}|SetAction::TakePair{..}=>Some(("native.set.take.engine_wait","native.set.take.engine_complete")),
                            _=>None,
                        };
                        if let Some((queued,_))=stages{performance_stage(queued,queued_at.elapsed(),None);}
                        let service=Instant::now();
                        let result=scene.as_mut().ok_or_else(||"The dev room is not running".to_string()).and_then(|g|g.sets_v2(action));
                        if let Some((_,complete))=stages{performance_stage(complete,service.elapsed(),Some(result.is_ok()));}
                        let _=reply.send(result);
                    }
                    Ok(Command::PresentationStatus {reply})=> {let _=reply.send(scene.as_ref().map_or(super::presentation::Status{generation:0,lease:None,revision:0},|g|g.presentation_status()));}
                    Ok(Command::PresentationWarm{request,reply})=>{let result=scene.as_mut().ok_or("Room scene unavailable".to_string()).and_then(|g|g.warm_presentation(request));let _=reply.send(result);}
                    Ok(Command::PresentationPrepare {request,reply})=> {let result=scene.as_mut().ok_or_else(||"The room scene is not running".to_string()).and_then(|g|g.prepare_presentation(request));let _=reply.send(result);}
                    Ok(Command::PresentationCommit {token,placements,reply})=> {let result=scene.as_mut().ok_or_else(||"The room scene is not running".to_string()).and_then(|g|g.commit_presentation(&token,placements));let _=reply.send(result);}
                    Ok(Command::PresentationAbort {token,revision})=> {if let Some(g)=scene.as_mut(){g.abort_presentation(&token,revision);}}
                    Ok(Command::PresentationReturn {lease,reply})=> {let result=scene.as_mut().ok_or_else(||"The room scene is not running".to_string()).and_then(|g|g.return_presentation(lease.as_deref()));let _=reply.send(result);}
                    Ok(Command::ApplyScene { changes, reply }) => {
                        let mut changes = changes;
                        let mut deferred = Vec::new();
                        if !microphones.is_empty() && changes.len() <= 128 {
                            changes.retain(|change| {
                                if microphones.iter().any(|mic| mic.extra.id == change.id && !mic.is_attached()) {
                                    deferred.push(change.clone());
                                    false
                                } else {
                                    true
                                }
                            });
                        }
                        let result = match scene.as_mut() {
                            Some(g) if changes.is_empty() && !deferred.is_empty() => Ok(g.state()),
                            Some(g) => g.apply_scene(&changes).map(|()| g.state()),
                            None => Err("The room scene is not running".into()),
                        };
                        if let Ok(sources) = &result {
                            for change in changes.iter().chain(&deferred) {
                                if let Some(mic) = microphones.iter_mut().find(|mic| mic.extra.id == change.id) {
                                    mic.update_audio_plan(change.patch.visible, change.muted);
                                }
                            }
                            {
                                let mut snapshot = snap.lock().unwrap();
                                snapshot.sources = sources.clone();
                                room_mic_status(&mut snapshot, &microphones);
                            }
                            sink(&LiveEvent::SourcesChanged { sources: sources.clone() });
                        }
                        let _ = reply.send(result);
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
                    Ok(Command::StartRecording { stamp, dual, reply }) => {
                        let mic_unready = {
                            let snapshot = snap.lock().unwrap();
                            snapshot.room_mic_pending || snapshot.room_mic_failed
                        };
                        if mic_unready {
                            let _ = reply.send(Err("The room microphone is not ready".into()));
                        } else if recorder.is_some() {
                            let _ = reply.send(Err("already recording".into()));
                        } else {
                            // Recording rides the same canvas as the stream at
                            // a quality bitrate keyed by canvas + frame rate.
                            let br = {
                                let s = snap.lock().unwrap();
                                record_kbps(s.video_height, s.video_fps)
                            };
                            let result=(||->Result<String,String>{
                                if dual {
                                    #[cfg(any(target_os = "macos", target_os = "windows"))]{let video=scene.as_mut().ok_or("Room is not ready")?.portrait_video()?;portrait_recorder=Some(unsafe{record::Recorder::start_video(&format!("{stamp} Portrait"),br,video)?});}
                                    #[cfg(not(any(target_os = "macos", target_os = "windows")))]return Err("Dual recording is unavailable on this platform".into());
                                }
                                match unsafe{record::Recorder::start_video(&stamp,br,if selected_portrait{selected_video}else{ffi::obs_get_video()})}{Ok(r)=>{let path=r.path();recorder=Some(r);Ok(path)},Err(e)=>{if let Some(r)=portrait_recorder.take(){r.stop();}Err(e)}}
                            })();
                            if let Err(e)=&result{sink(&LiveEvent::EngineError{message:e.clone()});}let _=reply.send(result);
                        }
                    }
                    Ok(Command::StopRecording { reply }) => {
                        if let Some(r)=portrait_recorder.take(){r.stop();}
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
                        if let Some(mic) = microphones.iter_mut().find(|mic| mic.extra.id == id) {
                            mic.update_audio_plan(None, muted);
                            mic.volume = volume.or(mic.volume);
                            if !mic.is_attached() { continue; }
                        }
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
                                FilterOp::Add { kind, name } => {
                                    super::filters::add(src, kind, name)?
                                }
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
                                        stop_vcam(o);
                                    }
                                    // The mix outlives the studio, not the app:
                                    // with no camera reading it there is nothing
                                    // to render, so give the mix back.
                                    if let Some(mut m) = room_mix.take() {
                                        m.teardown();
                                    }
                                    return Ok(false);
                                }
                                if vcam.is_some() {
                                    return Ok(true);
                                }
                                // The portrait canvas owns a separate native video output.
                                // Keep it alive for the lifetime of the camera, just as
                                // room_mix owns the landscape video output.
                                #[cfg(target_os = "windows")]
                                let mix = if selected_portrait {
                                    let canvas=scene.as_mut().ok_or("Room is not ready")?.portrait_canvas()?;
                                    room_mix=Some(studio::RoomMix::build_windows(ptr::null_mut(),canvas)?);
                                    room_mix.as_ref().unwrap().video()
                                } else {room_mix_video(&mut room_mix)?};
                                #[cfg(not(target_os = "windows"))]
                                let mix = if selected_portrait { selected_video }
                                    else { room_mix_video(&mut room_mix)? };
                                #[cfg(target_os = "windows")]
                                if let Some(m) = room_mix.as_ref() { m.set_mirrored(vcam_mirrored); }
                                match start_vcam(mix, selected_portrait, vcam_mirrored) {
                                    Ok(output) => vcam = Some(output),
                                    Err(error) => { if let Some(mut m)=room_mix.take(){m.teardown();} return Err(error); }
                                }
                                Ok(true)
                            }
                        })();
                        if let Err(e) = &r {
                            sink(&LiveEvent::EngineError { message: e.clone() });
                        }
                        let _ = reply.send(r);
                    }
                    Ok(Command::SetStudio { spec, reply }) => {
                        let r = (|| -> Result<bool, String> {
                            unsafe {
                                let same = match (&studio_out, &spec) {
                                    (Some(st), Some(sp)) => {
                                        st.spec.window_id == sp.window_id
                                    }
                                    (None, None) => true,
                                    _ => false,
                                };
                                if same {
                                    return Ok(studio_out.is_some());
                                }
                                if let Some(mut st) = studio_out.take() {
                                    st.teardown();
                                }
                                if let Some(sp) = spec {
                                    studio_out = Some(studio::Studio::build(sp)?);
                                }
                                // v0.4.48 — STUDIO IS THE WHOLE OUTPUT. The
                                // virtual camera used to show the room even
                                // with studio on, so a host using Producer as
                                // their camera in Meet or Zoom sent the stage
                                // while the stream sent the studio. "Broadcast
                                // the studio" now means every output.
                                //
                                // Re-point the MIX, never the OUTPUT: the vcam
                                // keeps running and keeps its video_t, and only
                                // the source behind it changes. Restarting the
                                // output is what crashed v0.4.40 on macOS and
                                // dropped the camera out of Google Meet on
                                // Windows (studio.rs module docs) — that
                                // invariant is intact.
                                if let Some(m) = room_mix.as_mut() {
                                    if !selected_portrait {
                                    match studio_out.as_ref() {
                                        // The studio scene is borrowed from
                                        // Studio; set_source takes its own ref.
                                        Some(st) => m.set_source(st.source()),
                                        None => {
                                            // Off: back to channel 0's room
                                            // scene. obs_get_output_source
                                            // hands back an OWNED reference —
                                            // release it after, exactly as
                                            // room_mix_video does above.
                                            let room = ffi::obs_get_output_source(0);
                                            m.set_source(room);
                                            if !room.is_null() {
                                                ffi::obs_source_release(room);
                                            }
                                        }
                                    }
                                    }
                                }
                                Ok(studio_out.is_some())
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
                    Ok(Command::SetDevice { id, device }) => {
                        if let Some(mic) = microphones.iter_mut().find(|mic| mic.extra.id == id && !mic.is_attached()) {
                            mic.restart(graph::ExtraSpec::Mic { device: Some(device) });
                            continue;
                        }
                        if let Some(g) = scene.as_mut() {
                            match g.set_device(&id, &device) {
                                Ok(()) => {
                                    let sources = g.state();
                                    snap.lock().unwrap().sources = sources.clone();
                                    sink(&LiveEvent::SourcesChanged { sources });
                                }
                                Err(e) => sink(&LiveEvent::EngineError { message: e }),
                            }
                        }
                    }
                    Ok(Command::ReplaceExtra { id, label, spec, initial, reply }) => {
                        if matches!(spec, graph::ExtraSpec::Mic { .. }) {
                            if let Some(mic) = microphones.iter_mut().find(|mic| mic.extra.id == id && !mic.is_attached()) {
                                if let Some(change) = initial {
                                    if change.id != id {
                                        let _ = reply.send(Err("Replacement source identity does not match".into()));
                                        continue;
                                    }
                                    mic.update_audio_plan(change.patch.visible, change.muted);
                                }
                                mic.extra.label = label;
                                mic.restart(spec);
                                let mut snapshot = snap.lock().unwrap();
                                room_mic_status(&mut snapshot, &microphones);
                                let _ = reply.send(Ok(snapshot.sources.clone()));
                                continue;
                            }
                        }
                        let result = match scene.as_mut() {
                            Some(g) => g.replace_extra(&id, &label, &spec, initial),
                            None => Err("The room scene is not running".into()),
                        };
                        if result.is_ok() {
                            microphones.retain(|mic| mic.extra.id != id);
                            room_mic_status(&mut snap.lock().unwrap(), &microphones);
                        }
                        if let Some(g) = scene.as_ref() {
                            let sources = g.state();
                            snap.lock().unwrap().sources = sources.clone();
                            sink(&LiveEvent::SourcesChanged { sources });
                        }
                        let _ = reply.send(result);
                    }
                    Ok(Command::RestoreRoom { queued_at, mut restore, reply }) => {
                        performance_stage("native.room.restore.queue_wait", queued_at.elapsed(), None);
                        performance_stage("native.room.restore.start", Duration::ZERO, None);
                        let restore_started = Instant::now();
                        if trace_room_open {
                            eprintln!("[room-open] engine_queue_ms={}", queued_at.elapsed().as_millis());
                        }
                        let result = if session.is_some() || recorder.is_some() || portrait_recorder.is_some() {
                            Err("Stop streaming and recording before restoring a room".into())
                        } else if restore.extras.len() > 128 || restore.changes.len() > 128 {
                            Err("A room has too many sources".into())
                        } else {
                            microphones.retain(|mic| mic.is_attached() && restore.keep_ids.contains(&mic.extra.id));
                            for mic in &mut microphones {
                                mic.change.patch.visible = Some(false);
                                mic.change.muted = Some(true);
                                if let Some(change) = restore.changes.iter().rev().find(|change| change.id == mic.extra.id) {
                                    mic.update_audio_plan(change.patch.visible, change.muted);
                                }
                            }
                            let deferred = if async_room_mic {
                                defer_room_microphones(&mut restore, queued_at)
                            } else { Vec::new() };
                            let mut result = match scene.as_mut() {
                                Some(g) => g.restore_room(restore),
                                None => Err("The room scene is not running".into()),
                            };
                            if result.is_ok() { microphones.extend(deferred); }
                            let mut snapshot = snap.lock().unwrap();
                            room_mic_status(&mut snapshot, &microphones);
                            if let Ok(restored) = &mut result {
                                restored.room_mic_starting_ids = snapshot.room_mic_starting_ids.clone();
                                restored.room_mic_pending = snapshot.room_mic_pending;
                                restored.room_mic_failed = snapshot.room_mic_failed;
                            }
                            result
                        };
                        // Even a failure leaves the graph hidden. Publish actual engine
                        // truth, never the pre-restore snapshot or a per-source echo.
                        if let Some(g) = scene.as_ref() {
                            let sources = g.state();
                            snap.lock().unwrap().sources = sources.clone();
                            sink(&LiveEvent::SourcesChanged { sources });
                        }
                        performance_stage("native.room.restore.complete", restore_started.elapsed(), Some(result.is_ok()));
                        let _ = reply.send(result);
                    }
                    Ok(Command::AddExtra { id, label, spec }) => {
                        if microphones.iter().any(|mic| mic.extra.id == id && !mic.is_attached()) {
                            sink(&LiveEvent::EngineError { message: format!("an item named {id} already exists") });
                            continue;
                        }
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
                        let was_deferred = microphones.iter().any(|mic| mic.extra.id == id && !mic.is_attached());
                        microphones.retain(|mic| mic.extra.id != id);
                        room_mic_status(&mut snap.lock().unwrap(), &microphones);
                        if was_deferred { continue; }
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
                    Ok(Command::SetPreviewSources { lease, ids }) => {
                        let mut requests=hub_engine.preview_requests.lock().unwrap();
                        if ids.is_empty() { requests.remove(&lease); }
                        else if requests.contains_key(&lease) || requests.len()<8 { requests.insert(lease,ids); }
                        hub_engine.preview_wanted.store(!requests.is_empty(),std::sync::atomic::Ordering::Relaxed);
                        drop(requests);
                        if let Some(g)=scene.as_ref(){hub_engine.publish_targets(g);}
                    }
                    Ok(Command::SetThumbRate { fps }) => {
                        hub_engine
                            .fps
                            .store(fps.min(30), std::sync::atomic::Ordering::Relaxed);
                    }
                    Ok(Command::SetProgramThumb { on }) => {
                        hub_engine
                            .program_wanted
                            .store(on, std::sync::atomic::Ordering::Relaxed);
                        if let Some(g) = scene.as_ref() {
                            hub_engine.publish_targets(g);
                        }
                    }
                    Ok(Command::SetVideo { height, fps }) => {
                        if selected_portrait && vcam.is_some(){sink(&LiveEvent::EngineError{message:"Stop the portrait virtual camera before changing video settings".into()});continue;}
                        if recorder.is_some()||portrait_recorder.is_some(){sink(&LiveEvent::EngineError{message:"Stop recording before changing video settings".into()});continue;}
                        if session.is_some() {
                            sink(&LiveEvent::EngineError {
                                message: "stop the stream to change video settings".into(),
                            });
                        } else if !video_mode_ok(height, fps) {
                            sink(&LiveEvent::EngineError {
                                message: "video settings must be 720p/1080p/2160p at 30/60fps"
                                    .into(),
                            });
                        } else if height == 2160 && !report.hardware_encoder {
                            sink(&LiveEvent::EngineError {
                                message:
                                    "4K needs a hardware encoder (VideoToolbox, NVENC, QSV, or AMF)"
                                        .into(),
                            });
                        } else if height == 2160 && fps == 60 && !four_k_60_ok() {
                            sink(&LiveEvent::EngineError {
                                message: "4K on an Intel Mac runs at 30 fps".into(),
                            });
                        } else if current_video_mode(&snap, height, fps) {
                            // A stale frontend request can arrive after this
                            // mode is already applied. Keep the running graph.
                            sink(&LiveEvent::VideoChanged { height, fps });
                        } else {
                            if let Some(p)=portrait_preview.take(){p.detach();}
                            #[cfg(any(target_os = "macos", target_os = "windows"))]if let Some(g)=scene.as_mut(){g.portrait_stop();}
                            let module = graphics_module(report.graphics_backend.as_deref());
                            // A video reset destroys every mix and every
                            // canvas-sized item, so the studio scene AND the
                            // room mix under the virtual camera come down
                            // first and are rebuilt after (studio.rs). This is
                            // the one command that may cycle the vcam.
                            let studio_spec = studio_out.take().map(|mut st| {
                                unsafe { st.teardown() };
                                st.spec
                            });
                            let vcam_was_on = vcam.is_some();
                            unsafe {
                                if let Some(o) = vcam.take() {
                                    stop_vcam(o);
                                }
                                if let Some(mut m) = room_mix.take() {
                                    m.teardown();
                                }
                            }
                            match reset_video(module, height, fps) {
                                Ok(()) => {
                                    if let Some(g) = scene.as_mut() {
                                        g.relayout();
                                        #[cfg(any(target_os = "macos", target_os = "windows"))]if selected_portrait{if let Err(e)=g.portrait_room(){sink(&LiveEvent::EngineError{message:format!("portrait resize: {e}")});}}
                                    }
                                    if let Some(sp) = studio_spec {
                                        unsafe {
                                            match studio::Studio::build(sp) {
                                                Ok(st) => studio_out = Some(st),
                                                Err(e) => sink(&LiveEvent::EngineError {
                                                    message: format!("studio: {e}"),
                                                }),
                                            }
                                        }
                                    }
                                    if vcam_was_on {
                                        unsafe {
                                            let rebuilt=(|| -> Result<*mut ffi::obs_output_t,String> {
                                                #[cfg(target_os="windows")]
                                                let mix=if selected_portrait {
                                                    let canvas=scene.as_mut().ok_or("Room is not ready")?.portrait_canvas()?;
                                                    room_mix=Some(studio::RoomMix::build_windows(ptr::null_mut(),canvas)?);
                                                    room_mix.as_ref().unwrap().video()
                                                }else{room_mix_video(&mut room_mix)?};
                                                #[cfg(not(target_os="windows"))]
                                                let mix=room_mix_video(&mut room_mix)?;
                                                #[cfg(target_os="windows")]
                                                if let Some(m)=room_mix.as_ref(){m.set_mirrored(vcam_mirrored);}
                                                start_vcam(mix,selected_portrait,vcam_mirrored)
                                            })();
                                            match rebuilt
                                            {
                                                Ok(o) => vcam = Some(o),
                                                Err(e) => sink(&LiveEvent::EngineError {
                                                    message: format!("virtual camera: {e}"),
                                                }),
                                            }
                                        }
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
                        if let Some(p) = preview.as_mut() {
                            p.set_rect(rect);
                        } else {
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
                                {
                                    let v = p.view as usize;
                                    let h = if hidden { 1 } else { 0 };
                                    on_window_thread(move || {
                                        ffi::producer_preview_set_hidden(
                                            v as *mut std::os::raw::c_void,
                                            h,
                                        )
                                    })
                                }
                            };
                        }
                    }
                    Ok(Command::SetPreviewCutouts(rects)) => {
                        // Windows float mode only: elsewhere the preview sits
                        // below the webview and nothing needs punching out.
                        #[cfg(target_os = "windows")]
                        apply_preview_cutouts(preview.as_ref(), portrait_preview.as_ref(), rects);
                        #[cfg(not(target_os = "windows"))]
                        let _ = rects;
                    }
                    Ok(Command::ReleaseIdleRoom { reply }) => {
                        let release_started = Instant::now();
                        performance_stage("native.room.release.start", Duration::ZERO, None);
                        // Presentation-only: active outputs keep their source
                        // graph, but no visible preview may expose the camera
                        // underneath a Set while that graph is being cleared.
                        if let Some(p)=preview.as_ref(){p.conceal();}
                        if let Some(p)=portrait_preview.as_ref(){p.conceal();}
                        // Evaluate on the engine thread, so an output starting
                        // during navigation cannot lose its capture sources.
                        if session.is_some() || recorder.is_some() || portrait_recorder.is_some() {
                            performance_stage("native.room.release.skipped", release_started.elapsed(), None);
                            let _ = reply.send(Ok(false));
                        } else {
                            microphones.clear();
                            room_mic_status(&mut snap.lock().unwrap(), &microphones);
                            #[cfg(any(target_os = "macos", target_os = "windows"))]super::portrait::select_program(false);
                            selected_portrait=false;selected_video=unsafe{ffi::obs_get_video()};hub_engine.program_portrait.store(false,std::sync::atomic::Ordering::Relaxed);
                            dj.clear();
                            soundboard.clear();
                            if let Some(output) = vcam.take() { unsafe { stop_vcam(output); } }
                            if let Some(mut m) = room_mix.take() { unsafe { m.teardown(); } }
                            if let Some(mut st) = studio_out.take() { unsafe { st.teardown(); } }
                            let result = if let Some(g) = scene.as_mut() {
                                g.clear_room().map(|()| {
                                    // Release thumbnail-owned camera references too.
                                    hub_engine.publish_targets(g);
                                    snap.lock().unwrap().sources = g.state();
                                    true
                                })
                            } else { Ok(true) };
                            // No SourcesChanged: unloading must not rewrite the
                            // saved room document or the next mounted room.
                            performance_stage("native.room.release.complete", release_started.elapsed(), Some(result.is_ok()));
                            let _ = reply.send(result);
                        }
                    }
                    Ok(Command::DetachPreview { reply }) => {
                        let started=Instant::now();
                        performance_stage("native.preview.detach.start",Duration::ZERO,None);
                        // Conceal BOTH siblings before either destruction can
                        // wait for graphics. Reply only after native removal.
                        if let Some(p)=preview.as_ref(){p.conceal();}
                        if let Some(p)=portrait_preview.as_ref(){p.conceal();}
                        performance_stage("native.preview.detach.hidden",started.elapsed(),Some(true));
                        if let Some(p)=portrait_preview.take(){p.detach();}
                        if let Some(p) = preview.take() {
                            p.detach();
                            snap.lock().unwrap().preview_attached = false;
                        }
                        performance_stage("native.preview.detach.complete",started.elapsed(),Some(true));
                        let _=reply.send(());
                    }
                    Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        microphones.clear();
                        if let Some(r)=portrait_recorder.take(){r.stop();}
                        if let Some(r)=recorder.take(){r.stop();}
                        unsafe {
                            if let Some(o) = vcam.take() {
                                stop_vcam(o);
                            }
                            if let Some(mut m) = room_mix.take() {
                                m.teardown();
                            }
                        }
                        if let Some(mut st) = studio_out.take() {
                            unsafe { st.teardown() };
                        }
                        if let Some(p)=portrait_preview.take(){p.detach();}
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

                #[cfg(any(target_os = "macos", target_os = "windows"))]
                if let Some(g)=scene.as_mut(){g.sync_portrait_room();}
                dj.tick(scene.as_ref().is_some_and(|g| g.dj_speaking()));

                // Meter stream — while any metered extra (mic, guest, mod,
                // media) exists.
                if scene
                    .as_ref()
                    .is_some_and(|g| !g.take_extra_peaks_ids_empty())
                    && last_levels_emit.elapsed() > Duration::from_millis(110)
                {
                    last_levels_emit = Instant::now();
                    sink(&LiveEvent::Levels {
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
