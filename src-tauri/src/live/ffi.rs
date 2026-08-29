//! Minimal hand-written libobs C API surface for the M-L1 bootstrap.
//! Signatures and struct layouts verified against the pinned OBS source
//! (engine/obs.lock: 32.1.2 / fb4d98bf), libobs/obs.h + media-io headers.
#![allow(non_camel_case_types, dead_code)]

use std::os::raw::{c_char, c_int, c_void};

// media-io/video-io.h
pub const VIDEO_FORMAT_NV12: c_int = 2;
pub const VIDEO_CS_709: c_int = 2;
pub const VIDEO_RANGE_PARTIAL: c_int = 1;
// obs.h enum obs_scale_type
pub const OBS_SCALE_BILINEAR: c_int = 3;
// media-io/audio-io.h enum speaker_layout
pub const SPEAKERS_STEREO: c_int = 2;

#[repr(C)]
pub struct obs_video_info {
    pub graphics_module: *const c_char,
    pub fps_num: u32,
    pub fps_den: u32,
    pub base_width: u32,
    pub base_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub output_format: c_int,
    pub adapter: u32,
    pub gpu_conversion: bool,
    pub colorspace: c_int,
    pub range: c_int,
    pub scale_type: c_int,
}

#[repr(C)]
pub struct obs_audio_info {
    pub samples_per_sec: u32,
    pub speakers: c_int,
}

#[repr(C)]
pub struct obs_module_failure_info {
    pub failed_modules: *mut *mut c_char,
    pub count: usize,
}

pub const MAX_AV_PLANES: usize = 8;

/// media-io/audio-io.h — audio is float planar internally; plane 0 suffices
/// for level metering.
#[repr(C)]
pub struct audio_data {
    pub data: [*mut u8; MAX_AV_PLANES],
    pub frames: u32,
    pub timestamp: u64,
}

/// media-io/video-io.h
#[repr(C)]
pub struct video_data {
    pub data: [*mut u8; MAX_AV_PLANES],
    pub linesize: [u32; MAX_AV_PLANES],
    pub timestamp: u64,
}

pub enum obs_source_t {}
pub enum obs_data_t {}
pub enum obs_properties_t {}
pub enum obs_property_t {}
pub enum obs_encoder_t {}
pub enum obs_service_t {}
pub enum obs_output_t {}
pub enum video_t {}
pub enum audio_t {}
pub enum signal_handler_t {}
pub enum calldata_t {}

pub type signal_callback_t = extern "C" fn(data: *mut c_void, cd: *mut calldata_t);

pub type obs_task_t = extern "C" fn(param: *mut c_void);
pub type obs_task_handler_t = extern "C" fn(task: obs_task_t, param: *mut c_void, wait: bool);
pub type obs_source_audio_capture_t = extern "C" fn(
    param: *mut c_void,
    source: *mut obs_source_t,
    audio: *const audio_data,
    muted: bool,
);
pub type raw_video_cb_t = extern "C" fn(param: *mut c_void, frame: *mut video_data);

