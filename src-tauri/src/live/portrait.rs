//! Secondary portrait output. Explicit canvas video, shared captures,
//! no secondary audio mix. Never resets or attaches to the main canvas.
use super::{
    ffi,
    presentation::{Bridge, Composition, Placement, Request},
};
use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::HashMap,
    ffi::{c_void, CString},
    sync::{Arc, Mutex},
    time::Instant,
};
static PROGRAM_SELECTED: AtomicBool = AtomicBool::new(false);
static PROGRAM_WANTED: AtomicBool = AtomicBool::new(false);
static PROGRAM_FRAME: Mutex<Vec<u8>> = Mutex::new(Vec::new());
pub fn select_program(on: bool) {
    PROGRAM_SELECTED.store(on, Ordering::Relaxed);
    if !on {
        if let Ok(mut f) = PROGRAM_FRAME.lock() {
            f.clear();
        }
    }
}
pub fn want_program(on: bool) {
    PROGRAM_WANTED.store(on, Ordering::Relaxed);
    if !on {
        if let Ok(mut f) = PROGRAM_FRAME.lock() {
            f.clear();
        }
    }
}
pub fn program_frame() -> Vec<u8> {
    if !PROGRAM_SELECTED.load(Ordering::Relaxed) {
        return Vec::new();
    }
    PROGRAM_FRAME.lock().map(|f| f.clone()).unwrap_or_default()
}

