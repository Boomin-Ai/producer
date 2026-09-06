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
//!   ([`RoomMix`], `obs_view_add`), and the vcam output is pointed at that mix
//!   — ALWAYS, studio on or off. Guests and mods never see the UI.
//!
//!   v0.4.41: the room mix used to be born with the studio, so toggling studio
//!   re-pointed a LIVE vcam output by stopping it, destroying it and starting a
//!   new one. `obs_output_stop` is asynchronous, so the immediately-following
//!   `obs_output_release` ran the output's stop callback a SECOND time inside
//!   `obs_output_destroy` — and mac-virtualcam's stop CFReleases its
//!   `formatDescription` unguarded, so the second stop was a double release
//!   (pointer-auth trap on the "live-engine" thread). On Windows the same
//!   stop/start made the camera device vanish from Google Meet. So the room mix
//!   now outlives the studio: it is created once, before the vcam starts, and
//!   `set_studio` never touches the vcam output at all.
//!
//! Off = the studio scene does not exist: channel 2 is empty and the preview
//! renders the main texture. The vcam keeps reading the same room mix.

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
    /// The capture's scene item, kept so teardown can remove it explicitly.
    /// Releasing our own reference is not enough: the scene holds one too, so
    /// the window capture (and macOS's screen-sharing indicator with it)
    /// outlived Studio being switched off.
    cap_item: *mut ffi::obs_sceneitem_t,
    pub spec: StudioSpec,
}

/// The room-only mix the virtual camera reads, in BOTH modes.
///
/// An `obs_view` whose channel 0 is the room scene, with its own `video_t` from
/// `obs_view_add`. It is deliberately independent of [`Studio`]: its lifetime is
/// the virtual camera's, not the studio's, so a studio toggle never has to
/// restart the vcam output (see the module docs — that restart was the v0.4.40
/// macOS crash and the Windows camera drop).
///
/// The one thing that DOES invalidate it is a video reset (`obs_reset_video`),
/// which tears down every mix; the engine loop rebuilds it there.
pub struct RoomMix {
    view: *mut ffi::obs_view_t,
    video: *mut ffi::video_t,
}

impl RoomMix {
    /// `room` is the channel-0 scene source (borrowed; `obs_view_set_source`
    /// takes its own reference). Engine-thread only (§5.1).
    pub unsafe fn build(room: *mut ffi::obs_source_t) -> Result<RoomMix, String> {
        if room.is_null() {
            return Err("the room scene is not on the program".into());
        }
        let view = ffi::obs_view_create();
        if view.is_null() {
            return Err("room mix view creation failed".into());
        }
        ffi::obs_view_set_source(view, 0, room);
        let video = ffi::obs_view_add(view);
        if video.is_null() {
            ffi::obs_view_set_source(view, 0, ptr::null_mut());
            ffi::obs_view_destroy(view);
            return Err("room mix creation failed".into());
        }
        Ok(RoomMix { view, video })
    }

    /// The mix to hand `obs_output_set_media`.
    pub fn video(&self) -> *mut ffi::video_t {
        self.video
    }

    /// Undo, in reverse. Idempotent. The vcam must already be stopped.
    pub unsafe fn teardown(&mut self) {
        if !self.view.is_null() {
            if !self.video.is_null() {
                ffi::obs_view_remove(self.view);
                self.video = ptr::null_mut();
            }
            ffi::obs_view_set_source(self.view, 0, ptr::null_mut());
            ffi::obs_view_destroy(self.view);
            self.view = ptr::null_mut();
        }
    }
}

/// win-capture's window id string: `title:class:exe`, `:` in the title
/// escaped as `#3A` (docs/WINDOWS-ENGINE.md). tao registers every Tauri
/// top-level window under the class "Window Class".
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn windows_capture_id(title: &str) -> String {
    format!("{}:Window Class:producer.exe", title.replace(':', "#3A"))
}

impl Studio {
    /// Build the studio scene over the room scene that already sits on channel
    /// 0. The return feed's mix is NOT built here — see [`RoomMix`].
    /// Engine-thread only (§5.1).
    pub unsafe fn build(spec: StudioSpec) -> Result<Studio, String> {
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
            cap_item: ptr::null_mut(),
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
            me.cap_item = item;
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

        // Last: the studio goes over the room on the main view, and the stage
        // switches to drawing the room directly.
        ffi::obs_set_output_source(STUDIO_CHANNEL, ffi::obs_scene_get_source(scene));
        STUDIO_ON.store(true, Ordering::SeqCst);
        Ok(me)
    }

