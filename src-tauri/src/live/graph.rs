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
pub(crate) fn on_main_thread<T: Send, F: FnOnce() -> T + Send>(f: F) -> T {
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
    let mut ctx = Ctx {
        f: Some(f),
        out: None,
    };
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
        let ok = ffi::CFStringGetCString(
            s,
            buf.as_mut_ptr(),
            buf.len() as isize,
            ffi::K_CF_STRING_ENCODING_UTF8,
        );
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

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct SourcesState {
    pub screen: bool,
    pub camera: bool,
    pub mic: bool,
    /// Window-capture overlay (D1's sanctioned v1 escape hatch); the CGWindowID
    /// being captured, if any.
    pub overlay_window: Option<u32>,
}

/// The implicit scene (§2.2: "UI exposes one implicit scene"): screen
/// full-frame, camera picture-in-picture bottom-right, mic on channel 1.
/// Sources are created when toggled ON (that's when TCC fires — the coach's
/// moment) and destroyed when toggled OFF, so "off" truly means not
/// capturing. Engine thread only.
pub struct SceneGraph {
    scene: *mut ffi::obs_scene_t,
    screen: Option<(*mut ffi::obs_sceneitem_t, *mut ffi::obs_source_t)>,
    camera: Option<(*mut ffi::obs_sceneitem_t, *mut ffi::obs_source_t)>,
    mic: Option<*mut ffi::obs_source_t>,
    overlay: Option<(*mut ffi::obs_sceneitem_t, *mut ffi::obs_source_t, u32)>,
}

impl SceneGraph {
    pub fn create() -> Result<SceneGraph, String> {
        unsafe {
            let name = CString::new("main").unwrap();
            let scene = ffi::obs_scene_create(name.as_ptr());
            if scene.is_null() {
                return Err("obs_scene_create failed".into());
            }
            ffi::obs_set_output_source(0, ffi::obs_scene_get_source(scene));
            Ok(SceneGraph {
                scene,
                screen: None,
                camera: None,
                mic: None,
                overlay: None,
            })
        }
    }

    pub fn state(&self) -> SourcesState {
        SourcesState {
            screen: self.screen.is_some(),
            camera: self.camera.is_some(),
            mic: self.mic.is_some(),
            overlay_window: self.overlay.as_ref().map(|(_, _, id)| *id),
        }
    }

    /// Window-capture overlay (D1 escape hatch): a browser window running the
    /// overlay page, captured full-frame on top of the scene; optional green
    /// color-key so it composites like a real overlay. None clears it.
    pub fn set_overlay(&mut self, window_id: Option<u32>, color_key: bool) -> Result<(), String> {
        unsafe {
            if let Some((item, src, _)) = self.overlay.take() {
                ffi::obs_sceneitem_remove(item);
                ffi::obs_source_release(src);
            }
            let Some(window_id) = window_id else {
                return Ok(());
            };
            let settings = ffi::obs_data_create();
            // mac-sck-common.h: ScreenCaptureWindowStream = 1
            ffi::obs_data_set_int(settings, CString::new("type").unwrap().as_ptr(), 1);
            ffi::obs_data_set_int(
                settings,
                CString::new("window").unwrap().as_ptr(),
                window_id as i64,
            );
            ffi::obs_data_set_bool(
                settings,
                CString::new("show_cursor").unwrap().as_ptr(),
                false,
            );
            let id = CString::new("screen_capture").unwrap();
            let name = CString::new("Overlay").unwrap();
            let src = ffi::obs_source_create(id.as_ptr(), name.as_ptr(), settings, ptr::null_mut());
            ffi::obs_data_release(settings);
            if src.is_null() {
                return Err("overlay window capture creation failed".into());
            }
            if color_key {
                let fsettings = ffi::obs_data_create();
                ffi::obs_data_set_string(
                    fsettings,
                    CString::new("key_color_type").unwrap().as_ptr(),
                    CString::new("green").unwrap().as_ptr(),
                );
                let fid = CString::new("color_key_filter_v2").unwrap();
                let fname = CString::new("overlay-key").unwrap();
                let filter =
                    ffi::obs_source_create_private(fid.as_ptr(), fname.as_ptr(), fsettings);
                ffi::obs_data_release(fsettings);
                if !filter.is_null() {
                    ffi::obs_source_filter_add(src, filter);
                    ffi::obs_source_release(filter);
                }
            }
            let item = ffi::obs_scene_add(self.scene, src);
            if item.is_null() {
                ffi::obs_source_release(src);
                return Err("scene add failed for overlay".into());
            }
            let (bw, bh) = Self::base_size();
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            let bounds = ffi::vec2 { x: bw, y: bh };
            ffi::obs_sceneitem_set_bounds(item, &bounds);
            let pos = ffi::vec2 { x: 0.0, y: 0.0 };
            ffi::obs_sceneitem_set_pos(item, &pos);
            ffi::obs_sceneitem_set_visible(item, true);
            self.overlay = Some((item, src, window_id));
        }
        Ok(())
    }

    fn base_size() -> (f32, f32) {
        let mut ovi: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        unsafe {
            if ffi::obs_get_video_info(ovi.as_mut_ptr()) {
                let ovi = ovi.assume_init();
                return (ovi.base_width as f32, ovi.base_height as f32);
            }
        }
        (1280.0, 720.0)
    }

    pub fn set_screen(&mut self, on: bool) -> Result<(), String> {
        unsafe {
            match (on, self.screen.take()) {
                (true, Some(existing)) => self.screen = Some(existing),
                (false, None) => {}
                (false, Some((item, src))) => {
                    ffi::obs_sceneitem_remove(item);
                    ffi::obs_source_release(src);
                }
                (true, None) => {
                    let uuid = main_display_uuid().ok_or("could not resolve main display UUID")?;
                    let settings = ffi::obs_data_create();
                    let key = CString::new("display_uuid").unwrap();
                    let val = CString::new(uuid).unwrap();
                    ffi::obs_data_set_string(settings, key.as_ptr(), val.as_ptr());
                    let id = CString::new("screen_capture").unwrap();
                    let name = CString::new("Screen").unwrap();
                    let src = ffi::obs_source_create(
                        id.as_ptr(),
                        name.as_ptr(),
                        settings,
                        ptr::null_mut(),
                    );
                    ffi::obs_data_release(settings);
                    if src.is_null() {
                        return Err("screen_capture creation failed".into());
                    }
                    let item = ffi::obs_scene_add(self.scene, src);
                    if item.is_null() {
                        ffi::obs_source_release(src);
                        return Err("scene add failed for screen".into());
                    }
                    ffi::obs_sceneitem_set_visible(item, true);
                    self.screen = Some((item, src));
                }
            }
        }
        Ok(())
    }

    pub fn set_camera(&mut self, on: bool) -> Result<(), String> {
        unsafe {
            match (on, self.camera.take()) {
                (true, Some(existing)) => self.camera = Some(existing),
                (false, None) => {}
                (false, Some((item, src))) => {
                    ffi::obs_sceneitem_remove(item);
                    ffi::obs_source_release(src);
                }
                (true, None) => {
                    // mac-avcapture needs an explicit device id (same lesson
                    // as SCK's display_uuid).
                    let mut buf = [0i8; 256];
                    if ffi::producer_default_camera_id(buf.as_mut_ptr(), buf.len() as i32) == 0 {
                        return Err("no camera device found".into());
                    }
                    let device = std::ffi::CStr::from_ptr(buf.as_ptr())
                        .to_string_lossy()
                        .into_owned();
                    let settings = ffi::obs_data_create();
                    let k_device = CString::new("device").unwrap();
                    let v_device = CString::new(device).unwrap();
                    ffi::obs_data_set_string(settings, k_device.as_ptr(), v_device.as_ptr());
                    // The webcam is a video PiP; its own audio stays out of
                    // the mix (mic is a separate toggle).
                    ffi::obs_data_set_bool(
                        settings,
                        CString::new("enable_audio").unwrap().as_ptr(),
                        false,
                    );
                    let id = CString::new("macos-avcapture").unwrap();
                    let name = CString::new("Camera").unwrap();
                    let src = ffi::obs_source_create(
                        id.as_ptr(),
                        name.as_ptr(),
                        settings,
                        ptr::null_mut(),
                    );
                    ffi::obs_data_release(settings);
                    if src.is_null() {
                        return Err("camera source creation failed".into());
                    }
                    let item = ffi::obs_scene_add(self.scene, src);
                    if item.is_null() {
                        ffi::obs_source_release(src);
                        return Err("scene add failed for camera".into());
                    }
                    // Picture-in-picture, bottom-right, 28% of frame width.
                    let (bw, bh) = Self::base_size();
                    let pip_w = bw * 0.28;
                    let pip_h = pip_w * 9.0 / 16.0;
                    let margin = 24.0;
                    ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
                    let bounds = ffi::vec2 { x: pip_w, y: pip_h };
                    ffi::obs_sceneitem_set_bounds(item, &bounds);
                    let pos = ffi::vec2 {
                        x: bw - pip_w - margin,
                        y: bh - pip_h - margin,
                    };
                    ffi::obs_sceneitem_set_pos(item, &pos);
                    ffi::obs_sceneitem_set_visible(item, true);
                    self.camera = Some((item, src));
                }
            }
        }
        Ok(())
    }

    pub fn set_mic(&mut self, on: bool) -> Result<(), String> {
        unsafe {
            match (on, self.mic.take()) {
                (true, Some(existing)) => self.mic = Some(existing),
                (false, None) => {}
                (false, Some(src)) => {
                    ffi::obs_set_output_source(1, ptr::null_mut());
                    ffi::obs_source_release(src);
                }
                (true, None) => {
                    let id = CString::new("coreaudio_input_capture").unwrap();
                    let name = CString::new("Mic").unwrap();
                    let src = ffi::obs_source_create(
                        id.as_ptr(),
                        name.as_ptr(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                    );
                    if src.is_null() {
                        return Err("mic source creation failed".into());
                    }
                    ffi::obs_set_output_source(1, src);
                    self.mic = Some(src);
                }
            }
        }
        Ok(())
    }
}

/// Create the default capture graph (SCK main display + default mic) and
/// attach it to output channels 0/1. The channels hold their own references,
/// so local refs are released before returning. Engine thread only.
pub fn attach_capture_sources() -> Result<(), String> {
    let uuid = main_display_uuid().ok_or("could not resolve main display UUID")?;
    unsafe {
        let settings = ffi::obs_data_create();
        let key = CString::new("display_uuid").unwrap();
        let val = CString::new(uuid).unwrap();
        ffi::obs_data_set_string(settings, key.as_ptr(), val.as_ptr());
        let screen_id = CString::new("screen_capture").unwrap();
        let screen_name = CString::new("Live Screen").unwrap();
        let screen = ffi::obs_source_create(
            screen_id.as_ptr(),
            screen_name.as_ptr(),
            settings,
            ptr::null_mut(),
        );
        ffi::obs_data_release(settings);
        if screen.is_null() {
            return Err("screen_capture source creation failed".into());
        }
        let mic_id = CString::new("coreaudio_input_capture").unwrap();
        let mic_name = CString::new("Live Mic").unwrap();
        let mic = ffi::obs_source_create(
            mic_id.as_ptr(),
            mic_name.as_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        if mic.is_null() {
            ffi::obs_source_release(screen);
            return Err("mic source creation failed".into());
        }
        ffi::obs_set_output_source(0, screen);
        ffi::obs_set_output_source(1, mic);
        ffi::obs_source_release(screen);
        ffi::obs_source_release(mic);
    }
    Ok(())
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
        ffi::obs_source_create(
            screen_id.as_ptr(),
            screen_name.as_ptr(),
            screen_settings,
            ptr::null_mut(),
        )
    };
    unsafe { ffi::obs_data_release(screen_settings) };
    let mic = unsafe {
        ffi::obs_source_create(
            mic_id.as_ptr(),
            mic_name.as_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
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
            size = unsafe {
                (
                    ffi::obs_source_get_width(screen),
                    ffi::obs_source_get_height(screen),
                )
            };
        }
    }
    if !screen.is_null() && size.0 == 0 {
        size = unsafe {
            (
                ffi::obs_source_get_width(screen),
                ffi::obs_source_get_height(screen),
            )
        };
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