#[repr(C)]
pub struct Canvas {
    _opaque: [u8; 0],
}
#[repr(C)]
struct Scale {
    format: i32,
    width: u32,
    height: u32,
    range: i32,
    colorspace: i32,
}
extern "C" {
    fn obs_sceneitem_set_alignment(item: *mut ffi::obs_sceneitem_t, alignment: u32);
    fn obs_sceneitem_set_bounds_alignment(item: *mut ffi::obs_sceneitem_t, alignment: u32);
    fn obs_canvas_create_private(
        name: *const std::ffi::c_char,
        info: *mut ffi::obs_video_info,
        flags: u32,
    ) -> *mut Canvas;
    pub fn obs_canvas_get_ref(canvas: *mut Canvas) -> *mut Canvas;
    pub fn obs_canvas_render(canvas: *mut Canvas);
    fn obs_canvas_scene_create(
        canvas: *mut c_void,
        name: *const std::ffi::c_char,
    ) -> *mut ffi::obs_scene_t;
    fn obs_canvas_set_channel(canvas: *mut Canvas, channel: u32, source: *mut ffi::obs_source_t);
    fn obs_canvas_get_video(canvas: *const Canvas) -> *mut ffi::video_t;
    fn obs_canvas_remove(canvas: *mut Canvas);
    fn obs_canvas_release(canvas: *mut Canvas);
    fn obs_register_output_s(info: *const OutputInfo, size: usize);
    fn obs_output_begin_data_capture(output: *mut ffi::obs_output_t, flags: u32) -> bool;
    fn obs_output_end_data_capture(output: *mut ffi::obs_output_t);
    fn obs_output_set_video_conversion(output: *mut ffi::obs_output_t, scale: *const Scale);
    fn obs_obj_get_data(output: *mut c_void) -> *mut c_void;
}
#[repr(C)]
struct OutputInfo {
    id: *const std::ffi::c_char,
    flags: u32,
    name: Option<extern "C" fn(*mut c_void) -> *const std::ffi::c_char>,
    create: Option<extern "C" fn(*mut ffi::obs_data_t, *mut ffi::obs_output_t) -> *mut c_void>,
    destroy: Option<extern "C" fn(*mut c_void)>,
    start: Option<extern "C" fn(*mut c_void) -> bool>,
    stop: Option<extern "C" fn(*mut c_void, u64)>,
    raw_video: Option<extern "C" fn(*mut c_void, *mut ffi::video_data)>,
    optional: [usize; 16],
}
struct Capture {
    output: *mut ffi::obs_output_t,
    param: *mut c_void,
}
extern "C" fn output_name(_: *mut c_void) -> *const std::ffi::c_char {
    b"Producer portrait preview\0".as_ptr().cast()
}
extern "C" fn output_create(
    _: *mut ffi::obs_data_t,
    output: *mut ffi::obs_output_t,
) -> *mut c_void {
    Box::into_raw(Box::new(Capture {
        output,
        param: std::ptr::null_mut(),
    }))
    .cast()
}
extern "C" fn output_destroy(data: *mut c_void) {
    unsafe {
        drop(Box::from_raw(data as *mut Capture));
    }
}
extern "C" fn output_start(data: *mut c_void) -> bool {
    unsafe { obs_output_begin_data_capture((*(data as *mut Capture)).output, 0) }
}
extern "C" fn output_stop(data: *mut c_void, _: u64) {
    unsafe {
        obs_output_end_data_capture((*(data as *mut Capture)).output);
    }
}
extern "C" fn output_frame(data: *mut c_void, video: *mut ffi::video_data) {
    unsafe {
        let param = (*(data as *mut Capture)).param;
        if !param.is_null() {
            frame(param, video);
        }
    }
}
struct Frames {
    last: Instant,
    jpeg: String,
    calls: u64,
    diagnostic: bool,
    width: u32,
    height: u32,
}
extern "C" fn frame(param: *mut c_void, data: *mut ffi::video_data) {
    unsafe {
        if data.is_null() || (*data).data[0].is_null() {
            return;
        }
        let store = &*(param as *const Mutex<Frames>);
        let Ok(mut store) = store.try_lock() else {
            return;
        };
        let program =
            PROGRAM_SELECTED.load(Ordering::Relaxed) && PROGRAM_WANTED.load(Ordering::Relaxed);
        if !store.diagnostic && !program {
            return;
        }
        store.calls += 1;
        if store.calls == 1 {
            eprintln!(
                "[portrait-dev] first raw frame linesize={}",
                (*data).linesize[0]
            );
        }
        if store.last.elapsed().as_millis() < if program { 50 } else { 250 } {
            return;
        }
        store.last = Instant::now();
        let mut bytes = Vec::with_capacity((store.width * store.height * 4) as usize);
        for y in 0..store.height as usize {
            bytes.extend_from_slice(std::slice::from_raw_parts(
                (*data).data[0].add(y * (*data).linesize[0] as usize),
                store.width as usize * 4,
            ));
        }
        let mut jpeg = Vec::new();
        match jpeg_encoder::Encoder::new(&mut jpeg, 92).encode(
            &bytes,
            store.width as u16,
            store.height as u16,
            jpeg_encoder::ColorType::Bgra,
        ) {
            Ok(()) => {
                if program {
                    if let Ok(mut f) = PROGRAM_FRAME.lock() {
                        *f = jpeg.clone();
                    }
                }
                store.jpeg = base64::engine::general_purpose::STANDARD.encode(jpeg)
            }
            Err(e) => eprintln!("[portrait-dev] preview encode failed: {e}"),
        }
    }
}
pub struct Portrait {
    width: u32,
    height: u32,
    pub canvas: *mut Canvas,
    room_scene: *mut ffi::obs_scene_t,
    room_items: HashMap<String, (*mut ffi::obs_sceneitem_t, usize)>,
    overrides: HashMap<String, super::graph::TransformPatch>,
    room_fingerprint: String,
    room_states: Vec<super::graph::ItemState>,
    output: *mut ffi::obs_output_t,
    frames: Box<Mutex<Frames>>,
    pub pending: Option<Composition>,
    pub spare: Option<Composition>,
    pub active: Option<Composition>,
    retiring: Option<Composition>,
    blend_scene: *mut ffi::obs_scene_t,
    needs_prewarm: bool,
}
impl Portrait {
    pub unsafe fn create() -> Result<Self, String> {
        let mut info: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        if !ffi::obs_get_video_info(info.as_mut_ptr()) {
            return Err("Room video is not ready".into());
        }
        let mut info = info.assume_init();
        let width = info.base_height;
        let height = info.base_width;
        info.base_width = width;
        info.base_height = height;
        info.output_width = width;
        info.output_height = height;
        let preview_width = width.min(1080);
        let preview_height = preview_width * height / width;
        let canvas = obs_canvas_create_private(
            CString::new("Producer portrait").unwrap().as_ptr(),
            &mut info,
            2 | 8 | 16,
        );
        if canvas.is_null() {
            return Err("Private portrait canvas unavailable".into());
        }
        let video = obs_canvas_get_video(canvas);
        let mut result = Self {
            width,
            height,
            canvas,
            room_scene: std::ptr::null_mut(),
            room_items: HashMap::new(),
            overrides: HashMap::new(),
            room_fingerprint: String::new(),
            room_states: Vec::new(),
            output: std::ptr::null_mut(),
            frames: Box::new(Mutex::new(Frames {
                last: Instant::now(),
                jpeg: String::new(),
                calls: 0,
                diagnostic: false,
                width: preview_width,
                height: preview_height,
            })),
            pending: None,
            spare: None,
            active: None,
            retiring: None,
            blend_scene: std::ptr::null_mut(),
            needs_prewarm: false,
        };
        static REGISTER: std::sync::Once = std::sync::Once::new();
        REGISTER.call_once(|| {
            let info = OutputInfo {
                id: b"producer_portrait_preview\0".as_ptr().cast(),
                flags: 1,
                name: Some(output_name),
                create: Some(output_create),
                destroy: Some(output_destroy),
                start: Some(output_start),
                stop: Some(output_stop),
                raw_video: Some(output_frame),
                optional: [0; 16],
            };
            obs_register_output_s(&info, std::mem::size_of::<OutputInfo>());
        });
        result.output = ffi::obs_output_create(
            b"producer_portrait_preview\0".as_ptr().cast(),
            b"Portrait preview\0".as_ptr().cast(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if video.is_null() || result.output.is_null() {
            return Err("Portrait preview capture unavailable".into());
        }
        let capture = obs_obj_get_data(result.output.cast()) as *mut Capture;
        (*capture).param = &mut *result.frames as *mut _ as *mut _;
        ffi::obs_output_set_media(result.output, video, std::ptr::null_mut());
        let scale = Scale {
            format: 7,
            width: preview_width,
            height: preview_height,
            range: 2,
            colorspace: 2,
        };
        obs_output_set_video_conversion(result.output, &scale);
        if !ffi::obs_output_start(result.output) {
            return Err("Portrait preview capture could not start".into());
        }
        Ok(result)
    }
    pub unsafe fn room(&mut self) {
        self.finish_transition(true);
        self.pending = None;
        self.spare = None;
        self.active = None;
        if self.room_scene.is_null() {
            self.room_scene =
                obs_canvas_scene_create(self.canvas.cast(), b"Portrait room\0".as_ptr().cast());
        }
        obs_canvas_set_channel(self.canvas, 0, ffi::obs_scene_get_source(self.room_scene));
    }
    pub unsafe fn sync_room(
        &mut self,
        mut states: Vec<super::graph::ItemState>,
        captures: HashMap<String, *mut ffi::obs_source_t>,
        width: f32,
        height: f32,
    ) {
        if self.room_scene.is_null() || self.active.is_some() {
            return;
        }
        let mut pointers: Vec<_> = captures
            .iter()
            .map(|(id, src)| (id, *src as usize))
            .collect();
        pointers.sort_by(|a, b| a.0.cmp(b.0));
        let signature = format!(
            "{}{:?}",
            serde_json::to_string(&states).unwrap_or_default(),
            pointers
        );
        if signature == self.room_fingerprint {
            return;
        }
        self.room_fingerprint = signature;
        let removed: Vec<_> = self
            .room_items
            .keys()
            .filter(|id| !captures.contains_key(*id))
            .cloned()
            .collect();
        for id in removed {
            if let Some((item, _)) = self.room_items.remove(&id) {
                ffi::obs_sceneitem_remove(item);
            }
            self.overrides.remove(&id);
        }
        let scale = (self.width as f32 / width).min(self.height as f32 / height);
        let ox = (self.width as f32 - width * scale) / 2.0;
        let oy = (self.height as f32 - height * scale) / 2.0;
        states.retain(|s| s.kind != "mic");
        for state in &mut states {
            let Some(&src) = captures.get(&state.id) else {
                continue;
            };
            if self
                .room_items
                .get(&state.id)
                .is_some_and(|(_, old)| *old != src as usize)
            {
                let (item, _) = self.room_items.remove(&state.id).unwrap();
                ffi::obs_sceneitem_remove(item);
            }
            let item = self
                .room_items
                .entry(state.id.clone())
                .or_insert_with(|| (ffi::obs_scene_add(self.room_scene, src), src as usize))
                .0;
            state.x = ox + state.x * scale;
            state.y = oy + state.y * scale;
            state.w *= scale;
            state.h *= scale;
            // Seed once from the room. From this point geometry belongs exclusively
            // to portrait; source metadata can refresh without importing main transforms.
            self.overrides.entry(state.id.clone()).or_insert_with(|| {
                super::graph::TransformPatch {
                    x: Some(state.x),
                    y: Some(state.y),
                    w: Some(state.w),
                    h: Some(state.h),
                    rot: Some(state.rot),
                    z: Some(state.z),
                    visible: Some(state.visible),
                    crop_left: Some(state.crop_left),
                    crop_top: Some(state.crop_top),
                    crop_right: Some(state.crop_right),
                    crop_bottom: Some(state.crop_bottom),
                }
            });
            if let Some(t) = self.overrides.get(&state.id) {
                state.x = t.x.unwrap_or(state.x);
                state.y = t.y.unwrap_or(state.y);
                state.w = t.w.unwrap_or(state.w);
                state.h = t.h.unwrap_or(state.h);
                state.rot = t.rot.unwrap_or(state.rot);
                state.z = t.z.unwrap_or(state.z);
                state.visible = t.visible.unwrap_or(state.visible);
                state.crop_left = t.crop_left.unwrap_or(state.crop_left);
                state.crop_top = t.crop_top.unwrap_or(state.crop_top);
                state.crop_right = t.crop_right.unwrap_or(state.crop_right);
                state.crop_bottom = t.crop_bottom.unwrap_or(state.crop_bottom);
            }
            obs_sceneitem_set_alignment(item, 5);
            obs_sceneitem_set_bounds_alignment(item, 5);
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            ffi::obs_sceneitem_set_pos(
                item,
                &ffi::vec2 {
                    x: state.x,
                    y: state.y,
                },
            );
            ffi::obs_sceneitem_set_bounds(
                item,
                &ffi::vec2 {
                    x: state.w.max(16.0),
                    y: state.h.max(16.0),
                },
            );
            ffi::obs_sceneitem_set_rot(item, state.rot);
            ffi::obs_sceneitem_set_crop(
                item,
                &ffi::obs_sceneitem_crop {
                    left: state.crop_left,
                    top: state.crop_top,
                    right: state.crop_right,
                    bottom: state.crop_bottom,
                },
            );
            ffi::obs_sceneitem_set_visible(item, state.visible);
            ffi::obs_sceneitem_set_order_position(item, state.z.max(0));
        }
        states.sort_by_key(|state| state.z);
        self.room_states = states;
    }
    pub unsafe fn program_source(&self) -> *mut ffi::obs_source_t {
        let scene = if !self.blend_scene.is_null() {
            self.blend_scene
        } else {
            self.active
                .as_ref()
                .map(|c| c.scene)
                .unwrap_or(self.room_scene)
        };
        if scene.is_null() {
            std::ptr::null_mut()
        } else {
            ffi::obs_source_get_ref(ffi::obs_scene_get_source(scene))
        }
    }
    pub unsafe fn video(&self) -> *mut ffi::video_t {
        obs_canvas_get_video(self.canvas)
    }
    pub fn room_states(&self) -> Vec<super::graph::ItemState> {
        self.room_states.clone()
    }
    pub fn transform(&mut self, id: &str, t: super::graph::TransformPatch) -> Result<(), String> {
        if self.active.is_some() {
            return Err("Edit the portrait set layout in Set edit".into());
        }
        if !self.room_items.contains_key(id) {
            return Err("Source left the portrait room".into());
        }
        let saved = self.overrides.entry(id.into()).or_default();
        macro_rules! merge {($($f:ident),*)=>{$(if t.$f.is_some(){saved.$f=t.$f;})*};}
        merge!(
            x,
            y,
            w,
            h,
            rot,
            z,
            visible,
            crop_left,
            crop_top,
            crop_right,
            crop_bottom
        );
        self.room_fingerprint.clear();
        Ok(())
    }
    pub unsafe fn prepare(
        &mut self,
        mut request: Request,
        captures: HashMap<String, *mut ffi::obs_source_t>,
    ) -> Result<Arc<Bridge>, String> {
        if request.projection.width >= request.projection.height {
            return Err("Choose a portrait set layout first".into());
        }
        if let Some(active) = &self.active {
            if request.lease != active.request.lease
                || request.projection.revision
                    <= active
                        .pending_patch
                        .as_ref()
                        .map_or(active.request.projection.revision, |p| {
                            p.projection.revision
                        })
            {
                return Err("Portrait request is stale".into());
            }
        }
        if let Some(active) = self.active.as_ref().or(self.pending.as_ref()) {
            super::presentation::hydrate(&mut request, &active.request);
        }
        super::presentation::validate_cached(
            &request,
            self.active
                .as_ref()
                .or(self.pending.as_ref())
                .map(|p| &p.request.projection.assets),
        )?;
        if let Some(active) = self.active.as_mut() {
            if active.can_patch(&request, &captures) {
                let clock = request
                    .projection
                    .timeline
                    .as_ref()
                    .map(|t| t.clock.clone());
                let bridge = active.patch(request);
                if let (Some(old), Some(clock)) = (&mut self.retiring, clock) {
                    old.synchronize_retired_clock(&clock);
                }
                return Ok(bridge);
            }
        }
        self.finish_transition(true);
        let candidate = if let Some(mut spare) = self
            .pending
            .take()
            .or(self.spare.take())
            .filter(|p| p.same_size(&request))
        {
            if spare.can_promote(&request, &captures) {
                eprintln!(
                    "[set-perf] portrait path=promote revision={}",
                    request.projection.revision
                );
                spare.promote(request)?;
            } else {
                spare.reuse(request, captures);
            }
            spare
        } else {
            Composition::build_sized(
                request,
                captures,
                Some((self.width, self.height)),
                Some(self.canvas.cast()),
            )?
        };
        let bridge = candidate.bridge.clone();
        self.pending = Some(candidate);
        Ok(bridge)
    }
    pub unsafe fn commit(
        &mut self,
        token: &str,
        placements: Vec<Placement>,
        generation: u64,
    ) -> Result<(), String> {
        if let Some(active) = self.active.as_mut() {
            if active.commit_patch(token, generation)? {
                self.needs_prewarm = true;
                return Ok(());
            }
        }
        if !self
            .pending
            .as_ref()
            .is_some_and(|p| p.bridge.token == token && p.request.generation == generation)
        {
            return Err("Portrait preparation was cancelled".into());
        }
        let mut candidate = self.pending.take().unwrap();
        candidate.finish_preparation(placements)?;
        let fade = candidate.has_crossfade() && self.active.is_some();
        if fade {
            super::filters::set_opacity(ffi::obs_scene_get_source(candidate.scene), 0.)?;
            let blend = obs_canvas_scene_create(
                self.canvas.cast(),
                b"Portrait set crossfade\0".as_ptr().cast(),
            );
            if blend.is_null() {
                return Err("Portrait transition allocation failed".into());
            }
            ffi::obs_source_set_audio_mixers(ffi::obs_scene_get_source(blend), 0);
            let old = self.active.as_ref().unwrap();
            ffi::obs_scene_add(blend, ffi::obs_scene_get_source(old.scene));
            ffi::obs_scene_add(blend, ffi::obs_scene_get_source(candidate.scene));
            obs_canvas_set_channel(self.canvas, 0, ffi::obs_scene_get_source(blend));
            self.blend_scene = blend;
            self.retiring = self.active.take();
        } else {
            obs_canvas_set_channel(self.canvas, 0, ffi::obs_scene_get_source(candidate.scene));
            self.spare = self.active.take();
        }
        candidate.activate_animation(fade);
        self.active = Some(candidate);
        self.needs_prewarm = true;
        if let Ok(mut frames) = self.frames.lock() {
            frames.jpeg.clear();
        }
        Ok(())
    }
    pub unsafe fn prewarm(&mut self) {
        self.finish_transition(false);
        if self.retiring.is_some() {
            return;
        }
        if !self.needs_prewarm {
            return;
        }
        self.needs_prewarm = false;
        if let Some(request) = self.active.as_ref().and_then(|p| p.preload_request()) {
            let mut captures = self.active.as_ref().unwrap().preload_captures();
            captures.retain(|id, _| request.bindings.contains_key(id));
            if let Some(spare) = self.spare.as_mut().filter(|p| p.same_size(&request)) {
                if !spare.can_promote(&request, &captures) {
                    spare.reuse(request, captures);
                }
            } else {
                self.spare = Composition::build_sized(
                    request,
                    captures,
                    Some((self.width, self.height)),
                    Some(self.canvas.cast()),
                )
                .ok();
            }
        }
    }
    pub unsafe fn finish_transition(&mut self, force: bool) {
        if self.retiring.is_none()
            || !force
                && self
                    .active
                    .as_ref()
                    .is_some_and(|p| !p.transition_finished())
        {
            return;
        }
        if let Some(active) = &self.active {
            active.finish_transition();
            obs_canvas_set_channel(self.canvas, 0, ffi::obs_scene_get_source(active.scene));
        }
        if !self.blend_scene.is_null() {
            ffi::obs_scene_release(self.blend_scene);
            self.blend_scene = std::ptr::null_mut();
        }
        self.spare = self.retiring.take();
    }
    pub fn jpeg(&self) -> String {
        self.frames
            .lock()
            .map(|mut f| {
                f.diagnostic = true;
                f.jpeg.clone()
            })
            .unwrap_or_default()
    }
}
impl Drop for Portrait {
    fn drop(&mut self) {
        unsafe {
            if !self.output.is_null() {
                ffi::obs_output_stop(self.output);
                ffi::obs_output_release(self.output);
            }
            obs_canvas_set_channel(self.canvas, 0, std::ptr::null_mut());
            if !self.blend_scene.is_null() {
                ffi::obs_scene_release(self.blend_scene);
                self.blend_scene = std::ptr::null_mut();
            }
            self.retiring = None;
            self.pending = None;
            self.active = None;
            self.spare = None;
            if !self.room_scene.is_null() {
                for (_, (item, _)) in self.room_items.drain() {
                    ffi::obs_sceneitem_remove(item);
                }
                ffi::obs_scene_release(self.room_scene);
            }
            obs_canvas_remove(self.canvas);
            obs_canvas_release(self.canvas);
        }
    }
}

pub unsafe fn release_display_canvas(canvas: *mut c_void) {
    obs_canvas_release(canvas.cast());
}
