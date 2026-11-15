//! Keep the room in channel 0 for audio and source activation while Studio
//! hides it in the program mix. The filter changes no routing or source state.

use std::ptr;

use super::ffi;

extern "C" {
    fn producer_studio_room_gate_register();
    fn producer_studio_room_gate_require_capture(
        filter: *mut ffi::obs_source_t,
        capture: *mut ffi::obs_source_t,
    ) -> bool;
}

pub(super) unsafe fn register() {
    producer_studio_room_gate_register();
}

pub(super) struct RoomProgramGate {
    room: *mut ffi::obs_source_t,
    filter: *mut ffi::obs_source_t,
    capture: *mut ffi::obs_source_t,
}

impl RoomProgramGate {
    /// Attach only after the opaque Studio scene is on the main mix, and
    /// detach before that scene is removed. The active room scene is stable
    /// over layout changes; its items change, not its channel-0 identity.
    pub(super) unsafe fn attach(required_capture: *mut ffi::obs_source_t) -> Option<Self> {
        // Allow a matched Studio-on A/B run without changing capture quality.
        if std::env::var_os("PRODUCER_STUDIO_FORCE_ROOM_RENDER").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            return None;
        }
        let room = ffi::obs_get_output_source(0);
        if room.is_null() {
            return None;
        }
        let filter = ffi::obs_source_create_private(
            c"producer_studio_room_program_gate".as_ptr(),
            c"Studio room program video gate".as_ptr(),
            ptr::null_mut(),
        );
        if filter.is_null() {
            ffi::obs_source_release(room);
            return None;
        }
        let capture = if required_capture.is_null() {
            ptr::null_mut()
        } else {
            ffi::obs_source_get_ref(required_capture)
        };
        if (!required_capture.is_null() && capture.is_null())
            || !producer_studio_room_gate_require_capture(filter, capture)
        {
            ffi::obs_source_release(filter);
            ffi::obs_source_release(room);
            if !capture.is_null() {
                ffi::obs_source_release(capture);
            }
            return None;
        }
        ffi::obs_enter_graphics();
        ffi::obs_source_filter_add(room, filter);
        ffi::obs_leave_graphics();
        Some(Self {
            room,
            filter,
            capture,
        })
    }
}

impl Drop for RoomProgramGate {
    fn drop(&mut self) {
        unsafe {
            // A rendering thread can have a retained filter. Wait for that
            // render before libobs clears the filter's parent/target.
            ffi::obs_enter_graphics();
            ffi::obs_source_filter_remove(self.room, self.filter);
            ffi::obs_leave_graphics();
            ffi::obs_source_release(self.filter);
            ffi::obs_source_release(self.room);
            if !self.capture.is_null() {
                ffi::obs_source_release(self.capture);
            }
        }
    }
}
