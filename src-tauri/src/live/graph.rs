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

/// Per-extra audio peaks, keyed by source pointer. Fixed atomic slots — the
/// audio thread must never take a lock (§5.1); 16 covers room cap with room
/// to spare.
const PEAK_SLOT: (std::sync::atomic::AtomicUsize, std::sync::atomic::AtomicU64) = (
    std::sync::atomic::AtomicUsize::new(0),
    std::sync::atomic::AtomicU64::new(0),
);
static EXTRA_PEAKS: [(std::sync::atomic::AtomicUsize, std::sync::atomic::AtomicU64); 16] =
    [PEAK_SLOT; 16];

extern "C" fn extra_audio_cb(
    _param: *mut c_void,
    source: *mut ffi::obs_source_t,
    audio: *const ffi::audio_data,
    muted: bool,
) {
    if muted || audio.is_null() {
        return;
    }
    let audio = unsafe { &*audio };
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
    let key = source as usize;
    for (slot_src, slot_peak) in EXTRA_PEAKS.iter() {
        if slot_src.load(Ordering::Relaxed) == key {
            slot_peak.fetch_max((peak * 1_000_000.0) as u64, Ordering::Relaxed);
            return;
        }
    }
}

fn peak_slot_register(src: *mut ffi::obs_source_t) {
    let key = src as usize;
    for (slot_src, slot_peak) in EXTRA_PEAKS.iter() {
        if slot_src
            .compare_exchange(0, key, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            slot_peak.store(0, Ordering::Relaxed);
            return;
        }
    }
}

fn peak_slot_release(src: *mut ffi::obs_source_t) {
    let key = src as usize;
    for (slot_src, slot_peak) in EXTRA_PEAKS.iter() {
        if slot_src.load(Ordering::Relaxed) == key {
            slot_src.store(0, Ordering::Relaxed);
            slot_peak.store(0, Ordering::Relaxed);
        }
    }
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

/// Live geometry of one scene item, in canvas coordinates (base size).
/// Everything the stage editor needs to draw selection and handles.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ItemState {
    pub id: String,
    pub kind: String,
    /// Human name for panel rows ("Screen", "intro.mp4", "Text").
    pub label: String,
    pub visible: bool,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub rot: f32,
    pub crop_left: i32,
    pub crop_top: i32,
    pub crop_right: i32,
    pub crop_bottom: i32,
    pub z: i32,
    pub src_w: u32,
    pub src_h: u32,
    /// Audio facts, so the mixer can show a strip for anything that makes
    /// sound rather than only the microphone.
    pub has_audio: bool,
    /// A/V sync offset in ms, positive = audio delayed.
    pub sync_ms: i64,
    pub volume: f32,
    pub muted: bool,
}

/// Patch semantics: only present fields are applied — the stage editor
/// sends exactly what the gesture changed.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct TransformPatch {
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub w: Option<f32>,
    pub h: Option<f32>,
    pub rot: Option<f32>,
    pub crop_left: Option<i32>,
    pub crop_top: Option<i32>,
    pub crop_right: Option<i32>,
    pub crop_bottom: Option<i32>,
    pub z: Option<i32>,
    pub visible: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SourcesState {
    pub screen: bool,
    pub camera: bool,
    pub mic: bool,
    /// Mic gain multiplier (0..=1 linear; the UI applies its own taper).
    pub mic_volume: f32,
    pub mic_muted: bool,
    /// Window-capture overlay (D1's sanctioned v1 escape hatch); the CGWindowID
    /// being captured, if any.
    pub overlay_window: Option<u32>,
    /// Native CEF overlay URL (M-L7.1); requires a browser-capable engine.
    pub overlay_url: Option<String>,
    /// Scene items with live geometry, back-to-front (UI-P1).
    pub items: Vec<ItemState>,
    /// Which device each picker is on (None = system default) — the strip
    /// highlights the active chip from these.
    pub camera_device: Option<String>,
    pub mic_device: Option<String>,
    pub screen_device: Option<String>,
}

impl Default for SourcesState {
    fn default() -> Self {
        SourcesState {
            screen: false,
            camera: false,
            mic: false,
            mic_volume: 1.0,
            mic_muted: false,
            overlay_window: None,
            overlay_url: None,
            items: Vec::new(),
            camera_device: None,
            mic_device: None,
            screen_device: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum OverlaySpec {
    None,
    Window { id: u32, color_key: bool },
    Browser { url: String },
}

/// A multi-instance scene item beyond the three well-known slots (UI-P2.10:
/// the item-list model). Specs arrive from the UI as tagged JSON; every kind
/// maps to a module that engine rev 3 already ships.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExtraSpec {
    /// Video/audio file via obs-ffmpeg (stingers, BRB loops, pre-rolls).
    Media {
        path: String,
        #[serde(default)]
        looping: bool,
    },
    /// Still image (logos, frames).
    Image { path: String },
    /// FreeType text (labels, countdowns). Color is "#rrggbb".
    Text {
        text: String,
        #[serde(default)]
        size: Option<u32>,
        #[serde(default)]
        color: Option<String>,
    },
    /// Solid color fill (backgrounds). "#rrggbb".
    Color { color: String },
    /// One window via SCK (same mechanism as the overlay's window mode).
    Window { window: u32 },
    /// A remote guest, rendered by the Connect guest page over a peer-to-peer
    /// WebRTC connection. This is a browser source with a specific contract:
    /// one URL PER GUEST, so each guest gets independent geometry on the stage
    /// and — because reroute_audio makes it its own audio source — an
    /// independent fader in the mixer. A single room page would fuse every
    /// guest into one track that can never be separated again.
    Guest { url: String },
}

struct ExtraItem {
    id: String,
    kind: &'static str,
    label: String,
    item: *mut ffi::obs_sceneitem_t,
    src: *mut ffi::obs_source_t,
}

/// "#rrggbb" → the 0xAABBGGRR integer OBS stores in data "color".
fn parse_color(hex: &str) -> Option<i64> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let r = i64::from_str_radix(&h[0..2], 16).ok()?;
    let g = i64::from_str_radix(&h[2..4], 16).ok()?;
    let b = i64::from_str_radix(&h[4..6], 16).ok()?;
    Some(0xFF00_0000 | (b << 16) | (g << 8) | r)
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
    mic_volume: f32,
    mic_muted: bool,
    overlay: Option<(
        *mut ffi::obs_sceneitem_t,
        *mut ffi::obs_source_t,
        OverlaySpec,
    )>,
    /// Chosen device per picker; survives a source being toggled off and on
    /// so the user's external mic or capture card is not silently forgotten.
    camera_device: Option<String>,
    mic_device: Option<String>,
    screen_device: Option<String>,
    /// The open-ended half of the item list (media, image, text, color,
    /// window). The three slots above are just well-known items; everything
    /// here rides the same transform/z/visibility pipeline.
    extras: Vec<ExtraItem>,
    /// The stinger clip while a transition is in flight. Deliberately NOT an
    /// extra: it is transition machinery, not a source the user owns, so it
    /// never appears in the sources list or the stage editor.
    stinger: Option<(*mut ffi::obs_sceneitem_t, *mut ffi::obs_source_t)>,
    stinger_path: Option<String>,
    stinger_duration: i64,
    /// Cached GPU objects for guest thumbnails (one texrender + staging
    /// surface reused every tick — creating them per frame would thrash).
    thumb_rt: *mut std::os::raw::c_void,
    thumb_ss: *mut std::os::raw::c_void,
}

/// One selectable device/display for a source's picker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceOption {
    pub id: String,
    pub name: String,
    pub disabled: bool,
}