// On Windows the engine links via raw-dylib: rustc synthesizes the import
// table for obs.dll directly from these declarations — no import .lib needed
// (the official OBS release ships none). macOS links the framework in build.rs.
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_add_data_path(path: *const c_char);
    pub fn obs_startup(
        locale: *const c_char,
        module_config_path: *const c_char,
        store: *mut c_void,
    ) -> bool;
    pub fn obs_shutdown();
    pub fn obs_initialized() -> bool;
    pub fn obs_get_version_string() -> *const c_char;
    pub fn obs_reset_video(ovi: *mut obs_video_info) -> c_int;
    pub fn obs_reset_audio(oai: *const obs_audio_info) -> bool;
    pub fn obs_load_all_modules2(mfi: *mut obs_module_failure_info);
    pub fn obs_module_failure_info_free(mfi: *mut obs_module_failure_info);
    pub fn obs_post_load_modules();
    pub fn obs_log_loaded_modules();
    pub fn obs_add_module_path(bin: *const c_char, data: *const c_char);
    pub fn obs_enum_source_types(idx: usize, id: *mut *const c_char) -> bool;
    pub fn obs_enum_encoder_types(idx: usize, id: *mut *const c_char) -> bool;
    pub fn obs_enum_output_types(idx: usize, id: *mut *const c_char) -> bool;
    pub fn obs_enum_service_types(idx: usize, id: *mut *const c_char) -> bool;
    pub fn obs_set_ui_task_handler(handler: obs_task_handler_t);

    // M-L2: sources in the graph
    pub fn obs_source_create(
        id: *const c_char,
        name: *const c_char,
        settings: *mut obs_data_t,
        hotkey_data: *mut obs_data_t,
    ) -> *mut obs_source_t;
    pub fn obs_source_release(source: *mut obs_source_t);
    pub fn obs_set_output_source(channel: u32, source: *mut obs_source_t);
    pub fn obs_get_output_source(channel: u32) -> *mut obs_source_t;
    pub fn obs_source_video_render(source: *mut obs_source_t);
    pub fn obs_source_inc_showing(source: *mut obs_source_t);
    pub fn obs_source_dec_showing(source: *mut obs_source_t);
    pub fn obs_source_get_width(source: *mut obs_source_t) -> u32;
    pub fn obs_source_get_height(source: *mut obs_source_t) -> u32;
    pub fn obs_source_showing(source: *mut obs_source_t) -> bool;
    pub fn obs_source_active(source: *mut obs_source_t) -> bool;
    pub fn obs_source_add_audio_capture_callback(
        source: *mut obs_source_t,
        callback: obs_source_audio_capture_t,
        param: *mut c_void,
    );
    pub fn obs_source_remove_audio_capture_callback(
        source: *mut obs_source_t,
        callback: obs_source_audio_capture_t,
        param: *mut c_void,
    );
    pub fn obs_add_raw_video_callback(
        conversion: *const c_void,
        callback: raw_video_cb_t,
        param: *mut c_void,
    );
    pub fn obs_remove_raw_video_callback(callback: raw_video_cb_t, param: *mut c_void);
}

// CoreGraphics TCC preflight/request for Screen Recording.
#[cfg(target_os = "macos")]
extern "C" {
    pub fn CGPreflightScreenCaptureAccess() -> bool;
    pub fn CGRequestScreenCaptureAccess() -> bool;
}

// obs-data settings (obs_source_create input)
// Source property introspection — how the OBS UI itself discovers device and
// window lists; we ask the same questions (enumeration without reinvention).
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_get_source_properties(id: *const c_char) -> *mut obs_properties_t;
    pub fn obs_properties_destroy(props: *mut obs_properties_t);
    pub fn obs_properties_get(
        props: *mut obs_properties_t,
        property: *const c_char,
    ) -> *mut obs_property_t;
    pub fn obs_property_list_item_count(prop: *mut obs_property_t) -> usize;
    pub fn obs_property_list_item_name(prop: *mut obs_property_t, idx: usize) -> *const c_char;
    pub fn obs_property_list_item_string(prop: *mut obs_property_t, idx: usize) -> *const c_char;
}

#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_data_create() -> *mut obs_data_t;
    pub fn obs_data_release(data: *mut obs_data_t);
    pub fn obs_data_set_string(data: *mut obs_data_t, name: *const c_char, value: *const c_char);
    pub fn obs_data_set_int(data: *mut obs_data_t, name: *const c_char, value: i64);
    pub fn obs_data_set_bool(data: *mut obs_data_t, name: *const c_char, value: bool);
    pub fn obs_data_get_int(data: *mut obs_data_t, name: *const c_char) -> i64;
}

// M-L4: D2 service-policy intersection (F12) + per-output telemetry
#[repr(C)]
pub struct obs_service_resolution {
    pub cx: c_int,
    pub cy: c_int,
}
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_service_get_supported_resolutions(
        service: *const obs_service_t,
        resolutions: *mut *mut obs_service_resolution,
        count: *mut usize,
    );
    pub fn obs_service_get_max_fps(service: *const obs_service_t, fps: *mut c_int);
    pub fn obs_service_get_max_bitrate(
        service: *const obs_service_t,
        video_bitrate: *mut c_int,
        audio_bitrate: *mut c_int,
    );
    pub fn obs_service_get_supported_video_codecs(
        service: *const obs_service_t,
    ) -> *const *const c_char;
    pub fn obs_output_get_congestion(output: *mut obs_output_t) -> f32;
    pub fn obs_output_get_total_bytes(output: *const obs_output_t) -> u64;
    pub fn bfree(ptr: *mut c_void);
}

// M-L6: preview display (A6), implicit scene, camera PiP
pub enum obs_display_t {}
pub enum obs_scene_t {}
pub enum obs_sceneitem_t {}

