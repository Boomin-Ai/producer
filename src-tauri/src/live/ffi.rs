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
pub type obs_source_audio_capture_t = extern "C" fn(
    param: *mut c_void,
    source: *mut obs_source_t,
    audio: *const audio_data,
    muted: bool,
);
pub type raw_video_cb_t = extern "C" fn(param: *mut c_void, frame: *mut video_data);

// raw-dylib: an EXTRACTED OBS release ships obs.dll with no obs.lib, and
// MSVC cannot link a DLL without an import library. raw-dylib makes rustc
// synthesise the import stubs from the DLL name, so a downloaded release
// works as a dev engine. Harmless when a source build DID produce a .lib.
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
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
    pub fn obs_set_video_levels(sdr_white_level: f32, hdr_nominal_peak_level: f32);
    pub fn obs_reset_audio(oai: *const obs_audio_info) -> bool;
    pub fn obs_load_all_modules2(mfi: *mut obs_module_failure_info);
    pub fn obs_module_failure_info_free(mfi: *mut obs_module_failure_info);
    pub fn obs_post_load_modules();
    pub fn obs_log_loaded_modules();
    // Deprecated upstream at 32.1.2 but still exported and still the only way to
    // tell libobs where its OWN data lives. Windows resolves that with the
    // relative path "../../data/libobs/" against the process CWD, which is right
    // for obs64.exe and never right for us.
    pub fn obs_add_data_path(path: *const c_char);
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
    pub fn obs_get_output_source(channel: u32) -> *mut obs_source_t;
    pub fn obs_get_main_texture() -> *mut c_void;
    pub fn obs_get_video_sdr_white_level() -> f32;
    pub fn obs_scene_from_source(source: *const obs_source_t) -> *mut c_void;
    pub fn obs_scene_find_source(scene: *mut c_void, name: *const c_char) -> *mut obs_sceneitem_t;
    pub fn obs_sceneitem_get_box_transform(item: *const obs_sceneitem_t, transform: *mut matrix4);
    pub fn gs_render_start(b_new: bool);
    pub fn gs_render_stop(mode: c_int);
    pub fn gs_vertex2f(x: f32, y: f32);
    pub fn gs_matrix_scale3f(x: f32, y: f32, z: f32);
    pub fn gs_get_color_space() -> c_int;
    pub fn gs_effect_set_texture(param: *mut c_void, val: *mut c_void);
    pub fn gs_enable_framebuffer_srgb(enable: bool);
    pub fn gs_framebuffer_srgb_enabled() -> bool;
    pub fn gs_matrix_push();
    pub fn gs_matrix_pop();
    pub fn gs_matrix_translate3f(x: f32, y: f32, z: f32);
    pub fn gs_get_render_target() -> *mut c_void;
    pub fn gs_texture_get_color_format(tex: *const c_void) -> c_int;
    pub fn gs_effect_get_param_by_name(effect: *mut c_void, name: *const c_char) -> *mut c_void;
    pub fn gs_effect_set_vec4(param: *mut c_void, val: *const vec4);
    pub fn gs_effect_get_technique(effect: *mut c_void, name: *const c_char) -> *mut c_void;
    pub fn gs_technique_begin(tech: *mut c_void) -> usize;
    pub fn gs_technique_begin_pass(tech: *mut c_void, pass: usize) -> bool;
    pub fn gs_technique_end_pass(tech: *mut c_void);
    pub fn gs_technique_end(tech: *mut c_void);
    pub fn gs_draw_sprite(tex: *mut c_void, flip: u32, width: u32, height: u32);
    pub fn obs_get_source_by_name(name: *const c_char) -> *mut obs_source_t;
    pub fn gs_texture_get_width(tex: *const c_void) -> u32;
    pub fn gs_texture_get_height(tex: *const c_void) -> u32;
    pub fn obs_get_base_effect(effect: c_int) -> *mut c_void;
    pub fn obs_set_output_source(channel: u32, source: *mut obs_source_t);
    pub fn obs_source_get_width(source: *mut obs_source_t) -> u32;
    /// Probe bindings (room-open first-frame investigation).
    pub fn obs_source_active(source: *mut obs_source_t) -> bool;
    pub fn obs_source_showing(source: *mut obs_source_t) -> bool;
    pub fn obs_get_total_frames() -> u32;
    pub fn obs_source_video_render(source: *mut obs_source_t);
    pub fn obs_enter_graphics();
    pub fn obs_leave_graphics();
    pub fn gs_texrender_create(format: c_int, zsformat: c_int) -> *mut c_void;
    pub fn gs_texrender_destroy(texrender: *mut c_void);
    pub fn gs_texrender_reset(texrender: *mut c_void);
    pub fn gs_texrender_begin(texrender: *mut c_void, cx: u32, cy: u32) -> bool;
    pub fn gs_texrender_end(texrender: *mut c_void);
    pub fn gs_texrender_get_texture(texrender: *const c_void) -> *mut c_void;
    pub fn gs_stagesurface_create(width: u32, height: u32, format: c_int) -> *mut c_void;
    pub fn gs_stagesurface_destroy(stagesurf: *mut c_void);
    pub fn gs_stage_texture(stagesurf: *mut c_void, texture: *mut c_void);
    pub fn gs_stagesurface_map(
        stagesurf: *mut c_void,
        data: *mut *mut u8,
        linesize: *mut u32,
    ) -> bool;
    pub fn gs_stagesurface_unmap(stagesurf: *mut c_void);
    pub fn gs_clear(clear_flags: u32, color: *const vec4, depth: f32, stencil: u8);
    pub fn obs_add_main_render_callback(
        cb: extern "C" fn(*mut c_void, u32, u32),
        param: *mut c_void,
    );
    pub fn obs_source_get_ref(source: *mut obs_source_t) -> *mut obs_source_t;
    pub fn obs_source_inc_showing(source: *mut obs_source_t);
    pub fn obs_source_dec_showing(source: *mut obs_source_t);
    pub fn gs_blend_state_push();
    pub fn gs_blend_state_pop();
    pub fn gs_blend_function(src: c_int, dest: c_int);
    pub fn obs_queue_task(
        task_type: c_int,
        task: extern "C" fn(*mut c_void),
        param: *mut c_void,
        wait: bool,
    );
    pub fn obs_source_get_height(source: *mut obs_source_t) -> u32;
    pub fn obs_source_set_volume(source: *mut obs_source_t, volume: f32);
    pub fn obs_source_get_volume(source: *mut obs_source_t) -> f32;
    pub fn obs_source_muted(source: *mut obs_source_t) -> bool;
    /// Non-zero when the source produces audio — how we know which items
    /// deserve a mixer strip without guessing from their kind.
    pub fn obs_source_get_output_flags(source: *mut obs_source_t) -> u32;
    pub fn obs_source_set_muted(source: *mut obs_source_t, muted: bool);
    /// 0 NONE, 1 MONITOR_ONLY, 2 MONITOR_AND_OUTPUT. MONITOR_ONLY is what
    /// makes cue possible: libobs gates the audio out at the SOURCE, before
    /// it enters any mix, so it cannot reach stream, recording or any output.
    pub fn obs_source_set_monitoring_type(source: *mut obs_source_t, mt: c_int);
    pub fn obs_source_get_monitoring_type(source: *mut obs_source_t) -> c_int;
    /// A/V sync offset in NANOSECONDS, positive = delay the audio. This is
    /// the same control OBS exposes per source; capture cards and remote
    /// guests both arrive with audio and video on different paths, and the
    /// drift is steady per source rather than random, so a fixed offset
    /// corrects it.
    pub fn obs_source_set_sync_offset(source: *mut obs_source_t, offset_ns: i64);
    pub fn obs_source_get_sync_offset(source: *const obs_source_t) -> i64;
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

