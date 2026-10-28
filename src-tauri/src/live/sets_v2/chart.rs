use super::{super::ffi, contract};
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, CString};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: Option<f64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Data {
    pub scope: String,
    pub points: Vec<Point>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Spec {
    pub id: String,
    pub kind: String,
    pub data: Data,
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub color: String,
    pub grid_color: String,
    pub duration_ms: f32,
    pub line_width: f32,
    pub fill_opacity: f32,
}
pub fn validate(s: &Spec) -> Result<(), String> {
    let hex = |s: &str| {
        (s.len() == 7 || s.len() == 9)
            && s.starts_with('#')
            && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
    };
    if !contract::identity(&s.id)
        || !["line", "area", "bar"].contains(&s.kind.as_str())
        || s.data.scope.len() > 120
        || s.data.scope.contains('\0')
        || s.data.points.len() > 256
        || !hex(&s.color)
        || !hex(&s.grid_color)
        || ![s.x_min, s.x_max, s.y_min, s.y_max]
            .iter()
            .all(|v| v.is_finite())
        || s.x_min >= s.x_max
        || s.y_min >= s.y_max
        || s.x_min.abs() > 1e15
        || s.x_max.abs() > 1e15
        || s.y_min.abs() > 2e6
        || s.y_max.abs() > 2e6
        || !s.duration_ms.is_finite()
        || !(0. ..=2000.).contains(&s.duration_ms)
        || !s.line_width.is_finite()
        || !(1. ..=8.).contains(&s.line_width)
        || !s.fill_opacity.is_finite()
        || !(0. ..=0.5).contains(&s.fill_opacity)
    {
        return Err("Invalid native chart".into());
    }
    for (i, p) in s.data.points.iter().enumerate() {
        if !p.x.is_finite()
            || p.x.abs() > 1e15
            || p.y.is_some_and(|y| !y.is_finite() || y.abs() > 1e6)
            || i > 0 && p.x <= s.data.points[i - 1].x
        {
            return Err("Invalid native chart points".into());
        }
    }
    Ok(())
}
#[repr(C)]
struct NativePoint {
    x: f64,
    y: f64,
    valid: bool,
}
#[repr(C)]
struct NativeSpec {
    id: *const c_char,
    scope: *const c_char,
    kind: i32,
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    color: u32,
    grid_color: u32,
    duration_ms: f32,
    line_width: f32,
    fill_opacity: f32,
    points: *const NativePoint,
    count: usize,
}
extern "C" {
    fn producer_chart_create(w: u32, h: u32, s: *const NativeSpec) -> *mut ffi::obs_source_t;
}
pub unsafe fn create(s: &Spec, w: f32, h: f32) -> Result<*mut ffi::obs_source_t, String> {
    validate(s)?;
    if !w.is_finite() || !h.is_finite() || w < 1. || h < 1. || w > 4096. || h > 4096. {
        return Err("Chart geometry exceeds budget".into());
    }
    let id = CString::new(s.id.as_str()).map_err(|_| "Invalid chart ID")?;
    let scope = CString::new(s.data.scope.as_str()).map_err(|_| "Invalid chart scope")?;
    let points: Vec<_> = s
        .data
        .points
        .iter()
        .map(|p| NativePoint {
            x: p.x,
            y: p.y.unwrap_or(0.),
            valid: p.y.is_some(),
        })
        .collect();
    let color = |v: &str| {
        let text = &v[1..];
        let a = if text.len() == 8 {
            u32::from_str_radix(&text[6..8], 16).unwrap_or(255)
        } else {
            255
        };
        let r = u32::from_str_radix(&text[0..2], 16).unwrap_or(0);
        let g = u32::from_str_radix(&text[2..4], 16).unwrap_or(0);
        let b = u32::from_str_radix(&text[4..6], 16).unwrap_or(0);
        r | (g << 8) | (b << 16) | (a << 24)
    };
    let spec = NativeSpec {
        id: id.as_ptr(),
        scope: scope.as_ptr(),
        kind: match s.kind.as_str() {
            "area" => 1,
            "bar" => 2,
            _ => 0,
        },
        x_min: s.x_min,
        x_max: s.x_max,
        y_min: s.y_min,
        y_max: s.y_max,
        color: color(&s.color),
        grid_color: color(&s.grid_color),
        duration_ms: s.duration_ms,
        line_width: s.line_width,
        fill_opacity: s.fill_opacity,
        points: points.as_ptr(),
        count: points.len(),
    };
    let source = producer_chart_create(w.ceil() as u32, h.ceil() as u32, &spec);
    if source.is_null() {
        Err("Native chart allocation failed".into())
    } else {
        Ok(source)
    }
}
