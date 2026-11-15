//! Local displays for Studio's composed program. The canvas monitor is a
//! borderless child window excluded by the window capture configuration.

use std::ffi::c_void;
use std::mem::MaybeUninit;
use std::ptr;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

use super::{ffi, graph};

extern "C" {
    fn producer_studio_preview_create(window: *mut c_void, width: *mut f64, height: *mut f64) -> *mut c_void;
    fn producer_studio_preview_show(view: *mut c_void);
    fn producer_studio_preview_destroy(view: *mut c_void);
    fn producer_studio_preview_is_closed(view: *mut c_void) -> bool;
    fn producer_studio_preview_floating(view: *mut c_void) -> bool;
    fn producer_studio_preview_set_floating(view: *mut c_void, floating: bool);
    fn producer_studio_stage_preview_create(window: *mut c_void, normalized: *const f64,
        width: *mut f64, height: *mut f64) -> *mut c_void;
    fn producer_studio_stage_preview_bind(view: *mut c_void, display: *mut ffi::obs_display_t);
    fn producer_studio_stage_preview_move(view: *mut c_void, normalized: *const f64) -> bool;
    fn producer_studio_stage_preview_hide(view: *mut c_void);
}

extern "C" fn draw_program(_: *mut c_void, width: u32, height: u32) {
    unsafe {
        let mut info = MaybeUninit::<ffi::obs_video_info>::zeroed();
        if !ffi::obs_get_video_info(info.as_mut_ptr()) {
            return;
        }
        let info = info.assume_init();
        let base_width = info.base_width.max(1) as f64;
        let base_height = info.base_height.max(1) as f64;
        let scale = (width as f64 / base_width).min(height as f64 / base_height);
        let fitted_width = (base_width * scale).round() as i32;
        let fitted_height = (base_height * scale).round() as i32;
        ffi::gs_viewport_push();
        ffi::gs_projection_push();
        ffi::gs_set_viewport(
            (width as i32 - fitted_width) / 2,
            (height as i32 - fitted_height) / 2,
            fitted_width,
            fitted_height,
        );
        ffi::gs_ortho(0.0, base_width as f32, 0.0, base_height as f32, -100.0, 100.0);
        ffi::obs_render_main_texture();
        ffi::gs_projection_pop();
        ffi::gs_viewport_pop();
    }
}

pub(super) struct StudioPreview {
    view: usize,
    display: usize,
    stage_session: Option<Arc<AtomicBool>>,
}

pub(crate) struct ComposerPreviewTarget {
    pub window: tauri::WebviewWindow,
    pub rect: super::StudioSpotlightRect,
    pub closed: Arc<AtomicBool>,
}

impl ComposerPreviewTarget {
    fn bounds(&self) -> Result<[f64; 4], String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Studio Composer is closed.".into());
        }
        let rect = self.rect;
        Ok([rect.x, rect.y, rect.w, rect.h])
    }
}

unsafe fn make_display(view: *mut c_void, width: f64, height: f64) -> *mut ffi::obs_display_t {
    let init = ffi::gs_init_data {
        window: ffi::gs_window { view },
        cx: width.round().max(1.0) as u32,
        cy: height.round().max(1.0) as u32,
        num_backbuffers: 0,
        format: ffi::GS_BGRA,
        zsformat: ffi::GS_ZS_NONE,
        adapter: 0,
    };
    ffi::obs_display_create(&init, 0)
}

impl StudioPreview {
    pub(super) fn new(window: usize, floating: bool) -> Result<Self, String> {
        let (view, display) = graph::on_main_thread(move || unsafe {
            let (mut width, mut height) = (0.0, 0.0);
            let view = producer_studio_preview_create(window as *mut c_void, &mut width, &mut height);
            if view.is_null() {
                return (0, 0);
            }
            let display = make_display(view, width, height);
            if display.is_null() {
                producer_studio_preview_destroy(view);
                return (0, 0);
            }
            producer_studio_preview_set_floating(view, floating);
            (view as usize, display as usize)
        });
        if display == 0 {
            return Err("Couldn't open the Studio preview.".into());
        }
        unsafe {
            ffi::obs_display_add_draw_callback(display as *mut _, draw_program, ptr::null_mut());
        }
        let preview = Self { view, display, stage_session: None };
        preview.show();
        Ok(preview)
    }

