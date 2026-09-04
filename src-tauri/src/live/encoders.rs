//! Video/audio encoder selection — one answer, decided at engine boot.
//!
//! macOS has one hardware H.264 encoder id (VideoToolbox) and it is
//! registered on every Mac, so the old code could spell it inline and fall
//! back to x264 when create returned null. Windows has THREE vendors with
//! different ids, and which of them exists is a property of the GPU in the
//! box — obs-nvenc / obs-qsv11 / obs-ffmpeg(AMF) each probe the hardware at
//! module load and register nothing when their vendor is absent. So the
//! honest way to know is the way OBS's own frontend does it: enumerate
//! `obs_enum_encoder_types` after `obs_post_load_modules`, and pick from
//! what is actually there.
//!
//! The choice is made once in `engine::bootstrap` and published here so the
//! multistream session, the recorder and the M-L3 harness all encode with
//! the same thing — and so the UI can gate a 4K canvas on `hardware`
//! (a 3840x2160 canvas through x264 is a space heater, not a product).

use std::ffi::CString;
use std::sync::Mutex;

use super::ffi;

/// The software fallback on every platform (obs-x264 is in the shared
/// allowlist). Never absent: engine.rs asserts it at boot.
pub const X264: &str = "obs_x264";

/// VideoToolbox hardware H.264 — the Apple id is fixed, not enumerated.
#[cfg(target_os = "macos")]
pub const VT_H264_HW: &str = "com.apple.videotoolbox.videoencoder.ave.avc";

/// Windows hardware H.264 ids at OBS 32.1.2, most preferred first. The
/// `_tex` / `_v2` / `texture_` ids are the zero-copy D3D11 paths; libobs
/// reroutes them to their `_soft` / `fallback` siblings by itself when the
/// texture path is unavailable (obs-nvenc nvenc.c, obs-qsv11, texture-amf.cpp
/// all call obs_encoder_create_rerouted), so the siblings are listed only
/// for completeness. `jim_nvenc` / `ffmpeg_nvenc` are the pre-31 names,
/// kept so a future lock bump to an older or newer obs-nvenc still lands
/// on NVENC rather than x264.
#[cfg(target_os = "windows")]
pub const HW_H264_PREFERENCE: &[&str] = &[
    // NVIDIA (obs-nvenc)
    "obs_nvenc_h264_tex",
    "obs_nvenc_h264_soft",
    "jim_nvenc",
    "ffmpeg_nvenc",
    // Intel (obs-qsv11)
    "obs_qsv11_v2",
    "obs_qsv11_soft_v2",
    "obs_qsv11",
    // AMD (obs-ffmpeg, texture-amf.cpp)
    "h264_texture_amf",
    "h264_fallback_amf",
];

/// Which vendor family an encoder id belongs to. Drives the per-encoder
/// settings keys in `apply_video_defaults`; every family has its own
/// vocabulary for "quality preset".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    X264,
    VideoToolbox,
    Nvenc,
    Qsv,
    Amf,
    Other,
}

pub fn family(id: &str) -> Family {
    if id == X264 {
        Family::X264
    } else if id.contains("videotoolbox") {
        Family::VideoToolbox
    } else if id.contains("nvenc") {
        Family::Nvenc
    } else if id.contains("qsv") {
        Family::Qsv
    } else if id.contains("amf") {
        Family::Amf
    } else {
        Family::Other
    }
}

/// The encoder the engine will use for every H.264 session.
#[derive(Debug, Clone)]
pub struct Choice {
    pub id: String,
    /// True when `id` is a GPU encoder (VideoToolbox / NVENC / QSV / AMF).
    pub hardware: bool,
}

impl Choice {
    fn x264() -> Choice {
        Choice {
            id: X264.into(),
            hardware: false,
        }
    }
}