/// Enumerate a list-valued property of a source TYPE straight from libobs —
/// the same list OBS's own dropdowns show, so cameras, capture cards, USB
/// mics and audio interfaces all appear without us knowing anything about
/// them. Must run on the engine-owner thread (§5.1).
/// Read one list-valued property out of an already-obtained properties set.
unsafe fn options_from(props: *mut ffi::obs_properties_t, prop: &str) -> Vec<DeviceOption> {
    let mut out = Vec::new();
    let Ok(pname) = CString::new(prop) else {
        return out;
    };
    let p = ffi::obs_properties_get(props, pname.as_ptr());
    if p.is_null() {
        return out;
    }
    let count = ffi::obs_property_list_item_count(p);
    for i in 0..count {
        let name = ffi::obs_property_list_item_name(p, i);
        let value = ffi::obs_property_list_item_string(p, i);
        if name.is_null() || value.is_null() {
            continue;
        }
        out.push(DeviceOption {
            id: std::ffi::CStr::from_ptr(value)
                .to_string_lossy()
                .into_owned(),
            name: std::ffi::CStr::from_ptr(name)
                .to_string_lossy()
                .into_owned(),
            disabled: ffi::obs_property_list_item_disabled(p, i),
        });
    }
    out
}

pub fn list_property_options(source_id: &str, prop: &str) -> Vec<DeviceOption> {
    unsafe {
        let id = match CString::new(source_id) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let props = ffi::obs_get_source_properties(id.as_ptr());
        if props.is_null() {
            return Vec::new();
        }
        let out = options_from(props, prop);
        ffi::obs_properties_destroy(props);
        out
    }
}

