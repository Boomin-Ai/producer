//! Opt-in dev-room adapter. No v1 conversion and no production registration.
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
    fn producer_set_v2_program_cancel(p: *mut ffi::obs_source_t, r: u64) -> bool;
    fn producer_set_v2_program_pause(p: *mut ffi::obs_source_t, paused: bool) -> bool;
    fn producer_set_v2_program_status(p: *mut ffi::obs_source_t, out: *mut NativeStatus) -> bool;
    fn producer_set_v2_program_stop_motion(p: *mut ffi::obs_source_t);
    fn producer_set_v2_program_collect(p: *mut ffi::obs_source_t) -> bool;
    fn producer_set_v2_surface_fence(
        s: *mut ffi::obs_source_t,
        y: u32,
        expected: *const u8,
    ) -> bool;
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
    scene: *mut NativeScene,
    markers: Vec<(Source, u32)>,
    _resources: resources::Prepared,
    bytes: usize,
    captures: HashMap<String, usize>,
    asset_versions: String,
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
struct Arena {
    ids: Vec<CString>,
    children: Vec<Box<[NativeNode]>>,
    sources: Vec<Source>,
    markers: Vec<(Source, u32)>,
    browser_pixels: usize,
    intermediate_pixels: usize,
    density: f32,
    motion_targets: std::collections::HashSet<String>,
}
impl Arena {
    fn new() -> Self {
        Self {
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
        !self.motion_targets.contains(&n.id)
            && ["text", "graphic", "group"].contains(&n.kind.as_str())
            && n.children.iter().all(|child| self.graphics_only(child))
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
        self.intermediate_pixels += (pw as usize) * (ph as usize);
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
        let surface = clip.0;
        self.sources.push(clip);
        self.markers.push((browser, ph));
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
        } else if ["source", "asset", "shader", "scene3d"].contains(&n.kind.as_str()) {
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
            preparing_key: None,
            building: None,
            latest_revision: 0,
            resources,
            pending_3d: None,
            presented_revision: 0,
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
                contract::validate(&plan)?;
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
                    {
                        let current = resolve(resource)?;
                        if draft.captures.get(resource) != Some(&(current as usize)) {
                            return Err("Cached scene source was replaced".into());
                        }
                    }
                }
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
        contract::validate(plan)?;
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
        let mut captures = HashMap::new();
        for resource in &plan.resources {
            if resource.starts_with("graphic:")
                || resource.starts_with("asset:")
                || resource.starts_with("shader:")
                || resource.starts_with("scene3d:")
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
        let mut arena = Arena::new();
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
        let root = arena.node(&b.plan.root, &palette(), &mut |id| {
            b.resources
                .sources
                .get(id)
                .map(|s| s.0)
                .or_else(|| b.captures.get(id).map(|s| s.0 .0))
                .ok_or_else(|| format!("Source {id} is unavailable"))
        })?;
        let mut error = [0 as c_char; 200];
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
        let bytes = producer_set_v2_scene_texture_bytes(scene)
            + (arena.browser_pixels + arena.intermediate_pixels) * 4
            + arena.markers.len() * 1024 * 1024;
        let draft = Draft {
            scene,
            markers: std::mem::take(&mut arena.markers),
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
        Ok(Rc::new(draft))
    }
    unsafe fn register(&mut self, draft: &Draft, plan: &Plan, revision: u64) -> Result<(), String> {
        self.pending_3d = Some((revision, plan.scenes3d.clone(), plan.clock.clone()));
        let (show, segment, running) = contract::clock_positions(plan.clock.as_ref());
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
    pub unsafe fn raise(&self) {
        ffi::obs_sceneitem_set_order_position(self.item, i32::MAX);
    }
    pub unsafe fn poll(&mut self) -> Result<Status, String> {
        if let Some(building) = self.building.take() {
            if let Some(error) = building.resources.error3d() {
                return Err(error);
            }
            if building.resources.ready()
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
                return Err("Media did not decode its first frame; current output retained".into());
            } else {
                self.building = Some(building);
            }
        }
        let mut native = NativeStatus::default();
        if !producer_set_v2_program_status(self.program.0, &mut native) {
            return Err("Native v2 program unavailable".into());
        }
        if let Some(draft) = &self.draft {
            if native.prepared_revision == self.draft_revision
                && !native.ready
                && draft
                    .markers
                    .iter()
                    .all(|(s, y)| producer_set_v2_surface_marker(s.0, 0, *y, 1, 254, 3))
            {
                producer_set_v2_program_ready(self.program.0, self.draft_revision);
                producer_set_v2_program_status(self.program.0, &mut native);
            }
            if native.ready && native.warmed {
                if let Some((key, signature)) = self.preparing_key.take() {
                    let bytes = self.bank.values().map(|(_, d)| d.bytes).sum::<usize>();
                    if bytes + draft.bytes > 768 * 1024 * 1024 {
                        return Err("Loaded set texture budget reached".into());
                    }
                    self.bank.insert(key, (signature, draft.clone()));
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
            cached_keys: self.bank.keys().cloned().collect(),
            cached_bytes: self.bank.values().map(|(_, d)| d.bytes).sum(),
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
