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

pub type obs_task_t = extern "C" fn(param: *mut c_void);
pub type obs_task_handler_t = extern "C" fn(task: obs_task_t, param: *mut c_void, wait: bool);

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