    /// Undo everything, in reverse. Safe on a half-built studio.
    pub unsafe fn teardown(&mut self) {
        STUDIO_ON.store(false, Ordering::SeqCst);
        ffi::obs_set_output_source(STUDIO_CHANNEL, ptr::null_mut());
        // The capture leaves the SCENE first. The scene owns a reference of
        // its own, so dropping only ours left the window capture alive and
        // macOS kept showing "Currently Sharing" after Studio was off.
        if !self.cap_item.is_null() {
            ffi::obs_sceneitem_remove(self.cap_item);
            self.cap_item = ptr::null_mut();
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

/// The engine-loop decisions this module exists to constrain, as a pure state
/// machine with a call log.
///
/// The real loop is `engine.rs`'s command match, which cannot be unit-tested
/// (it needs a live libobs). This mirrors WHICH engine calls each command
/// issues, so the one invariant that cost us v0.4.40 — **`set_studio` never
/// stops or starts the virtual camera output** — is asserted in CI instead of
/// re-discovered in a crash report. Keep the two in step: every arm below has a
/// counterpart in `engine.rs`.
#[cfg(test)]
pub mod machine {
    /// One engine call, as recorded by [`Machine::log`].
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Call {
        VcamStart,
        VcamStop,
        /// `obs_output_set_media` — only ever at start, never on a live output.
        VcamSetMedia,
        RoomMixBuild,
        RoomMixTeardown,
        StudioBuild,
        StudioTeardown,
    }

    #[derive(Default)]
    pub struct Machine {
        pub vcam_on: bool,
        pub room_mix: bool,
        pub studio: Option<(u32, String)>,
        pub log: Vec<Call>,
    }

    impl Machine {
        /// `Command::SetVirtualCam` — the room mix is built on demand and the
        /// vcam is pointed at it, in either studio mode.
        pub fn set_virtual_cam(&mut self, on: bool) {
            if !on {
                if self.vcam_on {
                    self.vcam_on = false;
                    self.log.push(Call::VcamStop);
                }
                return;
            }
            if self.vcam_on {
                return;
            }
            if !self.room_mix {
                self.room_mix = true;
                self.log.push(Call::RoomMixBuild);
            }
            self.log.push(Call::VcamSetMedia);
            self.log.push(Call::VcamStart);
            self.vcam_on = true;
        }

        /// `Command::SetStudio` — scene work only. Touches no output.
        pub fn set_studio(&mut self, spec: Option<(u32, &str)>) {
            let want = spec.map(|(w, t)| (w, t.to_string()));
            if self.studio == want {
                return;
            }
            if self.studio.take().is_some() {
                self.log.push(Call::StudioTeardown);
            }
            if let Some(sp) = want {
                self.studio = Some(sp);
                self.log.push(Call::StudioBuild);
            }
        }

        /// `Command::SetVideo` — a video reset destroys every mix, so this IS
        /// allowed to cycle the vcam. It is the only command that is.
        pub fn set_video(&mut self) {
            let vcam = self.vcam_on;
            let studio = self.studio.clone();
            self.set_virtual_cam(false);
            if studio.is_some() {
                self.studio = None;
                self.log.push(Call::StudioTeardown);
            }
            if self.room_mix {
                self.room_mix = false;
                self.log.push(Call::RoomMixTeardown);
            }
            if let Some((w, t)) = studio {
                self.studio = Some((w, t));
                self.log.push(Call::StudioBuild);
            }
            if vcam {
                self.set_virtual_cam(true);
            }
        }

        pub fn drain(&mut self) -> Vec<Call> {
            std::mem::take(&mut self.log)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use machine::{Call, Machine};

    /// The v0.4.40 crash, as an invariant: toggling studio must not stop or
    /// start the virtual camera output. `obs_output_stop` is asynchronous, so
    /// the release that followed it re-entered mac-virtualcam's stop callback
    /// and double-released `formatDescription`.
    #[test]
    fn set_studio_never_cycles_the_virtual_camera() {
        let mut m = Machine::default();
        m.set_virtual_cam(true);
        assert_eq!(
            m.drain(),
            vec![Call::RoomMixBuild, Call::VcamSetMedia, Call::VcamStart]
        );

        // Three cycles, the exact gesture from the crash report.
        for _ in 0..3 {
            m.set_studio(Some((7, "Producer")));
            m.set_studio(None);
        }
        let log = m.drain();
        assert!(
            !log.iter()
                .any(|c| matches!(c, Call::VcamStart | Call::VcamStop | Call::VcamSetMedia)),
            "set_studio touched the vcam output: {log:?}"
        );
        assert!(m.vcam_on, "the vcam must still be running");
        assert!(m.room_mix, "the room mix must outlive the studio");
    }

    /// A vcam started BEFORE studio and one started AFTER must be identical:
    /// same calls, same order, same media.
    #[test]
    fn vcam_before_and_after_studio_are_identical() {
        let mut before = Machine::default();
        before.set_virtual_cam(true);
        before.set_studio(Some((7, "Producer")));
        let before_vcam: Vec<_> = before
            .drain()
            .into_iter()
            .filter(|c| matches!(c, Call::VcamStart | Call::VcamStop | Call::VcamSetMedia))
            .collect();

        let mut after = Machine::default();
        after.set_studio(Some((7, "Producer")));
        after.set_virtual_cam(true);
        let after_vcam: Vec<_> = after
            .drain()
            .into_iter()
            .filter(|c| matches!(c, Call::VcamStart | Call::VcamStop | Call::VcamSetMedia))
            .collect();

        assert_eq!(before_vcam, vec![Call::VcamSetMedia, Call::VcamStart]);
        assert_eq!(before_vcam, after_vcam);
    }

    /// Idempotence: re-asserting the same studio spec, or turning an already-on
    /// vcam on, issues nothing at all.
    #[test]
    fn repeat_commands_issue_nothing() {
        let mut m = Machine::default();
        m.set_virtual_cam(true);
        m.set_studio(Some((7, "Producer")));
        m.drain();
        m.set_virtual_cam(true);
        m.set_studio(Some((7, "Producer")));
        assert_eq!(m.drain(), vec![]);
    }

    /// A video reset destroys every mix, so it — and only it — may cycle the
    /// vcam, and it must rebuild the room mix before restarting it.
    #[test]
    fn a_video_reset_rebuilds_the_mix_under_the_camera() {
        let mut m = Machine::default();
        m.set_virtual_cam(true);
        m.set_studio(Some((7, "Producer")));
        m.drain();
        m.set_video();
        assert_eq!(
            m.drain(),
            vec![
                Call::VcamStop,
                Call::StudioTeardown,
                Call::RoomMixTeardown,
                Call::StudioBuild,
                Call::RoomMixBuild,
                Call::VcamSetMedia,
                Call::VcamStart,
            ]
        );
        assert!(m.vcam_on && m.room_mix && m.studio.is_some());
    }

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