// obs-data settings (obs_source_create input)
// raw-dylib: an EXTRACTED OBS release ships obs.dll with no obs.lib, and
// MSVC cannot link a DLL without an import library. raw-dylib makes rustc
// synthesise the import stubs from the DLL name, so a downloaded release
// works as a dev engine. Harmless when a source build DID produce a .lib.
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
// raw-dylib: an EXTRACTED OBS release ships obs.dll with no obs.lib, and
// MSVC cannot link a DLL without an import library. raw-dylib makes rustc
// synthesise the import stubs from the DLL name, so a downloaded release
// works as a dev engine. Harmless when a source build DID produce a .lib.
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
pub const GS_RGBA: c_int = 3;
pub const OBS_TASK_GRAPHICS: c_int = 1;
pub const GS_BLEND_ZERO: c_int = 0;
pub const GS_BLEND_ONE: c_int = 1;
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

/// obs.h struct obs_sceneitem_crop — pixel crop per edge, pre-transform.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct obs_sceneitem_crop {
    pub left: c_int,
    pub top: c_int,
    pub right: c_int,
    pub bottom: c_int,
}

/// graphics/vec2.h struct vec2
#[repr(C)]
#[derive(Clone, Copy)]
pub struct vec4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct matrix4 {
    pub x: vec4,
    pub y: vec4,
    pub z: vec4,
    pub t: vec4,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct vec2 {
    pub x: f32,
    pub y: f32,
}

pub type draw_callback_t = extern "C" fn(param: *mut c_void, cx: u32, cy: u32);

// raw-dylib: an EXTRACTED OBS release ships obs.dll with no obs.lib, and
// MSVC cannot link a DLL without an import library. raw-dylib makes rustc
// synthesise the import stubs from the DLL name, so a downloaded release
// works as a dev engine. Harmless when a source build DID produce a .lib.
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

