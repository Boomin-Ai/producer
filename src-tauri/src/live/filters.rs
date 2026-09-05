//! Source filters — the chain that turns a raw capture into something worth
//! watching, and a raw mic into something worth hearing.
//!
//! Filters attach per source and run in order, so this is a LIST with
//! identity, not a settings blob: each entry has a name (its identity in
//! libobs), a type, an enabled flag, and its own settings. Everything here
//! runs on the engine-owner thread (§5.1).

use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::ptr;

use serde_json::{Map, Value};

use super::ffi;

/// One filter in a source's chain, as the UI sees it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FilterState {
    /// Identity within the source — also the display name.
    pub name: String,
    /// libobs type id, e.g. "chroma_key_filter_v2".
    pub kind: String,
    pub enabled: bool,
    /// Current settings, flattened to JSON for the property forms.
    pub settings: Value,
}

struct EnumCtx {
    out: Vec<FilterState>,
}

/// Filters Producer attaches for its own machinery (scene fades) are named
/// with this prefix and hidden from the user's chain — they are transitions,
/// not something the user added.
pub const INTERNAL_PREFIX: &str = "__producer_";
pub const OPACITY_FILTER: &str = "__producer_opacity";

extern "C" fn collect(
    _parent: *mut ffi::obs_source_t,
    filter: *mut ffi::obs_source_t,
    param: *mut c_void,
) {
    let ctx = unsafe { &mut *(param as *mut EnumCtx) };
    unsafe {
        let name = ffi::obs_source_get_name(filter);
        let kind = ffi::obs_source_get_id(filter);
        if name.is_null() || kind.is_null() {
            return;
        }
        if CStr::from_ptr(name)
            .to_string_lossy()
            .starts_with(INTERNAL_PREFIX)
        {
            return;
        }
        ctx.out.push(FilterState {
            name: CStr::from_ptr(name).to_string_lossy().into_owned(),
            kind: CStr::from_ptr(kind).to_string_lossy().into_owned(),
            enabled: ffi::obs_source_enabled(filter),
            settings: settings_of(filter),
        });
    }
}

/// Read a filter's settings into JSON. libobs has no key iterator we bind, so
/// we read the keys the catalog knows about — which is exactly what the UI
/// renders anyway.
fn settings_of(filter: *mut ffi::obs_source_t) -> Value {
    let mut map = Map::new();
    unsafe {
        let kind_ptr = ffi::obs_source_get_id(filter);
        if kind_ptr.is_null() {
            return Value::Object(map);
        }
        let kind = CStr::from_ptr(kind_ptr).to_string_lossy().into_owned();
        let data = ffi::obs_source_get_settings(filter);
        if data.is_null() {
            return Value::Object(map);
        }
        for (key, ty) in known_keys(&kind) {
            let k = match CString::new(*key) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let v = match *ty {
                KeyType::Int => Value::from(ffi::obs_data_get_int(data, k.as_ptr())),
                KeyType::Double => Value::from(ffi::obs_data_get_double(data, k.as_ptr())),
                KeyType::Bool => Value::from(ffi::obs_data_get_bool(data, k.as_ptr())),
                KeyType::Text => {
                    let p = ffi::obs_data_get_string(data, k.as_ptr());
                    if p.is_null() {
                        Value::from("")
                    } else {
                        Value::from(CStr::from_ptr(p).to_string_lossy().into_owned())
                    }
                }
            };
            map.insert((*key).to_string(), v);
        }
        ffi::obs_data_release(data);
    }
    Value::Object(map)
}

#[derive(Clone, Copy)]
enum KeyType {
    Int,
    Double,
    Bool,
    Text,
}

