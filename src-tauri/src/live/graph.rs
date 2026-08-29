//! Graph management (LIVE-REVIEW.md §5.1 module layout). M-L2 scope: put a
//! ScreenCaptureKit display source and a CoreAudio mic source live in the
//! graph, under the engine-owner-thread invariant, and gather truthful
//! evidence that both are producing data (rendered frame count, audio
//! callback count and peak level, source dimensions) plus the real TCC state.
//!
//! All obs_* calls happen on the live-engine thread. The libobs audio/video
//! threads only touch the atomics below — callbacks publish immutable data,
//! never mutate app or engine state (§5.1).

use std::ffi::CString;
use std::os::raw::c_void;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::ffi;

static AUDIO_CALLBACKS: AtomicU64 = AtomicU64::new(0);
static AUDIO_FRAMES: AtomicU64 = AtomicU64::new(0);
/// Peak absolute sample value across the probe window, in millionths.
static AUDIO_PEAK_MICRO: AtomicU64 = AtomicU64::new(0);
static VIDEO_FRAMES: AtomicU64 = AtomicU64::new(0);

extern "C" fn audio_cb(
    _param: *mut c_void,
    _source: *mut ffi::obs_source_t,
    audio: *const ffi::audio_data,
    muted: bool,
) {
    AUDIO_CALLBACKS.fetch_add(1, Ordering::Relaxed);
    if muted || audio.is_null() {
        return;
    }
    let audio = unsafe { &*audio };
    AUDIO_FRAMES.fetch_add(audio.frames as u64, Ordering::Relaxed);
    let plane = audio.data[0] as *const f32;
    if plane.is_null() {
        return;
    }
    let mut peak = 0f32;
    for i in 0..audio.frames as usize {
        let s = unsafe { *plane.add(i) }.abs();
        if s > peak {
            peak = s;
        }
    }
    AUDIO_PEAK_MICRO.fetch_max((peak * 1_000_000.0) as u64, Ordering::Relaxed);
}

extern "C" fn video_cb(_param: *mut c_void, _frame: *mut ffi::video_data) {
    VIDEO_FRAMES.fetch_add(1, Ordering::Relaxed);
}

/// Run a closure on the macOS main thread (blocking) — used for the TCC
/// preflight/request calls, which can present system UI.
fn on_main_thread<T: Send, F: FnOnce() -> T + Send>(f: F) -> T {
    if unsafe { ffi::pthread_main_np() } == 1 {
        return f();
    }
    struct Ctx<F, T> {
        f: Option<F>,
        out: Option<T>,
    }
    extern "C" fn run<F: FnOnce() -> T, T>(ctx: *mut c_void) {
        let ctx = unsafe { &mut *(ctx as *mut Ctx<F, T>) };
        let f = ctx.f.take().unwrap();
        ctx.out = Some(f());
    }
    let mut ctx = Ctx { f: Some(f), out: None };
    unsafe {
        ffi::dispatch_sync_f(
            &ffi::_dispatch_main_q as *const c_void,
            &mut ctx as *mut Ctx<_, T> as *mut c_void,
            run::<F, T>,
        );
    }
    ctx.out.unwrap()
}