    pub fn gs_viewport_push();
    pub fn gs_set_viewport(x: c_int, y: c_int, width: c_int, height: c_int);
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
    pub fn obs_sceneitem_get_pos(item: *mut obs_sceneitem_t, pos: *mut vec2);
    pub fn obs_sceneitem_set_rot(item: *mut obs_sceneitem_t, rot_deg: f32);
    pub fn obs_sceneitem_get_rot(item: *mut obs_sceneitem_t) -> f32;
    pub fn obs_sceneitem_set_scale(item: *mut obs_sceneitem_t, scale: *const vec2);
    pub fn obs_sceneitem_get_scale(item: *mut obs_sceneitem_t, scale: *mut vec2);
    pub fn obs_sceneitem_set_crop(item: *mut obs_sceneitem_t, crop: *const obs_sceneitem_crop);
    pub fn obs_sceneitem_get_crop(item: *mut obs_sceneitem_t, crop: *mut obs_sceneitem_crop);
    pub fn obs_sceneitem_set_order_position(item: *mut obs_sceneitem_t, position: c_int);
    pub fn obs_sceneitem_get_order_position(item: *mut obs_sceneitem_t) -> c_int;
    pub fn obs_sceneitem_get_bounds(item: *mut obs_sceneitem_t, bounds: *mut vec2);
    pub fn obs_sceneitem_get_bounds_type(item: *mut obs_sceneitem_t) -> c_int;
    pub fn obs_sceneitem_visible(item: *mut obs_sceneitem_t) -> bool;
    pub fn obs_sceneitem_get_source(item: *mut obs_sceneitem_t) -> *mut obs_source_t;
    pub fn obs_sceneitem_set_bounds_type(item: *mut obs_sceneitem_t, bounds_type: c_int);
    pub fn obs_sceneitem_set_bounds(item: *mut obs_sceneitem_t, bounds: *const vec2);
    pub fn obs_sceneitem_set_visible(item: *mut obs_sceneitem_t, visible: bool) -> bool;
}