/// The settings each supported filter carries. Kept in one place so the
/// reader and the writer can never disagree about a key's type.
fn known_keys(kind: &str) -> &'static [(&'static str, KeyType)] {
    match kind {
        "chroma_key_filter_v2" => &[
            ("key_color_type", KeyType::Text),
            ("key_color", KeyType::Int),
            ("similarity", KeyType::Int),
            ("smoothness", KeyType::Int),
            ("spill", KeyType::Int),
            ("opacity", KeyType::Int),
        ],
        "color_filter_v2" => &[
            ("brightness", KeyType::Double),
            ("contrast", KeyType::Double),
            ("saturation", KeyType::Double),
            ("hue_shift", KeyType::Double),
            ("gamma", KeyType::Double),
            ("opacity", KeyType::Double),
        ],
        "luma_key_filter_v2" => &[
            ("luma_max", KeyType::Double),
            ("luma_max_smooth", KeyType::Double),
            ("luma_min", KeyType::Double),
            ("luma_min_smooth", KeyType::Double),
        ],
        "sharpness_filter_v2" => &[("sharpness", KeyType::Double)],
        // Producer's own (shim-registered) Cutout: mode off|soft|cut, the
        // rest 0–1. See person_mask.m.
        "producer_person_mask" => &[
            ("mode", KeyType::Text),
            ("feather", KeyType::Double),
            ("erode", KeyType::Double),
            ("blur", KeyType::Double),
        ],
        "noise_suppress_filter_v2" => &[
            ("method", KeyType::Text),
            ("suppress_level", KeyType::Int),
            ("intensity", KeyType::Double),
        ],
        "noise_gate_filter" => &[
            ("open_threshold", KeyType::Double),
            ("close_threshold", KeyType::Double),
            ("attack_time", KeyType::Int),
            ("hold_time", KeyType::Int),
            ("release_time", KeyType::Int),
        ],
        "compressor_filter" => &[
            ("ratio", KeyType::Double),
            ("threshold", KeyType::Double),
            ("attack_time", KeyType::Int),
            ("release_time", KeyType::Int),
            ("output_gain", KeyType::Double),
        ],
        "limiter_filter" => &[
            ("threshold", KeyType::Double),
            ("release_time", KeyType::Int),
        ],
        "gain_filter" => &[("db", KeyType::Double)],
        _ => &[],
    }
}

/// Is this a type we expose? Anything else is refused rather than created
/// blind — an unknown filter would render with no properties.
pub fn is_supported(kind: &str) -> bool {
    !known_keys(kind).is_empty()
}

pub fn list(source: *mut ffi::obs_source_t) -> Vec<FilterState> {
    if source.is_null() {
        return Vec::new();
    }
    let mut ctx = EnumCtx { out: Vec::new() };
    unsafe {
        ffi::obs_source_enum_filters(source, collect, &mut ctx as *mut _ as *mut c_void);
    }
    ctx.out
}

/// Add a filter, named uniquely within the source so two of the same type
/// can coexist (two gains at different points is a real chain).
pub fn add(source: *mut ffi::obs_source_t, kind: &str, name: &str) -> Result<(), String> {
    if source.is_null() {
        return Err("that source is not on the stage".into());
    }
    if !is_supported(kind) {
        return Err(format!("unsupported filter {kind}"));
    }
    unsafe {
        let cname = CString::new(name).map_err(|_| "bad filter name")?;
        if !ffi::obs_source_get_filter_by_name(source, cname.as_ptr()).is_null() {
            return Err(format!("{name} is already on this source"));
        }
        let ckind = CString::new(kind).map_err(|_| "bad filter kind")?;
        // Default settings: NULL lets libobs fill its own, which is what the
        // filter's author considered sane.
        let f = ffi::obs_source_create_private(ckind.as_ptr(), cname.as_ptr(), ptr::null_mut());
        if f.is_null() {
            return Err(format!("{kind} isn't available in this engine"));
        }
        ffi::obs_source_filter_add(source, f);
        ffi::obs_source_release(f);
    }
    Ok(())
}

pub fn remove(source: *mut ffi::obs_source_t, name: &str) -> Result<(), String> {
    unsafe {
        let cname = CString::new(name).map_err(|_| "bad filter name")?;
        let f = ffi::obs_source_get_filter_by_name(source, cname.as_ptr());
        if f.is_null() {
            return Err(format!("no filter named {name}"));
        }
        ffi::obs_source_filter_remove(source, f);
        ffi::obs_source_release(f);
    }
    Ok(())
}

pub fn set_enabled(source: *mut ffi::obs_source_t, name: &str, on: bool) -> Result<(), String> {
    unsafe {
        let cname = CString::new(name).map_err(|_| "bad filter name")?;
        let f = ffi::obs_source_get_filter_by_name(source, cname.as_ptr());
        if f.is_null() {
            return Err(format!("no filter named {name}"));
        }
        ffi::obs_source_set_enabled(f, on);
        ffi::obs_source_release(f);
    }
    Ok(())
}