/// Pick the H.264 encoder from the ids libobs actually registered.
///
/// macOS: VideoToolbox's fixed id when present. Windows: the first id of
/// `HW_H264_PREFERENCE` that was registered (NVENC → QSV → AMF). Anything
/// else, or nothing: x264.
pub fn choose_video(registered: &[String]) -> Choice {
    let has = |id: &str| registered.iter().any(|r| r == id);
    // QA / support override: PRODUCER_VIDEO_ENCODER=<registered id>. The only
    // way to exercise the x264 path and the 4K gate on a box that has a GPU
    // without deleting a probe helper from the bundle. Ignored when the id did
    // not register, so a typo cannot pick an encoder that does not exist.
    if let Ok(forced) = std::env::var("PRODUCER_VIDEO_ENCODER") {
        let forced = forced.trim().to_string();
        if !forced.is_empty() {
            if has(&forced) {
                let hardware = forced != X264 && family(&forced) != Family::Other;
                eprintln!("[live] video encoder forced by PRODUCER_VIDEO_ENCODER: {forced}");
                return Choice {
                    id: forced,
                    hardware,
                };
            }
            eprintln!(
                "[live] PRODUCER_VIDEO_ENCODER={forced} is not a registered encoder; ignoring"
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        if has(VT_H264_HW) {
            return Choice {
                id: VT_H264_HW.into(),
                hardware: true,
            };
        }
    }
    #[cfg(target_os = "windows")]
    {
        for id in HW_H264_PREFERENCE {
            if has(*id) {
                return Choice {
                    id: (*id).into(),
                    hardware: true,
                };
            }
        }
    }
    let _ = has;
    Choice::x264()
}

/// The AAC encoder: CoreAudio on macOS, obs-ffmpeg's on Windows (there is
/// no CoreAudio there; engine.rs requires `ffmpeg_aac` at boot instead).
pub fn audio_id() -> &'static str {
    if cfg!(target_os = "macos") {
        "CoreAudio_AAC"
    } else {
        "ffmpeg_aac"
    }
}

static CHOSEN: Mutex<Option<Choice>> = Mutex::new(None);

/// Publish the boot-time decision. Engine thread, once, after the probe.
pub fn set_chosen(choice: Choice) {
    *CHOSEN.lock().unwrap() = Some(choice);
}

/// The published decision; x264 if asked before the engine booted.
pub fn chosen() -> Choice {
    CHOSEN.lock().unwrap().clone().unwrap_or_else(Choice::x264)
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| CString::new("").unwrap())
}

unsafe fn set_str(d: *mut ffi::obs_data_t, k: &str, v: &str) {
    ffi::obs_data_set_string(d, cstr(k).as_ptr(), cstr(v).as_ptr());
}

unsafe fn set_int(d: *mut ffi::obs_data_t, k: &str, v: i64) {
    ffi::obs_data_set_int(d, cstr(k).as_ptr(), v);
}

unsafe fn set_bool(d: *mut ffi::obs_data_t, k: &str, v: bool) {
    ffi::obs_data_set_bool(d, cstr(k).as_ptr(), v);
}

/// The settings every Producer video encoder shares — CBR at `bitrate_kbps`
/// with a keyframe every 2s (what every RTMP service asks for and what makes
/// a recording scrubbable) — plus each family's own quality vocabulary,
/// pinned to the values OBS's own defaults use at 32.1.2 so a Producer
/// stream looks like an OBS stream on the same GPU:
///
/// * NVENC  `preset` p5, `tune` hq, `multipass` qres, `profile` high,
///          2 B-frames, no lookahead (latency), AQ on
/// * QSV    `target_usage` balanced (TU4), `profile` high
/// * AMF    `preset` quality, `profile` high
/// * x264 / VideoToolbox: untouched — their libobs defaults are the ones
///   the A7 Kick-CBR finding was made against, and nothing here should move
///   a macOS stream.
///
/// # Safety
/// `settings` must be a live obs_data_t; engine thread only.
pub unsafe fn apply_video_defaults(settings: *mut ffi::obs_data_t, id: &str, bitrate_kbps: i64) {
    set_str(settings, "rate_control", "CBR");
    set_int(settings, "bitrate", bitrate_kbps);
    set_int(settings, "keyint_sec", 2);
    match family(id) {
        Family::Nvenc => {
            set_str(settings, "preset", "p5");
            set_str(settings, "tune", "hq");
            set_str(settings, "multipass", "qres");
            set_str(settings, "profile", "high");
            set_int(settings, "bf", 2);
            set_bool(settings, "lookahead", false);
            set_bool(settings, "adaptive_quantization", true);
        }
        Family::Qsv => {
            set_str(settings, "target_usage", "balanced");
            set_str(settings, "profile", "high");
        }
        Family::Amf => {
            set_str(settings, "preset", "quality");
            set_str(settings, "profile", "high");
        }
        Family::X264 | Family::VideoToolbox | Family::Other => {}
    }
}

/// Create the chosen video encoder, falling back to x264 if libobs refuses
/// (a hardware encoder can be registered and still fail to instantiate —
/// driver gone, adapter lost, session limit hit). Returns the encoder and
/// the id that actually took; the id is what reports and the UI show.
///
/// # Safety
/// Engine thread only; `settings` must be a live obs_data_t.
pub unsafe fn create_video(
    name: &str,
    settings: *mut ffi::obs_data_t,
) -> (*mut ffi::obs_encoder_t, String) {
    let choice = chosen();
    let enc = ffi::obs_video_encoder_create(
        cstr(&choice.id).as_ptr(),
        cstr(name).as_ptr(),
        settings,
        std::ptr::null_mut(),
    );
    if !enc.is_null() || choice.id == X264 {
        return (enc, choice.id);
    }
    let enc = ffi::obs_video_encoder_create(
        cstr(X264).as_ptr(),
        cstr(&format!("{name} (x264)")).as_ptr(),
        settings,
        std::ptr::null_mut(),
    );
    (enc, X264.into())
}