// shim.m — AppKit/AVFoundation helpers (main-thread marshalling inside)
extern "C" {
    pub fn producer_preview_attach(
        ns_window: *mut c_void,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        below_webview: c_int,
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
    pub fn producer_preview_set_hidden(view: *mut c_void, hidden: c_int);
    pub fn producer_preview_prepare_window(ns_window: *mut c_void) -> c_int;
    pub fn producer_apply_window_vibrancy(ns_window: *mut c_void) -> c_int;
    pub fn producer_av_authorization_status(media_type: c_int) -> c_int;
    pub fn producer_av_request_access(media_type: c_int);
    pub fn producer_screen_capture_preflight() -> c_int;
    pub fn producer_screen_capture_request();
    pub fn producer_default_camera_id(buf: *mut c_char, buflen: c_int) -> c_int;
    pub fn producer_list_windows(buf: *mut c_char, buflen: c_int) -> c_int;
    pub fn producer_drag_chip_show();
    pub fn producer_drag_chip_hide();
    pub fn producer_open_screen_settings();
    pub fn producer_open_camera_settings();
    /// Virtual camera (R13): ask macOS to install the bundled CMIO extension.
    pub fn producer_vcam_activate();
    #[cfg(target_os = "windows")]
    pub fn producer_sdr_white_nits() -> f32;
    #[cfg(target_os = "windows")]
    pub fn producer_vcam_set_module_dir(dir: *const c_char);
    /// 0 idle, 1 requested, 2 needs approval, 3 active, 4 failed; fills `buf`
    /// with the last error.
    pub fn producer_vcam_state(buf: *mut c_char, len: c_int) -> c_int;
    pub fn producer_vcam_installed() -> c_int;
    pub fn producer_open_mic_settings();
}

// M-L7 escape hatch: filters on the overlay window capture
// raw-dylib: an EXTRACTED OBS release ships obs.dll with no obs.lib, and
// MSVC cannot link a DLL without an import library. raw-dylib makes rustc
// synthesise the import stubs from the DLL name, so a downloaded release
// works as a dev engine. Harmless when a source build DID produce a .lib.
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    pub fn obs_source_create_private(
        id: *const c_char,
        name: *const c_char,
        settings: *mut obs_data_t,
    ) -> *mut obs_source_t;
    pub fn obs_source_filter_add(source: *mut obs_source_t, filter: *mut obs_source_t);
    pub fn obs_source_filter_remove(source: *mut obs_source_t, filter: *mut obs_source_t);
    pub fn obs_source_get_filter_by_name(
        source: *mut obs_source_t,
        name: *const c_char,
    ) -> *mut obs_source_t;
    /// Walks a source's filter chain in render order.
    pub fn obs_source_enum_filters(
        source: *mut obs_source_t,
        callback: extern "C" fn(*mut obs_source_t, *mut obs_source_t, *mut c_void),
        param: *mut c_void,
    );
    /// order: 0 = up, 1 = down, 2 = top, 3 = bottom (obs_order_movement).
    pub fn obs_source_filter_set_order(
        source: *mut obs_source_t,
        filter: *mut obs_source_t,
        movement: c_int,
    );
    pub fn obs_source_get_name(source: *mut obs_source_t) -> *const c_char;
    pub fn obs_source_get_id(source: *mut obs_source_t) -> *const c_char;
    pub fn obs_source_set_enabled(source: *mut obs_source_t, enabled: bool);
    pub fn obs_source_enabled(source: *const obs_source_t) -> bool;
    pub fn obs_data_get_double(data: *mut obs_data_t, name: *const c_char) -> f64;
    pub fn obs_data_get_bool(data: *mut obs_data_t, name: *const c_char) -> bool;
    pub fn obs_data_set_double(data: *mut obs_data_t, name: *const c_char, val: f64);
}

// M-L3: encoders, service, output — first light (LIVE-REVIEW.md F4 chain)
// raw-dylib: an EXTRACTED OBS release ships obs.dll with no obs.lib, and
// MSVC cannot link a DLL without an import library. raw-dylib makes rustc
// synthesise the import stubs from the DLL name, so a downloaded release
// works as a dev engine. Harmless when a source build DID produce a .lib.
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
// macOS SYSTEM symbols, not libobs ones: this block must not EXIST on Windows.
// It was annotated with the obs raw-dylib attribute in the first pass, which
// made rustc synthesise imports for them FROM obs.dll -- and the process then
// died at load with STATUS_ENTRYPOINT_NOT_FOUND, because obs.dll of course
// exports no CoreFoundation.
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
// macOS SYSTEM symbols, not libobs ones: this block must not EXIST on Windows.
// It was annotated with the obs raw-dylib attribute in the first pass, which
// made rustc synthesise imports for them FROM obs.dll -- and the process then
// died at load with STATUS_ENTRYPOINT_NOT_FOUND, because obs.dll of course
// exports no CoreFoundation.
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
// macOS SYSTEM symbols, not libobs ones: this block must not EXIST on Windows.
// It was annotated with the obs raw-dylib attribute in the first pass, which
// made rustc synthesise imports for them FROM obs.dll -- and the process then
// died at load with STATUS_ENTRYPOINT_NOT_FOUND, because obs.dll of course
// exports no CoreFoundation.
#[cfg(target_os = "macos")]
extern "C" {
    pub static kCFRunLoopDefaultMode: *const c_void;
    pub fn CFRunLoopRunInMode(
        mode: *const c_void,
        seconds: f64,
        return_after_source_handled: bool,
    ) -> i32;
}

