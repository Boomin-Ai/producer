//! Opt-in dev-room adapter. No v1 conversion and no production registration.
pub mod contract;
use super::ffi;
use contract::{Action, Node, Plan, Status};
use std::{
    collections::HashMap,
    ffi::{c_char, CStr, CString},
    ptr,
};
#[repr(C)]
struct NativeNode {
    id: *const c_char,
    kind: i32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
    opacity: f32,
    visible: bool,
    fit: i32,
    surface: *mut ffi::obs_source_t,
    children: *const NativeNode,
    child_count: usize,
}
#[repr(C)]
#[derive(Default)]
struct NativeStatus {
    prepared_revision: u64,
    rendered_revision: u64,
    render_serial: u64,
    clock_ms: f64,
    transition_progress: f64,
    warmed: bool,
    ready: bool,
    queued: bool,
    transitioning: bool,
    paused: bool,
}
enum NativeScene {}
extern "C" {
    fn producer_set_v2_register();
    fn producer_set_v2_program_register();
    fn producer_set_v2_transition_register();
    fn producer_set_v2_group_create(w: u32, h: u32, r: f32, o: f32) -> *mut ffi::obs_source_t;
    fn producer_set_v2_group_add(
        g: *mut ffi::obs_source_t,
        s: *mut ffi::obs_source_t,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        contain: bool,
    ) -> bool;
    fn producer_set_v2_group_seal(g: *mut ffi::obs_source_t) -> bool;
    fn producer_set_v2_scene_prepare(
        root: *const NativeNode,
        w: u32,
        h: u32,
        fit: i32,
        budget: usize,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut NativeScene;
    fn producer_set_v2_scene_source(scene: *mut NativeScene) -> *mut ffi::obs_source_t;
    fn producer_set_v2_scene_release(scene: *mut NativeScene);
    fn producer_set_v2_program_create(w: u32, h: u32) -> *mut ffi::obs_source_t;
    fn producer_set_v2_program_prepare(
        p: *mut ffi::obs_source_t,
        c: *mut ffi::obs_source_t,
        r: u64,
    ) -> bool;
    fn producer_set_v2_program_ready(p: *mut ffi::obs_source_t, r: u64) -> bool;
    fn producer_set_v2_program_take(p: *mut ffi::obs_source_t, r: u64, d: f64, mode: i32) -> bool;
    fn producer_set_v2_program_cancel(p: *mut ffi::obs_source_t, r: u64) -> bool;
    fn producer_set_v2_program_pause(p: *mut ffi::obs_source_t, paused: bool) -> bool;
    fn producer_set_v2_program_status(p: *mut ffi::obs_source_t, out: *mut NativeStatus) -> bool;
    fn producer_set_v2_program_collect(p: *mut ffi::obs_source_t) -> bool;
    fn producer_set_v2_surface_marker(
        s: *mut ffi::obs_source_t,
        x: u32,
        y: u32,
        r: u8,
        g: u8,
        b: u8,
    ) -> bool;
}
pub unsafe fn register() {
    producer_set_v2_register();
    producer_set_v2_transition_register();
    producer_set_v2_program_register();
}
struct Source(*mut ffi::obs_source_t);
impl Drop for Source {
    fn drop(&mut self) {
        unsafe { ffi::obs_source_release(self.0) }
    }
}
struct Draft {
    revision: u64,
    scene: *mut NativeScene,
    markers: Vec<(Source, u32)>,
}
impl Drop for Draft {
    fn drop(&mut self) {
        unsafe { producer_set_v2_scene_release(self.scene) }
    }
}
struct Arena {
    ids: Vec<CString>,
    children: Vec<Box<[NativeNode]>>,
    sources: Vec<Source>,
    markers: Vec<(Source, u32)>,
    browser_pixels: usize,
}
impl Arena {
    fn new() -> Self {
        Self {
            ids: Vec::new(),
            children: Vec::new(),
            sources: Vec::new(),
            markers: Vec::new(),
            browser_pixels: 0,
        }
    }
    unsafe fn graphics(
        &mut self,
        nodes: &[&Node],
        palette: &HashMap<String, String>,
    ) -> Result<NativeNode, String> {
        let x = nodes
            .iter()
            .map(|n| n.bounds.x)
            .fold(f32::INFINITY, f32::min)
            .floor();
        let y = nodes
            .iter()
            .map(|n| n.bounds.y)
            .fold(f32::INFINITY, f32::min)
            .floor();
        let w = (nodes
            .iter()
            .map(|n| n.bounds.x + n.bounds.width)
            .fold(f32::NEG_INFINITY, f32::max)
            .ceil()
            - x)
            .max(1.) as u32;
        let h = (nodes
            .iter()
            .map(|n| n.bounds.y + n.bounds.height)
            .fold(f32::NEG_INFINITY, f32::max)
            .ceil()
            - y)
            .max(1.) as u32;
        let pixels = (w as usize) * (h as usize + 1);
        if w > 8192
            || h >= 8192
            || pixels > 4096 * 4096
            || self.browser_pixels + pixels > 8 * 1024 * 1024
            || self.markers.len() >= 16
        {
            return Err("V2 graphics surface budget exceeded".into());
        }
        self.browser_pixels += pixels;
        let html = contract::graphics_document(nodes, w, h, (x, y), palette)?;
        let url = format!(
            "data:text/html;charset=utf-8,{}",
            html.as_bytes()
                .iter()
                .map(|c| format!("%{c:02X}"))
                .collect::<String>()
        );
        let config = serde_json::json!({"url":url,"is_local_file":false,"css":"","width":w,"height":h+1,"fps":30,"fps_custom":true,"shutdown":false,"reroute_audio":true,"webpage_control_level":0});
        let settings =
            ffi::obs_data_create_from_json(CString::new(config.to_string()).unwrap().as_ptr());
        if settings.is_null() {
            return Err("V2 graphics settings allocation failed".into());
        }
        let browser = ffi::obs_source_create_private(
            c"browser_source".as_ptr(),
            c"V2 graphics batch".as_ptr(),
            settings,
        );
        ffi::obs_data_release(settings);
        if browser.is_null() {
            return Err("V2 browser surface allocation failed".into());
        }
        let browser = Source(browser);
        ffi::obs_source_set_audio_mixers(browser.0, 0);
        let clip = producer_set_v2_group_create(w, h, 0., 1.);
        if clip.is_null() {
            return Err("V2 graphics crop allocation failed".into());
        }
        let clip = Source(clip);
        if !producer_set_v2_group_add(clip.0, browser.0, 0., 0., w as f32, (h + 1) as f32, false)
            || !producer_set_v2_group_seal(clip.0)
        {
            return Err("V2 graphics crop attachment failed".into());
        }
        let surface = clip.0;
        self.sources.push(clip);
        self.markers.push((browser, h));
        self.ids
            .push(CString::new(format!("graphics-{}", self.markers.len())).unwrap());
        Ok(NativeNode {
            id: self.ids.last().unwrap().as_ptr(),
            kind: 1,
            x,
            y,
            width: w as f32,
            height: h as f32,
            radius: 0.,
            opacity: 1.,
            visible: true,
            fit: 0,
            surface,
            children: ptr::null(),
            child_count: 0,
        })
    }
    unsafe fn node(
        &mut self,
        n: &Node,
        palette: &HashMap<String, String>,
        resolve: &mut impl FnMut(&str) -> Result<*mut ffi::obs_source_t, String>,
    ) -> Result<NativeNode, String> {
        self.ids
            .push(CString::new(n.id.clone()).map_err(|_| "Invalid v2 identity")?);
        let mut out = NativeNode {
            id: self.ids.last().unwrap().as_ptr(),
            kind: 0,
            x: n.bounds.x,
            y: n.bounds.y,
            width: n.bounds.width,
            height: n.bounds.height,
            radius: n.mask.as_ref().map_or(0., |m| m.radius),
            opacity: n.properties.opacity.unwrap_or(1.),
            visible: n.properties.visible.unwrap_or(true),
            fit: 0,
            surface: ptr::null_mut(),
            children: ptr::null(),
            child_count: 0,
        };
        if n.kind == "group" {
            let mut children = Vec::new();
            let mut batch = Vec::new();
            for child in &n.children {
                // Zero-area/hidden content consumes no texture. Keep semantic IDs
                // upstream; a future native animator activates it through patches.
                if child.properties.visible == Some(false)
                    || child.bounds.width == 0.
                    || child.bounds.height == 0.
                {
                    continue;
                }
                if ["text", "graphic"].contains(&child.kind.as_str()) {
                    batch.push(child);
                    continue;
                }
                if !batch.is_empty() {
                    children.push(self.graphics(&batch, palette)?);
                    batch.clear();
                }
                children.push(self.node(child, palette, resolve)?);
            }
            if !batch.is_empty() {
                children.push(self.graphics(&batch, palette)?);
            }
            let children = children.into_boxed_slice();
            out.children = children.as_ptr();
            out.child_count = children.len();
            self.children.push(children);
        } else if n.kind == "source" {
            out.kind = 1;
            out.fit = if n.fit.as_deref() == Some("cover") {
                2
            } else {
                1
            };
            let source = resolve(n.resource.as_deref().ok_or("Missing source")?)?;
            if source.is_null() {
                return Err("Room source unavailable".into());
            }
            let source = ffi::obs_source_get_ref(source);
            if source.is_null() {
                return Err("Room source expired during preparation".into());
            }
            out.surface = source;
            self.sources.push(Source(source));
        } else {
            return Err("Leaf requires graphics batching or native source service".into());
        }
        Ok(out)
    }
}
fn palette() -> HashMap<String, String> {
    [
        ("navy", "#091729"),
        ("gold", "#ffd167"),
        ("pink", "#f15b94"),
        ("panel", "#17283d"),
        ("blue", "#0000ff"),
        ("red", "#ff0000"),
        ("yellow", "#ffff00"),
    ]
    .into_iter()
    .map(|(k, v)| (format!("graphic:{k}"), v.into()))
    .collect()
}
fn fit(s: &str) -> i32 {
    match s {
        "cover" => 2,
        "contain" => 1,
        _ => 0,
    }
}
pub struct RoomProgram {
    generation: u64,
    width: u32,
    height: u32,
    program: Source,
    item: *mut ffi::obs_sceneitem_t,
    draft: Option<Draft>,
}
impl RoomProgram {
    pub unsafe fn attach(
        room: *mut ffi::obs_scene_t,
        generation: u64,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let source = producer_set_v2_program_create(width, height);
        if source.is_null() {
            return Err("V2 program allocation failed".into());
        }
        let program = Source(source);
        ffi::obs_source_set_audio_mixers(source, 0);
        let item = ffi::obs_scene_add(room, source);
        if item.is_null() {
            return Err("V2 program attachment failed".into());
        }
        ffi::obs_sceneitem_set_order_position(item, i32::MAX);
        Ok(Self {
            generation,
            width,
            height,
            program,
            item,
            draft: None,
        })
    }
    pub unsafe fn dispatch(
        &mut self,
        action: Action,
        mut resolve: impl FnMut(&str) -> Result<*mut ffi::obs_source_t, String>,
    ) -> Result<Status, String> {
        if action.generation() != self.generation {
            return Err("Room generation changed; prepare the set again".into());
        }
        match action {
            Action::Prepare { revision, plan, .. } => {
                self.prepare(revision, &plan, &mut resolve)?
            }
            Action::Take {
                revision,
                duration_ms,
                mode,
                ..
            } => {
                self.poll()?;
                let mode = match mode.as_str() {
                    "dissolve" => 0,
                    "wipe" => 1,
                    "slide" => 2,
                    _ => return Err("Invalid v2 transition mode".into()),
                };
                if !producer_set_v2_program_take(self.program.0, revision, duration_ms, mode) {
                    return Err(
                        "V2 candidate is not ready, stale, or another transition is active".into(),
                    );
                }
            }
            Action::Cancel { revision, .. } => {
                if !producer_set_v2_program_cancel(self.program.0, revision) {
                    return Err("V2 cancellation is stale or already rendered".into());
                }
                self.draft = None;
            }
            Action::Pause { paused, .. } => {
                if !producer_set_v2_program_pause(self.program.0, paused) {
                    return Err("V2 program clock unavailable".into());
                }
            }
            Action::Status { .. } => {}
            Action::Return { .. } => return Err("Room owner must detach the v2 program".into()),
        }
        self.poll()
    }
    unsafe fn prepare(
        &mut self,
        revision: u64,
        plan: &Plan,
        resolve: &mut impl FnMut(&str) -> Result<*mut ffi::obs_source_t, String>,
    ) -> Result<(), String> {
        contract::validate(plan)?;
        if revision == 0
            || revision > 9_007_199_254_740_991
            || plan.target.width != self.width
            || plan.target.height != self.height
        {
            return Err("V2 revision/output must match the current room canvas".into());
        }
        let current = self.poll()?;
        if current.transitioning
            || current.queued
            || revision <= current.prepared_revision
            || revision <= current.rendered_revision
        {
            return Err("V2 prepare is stale or the previous take is still rendering".into());
        }
        let mut arena = Arena::new();
        let root = arena.node(&plan.root, &palette(), resolve)?;
        let mut error = [0 as c_char; 200];
        let scene = producer_set_v2_scene_prepare(
            &root,
            self.width,
            self.height,
            fit(&plan.target.scaling),
            48 * 1024 * 1024,
            error.as_mut_ptr(),
            error.len(),
        );
        if scene.is_null() {
            return Err(CStr::from_ptr(error.as_ptr())
                .to_string_lossy()
                .into_owned());
        }
        let draft = Draft {
            revision,
            scene,
            markers: std::mem::take(&mut arena.markers),
        };
        if !producer_set_v2_program_prepare(
            self.program.0,
            producer_set_v2_scene_source(scene),
            revision,
        ) {
            return Err("Native program rejected v2 preparation".into());
        }
        self.draft = Some(draft);
        Ok(())
    }
    pub unsafe fn poll(&mut self) -> Result<Status, String> {
        let mut native = NativeStatus::default();
        if !producer_set_v2_program_status(self.program.0, &mut native) {
            return Err("Native v2 program unavailable".into());
        }
        if let Some(draft) = &self.draft {
            if native.prepared_revision == draft.revision
                && !native.ready
                && draft
                    .markers
                    .iter()
                    .all(|(s, y)| producer_set_v2_surface_marker(s.0, 0, *y, 1, 254, 3))
            {
                producer_set_v2_program_ready(self.program.0, draft.revision);
                producer_set_v2_program_status(self.program.0, &mut native);
            }
            if native.rendered_revision == draft.revision && !native.transitioning && !native.queued
            {
                self.draft = None;
            }
        }
        producer_set_v2_program_collect(self.program.0);
        Ok(Status {
            generation: self.generation,
            prepared_revision: native.prepared_revision,
            rendered_revision: native.rendered_revision,
            render_serial: native.render_serial,
            clock_ms: native.clock_ms,
            transition_progress: native.transition_progress,
            warmed: native.warmed,
            ready: native.ready,
            queued: native.queued,
            transitioning: native.transitioning,
            paused: native.paused,
        })
    }
}
impl Drop for RoomProgram {
    fn drop(&mut self) {
        unsafe {
            if !self.item.is_null() {
                ffi::obs_sceneitem_remove(self.item);
                self.item = ptr::null_mut();
            }
        }
    }
}
