//! Opt-in dev-room adapter. No v1 conversion and no production registration.
pub mod chart;
pub mod contract;
mod resources;
pub mod scene3d;
use super::ffi;
use contract::{Action, Node, Plan, Status};
use std::{
    collections::HashMap,
    ffi::{c_char, CStr, CString},
    ptr,
    rc::Rc,
};

// Static, payload-free timings only. A slow probe is observed after it returns;
// readiness=false is normal and must not be reported as a failed operation.
pub(super) struct PerformancePhase {
    name: &'static str,
    started: std::time::Instant,
    success: Option<bool>,
    minimum: std::time::Duration,
}
impl PerformancePhase {
    fn start(name: &'static str, begin: Option<&'static str>) -> Self {
        if let Some(begin) = begin {
            crate::performance_trace::native_stage(begin, std::time::Duration::ZERO, None);
        }
        Self {
            name,
            started: std::time::Instant::now(),
            success: Some(false),
            minimum: std::time::Duration::ZERO,
        }
    }
    fn slow(name: &'static str) -> Self {
        Self {
            name,
            started: std::time::Instant::now(),
            success: None,
            minimum: std::time::Duration::from_millis(20),
        }
    }
    fn complete(mut self, success: bool) {
        self.success = Some(success);
    }
}
impl Drop for PerformancePhase {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed();
        if elapsed >= self.minimum {
            crate::performance_trace::native_stage(self.name, elapsed, self.success);
        }
    }
}
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
    rotation: f32,
    scale_x: f32,
    scale_y: f32,
    mask_kind: i32,
    mask_progress: f32,
    mask_x: f32,
    mask_y: f32,
    mask_feather: f32,
    mask_invert: bool,
    mask_direction: i32,
    backdrop_blur: f32,
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
#[repr(C)]
struct NativeKeyframe {
    at_ms: f64,
    value: f32,
}
enum NativeScene {}
extern "C" {
    fn producer_set_v2_register();
    fn producer_chart_register();
    fn producer_set_v2_program_chart(
        p: *mut ffi::obs_source_t,
        r: u64,
        s: *mut ffi::obs_source_t,
    ) -> bool;
    fn producer_set_v2_program_register();
    fn producer_set_v2_program_track(
        p: *mut ffi::obs_source_t,
        r: u64,
        scene: *mut NativeScene,
        target: *const c_char,
        shader: *mut ffi::obs_source_t,
        property: i32,
        frames: *const NativeKeyframe,
        count: usize,
        easing: i32,
        loops: i32,
        base: f64,
        delay: f64,
        running: bool,
    ) -> bool;
    fn producer_set_v2_program_shader(
        p: *mut ffi::obs_source_t,
        r: u64,
        s: *mut ffi::obs_source_t,
        i: f32,
        f: f32,
        o: f32,
        b: f64,
        running: bool,
    ) -> bool;
    fn producer_set_v2_program_media(
        p: *mut ffi::obs_source_t,
        r: u64,
        s: *mut ffi::obs_source_t,
        playing: bool,
        position: f64,
    ) -> bool;
    fn producer_set_v2_transition_register();
    fn producer_set_v2_group_create(w: u32, h: u32, r: f32, o: f32) -> *mut ffi::obs_source_t;
    fn producer_set_v2_group_density(g: *mut ffi::obs_source_t, density: f32) -> bool;
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
    fn producer_set_v2_scene_reset(scene: *mut NativeScene);
    fn producer_set_v2_scene_texture_bytes(scene: *mut NativeScene) -> usize;
    fn producer_set_v2_program_cached_ready(p: *mut ffi::obs_source_t, r: u64) -> bool;
    fn producer_set_v2_scene_release(scene: *mut NativeScene);
    fn producer_set_v2_program_create(w: u32, h: u32) -> *mut ffi::obs_source_t;
    fn producer_set_v2_program_prepare(
        p: *mut ffi::obs_source_t,
        c: *mut ffi::obs_source_t,
        r: u64,
    ) -> bool;
    fn producer_set_v2_program_ready(p: *mut ffi::obs_source_t, r: u64) -> bool;
    fn producer_set_v2_program_take(p: *mut ffi::obs_source_t, r: u64, d: f64, mode: i32) -> bool;
    fn producer_set_v2_program_take_pair(
        a: *mut ffi::obs_source_t,
        ar: u64,
        b: *mut ffi::obs_source_t,
        br: u64,
        duration: f64,
        mode: i32,
    ) -> bool;
    fn producer_set_v2_program_cancel(p: *mut ffi::obs_source_t, r: u64) -> bool;
    fn producer_set_v2_program_pause(p: *mut ffi::obs_source_t, paused: bool) -> bool;
    fn producer_set_v2_program_status(p: *mut ffi::obs_source_t, out: *mut NativeStatus) -> bool;
    fn producer_set_v2_program_stop_motion(p: *mut ffi::obs_source_t);
    fn producer_set_v2_program_collect(p: *mut ffi::obs_source_t) -> bool;
    fn producer_set_v2_surface_warm(source: *mut ffi::obs_source_t) -> bool;
    fn producer_set_v2_surface_fence(
        s: *mut ffi::obs_source_t,
        y: u32,
        expected: *const u8,
    ) -> bool;
    fn producer_set_v2_surface_marker_progress(
        sources: *const *mut ffi::obs_source_t,
        rows: *const u32,
        count: usize,
        verified_prefix: *mut usize,
    ) -> bool;
}
pub unsafe fn register() {
    producer_set_v2_register();
    producer_chart_register();
    producer_set_v2_transition_register();
    producer_set_v2_program_register();
}
struct Source(*mut ffi::obs_source_t);
struct GraphicsContext;
impl GraphicsContext {
    unsafe fn enter() -> Self {
        ffi::obs_enter_graphics();
        Self
    }
}
impl Drop for GraphicsContext {
    fn drop(&mut self) {
        unsafe {
            ffi::obs_leave_graphics();
        }
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        unsafe { ffi::obs_source_release(self.0) }
    }
}
struct GraphicsLayer {
    painted: std::cell::Cell<bool>,
    bytes: usize,
    browser: Source,
    clip: Source,
}
// Prepared HTML is immutable, but CEF visibility is asynchronous. Keep its
// paint producer showing for the full cached-layer lease, not only while one
// scene happens to be current/pending. A take must not trigger WasHidden /
// texture invalidation after its first-paint receipt was already accepted.
impl Drop for GraphicsLayer {
    fn drop(&mut self) {
        unsafe {
            ffi::obs_source_dec_showing(self.browser.0);
            ffi::obs_source_dec_active(self.browser.0);
        }
    }
}
struct Draft {
    scene: *mut NativeScene,
    markers: Vec<(Source, u32)>,
    _graphics: Vec<Rc<GraphicsLayer>>,
    _resources: resources::Prepared,
    bytes: usize,
    captures: HashMap<String, usize>,
    asset_versions: String,
}