// --- Source properties (device enumeration, UI-P2.9) --------------------
pub enum obs_properties_t {}
pub enum obs_property_t {}

// raw-dylib: an EXTRACTED OBS release ships obs.dll with no obs.lib, and
// MSVC cannot link a DLL without an import library. raw-dylib makes rustc
// synthesise the import stubs from the DLL name, so a downloaded release
// works as a dev engine. Harmless when a source build DID produce a .lib.
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    /// Properties for a source TYPE, without needing an instance.
    pub fn obs_get_source_properties(id: *const c_char) -> *mut obs_properties_t;
    /// Properties for a live INSTANCE — some modules (mac-avcapture) only
    /// populate device lists here, never on the bare type.
    pub fn obs_source_properties(source: *mut obs_source_t) -> *mut obs_properties_t;
    pub fn obs_properties_destroy(props: *mut obs_properties_t);
    pub fn obs_properties_first(props: *mut obs_properties_t) -> *mut obs_property_t;
    pub fn obs_property_next(prop: *mut *mut obs_property_t) -> bool;
    pub fn obs_properties_get(
        props: *mut obs_properties_t,
        name: *const c_char,
    ) -> *mut obs_property_t;
    pub fn obs_property_name(prop: *mut obs_property_t) -> *const c_char;
    pub fn obs_property_list_item_count(prop: *mut obs_property_t) -> usize;
    pub fn obs_property_list_item_name(prop: *mut obs_property_t, idx: usize) -> *const c_char;
    pub fn obs_property_list_item_string(prop: *mut obs_property_t, idx: usize) -> *const c_char;
    pub fn obs_property_list_item_disabled(prop: *mut obs_property_t, idx: usize) -> bool;

    pub fn obs_source_get_settings(source: *mut obs_source_t) -> *mut obs_data_t;
    pub fn obs_source_update(source: *mut obs_source_t, settings: *mut obs_data_t);
    pub fn obs_data_get_string(data: *mut obs_data_t, name: *const c_char) -> *const c_char;
    pub fn obs_data_set_obj(data: *mut obs_data_t, name: *const c_char, obj: *mut obs_data_t);

    // --- Performance, for the OBS-style health readout ---
    /// CEF inherits these on macOS (obs-browser passes them straight into
    /// CefMainArgs), so this is how a browser source gets Chromium switches
    /// without patching or rebuilding the engine.
    pub fn obs_set_cmdline_args(argc: c_int, argv: *const *const c_char);
    pub fn obs_get_active_fps() -> f64;
    pub fn video_output_get_total_frames(video: *const video_t) -> u32;
    pub fn video_output_get_skipped_frames(video: *const video_t) -> u32;
    /// Opaque CPU sampler; must be started once and queried over time, since
    /// a single sample has nothing to compare against.
    pub fn os_cpu_usage_info_start() -> *mut c_void;
    pub fn os_cpu_usage_info_query(info: *mut c_void) -> f64;
    /// Media playback (stingers). Duration is 0 until the file is opened.
    pub fn obs_source_media_get_duration(source: *mut obs_source_t) -> i64;
    pub fn obs_source_media_restart(source: *mut obs_source_t);
    pub fn obs_source_media_stop(source: *mut obs_source_t);
}