/// movement: 0 up, 1 down, 2 top, 3 bottom.
pub fn reorder(source: *mut ffi::obs_source_t, name: &str, movement: i32) -> Result<(), String> {
    unsafe {
        let cname = CString::new(name).map_err(|_| "bad filter name")?;
        let f = ffi::obs_source_get_filter_by_name(source, cname.as_ptr());
        if f.is_null() {
            return Err(format!("no filter named {name}"));
        }
        ffi::obs_source_filter_set_order(source, f, movement);
        ffi::obs_source_release(f);
    }
    Ok(())
}

/// Apply a patch of settings. Only keys the catalog knows are written, with
/// the type the catalog declares — a slider can never corrupt a filter.
pub fn update(source: *mut ffi::obs_source_t, name: &str, patch: &Value) -> Result<(), String> {
    let obj = patch.as_object().ok_or("settings must be an object")?;
    unsafe {
        let cname = CString::new(name).map_err(|_| "bad filter name")?;
        let f = ffi::obs_source_get_filter_by_name(source, cname.as_ptr());
        if f.is_null() {
            return Err(format!("no filter named {name}"));
        }
        let kind_ptr = ffi::obs_source_get_id(f);
        let kind = if kind_ptr.is_null() {
            String::new()
        } else {
            CStr::from_ptr(kind_ptr).to_string_lossy().into_owned()
        };
        let data = ffi::obs_data_create();
        for (key, ty) in known_keys(&kind) {
            let Some(v) = obj.get(*key) else { continue };
            let Ok(k) = CString::new(*key) else { continue };
            match ty {
                KeyType::Int => {
                    if let Some(n) = v.as_i64() {
                        ffi::obs_data_set_int(data, k.as_ptr(), n);
                    }
                }
                KeyType::Double => {
                    if let Some(n) = v.as_f64() {
                        ffi::obs_data_set_double(data, k.as_ptr(), n);
                    }
                }
                KeyType::Bool => {
                    if let Some(b) = v.as_bool() {
                        ffi::obs_data_set_bool(data, k.as_ptr(), b);
                    }
                }
                KeyType::Text => {
                    if let Some(t) = v.as_str() {
                        if let Ok(cv) = CString::new(t) {
                            ffi::obs_data_set_string(data, k.as_ptr(), cv.as_ptr());
                        }
                    }
                }
            }
        }
        ffi::obs_source_update(f, data);
        ffi::obs_data_release(data);
        ffi::obs_source_release(f);
    }
    Ok(())
}

/// Set an item's opacity (0.0–1.0) for scene fades.
///
/// libobs scene items have NO opacity of their own — OBS itself fades by
/// animating a colour-correction filter, which is what this does. The filter
/// is created on first use, named with the internal prefix so it never shows
/// up in the user's filter list, and left attached (it is inert at 1.0).
pub fn set_opacity(source: *mut ffi::obs_source_t, opacity: f64) -> Result<(), String> {
    if source.is_null() {
        return Err("no such source".into());
    }
    let clamped = opacity.clamp(0.0, 1.0);
    unsafe {
        let name = CString::new(OPACITY_FILTER).unwrap();
        let mut f = ffi::obs_source_get_filter_by_name(source, name.as_ptr());
        if f.is_null() {
            let kind = CString::new("color_filter_v2").unwrap();
            let created =
                ffi::obs_source_create_private(kind.as_ptr(), name.as_ptr(), ptr::null_mut());
            if created.is_null() {
                return Err("opacity needs obs-filters in the engine".into());
            }
            ffi::obs_source_filter_add(source, created);
            // filter_add retains it; keep our own reference for the update
            // below and release once at the end.
            f = created;
        }
        let data = ffi::obs_data_create();
        ffi::obs_data_set_double(data, CString::new("opacity").unwrap().as_ptr(), clamped);
        ffi::obs_source_update(f, data);
        ffi::obs_data_release(data);
        ffi::obs_source_release(f);
    }
    Ok(())
}
