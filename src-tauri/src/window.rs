//! macOS window appearance is independent of the optional live engine.

use std::ffi::c_void;

unsafe extern "C" {
    fn producer_apply_window_vibrancy(ns_window: *mut c_void) -> i32;
}

pub fn apply_vibrancy(ns_window: *mut c_void) -> bool {
    unsafe { producer_apply_window_vibrancy(ns_window) == 1 }
}