#[derive(Default)]
struct TextureUsage {
    allocations: std::collections::HashSet<(u8, usize)>,
    bytes: usize,
}
impl TextureUsage {
    fn include(&mut self, kind: u8, identity: usize, bytes: usize) {
        if self.allocations.insert((kind, identity)) {
            self.bytes += bytes;
        }
    }
}
fn texture_usage<'a>(drafts: impl Iterator<Item = &'a Rc<Draft>>) -> usize {
    let mut usage = TextureUsage::default();
    for draft in drafts {
        usage.include(0, Rc::as_ptr(draft) as usize, draft.bytes);
        for graphics in &draft._graphics {
            usage.include(1, Rc::as_ptr(graphics) as usize, graphics.bytes);
        }
    }
    usage.bytes
}

#[cfg(test)]
#[test]
fn texture_budget_counts_shared_rasters_once_and_distinct_scenes_separately() {
    let mut usage = TextureUsage::default();
    // Two cached compositions retain one immutable raster. Repeated references
    // from the active/pending scene must not consume its budget a second time.
    for scene in [1, 2, 1] {
        usage.include(0, scene, 96);
        usage.include(1, 3, 32);
    }
    assert_eq!(usage.bytes, 224);
    usage.include(1, 4, 40); // Edited raster is a distinct allocation.
    assert_eq!(usage.bytes, 264);
}
struct Capture(Source);
impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            ffi::obs_source_dec_showing(self.0 .0);
            ffi::obs_source_dec_active(self.0 .0);
        }
    }
}
struct Building {
    revision: u64,
    plan: Plan,
    resources: resources::Prepared,
    captures: HashMap<String, Capture>,
    started: std::time::Instant,
}
impl Drop for Draft {
    fn drop(&mut self) {
        unsafe { producer_set_v2_scene_release(self.scene) }
    }
}
struct Arena<'a> {
    store: &'a resources::Store,
    graphics: Vec<Rc<GraphicsLayer>>,
    ids: Vec<CString>,
    children: Vec<Box<[NativeNode]>>,
    sources: Vec<Source>,
    markers: Vec<(Source, u32)>,
    browser_pixels: usize,
    intermediate_pixels: usize,
    density: f32,
    motion_targets: std::collections::HashSet<String>,
}
impl<'a> Arena<'a> {
    fn new(store: &'a resources::Store) -> Self {
        Self {
            store,
            graphics: Vec::new(),
            ids: Vec::new(),
            children: Vec::new(),
            sources: Vec::new(),
            markers: Vec::new(),
            browser_pixels: 0,
            intermediate_pixels: 0,
            density: 1.,
            motion_targets: Default::default(),
        }
    }
    fn graphics_only(&self, n: &Node) -> bool {
        n.mask.as_ref().is_none_or(|m| m.kind == "rounded")
            && n.backdrop.is_none()
            && !self.motion_targets.contains(&n.id)
            && ["text", "graphic", "group"].contains(&n.kind.as_str())
            && n.children.iter().all(|child| self.graphics_only(child))
    }
    unsafe fn graphics(
        &mut self,
        nodes: &[&Node],
        palette: &HashMap<String, String>,
    ) -> Result<NativeNode, String> {
        let _materialize = PerformancePhase::slow("native.set.graphics.materialize");
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
        let pw = (w as f32 * self.density).ceil() as u32;
        let ph = (h as f32 * self.density).ceil() as u32;
        let pixels = (pw as usize) * (ph as usize + 1);
        if pw > 8192
            || ph >= 8192
            || pixels > 4096 * 4096
            || self.browser_pixels + pixels > 8 * 1024 * 1024
            || self.markers.len() >= 16
        {
            return Err("V2 graphics surface budget exceeded".into());
        }
        self.browser_pixels += pixels;
        let html = contract::graphics_document_scaled(nodes, w, h, (x, y), palette, self.density)?;
        use sha2::{Digest, Sha256};
        // Exact trusted raster content and dimensions, scoped to this output
        // owner. A pooled layer is immutable; a value edit creates a new layer
        // while unchanged headers/art remain shared with the live scene.
        let identity = format!(
            "{}:{pw}:{ph}",
            format!("{:x}", Sha256::digest(html.as_bytes()))
        );
        let mut cache = self.store.graphics.borrow_mut();
        let used = self.store.graphics_clock.get() + 1;
        self.store.graphics_clock.set(used);
        let layer = if let Some((last_used, layer)) = cache.get_mut(&identity) {
            *last_used = used;
            layer.clone()
        } else {
            let _create = PerformancePhase::slow("native.set.graphics.create");
            let url = format!(
                "data:text/html;charset=utf-8,{}",
                html.as_bytes()
                    .iter()
                    .map(|c| format!("%{c:02X}"))
                    .collect::<String>()
            );
            let config = serde_json::json!({"url":url,"is_local_file":false,"css":"","width":pw,"height":ph+1,"fps":30,"fps_custom":true,"shutdown":false,"restart_when_active":false,"reroute_audio":true,"webpage_control_level":0});
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
            if !producer_set_v2_group_density(clip.0, self.density) {
                return Err("Graphics density exceeds texture budget".into());
            }
            if !producer_set_v2_group_add(
                clip.0,
                browser.0,
                0.,
                0.,
                w as f32,
                (ph + 1) as f32 * h as f32 / ph as f32,
                false,
            ) || !producer_set_v2_group_seal(clip.0)
            {
                return Err("V2 graphics crop attachment failed".into());
            }
            ffi::obs_source_inc_active(browser.0);
            ffi::obs_source_inc_showing(browser.0);
            self.store
                .graphics_created
                .set(self.store.graphics_created.get() + 1);
            let layer = Rc::new(GraphicsLayer {
                painted: std::cell::Cell::new(false),
                browser,
                clip,
                bytes: (pixels + (pw as usize) * (ph as usize)) * 4 + 1024 * 1024,
            });
            cache.insert(identity, (used, layer.clone()));
            layer
        };
        // Keep the per-scene preflight conservative. The resident cache counts
        // this immutable browser/crop lease once across its owning scenes.
        self.intermediate_pixels += (pw as usize) * (ph as usize);
        let surface = layer.clip.0;
        self.markers
            .push((Source(ffi::obs_source_get_ref(layer.browser.0)), ph));
        self.graphics.push(layer);
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
            rotation: 0.,
            scale_x: 1.,
            scale_y: 1.,
            mask_kind: 0,
            mask_progress: 1.,
            mask_x: 0.5,
            mask_y: 0.5,
            mask_feather: 0.,
            mask_invert: false,
            mask_direction: 0,
            backdrop_blur: 0.,
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
            mask_kind: n.mask.as_ref().map_or(0, |m| match m.kind.as_str() {
                "circle" => 1,
                "wipe" => 2,
                _ => 0,
            }),
            mask_progress: n.mask.as_ref().and_then(|m| m.progress).unwrap_or(1.),
            mask_x: n.mask.as_ref().and_then(|m| m.x).unwrap_or(0.5),
            mask_y: n.mask.as_ref().and_then(|m| m.y).unwrap_or(0.5),
            mask_feather: n.mask.as_ref().and_then(|m| m.feather).unwrap_or(0.),
            mask_invert: n.mask.as_ref().and_then(|m| m.invert).unwrap_or(false),
            mask_direction: n
                .mask
                .as_ref()
                .and_then(|m| m.direction.as_deref())
                .map_or(0, |d| match d {
                    "right" => 1,
                    "up" => 2,
                    "down" => 3,
                    _ => 0,
                }),
            backdrop_blur: n.backdrop.as_ref().map_or(0., |b| b.blur),
            opacity: n.properties.opacity.unwrap_or(1.),
            visible: n.properties.visible.unwrap_or(true),
            fit: 0,
            surface: ptr::null_mut(),
            children: ptr::null(),
            child_count: 0,
            rotation: n.properties.rotation.unwrap_or(0.),
            scale_x: n.properties.scale_x.or(n.properties.scale).unwrap_or(1.),
            scale_y: n.properties.scale_y.or(n.properties.scale).unwrap_or(1.),
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
                if self.graphics_only(child) {
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
        } else if ["source", "asset", "shader", "scene3d", "chart"].contains(&n.kind.as_str()) {
            out.kind = 1;
            out.fit = match n.fit.as_deref() {
                Some("cover") => 2,
                Some("contain") => 1,
                _ => 0,
            };
            let source = resolve(n.resource.as_deref().ok_or("Missing source")?)?;
            if source.is_null() {
                return Err("Room source unavailable".into());
            }
            let source = ffi::obs_source_get_ref(source);
            if source.is_null() {
                return Err("Room source expired during preparation".into());
            }
            if n.appearance.is_some() || n.framing.is_some() {
                let w = n.bounds.width.ceil().max(1.) as u32;
                let h = n.bounds.height.ceil().max(1.) as u32;
                let frame = Source(producer_set_v2_group_create(w, h, 0., 1.));
                if frame.0.is_null() {
                    ffi::obs_source_release(source);
                    return Err("Source placement allocation failed".into());
                }
                if !producer_set_v2_group_density(frame.0, self.density) {
                    ffi::obs_source_release(source);
                    return Err("Source placement density exceeds texture budget".into());
                }
                self.intermediate_pixels += ((w as f32 * self.density).ceil() as usize)
                    * ((h as f32 * self.density).ceil() as usize);
                let sw = ffi::obs_source_get_width(source) as f32;
                let sh = ffi::obs_source_get_height(source) as f32;
                if sw <= 0. || sh <= 0. {
                    ffi::obs_source_release(source);
                    return Err("Source placement has no video frame".into());
                }
                let (x, y, dw, dh) = if out.fit == 2 {
                    let scale = (w as f32 / sw).max(h as f32 / sh);
                    let align = n.framing.as_ref().map(|f| (f.x, f.y)).unwrap_or((0.5, 0.5));
                    (
                        (w as f32 - sw * scale) * align.0,
                        (h as f32 - sh * scale) * align.1,
                        sw * scale,
                        sh * scale,
                    )
                } else {
                    (0., 0., w as f32, h as f32)
                };
                if !producer_set_v2_group_add(frame.0, source, x, y, dw, dh, out.fit == 1)
                    || !producer_set_v2_group_seal(frame.0)
                {
                    ffi::obs_source_release(source);
                    return Err("Source placement attachment failed".into());
                }
                self.sources.push(Source(source));
                if let Some(appearance) = &n.appearance {
                    let mut value = serde_json::to_value(appearance).map_err(|e| e.to_string())?;
                    value["displayWidth"] = serde_json::json!(w);
                    value["displayHeight"] = serde_json::json!(h);
                    let settings = ffi::obs_data_create_from_json(
                        CString::new(value.to_string()).unwrap().as_ptr(),
                    );
                    let filter = ffi::obs_source_create_private(
                        c"producer_source_appearance".as_ptr(),
                        c"V2 source appearance".as_ptr(),
                        settings,
                    );
                    ffi::obs_data_release(settings);
                    if filter.is_null() {
                        return Err("Source appearance filter unavailable".into());
                    }
                    ffi::obs_source_filter_add(frame.0, filter);
                    ffi::obs_source_release(filter);
                }
                out.surface = frame.0;
                out.fit = 0;
                self.sources.push(frame);
            } else {
                out.surface = source;
                self.sources.push(Source(source));
            }
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
    draft: Option<Rc<Draft>>,
    draft_revision: u64,
    current: Option<Rc<Draft>>,
    bank: HashMap<String, (String, Rc<Draft>)>,
    capture_placements: HashMap<usize, Source>,
    preparing_key: Option<(String, String)>,
    building: Option<Building>,
    latest_revision: u64,
    resources: resources::Store,
    pending_3d: Option<(u64, HashMap<String, scene3d::Spec>, Option<contract::Clock>)>,
    presented_revision: u64,
}
impl RoomProgram {
    pub unsafe fn attach(
        room: *mut ffi::obs_scene_t,
        generation: u64,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let resources = resources::Store::new()?;
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
            draft_revision: 0,
            current: None,
            bank: HashMap::new(),
            capture_placements: HashMap::new(),
            preparing_key: None,
            building: None,
            latest_revision: 0,
            resources,
            pending_3d: None,
            presented_revision: 0,
        })
    }
    pub unsafe fn take_pair(
        &mut self,
        portrait: &mut Self,
        program_revision: u64,
        portrait_revision: u64,
        duration: f64,
        mode: &str,
    ) -> Result<Status, String> {
        self.poll()?;
        portrait.poll()?;
        let mode = match mode {
            "dissolve" => 0,
            "wipe" => 1,
            "slide" => 2,
            _ => return Err("Invalid v2 transition mode".into()),
        };
        if !producer_set_v2_program_take_pair(
            self.program.0,
            program_revision,
            portrait.program.0,
            portrait_revision,
            duration,
            mode,
        ) {
            return Err(
                "Both output candidates must be ready and current; previous outputs retained"
                    .into(),
            );
        }
        for (program, revision) in [
            (&mut *self, program_revision),
            (portrait, portrait_revision),
        ] {
            if let (Some(draft), Some((r, specs, clock))) = (&program.draft, &program.pending_3d) {
                if *r == revision {
                    draft._resources.publish3d(specs, clock.as_ref());
                }
            }
        }
        // The normal poll path confirms each output's rendered revision.
        self.poll()
    }
    /// Charge each scene's private placements, but each immutable painter once
    /// per output owner. Rc identity is the actual native resource lease, not
    /// an authored asset ID or a claim supplied by an imported Set.
    fn cache_bytes(&self, added: Option<&Rc<Draft>>) -> usize {
        texture_usage(
            self.bank
                .values()
                .map(|(_, draft)| draft)
                .chain(self.current.iter())
                .chain(added),
        )
    }
    pub unsafe fn dispatch(
        &mut self,
        action: Action,
        resolve: impl FnMut(&str) -> Result<*mut ffi::obs_source_t, String>,
    ) -> Result<Status, String> {
        let preload = matches!(&action, Action::Preload { .. }).then(|| {
            PerformancePhase::start(
                "native.set.preload.dispatch",
                Some("native.set.preload.begin"),
            )
        });
        let result = self.dispatch_inner(action, resolve);
        if let Some(preload) = preload {
            preload.complete(result.is_ok());
        }
        result
    }
    unsafe fn dispatch_inner(
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
            Action::Preload {
                revision,
                key,
                plan,
                ..
            } => {
                if !contract::identity(&key) {
                    return Err("Invalid cached scene identity".into());
                }
                self.resources.publish(&plan.assets)?;
                let signature = self.identity(&plan)?;
                if let Some((s, d)) = self.bank.get(&key) {
                    let captures_match = d.captures.iter().all(|(id, source)| {
                        resolve(id).is_ok_and(|current| current as usize == *source)
                    });
                    if s == &signature
                        && captures_match
                        && d.asset_versions == self.resources.versions(&plan.resources)
                    {
                        return self.poll();
                    }
                }
                self.bank.remove(&key);
                if self.bank.len() >= 64 {
                    return Err("Loaded set scene count budget reached".into());
                }
                self.prepare(revision, &plan, &mut resolve)?;
                self.preparing_key = Some((key, signature));
            }
            Action::Activate {
                revision,
                key,
                plan,
                ..
            } => {
                let validation = PerformancePhase::start("native.set.plan.validate", None);
                contract::validate(&plan)?;
                validation.complete(true);
                self.resources.publish(&plan.assets)?;
                let signature = self.identity(&plan)?;
                let draft = self
                    .bank
                    .get(&key)
                    .filter(|(s, _)| s == &signature)
                    .map(|(_, d)| d.clone())
                    .ok_or("Cached scene is missing or stale")?;
                let native = self.poll()?;
                if native.transitioning || native.queued || revision <= self.latest_revision {
                    return Err("Cached scene take is stale or busy".into());
                }
                // Validate capture identity again: a replaced source cannot reuse an old lease.
                for resource in &plan.resources {
                    if !resource.starts_with("graphic:")
                        && !resource.starts_with("shader:")
                        && !resource.starts_with("asset:")
                        && !resource.starts_with("scene3d:")
                        && !resource.starts_with("chart:")
                    {
                        let current = resolve(resource)?;
                        if draft.captures.get(resource) != Some(&(current as usize)) {
                            return Err("Cached scene source was replaced".into());
                        }
                    }
                }
                let _graphics = GraphicsContext::enter();
                if !producer_set_v2_program_prepare(
                    self.program.0,
                    producer_set_v2_scene_source(draft.scene),
                    revision,
                ) {
                    return Err("Cached scene activation rejected".into());
                }
                self.latest_revision = revision;
                self.building = None;
                self.preparing_key = None;
                if let Err(error) = self.register(&draft, &plan, revision) {
                    producer_set_v2_program_cancel(self.program.0, revision);
                    return Err(error);
                }
                producer_set_v2_scene_reset(draft.scene);
                if !producer_set_v2_program_cached_ready(self.program.0, revision) {
                    return Err("Cached scene readiness rejected".into());
                }
                self.draft_revision = revision;
                self.draft = Some(draft);
            }
            Action::Retain {
                keys, asset_ids, ..
            } => {
                if keys.len() > 64
                    || keys.iter().any(|k| !contract::identity(k))
                    || asset_ids.len() > 24
                    || asset_ids.iter().any(|id| !contract::identity(id))
                {
                    return Err("Invalid retained scene inventory".into());
                }
                self.bank.retain(|key, _| keys.contains(key));
                self.resources.retain_manifest(&asset_ids);
                let bytes = self.cache_bytes(None);
                self.resources
                    .trim_graphics((768usize * 1024 * 1024).saturating_sub(bytes));
            }
            Action::TakePair { .. } => {
                return Err("Paired takes require the room output coordinator".into())
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
                if let (Some(draft), Some((r, specs, clock))) = (&self.draft, &self.pending_3d) {
                    if *r == revision {
                        draft._resources.publish3d(specs, clock.as_ref());
                    }
                }
            }
            Action::Cancel { revision, .. } => {
                if self
                    .building
                    .as_ref()
                    .is_some_and(|b| b.revision == revision)
                {
                    self.building = None;
                    return self.poll();
                }
                if !producer_set_v2_program_cancel(self.program.0, revision) {
                    return Err("V2 cancellation is stale or already rendered".into());
                }
                self.draft = None;
            }
            Action::Pause { paused, .. } => {
                if let Some(current) = &self.current {
                    current._resources.pause3d(paused);
                }
                if !producer_set_v2_program_pause(self.program.0, paused) {
                    return Err("V2 program clock unavailable".into());
                }
            }
            Action::Status { .. } => {}
            Action::Return { .. } => return Err("Room owner must detach the v2 program".into()),
        }
        self.poll()
    }
    fn identity(&self, plan: &Plan) -> Result<String, String> {
        let _identity = PerformancePhase::slow("native.set.plan.identity");
        let mut value = serde_json::to_value(plan).map_err(|e| e.to_string())?;
        let o = value.as_object_mut().unwrap();
        o.remove("clock");
        o.remove("motion");
        o.remove("assets");
        o.remove("definitionRevision");
        if let Some(specs) = o.get_mut("scenes3d").and_then(|v| v.as_object_mut()) {
            for spec in specs.values_mut() {
                if let Some(s) = spec.as_object_mut() {
                    s.remove("cue");
                    s.remove("view");
                    s.remove("cueSequence");
                }
            }
        }
        fn strip(n: &mut serde_json::Value) {
            if let Some(o) = n.as_object_mut() {
                o.remove("playback");
                if let Some(children) = o.get_mut("children").and_then(|c| c.as_array_mut()) {
                    for c in children {
                        strip(c);
                    }
                }
            }
        }
        strip(value.get_mut("root").unwrap());
        Ok(value.to_string())
    }
    unsafe fn prepare(
        &mut self,
        revision: u64,
        plan: &Plan,
        resolve: &mut impl FnMut(&str) -> Result<*mut ffi::obs_source_t, String>,
    ) -> Result<(), String> {
        let validation = PerformancePhase::start("native.set.plan.validate", None);
        contract::validate(plan)?;
        validation.complete(true);
        self.preparing_key = None;
        if revision == 0
            || revision > 9_007_199_254_740_991
            || plan.target.width != self.width
            || plan.target.height != self.height
        {
            return Err(format!("V2 revision/output must match the current room canvas (revision {revision}, requested {}x{}, native {}x{})",plan.target.width,plan.target.height,self.width,self.height));
        }
        let current = self.poll()?;
        if current.transitioning || current.queued || revision <= self.latest_revision {
            return Err("V2 prepare is stale or a take is still rendering".into());
        }
        self.resources.publish(&plan.assets)?;
        let prepared = self.resources.open(plan)?;
        let captures_phase = PerformancePhase::start("native.set.capture.resolve", None);
        let mut captures = HashMap::new();
        for resource in &plan.resources {
            if resource.starts_with("graphic:")
                || resource.starts_with("asset:")
                || resource.starts_with("shader:")
                || resource.starts_with("scene3d:")
                || resource.starts_with("chart:")
            {
                continue;
            }
            let source = resolve(resource)?;
            let source = ffi::obs_source_get_ref(source);
            if source.is_null() {
                return Err("Room capture expired".into());
            }
            ffi::obs_source_inc_active(source);
            ffi::obs_source_inc_showing(source);
            captures.insert(resource.clone(), Capture(Source(source)));
        }
        captures_phase.complete(true);
        if self.draft.take().is_some() {
            producer_set_v2_program_cancel(self.program.0, self.draft_revision);
        }
        let mut plan = plan.clone();
        plan.assets.clear();
        self.latest_revision = revision;
        self.building = Some(Building {
            revision,
            plan,
            resources: prepared,
            captures,
            started: std::time::Instant::now(),
        });
        Ok(())
    }
    unsafe fn finish_build(&mut self, b: Building) -> Result<Rc<Draft>, String> {
        let phase = PerformancePhase::start(
            "native.set.finish_build",
            Some("native.set.finish_build.begin"),
        );
        for capture in b.captures.values() {
            let source = capture.0 .0;
            if let std::collections::hash_map::Entry::Vacant(entry) =
                self.capture_placements.entry(source as usize)
            {
                let placement = ffi::producer_source_placement_create(source);
                if placement.is_null() {
                    return Err("Native capture placement could not be created".into());
                }
                entry.insert(Source(placement));
            }
        }
        let mut arena = Arena::new(&self.resources);
        let sx = self.width as f32 / b.plan.root.bounds.width;
        let sy = self.height as f32 / b.plan.root.bounds.height;
        arena.density = if b.plan.target.scaling == "contain" {
            sx.min(sy)
        } else {
            sx.max(sy)
        }
        .max(1.);
        arena.motion_targets = b
            .plan
            .motion
            .iter()
            .map(|t| t.target.clone())
            .chain(b.plan.retained_targets.iter().cloned())
            .collect();
        let arena_phase = PerformancePhase::start("native.set.finish_build.arena_node", None);
        let root = arena.node(&b.plan.root, &palette(), &mut |id| {
            b.resources
                .sources
                .get(id)
                .map(|s| s.0)
                .or_else(|| {
                    let source = b.captures.get(id)?.0 .0 as usize;
                    self.capture_placements
                        .get(&source)
                        .map(|placement| placement.0)
                })
                .ok_or_else(|| format!("Source {id} is unavailable"))
        })?;
        arena_phase.complete(true);
        let mut error = [0 as c_char; 200];
        let scene_phase = PerformancePhase::start("native.set.finish_build.scene_prepare", None);
        let scene = producer_set_v2_scene_prepare(
            &root,
            self.width,
            self.height,
            fit(&b.plan.target.scaling),
            96 * 1024 * 1024,
            error.as_mut_ptr(),
            error.len(),
        );
        if scene.is_null() {
            return Err(CStr::from_ptr(error.as_ptr())
                .to_string_lossy()
                .into_owned());
        }
        scene_phase.complete(true);
        let bytes = producer_set_v2_scene_texture_bytes(scene)
            + (arena.browser_pixels + arena.intermediate_pixels) * 4
            + arena.markers.len() * 1024 * 1024
            - arena.graphics.iter().map(|g| g.bytes).sum::<usize>();
        let draft = Draft {
            scene,
            markers: std::mem::take(&mut arena.markers),
            _graphics: std::mem::take(&mut arena.graphics),
            bytes,
            asset_versions: self.resources.versions(&b.plan.resources),
            captures: b
                .captures
                .iter()
                .map(|(id, s)| (id.clone(), s.0 .0 as usize))
                .collect(),
            _resources: b.resources,
        };
        if !producer_set_v2_program_prepare(
            self.program.0,
            producer_set_v2_scene_source(scene),
            b.revision,
        ) {
            return Err("Native program rejected preparation".into());
        }
        if let Err(error) = self.register(&draft, &b.plan, b.revision) {
            producer_set_v2_program_cancel(self.program.0, b.revision);
            return Err(error);
        }
        self.draft_revision = b.revision;
        let draft = Rc::new(draft);
        phase.complete(true);
        Ok(draft)
    }
    unsafe fn register(&mut self, draft: &Draft, plan: &Plan, revision: u64) -> Result<(), String> {
        let _register = PerformancePhase::slow("native.set.timeline.register");
        // Register the complete pending timeline as one graphics transaction.
        // Inner native calls can nest this context without waiting a frame
        // between individual tracks; no queued graphics probe occurs here.
        let _graphics = GraphicsContext::enter();
        self.pending_3d = Some((revision, plan.scenes3d.clone(), plan.clock.clone()));
        let (show, segment, running) = contract::clock_positions(plan.clock.as_ref());
        for chart in &draft._resources.charts {
            if !producer_set_v2_program_chart(self.program.0, revision, *chart) {
                return Err("Native chart clock rejected".into());
            }
        }
        for shader in &draft._resources.shaders {
            let spec = draft
                ._resources
                .sources
                .iter()
                .find(|(_, s)| s.0 == shader.source)
                .and_then(|(key, _)| key.strip_prefix("shader:"))
                .and_then(|key| plan.shaders.get(key));
            if !producer_set_v2_program_shader(
                self.program.0,
                revision,
                shader.source,
                shader.intensity,
                shader.scale,
                shader.opacity,
                spec.map_or(shader.base_ms, |s| {
                    if s.clock == "show" {
                        show
                    } else {
                        segment
                    }
                }),
                running,
            ) {
                return Err("Native material clock rejected".into());
            }
        }
        for media in &draft._resources.media {
            fn transport(n: &Node, id: &str) -> Option<contract::Playback> {
                if n.resource.as_deref() == Some(id) {
                    return n.playback.clone();
                }
                n.children.iter().find_map(|c| transport(c, id))
            }
            let resource = draft
                ._resources
                .sources
                .iter()
                .find(|(_, s)| s.0 == media.source)
                .map(|(k, _)| k.as_str());
            let transport = resource.and_then(|id| transport(&plan.root, id));
            if !producer_set_v2_program_media(
                self.program.0,
                revision,
                media.source,
                transport.as_ref().map_or(media.playing, |t| t.playing),
                transport
                    .as_ref()
                    .map_or(media.position_ms, |t| t.position_ms),
            ) {
                return Err("Native media transport rejected".into());
            }
        }
        for t in &plan.motion {
            let property = [
                "x",
                "y",
                "width",
                "height",
                "opacity",
                "rotation",
                "scale",
                "shader.intensity",
                "shader.scale",
                "mask.progress",
            ]
            .iter()
            .position(|p| *p == t.property)
            .ok_or("Unknown animation property")? as i32;
            let frames = t
                .keyframes
                .iter()
                .map(|k| NativeKeyframe {
                    at_ms: k.at_ms,
                    value: k.value,
                })
                .collect::<Vec<_>>();
            let easing = match t.easing.as_deref() {
                Some("linear") => 0,
                Some("easeIn") => 1,
                Some("easeOut") => 2,
                _ => 3,
            };
            let loops = match t.r#loop.as_deref() {
                Some("repeat") => 1,
                Some("pingpong") => 2,
                _ => 0,
            };
            let shader = draft
                ._resources
                .sources
                .get(&format!("shader:{}", t.target))
                .map_or(ptr::null_mut(), |s| s.0);
            if !producer_set_v2_program_track(
                self.program.0,
                revision,
                draft.scene,
                CString::new(t.target.clone()).unwrap().as_ptr(),
                shader,
                property,
                frames.as_ptr(),
                frames.len(),
                easing,
                loops,
                if t.clock.as_deref() == Some("show") {
                    show
                } else {
                    segment
                },
                t.delay_ms.unwrap_or(0.),
                running,
            ) {
                producer_set_v2_program_cancel(self.program.0, revision);
                return Err("Native animation target is not representable".into());
            }
        }
        Ok(())
    }
    pub(super) fn scene_item(&self) -> *mut ffi::obs_sceneitem_t {
        self.item
    }
    pub(super) fn has_capture_placement(&self, source: *mut ffi::obs_source_t) -> bool {
        self.capture_placements.contains_key(&(source as usize))
    }
    /// Replace the video child behind a stable Set placement, or clear just
    /// that placement when its source leaves. Current and transitional
    /// compositions can continue drawing the rest of the Set.
    pub(super) unsafe fn retarget_capture(
        &mut self,
        old: *mut ffi::obs_source_t,
        replacement: Option<*mut ffi::obs_source_t>,
    ) {
        let old_key = old as usize;
        if let Some(placement) = self.capture_placements.remove(&old_key) {
            if let Some(replacement) = replacement
                .filter(|source| ffi::producer_source_placement_retarget(placement.0, *source))
            {
                self.capture_placements
                    .insert(replacement as usize, placement);
            } else {
                ffi::producer_source_placement_retarget(placement.0, ptr::null_mut());
            }
        }
    }

    pub(super) fn invalidate_capture(&mut self, old: *mut ffi::obs_source_t) {
        let uses_old = |draft: &Draft| {
            draft
                .captures
                .values()
                .any(|source| *source == old as usize)
        };
        self.bank.retain(|_, (_, draft)| !uses_old(draft));
        if self.draft.as_ref().is_some_and(|draft| uses_old(draft)) {
            self.preparing_key = None;
        }
        if self
            .building
            .as_ref()
            .is_some_and(|build| build.captures.values().any(|capture| capture.0 .0 == old))
        {
            self.building = None;
            self.preparing_key = None;
        }
    }
    pub unsafe fn poll(&mut self) -> Result<Status, String> {
        if let Some(building) = self.building.take() {
            if let Some(error) = building.resources.error3d() {
                return Err(error);
            }
            let resources_ready = {
                let _probe = PerformancePhase::slow("native.set.probe.resources_ready");
                building.resources.ready()
            };
            if resources_ready
                && building.captures.values().all(|s| {
                    ffi::obs_source_get_width(s.0 .0) > 0 && ffi::obs_source_get_height(s.0 .0) > 0
                })
            {
                self.draft = Some(self.finish_build(building)?);
            } else if building.started.elapsed().as_secs()
                > if building.resources.scenes3d.is_empty() {
                    12
                } else {
                    60
                }
            {
                // Cold WebGL shader compilation and CEF's first imported paint
                // can outlast media decoding on memory-constrained hosts.
                // This is preparation only; cached layout changes never wait
                // for this startup deadline.
                let mut pending = building.resources.pending_reasons();
                for (id, source) in &building.captures {
                    if ffi::obs_source_get_width(source.0 .0) == 0
                        || ffi::obs_source_get_height(source.0 .0) == 0
                    {
                        pending.push(format!("capture {id}: waiting for source dimensions"));
                    }
                }
                if pending.is_empty() {
                    pending.push("waiting for native surface warming".into());
                }
                return Err(format!(
                    "Set first-frame timeout ({}); current output retained",
                    pending.join("; ")
                ));
            } else {
                self.building = Some(building);
            }
        }
        let mut native = NativeStatus::default();
        if !producer_set_v2_program_status(self.program.0, &mut native) {
            return Err("Native v2 program unavailable".into());
        }
        if let Some(draft) = &self.draft {
            // Preparation must paint even before the program has a visible
            // parent/output. Its render callback warms pending scene children;
            // waiting for that callback via normal output activity can deadlock
            // the first take. The painted browser markers remain mandatory.
            if native.prepared_revision == self.draft_revision && !native.warmed {
                let _probe = PerformancePhase::slow("native.set.probe.program_warm");
                producer_set_v2_surface_warm(self.program.0);
                producer_set_v2_program_status(self.program.0, &mut native);
            }
            // Paint producers are immutable and keep their active/showing
            // lease for their entire cached lifetime. Validate their first
            // actual pixels once; a new scene placement is not a new paint.
            let pending_markers: Vec<_> = draft
                .markers
                .iter()
                .zip(&draft._graphics)
                .filter(|(_, layer)| !layer.painted.get())
                .collect();
            let marker_sources: Vec<_> = pending_markers.iter().map(|((s, _), _)| s.0).collect();
            let marker_rows: Vec<_> = pending_markers.iter().map(|((_, y), _)| *y).collect();
            if native.prepared_revision == self.draft_revision && !native.ready {
                let _probe = PerformancePhase::slow("native.set.probe.graphics_markers");
                let mut verified_prefix = 0;
                let valid = producer_set_v2_surface_marker_progress(
                    marker_sources.as_ptr(),
                    marker_rows.as_ptr(),
                    marker_sources.len(),
                    &mut verified_prefix,
                );
                if valid && verified_prefix <= pending_markers.len() {
                    // Retain only actual successful pixels. A later unpainted
                    // layer must not make us recheck this immutable prefix.
                    for (_, layer) in pending_markers.iter().take(verified_prefix) {
                        layer.painted.set(true);
                    }
                    if draft.markers.len() == draft._graphics.len()
                        && draft._graphics.iter().all(|layer| layer.painted.get())
                    {
                        producer_set_v2_program_ready(self.program.0, self.draft_revision);
                        producer_set_v2_program_status(self.program.0, &mut native);
                    }
                }
            }
            if native.ready && native.warmed {
                if let Some((key, signature)) = self.preparing_key.take() {
                    let bytes = self.cache_bytes(Some(draft));
                    if bytes > 768 * 1024 * 1024 {
                        return Err("Loaded set texture budget reached".into());
                    }
                    self.bank.insert(key, (signature, draft.clone()));
                    self.resources
                        .trim_graphics((768usize * 1024 * 1024).saturating_sub(bytes));
                }
            }
            if native.rendered_revision == self.draft_revision
                && !native.transitioning
                && !native.queued
            {
                producer_set_v2_program_collect(self.program.0);
                if let (Some(old), Some(next)) = (&self.current, &self.draft) {
                    old._resources.hide_unshared3d(&next._resources);
                }
                self.current = self.draft.take();
            }
        }
        producer_set_v2_program_collect(self.program.0);
        let presented = self
            .current
            .as_ref()
            .map_or(true, |d| d._resources.presented3d());
        if presented {
            self.presented_revision = native.rendered_revision;
        }
        Ok(Status {
            scene3d_contexts: scene3d::live_count(),
            graphics_layers: self.resources.graphics_count(),
            graphics_creations: self.resources.graphics_created.get(),
            cached_keys: self.bank.keys().cloned().collect(),
            cached_bytes: self.cache_bytes(None),
            spare_graphics_bytes: self.resources.spare_graphics_bytes(),
            generation: self.generation,
            prepared_revision: self
                .building
                .as_ref()
                .map_or(native.prepared_revision, |b| b.revision),
            rendered_revision: if presented {
                native.rendered_revision
            } else {
                self.presented_revision
            },
            render_serial: native.render_serial,
            clock_ms: native.clock_ms,
            transition_progress: native.transition_progress,
            warmed: self.building.is_none() && native.warmed,
            ready: self.building.is_none() && native.ready && presented,
            queued: native.queued,
            transitioning: native.transitioning,
            paused: native.paused,
        })
    }
}
impl Drop for RoomProgram {
    fn drop(&mut self) {
        unsafe {
            producer_set_v2_program_stop_motion(self.program.0);
            if !self.item.is_null() {
                ffi::obs_sceneitem_remove(self.item);
                self.item = ptr::null_mut();
            }
        }
    }
}