/// The source type + candidate property names behind each picker. libobs
/// names these differently per platform and version, so we try in order and
/// take the first that actually yields items rather than hardcoding one.
pub fn device_picker_spec(kind: &str) -> Option<(&'static str, &'static [&'static str])> {
    match kind {
        "camera" => Some(("macos-avcapture", &["device"])),
        "mic" => Some(("coreaudio_input_capture", &["device_id", "device"])),
        "screen" => Some(("screen_capture", &["display_uuid", "display"])),
        _ => None,
    }
}

/// Devices for one picker, straight from libobs — the same list OBS shows,
/// so USB mics, audio interfaces and capture cards appear without us knowing
/// anything about them.
/// Producer's own virtual camera must never be selectable as a camera SOURCE:
/// pointing the stage at its own output is an infinite feedback loop, and it
/// holds the CMIO device open so the virtual-camera output can no longer
/// start. Excluded from the picker and from default selection.
pub const VCAM_DEVICE_NAME: &str = "Producer Virtual Camera";

fn drop_own_vcam(kind: &str, opts: Vec<DeviceOption>) -> Vec<DeviceOption> {
    if kind != "camera" {
        return opts;
    }
    opts.into_iter()
        .filter(|o| !o.name.contains(VCAM_DEVICE_NAME))
        .collect()
}

pub fn devices_for(kind: &str) -> Vec<DeviceOption> {
    let Some((source_id, props)) = device_picker_spec(kind) else {
        return Vec::new();
    };
    for prop in props {
        let opts = drop_own_vcam(kind, list_property_options(source_id, prop));
        if !opts.is_empty() {
            return opts;
        }
    }
    eprintln!(
        "[live] no device list for {kind}: {source_id} exposes {:?}",
        list_property_names(source_id)
    );
    Vec::new()
}

/// Every property name a source type exposes — used by the --live-props
/// probe so picker wiring is written against reality, not guesses.
pub fn list_property_names(source_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        let id = match CString::new(source_id) {
            Ok(v) => v,
            Err(_) => return out,
        };
        let props = ffi::obs_get_source_properties(id.as_ptr());
        if props.is_null() {
            return out;
        }
        let mut p = ffi::obs_properties_first(props);
        while !p.is_null() {
            let n = ffi::obs_property_name(p);
            if !n.is_null() {
                let name = std::ffi::CStr::from_ptr(n).to_string_lossy().into_owned();
                let count = ffi::obs_property_list_item_count(p);
                out.push(format!("{name} (list items: {count})"));
            }
            if !ffi::obs_property_next(&mut p) {
                break;
            }
        }
        ffi::obs_properties_destroy(props);
    }
    out
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
                mic_volume: 1.0,
                mic_muted: false,
                overlay: None,
                camera_device: None,
                mic_device: None,
                screen_device: None,
                extras: Vec::new(),
                thumb_rt: std::ptr::null_mut(),
                thumb_ss: std::ptr::null_mut(),
                stinger: None,
                stinger_path: None,
                stinger_duration: 0,
            })
        }
    }

    pub fn state(&self) -> SourcesState {
        SourcesState {
            screen: self.screen.is_some(),
            camera: self.camera.is_some(),
            mic: self.mic.is_some(),
            mic_volume: self.mic_volume,
            mic_muted: self.mic_muted,
            overlay_window: self.overlay.as_ref().and_then(|(_, _, spec)| match spec {
                OverlaySpec::Window { id, .. } => Some(*id),
                _ => None,
            }),
            overlay_url: self.overlay.as_ref().and_then(|(_, _, spec)| match spec {
                OverlaySpec::Browser { url } => Some(url.clone()),
                _ => None,
            }),
            items: self.items(),
            camera_device: self.camera_device.clone(),
            mic_device: self.mic_device.clone(),
            screen_device: self.screen_device.clone(),
        }
    }

    /// The three video slots as uniform items. Read straight from libobs so
    /// the editor always sees engine truth, never a cached shadow.
    fn items(&self) -> Vec<ItemState> {
        let mut out = Vec::new();
        let mut push = |id: &str, kind: &str, label: &str, item: *mut ffi::obs_sceneitem_t| unsafe {
            let src = ffi::obs_sceneitem_get_source(item);
            let mut pos = ffi::vec2 { x: 0.0, y: 0.0 };
            let mut bounds = ffi::vec2 { x: 0.0, y: 0.0 };
            let mut crop = ffi::obs_sceneitem_crop::default();
            ffi::obs_sceneitem_get_pos(item, &mut pos);
            ffi::obs_sceneitem_get_bounds(item, &mut bounds);
            ffi::obs_sceneitem_get_crop(item, &mut crop);
            let (src_w, src_h) = if src.is_null() {
                (0, 0)
            } else {
                (
                    ffi::obs_source_get_width(src),
                    ffi::obs_source_get_height(src),
                )
            };
            // Items without bounds report their source size as extent.
            let (w, h) = if bounds.x > 0.0 && bounds.y > 0.0 {
                (bounds.x, bounds.y)
            } else {
                (src_w as f32, src_h as f32)
            };
            out.push(ItemState {
                id: id.into(),
                kind: kind.into(),
                label: label.into(),
                visible: ffi::obs_sceneitem_visible(item),
                x: pos.x,
                y: pos.y,
                w,
                h,
                rot: ffi::obs_sceneitem_get_rot(item),
                crop_left: crop.left,
                crop_top: crop.top,
                crop_right: crop.right,
                crop_bottom: crop.bottom,
                z: ffi::obs_sceneitem_get_order_position(item),
                src_w,
                src_h,
                // OBS_SOURCE_AUDIO = 1 << 1
                has_audio: !src.is_null() && (ffi::obs_source_get_output_flags(src) & 0x2) != 0,
                sync_ms: if src.is_null() { 0 } else { ffi::obs_source_get_sync_offset(src) / 1_000_000 },
                volume: if src.is_null() { 1.0 } else { ffi::obs_source_get_volume(src) },
                muted: !src.is_null() && ffi::obs_source_muted(src),
            });
        };
        if let Some((item, _)) = self.screen {
            push("screen", "screen", "Screen", item);
        }
        if let Some((item, _)) = self.camera {
            push("camera", "camera", "Camera", item);
        }
        if let Some((item, _, _)) = self.overlay.as_ref() {
            push("overlay", "overlay", "Overlay", *item);
        }
        for e in &self.extras {
            push(&e.id, e.kind, &e.label, e.item);
        }
        out.sort_by_key(|i| i.z);
        out
    }

    /// The underlying source for any item id, including the audio-only mic.
    /// Filters attach to sources, not scene items.
    pub fn source_by_id(&self, id: &str) -> Option<*mut ffi::obs_source_t> {
        match id {
            "screen" => self.screen.map(|(_, s)| s),
            "camera" => self.camera.map(|(_, s)| s),
            "overlay" => self.overlay.as_ref().map(|(_, s, _)| *s),
            "mic" => self.mic,
            other => self.extras.iter().find(|e| e.id == other).map(|e| e.src),
        }
    }

    fn item_by_id(&self, id: &str) -> Option<*mut ffi::obs_sceneitem_t> {
        match id {
            "screen" => self.screen.map(|(i, _)| i),
            "camera" => self.camera.map(|(i, _)| i),
            "overlay" => self.overlay.as_ref().map(|(i, _, _)| *i),
            other => self.extras.iter().find(|e| e.id == other).map(|e| e.item),
        }
    }

    /// Apply a transform patch to one item (UI-P1). Engine thread only.
    pub fn set_transform(&mut self, id: &str, t: &TransformPatch) -> Result<(), String> {
        let item = self.item_by_id(id).ok_or_else(|| format!("no item {id}"))?;
        unsafe {
            if t.x.is_some() || t.y.is_some() {
                let mut pos = ffi::vec2 { x: 0.0, y: 0.0 };
                ffi::obs_sceneitem_get_pos(item, &mut pos);
                let pos = ffi::vec2 {
                    x: t.x.unwrap_or(pos.x),
                    y: t.y.unwrap_or(pos.y),
                };
                ffi::obs_sceneitem_set_pos(item, &pos);
            }
            if t.w.is_some() || t.h.is_some() {
                let mut b = ffi::vec2 { x: 0.0, y: 0.0 };
                ffi::obs_sceneitem_get_bounds(item, &mut b);
                let b = ffi::vec2 {
                    x: t.w.unwrap_or(b.x).max(16.0),
                    y: t.h.unwrap_or(b.y).max(16.0),
                };
                ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
                ffi::obs_sceneitem_set_bounds(item, &b);
            }
            if let Some(rot) = t.rot {
                ffi::obs_sceneitem_set_rot(item, rot);
            }
            if t.crop_left.is_some()
                || t.crop_top.is_some()
                || t.crop_right.is_some()
                || t.crop_bottom.is_some()
            {
                let mut c = ffi::obs_sceneitem_crop::default();
                ffi::obs_sceneitem_get_crop(item, &mut c);
                let c = ffi::obs_sceneitem_crop {
                    left: t.crop_left.unwrap_or(c.left).max(0),
                    top: t.crop_top.unwrap_or(c.top).max(0),
                    right: t.crop_right.unwrap_or(c.right).max(0),
                    bottom: t.crop_bottom.unwrap_or(c.bottom).max(0),
                };
                ffi::obs_sceneitem_set_crop(item, &c);
            }
            if let Some(z) = t.z {
                ffi::obs_sceneitem_set_order_position(item, z.max(0));
            }
            if let Some(v) = t.visible {
                ffi::obs_sceneitem_set_visible(item, v);
            }
        }
        Ok(())
    }

    /// Overlay on top of the scene. Window mode = D1's v1 escape hatch (SCK
    /// window capture + optional green color-key). Browser mode = M-L7.1
    /// native CEF (`browser_source`); fails truthfully on engines built
    /// without obs-browser. None clears.
    pub fn set_overlay(&mut self, spec: OverlaySpec) -> Result<(), String> {
        unsafe {
            if let Some((item, src, _)) = self.overlay.take() {
                ffi::obs_sceneitem_remove(item);
                ffi::obs_source_release(src);
            }
            let (src, color_key) = match &spec {
                OverlaySpec::None => return Ok(()),
                OverlaySpec::Window {
                    id: window_id,
                    color_key,
                } => {
                    let settings = ffi::obs_data_create();
                    // mac-sck-common.h: ScreenCaptureWindowStream = 1
                    ffi::obs_data_set_int(settings, CString::new("type").unwrap().as_ptr(), 1);
                    ffi::obs_data_set_int(
                        settings,
                        CString::new("window").unwrap().as_ptr(),
                        *window_id as i64,
                    );
                    ffi::obs_data_set_bool(
                        settings,
                        CString::new("show_cursor").unwrap().as_ptr(),
                        false,
                    );
                    let id = CString::new("screen_capture").unwrap();
                    let name = CString::new("Overlay").unwrap();
                    let src = ffi::obs_source_create(
                        id.as_ptr(),
                        name.as_ptr(),
                        settings,
                        ptr::null_mut(),
                    );
                    ffi::obs_data_release(settings);
                    if src.is_null() {
                        return Err("overlay window capture creation failed".into());
                    }
                    (src, *color_key)
                }
                OverlaySpec::Browser { url } => {
                    let (bw, bh) = Self::base_size();
                    let settings = ffi::obs_data_create();
                    let k_url = CString::new("url").unwrap();
                    let v_url = CString::new(url.clone()).unwrap();
                    ffi::obs_data_set_string(settings, k_url.as_ptr(), v_url.as_ptr());
                    ffi::obs_data_set_int(
                        settings,
                        CString::new("width").unwrap().as_ptr(),
                        bw as i64,
                    );
                    ffi::obs_data_set_int(
                        settings,
                        CString::new("height").unwrap().as_ptr(),
                        bh as i64,
                    );
                    // overlay audio joins the mix as a source, not the desktop
                    ffi::obs_data_set_bool(
                        settings,
                        CString::new("reroute_audio").unwrap().as_ptr(),
                        true,
                    );
                    // PRODUCER_TEST_MONITOR=1 forces this source to
                    // MONITOR_ONLY so a recording can be inspected for leaks.
                    // Applied after creation, below.
                    let id = CString::new("browser_source").unwrap();
                    let name = CString::new("Overlay").unwrap();
                    let src = ffi::obs_source_create(
                        id.as_ptr(),
                        name.as_ptr(),
                        settings,
                        ptr::null_mut(),
                    );
                    ffi::obs_data_release(settings);
                    if src.is_null() {
                        return Err(
                            "browser overlays need the CEF-capable engine (M-L7.1) — this build's engine doesn't include obs-browser"
                                .into(),
                        );
                    }
                    (src, false)
                }
            };
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
            if std::env::var("PRODUCER_TEST_MONITOR").as_deref() == Ok("1") {
                ffi::obs_source_set_monitoring_type(src, 1);
                eprintln!("[test] overlay forced to MONITOR_ONLY");
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
            self.overlay = Some((item, src, spec));
        }
        Ok(())
    }

    /// Put the stinger clip on top of everything and start it. Returns the
    /// clip's duration in ms, or 0 when the file hasn't reported one yet —
    /// the caller falls back to its configured length rather than us
    /// blocking the engine thread waiting for ffmpeg to open the file.
    /// Create the clip AHEAD of the transition, hidden. Opening a media file
    /// makes ffmpeg probe it, which can take seconds — doing that during a
    /// cut blocks the engine thread and stalls the whole stage. Prepared at
    /// selection time, playing is then just "show it and restart".
    pub fn prepare_stinger(&mut self, path: &str) -> Result<i64, String> {
        if let Some(p) = &self.stinger_path {
            if p == path && self.stinger.is_some() {
                return Ok(self.stinger_duration);
            }
        }
        self.stop_stinger();
        let dur = self.create_stinger(path)?;
        if let Some((item, _)) = self.stinger {
            unsafe { ffi::obs_sceneitem_set_visible(item, false) };
        }
        self.stinger_path = Some(path.to_string());
        self.stinger_duration = dur;
        Ok(dur)
    }

    /// Show the prepared clip and restart it. Falls back to preparing inline
    /// when nothing is ready — correctness over speed in that rare case.
    pub fn play_stinger(&mut self, path: &str) -> Result<i64, String> {
        let ready = self.stinger.is_some() && self.stinger_path.as_deref() == Some(path);
        if !ready {
            self.prepare_stinger(path)?;
        }
        let (item, src) = self.stinger.ok_or("stinger not ready")?;
        unsafe {
            ffi::obs_sceneitem_set_visible(item, true);
            ffi::obs_sceneitem_set_order_position(item, 999);
            ffi::obs_source_media_restart(src);
            let d = ffi::obs_source_media_get_duration(src);
            if d > 0 {
                self.stinger_duration = d;
            }
        }
        Ok(self.stinger_duration)
    }

    /// Hide the clip without destroying it — the next transition reuses it.
    pub fn hide_stinger(&mut self) {
        if let Some((item, src)) = self.stinger {
            unsafe {
                ffi::obs_sceneitem_set_visible(item, false);
                ffi::obs_source_media_stop(src);
            }
        }
    }

    fn create_stinger(&mut self, path: &str) -> Result<i64, String> {
        unsafe {
            let settings = ffi::obs_data_create();
            ffi::obs_data_set_bool(
                settings,
                CString::new("is_local_file").unwrap().as_ptr(),
                true,
            );
            let v = CString::new(path).map_err(|_| "bad stinger path")?;
            ffi::obs_data_set_string(
                settings,
                CString::new("local_file").unwrap().as_ptr(),
                v.as_ptr(),
            );
            ffi::obs_data_set_bool(settings, CString::new("looping").unwrap().as_ptr(), false);
            ffi::obs_data_set_bool(settings, CString::new("hw_decode").unwrap().as_ptr(), true);
            ffi::obs_data_set_bool(
                settings,
                CString::new("close_when_inactive").unwrap().as_ptr(),
                false,
            );
            ffi::obs_data_set_bool(
                settings,
                CString::new("restart_on_activate").unwrap().as_ptr(),
                true,
            );
            let id = CString::new("ffmpeg_source").unwrap();
            let name = CString::new("__stinger__").unwrap();
            let src = ffi::obs_source_create(id.as_ptr(), name.as_ptr(), settings, ptr::null_mut());
            ffi::obs_data_release(settings);
            if src.is_null() {
                return Err("couldn't open that stinger clip".into());
            }
            let item = ffi::obs_scene_add(self.scene, src);
            if item.is_null() {
                ffi::obs_source_release(src);
                return Err("scene add failed for the stinger".into());
            }
            let (bw, bh) = Self::base_size();
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            let bounds = ffi::vec2 { x: bw, y: bh };
            ffi::obs_sceneitem_set_bounds(item, &bounds);
            let pos = ffi::vec2 { x: 0.0, y: 0.0 };
            ffi::obs_sceneitem_set_pos(item, &pos);
            ffi::obs_sceneitem_set_visible(item, true);
            // Above every real item — the whole point is to hide the cut.
            ffi::obs_sceneitem_set_order_position(item, 999);
            let dur = ffi::obs_source_media_get_duration(src);
            self.stinger = Some((item, src));
            Ok(dur.max(0))
        }
    }

    /// Destroy the clip entirely (room change, or a different file chosen).
    pub fn stop_stinger(&mut self) {
        self.stinger_path = None;
        if let Some((item, src)) = self.stinger.take() {
            unsafe {
                ffi::obs_sceneitem_remove(item);
                ffi::obs_source_release(src);
            }
        }
    }

    /// Add one item from the open-ended list. Engine thread only. The id is
    /// caller-chosen (the room document owns it, so a room can respawn its
    /// items with stable identity); duplicates are refused.
    pub fn add_extra(&mut self, id: &str, label: &str, spec: &ExtraSpec) -> Result<(), String> {
        if matches!(id, "screen" | "camera" | "overlay") || self.extras.iter().any(|e| e.id == id) {
            return Err(format!("an item named {id} already exists"));
        }
        unsafe {
            let (type_id, kind, settings): (&str, &'static str, *mut ffi::obs_data_t) = match spec {
                // PRODUCER_TEST_MONITOR=1 forces media sources to MONITOR_ONLY
                // so a recording can be inspected for leaks against a known
                // loud signal. Applied after creation.
                ExtraSpec::Media { path, looping } => {
                    let d = ffi::obs_data_create();
                    ffi::obs_data_set_bool(
                        d,
                        CString::new("is_local_file").unwrap().as_ptr(),
                        true,
                    );
                    let v = CString::new(path.as_str()).map_err(|_| "bad path")?;
                    ffi::obs_data_set_string(
                        d,
                        CString::new("local_file").unwrap().as_ptr(),
                        v.as_ptr(),
                    );
                    ffi::obs_data_set_bool(d, CString::new("looping").unwrap().as_ptr(), *looping);
                    ffi::obs_data_set_bool(d, CString::new("hw_decode").unwrap().as_ptr(), true);
                    ("ffmpeg_source", "media", d)
                }
                ExtraSpec::Image { path } => {
                    let d = ffi::obs_data_create();
                    let v = CString::new(path.as_str()).map_err(|_| "bad path")?;
                    ffi::obs_data_set_string(d, CString::new("file").unwrap().as_ptr(), v.as_ptr());
                    ("image_source", "image", d)
                }
                ExtraSpec::Text { text, size, color } => {
                    let d = ffi::obs_data_create();
                    let v = CString::new(text.as_str()).map_err(|_| "bad text")?;
                    ffi::obs_data_set_string(d, CString::new("text").unwrap().as_ptr(), v.as_ptr());
                    let font = ffi::obs_data_create();
                    ffi::obs_data_set_string(
                        font,
                        CString::new("face").unwrap().as_ptr(),
                        CString::new("Helvetica").unwrap().as_ptr(),
                    );
                    ffi::obs_data_set_int(
                        font,
                        CString::new("size").unwrap().as_ptr(),
                        size.unwrap_or(96) as i64,
                    );
                    ffi::obs_data_set_obj(d, CString::new("font").unwrap().as_ptr(), font);
                    ffi::obs_data_release(font);
                    let c = color
                        .as_deref()
                        .and_then(parse_color)
                        .unwrap_or(0xFFFF_FFFFu32 as i64);
                    ffi::obs_data_set_int(d, CString::new("color1").unwrap().as_ptr(), c);
                    ffi::obs_data_set_int(d, CString::new("color2").unwrap().as_ptr(), c);
                    ("text_ft2_source_v2", "text", d)
                }
                ExtraSpec::Color { color } => {
                    let d = ffi::obs_data_create();
                    let c = parse_color(color).ok_or("color must be #rrggbb")?;
                    ffi::obs_data_set_int(d, CString::new("color").unwrap().as_ptr(), c);
                    let (bw, bh) = Self::base_size();
                    ffi::obs_data_set_int(d, CString::new("width").unwrap().as_ptr(), bw as i64);
                    ffi::obs_data_set_int(d, CString::new("height").unwrap().as_ptr(), bh as i64);
                    ("color_source_v3", "color", d)
                }
                ExtraSpec::Guest { url } => {
                    let (bw, bh) = Self::base_size();
                    let d = ffi::obs_data_create();
                    let k_url = CString::new("url").unwrap();
                    let v_url = CString::new(url.clone()).map_err(|_| "bad guest url")?;
                    ffi::obs_data_set_string(d, k_url.as_ptr(), v_url.as_ptr());
                    ffi::obs_data_set_int(d, CString::new("width").unwrap().as_ptr(), bw as i64);
                    ffi::obs_data_set_int(d, CString::new("height").unwrap().as_ptr(), bh as i64);
                    // The guest's voice must land in the mixer as this
                    // source's own strip, not on the desktop bus.
                    ffi::obs_data_set_bool(d, CString::new("reroute_audio").unwrap().as_ptr(), true);
                    // A guest page is a live call: never suspend it when the
                    // source is hidden, or muting a guest would disconnect
                    // them mid-conversation.
                    ffi::obs_data_set_bool(d, CString::new("shutdown").unwrap().as_ptr(), false);
                    ffi::obs_data_set_bool(
                        d,
                        CString::new("restart_when_active").unwrap().as_ptr(),
                        false,
                    );
                    ("browser_source", "guest", d)
                }
                ExtraSpec::Window { window } => {
                    let d = ffi::obs_data_create();
                    // mac-sck-common.h: ScreenCaptureWindowStream = 1
                    ffi::obs_data_set_int(d, CString::new("type").unwrap().as_ptr(), 1);
                    ffi::obs_data_set_int(
                        d,
                        CString::new("window").unwrap().as_ptr(),
                        *window as i64,
                    );
                    ffi::obs_data_set_bool(d, CString::new("show_cursor").unwrap().as_ptr(), false);
                    ("screen_capture", "window", d)
                }
            };
            let tid = CString::new(type_id).unwrap();
            let name = CString::new(id).map_err(|_| "bad id")?;
            let src =
                ffi::obs_source_create(tid.as_ptr(), name.as_ptr(), settings, ptr::null_mut());
            ffi::obs_data_release(settings);
            if src.is_null() {
                return Err(format!(
                    "{type_id} creation failed — is its module in this engine?"
                ));
            }
            let item = ffi::obs_scene_add(self.scene, src);
            if item.is_null() {
                ffi::obs_source_release(src);
                return Err("scene add failed".into());
            }
            // Full-frame bounds for picture-like kinds; text keeps its natural
            // size (bounds-scaling rasterized glyphs just blurs them).
            if !matches!(spec, ExtraSpec::Text { .. }) {
                let (bw, bh) = Self::base_size();
                ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
                let bounds = ffi::vec2 { x: bw, y: bh };
                ffi::obs_sceneitem_set_bounds(item, &bounds);
                let pos = ffi::vec2 { x: 0.0, y: 0.0 };
                ffi::obs_sceneitem_set_pos(item, &pos);
            } else {
                let pos = ffi::vec2 { x: 80.0, y: 80.0 };
                ffi::obs_sceneitem_set_pos(item, &pos);
            }
            // Guests are created HIDDEN: being admitted puts someone in the
            // room, not on the air. Every other kind appears immediately —
            // you added it because you want to see it. Doing this here rather
            // than with a follow-up transform removes a race where the hide
            // could arrive before the item existed.
            // Leak test: force this source monitor-only so a recording can be
            // inspected against a known loud signal. Env-gated, dev only.
            if std::env::var("PRODUCER_TEST_MONITOR").as_deref() == Ok("1") {
                ffi::obs_source_set_monitoring_type(src, 1);
                eprintln!("[test] {id} forced to MONITOR_ONLY");
            }
            let born_visible = !matches!(spec, ExtraSpec::Guest { .. });
            ffi::obs_sceneitem_set_visible(item, born_visible);
            // A guest in the room is SEEN, NOT HEARD: they arrive muted and
            // stay muted until put on screen. Preview is for judging whether
            // someone is ready, not for putting their kitchen into the show.
            if !born_visible {
                ffi::obs_source_set_muted(src, true);
            }
            // Meter every audio-bearing extra the mixer shows a strip for.
            if matches!(kind, "guest" | "media") {
                peak_slot_register(src);
                ffi::obs_source_add_audio_capture_callback(src, extra_audio_cb, ptr::null_mut());
            }
            self.extras.push(ExtraItem {
                id: id.to_string(),
                kind,
                label: label.to_string(),
                item,
                src,
            });
        }
        Ok(())
    }

    /// Remove one open-list item and release its source.
    pub fn remove_extra(&mut self, id: &str) -> Result<(), String> {
        let idx = self
            .extras
            .iter()
            .position(|e| e.id == id)
            .ok_or_else(|| format!("no item named {id}"))?;
        let e = self.extras.remove(idx);
        if matches!(e.kind, "guest" | "media") {
            unsafe {
                ffi::obs_source_remove_audio_capture_callback(e.src, extra_audio_cb, ptr::null_mut());
            }
            peak_slot_release(e.src);
        }
        unsafe {
            ffi::obs_sceneitem_remove(e.item);
            ffi::obs_source_release(e.src);
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
                    let uuid = match self.screen_device.clone() {
                        Some(d) => d,
                        None => main_display_uuid().ok_or("could not resolve main display UUID")?,
                    };
                    self.screen_device = Some(uuid.clone());
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
                    // Bounds-driven like every other item, so the stage
                    // editor speaks one geometry language (UI-P1).
                    let (bw, bh) = Self::base_size();
                    ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
                    let bounds = ffi::vec2 { x: bw, y: bh };
                    ffi::obs_sceneitem_set_bounds(item, &bounds);
                    let pos = ffi::vec2 { x: 0.0, y: 0.0 };
                    ffi::obs_sceneitem_set_pos(item, &pos);
                    self.screen = Some((item, src));
                }
            }
        }
        self.layout_camera();
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
                    let device = match self.camera_device.clone() {
                        Some(d) => d,
                        None => {
                            let mut buf = [0i8; 256];
                            if ffi::producer_default_camera_id(buf.as_mut_ptr(), buf.len() as i32)
                                == 0
                            {
                                return Err("no camera device found".into());
                            }
                            std::ffi::CStr::from_ptr(buf.as_ptr())
                                .to_string_lossy()
                                .into_owned()
                        }
                    };
                    self.camera_device = Some(device.clone());
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
                    ffi::obs_sceneitem_set_visible(item, true);
                    self.camera = Some((item, src));
                    self.layout_camera();
                }
            }
        }
        Ok(())
    }

    /// Camera placement follows the scene: full-frame when it's the only
    /// video source ("Full cam"), picture-in-picture bottom-right when the
    /// screen is up ("PiP"). Engine thread only.
    fn layout_camera(&mut self) {
        let Some((item, _)) = self.camera else { return };
        let (bw, bh) = Self::base_size();
        unsafe {
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            if self.screen.is_some() {
                let pip_w = bw * 0.28;
                let pip_h = pip_w * 9.0 / 16.0;
                let margin = 24.0;
                let bounds = ffi::vec2 { x: pip_w, y: pip_h };
                ffi::obs_sceneitem_set_bounds(item, &bounds);
                let pos = ffi::vec2 {
                    x: bw - pip_w - margin,
                    y: bh - pip_h - margin,
                };
                ffi::obs_sceneitem_set_pos(item, &pos);
            } else {
                let bounds = ffi::vec2 { x: bw, y: bh };
                ffi::obs_sceneitem_set_bounds(item, &bounds);
                let pos = ffi::vec2 { x: 0.0, y: 0.0 };
                ffi::obs_sceneitem_set_pos(item, &pos);
            }
        }
    }

    pub fn set_mic(&mut self, on: bool) -> Result<(), String> {
        unsafe {
            match (on, self.mic.take()) {
                (true, Some(existing)) => self.mic = Some(existing),
                (false, None) => {}
                (false, Some(src)) => {
                    ffi::obs_source_remove_audio_capture_callback(src, audio_cb, ptr::null_mut());
                    ffi::obs_set_output_source(1, ptr::null_mut());
                    ffi::obs_source_release(src);
                }
                (true, None) => {
                    let id = CString::new("coreaudio_input_capture").unwrap();
                    let name = CString::new("Mic").unwrap();
                    // NULL settings = system default input; a chosen device
                    // (USB mic, interface) is remembered across toggles.
                    let settings = match self.mic_device.as_deref() {
                        Some(d) => {
                            let s = ffi::obs_data_create();
                            if let Ok(v) = CString::new(d) {
                                ffi::obs_data_set_string(
                                    s,
                                    CString::new("device_id").unwrap().as_ptr(),
                                    v.as_ptr(),
                                );
                            }
                            s
                        }
                        None => ptr::null_mut(),
                    };
                    let src = ffi::obs_source_create(
                        id.as_ptr(),
                        name.as_ptr(),
                        settings,
                        ptr::null_mut(),
                    );
                    if !settings.is_null() {
                        ffi::obs_data_release(settings);
                    }
                    if src.is_null() {
                        return Err("mic source creation failed".into());
                    }
                    // The meter rides the capture callback (audio thread →
                    // one atomic, §5.1); volume/mute survive re-creation.
                    ffi::obs_source_add_audio_capture_callback(src, audio_cb, ptr::null_mut());
                    ffi::obs_source_set_volume(src, self.mic_volume);
                    ffi::obs_source_set_muted(src, self.mic_muted);
                    ffi::obs_set_output_source(1, src);
                    self.mic = Some(src);
                }
            }
        }
        Ok(())
    }

    /// Devices for one picker, instance-first: mac-avcapture (and friends)
    /// only fill their device dropdowns on obs_source_properties of a LIVE
    /// source — the bare type returns an empty list. Fall back to the type
    /// when the source is toggled off.
    pub fn devices(&self, kind: &str) -> Vec<DeviceOption> {
        let src = match kind {
            "camera" => self.camera.map(|(_, s)| s),
            "mic" => self.mic,
            "screen" => self.screen.map(|(_, s)| s),
            _ => None,
        };
        if let (Some(src), Some((_, props_names))) = (src, device_picker_spec(kind)) {
            unsafe {
                let props = ffi::obs_source_properties(src);
                if !props.is_null() {
                    for prop in props_names {
                        let opts = drop_own_vcam(kind, options_from(props, prop));
                        if !opts.is_empty() {
                            ffi::obs_properties_destroy(props);
                            return opts;
                        }
                    }
                    ffi::obs_properties_destroy(props);
                }
            }
        }
        devices_for(kind)
    }

    /// Point a live source at a different device — camera, microphone or
    /// display. Applied with obs_source_update so the scene item, its
    /// transform and its place in the stack all survive the swap; the user
    /// sees the picture change, not the layout reset.
    pub fn set_device(&mut self, kind: &str, device: &str) -> Result<(), String> {
        let Some((_, props)) = device_picker_spec(kind) else {
            return Err(format!("no device picker for {kind}"));
        };
        let src = match kind {
            "camera" => self.camera.map(|(_, s)| s),
            "mic" => self.mic,
            "screen" => self.screen.map(|(_, s)| s),
            _ => None,
        }
        .ok_or_else(|| format!("{kind} is not on the stage"))?;

        unsafe {
            let settings = ffi::obs_data_create();
            let value = CString::new(device).map_err(|_| "bad device id")?;
            // Write every candidate key: harmless extras are ignored, and we
            // never have to care which spelling this platform build uses.
            for prop in props {
                if let Ok(key) = CString::new(*prop) {
                    ffi::obs_data_set_string(settings, key.as_ptr(), value.as_ptr());
                }
            }
            if kind == "camera" {
                // Keep the webcam's own audio out of the mix (mic is separate).
                ffi::obs_data_set_bool(
                    settings,
                    CString::new("enable_audio").unwrap().as_ptr(),
                    false,
                );
            }
            if kind == "screen" {
                // SCK display mode: ScreenCaptureDisplayStream = 0.
                ffi::obs_data_set_int(settings, CString::new("type").unwrap().as_ptr(), 0);
            }
            ffi::obs_source_update(src, settings);
            ffi::obs_data_release(settings);
        }
        match kind {
            "camera" => self.camera_device = Some(device.to_string()),
            "mic" => self.mic_device = Some(device.to_string()),
            "screen" => self.screen_device = Some(device.to_string()),
            _ => {}
        }
        Ok(())
    }

    /// Which device each picker is currently pointed at.
    pub fn devices_selected(&self) -> (Option<String>, Option<String>, Option<String>) {
        (
            self.camera_device.clone(),
            self.mic_device.clone(),
            self.screen_device.clone(),
        )
    }

    /// Re-fit scene items after a video-settings change: camera placement
    /// and the overlay's full-frame bounds both derive from the base size.
    pub fn relayout(&mut self) {
        self.layout_camera();
        if let Some((item, _, _)) = self.overlay {
            let (bw, bh) = Self::base_size();
            unsafe {
                let bounds = ffi::vec2 { x: bw, y: bh };
                ffi::obs_sceneitem_set_bounds(item, &bounds);
            }
        }
    }

    /// Mic gain/mute. Values persist on the graph so toggling the mic off
    /// and on keeps the fader where the user left it.
    /// A/V sync offset for any source, in MILLISECONDS (positive delays the
    /// audio to meet late video). Guests arrive with audio and video on
    /// different paths and capture cards have their own fixed lag, so this is
    /// the same per-source correction OBS exposes — dialled in once, steady
    /// thereafter.
    pub fn set_sync_offset(&mut self, id: &str, ms: i64) -> Result<(), String> {
        let src = self
            .source_by_id(id)
            .ok_or_else(|| format!("{id} is not on the stage"))?;
        unsafe { ffi::obs_source_set_sync_offset(src, ms.clamp(-2000, 2000) * 1_000_000) };
        Ok(())
    }

    /// Cue: let the HOST hear a source that is not on air.
    ///
    /// MONITOR_ONLY is the load-bearing primitive for the green room. libobs
    /// gates monitor-only audio out inside obs-source.c BEFORE it is placed in
    /// the source's audio output, so it reaches no mix at all — not the
    /// stream, not the recording, not any track of a multi-track profile.
    /// Verified in source and empirically (see PRODUCER_TEST_MONITOR).
    pub fn set_cue(&mut self, id: &str, on: bool) -> Result<(), String> {
        let src = self
            .source_by_id(id)
            .ok_or_else(|| format!("{id} is not on the stage"))?;
        unsafe {
            // Cue implies audible: a muted source is silent everywhere,
            // monitoring included.
            ffi::obs_source_set_muted(src, false);
            ffi::obs_source_set_monitoring_type(src, if on { 1 } else { 0 });
            if !on {
                ffi::obs_source_set_muted(src, true);
            }
        }
        Ok(())
    }

    /// Volume/mute for ANY source, not just the mic — guests, media and
    /// overlays all reach the mix and all deserve a fader.
    pub fn set_source_audio(&mut self, id: &str, volume: Option<f32>, muted: Option<bool>) -> Result<(), String> {
        if id == "mic" {
            self.set_mic_audio(volume, muted);
            return Ok(());
        }
        let src = self
            .source_by_id(id)
            .ok_or_else(|| format!("{id} is not on the stage"))?;
        unsafe {
            if let Some(v) = volume {
                ffi::obs_source_set_volume(src, v.clamp(0.0, 1.0));
            }
            if let Some(m) = muted {
                ffi::obs_source_set_muted(src, m);
            }
        }
        Ok(())
    }

    pub fn set_mic_audio(&mut self, volume: Option<f32>, muted: Option<bool>) {
        if let Some(v) = volume {
            self.mic_volume = v.clamp(0.0, 1.0);
        }
        if let Some(m) = muted {
            self.mic_muted = m;
        }
        if let Some(src) = self.mic {
            unsafe {
                ffi::obs_source_set_volume(src, self.mic_volume);
                ffi::obs_source_set_muted(src, self.mic_muted);
            }
        }
    }
}