    pub(super) fn new_stage(target: ComposerPreviewTarget) -> Result<Self, String> {
        let closed = target.closed.clone();
        let (view, display) = graph::on_main_thread(move || unsafe {
            let bounds = target.bounds()?;
            let window = target.window.ns_window().map_err(|error| error.to_string())?.cast();
            let (mut width, mut height) = (0.0, 0.0);
            let view = producer_studio_stage_preview_create(window, bounds.as_ptr(), &mut width, &mut height);
            if view.is_null() {
                return Err("The in-canvas Studio preview needs macOS 14.2 or later and a visible canvas.".into());
            }
            let display = make_display(view, width, height);
            if display.is_null() {
                producer_studio_preview_destroy(view);
                return Err("Couldn't create the Studio canvas display.".into());
            }
            Ok::<_, String>((view as usize, display as usize))
        })?;
        unsafe {
            ffi::obs_display_add_draw_callback(display as *mut _, draw_program, ptr::null_mut());
        }
        let preview = Self { view, display, stage_session: Some(closed.clone()) };
        graph::on_main_thread(move || unsafe {
            if !closed.load(Ordering::Acquire) && !producer_studio_preview_is_closed(view as *mut _) {
                producer_studio_stage_preview_bind(view as *mut _, display as *mut _);
            }
        });
        Ok(preview)
    }

    pub(super) fn move_stage(&self, target: ComposerPreviewTarget) -> Result<(), String> {
        let view = self.view;
        graph::on_main_thread(move || unsafe {
            let bounds = target.bounds()?;
            if producer_studio_stage_preview_move(view as *mut _, bounds.as_ptr()) {
                Ok(())
            } else {
                Err("The Studio canvas is unavailable.".into())
            }
        })
    }

    pub(super) fn hide_stage(&self) {
        debug_assert!(self.is_stage_monitor());
        let view = self.view;
        graph::on_main_thread(move || unsafe { producer_studio_stage_preview_hide(view as *mut _) });
    }

    pub(super) fn is_stage_monitor(&self) -> bool {
        self.stage_session.is_some()
    }

    pub(super) fn matches_session(&self, session: &Arc<AtomicBool>) -> bool {
        self.stage_session.as_ref().is_some_and(|closed| Arc::ptr_eq(closed, session))
    }

    pub(super) fn show(&self) {
        let view = self.view;
        graph::on_main_thread(move || unsafe { producer_studio_preview_show(view as *mut _) });
    }

    pub(super) fn is_closed(&self) -> bool {
        self.stage_session.as_ref().is_some_and(|closed| closed.load(Ordering::Acquire))
            || unsafe { producer_studio_preview_is_closed(self.view as *mut _) }
    }

    pub(super) fn floating(&self) -> Option<bool> {
        (!self.is_stage_monitor()).then(|| unsafe { producer_studio_preview_floating(self.view as *mut _) })
    }
}

impl Drop for StudioPreview {
    fn drop(&mut self) {
        let (view, display) = (self.view, self.display);
        if self.is_stage_monitor() {
            graph::on_main_thread(move || unsafe {
                producer_studio_stage_preview_bind(view as *mut _, ptr::null_mut());
            });
        }
        unsafe {
            ffi::obs_display_remove_draw_callback(display as *mut _, draw_program, ptr::null_mut());
        }
        graph::on_main_thread(move || unsafe {
            ffi::obs_display_destroy(display as *mut _);
            producer_studio_preview_destroy(view as *mut _);
        });
    }
}