// graphics/graphics.h enum gs_color_format / gs_zstencil_format
pub const GS_BGRA: c_int = 5;
pub const GS_ZS_NONE: c_int = 0;
// obs.h enum obs_bounds_type
pub const OBS_BOUNDS_SCALE_INNER: c_int = 2;

/// graphics/graphics.h struct gs_window (macOS arm: a single NSView* slot)
#[repr(C)]
pub struct gs_window {
    pub view: *mut c_void,
}

/// graphics/graphics.h struct gs_init_data
#[repr(C)]
pub struct gs_init_data {
    pub window: gs_window,
    pub cx: u32,
    pub cy: u32,
    pub num_backbuffers: u32,
    pub format: c_int,
    pub zsformat: c_int,
    pub adapter: u32,
}

/// graphics/vec2.h struct vec2
#[repr(C)]
#[derive(Clone, Copy)]
pub struct vec2 {
    pub x: f32,
    pub y: f32,
}

pub type draw_callback_t = extern "C" fn(param: *mut c_void, cx: u32, cy: u32);

#[repr(C)]
pub struct vec4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}
pub const GS_CLEAR_COLOR: u32 = 1;

#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_display_create(
        graphics_data: *const gs_init_data,
        background_color: u32,
    ) -> *mut obs_display_t;
    pub fn obs_display_destroy(display: *mut obs_display_t);
    pub fn obs_display_resize(display: *mut obs_display_t, cx: u32, cy: u32);
    pub fn obs_display_add_draw_callback(
        display: *mut obs_display_t,
        draw: draw_callback_t,
        param: *mut c_void,
    );
    pub fn obs_display_remove_draw_callback(
        display: *mut obs_display_t,
        draw: draw_callback_t,
        param: *mut c_void,
    );
    pub fn obs_render_main_texture();
    pub fn obs_get_video_info(ovi: *mut obs_video_info) -> bool;

    pub fn gs_clear(clear_flags: u32, color: *const vec4, depth: f32, stencil: u8);
    pub fn gs_viewport_push();
    pub fn gs_viewport_pop();
    pub fn gs_projection_push();
    pub fn gs_projection_pop();
    pub fn gs_ortho(left: f32, right: f32, top: f32, bottom: f32, znear: f32, zfar: f32);

    pub fn obs_scene_create(name: *const c_char) -> *mut obs_scene_t;
    pub fn obs_scene_release(scene: *mut obs_scene_t);
    pub fn obs_scene_get_source(scene: *const obs_scene_t) -> *mut obs_source_t;
    pub fn obs_scene_add(
        scene: *mut obs_scene_t,
        source: *mut obs_source_t,
    ) -> *mut obs_sceneitem_t;
    pub fn obs_sceneitem_remove(item: *mut obs_sceneitem_t);
    pub fn obs_sceneitem_set_pos(item: *mut obs_sceneitem_t, pos: *const vec2);
    pub fn obs_sceneitem_set_bounds_type(item: *mut obs_sceneitem_t, bounds_type: c_int);
    pub fn obs_sceneitem_set_bounds(item: *mut obs_sceneitem_t, bounds: *const vec2);
    pub fn obs_sceneitem_set_visible(item: *mut obs_sceneitem_t, visible: bool) -> bool;
}

// shim.m — AppKit/AVFoundation helpers (main-thread marshalling inside)
#[cfg(target_os = "macos")]
extern "C" {
    pub fn producer_preview_attach(
        ns_window: *mut c_void,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        out_px_w: *mut f64,
        out_px_h: *mut f64,
    ) -> *mut c_void;
    pub fn producer_preview_set_frame(
        view: *mut c_void,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        out_px_w: *mut f64,
        out_px_h: *mut f64,
    );
    pub fn producer_preview_detach(view: *mut c_void);
    pub fn producer_av_authorization_status(media_type: c_int) -> c_int;
    pub fn producer_av_request_access(media_type: c_int);
    pub fn producer_screen_capture_preflight() -> c_int;
    pub fn producer_screen_capture_request();
    pub fn producer_default_camera_id(buf: *mut c_char, buflen: c_int) -> c_int;
    pub fn producer_list_windows(buf: *mut c_char, buflen: c_int) -> c_int;
}

// M-L7 escape hatch: filters on the overlay window capture
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_source_create_private(
        id: *const c_char,
        name: *const c_char,
        settings: *mut obs_data_t,
    ) -> *mut obs_source_t;
    pub fn obs_source_filter_add(source: *mut obs_source_t, filter: *mut obs_source_t);
}