/// Peak absolute mic sample since the last call (0..=1), consumed on read —
/// the engine tick turns this into the meter event stream.
pub fn take_mic_peak() -> f64 {
    AUDIO_PEAK_MICRO.swap(0, Ordering::Relaxed) as f64 / 1_000_000.0
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


impl SceneGraph {
    /// Cheap gate: does any metered extra exist at all?
    pub fn take_extra_peaks_ids_empty(&self) -> bool {
        !self.extras.iter().any(|e| matches!(e.kind, "guest" | "media"))
    }

    /// Peak-and-reset for every metered extra since the last call, 0..=1.
    pub fn take_extra_peaks(&self) -> Vec<(String, f64)> {
        let mut out = Vec::new();
        for e in &self.extras {
            if !matches!(e.kind, "guest" | "media") {
                continue;
            }
            let key = e.src as usize;
            for (slot_src, slot_peak) in EXTRA_PEAKS.iter() {
                if slot_src.load(Ordering::Relaxed) == key {
                    let v = slot_peak.swap(0, Ordering::Relaxed) as f64 / 1_000_000.0;
                    out.push((e.id.clone(), v));
                }
            }
        }
        out
    }
}

pub const THUMB_W: u32 = 128;
pub const THUMB_H: u32 = 72;

impl SceneGraph {
    /// Live thumbnails of every GUEST source, visible or hidden — the panel
    /// shows who is actually on a feed before anyone reaches the stage. GPU
    /// render into a cached 128x72 target, staged back to RGBA rows.
    pub fn guest_thumbs(&mut self) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        unsafe {
            ffi::obs_enter_graphics();
            if self.thumb_rt.is_null() {
                self.thumb_rt = ffi::gs_texrender_create(ffi::GS_RGBA, ffi::GS_ZS_NONE);
            }
            if self.thumb_ss.is_null() {
                self.thumb_ss = ffi::gs_stagesurface_create(THUMB_W, THUMB_H, ffi::GS_RGBA);
            }
            if self.thumb_rt.is_null() || self.thumb_ss.is_null() {
                ffi::obs_leave_graphics();
                return out;
            }
            for e in &self.extras {
                if e.kind != "guest" || e.src.is_null() {
                    continue;
                }
                let sw = ffi::obs_source_get_width(e.src).max(1);
                let sh = ffi::obs_source_get_height(e.src).max(1);
                ffi::gs_texrender_reset(self.thumb_rt);
                if !ffi::gs_texrender_begin(self.thumb_rt, THUMB_W, THUMB_H) {
                    continue;
                }
                let clear = ffi::vec4 { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };
                ffi::gs_clear(1, &clear, 0.0, 0); // GS_CLEAR_COLOR
                ffi::gs_ortho(0.0, sw as f32, 0.0, sh as f32, -100.0, 100.0);
                ffi::obs_source_video_render(e.src);
                ffi::gs_texrender_end(self.thumb_rt);
                ffi::gs_stage_texture(self.thumb_ss, ffi::gs_texrender_get_texture(self.thumb_rt));
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut linesize: u32 = 0;
                if ffi::gs_stagesurface_map(self.thumb_ss, &mut data, &mut linesize) && !data.is_null() {
                    let mut rgba = Vec::with_capacity((THUMB_W * THUMB_H * 4) as usize);
                    for row in 0..THUMB_H {
                        let src_row = data.add((row * linesize) as usize);
                        rgba.extend_from_slice(std::slice::from_raw_parts(src_row, (THUMB_W * 4) as usize));
                    }
                    ffi::gs_stagesurface_unmap(self.thumb_ss);
                    out.push((e.id.clone(), rgba));
                }
            }
            ffi::obs_leave_graphics();
        }
        out
    }
}
