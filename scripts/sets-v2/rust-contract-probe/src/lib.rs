//! Pure serializer contract checks: no OBS, GPU, browser, sockets or app build.
//! Imports the actual shipped contract module and its embedded unit tests.
#![allow(dead_code)]

// The painter serializer never uses shader validation. Keep this unrelated
// dependency fail-closed instead of importing native shader/FFI integration.
mod shaders {
    pub const PRESETS: &[&str] = &[];
}
mod sets_v2;