// M-L3: encoders, service, output — first light (LIVE-REVIEW.md F4 chain)
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_get_video() -> *mut video_t;
    pub fn obs_get_audio() -> *mut audio_t;

    pub fn obs_video_encoder_create(
        id: *const c_char,
        name: *const c_char,
        settings: *mut obs_data_t,
        hotkey_data: *mut obs_data_t,
    ) -> *mut obs_encoder_t;
    pub fn obs_audio_encoder_create(
        id: *const c_char,
        name: *const c_char,
        settings: *mut obs_data_t,
        mixer_idx: usize,
        hotkey_data: *mut obs_data_t,
    ) -> *mut obs_encoder_t;
    pub fn obs_encoder_set_video(encoder: *mut obs_encoder_t, video: *mut video_t);
    pub fn obs_encoder_set_audio(encoder: *mut obs_encoder_t, audio: *mut audio_t);
    pub fn obs_encoder_release(encoder: *mut obs_encoder_t);

    pub fn obs_service_create(
        id: *const c_char,
        name: *const c_char,
        settings: *mut obs_data_t,
        hotkey_data: *mut obs_data_t,
    ) -> *mut obs_service_t;
    pub fn obs_service_release(service: *mut obs_service_t);
    pub fn obs_service_apply_encoder_settings(
        service: *mut obs_service_t,
        video_encoder_settings: *mut obs_data_t,
        audio_encoder_settings: *mut obs_data_t,
    );

    pub fn obs_output_create(
        id: *const c_char,
        name: *const c_char,
        settings: *mut obs_data_t,
        hotkey_data: *mut obs_data_t,
    ) -> *mut obs_output_t;
    pub fn obs_output_release(output: *mut obs_output_t);
    pub fn obs_output_set_video_encoder(output: *mut obs_output_t, encoder: *mut obs_encoder_t);
    pub fn obs_output_set_audio_encoder(
        output: *mut obs_output_t,
        encoder: *mut obs_encoder_t,
        idx: usize,
    );
    pub fn obs_output_set_service(output: *mut obs_output_t, service: *mut obs_service_t);
    pub fn obs_output_start(output: *mut obs_output_t) -> bool;
    pub fn obs_output_stop(output: *mut obs_output_t);
    pub fn obs_output_active(output: *const obs_output_t) -> bool;
    pub fn obs_output_get_total_frames(output: *const obs_output_t) -> c_int;
    pub fn obs_output_get_frames_dropped(output: *const obs_output_t) -> c_int;
    pub fn obs_output_get_last_error(output: *mut obs_output_t) -> *const c_char;
    pub fn obs_output_get_signal_handler(output: *const obs_output_t) -> *mut signal_handler_t;

    pub fn signal_handler_connect(
        handler: *mut signal_handler_t,
        signal: *const c_char,
        callback: signal_callback_t,
        data: *mut c_void,
    );
    pub fn calldata_get_data(
        data: *const calldata_t,
        name: *const c_char,
        out: *mut c_void,
        size: usize,
    ) -> bool;
}

// Main-display UUID lookup — the same CoreGraphics path OBS's own display
// picker uses (window-utils.m); the SCK source has no default-display
// behavior, it requires an explicit display_uuid.
pub const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
#[cfg(target_os = "macos")]
extern "C" {
    pub fn CGMainDisplayID() -> u32;
    pub fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> *const c_void;
    pub fn CFUUIDCreateString(alloc: *const c_void, uuid: *const c_void) -> *const c_void;
    pub fn CFStringGetCString(
        s: *const c_void,
        buffer: *mut c_char,
        buffer_size: isize,
        encoding: u32,
    ) -> bool;
    pub fn CFRelease(cf: *const c_void);
}

// Grand Central Dispatch + pthread, for marshalling OBS UI tasks onto the
// macOS main thread per the §5.1 invariant.
#[cfg(target_os = "macos")]
extern "C" {
    pub static _dispatch_main_q: c_void;
    pub fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
    pub fn dispatch_sync_f(
        queue: *const c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
    pub fn pthread_main_np() -> c_int;
}

// CoreFoundation run-loop pump for headless self-test mode (drains the GCD
// main queue while the engine thread bootstraps).
#[cfg(target_os = "macos")]
extern "C" {
    pub static kCFRunLoopDefaultMode: *const c_void;
    pub fn CFRunLoopRunInMode(
        mode: *const c_void,
        seconds: f64,
        return_after_source_handled: bool,
    ) -> i32;
}
