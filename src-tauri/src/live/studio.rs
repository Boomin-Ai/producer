//! Studio output (v0.4.37) — "Broadcast the studio".
//!
//! The founder wants the ENTIRE Producer window on the stream: their face on
//! the stage, the scenes rail, guests, chat, the vote. The obvious way (put a
//! capture of our own window in the room scene) is an infinite mirror, because
//! the stage shows the program and the program shows the stage.
//!
//! The way out is two render paths that never meet:
//!
//! * PROGRAM (stream, record, and anything reading the main mix): the ROOM
//!   scene stays on output channel 0 — its audio tree, its program thumb, the
//!   Windows selection outline all read channel 0 and keep working — and a
//!   hidden STUDIO scene sits on channel [`STUDIO_CHANNEL`] above it: a black
//!   backdrop plus a cursor-less window capture of Producer's own window,
//!   fitted to the canvas. Later channels composite on top, so the main mix
//!   IS the studio; the room underneath costs one scene draw and keeps every
//!   source active (audio is mixed only from the main view's channel tree).
//!
//! * STAGE (the in-app preview): while studio is on, `preview_draw` renders
//!   the channel-0 ROOM scene directly (`obs_source_video_render`) instead of
//!   `obs_render_main_texture`. The window shows the room, the capture shows
//!   the window — no recursion.
//!
//! * RETURN FEED (virtual camera → guests' return feed, mod monitors): the
//!   virtual camera would otherwise mirror the main mix. An auxiliary
//!   `obs_view` whose single channel is the room scene gets its own mix
//!   (`obs_view_add`), and the vcam output is pointed at that mix while
//!   studio is on. Guests and mods never see the UI.
//!
//! Off = nothing of this exists: channel 2 is empty, the preview renders the
//! main texture, the vcam uses the main mix. Exactly the pre-0.4.37 engine.

use std::ffi::CString;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};

use super::ffi;

/// Output channel the studio scene occupies (0 = room scene, 1 = mic).
pub const STUDIO_CHANNEL: u32 = 2;

/// Read by `preview_draw` on the graphics thread: true = draw the room scene,
/// not the main texture.
pub static STUDIO_ON: AtomicBool = AtomicBool::new(false);

/// What to capture. macOS: the CGWindowID of our NSWindow (ScreenCaptureKit
/// window stream). Windows: win-capture's `window_capture` selects by
/// `title:class:exe`, so the title is what travels.
#[derive(Debug, Clone)]
pub struct StudioSpec {
    pub window_id: u32,
    pub title: String,
}

