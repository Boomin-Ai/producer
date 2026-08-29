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
pub type obs_source_audio_capture_t =
    extern "C" fn(param: *mut c_void, source: *mut obs_source_t, audio: *const audio_data, muted: bool);
pub type raw_video_cb_t = extern "C" fn(param: *mut c_void, frame: *mut video_data);

extern "C" {
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
    pub fn obs_source_get_width(source: *mut obs_source_t) -> u32;
    pub fn obs_source_get_height(source: *mut obs_source_t) -> u32;
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
extern "C" {
    pub fn CGPreflightScreenCaptureAccess() -> bool;
    pub fn CGRequestScreenCaptureAccess() -> bool;
}

// obs-data settings (obs_source_create input)
extern "C" {
    pub fn obs_data_create() -> *mut obs_data_t;
    pub fn obs_data_release(data: *mut obs_data_t);
    pub fn obs_data_set_string(data: *mut obs_data_t, name: *const c_char, value: *const c_char);
    pub fn obs_data_set_int(data: *mut obs_data_t, name: *const c_char, value: i64);
    pub fn obs_data_set_bool(data: *mut obs_data_t, name: *const c_char, value: bool);
}

// M-L3: encoders, service, output — first light (LIVE-REVIEW.md F4 chain)
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
    pub fn obs_output_set_audio_encoder(output: *mut obs_output_t, encoder: *mut obs_encoder_t, idx: usize);
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
    pub fn calldata_get_data(data: *const calldata_t, name: *const c_char, out: *mut c_void, size: usize) -> bool;
}

// Main-display UUID lookup — the same CoreGraphics path OBS's own display
// picker uses (window-utils.m); the SCK source has no default-display
// behavior, it requires an explicit display_uuid.
pub const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
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
extern "C" {
    pub static kCFRunLoopDefaultMode: *const c_void;
    pub fn CFRunLoopRunInMode(
        mode: *const c_void,
        seconds: f64,
        return_after_source_handled: bool,
    ) -> i32;
}