/// UUID string of the main display, via the same CoreGraphics calls OBS's
/// display picker uses.
fn main_display_uuid() -> Option<String> {
    unsafe {
        let uuid = ffi::CGDisplayCreateUUIDFromDisplayID(ffi::CGMainDisplayID());
        if uuid.is_null() {
            return None;
        }
        let s = ffi::CFUUIDCreateString(ptr::null(), uuid);
        ffi::CFRelease(uuid);
        if s.is_null() {
            return None;
        }
        let mut buf = [0i8; 64];
        let ok = ffi::CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, ffi::K_CF_STRING_ENCODING_UTF8);
        ffi::CFRelease(s);
        if !ok {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr(buf.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureProbeReport {
    pub ok: bool,
    /// Screen Recording TCC state before the probe (CGPreflightScreenCaptureAccess).
    pub screen_tcc_granted: bool,
    /// Whether we asked the OS to show the Screen Recording prompt this run.
    pub screen_tcc_prompted: bool,
    pub probe_seconds: f64,
    pub screen_source_size: (u32, u32),
    pub rendered_frames: u64,
    pub mic_audio_callbacks: u64,
    pub mic_audio_frames: u64,
    pub mic_peak_level: f64,
    pub notes: Vec<String>,
}

/// M-L2 capture probe. MUST run on the live-engine thread, after bootstrap.
pub fn capture_probe(window: Duration) -> CaptureProbeReport {
    let mut notes = Vec::new();

    // Real TCC, up front. A grant issued while this process is running does
    // not always apply to it — the relaunch note tells the operator what to do.
    let granted = on_main_thread(|| unsafe { ffi::CGPreflightScreenCaptureAccess() });
    let mut prompted = false;
    if !granted {
        prompted = true;
        let now_granted = on_main_thread(|| unsafe { ffi::CGRequestScreenCaptureAccess() });
        notes.push(format!(
            "screen recording not granted at launch; prompt requested (immediate result: {now_granted}). \
             If you just granted it, relaunch and re-run the probe."
        ));
    }

    AUDIO_CALLBACKS.store(0, Ordering::Relaxed);
    AUDIO_FRAMES.store(0, Ordering::Relaxed);
    AUDIO_PEAK_MICRO.store(0, Ordering::Relaxed);
    VIDEO_FRAMES.store(0, Ordering::Relaxed);

    let screen_id = CString::new("screen_capture").unwrap();
    let screen_name = CString::new("M-L2 Screen").unwrap();
    let mic_id = CString::new("coreaudio_input_capture").unwrap();
    let mic_name = CString::new("M-L2 Mic").unwrap();

    // The SCK source requires an explicit display_uuid (no default-display
    // behavior); the mic source's NULL settings mean the default input device.
    let screen_settings = unsafe { ffi::obs_data_create() };
    match main_display_uuid() {
        Some(uuid) => {
            let key = CString::new("display_uuid").unwrap();
            let val = CString::new(uuid.clone()).unwrap();
            unsafe { ffi::obs_data_set_string(screen_settings, key.as_ptr(), val.as_ptr()) };
            notes.push(format!("capturing display_uuid {uuid}"));
        }
        None => notes.push("could not resolve main display UUID".into()),
    }
    let screen = unsafe {
        ffi::obs_source_create(screen_id.as_ptr(), screen_name.as_ptr(), screen_settings, ptr::null_mut())
    };
    unsafe { ffi::obs_data_release(screen_settings) };
    let mic =
        unsafe { ffi::obs_source_create(mic_id.as_ptr(), mic_name.as_ptr(), ptr::null_mut(), ptr::null_mut()) };
    if screen.is_null() || mic.is_null() {
        notes.push(format!(
            "source creation failed: screen={} mic={}",
            !screen.is_null(),
            !mic.is_null()
        ));
    }

    unsafe {
        ffi::obs_set_output_source(0, screen);
        ffi::obs_set_output_source(1, mic);
        if !mic.is_null() {
            ffi::obs_source_add_audio_capture_callback(mic, audio_cb, ptr::null_mut());
        }
        // Registering a raw consumer activates the video output mixer, so
        // rendered_frames counts full compositor output, not just source ticks.
        ffi::obs_add_raw_video_callback(ptr::null(), video_cb, ptr::null_mut());
    }

    // SCK starts asynchronously; poll dimensions while the window elapses.
    let start = Instant::now();
    let mut size = (0u32, 0u32);
    while start.elapsed() < window {
        std::thread::sleep(Duration::from_millis(250));
        if !screen.is_null() && size.0 == 0 {
            size = unsafe { (ffi::obs_source_get_width(screen), ffi::obs_source_get_height(screen)) };
        }
    }
    if !screen.is_null() && size.0 == 0 {
        size = unsafe { (ffi::obs_source_get_width(screen), ffi::obs_source_get_height(screen)) };
    }
    let elapsed = start.elapsed().as_secs_f64();

    unsafe {
        ffi::obs_remove_raw_video_callback(video_cb, ptr::null_mut());
        if !mic.is_null() {
            ffi::obs_source_remove_audio_capture_callback(mic, audio_cb, ptr::null_mut());
        }
        ffi::obs_set_output_source(0, ptr::null_mut());
        ffi::obs_set_output_source(1, ptr::null_mut());
        if !screen.is_null() {
            ffi::obs_source_release(screen);
        }
        if !mic.is_null() {
            ffi::obs_source_release(mic);
        }
    }

    let rendered = VIDEO_FRAMES.load(Ordering::Relaxed);
    let audio_cbs = AUDIO_CALLBACKS.load(Ordering::Relaxed);
    let ok = granted && size.0 > 0 && rendered > 0 && audio_cbs > 0;

    CaptureProbeReport {
        ok,
        screen_tcc_granted: granted,
        screen_tcc_prompted: prompted,
        probe_seconds: elapsed,
        screen_source_size: size,
        rendered_frames: rendered,
        mic_audio_callbacks: audio_cbs,
        mic_audio_frames: AUDIO_FRAMES.load(Ordering::Relaxed),
        mic_peak_level: AUDIO_PEAK_MICRO.load(Ordering::Relaxed) as f64 / 1_000_000.0,
        notes,
    }
}