/// The pure decision every output-facing path asks: which scene does this
/// consumer get while studio mode is `on`? Mirrors `outputSceneFor` in
/// src/lib/studioOutput.ts so the two halves cannot drift silently.
#[allow(dead_code)] // the documented decision + its test; engine paths inline it
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consumer {
    Program,
    Stage,
    ReturnFeed,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneFor {
    Room,
    Studio,
}

#[allow(dead_code)]
pub fn output_scene_for(consumer: Consumer, studio_on: bool) -> SceneFor {
    match (consumer, studio_on) {
        (Consumer::Program, true) => SceneFor::Studio,
        _ => SceneFor::Room,
    }
}

pub struct Studio {
    scene: *mut ffi::obs_scene_t,
    bg: *mut ffi::obs_source_t,
    cap: *mut ffi::obs_source_t,
    view: *mut ffi::obs_view_t,
    video: *mut ffi::video_t,
    pub spec: StudioSpec,
}

/// win-capture's window id string: `title:class:exe`, `:` in the title
/// escaped as `#3A` (docs/WINDOWS-ENGINE.md). tao registers every Tauri
/// top-level window under the class "Window Class".
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn windows_capture_id(title: &str) -> String {
    format!("{}:Window Class:producer.exe", title.replace(':', "#3A"))
}

impl Studio {
    /// Build the studio scene over `room` (the channel-0 scene source) and the
    /// room-only mix for the return feed. Engine-thread only (§5.1).
    pub unsafe fn build(spec: StudioSpec, room: *mut ffi::obs_source_t) -> Result<Studio, String> {
        let mut ovi: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        let (bw, bh) = if ffi::obs_get_video_info(ovi.as_mut_ptr()) {
            let ovi = ovi.assume_init();
            (ovi.base_width as i64, ovi.base_height as i64)
        } else {
            (1280, 720)
        };

        let name = CString::new("studio").unwrap();
        let scene = ffi::obs_scene_create(name.as_ptr());
        if scene.is_null() {
            return Err("studio scene creation failed".into());
        }
        let mut me = Studio {
            scene,
            bg: ptr::null_mut(),
            cap: ptr::null_mut(),
            view: ptr::null_mut(),
            video: ptr::null_mut(),
            spec: spec.clone(),
        };

        // Black backdrop the size of the canvas: the window capture is fitted
        // (letterboxed) and whatever it does not cover must not show the room
        // scene underneath.
        {
            let d = ffi::obs_data_create();
            ffi::obs_data_set_int(
                d,
                CString::new("color").unwrap().as_ptr(),
                0xFF000000u32 as i64,
            );
            ffi::obs_data_set_int(d, CString::new("width").unwrap().as_ptr(), bw);
            ffi::obs_data_set_int(d, CString::new("height").unwrap().as_ptr(), bh);
            let id = CString::new("color_source_v3").unwrap();
            let n = CString::new("studio-backdrop").unwrap();
            me.bg = ffi::obs_source_create(id.as_ptr(), n.as_ptr(), d, ptr::null_mut());
            ffi::obs_data_release(d);
            if me.bg.is_null() {
                me.teardown();
                return Err("studio backdrop creation failed".into());
            }
            let item = ffi::obs_scene_add(scene, me.bg);
            if item.is_null() {
                me.teardown();
                return Err("studio backdrop could not join the scene".into());
            }
        }

        // The capture of our own window, cursor hidden.
        {
            let d = ffi::obs_data_create();
            #[cfg(target_os = "macos")]
            let type_id = {
                // mac-sck-common.h: ScreenCaptureWindowStream = 1
                ffi::obs_data_set_int(d, CString::new("type").unwrap().as_ptr(), 1);
                ffi::obs_data_set_int(
                    d,
                    CString::new("window").unwrap().as_ptr(),
                    spec.window_id as i64,
                );
                ffi::obs_data_set_bool(d, CString::new("show_cursor").unwrap().as_ptr(), false);
                "screen_capture"
            };
            #[cfg(not(target_os = "macos"))]
            let type_id = {
                let w = CString::new(windows_capture_id(&spec.title))
                    .map_err(|_| "bad window title")?;
                ffi::obs_data_set_string(d, CString::new("window").unwrap().as_ptr(), w.as_ptr());
                // window-helper.h: WINDOW_PRIORITY_TITLE = 1 — the title is
                // the one part we know for certain.
                ffi::obs_data_set_int(d, CString::new("priority").unwrap().as_ptr(), 1);
                ffi::obs_data_set_bool(d, CString::new("cursor").unwrap().as_ptr(), false);
                ffi::obs_data_set_bool(d, CString::new("client_area").unwrap().as_ptr(), true);
                "window_capture"
            };
            let id = CString::new(type_id).unwrap();
            let n = CString::new("studio-window").unwrap();
            me.cap = ffi::obs_source_create(id.as_ptr(), n.as_ptr(), d, ptr::null_mut());
            ffi::obs_data_release(d);
            if me.cap.is_null() {
                me.teardown();
                return Err("studio window capture creation failed".into());
            }
            let item = ffi::obs_scene_add(scene, me.cap);
            if item.is_null() {
                me.teardown();
                return Err("studio window capture could not join the scene".into());
            }
            let b = ffi::vec2 {
                x: bw as f32,
                y: bh as f32,
            };
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            ffi::obs_sceneitem_set_bounds(item, &b);
        }

        // The room-only mix for the return feed.
        me.view = ffi::obs_view_create();
        if me.view.is_null() {
            me.teardown();
            return Err("studio view creation failed".into());
        }
        ffi::obs_view_set_source(me.view, 0, room);
        me.video = ffi::obs_view_add(me.view);
        if me.video.is_null() {
            me.teardown();
            return Err("studio room mix creation failed".into());
        }

        // Last: the studio goes over the room on the main view, and the stage
        // switches to drawing the room directly.
        ffi::obs_set_output_source(STUDIO_CHANNEL, ffi::obs_scene_get_source(scene));
        STUDIO_ON.store(true, Ordering::SeqCst);
        Ok(me)
    }

    /// The room-only mix the virtual camera must use while studio is on.
    pub fn room_video(&self) -> *mut ffi::video_t {
        self.video
    }

    /// Undo everything, in reverse. Safe on a half-built studio.
    pub unsafe fn teardown(&mut self) {
        STUDIO_ON.store(false, Ordering::SeqCst);
        ffi::obs_set_output_source(STUDIO_CHANNEL, ptr::null_mut());
        if !self.view.is_null() {
            if !self.video.is_null() {
                ffi::obs_view_remove(self.view);
                self.video = ptr::null_mut();
            }
            ffi::obs_view_set_source(self.view, 0, ptr::null_mut());
            ffi::obs_view_destroy(self.view);
            self.view = ptr::null_mut();
        }
        if !self.cap.is_null() {
            ffi::obs_source_release(self.cap);
            self.cap = ptr::null_mut();
        }
        if !self.bg.is_null() {
            ffi::obs_source_release(self.bg);
            self.bg = ptr::null_mut();
        }
        if !self.scene.is_null() {
            ffi::obs_scene_release(self.scene);
            self.scene = ptr::null_mut();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_is_the_only_consumer_that_sees_the_studio() {
        for c in [Consumer::Program, Consumer::Stage, Consumer::ReturnFeed] {
            assert_eq!(output_scene_for(c, false), SceneFor::Room);
        }
        assert_eq!(output_scene_for(Consumer::Program, true), SceneFor::Studio);
        assert_eq!(output_scene_for(Consumer::Stage, true), SceneFor::Room);
        assert_eq!(output_scene_for(Consumer::ReturnFeed, true), SceneFor::Room);
    }

    #[test]
    fn windows_capture_id_escapes_colons() {
        assert_eq!(
            windows_capture_id("Producer"),
            "Producer:Window Class:producer.exe"
        );
        assert_eq!(
            windows_capture_id("Room: A"),
            "Room#3A A:Window Class:producer.exe"
        );
    }
}
