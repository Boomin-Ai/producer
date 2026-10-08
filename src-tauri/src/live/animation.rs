//! Bounded animation tracks. Native clocks use monotonic time; browser surfaces
//! receive the equivalent UTC anchor and evaluate locally, without frame IPC.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClockSpec {
    pub running: bool,
    pub position_ms: f64,
    pub segment_ms: f64,
    pub anchor_ms: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Keyframe {
    pub at_ms: f64,
    pub value: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Track {
    pub target: String,
    pub property: String,
    pub keyframes: Vec<Keyframe>,
    #[serde(default)]
    pub easing: Option<String>,
    #[serde(default)]
    pub clock: Option<String>,
    #[serde(default)]
    pub delay_ms: Option<f64>,
    #[serde(default)]
    pub r#loop: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Transition {
    pub r#type: String,
    pub duration_ms: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Timeline {
    pub clock: ClockSpec,
    pub tracks: Vec<Track>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<Transition>,
}
pub fn utc_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
pub fn sample(track: &Track, position: f64) -> f64 {
    let frames = &track.keyframes;
    let duration = frames.last().unwrap().at_ms;
    let mut time = (position - track.delay_ms.unwrap_or(0.)).max(0.);
    if track.r#loop.as_deref() == Some("repeat") {
        time %= duration;
    } else if track.r#loop.as_deref() == Some("pingpong") {
        time %= duration * 2.;
        if time > duration {
            time = duration * 2. - time;
        }
    }
    if time >= duration {
        return frames.last().unwrap().value;
    }
    let index = frames
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, f)| f.at_ms >= time)
        .unwrap()
        .0;
    let a = &frames[index - 1];
    let b = &frames[index];
    let mut t = (time - a.at_ms) / (b.at_ms - a.at_ms);
    match track.easing.as_deref().unwrap_or("easeInOut") {
        "easeIn" => t *= t,
        "easeOut" => t = 1. - (1. - t) * (1. - t),
        "easeInOut" => t = t * t * (3. - 2. * t),
        _ => {}
    }
    a.value + (b.value - a.value) * t
}
impl Timeline {
    pub fn validate(&self, root: &super::presentation::Node) -> Result<(), String> {
        let c = &self.clock;
        if ![c.position_ms, c.segment_ms, c.anchor_ms]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.)
            || c.position_ms > 86_400_000.
            || c.segment_ms > 86_400_000.
            || self.tracks.len() > 32
        {
            return Err("Invalid animation clock or track budget".into());
        }
        fn find<'a>(
            n: &'a super::presentation::Node,
            id: &str,
        ) -> Option<&'a super::presentation::Node> {
            if n.id == id {
                Some(n)
            } else {
                n.children.iter().find_map(|c| find(c, id))
            }
        }
        fn has_slot(n: &super::presentation::Node) -> bool {
            n.slot_id.is_some() || n.shader.is_some() || n.children.iter().any(has_slot)
        }
        let mut seen = std::collections::HashSet::new();
        for t in &self.tracks {
            let node = find(root, &t.target).ok_or("Animation target is missing")?;
            if !seen.insert((&t.target, &t.property))
                || !matches!(
                    t.property.as_str(),
                    "x" | "y"
                        | "width"
                        | "height"
                        | "opacity"
                        | "scale"
                        | "rotation"
                        | "shader.intensity"
                        | "shader.scale"
                )
                || t.keyframes.len() < 2
                || t.keyframes.len() > 16
                || t.keyframes[0].at_ms != 0.
            {
                return Err("Invalid animation track".into());
            }
            if node.slot_id.is_none() && node.shader.is_none() && has_slot(node) {
                return Err("Animate native layers directly, not their ancestors".into());
            }
            if t.property.starts_with("shader.")
                && (node.shader.is_none()
                    || t.keyframes.iter().any(|f| {
                        if t.property == "shader.intensity" {
                            !(0.0..=2.0).contains(&f.value)
                        } else {
                            !(0.25..=4.0).contains(&f.value)
                        }
                    }))
            {
                return Err("Invalid shader parameter track".into());
            }
            if matches!(t.property.as_str(), "x" | "y" | "width" | "height")
                && node
                    .styles
                    .get("position")
                    .and_then(serde_json::Value::as_str)
                    != Some("absolute")
            {
                return Err("Animation geometry requires absolute placement".into());
            }
            if node.slot_id.is_some()
                && matches!(t.property.as_str(), "x" | "y")
                && node
                    .styles
                    .get(if t.property == "x" { "left" } else { "top" })
                    .and_then(serde_json::Value::as_f64)
                    .is_none()
            {
                return Err("Native source tracks require numeric position".into());
            }
            for (i, f) in t.keyframes.iter().enumerate() {
                if !f.at_ms.is_finite()
                    || f.at_ms < 0.
                    || f.at_ms > 60_000.
                    || i > 0 && f.at_ms <= t.keyframes[i - 1].at_ms
                    || !f.value.is_finite()
                    || f.value.abs() > 3840.
                    || t.property == "opacity" && !(0.0..=1.0).contains(&f.value)
                    || t.property == "scale" && !(0.05..=8.0).contains(&f.value)
                    || matches!(t.property.as_str(), "width" | "height") && f.value < 1.
                {
                    return Err("Animation keyframe exceeds bounds".into());
                }
            }
            if t.delay_ms
                .is_some_and(|v| !v.is_finite() || !(0.0..=60_000.0).contains(&v))
                || t.easing
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "linear" | "easeIn" | "easeOut" | "easeInOut"))
                || t.clock
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "segment" | "show"))
                || t.r#loop
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "none" | "repeat" | "pingpong"))
            {
                return Err("Unsupported animation timing".into());
            }
        }
        if self.transition.as_ref().is_some_and(|t| {
            !matches!(t.r#type.as_str(), "cut" | "crossfade" | "morph")
                || !t.duration_ms.is_finite()
                || !(0.0..=2000.0).contains(&t.duration_ms)
        }) {
            return Err("Invalid animation transition".into());
        }
        Ok(())
    }
}
struct Clock {
    running: bool,
    position: f64,
    anchor: Instant,
}
impl Clock {
    fn new(c: &ClockSpec) -> Self {
        Self {
            running: c.running,
            position: c.position_ms
                + if c.running {
                    (utc_ms() - c.anchor_ms).max(0.)
                } else {
                    0.
                },
            anchor: Instant::now(),
        }
    }
    fn position(&self) -> f64 {
        self.position
            + if self.running {
                self.anchor.elapsed().as_secs_f64() * 1000.
            } else {
                0.
            }
    }
}
type SharedClock = Arc<Mutex<Clock>>;
fn shared(lease: &str, c: &ClockSpec) -> SharedClock {
    static CLOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<Clock>>>>> = OnceLock::new();
    let mut clocks = CLOCKS.get_or_init(Default::default).lock().unwrap();
    clocks.retain(|_, v| v.strong_count() > 0);
    if let Some(clock) = clocks.get(lease).and_then(Weak::upgrade) {
        return clock;
    }
    let clock = Arc::new(Mutex::new(Clock::new(c)));
    clocks.insert(lease.into(), Arc::downgrade(&clock));
    clock
}
pub fn fill_crop(sw: f64, sh: f64, w: f64, h: f64, x: f64, y: f64) -> serde_json::Value {
    let ratio = w / h;
    let (cw, ch) = if sw / sh > ratio {
        (sh * ratio, sh)
    } else {
        (sw, sw / ratio)
    };
    let dx = (sw - cw).max(0.).floor() as i32;
    let dy = (sh - ch).max(0.).floor() as i32;
    let left = (dx as f64 * x).round() as i32;
    let top = (dy as f64 * y).round() as i32;
    serde_json::json!({"relative":true,"left":left,"right":dx-left,"top":top,"bottom":dy-top})
}
#[cfg(have_engine)]
unsafe fn update_filter(
    source: *mut super::ffi::obs_source_t,
    name: &str,
    values: &serde_json::Value,
) {
    let filter = super::ffi::obs_source_get_filter_by_name(
        source,
        std::ffi::CString::new(name).unwrap().as_ptr(),
    );
    if filter.is_null() {
        return;
    }
    let data = super::ffi::obs_data_create_from_json(
        std::ffi::CString::new(values.to_string()).unwrap().as_ptr(),
    );
    super::ffi::obs_source_update(filter, data);
    super::ffi::obs_data_release(data);
    super::ffi::obs_source_release(filter);
}
#[cfg(have_engine)]
#[derive(Clone)]
pub struct Target {
    pub id: String,
    pub item: *mut super::ffi::obs_sceneitem_t,
    pub source: *mut super::ffi::obs_source_t,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub local_x: f32,
    pub local_y: f32,
    pub scale: f32,
    pub last: Option<[f32; 6]>,
    pub last_opacity: Option<f64>,
    pub shader: Option<super::shaders::ShaderEffect>,
    pub last_shader: Option<[f32; 4]>,
    pub capture: *mut super::ffi::obs_source_t,
    pub framing: Option<super::presentation::Framing>,
    pub appearance: Option<serde_json::Value>,
}
#[cfg(have_engine)]
struct RenderState {
    clock: SharedClock,
    timeline: Timeline,
    origin: f64,
    targets: Vec<Target>,
    enabled: bool,
    fade: bool,
    scene: *mut super::ffi::obs_source_t,
    last_alpha: f64,
}
#[cfg(have_engine)]
extern "C" fn render(data: *mut std::ffi::c_void, _: u32, _: u32) {
    unsafe {
        use super::ffi;
        let store = &*(data as *const Mutex<RenderState>);
        let Ok(mut state) = store.try_lock() else {
            return;
        };
        if !state.enabled {
            return;
        }
        let position = state.clock.lock().unwrap().position();
        let segment = (position - state.origin).max(0.);
        let RenderState {
            targets, timeline, ..
        } = &mut *state;
        for target in targets {
            let (mut x, mut y, mut w, mut h, mut scale, mut rotation, mut opacity) =
                (target.x, target.y, target.width, target.height, 1., 0., 1.);
            let (mut intensity, mut frequency) = (
                target.shader.as_ref().map_or(1., |s| s.intensity as f32),
                target.shader.as_ref().map_or(1., |s| s.scale as f32),
            );
            for track in timeline.tracks.iter().filter(|t| t.target == target.id) {
                let v = sample(
                    track,
                    if track.clock.as_deref() == Some("show") {
                        position
                    } else {
                        segment
                    },
                ) as f32;
                match track.property.as_str() {
                    "x" => x = target.x + (v - target.local_x) * target.scale,
                    "y" => y = target.y + (v - target.local_y) * target.scale,
                    "width" => w = v * target.scale,
                    "height" => h = v * target.scale,
                    "scale" => scale = v,
                    "rotation" => rotation = v,
                    "opacity" => opacity = v,
                    "shader.intensity" => intensity = v,
                    "shader.scale" => frequency = v,
                    _ => {}
                }
            }
            let extent_changed = target.last.is_none_or(|last| {
                (last[2] - w * scale).abs() > 0.1 || (last[3] - h * scale).abs() > 0.1
            });
            if extent_changed {
                if target.shader.is_some() {
                    ffi::producer_shader_extent(target.source, w / target.scale, h / target.scale);
                } else {
                    if let Some(f) = &target.framing {
                        if f.mode == "fill" && !target.capture.is_null() {
                            let sw = ffi::obs_source_get_width(target.capture) as f64;
                            let sh = ffi::obs_source_get_height(target.capture) as f64;
                            if sw > 0. && sh > 0. && w > 0. && h > 0. {
                                let crop = fill_crop(sw, sh, w as f64, h as f64, f.x, f.y);
                                update_filter(target.source, "Set framing", &crop);
                            }
                        }
                    }
                    if let Some(a) = &target.appearance {
                        let mut values = a.clone();
                        if let Some(obj) = values.as_object_mut() {
                            obj.insert("displayWidth".into(), serde_json::json!(w / target.scale));
                            obj.insert("displayHeight".into(), serde_json::json!(h / target.scale));
                            update_filter(target.source, "Set slot appearance", &values);
                        }
                    }
                }
            }
            let geometry = [x, y, w * scale, h * scale, rotation, opacity];
            if target.last != Some(geometry) {
                ffi::obs_sceneitem_set_pos(target.item, &ffi::vec2 { x, y });
                ffi::obs_sceneitem_set_bounds(
                    target.item,
                    &ffi::vec2 {
                        x: w * scale,
                        y: h * scale,
                    },
                );
                ffi::obs_sceneitem_set_rot(target.item, rotation);
                target.last = Some(geometry);
            }
            if let Some(shader) = &target.shader {
                let values = [
                    (if shader.clock == "show" {
                        position
                    } else {
                        segment
                    } / 1000.) as f32,
                    intensity,
                    frequency,
                    opacity * shader.opacity as f32,
                ];
                if target.last_shader != Some(values) {
                    ffi::producer_shader_frame(
                        target.source,
                        values[0],
                        values[1],
                        values[2],
                        values[3],
                    );
                    target.last_shader = Some(values);
                }
            } else if timeline
                .tracks
                .iter()
                .any(|t| t.target == target.id && t.property == "opacity")
                && target.last_opacity != Some(opacity as f64)
            {
                let _ = super::filters::set_opacity(target.source, opacity as f64);
                target.last_opacity = Some(opacity as f64);
            }
        }
        if state.fade {
            let duration = state
                .timeline
                .transition
                .as_ref()
                .map_or(0., |t| t.duration_ms);
            let alpha = if duration > 0. {
                (segment / duration).clamp(0., 1.)
            } else {
                1.
            };
            if (alpha - state.last_alpha).abs() > 0.0001 {
                let _ = super::filters::set_opacity(state.scene, alpha);
                state.last_alpha = alpha;
            }
        }
    }
}
#[cfg(have_engine)]
pub struct Animator {
    state: Box<Mutex<RenderState>>,
}
#[cfg(have_engine)]
impl Animator {
    pub unsafe fn new(
        lease: &str,
        timeline: Timeline,
        scene: *mut super::ffi::obs_source_t,
        targets: Vec<Target>,
    ) -> Result<Self, String> {
        if timeline
            .transition
            .as_ref()
            .is_some_and(|t| t.r#type == "crossfade")
        {
            super::filters::set_opacity(scene, 1.)?;
        }
        for target in &targets {
            if target.shader.is_none()
                && timeline
                    .tracks
                    .iter()
                    .any(|t| t.target == target.id && t.property == "opacity")
            {
                super::filters::set_opacity(target.source, 1.)?;
            }
        }
        let clock = shared(lease, &timeline.clock);
        let origin = timeline.clock.position_ms - timeline.clock.segment_ms;
        let mut result = Self {
            state: Box::new(Mutex::new(RenderState {
                clock,
                timeline,
                origin,
                targets,
                enabled: false,
                fade: false,
                scene,
                last_alpha: 1.,
            })),
        };
        super::ffi::obs_add_main_render_callback(render, &mut *result.state as *mut _ as *mut _);
        Ok(result)
    }
    pub fn activate(&self, fade: bool) {
        let mut state = self.state.lock().unwrap();
        *state.clock.lock().unwrap() = Clock::new(&state.timeline.clock);
        state.origin = state.timeline.clock.position_ms - state.timeline.clock.segment_ms;
        state.enabled = true;
        state.fade = fade;
        state.last_alpha = -1.;
    }
    pub fn prepare(&self, timeline: Timeline) {
        let mut state = self.state.lock().unwrap();
        state.origin = timeline.clock.position_ms - timeline.clock.segment_ms;
        state.timeline = timeline;
    }
    pub fn retarget(&self, projection: &super::presentation::Projection) {
        let nodes: HashMap<_, _> = projection
            .root
            .children
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();
        let mut state = self.state.lock().unwrap();
        for target in &mut state.targets {
            if let Some(n) = nodes.get(target.id.as_str()) {
                let get = |key: &str| {
                    n.styles
                        .get(key)
                        .and_then(serde_json::Value::as_f64)
                        .unwrap() as f32
                };
                let ox = target.x - target.local_x * target.scale;
                let oy = target.y - target.local_y * target.scale;
                target.local_x = get("left");
                target.local_y = get("top");
                target.x = ox + target.local_x * target.scale;
                target.y = oy + target.local_y * target.scale;
                target.width = get("width") * target.scale;
                target.height = get("height") * target.scale;
            }
        }
    }
    pub fn update(&self, timeline: Timeline) {
        let mut state = self.state.lock().unwrap();
        *state.clock.lock().unwrap() = Clock::new(&timeline.clock);
        state.origin = timeline.clock.position_ms - timeline.clock.segment_ms;
        state.timeline = timeline;
    }
    pub fn finished(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.fade
            || state.clock.lock().unwrap().position() - state.origin
                >= state
                    .timeline
                    .transition
                    .as_ref()
                    .map_or(0., |t| t.duration_ms)
    }
    pub fn finish(&self) {
        let mut state = self.state.lock().unwrap();
        state.fade = false;
        let _ = super::filters::set_opacity(state.scene, 1.);
        state.last_alpha = 1.;
    }
}
#[cfg(have_engine)]
impl Drop for Animator {
    fn drop(&mut self) {
        unsafe {
            super::ffi::obs_remove_main_render_callback(
                render,
                &mut *self.state as *mut _ as *mut _,
            );
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn track() -> Track {
        Track {
            target: "host".into(),
            property: "x".into(),
            keyframes: vec![
                Keyframe {
                    at_ms: 0.,
                    value: 0.,
                },
                Keyframe {
                    at_ms: 1000.,
                    value: 100.,
                },
            ],
            easing: Some("linear".into()),
            clock: None,
            delay_ms: None,
            r#loop: None,
        }
    }
    #[test]
    fn crop_follows_resizing_camera_aspect() {
        let square = fill_crop(1920., 1080., 248., 248., 0.5, 0.5);
        assert_eq!(square["left"], 420);
        assert_eq!(square["right"], 420);
        let tall = fill_crop(1920., 1080., 640., 552., 0.5, 0.5);
        let cropped = 1920. - tall["left"].as_f64().unwrap() - tall["right"].as_f64().unwrap();
        assert!((cropped / 1080. - 640. / 552.).abs() < 0.002);
        let wide = fill_crop(1920., 1080., 640., 300., 0.5, 0.5);
        assert!(wide["top"].as_i64().unwrap() > 0);
        assert_eq!(wide["left"], 0);
    }
    #[test]
    fn bounded_sampling() {
        let mut t = track();
        assert_eq!(sample(&t, 500.), 50.);
        assert_eq!(sample(&t, 2000.), 100.);
        t.r#loop = Some("pingpong".into());
        assert_eq!(sample(&t, 1500.), 50.);
        t.delay_ms = Some(500.);
        assert_eq!(sample(&t, 250.), 0.);
    }
    #[test]
    fn paused_monotonic_clock() {
        let c = Clock::new(&ClockSpec {
            running: false,
            position_ms: 123.,
            segment_ms: 23.,
            anchor_ms: 0.,
        });
        assert_eq!(c.position(), 123.);
    }
}
